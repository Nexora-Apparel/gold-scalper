package com.veltrix.live

/**
 * Requires repeated explicit MT5 "no open positions" evidence before a tracked
 * position can be marked closed. A missing OCR row is never closure evidence.
 */
class PositionClosureConfirmation(private val requiredFrames: Int = 3) {
    private var consecutiveFrames = 0

    init { require(requiredFrames >= 2) }

    @Synchronized
    fun observe(tradeTabVisible: Boolean, explicitNoOpenPositions: Boolean): Boolean {
        if (!tradeTabVisible || !explicitNoOpenPositions) {
            consecutiveFrames = 0
            return false
        }
        consecutiveFrames += 1
        if (consecutiveFrames >= requiredFrames) {
            consecutiveFrames = 0
            return true
        }
        return false
    }

    @Synchronized
    fun reset() { consecutiveFrames = 0 }
}
