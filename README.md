# Gold Scalper

Personal XAUUSD signal dashboard. The application generates rules-based **manual-review candidates only**. It does not place broker orders and does not promise profitable or accurate predictions.

## Current scope

- XAUUSD only; H1 trend alignment + completed M15 breakout checks.
- Twelve Data market candles; invalid, incomplete, stale, or unavailable data fails closed to NO_TRADE.
- Persistent settings, control state, and analysis history in Neon.
- Owner-authenticated dashboard, pause, emergency stop, reset, and manual on-demand analysis.
- Optional Telegram notifications for validated SIGNAL_CANDIDATE results.
- No automated trading, scheduled scanning, economic-calendar/news filter, verified broker lot sizing, or backtest results.

## Required Vercel environment variables

Configure these for **Preview** first, then redeploy the branch:

- `DATABASE_URL` — Neon database URL for the Preview branch.
- `TWELVEDATA_API_KEY` — Twelve Data API key.
- `DASHBOARD_PASSWORD` — strong owner password.
- `SESSION_SECRET` — random secret at least 32 characters.
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
