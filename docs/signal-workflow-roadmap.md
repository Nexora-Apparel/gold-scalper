# Signal Workflow Roadmap

## Objective
Build a personal XAUUSD signal assistant that can identify a potential setup before price reaches the planned entry, send a clear Telegram alert, and track whether the setup remains valid. It is an analysis/alerting system, not an order-execution bot.

## Current implementation status (verified from code)
- Owner-authenticated dashboard and manual on-demand analysis.
- Twelve Data H1/M15 completed-candle validation, OHLC validation, freshness limits, and fail-closed handling.
- H1 EMA20/EMA50 trend filter, M15 MSNR zones/rejection or retest, RSI and ATR filters.
- Rule-based quality score, configured risk-to-reward target, estimated cash-risk budget, and a hard maximum of three queued/delivered signal candidates per Lagos calendar day.
- Persistent single active-signal lifecycle: `WAITING_FOR_ENTRY`, `CONFIRMATION_PENDING_DELIVERY`, `CONFIRMED_AND_NOTIFIED`, `INVALIDATED`, and `EXPIRED`.
- Entry monitoring evaluates only completed candles later than the setup candle. A setup is not confirmed by its own candle. Pending BUY entries are placed above the setup candle high and pending SELL entries below its low, with a volatility-based buffer. Before queueing a new candidate, the engine verifies a current provider quote and rejects the candidate if its trigger has already been crossed or the quote cannot be verified. Ambiguous stop/target touches fail closed.
- Telegram send helper and owner-triggered delivery test exist. Confirmed-entry delivery retries while in `CONFIRMATION_PENDING_DELIVERY`.
- A GitHub Actions monitor workflow exists on `feature/personal-telegram-signal-bot` and is intended to run every 15 minutes. The dashboard defaults to 24-hour monitoring; selected-hour mode remains available with editable Africa/Lagos start/end times (initial values 08:00–20:00, e.g. 01:00–07:00). START/PAUSE controls govern scheduled scans, and active pending signals continue to be checked outside selected hours. The workflow is **not active on the default branch yet** and has not been verified end-to-end with repository secrets.
- No historical backtest, broker lot-size verification, or automated broker orders. No profitability/accuracy claim is supported.

## Automation activation checklist
1. Add a strong `CRON_SECRET` to the Vercel project environment used by the preview deployment. Do not expose it in source code, commit messages, workflow output, or chat.
2. Add the **same** `CRON_SECRET` as a GitHub Actions repository secret, plus `GOLD_SCALPER_URL` set to the base HTTPS URL of the intended deployment (no `/api/analyze` suffix).
3. Confirm the deployment has the required database, Twelve Data, and Telegram environment variables; redeploy the preview if environment variables were changed.
4. Manually run the scheduled monitor workflow and verify the action reports HTTP success **and** `marketDataVerified: true` (or a clearly intentional pause/emergency-stop/disabled-symbol/daily-limit skip).
5. Verify that the run is visible in the GitHub Actions run history and that a protected `POST /api/analyze` request without the correct bearer secret is rejected.
6. Review the workflow and signal lifecycle checks, then merge the pull request to the default branch to activate the recurring schedule. Do not merge or call automation ready before steps 1–5 pass.
7. Verify multiple consecutive runs and the full pending-entry/confirmation lifecycle; confirm that duplicate Telegram alerts are not produced.
8. Keep the engine paused until operational checks pass. The scheduler cadence is approximate: GitHub may delay scheduled runs, so this is periodic monitoring, not real-time surveillance.

## Phase 1 — implemented on feature branch (automated checks passed)

- Minimum risk/reward is enforced against the actual rounded entry, stop, and target prices. Targets are not silently downgraded to a sub-minimum R multiple; Telegram formatting also rejects any signal below 1.5R or whose declared RR does not match its prices.
- The quality score is now a transparent 100-point component score: H1 trend strength (20), zone quality (25), MSNR candle/price action (20), RSI (10), M15 EMA alignment (5), entry/stop quality (10), risk/reward (5), and preferred-session weighting (5). Configured 65/70/75/80 thresholds are applied as actual gates, and Telegram alerts include each component and the threshold. The score is a rule-based ranking, not a probability of winning.
- New candidates are gated by the Fair Economy weekly economic calendar feed. High-impact USD events block new candidates within 30 minutes before/after the scheduled time. Calendar timeout, HTTP failure, empty/malformed payloads, or invalid event rows fail closed. Entry-confirmation Telegram delivery is held while the calendar is blocked/unavailable and retried after it clears.
- London/New York session weighting is included in the score. Session hours are a Lagos-time approximation and are not an absolute restriction, so a user-configured overnight window remains usable but may receive a lower score.
- The scheduled monitor no longer runs on every code push; it runs only by schedule or explicit manual dispatch, avoiding unintended live scans during edits.
- npm run check passed on commit f41bd38d25164bb112850fc4bcb24b77c693aa55, including the new news-window tests and Telegram RR validation tests. The later workflow-only change removes the push trigger and does not alter application code.
- Runtime/production verification remains outstanding: the scheduled monitor's preflight received HTTP 302 from the Vercel preview deployment, consistent with deployment protection/redirect. The monitor correctly stopped before requesting analysis. Do not treat Phase 1 as runtime-verified or enable live reliance until the intended deployment can be checked without weakening its protection.

## Target workflow
1. **Market-data gate:** retrieve completed H1/M15 candles; reject malformed, stale, incomplete, or unavailable data.
2. **Regime and setup:** evaluate trend, structure, support/resistance, momentum, volatility, and opposing-zone clearance. Never force a trade when filters disagree.
3. **Pre-entry candidate:** only create a pending-entry idea when the intended entry is still ahead of current price in the correct direction. Distinguish this from an immediate/market-entry candidate. A lead-time estimate is informational, not guaranteed.
4. **Risk validation:** calculate entry, invalidation-based stop, target, and RR; reject invalid or structurally blocked trades. Do not claim a verified lot size until broker contract/tick-value rules and account-currency conversion are known.
5. **Telegram alert:** clearly label the setup as PENDING, include BUY LIMIT/SELL LIMIT where appropriate, entry/SL/TP, RR, quality score (not win probability), setup reason, timestamp, and expiry/invalidity conditions.
6. **Lifecycle monitoring:** avoid repeated duplicate alerts; track pending, triggered, expired, and invalidated states. Re-check fresh data before sending state-change alerts.
7. **Operator controls:** owner-only pause/resume, emergency stop, risk settings, test notification, recent history, and explicit system/data status.
8. **Validation:** deterministic unit tests, historical walk-forward/backtest with spread/slippage assumptions, paper/signal-only forward testing, and deployment checks before enabling automation.

## Safety and correctness constraints
- No broker orders or real-money execution.
- No claim that a setup is guaranteed to arrive in 20–30 minutes. Price may never reach the level or may reach it sooner.
- Do not notify a pending entry if it is already crossed or no longer valid at the latest verified price.
- Do not use a forming candle for a confirmed setup.
- Daily limits, pause, and emergency stop must apply to automated scanning as well as manual analysis.
- Protect scheduled endpoints with a secret and owner/operational safeguards; never weaken dashboard authentication or deployment protection.
- Use idempotency keys based on symbol, direction, entry zone, and setup/candle identity to suppress duplicate alerts.
- Keep market-data verification distinct from whether the data-provider API key merely exists.
- No profitability or accuracy claims until independently validated.

## Delivery sequence
### Phase 1 — Strategy correctness
- Add deterministic synthetic fixtures for bullish, bearish, neutral, stale/malformed, invalid stop, and blocked-target cases.
- Audit indicator math, pivot confirmation, zone clustering, and candle ordering.
- Make every rejection reason explicit and ensure candidate prices/SL/TP are finite and directionally valid.

### Phase 2 — Pending-entry model
- Define pending-entry conditions separately from immediate entry conditions.
- Add entry status, creation time, last verified price, expiry, invalidation rule, and idempotency identity.
- Add unit tests for entry-ahead-of-price, already-crossed entries, expiry, and invalidation.

### Phase 3 — Monitoring and Telegram
- Implement a protected scan endpoint that shares the same strategy and risk gates as manual analysis.
- Choose and verify a supported scheduler cadence before enabling recurring scans; current Vercel Hobby cron constraints must not be bypassed or assumed away.
- Add lifecycle updates and duplicate suppression; test Telegram delivery failures and retry safety.

### Phase 4 — Evidence before use
- Backtest without look-ahead bias and with realistic spread/slippage assumptions.
- Run signal-only forward testing and report metrics honestly.
- Keep automated order execution out of scope unless separately requested and explicitly reviewed.
