package com.veltrix.live

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class OwnerSessionStore(context: Context) {
    private val baseUrl = "https://gold-scalper-nexora-apparel.vercel.app"
    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .writeTimeout(12, TimeUnit.SECONDS)
        .build()
    private val brokerQuoteClient = OkHttpClient.Builder()
        .connectTimeout(1, TimeUnit.SECONDS)
        .readTimeout(1, TimeUnit.SECONDS)
        .writeTimeout(1, TimeUnit.SECONDS)
        .build()
    private val prefs by lazy {
        val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context, "veltrix_owner_session", masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun hasSession(): Boolean = !prefs.getString("cookie", null).isNullOrBlank()

    @Synchronized
    fun login(password: String): Boolean {
        val body = JSONObject().put("password", password).toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder().url(baseUrl + "/api/login").post(body).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return false
            val cookie = response.header("Set-Cookie")?.substringBefore(";") ?: return false
            if (!cookie.startsWith("gold_session=")) return false
            prefs.edit().putString("cookie", cookie).apply()
            return true
        }
    }


    @Synchronized
    fun publishBrokerQuote(symbol: String, bid: Double, ask: Double, observedAtMillis: Long): Boolean {
        val cookie = prefs.getString("cookie", null) ?: return false
        if (symbol != "XAUUSD" && symbol != "XAGUSD") return false
        if (!bid.isFinite() || !ask.isFinite() || bid <= 0.0 || ask <= bid) return false
        val sequence = maxOf(prefs.getLong("broker_quote_sequence", 0L) + 1L, observedAtMillis)
        prefs.edit().putLong("broker_quote_sequence", sequence).apply()
        val body = JSONObject()
            .put("sequence", sequence)
            .put("source", "mt5_android")
            .put("symbol", symbol)
            .put("bid", bid)
            .put("ask", ask)
            .put("observedAt", java.time.Instant.ofEpochMilli(observedAtMillis).toString())
            .put("observationMethod", "user_authorized_local_mt5_screen_ocr")
            .toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder().url(baseUrl + "/api/broker-quote-observation")
            .addHeader("Cookie", cookie).post(body).build()
        brokerQuoteClient.newCall(request).execute().use { response ->
            if (response.code == 401) prefs.edit().remove("cookie").apply()
            if (!response.isSuccessful) return false
            return JSONObject(response.body?.string() ?: "{}").optBoolean("accepted")
        }
    }

    fun syncJournal(database: EventJournalDb): Int {
        val cookie = prefs.getString("cookie", null) ?: return 0
        val events = database.pending(50)
        if (events.isEmpty()) return 0
        val batch = JSONArray()
        events.forEach { event ->
            val item = JSONObject()
                .put("eventId", event.eventId)
                .put("type", event.type)
                .put("symbol", event.symbol)
                .put("occurredAt", event.occurredAt)
                .put("payload", JSONObject(event.payload))
            if (event.side == null) item.put("side", JSONObject.NULL) else item.put("side", event.side)
            batch.put(item)
        }
        val requestBody = batch.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder().url(baseUrl + "/api/scalping-events")
            .addHeader("Cookie", cookie).post(requestBody).build()
        client.newCall(request).execute().use { response ->
            if (response.code == 401) prefs.edit().remove("cookie").apply()
            if (!response.isSuccessful) return 0
            val result = JSONObject(response.body?.string() ?: "{}")
            if (!result.optBoolean("saved") || result.optInt("received") != events.size) return 0
            database.markSynced(events.map { it.eventId })
            return result.optInt("inserted")
        }
    }

    fun logout() { prefs.edit().remove("cookie").apply() }
}
