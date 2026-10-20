const OUTCOMES = new Set(["WIN", "LOSS", "BREAKEVEN", "NOT_TAKEN", "CANCELLED"]);

export function validateOutcomeInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Outcome payload must be an object." };
  }
  const signalRef = typeof body.signalRef === "string" ? body.signalRef.trim() : "";
  if (!signalRef || signalRef.length > 200) {
    return { ok: false, error: "A valid signal reference is required." };
  }
  const outcome = typeof body.outcome === "string" ? body.outcome.toUpperCase() : "";
  if (!OUTCOMES.has(outcome)) {
    return { ok: false, error: "Unsupported outcome. Choose WIN, LOSS, BREAKEVEN, NOT_TAKEN, or CANCELLED." };
  }
  let realizedR = null;
  if (body.realizedR !== undefined && body.realizedR !== null && body.realizedR !== "") {
    realizedR = Number(body.realizedR);
    if (!Number.isFinite(realizedR) || realizedR < -20 || realizedR > 20) {
      return { ok: false, error: "Realized R must be a finite number between -20 and 20." };
    }
    realizedR = Number(realizedR.toFixed(3));
  }
  if (body.notes !== undefined && typeof body.notes !== "string") {
    return { ok: false, error: "Notes must be plain text." };
  }
  return {
    ok: true,
    value: {
      signalRef,
      outcome,
      realizedR,
      notes: String(body.notes || "").trim().slice(0, 500)
    }
  };
}

function realizedValue(row) {
  if (row.realizedR === null || row.realizedR === undefined || row.realizedR === "") return null;
  const value = Number(row.realizedR);
  return Number.isFinite(value) ? value : null;
}

function performanceRows(rows) {
  return rows.filter((row) => ["WIN", "LOSS", "BREAKEVEN"].includes(row.outcome) && realizedValue(row) !== null);
}

function sessionBucket(value) {
  if (!value) return "Unknown";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Unknown";
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(time)).find((part) => part.type === "hour")?.value);
  if (hour < 8) return "Asia (00–08 WAT)";
  if (hour < 13) return "London (08–13 WAT)";
  if (hour < 22) return "New York (13–22 WAT)";
  return "Late (22–24 WAT)";
}

function qualityBucket(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return "Unknown";
  if (score < 70) return "<70";
  if (score < 80) return "70–79";
  if (score < 90) return "80–89";
  return "90+";
}

function summarizeGroup(rows) {
  const decided = rows.filter((row) => row.outcome === "WIN" || row.outcome === "LOSS");
  const wins = decided.filter((row) => row.outcome === "WIN").length;
  const rRows = performanceRows(rows);
  const rValues = rRows.map(realizedValue);
  const expectancyValues = decided.map(realizedValue).filter((value) => value !== null);
  let cumulativeR = 0, peakR = 0, maxDrawdownR = 0;
  for (const row of rRows) {
    cumulativeR += realizedValue(row);
    peakR = Math.max(peakR, cumulativeR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - cumulativeR);
  }
  return {
    recordedOutcomes: rows.length,
    performanceSampleSize: rRows.length,
    decided: decided.length,
    wins,
    losses: decided.length - wins,
    winRate: decided.length ? Number((wins / decided.length * 100).toFixed(1)) : null,
    netR: Number(rValues.reduce((sum, value) => sum + value, 0).toFixed(3)),
    averageR: rValues.length ? Number((rValues.reduce((sum, value) => sum + value, 0) / rValues.length).toFixed(3)) : null,
    expectancyR: expectancyValues.length ? Number((expectancyValues.reduce((sum, value) => sum + value, 0) / expectancyValues.length).toFixed(3)) : null,
    maxDrawdownR: rRows.length ? Number(maxDrawdownR.toFixed(3)) : null
  };
}

function breakdown(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([key, groupRows]) => ({ key, ...summarizeGroup(groupRows) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function summarizeOutcomes(rows = []) {
  const chronological = rows.slice().sort((a, b) => {
    const left = Date.parse(a.recordedAt || a.signalCreatedAt || "");
    const right = Date.parse(b.recordedAt || b.signalCreatedAt || "");
    return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
  });
  return {
    ...summarizeGroup(chronological),
    bySymbol: breakdown(chronological, (row) => row.symbol || "Unknown"),
    bySession: breakdown(chronological, (row) => sessionBucket(row.signalCreatedAt)),
    byQualityBand: breakdown(chronological, (row) => qualityBucket(row.quality))
  };
}
