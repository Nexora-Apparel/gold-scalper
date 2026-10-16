# External scheduler activation — Gold Scalper

## Current state

- The live monitor workflow is `.github/workflows/gold-scalper-scheduled-monitor.yml`.
- The workflow's `push` trigger has been removed to prevent ordinary code commits from initiating live analysis.
- `workflow_dispatch` remains available for manual verification.
- The staggered GitHub `schedule` remains as a temporary fallback.
- The production status endpoint reports the application and database online, with `CRON_SECRET`, Twelve Data and Telegram configuration present. A configured value does not by itself prove delivery or end-to-end operation.
- A successful scheduled execution has not yet been confirmed. Recent run history queries found zero `schedule` and zero `workflow_dispatch` events.

## External dispatch setup

Use cron-job.org (or an equivalent trusted scheduler) to call GitHub's workflow-dispatch API, not the Vercel analysis endpoint. This keeps the scheduler's short HTTP timeout away from the analysis request.

### GitHub token

Create a fine-grained personal access token restricted to the `Nexora-Apparel/gold-scalper` repository. Grant only **Actions: Read and write**. Choose an expiry and document when it must be rotated. Never commit the token, include it in a URL, or place it in logs.

### Scheduled HTTP request

- Method: `POST`
- URL: `https://api.github.com/repos/Nexora-Apparel/gold-scalper/actions/workflows/gold-scalper-scheduled-monitor.yml/dispatches`
- Body: `{"ref":"main"}`
- Headers:
  - `Authorization: Bearer <fine-grained-token>`
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `User-Agent: gold-scalper`
  - `Content-Type: application/json`
- Interval: every 15 minutes
- Expected successful HTTP status: `204`

Store the token in the scheduler's protected credential/header settings, not in a publicly visible request URL or repository file. If the scheduler UI cannot keep authorization headers private, do not use it.

## Verification sequence

1. Use GitHub's Actions page to run **Gold Scalper scheduled monitor** manually, or send one dispatch request.
2. Confirm a new run appears with event `workflow_dispatch`, not `push`.
3. Inspect every step: scheduler configuration, production preflight, and authenticated analysis/pending-entry check. A green run where analysis is skipped outside the configured session is not proof that live analysis ran.
4. During the configured `01:00–07:00 Africa/Lagos` session, confirm a dispatched run reaches the analysis step and validates fresh completed H1/M15 candles. A `NO_TRADE` result can be correct; do not force a signal for testing.
5. Verify Telegram delivery only through a legitimate test or a real qualifying signal; do not infer delivery from `TELEGRAM_BOT_TOKEN` being configured.
6. Confirm no duplicate active setup or duplicate Telegram notification across consecutive monitor runs.
7. Let the external scheduler run reliably for at least one full session and review failures before removing the GitHub `schedule` fallback. Removing the fallback before this point could leave monitoring inactive if the external job or token fails.

## Safety boundaries

- Do not alter strategy thresholds just to produce a signal.
- Respect the emergency stop, engine state, session window, pending-entry lifecycle and daily signal limit.
- This project is in manual-review mode; it does not place broker orders.
- Do not declare the bot operational until repeated scheduled runs, fresh data validation and end-to-end Telegram behavior are verified.
