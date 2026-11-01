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
- Tests cover normalization, stream lifecycle, stale data, reordered ticks, M1/M5/M15 aggregation, microstructure metrics and REST endpoint failure handling.

## Runtime constraint

Vercel serverless functions are request-scoped and must not be used as the permanent SignalR listener. The persistent client belongs in the Android companion foreground service (preferred for reliable background operation) or in an explicitly running client while the dashboard is open. A web page that is backgrounded or suspended by Android cannot guarantee continuous tick reception.

The next integration stage is the Android companion runtime and its authenticated, compact quote/candle transport to the existing monolith. Keep the Vercel API for snapshots, history, diagnostics and dashboard requests; do not create a new backend service or repository.

## Safety invariants

- No order execution is implemented.
- No trading signal generation is enabled by this data foundation.
- Quotes older than five seconds, future-dated quotes, provider-stale quotes, closed-market quotes and malformed quotes are rejected.
- A stream disconnect or stale watchdog state must invalidate live decisions.
- Interrupted M1 candles remain marked partial and must not be passed to closed-candle strategy logic.
- Record provider/source and timestamps with every future signal and trade record.
- Do not equate external biquote spread with Exness spread or slippage.

## Validation

Run `npm run check` on Node.js 20 or later. CI is configured to run the check workflow on `veltrix-live-rebuild`. Tests have been authored but must not be considered passed until a runner reports success.


## Single-market selection

The saved dashboard preference `scalpInstrument` is either `XAUUSD` or `XAGUSD` (default `XAUUSD`). The live engine accepts this value as `selectedSymbol`, requests a REST bootstrap snapshot for that symbol only, and subscribes to that symbol only. This is an intentional one-market-at-a-time operating mode: the user switches instruments from Strategy settings before starting a session. The selector does not change Exness MT5's chart automatically and does not enable broker execution. The app must pass the saved `settings.scalpInstrument` into the persistent Android/live-engine runtime when that runtime is integrated.
