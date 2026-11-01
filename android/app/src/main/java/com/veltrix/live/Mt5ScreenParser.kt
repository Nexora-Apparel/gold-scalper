package com.veltrix.live

data class Mt5ScreenSnapshot(
    val tradeTabVisible: Boolean,
    val symbol: String?,
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

    fun parse(text: String): Mt5ScreenSnapshot {
        val normalized = text
        val lines = normalized.lines().map { it.trim() }.filter { it.isNotEmpty() }
        val all = normalized.uppercase()
        val tradeTab = all.contains("TRADE") || all.contains("POSITIONS")
        val symbol = when {
            Regex("\\bXAUUSD\\b|\\bGOLD\\b").containsMatchIn(all) -> "XAUUSD"
            Regex("\\bXAGUSD\\b|\\bSILVER\\b").containsMatchIn(all) -> "XAGUSD"
            else -> null
        }
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
                val normalizedToken = when {
                    token.contains(",") && token.contains(".") -> token.replace(",", "")
                    token.contains(",") -> token.replace(",", ".")
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
        val detected = tradeTab && symbol != null && side != null && entry != null && entry > 0
        val noOpenPositions = tradeTab && Regex("NO\\s+(OPEN\\s+)?POSITIONS?").containsMatchIn(all)
        val confidence = when {
            detected -> 0.92
            tradeTab && symbol != null && side != null -> 0.65
            tradeTab -> 0.35
            else -> 0.0
        }
        return Mt5ScreenSnapshot(tradeTab, symbol, side, volume, entry, profit, bid, ask, quoteDetected, detected, noOpenPositions, confidence)
    }
}
