package com.veltrix.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
