# VELTRIX LIVE — Tick Scalping Foundation

## Runtime boundary
The Next.js monolith remains the control plane and persistent application. Vercel serverless functions provide authenticated APIs and database access; they are not used as permanent SignalR listeners. A persistent Android foreground service is the intended always-on stream host. A dashboard-open browser session can be used for development/diagnostics only.

## Data provenance
- biquote REST snapshots are display/bootstrap data and do not create candles.
- SignalR ticks are normalized before entering microstructure windows or candle aggregation.
- biquote quotes are not verified Exness executable prices. The MT5 terminal quote remains the execution reference.
- CFD tick volume is not available from the provider. Directional tick imbalance is a price-tick proxy, not exchange order flow, depth, or broker volume.

## Decision path
1. Normalize and freshness-check the selected instrument's bid/ask/mid.
2. Maintain 5-second and 15-second rolling quote windows.
3. Compute movement, tick rate, spread statistics and directional tick imbalance.
4. Evaluate market readiness, spread anomalies and volatility regime.
5. Build M1 OHLC from actual ticks; do not synthesize empty minutes.
6. Confirm short-term swing/breakout structure from completed M1 candles only.
7. Evaluate a conservative BUY/SELL candidate only when all gates agree.
8. Keep execution disabled; the user confirms any trade manually in Exness MT5.

A missing/stale quote, closed market, insufficient microstructure, unconfirmed structure, volatility spike or conflicting direction must resolve to NO_TRADE.

## Event journal
The authenticated scalping-events API accepts 1–100 events per POST and supports GET with optional symbol and limit. eventId is unique and database-enforced for idempotency. Event payloads are capped at 12 KB. Events include market state, decisions, signal/rejection lifecycle, missed opportunities, position lifecycle, exit recommendations, feed failures and emergency-stop state.

The journal client maintains a bounded in-memory queue, batches writes, and retains events after failed requests. Android production storage must use a durable local queue (Room/SQLite) before network upload; an in-memory browser queue is not a substitute for durable device storage.

## Known integration limits
- Event schema/API and JS client are implemented, but live Android events are not yet wired to durable Android storage.
- Decision engine is deterministic and experimental. Directional tick pressure is a proxy and requires calibration against recorded bid/ask ticks.
- Android local OCR, position lifecycle events and dynamic emergency exit recommendations are implemented in the draft; OCR accuracy and exit behavior still require physical MT5 device validation.
- No Exness API or order execution bridge is enabled. The Android decision engine blocks signals until the user manually compares current Exness MT5 bid/ask with the provider quote; a successful match is valid for five minutes only. This spot comparison is a guard, not proof of continuous feed identity.
- biquote source is not proven to match this user's Exness account's exact symbol, spread, or executable price.
- The two-month demo evaluation must precede real-money reliance; no accuracy or profitability level is guaranteed.

## Validation
Run npm run check. Runtime verification must additionally confirm that XAUUSD and XAGUSD are actually subscribed, timestamps remain fresh, provider reconnects work, and market hours/quotes are correct. Do not treat HTTP 200 or a cached quote as a live market.
