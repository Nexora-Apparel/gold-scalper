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
- Monitoring runs whenever `/api/analyze` is called. For unattended monitoring, configure a trusted external scheduler to POST to `/api/analyze` every 5–15 minutes with `Authorization: Bearer <CRON_SECRET>` and a JSON body `{}`. Add a strong `CRON_SECRET` in Vercel first. The endpoint still respects START/PAUSE and emergency stop; no scheduler is configured by this code alone.
- No automated trading, continuous/background scanning, economic-calendar/news filter, verified broker lot sizing, or backtest results.

## Required Vercel environment variables

Configure these for **Preview** first, then redeploy the branch:

- `DATABASE_URL` — Neon database URL for the Preview branch.
- `TWELVEDATA_API_KEY` — Twelve Data API key.
- `DASHBOARD_PASSWORD` — strong owner password.
- `SESSION_SECRET` — random secret at least 32 characters.
- `CRON_SECRET` — a separate random secret at least 32 characters for a trusted external scheduler to POST to `/api/analyze` with `Authorization: Bearer <CRON_SECRET>`.
- `TELEGRAM_BOT_TOKEN` — token from Telegram's official BotFather.
- `TELEGRAM_CHAT_ID` — the private chat or group ID where the bot should send messages.

Never commit tokens or passwords to Git. In Telegram, create a bot through BotFather, open the bot and press Start, then determine the chat ID using a trusted method. For a group, add the bot and verify it is allowed to post. Set both Telegram environment variables in Vercel Preview and redeploy.

## First-run checklist

1. Sign in to the Preview dashboard.
2. Confirm system/database status and saved settings.
3. Use **TEST TELEGRAM DELIVERY**. Do not consider Telegram configured until the test message arrives.
4. Press START BOT; this enables manual on-demand analysis only.
5. Run ANALYZE GOLD NOW. A NO_TRADE result is valid when the entry rules do not align.
6. Confirm history persists after refresh.
7. Test pause and emergency stop. Resetting emergency stop leaves the engine paused.
8. Do not use a candidate on a live account until independently validated.

## Signal interpretation

A signal is a rules-based candidate, not a guarantee. Risk amount is only a cash-risk budget estimate. Lot size is intentionally not supplied until the broker's XAUUSD contract size, tick value, and account-currency conversion are verified. Check live price, spread, market hours, and scheduled news manually before any trade decision.
