const DEFAULT_STALE_AFTER_MS = 25 * 60 * 1000;

export function getSchedulerHealth(lastRunAt, now = Date.now(), staleAfterMs = DEFAULT_STALE_AFTER_MS) {
  if (!lastRunAt) return { status: "NEVER_RUN", lastRunAt: null, ageMinutes: null };
  const runMs = lastRunAt instanceof Date ? lastRunAt.getTime() : Date.parse(lastRunAt);
  if (!Number.isFinite(runMs) || !Number.isFinite(now) || runMs > now ||
      !Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    return { status: "UNVERIFIED", lastRunAt: null, ageMinutes: null };
  }
  const ageMs = now - runMs;
  return {
    status: ageMs <= staleAfterMs ? "RECENT" : "STALE",
    lastRunAt: new Date(runMs).toISOString(),
    ageMinutes: Math.floor(ageMs / 60000)
  };
}
