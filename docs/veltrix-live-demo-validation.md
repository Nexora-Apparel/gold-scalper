# VELTRIX LIVE — Two-Month Demo Validation Protocol

## Purpose

Measure whether the on-device recommendations produce a repeatable, positive net expectancy on an Exness demo account. This protocol does not assume 90% accuracy or profitability.

## Test conditions

- Run for at least 60 calendar days on an Exness demo account.
- Test XAUUSD and XAGUSD separately; only one instrument may be selected at a time.
- Do not change thresholds mid-session. Any strategy change starts a new versioned evaluation period.
- Keep broker execution manual. No automated order placement is enabled.
- Never count a signal as a trade unless the MT5 position is confirmed and journaled.
- Use the same Exness account type and symbol specification intended for later use.

## Required records

- Every BUY/SELL recommendation, including confidence, provider timestamp, spread, volatility regime, M1/M5/M15 context, quote-parity status and rejection reasons.
- Every NO_TRADE state transition and feed failure.
- Every accepted, rejected, ignored or expired recommendation.
- Every manually confirmed MT5 position open and close, including entry, exit, volume and realized R after commission, swap and slippage.
- Every CLOSE_NOW/HOLD_UNVERIFIED recommendation and whether the trader acted.
- Any missed opportunity, duplicate event, stale quote, spread expansion or app interruption.

## Metrics

1. **Directional accuracy:** fraction of recommendations whose predefined evaluation horizon resolves in the predicted direction. Fix the horizon before testing; do not change it after seeing results.
2. **Trade win rate:** profitable settled MT5 positions divided by settled wins plus losses. Report breakevens separately.
3. **Net expectancy:** average realized R after all trading costs.
4. **Profit factor:** gross positive R divided by absolute gross negative R.
5. **Maximum drawdown:** peak-to-trough decline in cumulative realized R.
6. **Exit quality:** realized R compared with the best executable outcome available after the signal, including adverse excursion and missed exit recommendations.
7. **Operational quality:** signal latency, quote age, Exness parity match rate, reconnect time, stale-feed duration and journal-sync completeness.
8. **Segmentation:** report each metric by instrument, trading session, volatility regime and strategy version.

## Stop conditions

Pause the assistant and investigate if any of the following occurs:

- Exness quote parity cannot be maintained or provider and broker quotes diverge.
- Any stale/closed quote is treated as live.
- A signal is produced while the quote-parity gate is closed.
- The Android app loses its foreground service or misses a recorded open position.
- The journal fails to preserve or synchronize an event.
- Spread/commission/slippage makes the strategy's net expectancy negative.
- Drawdown exceeds a pre-agreed demo risk limit.

## Review gates

- **Day 14:** inspect data completeness, feed stability, OCR accuracy and journal reconciliation. No profitability conclusion.
- **Day 30:** review directional accuracy, settled-trade metrics and risk by instrument/session. Change strategy only by creating a new version.
- **Day 60 or later:** evaluate sample size, confidence intervals, net expectancy, drawdown and operational reliability. Do not promote to live solely because a headline accuracy percentage is high.

## Acceptance criteria before any live consideration

- At least 60 days of uninterrupted, auditable demo records.
- All position outcomes reconciled with the Exness MT5 history.
- Positive net expectancy after realistic costs, with acceptable drawdown.
- No unresolved critical feed, quote-parity, journal or position-tracking defects.
- Performance stable across more than one market condition and not dependent on one exceptional session.
- A separate explicit decision to enable any future broker execution bridge. The current system remains manual-only.

