package com.veltrix.live

data class Mt5ScreenSnapshot(
    val tradeTabVisible: Boolean,
    val symbol: String?,
    val timeframe: String?,
    val side: String?,
    val volumeLots: Double?,
    val entryPrice: Double?,
    val floatingProfit: Double?,
    val bid: Double?,
    val ask: Double?,
    val quoteDetected: Boolean,
    val positionDetected: Boolean,
    val noOpenPositions: Boolean,
    val confidence: Double
)

object Mt5ScreenParser {
    // Conservative local OCR parser; never uploads captured screen frames.
    private val numberPattern = Regex("-?\\d[\\d,.]*")

    fun parse(text: String, expectedSymbol: String? = null): Mt5ScreenSnapshot {
        val normalized = text
        val lines = normalized.lines().map { it.trim() }.filter { it.isNotEmpty() }
        val all = normalized.uppercase()
        val tradeTab = all.contains("TRADE") || all.contains("POSITIONS")
        val hasGold = Regex("\\bXAUUSD\\b|\\bGOLD\\b").containsMatchIn(all)
        val hasSilver = Regex("\\bXAGUSD\\b|\\bSILVER\\b").containsMatchIn(all)
        val symbol = when {
            expectedSymbol == "XAUUSD" && hasGold -> "XAUUSD"
            expectedSymbol == "XAGUSD" && hasSilver -> "XAGUSD"
            hasGold -> "XAUUSD"
            hasSilver -> "XAGUSD"
            else -> null
        }
        val timeframe = Regex("\\b(M1|M5|M15|M30|H1|H4|D1|W1|MN1)\\b").find(all)?.groupValues?.get(1)
        val side = when {
            Regex("\\bBUY\\b").containsMatchIn(all) -> "BUY"
            Regex("\\bSELL\\b").containsMatchIn(all) -> "SELL"
            else -> null
        }
        fun labelledNumber(labels: List<String>): Double? {
            for (label in labels) {
                val line = lines.firstOrNull { it.lowercase().contains(label) } ?: continue
                val index = line.lowercase().indexOf(label)
                if (index < 0) continue
                val token = numberPattern.find(line.substring(index + label.length))?.value ?: continue
                val commaAt = token.lastIndexOf(',')
                val dotAt = token.lastIndexOf('.')
                val normalizedToken = when {
                    commaAt >= 0 && dotAt >= 0 && commaAt > dotAt -> token.replace(".", "").replace(",", ".")
                    commaAt >= 0 && dotAt >= 0 -> token.replace(",", "")
                    commaAt >= 0 && dotAt < 0 && token.length - commaAt - 1 == 3 -> token.replace(",", "")
                    commaAt >= 0 -> token.replace(",", ".")
                    else -> token
                }
                normalizedToken.toDoubleOrNull()?.let { return it }
            }
            return null
        }
        val entry = labelledNumber(listOf("open price", "price open", "entry price"))
        val volume = labelledNumber(listOf("volume", "lots", "lot"))
        val profit = labelledNumber(listOf("profit", "p/l"))
        val bid = labelledNumber(listOf("bid"))
        val ask = labelledNumber(listOf("ask"))
        val quoteDetected = symbol != null && bid != null && ask != null && bid > 0 && ask > bid
        val positionEvidence = Regex("\\b(PROFIT|SWAP|COMMISSION)\\b").containsMatchIn(all)
        val detected = tradeTab && positionEvidence && symbol != null && side != null && entry != null && entry > 0
        val noOpenPositions = tradeTab && Regex("NO\\s+(OPEN\\s+)?POSITIONS?").containsMatchIn(all)
        val confidence = when {
            detected -> 0.92
            tradeTab && symbol != null && side != null -> 0.65
            tradeTab -> 0.35
            else -> 0.0
        }
        return Mt5ScreenSnapshot(tradeTab, symbol, timeframe, side, volume, entry, profit, bid, ask, quoteDetected, detected, noOpenPositions, confidence)
    }
}
