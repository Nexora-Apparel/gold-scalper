package com.veltrix.live

import com.google.gson.JsonElement
import com.microsoft.signalr.HubConnection
import com.microsoft.signalr.HubConnectionBuilder
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

data class LiveTick(val bid: Double, val ask: Double, val live: Boolean)

class BiquoteHubClient(
    private val symbol: String,
    private val onTick: (LiveTick) -> Unit,
    private val onState: (String) -> Unit
) {
    private val executor = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var stopped = false
    @Volatile private var connection: HubConnection? = null
    @Volatile private var retrySeconds = 1L

    fun start() { connect() }

    private fun connect() {
        if (stopped) return
        executor.execute {
            try {
                onState("Connecting " + symbol + "…")
                val hub = HubConnectionBuilder.create("https://biquote.io/hubs/tick").build()
                connection = hub
                hub.on("ReceiveTick", { payload: JsonElement -> handleTick(payload) }, JsonElement::class.java)
                hub.onClosed { error ->
                    if (!stopped) {
                        onState("Stream disconnected" + (error?.message?.let { ": " + it } ?: ""))
                        scheduleReconnect()
                    }
                }
                hub.start().blockingAwait(15, TimeUnit.SECONDS)
                hub.invoke(Void::class.java, "Subscribe", listOf(symbol)).blockingAwait(10, TimeUnit.SECONDS)
                retrySeconds = 1L
                onState("Subscribed to " + symbol)
            } catch (error: Exception) {
                onState("Feed connection failed: " + (error.message ?: "unknown"))
                scheduleReconnect()
            }
        }
    }

    private fun handleTick(payload: JsonElement) {
        try {
            val json = payload.asJsonObject
            val bid = json.get("bid")?.asDouble ?: return
            val ask = json.get("ask")?.asDouble ?: return
            val stale = json.get("stale")?.asBoolean ?: true
            val marketState = json.get("marketState")?.asString ?: "unknown"
            val timestamp = json.get("timestamp")?.asString ?: return
            val age = System.currentTimeMillis() - Instant.parse(timestamp).toEpochMilli()
            val live = bid > 0 && ask > bid && !stale && marketState == "open" && age in -1000..1500
            onTick(LiveTick(bid, ask, live))
        } catch (_: Exception) {
            onState("Invalid tick payload · feed rejected")
        }
    }

    private fun scheduleReconnect() {
        if (stopped) return
        val delay = retrySeconds.coerceAtMost(30)
        retrySeconds = (retrySeconds * 2).coerceAtMost(30)
        executor.schedule({ connect() }, delay, TimeUnit.SECONDS)
    }

    fun stop() {
        stopped = true
        try { connection?.stop()?.blockingAwait(3, TimeUnit.SECONDS) } catch (_: Exception) {}
        executor.shutdownNow()
    }
}
