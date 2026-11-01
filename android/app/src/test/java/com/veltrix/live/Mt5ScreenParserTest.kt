package com.veltrix.live

import org.junit.Assert.*
import org.junit.Test

class Mt5ScreenParserTest {
    @Test fun detectsExplicitTradeTabPositionWithEntryPrice() {
        val result = Mt5ScreenParser.parse("Trade\nXAUUSD\nBUY 0.01\nOpen Price 2650.25\nProfit 1.20\nM1")
        assertTrue(result.tradeTabVisible)
        assertEquals("XAUUSD", result.symbol)
        assertEquals("M1", result.timeframe)
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
        val result = Mt5ScreenParser.parse("Trade\nXAGUSD\nSELL 0.02\nEntry Price 31.450\nProfit 0.00")
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

    @Test fun parsesThousandsSeparatorInMetalPrice() {
        val result = Mt5ScreenParser.parse("Trade\nXAUUSD\nBUY 0.01\nOpen Price 4,172.55\nProfit 0.00")
        assertEquals(4172.55, result.entryPrice!!, 0.0001)
        assertTrue(result.positionDetected)
    }
    @Test fun extractsExnessBidAskForQuoteVerification() {
        val result = Mt5ScreenParser.parse("Trade\nXAUUSD\nBid 4,172.55\nAsk 4,172.70")
        assertTrue(result.quoteDetected)
        assertEquals(4172.55, result.bid!!, 0.0001)
        assertEquals(4172.70, result.ask!!, 0.0001)
        assertEquals(0.15, result.spread!!, 0.0001)
    }
    @Test fun separatesBidAndAskWhenBothAreOnOneOcrLine() {
        val result = Mt5ScreenParser.parse("Trade\nXAUUSD\nBid 4,172.55 Ask 4,172.70")
        assertTrue(result.quoteDetected)
        assertEquals(4172.55, result.bid!!, 0.0001)
        assertEquals(4172.70, result.ask!!, 0.0001)
    }
    @Test fun rejectsBidAskTextWithoutMt5ScreenContext() {
        val result = Mt5ScreenParser.parse("XAUUSD\nBid 4172.50\nAsk 4172.70")
        assertFalse(result.quoteDetected)
        assertNull(result.spread)
    }
    @Test fun rejectsAmbiguousSpreadWhenBothMetalsAppearOnScreen() {
        val result = Mt5ScreenParser.parse("Trade\\nXAUUSD\\nXAGUSD\\nBid 4172.50\\nAsk 4172.70", "XAUUSD")
        assertFalse(result.quoteDetected)
        assertNull(result.spread)
    }
    @Test fun parsesEuropeanDecimalAndThousandsSeparators() {
        val result = Mt5ScreenParser.parse("Trade\nXAUUSD\nBUY 0.01\nOpen Price 4.172,55")
        assertEquals(4172.55, result.entryPrice!!, 0.0001)
    }
    @Test fun prefersTheSelectedInstrumentWhenBothMetalsAreVisible() {
        val result = Mt5ScreenParser.parse("XAUUSD\nXAGUSD\nTrade\nSELL 0.02\nEntry Price 31.450", "XAGUSD")
        assertEquals("XAGUSD", result.symbol)
    }
}
