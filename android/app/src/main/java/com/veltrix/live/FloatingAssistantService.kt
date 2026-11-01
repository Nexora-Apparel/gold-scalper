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

class FloatingAssistantService : Service() {
    private lateinit var windowManager: WindowManager
    private var dot: TextView? = null
    private var panel: TextView? = null
    private var dotParams: WindowManager.LayoutParams? = null
    private val worker = Executors.newSingleThreadExecutor()
    private var hub: BiquoteHubClient? = null
    private var mobileEngine: MobileScalpingEngine? = null
    @Volatile private var paused = false
    @Volatile private var feedHealthy = false
    @Volatile private var lastTickAt = 0L
    @Volatile private var latestText = "Connecting to market feed…"
    @Volatile private var currentDecisionText: String? = null
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
                if (ownerSession.hasSession() && System.currentTimeMillis() - lastSyncAt >= 10000) {
                    lastSyncAt = System.currentTimeMillis()
                    try { ownerSession.syncJournal(journal) } catch (_: Exception) { }
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
        val engine = MobileScalpingEngine(symbol) { eventType, side, payload ->
            journal.record(eventType, symbol, payload, side)
            if (eventType == "SIGNAL" || eventType == "EXIT_RECOMMENDED") {
                currentDecisionText = payload.optString("action") + " · manual MT5 only"
                latestText = currentDecisionText ?: latestText
                updateNotification(latestText)
            } else if (eventType == "NO_TRADE") {
                currentDecisionText = "NO TRADE · " + (payload.optJSONArray("reasons")?.toString() ?: "quality gate blocked")
                latestText = currentDecisionText ?: latestText
                updateNotification(latestText)
            } else if (eventType == "MISSED_OPPORTUNITY") {
                currentDecisionText = "MISSED OPPORTUNITY · signal expired"
                latestText = currentDecisionText ?: latestText
                updateNotification(latestText)
            } else if (eventType == "ENGINE_STATE" && payload.has("exnessQuoteVerification")) {
                currentDecisionText = "EXNESS QUOTE " + payload.optString("exnessQuoteVerification") + " · SIGNALS BLOCKED UNTIL VERIFIED"
                latestText = currentDecisionText ?: latestText
                updateNotification(latestText)
            }
        }
        mobileEngine = engine
        hub = BiquoteHubClient(symbol, { tick ->
            engine.onTick(tick)
            lastTickAt = System.currentTimeMillis()
            feedHealthy = tick.live
            if (tick.live && currentDecisionText?.startsWith("HOLD_UNVERIFIED") == true) currentDecisionText = null
            latestText = if (!tick.live) "Market closed or quote stale" else currentDecisionText ?: ("Bid " + tick.bid + " · Ask " + tick.ask)
            if (lastQuoteState != tick.live) {
                lastQuoteState = tick.live
                journal.record("QUOTE_STATE", symbol, JSONObject().put("live", tick.live).put("bid", tick.bid).put("ask", tick.ask))
            }
            updateNotification(if (tick.live) "Live " + symbol + " tick stream" else symbol + " quote is not live")
        }, { state ->
            feedHealthy = false
            currentDecisionText = null
            latestText = state
            val type = if (state.contains("failed", true) || state.contains("disconnected", true) || state.contains("invalid", true)) "FEED_ERROR" else "ENGINE_STATE"
            if (type == "FEED_ERROR") mobileEngine?.onFeedStale()
            journal.record(type, symbol, JSONObject().put("state", state))
            updateNotification(state)
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
        val snapshot = Mt5ScreenParser.parse(text)
        val symbol = snapshot.symbol ?: (prefs.getString("symbol", "XAUUSD") ?: "XAUUSD")
        if (snapshot.quoteDetected && snapshot.symbol == (prefs.getString("symbol", "XAUUSD") ?: "XAUUSD") && snapshot.bid != null && snapshot.ask != null) {
            val matched = mobileEngine?.verifyExnessQuote(snapshot.bid, snapshot.ask) == true
            if (matched) latestText = "EXNESS MT5 QUOTE MATCHED · SIGNAL GATE OPEN"
            else if (feedHealthy) latestText = "EXNESS QUOTE MISMATCH · NO SIGNAL"
        }
        if (snapshot.noOpenPositions) {
            if (lastPositionSignature != null) {
                val fields = lastPositionSignature!!.split("|")
                val closedSide = fields.getOrNull(1)
                val payload = JSONObject().put("source", "user_authorized_local_mt5_screen_ocr")
                    .put("closureEvidence", "explicit_no_open_positions_text")
                    .put("confidence", 0.9).put("rawScreenUploaded", false)
                journal.record("POSITION_CLOSED", symbol, payload, if (closedSide == "BUY" || closedSide == "SELL") closedSide else null)
            }
            mobileEngine?.clearPosition()
            currentDecisionText = null
            prefs.edit().putBoolean("position_active", false).apply()
            lastPositionSignature = null
            missingPositionFrames = 0
            latestText = "MT5 shows no open positions"
            return
        }
        if (snapshot.positionDetected && snapshot.side != null && snapshot.entryPrice != null) {
            val signature = listOf(symbol, snapshot.side, snapshot.entryPrice.toString(), snapshot.volumeLots?.toString() ?: "").joinToString("|")
            missingPositionFrames = 0
            prefs.edit().putBoolean("position_active", true).apply()
            mobileEngine?.setPosition(snapshot.side, snapshot.entryPrice)
            if (signature != lastPositionSignature) {
                lastPositionSignature = signature
                val payload = JSONObject()
                    .put("side", snapshot.side)
                    .put("entryPrice", snapshot.entryPrice)
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
        try { panel?.let { windowManager.removeView(it) } } catch (_: Exception) {}
        try { dot?.let { windowManager.removeView(it) } } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
