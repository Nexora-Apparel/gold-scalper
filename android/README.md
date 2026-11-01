# VELTRIX LIVE Android companion

## Purpose

VELTRIX LIVE is a manual-execution scalping copilot for XAUUSD and XAGUSD. It does not connect to an Exness trading account, submit orders, modify orders, or close orders. All recommendations require the user to act and confirm in Exness MT5.

## Runtime

- Android application ID: `com.veltrix.live`
- Minimum Android: 8.0 (API 26); developed for the user's Android 11 device.
- One selected instrument at a time: XAUUSD or XAGUSD.
- Persistent market stream: biquote SignalR, running in a foreground service.
- On-device tick engine: short-window momentum, rolling M1/M5/M15 context, spread and volatility gates.
- Exness parity: new signals are blocked until the current biquote bid/ask matches the bid/ask read locally from MT5. Parity expires quickly and must be refreshed.
- MT5 screen reading: user-authorized Android MediaProjection plus on-device ML Kit OCR. Captured frames are not uploaded.
- Journal: local SQLite outbox, synced to the existing Vercel monolith after owner login.

## Build

Requirements: JDK 17, Android SDK Platform 35, Gradle 8.9.

From the repository root:

```sh
gradle -p android assembleDebug testDebugUnitTest
```

The debug APK is generated at `android/app/build/outputs/apk/debug/app-debug.apk`. GitHub Actions builds and unit-tests the APK and uploads it as the `veltrix-live-android-debug` workflow artifact.

## First-run setup

1. Install the debug APK and open VELTRIX LIVE.
2. Select one market. The selected instrument is locked while a position is tracked.
3. Connect the dashboard owner session using the existing dashboard password. This enables journal sync; local journaling works without it.
4. Grant Android's “Display over other apps” permission for the floating dot.
5. Start the assistant and approve Android's screen-capture prompt. Frames are processed locally.
6. Open Exness MT5 and select the same symbol as the companion.
7. Keep the MT5 bid/ask visible long enough for OCR to verify parity. Signals remain blocked if the prices do not match.
8. Optional: allow unrestricted background running in Android battery settings. This can increase battery consumption.
9. Use the companion only alongside an Exness demo account during validation.

## Operating rules

- Red dot: feed active; pulsing indicates analysis. Amber: feed or verification issue. Grey: paused.
- BUY NOW / SELL NOW are manual-review recommendations, not orders.
- CLOSE NOW is a high-priority manual MT5 alert. The assistant never closes the trade itself.
- A stale or mismatched feed blocks new entries and produces an unverified-position warning.
- A position is not marked closed merely because OCR fails to see it. The parser requires three consecutive explicit “no open positions” frames.
- Signals, no-trade states, missed opportunities, positions, exit recommendations, unconfirmed exits, feed issues and manually entered outcomes are journaled locally.
- Manual position open/close controls are available if MT5 OCR cannot confidently read a trade.
- Do not switch instruments while a position is open. The companion enforces this lock.
- Stop the assistant only when you are ready to stop live monitoring. If a position remains tracked, shutdown raises a critical warning to check MT5 manually.

## Validation boundary

CI compilation and unit tests do not establish live feed availability, broker quote parity, OCR reliability on every MT5 layout, trading profitability or accuracy. Run the full two-month demo validation before relying on recommendations. Track net R after spread/commission/slippage, win rate, false positives, missed exits, latency, feed uptime and drawdown. No target accuracy is guaranteed.
