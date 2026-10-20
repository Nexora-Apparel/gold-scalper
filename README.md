# Gold Scalper

Personal XAUUSD signal dashboard. The application generates rules-based **manual-review candidates only**. It does not place broker orders and does not promise profitable or accurate predictions.

## Current strategy

- **Fixed combined model:** the strategy always uses MSNR + SMC; dashboard settings cannot switch either model off.
- **H1 direction:** EMA 20 versus EMA 50 determines the permitted direction.
- **M15 setup context:** the latest completed M15 candle must show an MSNR support/resistance rejection or breakout-and-retest / breakdown-and-retest. An aligned M15 BOS/CHoCH is also mandatory.
- **Supporting evidence:** liquidity sweeps, an Africa/Lagos Asian-session sweep, FVG retest, RSI momentum and EMA alignment are supporting confluence. They do not all have to be present and cannot replace the three core confirmations.
- **ATR-aware risk:** M15 ATR helps set the entry buffer and stop distance. The stop distance must remain within configured volatility bounds, and the actual rounded-price risk/reward must satisfy the configured minimum (default 2:1).
- **Completed candles only:** malformed, duplicate-timestamp, incomplete, stale, or unavailable candle data fails closed. H1/M15 remain the setup context; M5 is used for entry lifecycle monitoring when a pending setup exists.
- The quality score is a rule-based ranking, **not** a win probability. The strategy has not been historically validated for profitability.

## Current scope

- **XAUUSD:** enabled by default; H1 + M15 setup logic and M5 pending-entry lifecycle monitoring.
- **BTCUSD:** code path exists but Bitcoin is disabled in saved settings by default. A prior read-only data diagnostic succeeded; normal automated BTC lifecycle monitoring must be verified before enabling it.
- **Market data:** Twelve Data candles and live quotes. Invalid, incomplete, stale, or unavailable data fails closed to NO_TRADE.
- **News protection:** the economic-calendar filter fails closed if the calendar cannot be verified. This can suppress a valid setup during a provider outage; the restriction is intentional.
- **Entry lifecycle:** a pending candidate is dashboard-only; no Telegram candidate alert is sent. A later completed M5 candle must touch the planned entry and close directionally. If SL or TP is touched first, the setup is invalidated. Pending setups expire after eight hours. Confirmation notifications older than 15 minutes from the confirmation candle close are not sent.
- **Risk limits:** daily signal cap, minimum RR, valid directional SL/TP, data validation, news restrictions, emergency stop, and duplicate-monitor lock remain active. Risk amount is a budget estimate; broker-specific lot sizing is intentionally not supplied.
- **Scheduler:** the current external cron-job.org relay has been observed running approximately every 15 minutes and dispatches `.github/workflows/gold-scalper-scheduled-monitor.yml`. That workflow is `workflow_dispatch` only. The current external schedule has **not** been changed to five minutes. M5 candles improve entry-lifecycle evaluation on each scheduled pass; true five-minute end-to-end scans require the external relay to be configured for every five minutes and then verified.
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
