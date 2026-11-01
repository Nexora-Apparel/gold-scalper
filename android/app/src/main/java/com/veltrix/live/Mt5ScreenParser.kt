package com.veltrix.live

data class Mt5ScreenSnapshot(
    val tradeTabVisible: Boolean,
    val symbol: String?,
    val side: String?,
    val volumeLots: Double?,
    val entryPrice: Double?,
    val floatingProfit: Double?,
    val positionDetected: Boolean,
    val confidence: Double
)

object Mt5ScreenParser {
    private val numberPattern = Regex("-?\\d+(?:[.,]\\d+)?")

    fun parse(text: String): Mt5ScreenSnapshot {
        val normalized = text.replace(',', '.')
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
            val line = lines.firstOrNull { value -> labels.any { value.lowercase().contains(it) } } ?: return null
            val numbers = numberPattern.findAll(line).mapNotNull { it.value.toDoubleOrNull() }.toList()
            return numbers.lastOrNull()
        }
        val entry = labelledNumber(listOf("open price", "price open", "entry price"))
        val volume = labelledNumber(listOf("volume", "lots", "lot"))
        val profit = labelledNumber(listOf("profit", "p/l"))
        val detected = tradeTab && symbol != null && side != null && entry != null && entry > 0
        val confidence = when {
            detected -> 0.92
            tradeTab && symbol != null && side != null -> 0.65
            tradeTab -> 0.35
            else -> 0.0
        }
        return Mt5ScreenSnapshot(tradeTab, symbol, side, volume, entry, profit, detected, confidence)
    }
}
