package com.veltrix.live

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
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
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(28, 40, 28, 24); setBackgroundColor(0xFF08090D.toInt()) }
        root.addView(TextView(this).apply { text = "VELTRIX LIVE"; textSize = 24f; setTextColor(0xFFF2C85B.toInt()); gravity = Gravity.CENTER })
        root.addView(TextView(this).apply { text = "Tick-stream companion · Manual Exness MT5 execution only"; textSize = 14f; setTextColor(0xFFE5E7EB.toInt()); gravity = Gravity.CENTER; setPadding(0, 18, 0, 24) })
        val selector = Spinner(this)
        selector.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, listOf("XAUUSD · Gold", "XAGUSD · Silver"))
        selector.setSelection(if (prefs.getString("symbol", "XAUUSD") == "XAGUSD") 1 else 0)
        selector.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: android.view.View?, position: Int, id: Long) { prefs.edit().putString("symbol", if (position == 1) "XAGUSD" else "XAUUSD").apply() }
        }
        root.addView(selector, LinearLayout.LayoutParams(-1, -2))
        val passwordInput = EditText(this).apply {
            hint = "Dashboard password"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            setSingleLine(true)
        }
        root.addView(passwordInput, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 16 })
        root.addView(Button(this).apply {
            text = "CONNECT SECURE DASHBOARD SESSION"
            setOnClickListener {
                val password = passwordInput.text.toString()
                if (password.isBlank()) {
                    Toast.makeText(this@MainActivity, "Enter the dashboard password.", Toast.LENGTH_SHORT).show()
                } else {
                    isEnabled = false
                    Executors.newSingleThreadExecutor().execute {
                        val connected = try { OwnerSessionStore(this@MainActivity).login(password) } catch (_: Exception) { false }
                        runOnUiThread {
                            isEnabled = true
                            passwordInput.text.clear()
                            Toast.makeText(this@MainActivity, if (connected) "Dashboard session connected." else "Login failed. Check password and server configuration.", Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }
        }, LinearLayout.LayoutParams(-1, -2))
        root.addView(Button(this).apply {
            text = "ENABLE FLOATING ASSISTANT"
            setOnClickListener { if (!Settings.canDrawOverlays(this@MainActivity)) startActivityForResult(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + packageName)), 401) else startAssistant() }
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 20 })
        root.addView(Button(this).apply { text = "PAUSE / STOP ASSISTANT"; setOnClickListener { stopService(Intent(this@MainActivity, FloatingAssistantService::class.java)) } }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 10 })
        root.addView(TextView(this).apply {
            text = "The floating indicator displays connection and feed health. It does not place, modify, or close MT5 orders. Provider prices are indicative and must be checked against Exness MT5 before any manual action."
            textSize = 12f; setTextColor(0xFF9CA3AF.toInt()); setPadding(0, 24, 0, 0)
        })
        setContentView(root)
    }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 401 && Settings.canDrawOverlays(this)) startAssistant()
    }
    private fun startAssistant() { startForegroundService(Intent(this, FloatingAssistantService::class.java)) }
}
