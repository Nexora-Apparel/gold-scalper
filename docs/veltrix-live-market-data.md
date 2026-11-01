# VELTRIX LIVE market-data foundation

## Provider boundary

The provisional quote provider is biquote. It is an external reference feed and is **not** an Exness executable quote stream. The adapter stamps every quote with `provider: "biquote"` and `executableForExness: false`. Do not use its price as proof of the MT5 fill price.

Supported instruments in this layer: `XAUUSD` and `XAGUSD` only.

## Data paths

- REST bootstrap/recovery: `GET https://biquote.io/api/latest?symbols=XAUUSD&symbols=XAGUSD`
- Persistent SignalR hub: `https://biquote.io/hubs/tick`
- Server tick event: `ReceiveTick`
- Subscription method: `Subscribe(["XAUUSD", "XAGUSD"])`
- Unsubscribe method: `Unsubscribe(["XAUUSD", "XAGUSD"])`

REST is best-effort bootstrap only. It does not build M1 candles and is not a substitute for streaming.

## Implemented modules

- `lib/biquote-market-data.js`: quote normalization, 5-second freshness validation, REST snapshot fetch.
- `lib/biquote-signalr-connection.js`: HTTPS SignalR connection factory with automatic reconnect backoff.
- `lib/biquote-tick-stream.js`: subscription lifecycle, re-subscription, tick validation, watchdog and stale-feed state.
- `lib/tick-candle-aggregator.js`: event-driven M1 OHLC aggregation from actual ticks; no synthetic bars for empty minutes.
- `lib/microstructure-window.js`: rolling 5-second and 15-second price-velocity and spread statistics.
- `lib/higher-timeframe-aggregator.js`: gap-aware M5/M15 context bars built only from contiguous completed M1 candles.
- `lib/biquote-live-engine.js`: composes REST bootstrap, streaming and M1 aggregation.
- `api/biquote-quotes.js`: no-cache REST snapshot endpoint; returns 503 when fresh data cannot be verified.
- `android/app/src/main/java/com/veltrix/live/BiquoteHubClient.kt`: persistent Android SignalR client, strict symbol/freshness checks, confirmed subscription and reconnect backoff.
- `android/app/src/main/java/com/veltrix/live/MobileScalpingEngine.kt`: on-device tick decision, M1/M5/M15 context, fresh MT5-screen spread override and dynamic exit recommendations. Broker quote parity is an optional future gate and is disabled in the current reference-feed development mode.
- `android/app/src/main/java/com/veltrix/live/Mt5ScreenParser.kt`: local OCR extraction of MT5 bid/ask and raw price-delta spread; no pip conversion is assumed without instrument contract metadata.
- `android/app/src/main/java/com/veltrix/live/FloatingAssistantService.kt`: foreground runtime, floating overlay, user-authorized local OCR, MT5 spread monitoring and durable journal sync.
- Tests cover normalization, stream lifecycle, stale data, reordered ticks, M1/M5/M15 aggregation, microstructure metrics and REST endpoint failure handling.

## Runtime constraint

Vercel serverless functions are request-scoped and must not be used as the permanent SignalR listener. The persistent client is implemented in the Android companion foreground service. It processes ticks on-device; the monolith receives structured journal events after owner authentication. A web page that is backgrounded or suspended by Android cannot guarantee continuous tick reception.

The next integration stage is the Android companion runtime and its authenticated, compact quote/candle transport to the existing monolith. Keep the Vercel API for snapshots, history, diagnostics and dashboard requests; do not create a new backend service or repository.

## Safety invariants

- No order execution is implemented.
- The server-side data adapter does not autonomously generate or execute orders. The Android companion can issue manual-review recommendations in reference-feed development mode after market-quality gates pass. A fresh MT5 OCR spread, when available, is used as the spread input; otherwise the Biquote spread is explicitly labelled reference-only. Broker quote parity is reserved for a future broker-integration mode.
- Quotes older than five seconds, future-dated quotes, provider-stale quotes, closed-market quotes and malformed quotes are rejected.
- A stream disconnect or stale watchdog state must invalidate live decisions.
- Interrupted M1 candles remain marked partial and must not be passed to closed-candle strategy logic.
- Record provider/source and timestamps with every future signal and trade record.
- Do not equate external biquote spread with Exness spread or slippage.

## Validation

Run `npm run check` on Node.js 20 or later. CI runs Node engine tests and Android Gradle build/unit tests on the validation branch. A successful CI run proves compilation and unit tests only; it does not prove provider availability or live Exness price parity.


## Single-market selection

The Android companion stores one selected instrument (`XAUUSD` or `XAGUSD`, default `XAUUSD`) and subscribes to that symbol only. The user changes the selection in the companion before a session; changing markets is blocked while a position is recorded as open. The selector does not change Exness MT5's chart automatically and does not enable broker execution. The app must pass the saved `settings.scalpInstrument` into the persistent Android/live-engine runtime when that runtime is integrated.

## MT5 spread observation

When the user authorizes Android screen capture, the foreground companion locally OCRs the visible screen. It accepts bid/ask only when the parsed content also contains MT5 context, matches the currently selected instrument, and has `ask > bid`. The raw spread is `ask - bid` in the instrument's quoted price units. The observation expires after 2.5 seconds; after expiry the decision engine falls back to the Biquote reference spread and records the source. The companion journals spread observations at a throttled interval and never uploads screen images. Pip conversion is intentionally deferred until the instrument's digits/point specification is known.

## MT5 quote agreement gate

When a fresh MT5 screen OCR quote is available, the Android engine compares both Bid and Ask, plus spread, against the latest Biquote reference tick. Current provisional tolerances are 0.05 quoted price units for XAUUSD and 0.01 for XAGUSD; these are engineering thresholds, not broker specifications, and must be calibrated against real device observations. A fresh observed mismatch blocks new BUY/SELL signals and is surfaced in the companion status. A match is recorded as corroboration, not proof of executable-price parity or a fill. When no fresh MT5 quote is visible, the engine remains in clearly labelled reference-feed mode; this does not imply MT5 verification. All comparison events store numeric quotes and source metadata, never screen images.

## Android quote integrity gate

Before a tick enters the Android signal calculations, the engine rejects non-finite Bid/Ask/Mid/Spread values, non-positive Bid/Mid, Ask less than or equal to Bid, negative spread, and Mid outside the observed Bid/Ask interval (with a small rounding tolerance). Rejected ticks cannot update momentum windows or generate BUY/SELL recommendations. The engine records a structured rejection reason, deduplicates repeated validation-state events, and returns to an accepted state only after a valid quote arrives. If a position is recorded, invalid reference data produces an unverified manual-check recommendation rather than a fabricated exit price.
