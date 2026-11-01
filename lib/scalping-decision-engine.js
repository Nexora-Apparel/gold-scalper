const MIN_CONFIDENCE = 0.72;

/**
 * Conservative tick-scalping decision layer.
 * It emits a directional recommendation only when market-quality gates,
 * short/context momentum and microstructure pressure agree. It is not an
 * order router and cannot place trades.
 */
export function evaluateScalpingDecision({
  marketState,
  quote,
  microstructure,
  structure,
  now = Date.now(),
  minConfidence = MIN_CONFIDENCE,
  maxSpread = null
} = {}) {
  const reasons = [];
  const symbol = marketState?.symbol;
  const spread = Number(quote?.spread);
  if (!marketState?.ready) reasons.push(...(marketState?.reasons?.length ? marketState.reasons : ["market_quality_not_ready"]));
  if (!["XAUUSD", "XAGUSD"].includes(symbol)) reasons.push("unsupported_symbol");
  if (maxSpread !== null && Number.isFinite(maxSpread) && spread > maxSpread) reasons.push("spread_above_absolute_limit");
  if (marketState?.volatilityRegime === "SPIKE") reasons.push("volatility_spike");
  const direction = marketState?.momentumDirection;
  if (!["UP", "DOWN"].includes(direction)) reasons.push("momentum_not_aligned");

  const pressure = Number(microstructure?.pressure);
  const tickRate = Number(microstructure?.ticksPerSecond);
  if (!Number.isFinite(pressure) || Math.abs(pressure) < 0.15) reasons.push("directional_tick_pressure_insufficient");
  if (!Number.isFinite(tickRate) || tickRate <= 0) reasons.push("tick_activity_unavailable");

  const structureDirection = structure?.direction;
  if (!["UP", "DOWN"].includes(structureDirection)) reasons.push("short_term_structure_unconfirmed");
  if (structureDirection !== direction) reasons.push("structure_momentum_conflict");

  const pressureDirection = pressure > 0 ? "UP" : pressure < 0 ? "DOWN" : "FLAT";
  if (pressureDirection !== direction) reasons.push("directional_tick_pressure_conflict");

  const momentumStrength = Math.min(1, Math.abs(Number(marketState?.shortMovePercent) || 0) / 0.03);
  const contextStrength = Math.min(1, Math.abs(Number(marketState?.contextMovePercent) || 0) / 0.03);
  const pressureStrength = Math.min(1, Math.abs(Number.isFinite(pressure) ? pressure : 0));
  const structureStrength = Number.isFinite(structure?.strength)
    ? Math.max(0, Math.min(1, structure.strength)) : 0;
  const confidence = Number((
    momentumStrength * 0.30 +
    contextStrength * 0.20 +
    pressureStrength * 0.25 +
    structureStrength * 0.25
  ).toFixed(3));

  if (confidence < minConfidence) reasons.push("confidence_below_threshold");
  const eligible = reasons.length === 0;
  return Object.freeze({
    symbol: ["XAUUSD", "XAGUSD"].includes(symbol) ? symbol : null,
    action: eligible ? (direction === "UP" ? "BUY_NOW" : "SELL_NOW") : "NO_TRADE",
    side: eligible ? direction : null,
    confidence,
    pressureSource: "directional_tick_imbalance_proxy_not_order_flow",
    reasons: Object.freeze([...new Set(reasons)]),
    volatilityRegime: marketState?.volatilityRegime || "UNKNOWN",
    spread: Number.isFinite(spread) ? spread : null,
    evaluatedAt: new Date(now).toISOString(),
    executionEnabled: false,
    requiresManualMT5Confirmation: eligible
  });
}

export function evaluateDynamicExit({
  position,
  quote,
  marketState,
  microstructure,
  now = Date.now(),
  maxQuoteAgeMs = 1500
} = {}) {
  const side = position?.side;
  const entry = Number(position?.entryPrice);
  const bid = Number(quote?.bid), ask = Number(quote?.ask);
  const timestamp = Date.parse(quote?.timestamp);
  const age = Number.isFinite(timestamp) ? now - timestamp : Infinity;
  if (!["BUY", "SELL"].includes(side) || !(entry > 0) ||
      !(bid > 0 && ask > bid) || age < -1000 || age > maxQuoteAgeMs) {
    return { action: "HOLD_UNVERIFIED", reason: "Position or live quote is invalid/stale; refresh MT5 manually.", executionEnabled: false };
  }
  const exitPrice = side === "BUY" ? bid : ask;
  const move = side === "BUY" ? exitPrice - entry : entry - exitPrice;
  const adversePressure = Number(microstructure?.pressure);
  const opposite = side === "BUY" ? "DOWN" : "UP";
  if (marketState?.volatilityRegime === "SPIKE") {
    return { action: "CLOSE_NOW", reason: "Volatility spike detected; protect the open position.", indicativeExitPrice: exitPrice, move, executionEnabled: false };
  }
  if (marketState?.momentumDirection === opposite &&
      Number.isFinite(adversePressure) &&
      (side === "BUY" ? adversePressure < -0.35 : adversePressure > 0.35)) {
    return { action: "CLOSE_NOW", reason: "Momentum and microstructure pressure have reversed against the position.", indicativeExitPrice: exitPrice, move, executionEnabled: false };
  }
  return { action: "HOLD", reason: "No validated emergency exit condition.", indicativeExitPrice: exitPrice, move, executionEnabled: false };
}
