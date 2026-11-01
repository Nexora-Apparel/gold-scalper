package com.veltrix.live

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.Activity
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.util.DisplayMetrics
import android.os.HandlerThread
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.Bitmap
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.animation.AlphaAnimation
import android.view.animation.Animation
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.UUID

class FloatingAssistantService : Service() {
    private lateinit var windowManager: WindowManager
    private var dot: TextView? = null
    private var panel: TextView? = null
    private var dotParams: WindowManager.LayoutParams? = null
    private val worker = Executors.newSingleThreadExecutor()
    private val syncWorker = Executors.newSingleThreadExecutor()
    @Volatile private var syncInFlight = false
    private var hub: BiquoteHubClient? = null
    private var mobileEngine: MobileScalpingEngine? = null
    @Volatile private var paused = false
    @Volatile private var feedHealthy = false
    @Volatile private var lastTickAt = 0L
    @Volatile private var latestText = "Connecting to market feed…"
    @Volatile private var currentDecisionText: String? = null
    @Volatile private var criticalExitAlert = false
    private val prefs by lazy { getSharedPreferences("veltrix_live", MODE_PRIVATE) }
    private val journal by lazy { EventJournalDb(this) }
    private val ownerSession by lazy { OwnerSessionStore(this) }
    @Volatile private var lastQuoteState: Boolean? = null
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var ocrThread: HandlerThread? = null
    private var lastOcrAt = 0L
    private var lastPositionSignature: String? = null
    private var lastScreenTimeframe: String? = null
    private var lastScreenMismatch: String? = null
    @Volatile private var pendingSignalEventId: String? = null
    private var activePositionId: String? = null
    private var missingPositionFrames = 0
    private val textRecognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        prefs.edit().putBoolean("assistant_active", true).apply()
        startForeground(7101, notification("Connecting to biquote market data"))
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        showFloatingDot()
        connectSelectedMarket()
        worker.execute {
            var lastSyncAt = 0L
            while (!Thread.currentThread().isInterrupted) {
                mobileEngine?.checkTimeouts()
                val fresh = feedHealthy && System.currentTimeMillis() - lastTickAt <= 5000
                if (feedHealthy && !fresh) {
                    feedHealthy = false
                    latestText = "STALE FEED · NO SIGNAL"
                    currentDecisionText = null
                    val selected = prefs.getString("symbol", "XAUUSD") ?: "XAUUSD"
                    journal.record("FEED_ERROR", selected, JSONObject().put("reason", "tick_stream_stale").put("lastTickAt", lastTickAt))
                    mobileEngine?.onFeedStale()
                }
                if (ownerSession.hasSession() && !syncInFlight && System.currentTimeMillis() - lastSyncAt >= 10000) {
                    lastSyncAt = System.currentTimeMillis()
                    syncInFlight = true
                    try {
                        syncWorker.execute {
                            try { ownerSession.syncJournal(journal) } catch (_: Exception) { }
                            finally { syncInFlight = false }
                        }
                    } catch (_: java.util.concurrent.RejectedExecutionException) {
                        syncInFlight = false
                    }
                }
                Handler(Looper.getMainLooper()).post {
                    (dot?.background as? android.graphics.drawable.GradientDrawable)?.setColor(if (paused) 0xFF737373.toInt() else if (fresh) 0xFFE53935.toInt() else 0xFFFFB300.toInt())
                    if (!paused && fresh && dot?.animation == null) {
                        dot?.startAnimation(AlphaAnimation(0.45f, 1.0f).apply {
                            duration = 900
                            repeatMode = Animation.REVERSE
                            repeatCount = Animation.INFINITE
                        })
                    } else if ((paused || !fresh) && dot?.animation != null) {
                        dot?.clearAnimation()
                    }
                    panel?.text = "VELTRIX LIVE\n" + prefs.getString("symbol", "XAUUSD") + "\n" + latestText + "\n" + (if (paused) "PAUSED" else if (fresh) "LIVE FEED" else "FEED ISSUE") + "\nTap panel to pause/resume · tap dot to hide"
                }
                Thread.sleep(1000)
            }
        }
    }

    private fun connectSelectedMarket() {
        val symbol = prefs.getString("symbol", "XAUUSD") ?: "XAUUSD"
        pendingSignalEventId = prefs.getString("pending_signal_event_id", null)
        val engine = MobileScalpingEngine(symbol) { eventType, side, payload ->
            val journalEventId = journal.record(eventType, symbol, payload, side)
            if (eventType == "SIGNAL" && side != null) {
                pendingSignalEventId = journalEventId
                prefs.edit().putString("pending_signal_event_id", journalEventId)
                    .putString("pending_signal_side", side)
                    .putLong("pending_signal_at", payload.optLong("signalAt", System.currentTimeMillis()))
                    .putFloat("pending_signal_confidence", payload.optDouble("confidence", 0.0).toFloat()).apply()
            } else if (eventType == "MISSED_OPPORTUNITY") {
                pendingSignalEventId = null
                prefs.edit().remove("pending_signal_event_id").remove("pending_signal_side")
                    .remove("pending_signal_at").remove("pending_signal_confidence").apply()
            } else if (eventType == "ENGINE_STATE" && payload.optBoolean("signalAccepted")) {
                val acceptedSignalId = pendingSignalEventId ?: prefs.getString("pending_signal_event_id", null)
                val editor = prefs.edit().remove("pending_signal_event_id").remove("pending_signal_side")
                    .remove("pending_signal_at").remove("pending_signal_confidence")
                if (acceptedSignalId != null) editor.putString("active_position_signal_event_id", acceptedSignalId)
                editor.apply()
                pendingSignalEventId = null
            }
            if (eventType == "POSITION_OPENED" || eventType == "POSITION_CLOSED") { criticalExitAlert = false; currentDecisionText = null }
            if (eventType == "EXIT_RECOMMENDED") {
                val action = payload.optString("action")
                criticalExitAlert = action == "CLOSE_NOW" || action == "HOLD_UNVERIFIED"
                currentDecisionText = when (action) {
                    "CLOSE_NOW" -> "CLOSE NOW · " + payload.optString("reason")
                    "HOLD_UNVERIFIED" -> "HOLD · FEED UNVERIFIED"
                    else -> "POSITION HOLD · monitoring"
                }
                latestText = currentDecisionText ?: latestText
                updateNotification(latestText)
            } else if (eventType == "SIGNAL") {
                currentDecisionText = payload.optString("action").replace("_", " ") + " · manual MT5 only"
                latestText = currentDecisionText ?: latestText
                updateNotification(latestText)
            } else if (eventType == "NO_TRADE" && !criticalExitAlert) {
                currentDecisionText = "NO TRADE · " + (payload.optJSONArray("reasons")?.toString() ?: "quality gate blocked")
                latestText = currentDecisionText ?: latestText
                updateNotification(latestText)
            } else if (eventType == "MISSED_OPPORTUNITY" && !criticalExitAlert) {
                currentDecisionText = "MISSED OPPORTUNITY · signal expired"
                latestText = currentDecisionText ?: latestText
                updateNotification(latestText)
            } else if (eventType == "ENGINE_STATE" && payload.has("exnessQuoteVerification") && !criticalExitAlert) {
                val verification = payload.optString("exnessQuoteVerification")
                currentDecisionText = if (verification == "MATCHED") "EXNESS QUOTE MATCHED · SIGNAL GATE OPEN" else "EXNESS QUOTE " + verification + " · SIGNALS BLOCKED"
                latestText = currentDecisionText ?: latestText
                updateNotification(latestText)
            }
        }
        mobileEngine = engine
        engine.restorePendingSignal(
            prefs.getString("pending_signal_side", null),
            prefs.getLong("pending_signal_at", 0L),
            prefs.getFloat("pending_signal_confidence", 0f).toDouble()
        )
        if (prefs.getBoolean("position_active", false)) {
            val savedSide = prefs.getString("active_position_side", null)
            val savedEntry = prefs.getString("active_position_entry", null)?.toDoubleOrNull()
            if ((savedSide == "BUY" || savedSide == "SELL") && savedEntry != null && savedEntry > 0) {
                engine.setPosition(savedSide, savedEntry)
                activePositionId = prefs.getString("active_position_id", null)
                lastPositionSignature = listOf(symbol, savedSide, savedEntry.toString()).joinToString("|")
            }
        }
        hub = BiquoteHubClient(symbol, { tick ->
            if (!tick.live) engine.onFeedStale()
            engine.onTick(tick)
            lastTickAt = System.currentTimeMillis()
            feedHealthy = tick.live
            if (tick.live && currentDecisionText?.startsWith("HOLD · FEED UNVERIFIED") == true) currentDecisionText = null
            latestText = currentDecisionText ?: if (!tick.live) "Market closed or quote stale" else ("Bid " + tick.bid + " · Ask " + tick.ask)
            if (lastQuoteState != tick.live) {
                lastQuoteState = tick.live
                journal.record("QUOTE_STATE", symbol, JSONObject().put("live", tick.live).put("bid", tick.bid).put("ask", tick.ask))
            }
            updateNotification(latestText)
        }, { state ->
            feedHealthy = false
            currentDecisionText = null
            latestText = state
            val type = if (state.contains("failed", true) || state.contains("disconnected", true) || state.contains("invalid", true) || state.contains("unexpected", true) || state.contains("rejected", true)) "FEED_ERROR" else "ENGINE_STATE"
            if (type == "FEED_ERROR") mobileEngine?.onFeedStale()
            journal.record(type, symbol, JSONObject().put("state", state))
            updateNotification(currentDecisionText ?: state)
        })
        hub?.start()
    }

    private fun showFloatingDot() {
        dot = TextView(this).apply {
            text = "V"; textSize = 16f; setTextColor(0xFFFFFFFF.toInt())
            typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.CENTER
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.OVAL
                setColor(0xFFE53935.toInt()); setStroke(2, 0xFFFFFFFF.toInt())
            }
        }
        dotParams = WindowManager.LayoutParams(
            52, 52, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = prefs.getInt("overlay_x", 0); y = prefs.getInt("overlay_y", 260)
        }
        dot?.setOnTouchListener(makeDragListener())
        try { windowManager.addView(dot, dotParams) } catch (_: Exception) { stopSelf() }
    }

    private fun makeDragListener(): View.OnTouchListener {
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var dragged = false
        return View.OnTouchListener { view, event ->
            val params = dotParams ?: return@OnTouchListener false
            when (event.action) {
                MotionEvent.ACTION_DOWN -> { downX = event.rawX; downY = event.rawY; startX = params.x; startY = params.y; dragged = false; true }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - downX).toInt(); val dy = (event.rawY - downY).toInt()
                    if (kotlin.math.abs(dx) + kotlin.math.abs(dy) > 8) dragged = true
                    params.x = startX + dx; params.y = startY + dy
                    windowManager.updateViewLayout(view, params); true
                }
                MotionEvent.ACTION_UP -> {
                    prefs.edit().putInt("overlay_x", params.x).putInt("overlay_y", params.y).apply()
                    if (!dragged) togglePanel()
                    true
                }
                else -> false
            }
        }
    }

    private fun togglePanel() {
        if (panel != null) {
            try { windowManager.removeView(panel) } catch (_: Exception) {}
            panel = null
            return
        }
        panel = TextView(this).apply {
            text = "VELTRIX LIVE\n" + prefs.getString("symbol", "XAUUSD") + "\n" + latestText + "\nManual MT5 only"
            textSize = 13f; setTextColor(0xFFFFFFFF.toInt()); setPadding(16, 14, 16, 14)
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(0xFF111318.toInt()); cornerRadius = 18f; setStroke(1, 0xFF555555.toInt())
            }
        }
        panel?.setOnClickListener {
            paused = !paused
            mobileEngine?.setPaused(paused)
            latestText = if (paused) "PAUSED · NO NEW SIGNALS" else "RESUMED · MONITORING"
            updateNotification(latestText)
        }
        val params = WindowManager.LayoutParams(
            260, WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = (dotParams?.x ?: 0) - 190; y = (dotParams?.y ?: 260) + 58
        }
        try { windowManager.addView(panel, params) } catch (_: Exception) { panel = null }
    }

    private fun startScreenObservation(resultCode: Int, data: Intent) {
        try {
            val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val projection = manager.getMediaProjection(resultCode, data) ?: return
            mediaProjection = projection
            projection.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    stopScreenObservation()
                    journal.record("ENGINE_STATE", prefs.getString("symbol", "XAUUSD") ?: "XAUUSD", JSONObject().put("screenObservation", "stopped_by_system_or_user"))
                }
            }, Handler(Looper.getMainLooper()))
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            (getSystemService(WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(metrics)
            val reader = ImageReader.newInstance(metrics.widthPixels, metrics.heightPixels, PixelFormat.RGBA_8888, 2)
            imageReader = reader
            val thread = HandlerThread("veltrix-local-screen-ocr")
            thread.start()
            ocrThread = thread
            val handler = Handler(thread.looper)
            reader.setOnImageAvailableListener({ source ->
                val now = System.currentTimeMillis()
                if (now - lastOcrAt < 1200) {
                    source.acquireLatestImage()?.close()
                    return@setOnImageAvailableListener
                }
                lastOcrAt = now
                val frame = source.acquireLatestImage() ?: return@setOnImageAvailableListener
                var paddedBitmap: Bitmap? = null
                var croppedBitmap: Bitmap? = null
                try {
                    val plane = frame.planes[0]
                    val pixelStride = plane.pixelStride
                    val rowPadding = plane.rowStride - pixelStride * frame.width
                    val padded = Bitmap.createBitmap(frame.width + rowPadding / pixelStride, frame.height, Bitmap.Config.ARGB_8888)
                    paddedBitmap = padded
                    padded.copyPixelsFromBuffer(plane.buffer)
                    val cropped = Bitmap.createBitmap(padded, 0, 0, frame.width, frame.height)
                    croppedBitmap = cropped
                    val input = InputImage.fromBitmap(cropped, 0)
                    textRecognizer.process(input)
                        .addOnSuccessListener { result -> handleScreenText(result.text) }
                        .addOnFailureListener { error ->
                            latestText = "Local screen reading unavailable"
                            journal.record("ENGINE_STATE", prefs.getString("symbol", "XAUUSD") ?: "XAUUSD", JSONObject().put("screenOcrError", error.message ?: "unknown"))
                        }
                        .addOnCompleteListener {
                            frame.close()
                            try { cropped.recycle() } catch (_: Exception) {}
                            try { if (padded !== cropped) padded.recycle() } catch (_: Exception) {}
                        }
                } catch (error: Exception) {
                    frame.close()
                    try { croppedBitmap?.recycle() } catch (_: Exception) {}
                    try { if (paddedBitmap !== croppedBitmap) paddedBitmap?.recycle() } catch (_: Exception) {}
                    latestText = "Screen frame rejected"
                }
            }, handler)
            virtualDisplay = projection.createVirtualDisplay(
                "VELTRIX LIVE screen observer", metrics.widthPixels, metrics.heightPixels,
                metrics.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.surface, null, handler
            )
            latestText = "LOCAL MT5 OCR ACTIVE · " + (prefs.getString("symbol", "XAUUSD") ?: "XAUUSD")
            updateNotification(latestText)
            journal.record("ENGINE_STATE", prefs.getString("symbol", "XAUUSD") ?: "XAUUSD", JSONObject().put("screenObservation", "user_authorized_local_ocr_active"))
        } catch (error: Exception) {
            latestText = "Screen observation unavailable"
            journal.record("FEED_ERROR", prefs.getString("symbol", "XAUUSD") ?: "XAUUSD", JSONObject().put("screenCaptureError", error.message ?: "unknown"))
        }
    }

    private fun handleScreenText(text: String) {
        val snapshot = Mt5ScreenParser.parse(text, prefs.getString("symbol", "XAUUSD"))
        val symbol = prefs.getString("symbol", "XAUUSD") ?: "XAUUSD"
        if (snapshot.symbol != null && snapshot.symbol != symbol) {
            if (lastScreenMismatch != snapshot.symbol) {
                lastScreenMismatch = snapshot.symbol
                journal.record("ENGINE_STATE", symbol, JSONObject().put("screenSymbolMismatch", true)
                    .put("selectedSymbol", symbol).put("detectedSymbol", snapshot.symbol)
                    .put("screenTimeframe", snapshot.timeframe ?: JSONObject.NULL))
            }
            if (!criticalExitAlert) currentDecisionText = "MT5 SCREEN SYMBOL MISMATCH · SELECT " + symbol
            latestText = currentDecisionText ?: latestText
            return
        }
        if (snapshot.symbol == symbol && lastScreenMismatch != null) {
            journal.record("ENGINE_STATE", symbol, JSONObject().put("screenSymbolMismatch", false)
                .put("selectedSymbol", symbol).put("screenTimeframe", snapshot.timeframe ?: JSONObject.NULL))
            lastScreenMismatch = null
            if (currentDecisionText?.startsWith("MT5 SCREEN SYMBOL MISMATCH") == true) currentDecisionText = null
        }
        if (snapshot.timeframe != null && snapshot.timeframe != lastScreenTimeframe) {
            lastScreenTimeframe = snapshot.timeframe
            journal.record("ENGINE_STATE", symbol, JSONObject().put("mt5ScreenSymbol", symbol)
                .put("mt5ScreenTimeframe", snapshot.timeframe).put("rawScreenUploaded", false))
        }
        if (snapshot.quoteDetected && snapshot.symbol == symbol && snapshot.bid != null && snapshot.ask != null) {
            val matched = mobileEngine?.verifyExnessQuote(snapshot.bid, snapshot.ask) == true
            if (matched) latestText = "EXNESS MT5 QUOTE MATCHED · SIGNAL GATE OPEN"
            else if (feedHealthy) latestText = "EXNESS QUOTE MISMATCH · NO SIGNAL"
        }
        if (snapshot.noOpenPositions) {
            if (lastPositionSignature != null || prefs.getBoolean("position_active", false)) {
                val fields = lastPositionSignature?.split("|") ?: emptyList()
                val storedSide = prefs.getString("active_position_side", null)
                val closedSide = fields.getOrNull(1) ?: storedSide
                val positionId = activePositionId ?: prefs.getString("active_position_id", null)
                val payload = JSONObject().put("source", "user_authorized_local_mt5_screen_ocr")
                    .put("positionId", positionId ?: JSONObject.NULL)
                    .put("sourceSignalRef", prefs.getString("active_position_signal_event_id", null) ?: JSONObject.NULL)
                    .put("closureEvidence", "explicit_no_open_positions_text")
                    .put("confidence", 0.9).put("rawScreenUploaded", false)
                journal.record("POSITION_CLOSED", symbol, payload, if (closedSide == "BUY" || closedSide == "SELL") closedSide else null)
            }
            mobileEngine?.clearPosition()
            currentDecisionText = null
            prefs.edit().putBoolean("position_active", false).remove("active_position_id").remove("active_position_side")
                    .remove("active_position_entry").remove("active_position_volume").remove("active_position_signal_event_id").apply()
            activePositionId = null
            lastPositionSignature = null
            missingPositionFrames = 0
            latestText = "MT5 shows no open positions"
            return
        }
        if (snapshot.positionDetected && snapshot.side != null && snapshot.entryPrice != null) {
            val signature = listOf(symbol, snapshot.side, snapshot.entryPrice.toString()).joinToString("|")
            val existing = lastPositionSignature?.split("|")
            if (prefs.getBoolean("position_active", false) && existing != null &&
                (existing.getOrNull(1) != snapshot.side || existing.getOrNull(2) != snapshot.entryPrice.toString())) {
                journal.record("ENGINE_STATE", symbol, JSONObject()
                    .put("positionTrackingConflict", true)
                    .put("note", "A second or changed MT5 position was detected; only one position can be tracked safely.")
                    .put("detectedSide", snapshot.side).put("detectedEntry", snapshot.entryPrice))
                latestText = "POSITION TRACKING CONFLICT · VERIFY MT5 MANUALLY"
                return
            }
            missingPositionFrames = 0
            activePositionId = activePositionId ?: prefs.getString("active_position_id", null) ?: UUID.randomUUID().toString()
            prefs.edit().putBoolean("position_active", true).putString("active_position_id", activePositionId)
                .putString("active_position_side", snapshot.side).putString("active_position_entry", snapshot.entryPrice.toString())
                .putString("active_position_volume", snapshot.volumeLots?.toString() ?: "0").apply()
            mobileEngine?.setPosition(snapshot.side, snapshot.entryPrice)
            if (signature != lastPositionSignature) {
                lastPositionSignature = signature
                val payload = JSONObject()
                    .put("positionId", activePositionId)
                    .put("sourceSignalRef", prefs.getString("active_position_signal_event_id", null) ?: JSONObject.NULL)
                    .put("side", snapshot.side)
                    .put("entryPrice", snapshot.entryPrice)
                    .put("mt5Timeframe", snapshot.timeframe ?: JSONObject.NULL)
                    .put("volumeLots", snapshot.volumeLots ?: JSONObject.NULL)
                    .put("floatingProfit", snapshot.floatingProfit ?: JSONObject.NULL)
                    .put("source", "user_authorized_local_mt5_screen_ocr")
                    .put("confidence", snapshot.confidence)
                    .put("rawScreenUploaded", false)
                journal.record("POSITION_OPENED", symbol, payload, snapshot.side)
            }
            latestText = "MT5 " + snapshot.side + " " + symbol + " @ " + snapshot.entryPrice
        } else if (snapshot.tradeTabVisible && lastPositionSignature != null) {
            missingPositionFrames += 1
            if (missingPositionFrames == 3) {
                journal.record("ENGINE_STATE", symbol, JSONObject().put("positionVisibility", "not_visible").put("note", "OCR absence is not proof of closure; confirm the MT5 Trade tab manually."))
            }
        }
    }

    private fun stopScreenObservation() {
        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        try { imageReader?.setOnImageAvailableListener(null, null); imageReader?.close() } catch (_: Exception) {}
        imageReader = null
        try { mediaProjection?.stop() } catch (_: Exception) {}
        mediaProjection = null
        try { ocrThread?.quitSafely() } catch (_: Exception) {}
        ocrThread = null
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel("veltrix_live", "VELTRIX LIVE", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun notification(text: String): Notification {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, "veltrix_live").setContentTitle("VELTRIX LIVE").setContentText(text)
                .setSmallIcon(R.drawable.ic_veltrix_notification).setOngoing(true).build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setContentTitle("VELTRIX LIVE").setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_info_details).setOngoing(true).build()
        }
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(7101, notification(text))
    }

    @Suppress("DEPRECATION")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "CHANGE_SYMBOL") {
            if (prefs.getBoolean("position_active", false)) {
                latestText = "MARKET SWITCH BLOCKED · CLOSE MT5 POSITION FIRST"
                journal.record("ENGINE_STATE", prefs.getString("symbol", "XAUUSD") ?: "XAUUSD", JSONObject().put("marketSelectionChangeBlocked", true).put("reason", "position_active"))
            } else {
                hub?.stop()
                connectSelectedMarket()
                journal.record("ENGINE_STATE", prefs.getString("symbol", "XAUUSD") ?: "XAUUSD", JSONObject().put("marketSelectionChanged", true))
            }
        }
        if (intent?.action == "JOURNAL_POSITION_OPEN") {
            val side = intent.getStringExtra("position_side") ?: ""
            val entry = intent.getDoubleExtra("entry_price", 0.0)
            val volume = intent.getDoubleExtra("volume_lots", 0.0)
            if (side == "BUY" || side == "SELL") {
                if (entry > 0 && mobileEngine != null && !prefs.getBoolean("position_active", false)) {
                    activePositionId = UUID.randomUUID().toString()
                    lastPositionSignature = listOf(prefs.getString("symbol", "XAUUSD"), side, entry.toString()).joinToString("|")
                    prefs.edit().putBoolean("position_active", true).putString("active_position_id", activePositionId)
                        .putString("active_position_side", side).putString("active_position_entry", entry.toString())
                        .putString("active_position_volume", volume.toString()).apply()
                    mobileEngine?.setPosition(side, entry)
                    journal.record("POSITION_OPENED", prefs.getString("symbol", "XAUUSD") ?: "XAUUSD",
                        JSONObject().put("positionId", activePositionId)
                            .put("sourceSignalRef", prefs.getString("active_position_signal_event_id", null) ?: JSONObject.NULL)
                            .put("side", side).put("entryPrice", entry)
                            .put("volumeLots", volume).put("source", "manual_mt5_journal_entry"), side)
                    latestText = "POSITION JOURNALED · " + side
                } else { latestText = "POSITION NOT JOURNALED · CHECK ENGINE OR EXISTING POSITION" }
                updateNotification(latestText)
            }
        }
        if (intent?.action == "JOURNAL_POSITION_CLOSE") {
            if (prefs.getBoolean("position_active", false)) {
                val exitPrice = intent.getDoubleExtra("exit_price", 0.0)
                val realizedR = intent.getDoubleExtra("realized_r", Double.NaN)
                val side = prefs.getString("active_position_side", null)
                val positionId = activePositionId ?: prefs.getString("active_position_id", null)
                val payload = JSONObject().put("positionId", positionId ?: JSONObject.NULL)
                    .put("sourceSignalRef", prefs.getString("active_position_signal_event_id", null) ?: JSONObject.NULL)
                    .put("source", "manual_mt5_journal_entry").put("exitPrice", if (exitPrice > 0) exitPrice else JSONObject.NULL)
                journal.record("POSITION_CLOSED", prefs.getString("symbol", "XAUUSD") ?: "XAUUSD", payload, if (side == "BUY" || side == "SELL") side else null)
                if (realizedR.isFinite() && positionId != null) {
                    journal.record("POSITION_OUTCOME_RECORDED", prefs.getString("symbol", "XAUUSD") ?: "XAUUSD",
                        JSONObject().put("positionId", positionId)
                            .put("sourceSignalRef", prefs.getString("active_position_signal_event_id", null) ?: JSONObject.NULL)
                            .put("realizedR", realizedR).put("exitPrice", if (exitPrice > 0) exitPrice else JSONObject.NULL),
                        if (side == "BUY" || side == "SELL") side else null)
                }
                mobileEngine?.clearPosition()
                prefs.edit().putBoolean("position_active", false).remove("active_position_id").remove("active_position_side")
                    .remove("active_position_entry").remove("active_position_volume").remove("active_position_signal_event_id").apply()
                activePositionId = null; lastPositionSignature = null
                latestText = "POSITION JOURNALED CLOSED"
                updateNotification(latestText)
            }
        }
        if (intent?.action == "VERIFY_QUOTES") {
            val bid = intent.getDoubleExtra("exness_bid", 0.0)
            val ask = intent.getDoubleExtra("exness_ask", 0.0)
            val matched = mobileEngine?.verifyExnessQuote(bid, ask) == true
            latestText = if (matched) "EXNESS QUOTE VERIFIED · 5 MIN" else "EXNESS QUOTE MISMATCH · NO SIGNAL"
            updateNotification(latestText)
        }
        val resultCode = intent?.getIntExtra("projection_result_code", Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        val projectionData: Intent? = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra("projection_data", Intent::class.java)
            else intent?.getParcelableExtra("projection_data")
        if (resultCode == Activity.RESULT_OK && projectionData != null && mediaProjection == null) {
            startScreenObservation(resultCode, projectionData)
        } else if (mediaProjection == null && intent?.action == null) {
            latestText = "SCREEN OCR REQUIRES USER RE-AUTHORIZATION"
            journal.record("ENGINE_STATE", prefs.getString("symbol", "XAUUSD") ?: "XAUUSD", JSONObject().put("screenObservation", "permission_reauthorization_required"))
        }
        return START_STICKY
    }

    override fun onDestroy() {
        paused = true
        prefs.edit().putBoolean("assistant_active", false).apply()
        hub?.stop()
        stopScreenObservation()
        try { textRecognizer.close() } catch (_: Exception) {}
        worker.shutdownNow()
        syncWorker.shutdownNow()
        try { panel?.let { windowManager.removeView(it) } } catch (_: Exception) {}
        try { dot?.let { windowManager.removeView(it) } } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
