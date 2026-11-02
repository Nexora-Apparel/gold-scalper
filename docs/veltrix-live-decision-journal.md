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
The authenticated scalping-events API accepts 1–100 events per POST and supports GET with optional symbol and limit. eventId is unique and database-enforced for idempotency. Event payloads are capped at 12 KB. Events include market state, decisions, signal/rejection lifecycle, missed opportunities, position lifecycle, exit recommendations, feed failures, emergency-stop state and manually recorded realized-R outcomes. The dashboard calculates settled trade count, win rate, net R and average R only from explicit outcome records; it never infers profit from a signal or position-closed event.

### Canonical event envelope v1
Each accepted event is normalized with:
- `schemaVersion: 1` and a controlled `source` (`android`, `web`, `server`, `replay`, or `legacy`).
- A unique `eventId`, `occurredAt`, event type, market symbol and optional side.
- `correlationId`, `signalId` and `positionId` where those references exist.
- The original payload, preserved without destructive migration. The API stores normalized envelope metadata at `payload._envelope` so existing JSONB consumers remain compatible.

Android Room events are synchronized in bounded batches. The Android sync adapter derives `signalId` from `sourceSignalRef` for position and missed-opportunity events, keeping the originating signal linked to the MT5 ticket. Events remain pending locally when the API rejects a batch or cannot confirm the full received count.

### Position lifecycle invariants
For an MT5 `positionId`, the server reconstructs persisted history plus the incoming batch in timestamp order:
1. `POSITION_OPENED` establishes the position.
2. Exit recommendation, acknowledgement and clearance events are only valid while that position is open.
3. `POSITION_CLOSED` requires an earlier open event.
4. `POSITION_OUTCOME_RECORDED` requires closure and is limited to one settlement per ticket.
5. Repeated event IDs and repeated outcome submissions are idempotent. Invalid new transitions return HTTP 409; already-settled outcome retries are skipped and counted rather than blocking the batch.

The position/type lookup index supports lifecycle reconstruction. Legacy duplicate open/close anomalies are tolerated while new duplicate transitions are rejected; these historical anomalies remain data-quality items to audit.

The Android event journal uses durable Room/SQLite storage before network upload. The dashboard's browser-side diagnostics queue is not a substitute for the device's durable journal.

## Known integration limits
- Decision engine is deterministic and experimental. Directional tick pressure is a proxy and requires calibration against recorded bid/ask ticks.
- Android foreground SignalR, local-only MediaProjection/ML Kit OCR, one-position lifecycle tracking, manual journal fallback, signal-expiry/missed-opportunity recording and dynamic exit recommendations are implemented in the validation branch. OCR accuracy, overlay behavior, reconnection and exit behavior still require physical MT5 device validation.
- The Android emergency-stop latch disables new signal generation locally while keeping existing-position exit monitoring active. It does not close MT5 positions and does not globally stop the website/server engine; the user must still manage open positions in MT5.
- No Exness API or order execution bridge is enabled. The Android decision engine blocks new signals until a fresh Exness MT5 bid/ask/spread match is confirmed against the biquote tick. OCR-based parity expires after 2.5 seconds without another matching quote; manual checks expire after ten seconds. Parity is revoked immediately on stale/closed feed. This is a short-lived parity guard, not proof that the provider is the user's Exness feed.
- biquote source is not proven to match this user's Exness account's exact symbol, spread, or executable price.
- The two-month demo evaluation must precede real-money reliance; no accuracy or profitability level is guaranteed.

## Validation
Run npm run check. Runtime verification must additionally confirm that XAUUSD and XAGUSD are actually subscribed, timestamps remain fresh, provider reconnects work, and market hours/quotes are correct. Do not treat HTTP 200 or a cached quote as a live market.
