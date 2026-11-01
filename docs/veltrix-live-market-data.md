# VELTRIX LIVE market-data foundation

## Provider boundary

The provisional quote provider is biquote. It is an external reference feed and is **not** an Exness executable quote stream. The adapter stamps every quote with `provider: "biquote"` and `executableForExness: false`. Do not use its price as proof of the MT5 fill price.

Supported instruments in this layer: `XAUUSD` and `XAGUSD` only.

## Data paths

- REST bootstrap/recovery: `GET https://biquote.io/api/latest?symbols={selectedSymbol}`
- Persistent SignalR hub: `https://biquote.io/hubs/tick`
- Server tick event: `ReceiveTick`
- Subscription method: `Subscribe([selectedSymbol])`
- Unsubscribe method: `Unsubscribe([selectedSymbol])`

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
- `android/app/src/main/java/com/veltrix/live/MobileScalpingEngine.kt`: on-device tick decision, M1/M5/M15 context, Exness quote-parity gate and dynamic exit recommendations.
- `android/app/src/main/java/com/veltrix/live/FloatingAssistantService.kt`: foreground runtime, draggable overlay, high-priority exit notifications, user-authorized local OCR and durable journal sync.
- `android/app/src/main/java/com/veltrix/live/Mt5ScreenParser.kt`: conservative local OCR parsing for MT5 instrument, bid/ask, position side, entry and volume.
- `android/app/src/main/java/com/veltrix/live/PositionClosureConfirmation.kt`: requires three consecutive explicit no-open-positions frames before marking an MT5 position closed.
- `android/app/src/main/java/com/veltrix/live/EventJournalDb.kt`: durable SQLite outbox; unsynced events survive app restarts and retry after connectivity returns.
- Tests cover normalization, stream lifecycle, stale data, reordered ticks, M1/M5/M15 aggregation, microstructure metrics and REST endpoint failure handling.

## Runtime constraint

Vercel serverless functions are request-scoped and must not be used as the permanent SignalR listener. The persistent client is implemented in the Android companion foreground service. It processes ticks on-device; the monolith receives structured journal events after owner authentication. A web page that is backgrounded or suspended by Android cannot guarantee continuous tick reception.

The Android companion runtime is implemented in this branch. It holds the SignalR connection in a foreground service, subscribes to one selected metal, evaluates ticks locally, and syncs structured journal events to the existing monolith after owner authentication. The web API remains for snapshots, history, diagnostics and dashboard requests; no second backend service is required.

## Safety invariants

- No order execution is implemented.
- The server-side data adapter does not autonomously generate or execute orders. The Android companion can issue manual-review recommendations only after its additional market-quality and Exness quote-parity gates pass.
- Quotes older than five seconds, future-dated quotes, provider-stale quotes, closed-market quotes and malformed quotes are rejected.
- A stream disconnect or stale watchdog state must invalidate live decisions.
- Interrupted M1 candles remain marked partial and must not be passed to closed-candle strategy logic.
- Record provider/source and timestamps with every future signal and trade record.
- Do not equate external biquote spread with Exness spread or slippage.

## Validation

Run `npm run check` on Node.js 20 or later. CI runs Node engine tests and Android Gradle build/unit tests on the validation branch. A successful CI run proves compilation and unit tests only; it does not prove provider availability or live Exness price parity.


## Single-market selection

The Android companion stores one selected instrument (`XAUUSD` or `XAGUSD`, default `XAUUSD`) and subscribes to that symbol only. The user changes the selection in the companion before a session; changing markets is blocked while a position is recorded as open. The selector does not change Exness MT5's chart automatically and does not enable broker execution. The Android companion stores the selected instrument locally and subscribes only to that symbol. The web dashboard setting is separate; changing the Android selector does not automatically change the MT5 chart, so the OCR parser checks the selected symbol before trusting screen context.
