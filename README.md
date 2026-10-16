# Gold Scalper

Personal XAUUSD signal dashboard. The application generates rules-based **manual-review candidates only**. It does not place broker orders and does not promise profitable or accurate predictions.

## Current strategy

- **MSNR (Multiple Support and Resistance):** builds price zones from confirmed H1 and M15 swing highs/lows, clustering nearby levels and tracking their source and touch count.
- **H1 trend filter:** EMA 20 versus EMA 50 determines the permitted direction.
- **M15 entry confirmation:** looks for a confirmed support/resistance rejection or a breakout-and-retest / breakdown-and-retest candle.
- **Momentum filter:** M15 RSI must support the H1 direction; M15 EMA 20 is an additional quality check.
- **Risk controls:** ATR-based stop-loss bounds, configured risk-to-reward target, and rejection when a nearby opposing zone does not leave enough room for the target.
- Only completed candles are used; pivot levels require right-side candle confirmation. The engine returns NO_TRADE when conditions do not align.

The quality score is a rule-based filter, **not** a win probability. This strategy has not yet been historically backtested and must not be assumed profitable.

## Current scope

- XAUUSD and BTCUSD; both use the existing H1 trend + M15 MSNR rules-based analysis.
- Gold follows the configured Africa/Lagos monitoring session. BTCUSD is independent of Gold's session and is intended to run 24/7, including weekends, when enabled.
- BTCUSD has its own active-signal lifecycle state and history symbol. The daily cap of up to 3 signal candidates is shared across both markets.
- BTCUSD has not been independently backtested or calibrated for Bitcoin volatility. Treat BTC results as experimental manual-review candidates until independently validated.
- Twelve Data candles for XAU/USD and BTC/USD; invalid, incomplete, stale, unsupported, or unavailable data fails closed to NO_TRADE. Key presence alone does not verify BTC symbol entitlement; the configured plan must support BTC/USD H1, M15, and live-quote endpoints.
- Persistent settings, control state, active signal lifecycles, and analysis history in Neon.
- Owner-authenticated dashboard, pause, emergency stop, reset, and manual on-demand analysis.
- Telegram notifications are intended only after a later completed M15 candle retests the stored candidate entry and closes in the signal direction; fresh candidates are not sent as immediate market orders.
- Monitoring runs through `/api/analyze` for Gold during the configured session and `/api/analyze-btc` for Bitcoin at any hour when enabled. The GitHub Actions workflow `.github/workflows/gold-scalper-scheduled-monitor.yml` is prepared to call the relevant endpoints every 15 minutes, with manual dispatch also available. Scheduled GitHub workflows can be delayed and are not tick-level monitoring.
- No automated trading, continuous tick-level scanning, economic-calendar/news filter, verified broker lot sizing, or historical backtest results.

## Required Vercel environment variables

Configure these for **Preview** first, then redeploy the branch:

- `DATABASE_URL` — Neon database URL for the Preview branch.
- `TWELVEDATA_API_KEY` — Twelve Data API key.
- `DASHBOARD_PASSWORD` — strong owner password.
- `SESSION_SECRET` — random secret at least 32 characters.
- `CRON_SECRET` — a separate random secret at least 32 characters; the scheduler must send it as `Authorization: Bearer <CRON_SECRET>`. Add the same value as a GitHub Actions repository secret named `CRON_SECRET`.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` — Telegram delivery configuration.

Also add a GitHub Actions repository secret named `GOLD_SCALPER_URL` containing the base HTTPS URL of the deployment to monitor (without an API path). Keep credentials private and never commit tokens or passwords to Git.

## First-run checklist

1. Open the dashboard and sign in with the owner password.
2. Confirm system/database status and saved settings.
3. Use **TEST TELEGRAM DELIVERY** and verify that the test message arrives.
4. Confirm both XAUUSD and BTCUSD are enabled as intended.
5. Test `/api/market-data` and `/api/market-data-btc` separately; both must report fresh completed candles before relying on the relevant market. A successful Gold feed does not verify BTC access.
6. Press START BOT to enable scheduled monitoring. No broker execution is enabled.
7. Run ANALYZE GOLD NOW during its configured session and ANALYZE BTC NOW at any time. A NO_TRADE result is valid when the setup rules do not align.
8. Confirm symbol-labelled history persists after refresh; test pause and emergency stop. Resetting emergency stop leaves the engine paused.
9. Do not use any candidate on a live account until independently validated.

## Signal interpretation

A signal is a rules-based candidate, not a guarantee. Risk amount is only a cash-risk budget estimate. Lot size is intentionally not supplied until the broker's XAUUSD contract size, tick value, and account-currency conversion are verified. Check live price, spread, market hours, and scheduled news manually before any trade decision.
