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
    @Test fun requiresFreshBrokerQuoteToMatchBothSidesAndSpread() {
        val engine = MobileScalpingEngine("XAUUSD") { _, _, _ -> }
        val now = System.currentTimeMillis()
        engine.onTick(LiveTick("XAUUSD", 4172.50, 4172.65, 4172.575, 0.15, now, true))
        assertTrue(engine.verifyExnessQuote(4172.50, 4172.65))
        assertTrue(!engine.verifyExnessQuote(4172.80, 4172.95))
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
            Thread.sleep(3)
        }
        val now = System.currentTimeMillis()
        engine.onTick(LiveTick("XAUUSD", 4172.00, 4173.00, 4172.50, 1.00, now, true))
        assertTrue(events.contains("EXIT_RECOMMENDED"))
        engine.checkTimeouts(System.currentTimeMillis() + 5001L)
        assertTrue(events.contains("EXIT_NOT_CONFIRMED"))
    }
}
