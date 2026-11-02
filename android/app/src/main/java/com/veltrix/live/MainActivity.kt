package com.veltrix.live

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.media.projection.MediaProjectionManager
import android.view.Gravity
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import java.util.concurrent.Executors
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView

class MainActivity : Activity() {
    private val prefs by lazy { getSharedPreferences("veltrix_live", MODE_PRIVATE) }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (prefs.getBoolean("position_active", false)) {
            val locked = prefs.getString("active_market_lock", null)
            if (locked == "XAUUSD" || locked == "XAGUSD") prefs.edit().putString("symbol", locked).apply()
        }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(28, 40, 28, 24); setBackgroundColor(0xFF08090D.toInt()) }
        root.addView(TextView(this).apply { text = "VELTRIX LIVE"; textSize = 24f; setTextColor(0xFFF2C85B.toInt()); gravity = Gravity.CENTER })
        root.addView(TextView(this).apply { text = "GOLD & SILVER · MT5 SCREEN COMPANION · MANUAL TRADING ONLY"; textSize = 14f; setTextColor(0xFFE5E7EB.toInt()); gravity = Gravity.CENTER; setPadding(0, 18, 0, 24) })
        val selector = Spinner(this)
        selector.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, listOf("XAUUSD · Gold", "XAGUSD · Silver"))
        selector.setSelection(if (prefs.getString("symbol", "XAUUSD") == "XAGUSD") 1 else 0)
        selector.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                val nextSymbol = if (position == 1) "XAGUSD" else "XAUUSD"
                val currentSymbol = prefs.getString("symbol", "XAUUSD") ?: "XAUUSD"
                if (currentSymbol == nextSymbol) return
                if (prefs.getBoolean("position_active", false)) {
                    parent?.setSelection(if (currentSymbol == "XAGUSD") 1 else 0)
                    Toast.makeText(this@MainActivity, "Close the detected MT5 position before switching markets.", Toast.LENGTH_LONG).show()
                } else {
                    prefs.edit().putString("symbol", nextSymbol).apply()
                    if (prefs.getBoolean("assistant_active", false)) {
                        startService(Intent(this@MainActivity, FloatingAssistantService::class.java).setAction("CHANGE_SYMBOL"))
                    }
                }
            }
        }
        root.addView(selector, LinearLayout.LayoutParams(-1, -2))
        val passwordInput = EditText(this).apply {
            hint = "VELTRIX dashboard password (not Exness password)"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            setSingleLine(true)
        }
        root.addView(passwordInput, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 16 })
        root.addView(Button(this).apply {
            text = "STEP 1 · CONNECT VELTRIX DASHBOARD"
            setOnClickListener {
                val password = passwordInput.text.toString()
                if (password.isBlank()) {
                    Toast.makeText(this@MainActivity, "Enter the dashboard password.", Toast.LENGTH_SHORT).show()
                } else {
                    Executors.newSingleThreadExecutor().execute {
                        val connected = try { OwnerSessionStore(this@MainActivity).login(password) } catch (_: Exception) { false }
                        runOnUiThread {
                            passwordInput.text.clear()
                            Toast.makeText(this@MainActivity, if (connected) "Dashboard session connected." else "Login failed. Check password and server configuration.", Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }
        }, LinearLayout.LayoutParams(-1, -2))
        root.addView(TextView(this).apply {
            text = "CONNECTION GUIDE\n1. Enter your VELTRIX dashboard password above. This is not your Exness password.\n2. Tap START DOT and approve Android screen capture.\n3. Switch to Exness MT5 and open the selected symbol with Bid and Ask visible.\n4. The floating dot turns GREEN only after the app reads a valid MT5 quote. RED means not verified. Tap the dot for its status panel.\n5. Keep MT5 visible. Screen text is processed on this phone; screenshots are not uploaded."
            setTextColor(0xFFE5E7EB.toInt())
            setPadding(0, 18, 0, 4)
        })
        root.addView(TextView(this).apply { text = "MT5 trade journal"; setTextColor(0xFFE5E7EB.toInt()); setPadding(0, 18, 0, 4) })
        val journalSide = Spinner(this).apply { adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, listOf("BUY", "SELL")) }
        val journalEntry = EditText(this).apply { hint = "MT5 entry price"; inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL }
        val journalVolume = EditText(this).apply { hint = "Volume in lots (optional)"; inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL }
        root.addView(journalSide, LinearLayout.LayoutParams(-1, -2))
        root.addView(journalEntry, LinearLayout.LayoutParams(-1, -2))
        root.addView(journalVolume, LinearLayout.LayoutParams(-1, -2))
        root.addView(Button(this).apply {
            text = "RECORD MT5 POSITION OPEN"
            setOnClickListener {
                val entry = journalEntry.text.toString().toDoubleOrNull()
                val volume = journalVolume.text.toString().toDoubleOrNull() ?: 0.0
                if (entry == null || entry <= 0 || !prefs.getBoolean("assistant_active", false)) {
                    Toast.makeText(this@MainActivity, "Start the assistant and enter a valid entry price.", Toast.LENGTH_LONG).show()
                } else startService(Intent(this@MainActivity, FloatingAssistantService::class.java)
                    .setAction("JOURNAL_POSITION_OPEN").putExtra("position_side", journalSide.selectedItem.toString())
                    .putExtra("entry_price", entry).putExtra("volume_lots", volume))
            }
        }, LinearLayout.LayoutParams(-1, -2))
        val journalExit = EditText(this).apply { hint = "MT5 exit price (optional)"; inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL }
        val journalR = EditText(this).apply { hint = "Realized R multiple (e.g. 1.5 or -1)"; inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL or android.text.InputType.TYPE_NUMBER_FLAG_SIGNED }
        root.addView(journalExit, LinearLayout.LayoutParams(-1, -2))
        root.addView(journalR, LinearLayout.LayoutParams(-1, -2))
        root.addView(Button(this).apply {
            text = "RECORD MT5 POSITION CLOSE"
            setOnClickListener {
                if (!prefs.getBoolean("assistant_active", false)) Toast.makeText(this@MainActivity, "Start the assistant first.", Toast.LENGTH_SHORT).show()
                else startService(Intent(this@MainActivity, FloatingAssistantService::class.java).setAction("JOURNAL_POSITION_CLOSE")
                    .putExtra("exit_price", journalExit.text.toString().toDoubleOrNull() ?: 0.0)
                    .putExtra("realized_r", journalR.text.toString().toDoubleOrNull() ?: Double.NaN))
            }
        }, LinearLayout.LayoutParams(-1, -2))
        root.addView(Button(this).apply {
            text = "EMERGENCY STOP · DISABLE NEW SIGNALS"
            setTextColor(0xFFFFFFFF.toInt())
            setBackgroundColor(0xFF9F2438.toInt())
            setOnClickListener {
                prefs.edit().putBoolean("emergency_stop", true).apply()
                if (prefs.getBoolean("assistant_active", false)) {
                    startService(Intent(this@MainActivity, FloatingAssistantService::class.java).setAction("EMERGENCY_STOP"))
                }
                Toast.makeText(this@MainActivity, "Emergency stop latched. New signals disabled; existing MT5 positions are not closed and must still be monitored manually.", Toast.LENGTH_LONG).show()
            }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 16 })
        root.addView(Button(this).apply {
            text = "RESUME SIGNAL GENERATION"
            setOnClickListener {
                if (prefs.getBoolean("position_active", false)) {
                    Toast.makeText(this@MainActivity, "Resume blocked while an MT5 position is active.", Toast.LENGTH_LONG).show()
                } else {
                    prefs.edit().putBoolean("emergency_stop", false).apply()
                    if (prefs.getBoolean("assistant_active", false)) {
                        startService(Intent(this@MainActivity, FloatingAssistantService::class.java).setAction("RESUME_SIGNALS"))
                    }
                    Toast.makeText(this@MainActivity, "Emergency stop cleared. Start the assistant to resume monitoring.", Toast.LENGTH_LONG).show()
                }
            }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8 })
        root.addView(Button(this).apply {
            text = "STEP 2 · START DOT & ALLOW SCREEN READING"
            setOnClickListener { if (!Settings.canDrawOverlays(this@MainActivity)) startActivityForResult(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + packageName)), 401) else startAssistant() }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 20 })
        root.addView(Button(this).apply {
            text = "STOP SCREEN READING"
            setOnClickListener {
                if (prefs.getBoolean("position_active", false)) {
                    Toast.makeText(this@MainActivity, "Close or manually confirm the MT5 position before stopping monitoring.", Toast.LENGTH_LONG).show()
                } else {
                    stopService(Intent(this@MainActivity, FloatingAssistantService::class.java))
                }
            }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 10 })
        root.addView(TextView(this).apply {
            text = "LIVE STATUS KEY\nRED DOT · Screen reading not verified / no fresh MT5 quote.\nGREEN DOT · A valid quote was read from the selected MT5 symbol. It does not mean a trade is approved.\nDashboard connection is required for cloud quote telemetry and journal sync. The assistant never places, modifies, or closes orders."
            textSize = 12f; setTextColor(0xFF9CA3AF.toInt()); setPadding(0, 24, 0, 0)
        })
        setContentView(android.widget.ScrollView(this).apply { addView(root) })
    }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 401 && Settings.canDrawOverlays(this)) startAssistant()
        if (requestCode == 402) {
            if (resultCode == RESULT_OK && data != null) {
                val service = Intent(this, FloatingAssistantService::class.java)
                    .putExtra("projection_result_code", resultCode)
                    .putExtra("projection_data", data)
                startForegroundService(service)
            } else {
                startForegroundService(Intent(this, FloatingAssistantService::class.java))
                Toast.makeText(this, "Screen reading disabled. Manual Exness quote checks remain available.", Toast.LENGTH_LONG).show()
            }
        }
    }
    private fun startAssistant() {
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(manager.createScreenCaptureIntent(), 402)
    }
}
