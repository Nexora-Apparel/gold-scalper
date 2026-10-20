# External scheduler activation — Gold Scalper

## Current state

- The monitor workflow is `.github/workflows/gold-scalper-scheduled-monitor.yml`.
- The workflow is manually dispatched only. There is no GitHub `schedule` trigger in the current workflow, so there is no built-in fallback timer.
- Production status confirms the app/database are online and XAUUSD completed-candle data is being verified.
- On 2026-10-20, successful `workflow_dispatch` monitor runs were observed at 15-minute intervals from 04:22Z through 05:37Z. Each run passed its prerequisite checks and authenticated analysis step.
- The 05:37Z run verified fresh XAUUSD completed candles and correctly returned `NO_TRADE` because the actual rounded-price reward/risk was 1.64R, below the configured 2R minimum.
- The same run skipped BTCUSD with `BTC_DISABLED`, so BTC trading/monitoring remains disabled.
- A one-time read-only BTC diagnostic passed at 05:48:40Z on 2026-10-20: 119 validated H1 candles, 249 validated M15 candles, a verified live quote, and completed candles at H1 `2026-10-20 04:00:00` / M15 `2026-10-20 05:30:00` UTC. Diagnostic analysis returned `NO_TRADE`; no signal, Telegram message, database write, or broker order occurred.
- This confirms the BTC market-data feed is accessible, not that BTC strategy monitoring is enabled. BTC remains disabled until the owner enables it in saved settings and a normal scheduled BTC analysis verifies data and lifecycle behavior. The temporary one-time diagnostic workflow was removed after this result.
- The run history is evidence that recurring dispatches are reaching GitHub Actions; cron-job.org's saved configuration and protected header still need direct inspection before calling the scheduler fully audited.

## Intended architecture

Use cron-job.org (or another trusted scheduler) to call the Vercel relay endpoint:

- Relay endpoint: `https://gold-scalper-nexora-apparel.vercel.app/api/scheduler-dispatch`
- Method: `POST`
- Header: `Authorization: Bearer <SCHEDULER_TRIGGER_SECRET>`
- Expected response: HTTP `202` with `ok: true` and `queued: true`
- Interval: every 15 minutes

The relay validates `SCHEDULER_TRIGGER_SECRET`, then uses the server-side `GITHUB_DISPATCH_TOKEN` to dispatch the `Gold Scalper scheduled monitor` workflow against `main`. This keeps the GitHub token out of cron-job.org. Never put a secret in the URL, a public field, source code, or logs. Configure the job so its authorization header is private. If the scheduler cannot protect the header, do not use it.

The relay is not the analysis endpoint. Do not point cron-job.org directly at `/api/analyze` or `/api/analyze-btc`; the GitHub workflow performs the authenticated analysis calls and handles the longer timeout.

## Verification sequence

1. In cron-job.org, inspect the job URL, method, 15-minute schedule, and protected bearer header. Do not copy secrets into chat or screenshots.
2. Trigger one test run from cron-job.org. Confirm the relay returns HTTP `202`. A `202` only means GitHub accepted the dispatch; it does not prove analysis succeeded.
3. In GitHub Actions, confirm a new **Gold Scalper scheduled monitor** run appears with event `workflow_dispatch` and ref `main`.
4. Inspect all workflow steps: configuration validation, production preflight, XAUUSD analysis/pending-entry check, and BTCUSD monitor.
5. During the configured `01:00–07:00 Africa/Lagos` session, confirm fresh completed candles are verified. A `NO_TRADE` result can be correct; never force a signal for testing.
6. Check the workflow result and the production status endpoint after the run. A green run that intentionally skips analysis outside the session or while paused is not proof that a market scan ran.
7. Verify Telegram delivery only through a legitimate test or a real qualifying signal. A configured Telegram token is not proof of successful delivery.
8. Confirm repeated runs do not create duplicate active setups or duplicate Telegram notifications. Review at least one full session before calling the scheduler reliable.

## Known runtime checks to keep visible

- `/api/status` currently reports whether BTCUSD is enabled separately from XAUUSD. If `btcEnabled` is false, the BTC monitor must not be described as active, even if its endpoint exists.
- Production status previously showed XAUUSD fresh-candle verification, while BTCUSD was disabled and lacked recent fresh-candle verification. Confirm the owner-saved BTCUSD setting before counting BTC scans as operational.
- The dashboard and workflow are signal-only/manual-review. No broker orders are placed.

## Safety boundaries

- Do not lower strategy, rounded-price minimum RR, news, stop/target, or entry-confirmation gates just to produce more signals.
- Respect the emergency stop, engine state, configured session, pending-entry lifecycle, and daily signal limit.
- Do not declare the bot operational until recurring dispatch, fresh market data, BTC enablement (if desired), and end-to-end Telegram behavior are verified.
