import { API_ROUTE_NAMES } from "../api/index.js";

const rawBase = process.env.VELTRIX_SMOKE_BASE_URL;
if (!rawBase) {
  console.error("Set VELTRIX_SMOKE_BASE_URL to the deployed preview or production origin.");
  process.exit(2);
}
const base = new URL(rawBase);
if (!["https:", "http:"].includes(base.protocol)) {
  console.error("VELTRIX_SMOKE_BASE_URL must use HTTP or HTTPS.");
  process.exit(2);
}

const results = await Promise.all(API_ROUTE_NAMES.map(async (route) => {
  const url = new URL(`/api/${route}`, base);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10000)
    });
    const accepted = response.status !== 404 && response.status < 500;
    return {
      route,
      status: response.status,
      result: accepted ? (response.status === 503 ? "DEGRADED" : "REACHABLE") : "FAILED"
    };
  } catch (error) {
    return { route, status: null, result: "FAILED", error: error?.message || "request failed" };
  }
}));

for (const result of results) {
  const detail = result.error ? ` · ${result.error}` : "";
  console.log(`[${result.result}] GET /api/${result.route} → ${result.status ?? "NETWORK_ERROR"}${detail}`);
}
const failed = results.filter(result => result.result === "FAILED");
const degraded = results.filter(result => result.result === "DEGRADED");
console.log(`\n${results.length - failed.length} reachable, ${degraded.length} degraded, ${failed.length} failed.`);
if (failed.length) process.exit(1);
