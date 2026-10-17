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

export function summarizeOutcomes(rows = []) {
  const decided = rows.filter((row) => row.outcome === "WIN" || row.outcome === "LOSS");
  const wins = decided.filter((row) => row.outcome === "WIN").length;
  const losses = decided.length - wins;
  const values = rows.map((row) => Number(row.realizedR)).filter(Number.isFinite);
  return {
    decided: decided.length,
    wins,
    losses,
    winRate: decided.length ? Number((wins / decided.length * 100).toFixed(1)) : null,
    netR: Number(values.reduce((sum, value) => sum + value, 0).toFixed(3))
  };
}
