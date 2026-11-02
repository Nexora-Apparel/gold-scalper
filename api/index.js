import analyze from "../api-handlers/analyze.js";
import biquoteQuotes from "../api-handlers/biquote-quotes.js";
import brokerQuoteObservation from "../api-handlers/broker-quote-observation.js";
import control from "../api-handlers/control.js";
import login from "../api-handlers/login.js";
import marketData from "../api-handlers/market-data.js";
import news from "../api-handlers/news.js";
import outcomes from "../api-handlers/outcomes.js";
import scalpingEvents from "../api-handlers/scalping-events.js";
import schedulerDispatch from "../api-handlers/scheduler-dispatch.js";
import settings from "../api-handlers/settings.js";
import status from "../api-handlers/status.js";

const ROUTES = Object.freeze({
  analyze,
  "biquote-quotes": biquoteQuotes,
  "broker-quote-observation": brokerQuoteObservation,
  control,
  login,
  "market-data": marketData,
  news,
  outcomes,
  "scalping-events": scalpingEvents,
  "scheduler-dispatch": schedulerDispatch,
  settings,
  status
});

export const API_ROUTE_NAMES = Object.freeze(Object.keys(ROUTES));

export default async function handler(req, res) {
  const routeValue = req.query?.route;
  const route = Array.isArray(routeValue) ? routeValue[0] : routeValue;
  const target = typeof route === "string" ? ROUTES[route] : null;

  if (!target) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).json({ ok: false, error: "Unknown API route." });
  }

  return target(req, res);
}
