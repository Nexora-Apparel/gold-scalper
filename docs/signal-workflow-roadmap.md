# Signal Workflow Roadmap

## Objective
Build a personal XAUUSD signal assistant that can identify a potential setup before price reaches the planned entry, send a clear Telegram alert, and track whether the setup remains valid. It is an analysis/alerting system, not an order-execution bot.

## Current verified baseline
- Owner-authenticated dashboard and manual on-demand analysis.
- Twelve Data H1/M15 completed-candle validation and fail-closed handling.
- H1 EMA20/EMA50 trend filter, M15 MSNR zones/rejection or retest, RSI and ATR filters.
- Rule-based quality score, configured risk-to-reward target, estimated cash-risk budget.
- Optional Telegram notification for a candidate.
- No background scanning, pending-entry lifecycle, entry monitoring, historical backtest, broker lot-size verification, or automated broker orders.

## Target workflow
1. **Market-data gate:** retrieve completed H1/M15 candles; reject malformed, stale, incomplete, or unavailable data.
2. **Regime and setup:** evaluate trend, structure, support/resistance, momentum, volatility, and opposing-zone clearance. Never force a trade when filters disagree.
3. **Pre-entry candidate:** only create a pending-entry idea when the intended entry is still ahead of current price in the correct direction. Distinguish this from an immediate/market-entry candidate. A lead-time estimate is informational, not guaranteed.
4. **Risk validation:** calculate entry, invalidation-based stop, target, and RR; reject invalid or structurally blocked trades. Do not claim a verified lot size until broker contract/tick-value rules and account-currency conversion are known.
5. **Telegram alert:** clearly label the setup as PENDING, include BUY LIMIT/SELL LIMIT where appropriate, entry/SL/TP, RR, quality score (not win probability), setup reason, timestamp, and expiry/invalidity conditions.
6. **Lifecycle monitoring:** avoid repeated duplicate alerts; track pending, triggered, expired, and invalidated states. Re-check fresh data before sending state-change alerts.
7. **Operator controls:** owner-only pause/resume, emergency stop, risk settings, test notification, recent history, and explicit system/data status.
8. **Validation:** deterministic unit tests, historical walk-forward/backtest with spread/slippage assumptions, paper/signal-only forward testing, and deployment checks before enabling automation.

## Safety and correctness constraints
- No broker orders or real-money execution.
- No claim that a setup is guaranteed to arrive in 20–30 minutes. Price may never reach the level or may reach it sooner.
- Do not notify a pending entry if it is already crossed or no longer valid at the latest verified price.
- Do not use a forming candle for a confirmed setup.
- Daily limits, pause, and emergency stop must apply to automated scanning as well as manual analysis.
- Protect scheduled endpoints with a secret and owner/operational safeguards; never weaken dashboard authentication or deployment protection.
- Use idempotency keys based on symbol, direction, entry zone, and setup/candle identity to suppress duplicate alerts.
- Keep market-data verification distinct from whether the data-provider API key merely exists.
- No profitability or accuracy claims until independently validated.

## Delivery sequence
### Phase 1 — Strategy correctness
- Add deterministic synthetic fixtures for bullish, bearish, neutral, stale/malformed, invalid stop, and blocked-target cases.
- Audit indicator math, pivot confirmation, zone clustering, and candle ordering.
- Make every rejection reason explicit and ensure candidate prices/SL/TP are finite and directionally valid.

### Phase 2 — Pending-entry model
- Define pending-entry conditions separately from immediate entry conditions.
- Add entry status, creation time, last verified price, expiry, invalidation rule, and idempotency identity.
- Add unit tests for entry-ahead-of-price, already-crossed entries, expiry, and invalidation.

### Phase 3 — Monitoring and Telegram
- Implement a protected scan endpoint that shares the same strategy and risk gates as manual analysis.
- Choose and verify a supported scheduler cadence before enabling recurring scans; current Vercel Hobby cron constraints must not be bypassed or assumed away.
- Add lifecycle updates and duplicate suppression; test Telegram delivery failures and retry safety.

### Phase 4 — Evidence before use
- Backtest without look-ahead bias and with realistic spread/slippage assumptions.
- Run signal-only forward testing and report metrics honestly.
- Keep automated order execution out of scope unless separately requested and explicitly reviewed.
