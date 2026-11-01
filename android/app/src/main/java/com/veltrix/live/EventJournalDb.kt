package com.veltrix.live

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
import java.util.UUID

data class PendingJournalEvent(
    val eventId: String,
    val type: String,
    val symbol: String,
    val side: String?,
    val occurredAt: String,
    val payload: String
)

class EventJournalDb(context: Context) : SQLiteOpenHelper(context, "veltrix_event_journal.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE journal_events (" +
                "event_id TEXT PRIMARY KEY NOT NULL, event_type TEXT NOT NULL, symbol TEXT NOT NULL, " +
                "side TEXT, occurred_at TEXT NOT NULL, payload TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0, " +
                "created_at INTEGER NOT NULL)"
        )
        db.execSQL("CREATE INDEX journal_pending_idx ON journal_events(synced, created_at)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Additive schema upgrades only. Existing journal rows must never be discarded.
    }

    @Synchronized
    fun record(type: String, symbol: String, payload: JSONObject = JSONObject(), side: String? = null): String {
        require(type in setOf("QUOTE_STATE", "MARKET_STATE", "MT5_SPREAD_OBSERVED", "SIGNAL", "NO_TRADE", "SIGNAL_REJECTED", "MISSED_OPPORTUNITY", "POSITION_OPENED", "EXIT_RECOMMENDED", "EXIT_NOT_CONFIRMED", "EXIT_RECOMMENDATION_CLEARED", "POSITION_CLOSED", "FEED_ERROR", "ENGINE_STATE", "EMERGENCY_STOP", "POSITION_OUTCOME_RECORDED"))
        require(symbol == "XAUUSD" || symbol == "XAGUSD")
        require(side == null || side == "BUY" || side == "SELL")
        val id = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put("event_id", id)
            put("event_type", type)
            put("symbol", symbol)
            if (side == null) putNull("side") else put("side", side)
            put("occurred_at", java.time.Instant.ofEpochMilli(now).toString())
            put("payload", payload.toString())
            put("synced", 0)
            put("created_at", now)
        }
        writableDatabase.insertOrThrow("journal_events", null, values)
        return id
    }

    @Synchronized
    fun pending(limit: Int = 50): List<PendingJournalEvent> {
        val result = mutableListOf<PendingJournalEvent>()
        readableDatabase.rawQuery(
            "SELECT event_id,event_type,symbol,side,occurred_at,payload FROM journal_events WHERE synced=0 ORDER BY created_at LIMIT ?",
            arrayOf(limit.coerceIn(1, 200).toString())
        ).use { cursor ->
            while (cursor.moveToNext()) result.add(PendingJournalEvent(
                cursor.getString(0), cursor.getString(1), cursor.getString(2),
                if (cursor.isNull(3)) null else cursor.getString(3),
                cursor.getString(4), cursor.getString(5)
            ))
        }
        return result
    }

    @Synchronized
    fun markSynced(eventIds: List<String>) {
        if (eventIds.isEmpty()) return
        val db = writableDatabase
        db.beginTransaction()
        try {
            val values = ContentValues().apply { put("synced", 1) }
            eventIds.forEach { id -> db.update("journal_events", values, "event_id=?", arrayOf(id)) }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    @Synchronized
    fun pendingCount(): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM journal_events WHERE synced=0", null).use { cursor ->
            return if (cursor.moveToFirst()) cursor.getInt(0) else 0
        }
    }
}
