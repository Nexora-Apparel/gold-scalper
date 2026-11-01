package com.veltrix.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class MobileScalpingEngineTest {
    @Test fun restoredUnconfirmedSignalExpiresIntoMissedOpportunity() {
        val events = mutableListOf<String>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, _ -> events.add(type) }
        engine.restorePendingSignal("BUY", 1000L, 0.82)
        engine.checkTimeouts(11000L)
        assertTrue(events.contains("MISSED_OPPORTUNITY"))
    }

    @Test fun invalidRestoredSignalIsIgnored() {
        val events = mutableListOf<String>()
        val engine = MobileScalpingEngine("XAGUSD") { type, _, _ -> events.add(type) }
        engine.restorePendingSignal("HOLD", 1000L, 0.82)
        engine.checkTimeouts(11000L)
        assertEquals(0, events.size)
    }
    @Test fun acceptsFreshObservedMt5SpreadOnlyForSelectedInstrument() {
        val engine = MobileScalpingEngine("XAUUSD") { _, _, _ -> }
        val now = System.currentTimeMillis()
        assertTrue(engine.updateMt5ObservedQuote("XAUUSD", 4172.50, 4172.70, now))
        assertTrue(!engine.updateMt5ObservedQuote("XAGUSD", 31.40, 31.60, now))
        assertTrue(!engine.updateMt5ObservedQuote("XAUUSD", 4172.70, 4172.50, now))
    }
    @Test fun requiresFreshBrokerQuoteToMatchBothSidesAndSpread() {
        val engine = MobileScalpingEngine("XAUUSD") { _, _, _ -> }
        val now = System.currentTimeMillis()
        engine.onTick(LiveTick("XAUUSD", 4172.50, 4172.65, 4172.575, 0.15, now, true))
        assertTrue(engine.verifyBrokerQuote(4172.50, 4172.65))
        assertTrue(!engine.verifyBrokerQuote(4172.80, 4172.95))
    }

    @Test fun productionSignalModeBlocksWhenFreshMt5QuoteIsUnavailable() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAUUSD", requireBrokerQuoteParity = true) { type, _, payload -> events.add(type to payload) }
        val now = System.currentTimeMillis()
        engine.onTick(LiveTick("XAUUSD", 4172.50, 4172.65, 4172.575, 0.15, now, true))
        val noTrade = events.last { it.first == "NO_TRADE" }.second
        assertTrue(noTrade.getJSONArray("reasons").toString().contains("broker_quote_parity_not_verified"))
    }

    @Test fun productionSignalModeAcceptsOnlyFreshMt5QuoteCorroboratedByReference() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAUUSD", requireBrokerQuoteParity = true) { type, _, payload -> events.add(type to payload) }
        val now = System.currentTimeMillis()
        val tick = LiveTick("XAUUSD", 4172.50, 4172.65, 4172.575, 0.15, now, true)
        engine.onTick(tick)
        assertTrue(engine.updateMt5ObservedQuote("XAUUSD", tick.bid, tick.ask, now))
        engine.onTick(tick.copy(timestampMillis = now + 1L))
        val noTrade = events.last { it.first == "NO_TRADE" }.second
        assertTrue(!noTrade.getJSONArray("reasons").toString().contains("broker_quote_parity_not_verified"))
    }


    @Test fun brokerVerificationExpiresWithTheFreshMt5ObservationWindow() {
        val engine = MobileScalpingEngine("XAUUSD", requireBrokerQuoteParity = true) { _, _, _ -> }
        val now = System.currentTimeMillis()
        val tick = LiveTick("XAUUSD", 4172.50, 4172.65, 4172.575, 0.15, now, true)
        engine.onTick(tick)
        assertTrue(engine.updateMt5ObservedQuote("XAUUSD", tick.bid, tick.ask, now))
        assertTrue(engine.hasFreshBrokerQuoteVerification(now))
        assertTrue(!engine.hasFreshBrokerQuoteVerification(now + 2501L))
    }

    @Test fun mismatchedMt5ObservationNeverOpensProductionBrokerGate() {
        val engine = MobileScalpingEngine("XAUUSD", requireBrokerQuoteParity = true) { _, _, _ -> }
        val now = System.currentTimeMillis()
        val tick = LiveTick("XAUUSD", 4172.50, 4172.65, 4172.575, 0.15, now, true)
        engine.onTick(tick)
        assertTrue(engine.updateMt5ObservedQuote("XAUUSD", 4173.10, 4173.30, now))
        assertTrue(!engine.hasFreshBrokerQuoteVerification(now))
    }

    @Test fun recommendsCloseAtSixtySecondMaximumHoldingTime() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, payload -> events.add(type to payload) }
        val openedAt = System.currentTimeMillis() - 61000L
        engine.setPosition("BUY", 4172.50, openedAt)
        val now = System.currentTimeMillis()
        engine.onTick(LiveTick("XAUUSD", 4172.55, 4172.65, 4172.60, 0.10, now, true))
        val exit = events.lastOrNull { it.first == "EXIT_RECOMMENDED" }?.second
        assertTrue(exit != null)
        assertEquals("CLOSE_NOW", exit!!.getString("action"))
        assertEquals("Maximum 60-second scalping holding time reached.", exit.getString("reason"))
        assertTrue(exit.getLong("holdingTimeMs") >= 60000L)
    }

    @Test fun feedFailureEventsAreDeduplicated() {
        val events = mutableListOf<String>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, _ -> events.add(type) }
        engine.onFeedStale()
        engine.onFeedStale()
        assertEquals(1, events.count { it == "ENGINE_STATE" })
    }
    @Test fun delayedAcknowledgementIsLogged() {
        val events = mutableListOf<String>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, _ -> events.add(type) }
        engine.setPosition("BUY", 4172.50)
        repeat(3) {
            val now = System.currentTimeMillis()
            engine.onTick(LiveTick("XAUUSD", 4172.45, 4172.55, 4172.50, 0.10, now, true))
            engine.verifyBrokerQuote(4172.45, 4172.55, 2500L)
            Thread.sleep(3)
        }
        val now = System.currentTimeMillis()
        engine.onTick(LiveTick("XAUUSD", 4172.00, 4173.00, 4172.50, 1.00, now, true))
        assertTrue(events.contains("EXIT_RECOMMENDED"))
        engine.checkTimeouts(System.currentTimeMillis() + 5001L)
        assertTrue(events.contains("EXIT_NOT_CONFIRMED"))
    }
    @Test fun recordsEntryThatDriftedAwayFromTheRecommendationAsMissed() {
        val events = mutableListOf<String>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, _ -> events.add(type) }
        engine.restorePendingSignal("BUY", System.currentTimeMillis(), 0.82, 4172.50, 0.10)
        engine.setPosition("BUY", 4175.00)
        assertTrue(events.contains("MISSED_OPPORTUNITY"))
        assertTrue(!events.contains("ENGINE_STATE"))
    }

    @Test fun buyExitUsesFreshMt5BidWithoutSubtractingSpreadTwice() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, payload -> events.add(type to payload) }
        val now = System.currentTimeMillis()
        engine.setPosition("BUY", 4172.50, now - 2000L)
        assertTrue(engine.updateMt5ObservedQuote("XAUUSD", 4172.62, 4172.82, now))
        engine.onTick(LiveTick("XAUUSD", 4172.40, 4172.50, 4172.45, 0.10, now, true))
        val exit = events.last { it.first == "EXIT_RECOMMENDED" }.second
        assertEquals(4172.62, exit.getDouble("indicativeExitPrice"), 0.000001)
        assertEquals(0.12, exit.getDouble("grossMovePriceUnits"), 0.000001)
        assertEquals("mt5_screen_ocr", exit.getString("closeQuoteSource"))
        assertTrue(exit.getBoolean("spreadIncludedInExecutableQuote"))
        assertTrue(exit.isNull("netProfitCurrency"))
    }

    @Test fun sellExitUsesFreshMt5AskAsExecutableClosePrice() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, payload -> events.add(type to payload) }
        val now = System.currentTimeMillis()
        engine.setPosition("SELL", 4172.50, now - 2000L)
        assertTrue(engine.updateMt5ObservedQuote("XAUUSD", 4172.62, 4172.82, now))
        engine.onTick(LiveTick("XAUUSD", 4172.40, 4172.50, 4172.45, 0.10, now, true))
        val exit = events.last { it.first == "EXIT_RECOMMENDED" }.second
        assertEquals(4172.82, exit.getDouble("indicativeExitPrice"), 0.000001)
        assertEquals(-0.32, exit.getDouble("grossMovePriceUnits"), 0.000001)
        assertEquals("mt5_screen_ocr", exit.getString("closeQuoteSource"))
    }


    @Test fun mt5QuoteMismatchIsExplicitlyReportedAgainstReferenceFeed() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, payload -> events.add(type to payload) }
        val now = System.currentTimeMillis()
        engine.onTick(LiveTick("XAUUSD", 4172.50, 4172.65, 4172.575, 0.15, now, true))
        assertTrue(engine.updateMt5ObservedQuote("XAUUSD", 4173.10, 4173.30, System.currentTimeMillis()))
        val verification = events.last { it.first == "ENGINE_STATE" }.second
        assertEquals("MISMATCHED", verification.getString("mt5ReferenceQuoteVerification"))
    }

    @Test fun matchingMt5QuoteIsExplicitlyVerifiedAgainstReferenceFeed() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, payload -> events.add(type to payload) }
        val now = System.currentTimeMillis()
        engine.onTick(LiveTick("XAUUSD", 4172.50, 4172.65, 4172.575, 0.15, now, true))
        assertTrue(engine.updateMt5ObservedQuote("XAUUSD", 4172.51, 4172.66, System.currentTimeMillis()))
        val verification = events.last { it.first == "ENGINE_STATE" }.second
        assertEquals("MATCHED", verification.getString("mt5ReferenceQuoteVerification"))
    }

    @Test fun staleReferenceFeedCannotLeaveMt5QuoteMarkedMatched() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, payload -> events.add(type to payload) }
        val now = System.currentTimeMillis()
        engine.onTick(LiveTick("XAUUSD", 4172.50, 4172.65, 4172.575, 0.15, now, true))
        engine.updateMt5ObservedQuote("XAUUSD", 4172.51, 4172.66, now)
        engine.onTick(LiveTick("XAUUSD", 4172.50, 4172.65, 4172.575, 0.15, now - 5000L, false))
        val verification = events.last { it.first == "ENGINE_STATE" && it.second.has("mt5ReferenceQuoteVerification") }.second
        assertEquals("REFERENCE_FEED_STALE", verification.getString("mt5ReferenceQuoteVerification"))
    }

    @Test fun expiredMt5QuoteReturnsVerificationToReferenceFeedMode() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, payload -> events.add(type to payload) }
        val now = System.currentTimeMillis()
        engine.onTick(LiveTick("XAUUSD", 4172.50, 4172.65, 4172.575, 0.15, now, true))
        engine.updateMt5ObservedQuote("XAUUSD", 4172.51, 4172.66, now)
        engine.checkTimeouts(now + 3000L)
        val verification = events.last { it.first == "ENGINE_STATE" && it.second.has("mt5ReferenceQuoteVerification") }.second
        assertEquals("NOT_OBSERVED_OR_EXPIRED", verification.getString("mt5ReferenceQuoteVerification"))
        assertEquals("REFERENCE_FEED_MODE", verification.getString("signalGate"))
    }


    @Test fun malformedMarketQuotesAreRejectedBeforeSignalAnalysis() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, payload -> events.add(type to payload) }
        val now = System.currentTimeMillis()
        engine.onTick(LiveTick("XAUUSD", 4172.50, 4172.65, 4173.00, 0.15, now, true))
        val noTrade = events.last { it.first == "NO_TRADE" }.second
        assertTrue(noTrade.getJSONArray("reasons").toString().contains("mid_outside_bid_ask"))
        val state = events.last { it.first == "ENGINE_STATE" }.second
        assertEquals("REJECTED", state.getString("quoteValidation"))
        assertTrue(!state.getBoolean("quoteStreamValid"))
        assertTrue(events.none { it.first == "SIGNAL" })
    }

    @Test fun nonFiniteQuoteValuesAreRejectedBeforeSignalAnalysis() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAGUSD") { type, _, payload -> events.add(type to payload) }
        val now = System.currentTimeMillis()
        engine.onTick(LiveTick("XAGUSD", 31.40, 31.60, Double.NaN, 0.20, now, true))
        val noTrade = events.last { it.first == "NO_TRADE" }.second
        assertTrue(noTrade.getJSONArray("reasons").toString().contains("non_finite_quote_value"))
        assertTrue(events.none { it.first == "SIGNAL" })
    }



    @Test fun repeatedMalformedQuotesDoNotSpamValidationState() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, payload -> events.add(type to payload) }
        repeat(3) {
            engine.onTick(LiveTick("XAUUSD", 4172.50, 4172.65, 4173.00, 0.15, System.currentTimeMillis(), true))
        }
        val rejectedStates = events.count {
            it.first == "ENGINE_STATE" && it.second.optString("quoteValidation") == "REJECTED"
        }
        assertEquals(1, rejectedStates)
    }

    @Test fun validQuoteClearsPreviousQuoteValidationFailure() {
        val events = mutableListOf<Pair<String, org.json.JSONObject>>()
        val engine = MobileScalpingEngine("XAUUSD") { type, _, payload -> events.add(type to payload) }
        engine.onTick(LiveTick("XAUUSD", 4172.50, 4172.65, 4173.00, 0.15, System.currentTimeMillis(), true))
        engine.onTick(LiveTick("XAUUSD", 4172.50, 4172.65, 4172.575, 0.15, System.currentTimeMillis(), true))
        val accepted = events.last { it.first == "ENGINE_STATE" && it.second.has("quoteValidation") }.second
        assertEquals("ACCEPTED", accepted.getString("quoteValidation"))
        assertTrue(accepted.getBoolean("quoteStreamValid"))
    }


}
