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
- `android/app/src/main/java/com/veltrix/live/MobileScalpingEngine.kt`: on-device tick decision, M1/M5/M15 context, fresh MT5-screen quote comparison and dynamic exit recommendations. Broker quote parity is mandatory by default; reference-only mode must be explicitly selected by development/test callers.
- `android/app/src/main/java/com/veltrix/live/Mt5ScreenParser.kt`: local OCR extraction of MT5 bid/ask and raw price-delta spread; no pip conversion is assumed without instrument contract metadata.
- `android/app/src/main/java/com/veltrix/live/FloatingAssistantService.kt`: foreground runtime, floating overlay, user-authorized local OCR, MT5 spread monitoring and durable journal sync.
- Tests cover normalization, stream lifecycle, stale data, reordered ticks, M1/M5/M15 aggregation, microstructure metrics and REST endpoint failure handling.

## Runtime constraint

Vercel serverless functions are request-scoped and must not be used as the permanent SignalR listener. The persistent client is implemented in the Android companion foreground service. It processes ticks on-device; the monolith receives structured journal events after owner authentication. A web page that is backgrounded or suspended by Android cannot guarantee continuous tick reception.

The Android companion runtime is the persistent tick and decision client. Authenticated MT5 quote observations are relayed to the existing monolith through a short-timeout serverless route and latest-value Neon state for remote diagnostics only; the serverless route is not a real-time decision engine. Keep Vercel for snapshots, history, diagnostics and dashboard requests; do not create a new backend service or repository.

## Safety invariants

- No order execution is implemented.
- The server-side data adapter does not autonomously generate or execute orders. The Android companion's default production mode requires a fresh MT5 OCR quote corroborated against Biquote before issuing manual-review BUY/SELL recommendations. Reference-feed-only mode is reserved for explicit development/test use. Biquote remains an independent reference feed and never proves Exness executable price or fill quality.
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

Before a tick enters the Android signal calculations, the engine rejects non-finite Bid/Ask/Mid/Spread values, non-positive Bid/Mid, Ask less than or equal to Bid, negative spread, and Mid outside the observed Bid/Ask interval (with a small rounding tolerance). Rejected ticks cannot update momentum windows or generate BUY/SELL recommendations. The engine records a structured rejection reason and `quoteStreamValid=false`, deduplicates repeated validation-state events, and returns to `quoteStreamValid=true` only after a valid quote arrives. Quote validity is distinct from overall signal eligibility; all other strategy, freshness, spread, MT5 and position gates still apply. If a position is recorded, invalid reference data produces an unverified manual-check recommendation rather than a fabricated exit price.


## Broker-neutral Android MT5 quote adapter

- `lib/broker-quote-adapter.js` validates structured observations with source exactly `mt5_android`, supported symbol, expected-symbol match, finite positive Bid/Ask, Ask greater than Bid, and a bounded timestamp age (2.5 seconds; 1 second future tolerance).
- The adapter derives Mid and spread from Bid/Ask; it does not trust client-supplied derived values.
- A passing observation is labelled `BROKER_QUOTE_VERIFIED`. This means only that the local MT5 observation passed structural/freshness checks. It does not guarantee that the quote remains executable, that the order was filled, or that a broker API confirmed it.
- The adapter does not infer market-open state from an OCR price observation. Market state and quote freshness remain independent gates.
- The server market-state and decision layers now require a broker-neutral verification object from the Android MT5 source. Biquote remains a reference feed and cannot satisfy this gate.
- The current Biquote server engine does not yet submit an Android observation to the adapter. It therefore remains fail-closed and will continue to produce `NO_TRADE` until that authenticated observation transport is integrated.
- No screenshot or screen recording is uploaded by this adapter. It accepts structured quote fields only.


### Broker quote journal transport

- The Android companion now journals a structured `BROKER_QUOTE_OBSERVED` event when its local MT5 OCR parser detects an unambiguous supported-symbol Bid/Ask pair. The event contains numeric Bid/Ask, derived spread, observation timestamp, `source=mt5_android`, the local OCR method label and `rawScreenUploaded=false`.
- The event travels through the existing encrypted owner-session cookie and batched `/api/scalping-events` sync path into Neon. No new backend or repository is introduced.
- Server validation rejects unsupported sources, wrong symbols, malformed prices, invalid observation timestamps, missing local-OCR provenance labels and any event claiming raw screen upload.
- Because journal sync is batched and may occur several seconds after OCR, the journal validator validates the quote at its recorded observation time. It does **not** treat a delayed journal event as a fresh live quote.
- This is an auditable history/transport integration only. The server does not yet use these journal rows as a live decision feed. Live decision eligibility still requires a fresh broker verification object at evaluation time; Biquote remains reference-only.


## Fresh broker quote transport

The Android foreground service now sends structured MT5 OCR Bid/Ask observations to the owner-authenticated /api/broker-quote-observation endpoint, independently of the delayed journal batch. The endpoint validates the observation timestamp (2.5-second maximum age), source, instrument, Bid/Ask shape, OCR method and sequence, then atomically stores the latest value in Neon. Authenticated GET requests return a quote only while it remains fresh; missing or stale observations return HTTP 503. This is a request-scoped API backed by durable Neon state, not a persistent Vercel process or WebSocket. Accepted observations remain OCR-derived and are not proof of executable broker prices or fills. The server-side decision engine is not yet wired to consume this state.

## Historical replay

lib/scalping-historical-replay.js evaluates timestamped signals against chronological tick tapes only. BUY entry/exit use Ask/Bid; SELL entry/exit use Bid/Ask. It evaluates 5/15/30/60-second horizons, reports favourable/adverse excursion, and skips missing entry/exit quotes rather than fabricating results. It rejects OHLC input, malformed quotes, mixed providers and unordered tapes. Commission, slippage and latency beyond the recorded quote timestamps are not modelled; results are research estimates, not proof of future performance.


## Production signal eligibility

The Android production foreground service now instantiates the mobile engine with broker-quote parity required. BUY/SELL generation is blocked unless a fresh user-authorised MT5 OCR Bid/Ask observation is corroborated against the independent Biquote reference within the instrument tolerance. Missing, expired, or mismatched observations fail closed. The signal's indicative entry reference uses Ask for BUY and Bid for SELL; reference-feed-only development mode remains separate and is not enabled by the production service. This corroboration is not proof of an executable fill, so execution remains manual.

Signal events also carry the MT5 observation timestamp, quote age, executable-side entry reference (Ask for BUY, Bid for SELL) and source label. The Android notification displays that side-specific reference and still requires the user to confirm the live quote in MT5 before acting.

The Android floating indicator now distinguishes a fresh reference stream from a broker-corroborated state: red/live-ready only while the MT5 quote verification window is valid, amber while waiting for an MT5 match or while the feed is unavailable, and grey when paused. Fresh quote publication uses its own worker, separate from historical journal uploads, so a slow batch sync cannot queue the live observation behind it.

Broker quote verification is also the mobile engine's constructor default. Reference-feed-only operation must be explicitly selected by a development/test caller; production code cannot accidentally fall back to Biquote-only signal generation by omitting the broker-verification option.

The repository currently contains live Biquote streaming and derived M1/M5/M15 aggregation, but no verified historical tick archive for XAUUSD/XAGUSD. The replay engine is implemented and tested against synthetic fixtures only; it is not yet a real-market backtest. Do not publish win-rate or accuracy claims until a provenance-labelled chronological tick dataset is available and replayed out of sample.

The legacy manual Bid/Ask entry path has been removed. Production broker verification can only be established by the user-authorised local MT5 OCR observation and its fresh reference-feed corroboration; manually typed prices cannot open the signal gate.

Live quote publishing uses a dedicated OkHttp client with a 1.8-second total call timeout, separate from the slower journal/login client. Timed-out observations are not retried with stale timestamps; the next fresh OCR frame is the next attempt.

MT5 OCR observation timestamps are derived from the Android ImageReader frame timestamp (mapped to wall-clock time), rather than the later ML Kit OCR completion callback. This prevents OCR processing delay from making an old screen frame appear newer than it is. If the platform provides no frame timestamp, the callback time is used and the normal freshness checks still apply.

The Android journal records only broker-quote transport health transitions (PUBLISHED / NOT_PUBLISHED), not every network attempt, preventing repetitive failure spam while making loss of server sync auditable.

The Android engine also rejects OCR observations whose frame timestamp is not strictly newer than the currently held MT5 quote. This prevents slower OCR jobs from overwriting a newer frame when recognition callbacks complete out of order.


## Historical tick archive intake

`lib/scalping-tick-dataset.js` validates externally supplied historical tick archives before replay. Required manifest fields are `symbol` (`XAUUSD` or `XAGUSD`), `provider`, `sourceReference` and `dataKind: "tick"`. Each quote requires a timezone-explicit ISO timestamp (or integer epoch milliseconds), numeric Bid and Ask, and strictly increasing timestamps. OHLC candles, numeric strings, mixed symbols, duplicate/out-of-order timestamps, invalid spreads and missing provenance are rejected. The validator reports tick count, date coverage, median and 95th-percentile inter-tick interval, and maximum observed gap. It never sorts, interpolates or fabricates missing ticks.

Example input shape:

```json
{
  "metadata": {
    "symbol": "XAUUSD",
    "provider": "DATA_PROVIDER_NAME",
    "sourceReference": "export-id-or-source-url",
    "dataKind": "tick"
  },
  "quotes": [
    {"symbol": "XAUUSD", "timestamp": "2026-10-01T10:00:00.000Z", "bid": 2650.10, "ask": 2650.20},
    {"symbol": "XAUUSD", "timestamp": "2026-10-01T10:00:00.250Z", "bid": 2650.15, "ask": 2650.25}
  ]
}
```

This is an intake validator only. No historical dataset is bundled or claimed to exist; replay results remain unavailable until a genuine provider archive is supplied and validated.

The intake library also accepts standard comma-separated CSV exports through `importHistoricalTickCsv`. Required headers are `timestamp,bid,ask`; an optional `symbol` column is supported. Decimal prices must use plain dot-decimal notation. CSV rows pass through the same strict chronology, timestamp, Bid/Ask and provenance checks as JSON archives.


## Fresh quote transport boundary

`api/broker-quote-observation.js` accepts authenticated, schema-validated MT5 OCR observations and stores only the latest value per supported symbol in Neon. Its GET response is for remote diagnostics and dashboard visibility. It is not consumed by the on-device signal calculation, and the delayed journal batch is never treated as a fresh quote. Android performs signal eligibility locally against the fresh OCR quote and independent reference tick. No Vercel serverless function is treated as a persistent tick process.


## Browser tick archive registry and replay console

- `tick-archive.html` and `tick-archive.js` provide a mobile-friendly CSV/JSON archive intake page linked from the dashboard.
- The browser validator enforces symbol, provider/source provenance, timezone-explicit chronology, Bid/Ask integrity and a 250,000-tick / 25 MB intake ceiling. It creates a SHA-256 content identifier and a fixed chronological 60/20/20 train/validation/held-out-test split.
- Raw ticks remain in the user's browser IndexedDB. They are not uploaded to Neon or Vercel. Users can export a local archive backup. Browser storage can be cleared by the operating system or browser; this is not a cloud backup.
- `historical-replay.html` and `historical-replay.js` load the selected local archive and replay genuine timestamped BUY/SELL signal logs over 5, 15, 30 and 60 seconds. Signal logs may be imported as JSON/CSV or loaded from the authenticated journal.
- Journal export is date-bounded and limited to 1,000 rows. The replay console accepts only recorded SIGNAL events with `provider=biquote`, `signalQuoteSource=mt5_screen_ocr` and `mt5ReferenceQuoteVerification=MATCHED`. Reference-only and unverified signal events are excluded. Biquote-generated journal signals are blocked from replay against an archive whose provider label does not identify Biquote.
- Each partition is replayed independently. Entry and exit quotes cannot cross partition boundaries. Signal source and archive identifiers are included in the exported report; the imported signal file receives its own SHA-256 digest.
- MFE/MAE include the entry-side spread impact. The replay uses BUY Ask-entry/Bid-exit and SELL Bid-entry/Ask-exit. It still does not model commissions, unobserved slippage, network/execution latency, partial fills or exact Exness fills.
- The UI and CI wiring are implemented, but browser/device verification and a genuine historical archive import remain outstanding. Synthetic unit tests are not a substitute for a real out-of-sample market replay.

- Replay supports an optional user-supplied additional round-trip cost in quote price units, explicitly **excluding** the Bid/Ask spread already embedded in entry/exit. If omitted, gross outcomes remain available but net outcomes are null/unavailable. Do not enter a commission amount in account currency directly; converting it requires verified contract size, volume and currency conversion for the exact instrument/account.

- Hit-rate reporting includes Wilson 95% confidence intervals, with flat outcomes excluded from the decisive win/loss denominator. Confidence intervals are wide for small samples by design; the evaluated and decisive counts must be considered alongside the percentage.

- Imported signal logs must carry provider provenance (JSON `metadata.provider`; CSV `provider` column). The replay console rejects missing or inconsistent provider labels and blocks signal/tick archive provider mismatches.
