import { evaluateNewsWindow, CALENDAR_URL, NEWS_WINDOW_MS } from "../lib/news-filter.js";

const LOOKBACK_MS = 12 * 60 * 60 * 1000;
const LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_CALENDAR_URL = "https://www.financecalendar.com/wp-json/fc/v1/calendar";

function normalizeFallbackEvents(payload, now) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.events) ? payload.events : [];
  const nowMs = now.getTime();
  return rows.map((event) => {
    if (!event || typeof event !== "object") return null;
    const currency = String(event.country ?? event.currency ?? event.currency_code ?? event.currencyCode ?? "").toUpperCase();
    const rawTime = event.time_utc ?? event.datetime ?? event.dateTime ?? event.date ?? event.time ?? "";
    const parsedTime = Date.parse(rawTime);
    const title = event.title ?? event.name ?? event.event ?? event.release ?? "";
    const impact = String(event.impact ?? event.importance ?? "").toLowerCase();
    if (currency !== "USD" || typeof title !== "string" || !title.trim() ||
        !Number.isFinite(parsedTime) || !["high", "medium"].includes(impact)) return null;
    return {
      title: title.trim(),
      country: "USD",
      impact,
      time: new Date(parsedTime).toISOString(),
      actual: event.actual ?? null,
      forecast: event.forecast ?? event.consensus ?? null,
      previous: event.previous ?? event.prior ?? null,
      unit: event.unit ?? null
    };
  }).filter((event) => event && Date.parse(event.time) >= nowMs - LOOKBACK_MS &&
      Date.parse(event.time) <= nowMs + LOOKAHEAD_MS)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

async function loadFallbackEvents(now) {
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + LOOKAHEAD_MS).toISOString().slice(0, 10);
  const url = `${FALLBACK_CALENDAR_URL}?from=${from}&to=${to}&limit=500`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store"
    });
    if (!response.ok) return [];
    return normalizeFallbackEvents(await response.json(), now);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function unavailableResponse(res, now, reason, events = [], source = "Fair Economy economic calendar unavailable") {
  // Fallback events are informational only. The primary safety check remains
  // UNAVAILABLE/blocked until the configured trusted calendar verifies.
  return res.status(200).json({
    ok: false, status: "UNAVAILABLE", blocked: true, events,
    reason: `${reason} New signals remain blocked until the primary calendar is verified.`,
    checkedAt: now.toISOString(),
    source,
    note: events.length
      ? "Upcoming events are informational fallback data only; they do not clear the trading news filter. Source: FinanceCalendar.com."
      : "No fallback events could be loaded. Do not interpret this as no news."
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, status: "UNAVAILABLE", error: "Method not allowed" });
  }

  const now = new Date();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(CALENDAR_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store"
    });
    if (!response.ok) {
      const fallbackEvents = await loadFallbackEvents(now);
      return unavailableResponse(res, now,
        `Primary economic calendar request failed (HTTP ${response.status}).`,
        fallbackEvents,
        fallbackEvents.length ? "Fair Economy unavailable · FinanceCalendar fallback (display only)" : "Fair Economy economic calendar unavailable");
    }

    const raw = await response.json();
    const newsStatus = evaluateNewsWindow(raw, now);
    if (!Array.isArray(raw) || raw.length === 0 || !newsStatus.ok) {
      const fallbackEvents = await loadFallbackEvents(now);
      return unavailableResponse(res, now,
        newsStatus.reason || "Primary economic calendar data is empty or invalid.",
        fallbackEvents,
        fallbackEvents.length ? "Fair Economy unavailable · FinanceCalendar fallback (display only)" : "Fair Economy economic calendar unavailable");
    }

    const nowMs = now.getTime();
    const events = raw
      .filter((event) => event && typeof event.title === "string" &&
        typeof event.country === "string" && typeof event.impact === "string" &&
        typeof event.date === "string" && Number.isFinite(Date.parse(event.date)))
      .filter((event) => event.country.toUpperCase() === "USD" &&
        ["high", "medium"].includes(event.impact.toLowerCase()))
      .map((event) => ({
        title: event.title,
        country: event.country.toUpperCase(),
        impact: event.impact.toLowerCase(),
        time: new Date(event.date).toISOString(),
        actual: event.actual ?? null,
        forecast: event.forecast ?? null,
        previous: event.previous ?? null,
        unit: event.unit ?? null
      }))
      .filter((event) => {
        const t = Date.parse(event.time);
        return t >= nowMs - LOOKBACK_MS && t <= nowMs + LOOKAHEAD_MS;
      })
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

    return res.status(200).json({
      ok: true,
      status: newsStatus.status,
      blocked: newsStatus.blocked,
      reason: newsStatus.reason,
      activeEvent: newsStatus.event || null,
      blockWindowMinutes: NEWS_WINDOW_MS / 60000,
      events,
      checkedAt: now.toISOString(),
      source: "Fair Economy economic calendar",
      note: "Scheduled USD economic releases only; this is not a live geopolitical or breaking-news headline feed."
    });
  } catch (error) {
    const fallbackEvents = await loadFallbackEvents(now);
    return unavailableResponse(res, now,
      error?.name === "AbortError" ? "Primary economic calendar timed out." : "Primary economic calendar could not be verified.",
      fallbackEvents,
      fallbackEvents.length ? "Fair Economy unavailable · FinanceCalendar fallback (display only)" : "Fair Economy economic calendar unavailable");
  } finally {
    clearTimeout(timer);
  }
}
