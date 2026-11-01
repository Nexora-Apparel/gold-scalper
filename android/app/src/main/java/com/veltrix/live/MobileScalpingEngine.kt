package com.veltrix.live

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sign

class MobileScalpingEngine(
    private val symbol: String,
    private val requireBrokerQuoteParity: Boolean = false,
    private val onEvent: (String, String?, JSONObject) -> Unit
) {
    private data class Sample(val time: Long, val mid: Double, val spread: Double)
    private data class Bar(val time: Long, val open: Double, val high: Double, val low: Double, val close: Double)
    private data class ActiveBar(val time: Long, val open: Double, var high: Double, var low: Double, var close: Double)
    private data class PendingSignal(val side: String, val at: Long, val confidence: Double, val referencePrice: Double, val spread: Double)
    private data class Mt5Quote(val bid: Double, val ask: Double, val spread: Double, val observedAt: Long)

    private val samples = mutableListOf<Sample>()
    private val bars = mutableListOf<Bar>()
    private var activeBar: ActiveBar? = null
    private var lastFingerprint = ""
    private var lastSignalAt = 0L
    private var lastMarketFingerprint = ""
    private data class ActivePosition(val side: String, val entryPrice: Double, val openedAtMillis: Long)
    private var activePosition: ActivePosition? = null
    private var lastExitFingerprint = ""
    private var pendingSignal: PendingSignal? = null
    private var pendingExitAt = 0L
    private var pendingExitLogged = false
    private var pendingExitReason = ""
    private var latestTick: LiveTick? = null
    private var latestMt5Quote: Mt5Quote? = null
    private var mt5ReferenceQuoteMatch: Boolean? = null
    private var lastAcceptedTickAt = 0L
    private var exnessVerifiedUntil = 0L
    private var lastExnessMatch: Boolean? = null
    private var feedRevoked = false
    private var lastQuoteValidationFingerprint = ""
    @Volatile private var paused = false

    @Synchronized
    fun setPosition(side: String, entryPrice: Double, openedAtMillis: Long = System.currentTimeMillis()) {
        if (side !in setOf("BUY", "SELL") || !entryPrice.isFinite() || entryPrice <= 0) return
        val pending = pendingSignal
        if (pending != null) {
            val age = System.currentTimeMillis() - pending.at
            val priceTolerance = max(pending.spread * 2.0, pending.referencePrice * 0.0001)
            val priceMatches = pending.referencePrice <= 0.0 || abs(entryPrice - pending.referencePrice) <= priceTolerance
            if (side == pending.side && age in 0L..10000L && priceMatches) {
                onEvent("ENGINE_STATE", side, JSONObject().put("signalAccepted", true).put("signalAgeMs", age)
                    .put("entryPriceDeviation", abs(entryPrice - pending.referencePrice)))
            } else {
                val reason = when {
                    age > 10000L -> "signal_expired_before_position_confirmation"
                    side != pending.side -> "different_side_position_detected"
                    else -> "entry_price_deviated_from_signal"
                }
                onEvent("MISSED_OPPORTUNITY", pending.side, JSONObject()
                    .put("reason", reason).put("signalAgeMs", age)
                    .put("signalReferencePrice", pending.referencePrice).put("detectedEntryPrice", entryPrice))
            }
            pendingSignal = null
        }
        val previousPosition = activePosition
        if (previousPosition == null || previousPosition.side != side || previousPosition.entryPrice != entryPrice) {
            lastExitFingerprint = ""
            pendingExitAt = 0L
            pendingExitLogged = false
            pendingExitReason = ""
        }
        val preservedOpenedAt = previousPosition?.takeIf { it.side == side && it.entryPrice == entryPrice }?.openedAtMillis
        activePosition = ActivePosition(side, entryPrice, (preservedOpenedAt ?: openedAtMillis).coerceAtMost(System.currentTimeMillis()))
    }

    @Synchronized
    fun updateMt5ObservedQuote(observedSymbol: String, bid: Double, ask: Double, observedAt: Long = System.currentTimeMillis()): Boolean {
        if (observedSymbol != symbol || !bid.isFinite() || !ask.isFinite() || bid <= 0.0 || ask <= bid || observedAt <= 0L) return false
        val age = System.currentTimeMillis() - observedAt
        if (age !in -1000L..2500L) return false
        latestMt5Quote = Mt5Quote(bid, ask, ask - bid, observedAt)
        refreshMt5ReferenceQuoteVerification()
        return true
    }

    private fun refreshMt5ReferenceQuoteVerification(now: Long = System.currentTimeMillis()) {
        val quote = latestMt5Quote
        if (quote == null || now - quote.observedAt !in -1000L..2500L) {
            exnessVerifiedUntil = 0L
            lastExnessMatch = null
            if (mt5ReferenceQuoteMatch != null) {
                mt5ReferenceQuoteMatch = null
                onEvent("ENGINE_STATE", null, JSONObject()
                    .put("mt5ReferenceQuoteVerification", "NOT_OBSERVED_OR_EXPIRED")
                    .put("signalGate", "REFERENCE_FEED_MODE")
                    .put("rawScreenUploaded", false))
            }
            return
        }
        val tick = latestTick
        val tolerance = if (symbol == "XAUUSD") 0.05 else 0.01
        val reference = tick?.takeIf {
            it.live && now - it.timestampMillis in -1000L..1500L
        }
        val referenceFresh = reference != null
        val matched = reference != null &&
            abs(quote.bid - reference.bid) <= tolerance &&
            abs(quote.ask - reference.ask) <= tolerance &&
            abs(quote.spread - reference.spread) <= max(tolerance, reference.spread * 0.20)
        val status = when {
            !referenceFresh -> "REFERENCE_FEED_STALE"
            matched -> "MATCHED"
            else -> "MISMATCHED"
        }
        val nextMatch = if (referenceFresh) matched else null
        // A fresh OCR observation only opens the production signal gate while
        // both Bid and Ask remain corroborated by the independent reference.
        exnessVerifiedUntil = if (matched) quote.observedAt + 2500L else 0L
        lastExnessMatch = matched
        if (mt5ReferenceQuoteMatch != nextMatch) {
            mt5ReferenceQuoteMatch = nextMatch
            onEvent("ENGINE_STATE", null, JSONObject()
                .put("mt5ReferenceQuoteVerification", status)
                .put("signalGate", if (matched) "QUOTE_CORROBORATED" else "BLOCK_WHILE_MT5_QUOTE_VISIBLE")
                .put("tolerancePriceUnits", tolerance)
                .put("mt5Bid", quote.bid).put("mt5Ask", quote.ask)
                .put("referenceBid", tick?.bid ?: JSONObject.NULL)
                .put("referenceAsk", tick?.ask ?: JSONObject.NULL)
                .put("quoteSource", "mt5_screen_ocr_vs_biquote_reference")
                .put("rawScreenUploaded", false))
        }
    }

    @Synchronized
    fun verifyExnessQuote(exnessBid: Double, exnessAsk: Double, validForMs: Long = 10000L): Boolean {
        val tick = latestTick
        val now = System.currentTimeMillis()
        val tolerance = if (symbol == "XAUUSD") 0.05 else 0.01
        val matched = tick != null && tick.live && tick.timestampMillis - now in -1000L..1500L && exnessBid > 0 && exnessAsk > exnessBid &&
            abs(exnessBid - tick.bid) <= tolerance && abs(exnessAsk - tick.ask) <= tolerance &&
            abs((exnessAsk - exnessBid) - tick.spread) <= max(tolerance, tick.spread * 0.20)
        val verificationWindow = validForMs.coerceIn(1000L, 10000L)
        exnessVerifiedUntil = if (matched) now + verificationWindow else 0L
        if (lastExnessMatch != matched) {
            lastExnessMatch = matched
            onEvent("ENGINE_STATE", null, JSONObject()
                .put("exnessQuoteVerification", if (matched) "MATCHED" else "NOT_MATCHED")
                .put("tolerance", tolerance).put("validForMs", if (matched) verificationWindow else 0L)
                .put("rawScreenUploaded", false))
        }
        return matched
    }

    @Synchronized
    fun restorePendingSignal(side: String?, at: Long, confidence: Double, referencePrice: Double = 0.0, spread: Double = 0.0) {
        if ((side == "BUY" || side == "SELL") && at > 0 && confidence.isFinite() && confidence in 0.0..1.0) {
            pendingSignal = PendingSignal(side, at, confidence, referencePrice, spread)
        }
    }

    @Synchronized
    fun restorePendingExit(at: Long, reason: String?) {
        if (at > 0L && !reason.isNullOrBlank()) {
            pendingExitAt = at
            pendingExitReason = reason
            pendingExitLogged = false
        }
    }

    @Synchronized
    fun checkTimeouts(now: Long = System.currentTimeMillis()) {
        refreshMt5ReferenceQuoteVerification(now)
        val pending = pendingSignal
        if (pending != null && now - pending.at >= 10000L) {
            onEvent("MISSED_OPPORTUNITY", pending.side, JSONObject()
                .put("reason", "signal_expired_without_detected_mt5_position")
                .put("signalAgeMs", now - pending.at)
                .put("confidence", pending.confidence)
                .put("validForSeconds", 10))
            pendingSignal = null
        }
        val position = activePosition
        if (position != null && pendingExitAt > 0 && !pendingExitLogged && now - pendingExitAt >= 5000L) {
            pendingExitLogged = true
            onEvent("EXIT_NOT_CONFIRMED", position.side, JSONObject()
                .put("reason", pendingExitReason)
                .put("confirmationDelayMs", now - pendingExitAt)
                .put("manualMT5ConfirmationRequired", true))
        }
    }

    @Synchronized
    fun onFeedStale() {
        exnessVerifiedUntil = 0L
        lastExnessMatch = null
        if (!feedRevoked) {
            feedRevoked = true
            onEvent("ENGINE_STATE", null, JSONObject().put("exnessQuoteVerification", "REVOKED_FEED_STALE").put("signalGenerationEnabled", false))
        }
        val position = activePosition ?: return
        val fingerprint = "HOLD_UNVERIFIED|feed_stale"
        if (lastExitFingerprint == fingerprint) return
        lastExitFingerprint = fingerprint
        onEvent("EXIT_RECOMMENDED", position.side, JSONObject()
            .put("action", "HOLD_UNVERIFIED")
            .put("reason", "Market-data stream is stale or disconnected. Verify the position directly in MT5.")
            .put("entryPrice", position.entryPrice)
            .put("executionEnabled", false))
    }

    @Synchronized
    fun clearPosition() {
        activePosition = null
        lastExitFingerprint = ""
        pendingExitAt = 0L
        pendingExitLogged = false
        pendingExitReason = ""
    }

    @Synchronized
    fun shutdown() {
        val pending = pendingSignal
        if (pending != null) {
            onEvent("MISSED_OPPORTUNITY", pending.side, JSONObject()
                .put("reason", "assistant_stopped_before_position_confirmation")
                .put("signalAgeMs", System.currentTimeMillis() - pending.at)
                .put("confidence", pending.confidence))
            pendingSignal = null
        }
        val position = activePosition
        if (position != null && pendingExitAt > 0L && !pendingExitLogged) {
            onEvent("EXIT_NOT_CONFIRMED", position.side, JSONObject()
                .put("reason", pendingExitReason)
                .put("confirmationDelayMs", System.currentTimeMillis() - pendingExitAt)
                .put("manualMT5ConfirmationRequired", true)
                .put("assistantStopped", true))
            pendingExitLogged = true
        }
    }

    @Synchronized
    fun setPaused(value: Boolean) {
        if (paused == value) return
        paused = value
        onEvent("ENGINE_STATE", null, JSONObject().put("paused", value).put("signalGenerationEnabled", !value))
    }

    private fun quoteValidationError(tick: LiveTick): String? {
        if (tick.symbol != symbol) return "symbol_mismatch"
        if (!tick.bid.isFinite() || !tick.ask.isFinite() || !tick.mid.isFinite() || !tick.spread.isFinite()) return "non_finite_quote_value"
        if (tick.bid <= 0.0 || tick.ask <= tick.bid || tick.mid <= 0.0 || tick.spread < 0.0) return "invalid_bid_ask_or_spread"
        val midpointTolerance = max(0.000001, (tick.ask - tick.bid) * 0.02)
        if (tick.mid < tick.bid - midpointTolerance || tick.mid > tick.ask + midpointTolerance) return "mid_outside_bid_ask"
        return null
    }

    @Synchronized
    fun onTick(tick: LiveTick) {
        checkTimeouts()
        if (tick.symbol != symbol) return
        val validationError = quoteValidationError(tick)
        if (validationError != null) {
            latestTick = tick.copy(live = false)
            exnessVerifiedUntil = 0L
            lastExnessMatch = null
            feedRevoked = true
            val validationFingerprint = "REJECTED|$validationError"
            if (lastQuoteValidationFingerprint != validationFingerprint) {
                lastQuoteValidationFingerprint = validationFingerprint
                onEvent("ENGINE_STATE", null, JSONObject()
                    .put("quoteValidation", "REJECTED")
                    .put("quoteValidationReason", validationError)
                    .put("quoteStreamValid", false)
                    .put("providerSource", tick.source))
            }
            val invalidFingerprint = "NO_TRADE|invalid_quote|$validationError"
            if (invalidFingerprint != lastFingerprint) {
                lastFingerprint = invalidFingerprint
                onEvent("NO_TRADE", null, JSONObject()
                    .put("action", "NO_TRADE")
                    .put("reasons", JSONArray().put("invalid_quote").put(validationError))
                    .put("provider", "biquote")
                    .put("providerSource", tick.source)
                    .put("executionEnabled", false))
            }
            val position = activePosition
            if (position != null) {
                val exitFingerprint = "HOLD_UNVERIFIED|invalid_quote"
                if (lastExitFingerprint != exitFingerprint) {
                    lastExitFingerprint = exitFingerprint
                    onEvent("EXIT_RECOMMENDED", position.side, JSONObject()
                        .put("action", "HOLD_UNVERIFIED")
                        .put("reason", "Reference quote failed validation. Check the live position and executable price directly in MT5.")
                        .put("entryPrice", position.entryPrice)
                        .put("executionEnabled", false))
                }
            }
            return
        }
        if (lastQuoteValidationFingerprint.isNotEmpty()) {
            lastQuoteValidationFingerprint = ""
            onEvent("ENGINE_STATE", null, JSONObject()
                .put("quoteValidation", "ACCEPTED")
                .put("quoteStreamValid", tick.live &&
                    (System.currentTimeMillis() - tick.timestampMillis) in -1000L..1500L)
                .put("providerSource", tick.source))
        }
        val incomingAge = System.currentTimeMillis() - tick.timestampMillis
        if (!tick.live || incomingAge !in -1000L..1500L) {
            if (tick.live) onFeedStale()
            val staleTick = tick.copy(live = false)
            latestTick = staleTick
            refreshMt5ReferenceQuoteVerification()
            evaluatePositionExit(staleTick, "QUIET", 1.0, null, 0.0)
            val staleFingerprint = "NO_TRADE|quote_not_live_or_fresh"
            if (staleFingerprint != lastFingerprint) {
                lastFingerprint = staleFingerprint
                onEvent("NO_TRADE", null, JSONObject().put("action", "NO_TRADE")
                    .put("reasons", JSONArray().put("quote_not_live_or_fresh"))
                    .put("provider", "biquote").put("providerSource", tick.source))
            }
            return
        }
        if (lastAcceptedTickAt > 0 && tick.timestampMillis <= lastAcceptedTickAt) return
        if (lastAcceptedTickAt > 0 && tick.timestampMillis - lastAcceptedTickAt > 5000L) {
            val gap = tick.timestampMillis - lastAcceptedTickAt
            samples.clear()
            bars.clear()
            activeBar = null
            lastMarketFingerprint = ""
            lastFingerprint = ""
            onEvent("ENGINE_STATE", null, JSONObject().put("contextReset", "tick_gap")
                .put("gapMs", gap).put("reason", "M1_M5_M15_context_must_rebuild"))
        }
        lastAcceptedTickAt = tick.timestampMillis
        feedRevoked = false
        latestTick = tick
        refreshMt5ReferenceQuoteVerification()
        if (requireBrokerQuoteParity && exnessVerifiedUntil > 0 && System.currentTimeMillis() > exnessVerifiedUntil) {
            exnessVerifiedUntil = 0L
            lastExnessMatch = false
            onEvent("ENGINE_STATE", null, JSONObject().put("exnessQuoteVerification", "EXPIRED").put("signalGenerationEnabled", false))
        }
        val now = tick.timestampMillis
        val observedMt5Quote = latestMt5Quote?.takeIf {
            val observedAge = System.currentTimeMillis() - it.observedAt
            observedAge in -1000L..2500L
        }
        val effectiveSpread = observedMt5Quote?.spread ?: tick.spread
        val spreadSource = if (observedMt5Quote != null) "mt5_screen_ocr" else "biquote_reference"
        samples.add(Sample(now, tick.mid, effectiveSpread))
        samples.removeAll { it.time < now - 15000L }
        updateBars(tick)

        val short = samples.filter { it.time >= now - 5000L }
        val context = samples
        val reasons = mutableListOf<String>()
        if (paused) reasons.add("engine_paused_exit_monitoring_remains_active")
        if (activePosition != null) reasons.add("position_already_open")
        val age = System.currentTimeMillis() - now
        if (!tick.live || age !in -1000..1500) reasons.add("quote_not_live_or_fresh")
        if (requireBrokerQuoteParity && System.currentTimeMillis() > exnessVerifiedUntil) reasons.add("broker_quote_parity_not_verified")
        val freshMt5Quote = latestMt5Quote?.takeIf { System.currentTimeMillis() - it.observedAt in -1000L..2500L }
        if (freshMt5Quote != null && mt5ReferenceQuoteMatch != true) reasons.add("mt5_reference_quote_mismatch")
        if (short.size < 3) reasons.add("short_window_not_ready")
        if (context.size < 3) reasons.add("context_window_not_ready")

        val shortMove = movement(short)
        val contextMove = movement(context)
        val shortElapsed = if (short.size >= 2) short.last().time - short.first().time else 0L
        val tickRate = if (shortElapsed > 0) (short.size - 1).toDouble() / (shortElapsed / 1000.0) else 0.0
        if (tickRate < 0.2) reasons.add("tick_activity_insufficient")

        val baselineSpread = if (context.isNotEmpty()) context.map { it.spread }.average() else 0.0
        val spreadMultiple = if (baselineSpread > 0) effectiveSpread / baselineSpread else 1.0
        val spreadPercent = if (tick.mid > 0) effectiveSpread / tick.mid * 100.0 else Double.POSITIVE_INFINITY
        val maxSpreadPercent = if (symbol == "XAUUSD") 0.02 else 0.12
        if (spreadMultiple > 2.5) reasons.add("spread_anomaly")
        if (spreadPercent > maxSpreadPercent) reasons.add("absolute_spread_cap_exceeded")

        val aligned = shortMove != null && contextMove != null &&
            shortMove != 0.0 && contextMove != 0.0 && sign(shortMove) == sign(contextMove)
        val direction = if (!aligned) null else if (shortMove!! > 0) "UP" else "DOWN"
        if (!aligned) reasons.add("momentum_not_aligned")

        val absoluteMove = max(abs(shortMove ?: 0.0), abs(contextMove ?: 0.0))
        val volatility = when {
            absoluteMove >= 0.05 -> "SPIKE"
            absoluteMove >= 0.02 -> "EXPANDED"
            absoluteMove <= 0.002 -> "QUIET"
            else -> "NORMAL"
        }
        if (volatility == "SPIKE") reasons.add("volatility_spike")

        val upTicks = short.zipWithNext().count { it.second.mid > it.first.mid }
        val downTicks = short.zipWithNext().count { it.second.mid < it.first.mid }
        val directionalCount = upTicks + downTicks
        val pressure = if (directionalCount > 0) (upTicks - downTicks).toDouble() / directionalCount else 0.0
        if (abs(pressure) < 0.15) reasons.add("directional_tick_pressure_insufficient")
        val pressureDirection = if (pressure > 0) "UP" else if (pressure < 0) "DOWN" else null
        if (direction != null && pressureDirection != direction) reasons.add("directional_tick_pressure_conflict")

        val m5Direction = timeframeDirection(5)
        val m15Direction = timeframeDirection(15)
        if (m5Direction == null) reasons.add("m5_context_not_ready")
        if (m15Direction == null) reasons.add("m15_context_not_ready")
        if (direction != null && m5Direction != null && m5Direction != direction) reasons.add("m5_context_conflict")
        if (direction != null && m15Direction != null && m15Direction != direction) reasons.add("m15_context_conflict")

        val structure = structure()
        if (structure.first == null) reasons.add("short_term_structure_unconfirmed")
        if (direction != null && structure.first != direction) reasons.add("structure_momentum_conflict")

        val momentumStrength = min(1.0, abs(shortMove ?: 0.0) / 0.03)
        val contextStrength = min(1.0, abs(contextMove ?: 0.0) / 0.03)
        val pressureStrength = min(1.0, abs(pressure))
        val confidence = momentumStrength * 0.30 + contextStrength * 0.20 +
            pressureStrength * 0.25 + structure.second * 0.25

        var action = "NO_TRADE"
        var side: String? = null
        if (reasons.isEmpty() && confidence >= 0.72 && direction != null) {
            if (now - lastSignalAt < 20000L) reasons.add("signal_cooldown_active")
            else {
                action = if (direction == "UP") "BUY_NOW" else "SELL_NOW"
                side = if (direction == "UP") "BUY" else "SELL"
                lastSignalAt = now
                val brokerEntryPrice = if (side == "BUY") freshMt5Quote?.ask ?: tick.mid else freshMt5Quote?.bid ?: tick.mid
                pendingSignal = PendingSignal(side!!, System.currentTimeMillis(), confidence, brokerEntryPrice, effectiveSpread)
            }
        } else if (confidence < 0.72) reasons.add("confidence_below_threshold")

        evaluatePositionExit(tick, volatility, spreadMultiple, direction, pressure)

        val marketFingerprint = listOf(tick.live, volatility, direction, reasons.joinToString(",")).joinToString("|")
        if (marketFingerprint != lastMarketFingerprint) {
            lastMarketFingerprint = marketFingerprint
            onEvent("MARKET_STATE", null, JSONObject()
                .put("live", tick.live).put("quoteAgeMs", age).put("spread", effectiveSpread)
                .put("biquoteReferenceSpread", tick.spread)
                .put("mt5ObservedSpread", observedMt5Quote?.spread ?: JSONObject.NULL)
                .put("spreadSource", spreadSource)
                .put("provider", "biquote").put("providerSource", tick.source)
                .put("spreadMultiple", spreadMultiple).put("volatilityRegime", volatility)
                .put("momentumDirection", direction ?: JSONObject.NULL).put("reasons", JSONArray(reasons)))
        }

        val fingerprint = action + "|" + side + "|" + reasons.joinToString(",")
        if (fingerprint != lastFingerprint) {
            lastFingerprint = fingerprint
            val payload = JSONObject()
                .put("action", action).put("confidence", confidence)
                .put("provider", "biquote").put("providerSource", tick.source)
                .put("tickTimestamp", java.time.Instant.ofEpochMilli(tick.timestampMillis).toString())
                .put("processingLatencyMs", (System.currentTimeMillis() - tick.timestampMillis).coerceAtLeast(0L))
                .put("validForSeconds", if (side != null) 10 else 0)
                .put("signalAt", if (side != null) pendingSignal?.at ?: System.currentTimeMillis() else JSONObject.NULL)
                .put("signalMid", if (side != null) tick.mid else JSONObject.NULL)
                .put("signalEntryPrice", if (side != null) pendingSignal?.referencePrice ?: JSONObject.NULL else JSONObject.NULL)
                .put("signalEntryPriceSide", if (side == "BUY") "ASK" else if (side == "SELL") "BID" else JSONObject.NULL)
                .put("signalQuoteSource", if (freshMt5Quote != null) "mt5_screen_ocr" else "biquote_reference_only")
                .put("signalSpread", if (side != null) effectiveSpread else JSONObject.NULL)
                .put("quoteBid", tick.bid).put("quoteAsk", tick.ask)
                .put("quoteMid", tick.mid).put("spread", effectiveSpread)
                .put("biquoteReferenceSpread", tick.spread)
                .put("mt5ObservedBid", observedMt5Quote?.bid ?: JSONObject.NULL)
                .put("mt5ObservedAsk", observedMt5Quote?.ask ?: JSONObject.NULL)
                .put("mt5ObservedSpread", observedMt5Quote?.spread ?: JSONObject.NULL)
                .put("spreadSource", spreadSource).put("spreadPercent", spreadPercent)
                .put("mt5ReferenceQuoteVerification", when {
                    freshMt5Quote == null -> "NOT_OBSERVED"
                    mt5ReferenceQuoteMatch == true -> "MATCHED"
                    else -> "MISMATCHED"
                })
                .put("volatilityRegime", volatility)
                .put("momentumDirection", direction ?: JSONObject.NULL)
                .put("m5Direction", m5Direction ?: JSONObject.NULL)
                .put("m15Direction", m15Direction ?: JSONObject.NULL)
                .put("structureDirection", structure.first ?: JSONObject.NULL)
                .put("structureStrength", structure.second)
                .put("directionalTickPressure", pressure)
                .put("pressureSource", "directional_tick_imbalance_proxy_not_order_flow")
                .put("reasons", JSONArray(reasons))
                .put("executionEnabled", false)
                .put("requiresManualMT5Confirmation", side != null)
            onEvent(if (side == null) "NO_TRADE" else "SIGNAL", side, payload)
        }
    }


    private fun evaluatePositionExit(tick: LiveTick, volatility: String, spreadMultiple: Double, direction: String?, pressure: Double) {
        val position = activePosition ?: return
        val side = position.side
        val entry = position.entryPrice
        val heldMs = (System.currentTimeMillis() - position.openedAtMillis).coerceAtLeast(0L)
        val opposite = if (side == "BUY") "DOWN" else "UP"
        val now = System.currentTimeMillis()
        val tickAgeMs = now - tick.timestampMillis
        val mt5Quote = latestMt5Quote?.takeIf { now - it.observedAt in -1000L..2500L }
        // A BUY closes at Bid; a SELL closes at Ask. These executable-side quotes
        // already include the spread, so never subtract spread a second time.
        val exitPrice = if (mt5Quote != null) {
            if (side == "BUY") mt5Quote.bid else mt5Quote.ask
        } else {
            if (side == "BUY") tick.bid else tick.ask
        }
        val closeQuoteSource = if (mt5Quote != null) "mt5_screen_ocr" else "biquote_reference"
        val move = if (side == "BUY") exitPrice - entry else entry - exitPrice
        val effectiveSpread = mt5Quote?.spread ?: tick.spread
        val action: String
        val reason: String
        when {
            !tick.live -> { action = "HOLD_UNVERIFIED"; reason = "Live quote unavailable; refresh MT5 manually." }
            requireBrokerQuoteParity && System.currentTimeMillis() > exnessVerifiedUntil -> { action = "HOLD_UNVERIFIED"; reason = "Broker quote parity expired; verify MT5 before acting." }
            heldMs >= 60000L -> { action = "CLOSE_NOW"; reason = "Maximum 60-second scalping holding time reached." }
            volatility == "SPIKE" -> { action = "CLOSE_NOW"; reason = "Short-window volatility spike detected." }
            spreadMultiple >= 3.0 -> { action = "CLOSE_NOW"; reason = "Spread expanded to at least three times its recent baseline." }
            heldMs >= 5000L && direction == opposite && abs(pressure) >= 0.35 && ((side == "BUY" && pressure < 0) || (side == "SELL" && pressure > 0)) -> {
                action = "CLOSE_NOW"; reason = "Short-term momentum and tick pressure reversed against the position."
            }
            else -> { action = "HOLD"; reason = "No emergency exit condition confirmed." }
        }
        if (action == "CLOSE_NOW") {
            if (pendingExitAt == 0L) {
                pendingExitAt = System.currentTimeMillis()
                pendingExitLogged = false
                pendingExitReason = reason
            }
        } else if (action == "HOLD" && pendingExitAt > 0L) {
            onEvent("EXIT_RECOMMENDATION_CLEARED", side, JSONObject()
                .put("reason", "exit_conditions_no_longer_confirmed")
                .put("previousExitReason", pendingExitReason))
            pendingExitAt = 0L
            pendingExitLogged = false
            pendingExitReason = ""
        }
        val fingerprint = action + "|" + reason
        if (fingerprint == lastExitFingerprint) return
        lastExitFingerprint = fingerprint
        onEvent("EXIT_RECOMMENDED", side, JSONObject()
            .put("action", action).put("reason", reason).put("entryPrice", entry)
            .put("indicativeExitPrice", exitPrice)
            .put("grossMovePriceUnits", move)
            .put("move", move)
            .put("closeQuoteSource", closeQuoteSource)
            .put("quoteAgeMs", tickAgeMs.coerceAtLeast(0L))
            .put("observedSpreadPriceUnits", effectiveSpread)
            .put("spreadSource", if (mt5Quote != null) "mt5_screen_ocr" else "biquote_reference")
            .put("spreadIncludedInExecutableQuote", true)
            .put("netProfitCurrency", JSONObject.NULL)
            .put("netProfitCurrencyReason", "Contract size, verified volume, and account-currency conversion are not available.")
            .put("holdingTimeMs", heldMs).put("maximumHoldingTimeMs", 60000L)
            .put("minimumNormalHoldingTimeMs", 5000L)
            .put("executionEnabled", false).put("manualMT5ActionRequired", action == "CLOSE_NOW"))
    }

    private fun movement(window: List<Sample>): Double? {
        if (window.size < 2 || window.first().mid <= 0) return null
        return (window.last().mid - window.first().mid) / window.first().mid * 100.0
    }

    private fun updateBars(tick: LiveTick) {
        val bucket = tick.timestampMillis / 60000L * 60000L
        val current = activeBar
        if (current == null) {
            activeBar = ActiveBar(bucket, tick.mid, tick.mid, tick.mid, tick.mid)
        } else if (bucket > current.time) {
            if (bucket - current.time == 60000L) {
                bars.add(Bar(current.time, current.open, current.high, current.low, current.close))
                if (bars.size > 30) bars.removeAt(0)
            } else {
                bars.clear()
            }
            activeBar = ActiveBar(bucket, tick.mid, tick.mid, tick.mid, tick.mid)
        } else if (bucket == current.time) {
            current.high = max(current.high, tick.mid)
            current.low = min(current.low, tick.mid)
            current.close = tick.mid
        }
    }

    private fun timeframeDirection(count: Int): String? {
        if (bars.size < count) return null
        val window = bars.takeLast(count)
        val displacement = window.last().close - window.first().open
        return when {
            displacement > 0 -> "UP"
            displacement < 0 -> "DOWN"
            else -> null
        }
    }

    private fun structure(): Pair<String?, Double> {
        if (bars.size < 4) return Pair(null, 0.0)
        val prior = bars.takeLast(4).dropLast(1)
        val latest = bars.last()
        val range = prior.map { it.high - it.low }.average()
        if (range <= 0) return Pair(null, 0.0)
        val priorHigh = prior.maxOf { it.high }
        val priorLow = prior.minOf { it.low }
        val up = latest.close > priorHigh
        val down = latest.close < priorLow
        if (!up && !down) return Pair(null, 0.0)
        val displacement = if (up) latest.close - priorHigh else priorLow - latest.close
        val strength = min(1.0, displacement / range)
        return if (strength >= 0.35) Pair(if (up) "UP" else "DOWN", strength) else Pair(null, strength)
    }
}
