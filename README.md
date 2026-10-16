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

- XAUUSD only; H1 trend + M15 MSNR setup.
- Twelve Data candles; invalid, incomplete, stale, or unavailable data fails closed to NO_TRADE.
- Persistent settings, control state, and analysis history in Neon.
- Owner-authenticated dashboard, pause, emergency stop, reset, and manual on-demand analysis.
- Telegram notifications are intended only after a later completed M15 candle retests the stored candidate entry and closes in the signal direction; fresh candidates are not sent immediately.
- Monitoring runs whenever `/api/analyze` is called. The GitHub Actions workflow `.github/workflows/gold-scalper-scheduled-monitor.yml` runs on a 15-minute schedule from the default branch and supports manual dispatch. Scheduled GitHub workflows can be delayed and are not tick-level monitoring. The workflow authenticates with the `CRON_SECRET` repository secret and skips analysis when the engine is paused, emergency stop is active, or the configured session has no pending signal to monitor.
- No automated trading, continuous/background scanning, economic-calendar/news filter, verified broker lot sizing, or backtest results.

## Required Vercel environment variables

Configure the appropriate values for **Preview and Production**. Keep their database URLs separate; Preview uses the preview Neon branch and Production uses the Neon `main` branch. Redeploy after changing environment variables:

- `DATABASE_URL` — Neon connection string for the matching environment's database branch.
- `TWELVEDATA_API_KEY` — Twelve Data API key.
- `DASHBOARD_PASSWORD` — strong owner password.
- `SESSION_SECRET` — random secret at least 32 characters.
- `CRON_SECRET` — a random secret at least 32 characters; the scheduled monitor sends it as `Authorization: Bearer <CRON_SECRET>`. The same value must be available to the Vercel Production environment and as a GitHub Actions repository secret named `CRON_SECRET`.
- `TELEGRAM_BOT_TOKEN` — token from Telegram's official BotFather.
- `TELEGRAM_CHAT_ID` — the private chat or group ID where the bot should send messages.

Add `CRON_SECRET` under GitHub repository Settings → Secrets and variables → Actions. The scheduled workflow uses the stable Production deployment URL in its workflow file, so a `GOLD_SCALPER_URL` repository secret is not required. Never commit tokens or passwords to Git. In Telegram, create a bot through BotFather, open the bot and press Start, then determine the chat ID using a trusted method. For a group, add the bot and verify it is allowed to post. Set both Telegram environment variables in Vercel Preview and Production, then redeploy.

## First-run checklist

1. Open the Production dashboard at `https://gold-scalper-nexora-apparel.vercel.app` and sign in with the owner password.
2. Confirm system/database status and saved settings.
3. Use **TEST TELEGRAM DELIVERY** if you need to re-verify delivery on this deployment.
4. Press START BOT to enable scheduled monitoring; the deployed engine state is stored persistently.
5. Confirm GitHub Actions shows a successful scheduled-monitor run. Runs may be delayed; they are not tick-level monitoring.
6. A `NO_TRADE` result is valid when the strategy rules do not align; never force a trade.
7. Confirm history persists after refresh, and test pause and emergency stop. Resetting emergency stop leaves the engine paused.
8. Do not use a candidate on a live account until independently validated.

## Signal interpretation

A signal is a rules-based candidate, not a guarantee. Risk amount is only a cash-risk budget estimate. Lot size is intentionally not supplied until the broker's XAUUSD contract size, tick value, and account-currency conversion are verified. Check live price, spread, market hours, and scheduled news manually before any trade decision.
