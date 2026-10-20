# Gold Scalper

Personal XAUUSD signal dashboard. The application generates rules-based **manual-review candidates only**. It does not place broker orders and does not promise profitable or accurate predictions.

## Selectable strategies

- **MSNR + SMC (default):** H1 direction, M15 support/resistance context, aligned BOS/CHoCH, and ATR-aware risk. Existing pending-entry lifecycle remains unchanged.
- **EMA Ribbon + RSI (intraday option):** selectable from Strategy settings; supports completed M5 or M15 candles. Buy requires EMA9 > EMA21 > EMA50, the previous close at/below EMA9 followed by a completed close above EMA9, and RSI(14) > 50. Sell requires the inverse stack, a close crossing below EMA9, and RSI(14) < 50.
- **Risk engine:** ATR(14), stop at 2×ATR, and target at either 3×ATR (1.5R) or 4×ATR (2R). The signal entry is the trigger candle close. Before a signal is sent, the API checks a current quote and rejects it if price has already reached the stop or target boundary.
- **Closed candles only:** incomplete, malformed, stale, or unavailable market data fails closed. The new strategy does not require H1 candles, so an hourly-feed failure should not block its M5/M15 analysis.
- **No automatic execution:** this remains a manual-review signal dashboard. A Telegram message is a signal notification, not a broker order or a guarantee of profit.

## Current scope

- **XAUUSD:** enabled by default. Select either the existing MSNR + SMC model or EMA Ribbon + RSI from Strategy settings.
- **BTCUSD:** code path exists but Bitcoin is disabled in saved settings by default. The selected strategy and timeframe are used for analysis; verify normal BTC market-data availability before enabling it.
- **Market data:** Twelve Data candles and live quotes. Invalid, incomplete, stale, or unavailable data fails closed to NO_TRADE.
- **News panel:** calendar availability is advisory and does not block an otherwise valid signal. Review news risk manually when the calendar is unavailable.
- **Entry lifecycle:** a pending candidate is dashboard-only; no Telegram candidate alert is sent. A later completed M5 candle must touch the planned entry and close directionally. If SL or TP is touched first, the setup is invalidated. Pending setups expire after eight hours. Confirmation notifications older than 15 minutes from the confirmation candle close are not sent.
- **Risk limits:** daily signal cap, minimum RR, valid directional SL/TP, data validation, news restrictions, emergency stop, and duplicate-monitor lock remain active. Risk amount is a budget estimate; broker-specific lot sizing is intentionally not supplied.
- **Scheduler:** the current external cron-job.org relay has been observed running approximately every 15 minutes and dispatches `.github/workflows/gold-scalper-scheduled-monitor.yml`. That workflow is `workflow_dispatch` only. The current external schedule has **not** been changed to five minutes. Selecting M5 changes the strategy candle interval, but scans still occur only when the external relay runs (observed around every 15 minutes). For reliable coverage of every completed M5 candle, change the external relay to five minutes and verify it.
- **No broker execution:** the application is a manual-review signal dashboard. It does not place MT5 or other broker orders.

## Validation status

- Automated repository checks run with `npm run check`; the recent M5 lifecycle, candle-validation, Asian-session, and timestamp regression tests passed in GitHub Actions.
- Production deployment was verified READY after the M5 monitoring changes.
- The database currently has no recorded manual trade outcomes. Therefore, a measured win rate, expectancy, average realized R, and maximum drawdown are not available. Do not treat code tests or the quality score as proof of strategy profitability.
- A meaningful two-month paper-trading test remains necessary before real-money reliance.

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
