import { evaluateNewsWindow, CALENDAR_URL, NEWS_WINDOW_MS } from "../lib/news-filter.js";

const LOOKBACK_MS = 12 * 60 * 60 * 1000;
const LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;

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
      return res.status(502).json({
        ok: false, status: "UNAVAILABLE", blocked: true, events: [],
        reason: `Economic calendar request failed (HTTP ${response.status}). New signals remain blocked if the news check cannot be verified.`,
        checkedAt: now.toISOString(), source: "Fair Economy economic calendar"
      });
    }

    const raw = await response.json();
    const newsStatus = evaluateNewsWindow(raw, now);
    if (!Array.isArray(raw) || raw.length === 0 || !newsStatus.ok) {
      return res.status(502).json({
        ok: false, status: "UNAVAILABLE", blocked: true, events: [],
        reason: newsStatus.reason || "Economic calendar data is empty or invalid.",
        checkedAt: now.toISOString(), source: "Fair Economy economic calendar"
      });
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
    return res.status(502).json({
      ok: false, status: "UNAVAILABLE", blocked: true, events: [],
      reason: error?.name === "AbortError"
        ? "Economic calendar timed out. News status is unknown; new signals remain blocked."
        : "Economic calendar could not be verified. News status is unknown; new signals remain blocked.",
      checkedAt: now.toISOString(), source: "Fair Economy economic calendar"
    });
  } finally {
    clearTimeout(timer);
  }
}
