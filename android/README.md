# VELTRIX LIVE Android Companion

## Build
Requirements: JDK 17, Android SDK Platform 35, Gradle 8.9.

From the repository root:

```sh
gradle -p android assembleDebug testDebugUnitTest
```

The debug APK is generated at:

`android/app/build/outputs/apk/debug/app-debug.apk`

The GitHub Actions validation workflow uploads this APK as the artifact named `veltrix-live-android-debug` after a successful build.

## First-run flow
1. Install the debug APK on Android 8.0 or later.
2. Enter the existing dashboard owner password to establish an encrypted session for journal upload.
3. Select one instrument: XAUUSD or XAGUSD.
4. Grant Android's overlay permission.
5. Approve Android's MediaProjection screen-capture prompt. Screen frames are processed locally with ML Kit; full-screen images are not uploaded.
6. Start the floating assistant and open Exness MT5.
7. Keep the Exness MT5 chart or Market Watch visible with the selected symbol and labelled Bid/Ask values. Local OCR attempts to match both sides and spread against the fresh provider quote. If the MT5 layout does not expose labelled Bid/Ask text, enter the current values in the manual verification fields. Signals remain blocked until a match is confirmed; verification expires after ten seconds without a fresh matching quote and is revoked on feed loss.
8. Keep only one selected market and do not switch instruments while an MT5 position is detected.
9. Any BUY/SELL/CLOSE recommendation is manual-review-only. The app never sends broker orders.

## Floating indicator
- Pulsing red: fresh stream and analysis active.
- Yellow: feed stale, disconnected or unavailable.
- Grey: decision engine paused.
- Tap the dot to open/close the panel. Tap the panel to pause/resume decisions.

## Data handling
- SQLite stores structured events locally until the authenticated dashboard session can upload them.
- OCR runs on-device. The app sends parsed position fields and event metadata, never the screen image.
- The owner session cookie is stored using Android EncryptedSharedPreferences.
- If Android restarts the service and invalidates MediaProjection, screen observation requires fresh user consent.

## Known constraints
- biquote is a provisional external feed, not verified as the user's exact Exness execution feed. Manual spot verification is required and does not prove continuous feed parity.
- OCR parsing must be physically validated against the installed Exness MT5 layout. Quote matching depends on visible, labelled Bid/Ask text or the manual verification fallback. The current parser tracks one detected position; multiple simultaneous positions are not yet supported.
- Signal logic is experimental and intentionally fail-closed. It requires at least 15 completed contiguous M1 bars for M15 context plus completed M1 structure; early runtime may show NO_TRADE.
- No 90% accuracy or profitability is claimed. Run at least two months on demo and record every closed trade's net realized R after fees and slippage before considering live reliance.
- A human must physically test overlay, MediaProjection, OCR accuracy, Exness quote matching, background behavior and reconnection on the target Android device.
