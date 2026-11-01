package com.veltrix.live

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sign

class MobileScalpingEngine(
    private val symbol: String,
    private val onEvent: (String, String?, JSONObject) -> Unit
) {
    private data class Sample(val time: Long, val mid: Double, val spread: Double)
    private data class Bar(val time: Long, val open: Double, val high: Double, val low: Double, val close: Double)
    private data class ActiveBar(val time: Long, val open: Double, var high: Double, var low: Double, var close: Double)

    private val samples = mutableListOf<Sample>()
    private val bars = mutableListOf<Bar>()
    private var activeBar: ActiveBar? = null
    private var lastFingerprint = ""
    private var lastSignalAt = 0L
    private var lastMarketFingerprint = ""
    private var activePosition: Pair<String, Double>? = null
    private var lastExitFingerprint = ""
    @Volatile private var paused = false

    @Synchronized
    fun setPosition(side: String, entryPrice: Double) {
        if (side !in setOf("BUY", "SELL") || !entryPrice.isFinite() || entryPrice <= 0) return
        activePosition = Pair(side, entryPrice)
        lastExitFingerprint = ""
    }

    @Synchronized
    fun clearPosition() {
        activePosition = null
        lastExitFingerprint = ""
    }

    @Synchronized
    fun setPaused(value: Boolean) {
        if (paused == value) return
        paused = value
        onEvent("ENGINE_STATE", null, JSONObject().put("paused", value).put("signalGenerationEnabled", !value))
    }

    @Synchronized
    fun onTick(tick: LiveTick) {
        if (tick.symbol != symbol || paused) return
        val now = tick.timestampMillis
        samples.add(Sample(now, tick.mid, tick.spread))
        samples.removeAll { it.time < now - 15000L }
        updateBars(tick)

        val short = samples.filter { it.time >= now - 5000L }
        val context = samples
        val reasons = mutableListOf<String>()
        val age = System.currentTimeMillis() - now
        if (!tick.live || age !in -1000..1500) reasons.add("quote_not_live_or_fresh")
        if (short.size < 3) reasons.add("short_window_not_ready")
        if (context.size < 3) reasons.add("context_window_not_ready")

        val shortMove = movement(short)
        val contextMove = movement(context)
        val shortElapsed = if (short.size >= 2) short.last().time - short.first().time else 0L
        val tickRate = if (shortElapsed > 0) (short.size - 1).toDouble() / (shortElapsed / 1000.0) else 0.0
        if (tickRate < 0.2) reasons.add("tick_activity_insufficient")

        val baselineSpread = if (context.isNotEmpty()) context.map { it.spread }.average() else 0.0
        val spreadMultiple = if (baselineSpread > 0) tick.spread / baselineSpread else 1.0
        if (spreadMultiple > 2.5) reasons.add("spread_anomaly")

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
            }
        } else if (confidence < 0.72) reasons.add("confidence_below_threshold")

        evaluatePositionExit(tick, volatility, spreadMultiple, direction, pressure)

        val marketFingerprint = listOf(tick.live, volatility, direction, reasons.joinToString(",")).joinToString("|")
        if (marketFingerprint != lastMarketFingerprint) {
            lastMarketFingerprint = marketFingerprint
            onEvent("MARKET_STATE", null, JSONObject()
                .put("live", tick.live).put("quoteAgeMs", age).put("spread", tick.spread)
                .put("spreadMultiple", spreadMultiple).put("volatilityRegime", volatility)
                .put("momentumDirection", direction ?: JSONObject.NULL).put("reasons", JSONArray(reasons)))
        }

        val fingerprint = action + "|" + side + "|" + reasons.joinToString(",")
        if (fingerprint != lastFingerprint) {
            lastFingerprint = fingerprint
            val payload = JSONObject()
                .put("action", action).put("confidence", confidence)
                .put("validForSeconds", if (side != null) 10 else 0)
                .put("quoteBid", tick.bid).put("quoteAsk", tick.ask)
                .put("quoteMid", tick.mid).put("spread", tick.spread)
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
        val side = position.first
        val entry = position.second
        val opposite = if (side == "BUY") "DOWN" else "UP"
        val exitPrice = if (side == "BUY") tick.bid else tick.ask
        val move = if (side == "BUY") exitPrice - entry else entry - exitPrice
        val action: String
        val reason: String
        when {
            !tick.live -> { action = "HOLD_UNVERIFIED"; reason = "Live quote unavailable; refresh MT5 manually." }
            volatility == "SPIKE" -> { action = "CLOSE_NOW"; reason = "Short-window volatility spike detected." }
            spreadMultiple >= 3.0 -> { action = "CLOSE_NOW"; reason = "Spread expanded to at least three times its recent baseline." }
            direction == opposite && abs(pressure) >= 0.35 && ((side == "BUY" && pressure < 0) || (side == "SELL" && pressure > 0)) -> {
                action = "CLOSE_NOW"; reason = "Short-term momentum and tick pressure reversed against the position."
            }
            else -> { action = "HOLD"; reason = "No emergency exit condition confirmed." }
        }
        val fingerprint = action + "|" + reason
        if (fingerprint == lastExitFingerprint) return
        lastExitFingerprint = fingerprint
        if (action == "CLOSE_NOW" || action == "HOLD_UNVERIFIED") {
            onEvent("EXIT_RECOMMENDED", side, JSONObject()
                .put("action", action).put("reason", reason).put("entryPrice", entry)
                .put("indicativeExitPrice", exitPrice).put("move", move)
                .put("executionEnabled", false).put("manualMT5ActionRequired", action == "CLOSE_NOW"))
        }
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
