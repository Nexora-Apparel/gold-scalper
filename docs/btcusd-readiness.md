# BTCUSD integration readiness

## Current implementation
- BTC/USD H1 and M15 completed candles are validated before MSNR analysis.
- The current BTC/USD quote is checked before a pending-entry candidate is queued and before an entry-confirmation Telegram message is delivered.
- BTC has its own persistent active-signal key (`active_signal:BTCUSD`) and symbol-tagged history; Gold remains on the existing `active_signal` key.
- Gold and BTC share the monitor lock and daily cap of three signal candidates per Africa/Lagos day.
- BTC monitoring is scheduled alongside Gold, can run 24/7 when enabled, and follows the global engine pause/emergency stop.
- Telegram alerts are manual-review signals only. No broker order execution is connected.
- A confirmed BTC signal is not replaced until its manual outcome is recorded.

## Activation gate
BTC is disabled by default. Do not enable it in Production until all of the following are true:
1. The mainline integration tests pass.
2. A current Vercel Preview deployment builds successfully.
3. `/api/status` reports the BTC configuration and the protected `/api/market-data-btc` route verifies fresh completed BTC/USD candles.
4. An authenticated `/api/analyze-btc` pass verifies H1/M15 candles and current quote, or explicitly reports `NO_TRADE` with verified data.
5. Telegram formatting and delivery are verified without sending fabricated or test trade signals.
6. BTC MSNR parameters have been reviewed against historical/forward-test results. The shared Gold-derived strategy is not yet independently calibrated for BTC volatility.

## Current blocker
Vercel's deployment API has returned `api-deployments-free-per-day` / HTTP 402, so the latest preview build cannot currently be created. Keep this change in draft and keep BTC disabled until preview verification is possible.
