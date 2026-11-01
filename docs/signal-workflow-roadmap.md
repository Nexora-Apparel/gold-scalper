# VELTRIX LIVE — Signal Workflow Roadmap

## Objective

Maintain a manual-review market-analysis dashboard that evaluates XAUUSD, records every signal lifecycle transition in Neon, and supports honest forward-testing. It is not an order-execution bot.

## Current release status

- Owner-authenticated dashboard and manual on-demand XAUUSD analysis.
- Twelve Data H1/M15 and M5 completed-candle validation, OHLC checks, freshness limits, and fail-closed behavior.
- MSNR + SMC and EMA Ribbon + RSI strategy modes.
- Configurable risk budget and minimum reward/risk validation.
- Single active-signal lifecycle with pending entry, confirmation, invalidation, expiry, and manual outcome recording.
- Dashboard and Neon journal are the only signal/notification surfaces. Telegram transport and test endpoint have been removed.
- No fixed daily signal quota; an active setup is not stacked with a new candidate.
- XAGUSD is chart-only in this release. A separate Silver market-data and strategy validation path is future work.
- BTC active analysis and routes have been removed. Existing historical records are retained.
- No broker orders or automatic execution.
- The external cron-job.org relay dispatches the GitHub workflow on `main`; the workflow is manual-dispatch-only and depends on the external scheduler. The configured cadence is approximately 15 minutes.
- No validated profitability or accuracy claim exists. A two-month forward paper test remains required.

## Next engineering phases

### Phase 1 — Release validation

- Keep the serverless function count within the Vercel Hobby limit.
- Require `npm run check` and Android unit/build checks to pass.
- Verify a Preview deployment against the exact feature-branch commit.
- Confirm owner authentication, settings persistence, dashboard status, Neon journal writes, outcome recording, pause, and emergency stop.
- Keep Production and its database untouched until Preview verification is complete.

### Phase 2 — Live data and decision integrity

- Confirm broker-matched XAUUSD quote provenance, timestamp freshness, bid/ask spread, and candle aggregation.
- Verify M1 decision inputs with M5/M15 context before enabling low-latency decisions.
- Persist each accepted, rejected, invalidated, missed, and manually closed setup with a stable event identity.
- Test duplicate and out-of-order tick handling, stale-feed fail-closed behavior, and restart recovery.

### Phase 3 — Silver support

- Add a dedicated XAGUSD market-data mapping and instrument-specific price precision, contract sizing, risk calculation, and strategy validation.
- Add separate tests and forward-test records before exposing Silver signal analysis in the dashboard.
- Keep the Silver chart selector labelled chart-only until the full path is validated.

### Phase 4 — Android companion

- Verify MT5 screen observation and parsing on the actual Android device.
- Verify overlay permission, foreground service lifecycle, floating control behavior, battery restrictions, and recovery after process death.
- Physical testing is required; CI build success alone does not prove device compatibility.

### Phase 5 — Evidence before use

- Run chronological walk-forward/backtests without look-ahead bias and with realistic spread/slippage assumptions.
- Collect at least two months of signal-only forward-test results.
- Report sample size, win rate, expectancy, net R, drawdown, missed opportunities, and invalidations.
- Do not describe model quality as win probability or enable broker execution based solely on unit tests.

## Safety constraints

- No broker orders or real-money execution.
- Never force a signal to meet a frequency target.
- Do not use a forming candle for confirmation.
- Reject malformed, stale, incomplete, or unverifiable market data.
- Preserve emergency stop, owner authentication, pause state, and persistent journaling.
- Do not claim profitability or accuracy until independently validated.
