const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const NEWS_WINDOW_MS = 30 * 60 * 1000;

function eventTime(value) {
  if (typeof value !== "string" || !value.trim()) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function evaluateNewsWindow(events, now = new Date()) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, blocked: true, status: "UNAVAILABLE", reason: "Economic calendar is empty or malformed; fail-closed news protection blocked new signals." };
  }

  const normalized = [];
  for (const event of events) {
    if (!event || typeof event !== "object" ||
        typeof event.title !== "string" ||
        typeof event.country !== "string" ||
        typeof event.impact !== "string" ||
        typeof event.date !== "string" ||
        !Number.isFinite(eventTime(event.date))) {
      return { ok: false, blocked: true, status: "UNAVAILABLE", reason: "Economic calendar contains an invalid event; fail-closed news protection blocked new signals." };
    }
    normalized.push({
      title: event.title,
      country: event.country.toUpperCase(),
      impact: event.impact.toLowerCase(),
      time: eventTime(event.date)
    });
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) {
    return { ok: false, blocked: true, status: "UNAVAILABLE", reason: "Current time is invalid; fail-closed news protection blocked new signals." };
  }
  const event = normalized
    .filter((item) => item.country === "USD" && item.impact === "high" &&
      Math.abs(item.time - nowMs) <= NEWS_WINDOW_MS)
    .sort((a, b) => Math.abs(a.time - nowMs) - Math.abs(b.time - nowMs))[0];

  if (event) {
    return {
      ok: true, blocked: true, status: "BLOCKED",
      reason: `High-impact USD event window: ${event.title} is within 30 minutes of its scheduled time.`,
      event: { title: event.title, time: new Date(event.time).toISOString() }
    };
  }
  return { ok: true, blocked: false, status: "CLEAR", reason: "No high-impact USD event is within the 30-minute pre/post news block." };
}

export async function getNewsStatus({ now = new Date(), fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetchImpl(CALENDAR_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store"
    });
    if (!response.ok) {
      return { ok: false, blocked: true, status: "UNAVAILABLE", reason: `Economic calendar request failed (HTTP ${response.status}); fail-closed news protection blocked new signals.` };
    }
    const events = await response.json();
    return evaluateNewsWindow(events, now);
  } catch (error) {
    return {
      ok: false, blocked: true, status: "UNAVAILABLE",
      reason: error?.name === "AbortError"
        ? "Economic calendar timed out; fail-closed news protection blocked new signals."
        : "Economic calendar could not be verified; fail-closed news protection blocked new signals."
    };
  } finally {
    clearTimeout(timer);
  }
}

export { CALENDAR_URL, NEWS_WINDOW_MS };
