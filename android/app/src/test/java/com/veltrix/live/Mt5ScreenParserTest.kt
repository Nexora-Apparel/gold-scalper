package com.veltrix.live

import org.junit.Assert.*
import org.junit.Test

class Mt5ScreenParserTest {
    @Test fun detectsExplicitTradeTabPositionWithEntryPrice() {
        val result = Mt5ScreenParser.parse("Trade\nXAUUSD\nBUY 0.01\nOpen Price 2650.25\nProfit 1.20")
        assertTrue(result.tradeTabVisible)
        assertEquals("XAUUSD", result.symbol)
        assertEquals("BUY", result.side)
        assertEquals(2650.25, result.entryPrice!!, 0.0001)
        assertTrue(result.positionDetected)
        assertTrue(result.confidence >= 0.9)
    }

    @Test fun rejectsAmbiguousChartTextWithoutEntryPrice() {
        val result = Mt5ScreenParser.parse("XAGUSD\nBUY\nMarket Watch")
        assertFalse(result.positionDetected)
        assertNull(result.entryPrice)
    }

    @Test fun detectsSilverSellPosition() {
        val result = Mt5ScreenParser.parse("Trade\nXAGUSD\nSELL 0.02\nEntry Price 31.450")
        assertEquals("XAGUSD", result.symbol)
        assertEquals("SELL", result.side)
        assertTrue(result.positionDetected)
    }

    @Test fun recognizesExplicitNoOpenPositionsState() {
        val result = Mt5ScreenParser.parse("Trade\nNo open positions")
        assertTrue(result.tradeTabVisible)
        assertTrue(result.noOpenPositions)
        assertFalse(result.positionDetected)
    }
}
