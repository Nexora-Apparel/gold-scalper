# cron-job.org external dispatch setup

This project uses GitHub Actions to run scheduled monitoring. cron-job.org must trigger the GitHub Actions workflow through the authenticated relay at `POST /api/scheduler-dispatch`; it must not call `/api/analyze` directly.

## Required Vercel Production environment variables

Set both variables in the `gold-scalper` Vercel project for **Production** only:

- `SCHEDULER_TRIGGER_SECRET`: a long random secret shared only with the cron-job.org request's Authorization header.
- `GITHUB_DISPATCH_TOKEN`: a GitHub fine-grained personal access token scoped to only `Nexora-Apparel/gold-scalper`, with **Actions: Read and write** repository permission. Set an expiration and rotate it when it expires. Never put this token in the cron-job.org job or URL.

Do not use the bot's `CRON_SECRET` as the relay secret. These secrets have separate purposes.

## cron-job.org job

- Title: `Gold Scalper Workflow Trigger`
- URL: `https://gold-scalper-nexora-apparel.vercel.app/api/scheduler-dispatch`
- Method: `POST`
- Schedule: `7,22,37,52 * * * *`
- Header: `Authorization: Bearer <SCHEDULER_TRIGGER_SECRET>`
- Optional header: `Content-Type: application/json`
- Body: `{}`

Keep the existing GitHub Actions schedule enabled until cron-job.org has successfully triggered and the workflow has completed successfully several times. Do not remove the fallback merely because the HTTP test returns success.

## Endpoint behavior and security

- POST only; GET and other methods return 405.
- Compares the bearer secret using a constant-time comparison.
- Secrets are read only from Vercel environment variables; none are committed to source.
- Dispatches only the fixed workflow on the fixed `main` ref.
- Does not accept caller-provided repository, workflow, or branch values.
- Does not return GitHub response bodies or credentials.
- A successful dispatch returns HTTP 202 only after GitHub confirms the workflow-dispatch request with HTTP 204.
- A successful relay response confirms queueing, not completion. Verify the matching GitHub Actions run separately.

## Token setup

Create a fine-grained token in GitHub settings. Restrict repository access to this repository only, grant the Actions repository permission **Read and write**, and set an expiration. Store it as the Vercel Production environment variable `GITHUB_DISPATCH_TOKEN`. Never paste the token into chat or into cron-job.org.

After adding or changing Vercel environment variables, redeploy Production so the running deployment receives them. Do not activate the external job until both variables exist and the deployed endpoint has been tested.
