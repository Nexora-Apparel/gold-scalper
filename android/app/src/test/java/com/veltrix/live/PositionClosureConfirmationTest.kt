package com.veltrix.live

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PositionClosureConfirmationTest {
    @Test fun requiresThreeExplicitTradeTabFrames() {
        val gate = PositionClosureConfirmation(3)
        assertFalse(gate.observe(true, true))
        assertFalse(gate.observe(true, true))
        assertTrue(gate.observe(true, true))
    }

    @Test fun resetsWhenEvidenceIsMissingOrTradeTabIsNotVisible() {
        val gate = PositionClosureConfirmation(3)
        assertFalse(gate.observe(true, true))
        assertFalse(gate.observe(false, true))
        assertFalse(gate.observe(true, true))
        assertFalse(gate.observe(true, false))
        assertFalse(gate.observe(true, true))
    }

    @Test fun emitsOnlyOncePerConfirmedClosure() {
        val gate = PositionClosureConfirmation(2)
        assertFalse(gate.observe(true, true))
        assertTrue(gate.observe(true, true))
        assertFalse(gate.observe(true, true))
    }
}
