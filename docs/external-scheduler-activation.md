# External scheduler activation — VELTRIX LIVE

## Current architecture

- cron-job.org calls the Vercel relay at `POST /api/scheduler-dispatch`.
- The relay validates `SCHEDULER_TRIGGER_SECRET` and dispatches the fixed workflow `.github/workflows/gold-scalper-scheduled-monitor.yml` against `main`.
- GitHub Actions checks the production `/api/status` endpoint and then calls `POST /api/analyze` with `Authorization: Bearer <CRON_SECRET>`.
- The workflow is `workflow_dispatch` only. It has no GitHub cron schedule fallback.
- The external scheduler is configured for approximately 15-minute intervals. Runs may be delayed; this is periodic scanning, not tick-level monitoring.

## Required secrets

Vercel Production:

- `SCHEDULER_TRIGGER_SECRET` — long random bearer secret for cron-job.org.
- `GITHUB_DISPATCH_TOKEN` — fine-grained token restricted to `Nexora-Apparel/gold-scalper` with Actions: Read and write.
- `CRON_SECRET` — bearer secret consumed by the scheduled workflow when it calls `/api/analyze`.

GitHub Actions repository secrets:

- `CRON_SECRET` — must exactly match the Production Vercel `CRON_SECRET`.

Do not place GitHub tokens in cron-job.org. Do not put secrets in URLs, workflow logs, source code, or chat.

## cron-job.org job

- Title: `Gold Scalper Workflow Trigger`
- URL: `https://gold-scalper-nexora-apparel.vercel.app/api/scheduler-dispatch`
- Method: `POST`
- Schedule: `7,22,37,52 * * * *`
- Header: `Authorization: Bearer <SCHEDULER_TRIGGER_SECRET>`
- Optional header: `Content-Type: application/json`
- Body: `{}`

The relay returns HTTP 202 only after GitHub accepts the workflow-dispatch request with HTTP 204. A 202 confirms queueing only, not successful analysis.

## Verification sequence

1. Inspect the cron-job.org URL, method, schedule, and protected bearer header without copying the secret.
2. Trigger one run and confirm the relay returns HTTP 202.
3. Confirm a GitHub Actions `workflow_dispatch` run starts on `main`.
4. Check preflight: application online, database connected, market-data key configured, and CRON_SECRET configured.
5. Check whether the engine is intentionally paused or outside its configured session.
6. For an actual analysis run, require fresh completed candles and a clear `marketDataVerified: true` result.
7. Review the dashboard and Neon journal for persisted signal lifecycle records.
8. Repeat over a full session and inspect duplicate suppression and scheduler heartbeat before calling the scheduler reliable.

## Current release constraints

- XAUUSD is the only active analysis instrument. XAGUSD is chart-only; BTC active analysis has been removed.
- Notifications are dashboard/Neon journal only; Telegram delivery is not part of this release.
- No broker order execution is connected.
- There is no fixed daily signal quota. A single active signal lifecycle is maintained.
- A green workflow that intentionally skips analysis while paused or outside session is not evidence of a market scan.
- Do not claim profitable or accurate trading until forward-test outcomes have been recorded and evaluated.
