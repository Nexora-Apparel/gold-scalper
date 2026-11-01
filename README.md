# VELTRIX LIVE

Personal rules-based market-analysis dashboard for manual review. It records signal candidates, lifecycle changes, missed setups, and manually entered outcomes in the dashboard and Neon journal. It does not place broker orders and makes no profitability or accuracy guarantee.

## Current release scope

- **XAUUSD (Gold):** the only instrument with an active signal-analysis engine in this release.
- **XAGUSD (Silver):** available as a TradingView chart symbol only. Silver signal analysis is not enabled yet; the dashboard labels this explicitly.
- **BTCUSD:** removed from active dashboard, API routes, and scheduled monitoring. Existing historical records are preserved.
- **Notifications:** dashboard and Neon journal only. Telegram transport, Telegram test UI, credentials, and API calls have been removed.
- **Execution:** manual review only. No MT5 orders, broker orders, or automated position management are placed.
- **Signal frequency:** no fixed daily signal quota. The system keeps one active signal lifecycle at a time and does not stack another entry while the existing signal is active.

## Strategy and risk controls

- **MSNR + SMC:** H1 directional context, M15 structure and support/resistance, BOS/CHoCH, liquidity/FVG context, momentum and ATR-aware risk.
- **EMA Ribbon + RSI:** selectable strategy using completed M5 or M15 candles; EMA 9/21/50 alignment, EMA9 trigger and RSI(14) confirmation.
- **Risk:** configurable account balance, currency and 0.1%–1% risk budget; minimum reward/risk validation; ATR-based stop and target controls.
- **Market data:** Twelve Data completed candles and live quote checks. Malformed, incomplete, stale or unavailable data fails closed to NO_TRADE.
- **Economic calendar:** advisory status is shown in the dashboard. Calendar outages do not fabricate a clear-news result; review news manually.
- **Lifecycle:** pending setup, entry confirmation, invalidation, expiry, and closure/outcome recording. A signal is not a trade until the owner manually executes it.
- **Safety:** owner authentication, pause/resume, emergency stop, persistent state, monitor lock, and manual outcome journal.

## Scheduler architecture

cron-job.org calls the protected Vercel relay `POST /api/scheduler-dispatch`. The relay validates `SCHEDULER_TRIGGER_SECRET` and dispatches the fixed GitHub Actions workflow on `main` using `GITHUB_DISPATCH_TOKEN`. The workflow then calls the production `/api/status` and authenticated `/api/analyze` endpoints using `CRON_SECRET`.

The external scheduler is configured for approximately 15-minute intervals. The workflow itself is `workflow_dispatch` only; GitHub scheduled events are not configured as a fallback. Runs may be delayed and are not tick-level monitoring. Selecting M5 changes the strategy candle interval, but does not make the external scheduler run every five minutes.

## Automated validation

Run `npm install` and `npm run check`. GitHub Actions also builds and tests the Android companion. Unit tests prove behavior against test fixtures; they do not establish live-market accuracy or profitability.

## Required Vercel environment variables

Configure Preview and Production separately. Preview should use its own Neon branch; Production uses the production database branch.

- `DATABASE_URL` — Neon connection string for the target environment.
- `TWELVEDATA_API_KEY` — market-data provider key.
- `DASHBOARD_PASSWORD` — strong owner password.
- `SESSION_SECRET` — random secret of at least 32 characters.
- `CRON_SECRET` — random secret of at least 32 characters. Set the same value as a GitHub Actions repository secret; the workflow sends it as `Authorization: Bearer <CRON_SECRET>` to the production analysis endpoint.
- `SCHEDULER_TRIGGER_SECRET` — Production-only random secret used in the cron-job.org relay Authorization header.
- `GITHUB_DISPATCH_TOKEN` — Production-only fine-grained GitHub token restricted to this repository with Actions: Read and write permission.

Never commit, paste, or log secrets. Do not expose tokens in URLs or screenshots. After changing Vercel environment variables, redeploy the relevant environment.

## First-run checklist

1. Open the dashboard and sign in with the owner password.
2. Confirm application and database status.
3. Review saved strategy, timeframe, risk and monitoring-session settings.
4. Keep the engine paused until market data and scheduler prerequisites are verified.
5. Start monitoring only after the protected scheduler relay and GitHub workflow are confirmed.
6. Review signal history and the Neon journal after each scan.
7. Record every manually taken or not-taken signal outcome; do not infer outcomes without checking the actual trade.
8. Keep the system in manual-review mode until at least two months of forward paper testing have been evaluated.

## Interpretation

A quality score is a model score, not win probability. Risk amount is a budget estimate, not broker lot sizing. Verify live quote, spread, contract size, tick value, account-currency conversion, market hours and scheduled news before any manual trade decision. No win-rate or expectancy claim is supported until measured from a sufficiently large, chronological out-of-sample sample.
