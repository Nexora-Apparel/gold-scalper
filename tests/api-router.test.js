import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import handler, { API_ROUTE_NAMES } from "../api/index.js";

const rewrites = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).rewrites;

test("every public API path has exactly one dispatcher rewrite", () => {
  const rewriteMap = new Map(rewrites.map(({ source, destination }) => [
    source.replace(/^\/api\//, ""),
    destination.split("?route=")[1]
  ]));
  assert.equal(rewriteMap.size, API_ROUTE_NAMES.length);
  for (const route of API_ROUTE_NAMES) assert.equal(rewriteMap.get(route), route);
});

test("dispatcher rejects unknown routes without invoking a handler", async () => {
  const headers = {};
  const response = {
    statusCode: 200,
    setHeader(name, value) { headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  await handler({ query: { route: "not-a-real-route" } }, response);
  assert.equal(response.statusCode, 404);
  assert.equal(response.payload.ok, false);
  assert.equal(headers["Cache-Control"], "no-store");
});

test("dispatcher routes known paths to the original handler contract", async () => {
  const response = {
    statusCode: 200,
    setHeader(name, value) { this.headers ??= {}; this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
  await handler({ method: "GET", query: { route: "login" } }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, "POST");
});
