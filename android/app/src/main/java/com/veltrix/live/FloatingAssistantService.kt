package com.veltrix.live

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
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
    @Volatile private var paused = false
    @Volatile private var feedHealthy = false
    @Volatile private var lastTickAt = 0L
    @Volatile private var latestText = "Connecting to market feed…"
    private val prefs by lazy { getSharedPreferences("veltrix_live", MODE_PRIVATE) }
    private val journal by lazy { EventJournalDb(this) }
    @Volatile private var lastQuoteState: Boolean? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(7101, notification("Connecting to biquote market data"))
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        showFloatingDot()
        connectSelectedMarket()
        worker.execute {
            while (!Thread.currentThread().isInterrupted) {
                val fresh = feedHealthy && System.currentTimeMillis() - lastTickAt <= 5000
                if (feedHealthy && !fresh) latestText = "STALE FEED · NO SIGNAL"
                Handler(Looper.getMainLooper()).post {
                    (dot?.background as? android.graphics.drawable.GradientDrawable)?.setColor(if (paused) 0xFF737373.toInt() else if (fresh) 0xFFE53935.toInt() else 0xFFFFB300.toInt())
                    panel?.text = "VELTRIX LIVE\n" + prefs.getString("symbol", "XAUUSD") + "\n" + latestText + "\n" + (if (paused) "PAUSED" else if (fresh) "LIVE FEED" else "FEED ISSUE")
                }
                Thread.sleep(1000)
            }
        }
    }

    private fun connectSelectedMarket() {
        val symbol = prefs.getString("symbol", "XAUUSD") ?: "XAUUSD"
        hub = BiquoteHubClient(symbol, { tick ->
            lastTickAt = System.currentTimeMillis()
            feedHealthy = tick.live
            latestText = if (tick.live) "Bid " + tick.bid + " · Ask " + tick.ask else "Market closed or quote stale"
            if (lastQuoteState != tick.live) {
                lastQuoteState = tick.live
                journal.record("QUOTE_STATE", symbol, JSONObject().put("live", tick.live).put("bid", tick.bid).put("ask", tick.ask))
            }
            updateNotification(if (tick.live) "Live " + symbol + " tick stream" else symbol + " quote is not live")
        }, { state ->
            feedHealthy = false
            latestText = state
            val type = if (state.contains("failed", true) || state.contains("disconnected", true) || state.contains("invalid", true)) "FEED_ERROR" else "ENGINE_STATE"
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

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel("veltrix_live", "VELTRIX LIVE", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun notification(text: String): Notification {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, "veltrix_live").setContentTitle("VELTRIX LIVE").setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_info_details).setOngoing(true).build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this).setContentTitle("VELTRIX LIVE").setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_info_details).setOngoing(true).build()
        }
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(7101, notification(text))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        paused = true
        hub?.stop()
        worker.shutdownNow()
        try { panel?.let { windowManager.removeView(it) } } catch (_: Exception) {}
        try { dot?.let { windowManager.removeView(it) } } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
