const SUPPORTED = new Set(["XAUUSD", "XAGUSD"]);
const HORIZONS_SECONDS = Object.freeze([5, 15, 30, 60]);

function finitePrice(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parseExplicitTimestamp(value) {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$/i.test(value)) return NaN;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return NaN;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return NaN;
  return timestamp;
}

function lowerBound(ticks, target, start = 0) {
  let low = start, high = ticks.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ticks[middle].timestamp < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function normalizeTape(quotes, expectedSymbol) {
  if (!Array.isArray(quotes) || quotes.length < 2) throw new Error("A tick tape with at least two quotes is required.");
  const normalized = [];
  let previousTime = -Infinity;
  let provider = null;
  for (const [index, item] of quotes.entries()) {
    if (item?.dataKind !== "tick") throw new Error("Historical replay accepts tick data only; OHLC bars cannot reproduce intrahorizon execution.");
    const symbol = String(item?.symbol || "").toUpperCase();
    if (!SUPPORTED.has(symbol) || symbol !== expectedSymbol) throw new Error("Tick tape contains an unsupported or mismatched symbol.");
    if (typeof item.provider !== "string" || !item.provider.trim()) throw new Error("Every tick must identify its provider.");
    if (provider === null) provider = item.provider;
    if (provider !== item.provider) throw new Error("A replay tape cannot mix market-data providers.");
    const timestampText = item.timestamp;
    const timestamp = typeof timestampText === "string" && /(Z|[+-]\d{2}:?\d{2})$/i.test(timestampText)
      ? Date.parse(timestampText) : NaN;
    const bid = item.bid, ask = item.ask;
    if (!Number.isFinite(timestamp) || timestamp <= previousTime) throw new Error("Tick timestamps must be timezone-explicit, unique and strictly chronologically ordered.");
    if (!finitePrice(bid) || !finitePrice(ask) || ask <= bid) throw new Error("Tick tape contains an invalid Bid/Ask quote.");
    normalized.push({ timestamp, bid, ask });
    previousTime = timestamp;
  }
  return { ticks: normalized, provider };
}

function executableMove(side, entryPrice, quote) {
  return side === "BUY" ? quote.bid - entryPrice : entryPrice - quote.ask;
}

export function replayScalpingSignals({
  symbol,
  quotes,
  signals,
  horizonsSeconds = HORIZONS_SECONDS,
  maxEntryDelayMs = 1500,
  maxExitWaitMs = 1500
} = {}) {
  const market = String(symbol || "").toUpperCase();
  if (!SUPPORTED.has(market)) throw new Error("Replay symbol must be XAUUSD or XAGUSD.");
  if (!Array.isArray(signals)) throw new Error("signals must be an array.");
  if (!Array.isArray(horizonsSeconds) || !horizonsSeconds.length ||
      horizonsSeconds.some((value) => !Number.isInteger(value) || value <= 0 || value > 3600)) {
    throw new Error("Replay horizons must be positive integer seconds up to one hour.");
  }
  if (!Number.isInteger(maxEntryDelayMs) || maxEntryDelayMs < 0 ||
      !Number.isInteger(maxExitWaitMs) || maxExitWaitMs < 0) {
    throw new Error("Replay quote-wait limits must be non-negative integer milliseconds.");
  }
  const { ticks, provider } = normalizeTape(quotes, market);
  const results = [];
  const skipped = {};
  const countSkip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };

  for (const signal of signals) {
    const side = signal?.side;
    const signalTime = parseExplicitTimestamp(signal?.timestamp);
    if (String(signal?.symbol || "").toUpperCase() !== market ||
        !["BUY", "SELL"].includes(side) || !Number.isFinite(signalTime)) {
      countSkip("invalid_signal");
      continue;
    }
    const entryIndex = lowerBound(ticks, signalTime);
    if (entryIndex < 0 || ticks[entryIndex].timestamp - signalTime > maxEntryDelayMs) {
      countSkip("entry_quote_unavailable");
      continue;
    }
    const entry = ticks[entryIndex];
    const entryPrice = side === "BUY" ? entry.ask : entry.bid;

    for (const horizonSeconds of horizonsSeconds) {
      const targetTime = entry.timestamp + horizonSeconds * 1000;
      const exitIndex = lowerBound(ticks, targetTime, entryIndex + 1);
      if (exitIndex >= ticks.length || ticks[exitIndex].timestamp - targetTime > maxExitWaitMs) {
        countSkip("exit_quote_unavailable_" + horizonSeconds + "s");
        continue;
      }
      const exit = ticks[exitIndex];
      const exitPrice = side === "BUY" ? exit.bid : exit.ask;
      const move = executableMove(side, entryPrice, exit);
      let maxFavourableMove = -Infinity;
      let maxAdverseMove = Infinity;
      for (let i = entryIndex + 1; i <= exitIndex; i += 1) {
        const excursion = executableMove(side, entryPrice, ticks[i]);
        maxFavourableMove = Math.max(maxFavourableMove, excursion);
        maxAdverseMove = Math.min(maxAdverseMove, excursion);
      }
      results.push({
        signalId: typeof signal.id === "string" ? signal.id : null,
        symbol: market,
        side,
        horizonSeconds,
        provider,
        dataKind: "tick",
        entryTimestamp: new Date(entry.timestamp).toISOString(),
        exitTimestamp: new Date(exit.timestamp).toISOString(),
        entryPrice,
        exitPrice,
        movePriceUnits: Number(move.toFixed(10)),
        maxFavourableMovePriceUnits: Number(maxFavourableMove.toFixed(10)),
        maxAdverseMovePriceUnits: Number(maxAdverseMove.toFixed(10)),
        outcome: move > 0 ? "WIN" : move < 0 ? "LOSS" : "FLAT",
        costsIncluded: "Bid/Ask spread embedded; commission, slippage and latency beyond quote timestamps are not modelled."
      });
    }
  }

  const summary = horizonsSeconds.map((horizonSeconds) => {
    const rows = results.filter((row) => row.horizonSeconds === horizonSeconds);
    const wins = rows.filter((row) => row.outcome === "WIN").length;
    const losses = rows.filter((row) => row.outcome === "LOSS").length;
    const flats = rows.filter((row) => row.outcome === "FLAT").length;
    const totalMove = rows.reduce((sum, row) => sum + row.movePriceUnits, 0);
    return {
      horizonSeconds,
      evaluated: rows.length,
      wins,
      losses,
      flats,
      hitRatePercent: wins + losses ? Number((wins / (wins + losses) * 100).toFixed(2)) : null,
      meanMovePriceUnits: rows.length ? Number((totalMove / rows.length).toFixed(10)) : null
    };
  });

  const summaryBySide = ["BUY", "SELL"].flatMap((side) => horizonsSeconds.map((horizonSeconds) => {
    const rows = results.filter((row) => row.side === side && row.horizonSeconds === horizonSeconds);
    const wins = rows.filter((row) => row.outcome === "WIN").length;
    const losses = rows.filter((row) => row.outcome === "LOSS").length;
    const flats = rows.filter((row) => row.outcome === "FLAT").length;
    return {
      side,
      horizonSeconds,
      evaluated: rows.length,
      wins,
      losses,
      flats,
      hitRatePercent: wins + losses ? Number((wins / (wins + losses) * 100).toFixed(2)) : null,
      meanMovePriceUnits: rows.length ? Number((rows.reduce((sum, row) => sum + row.movePriceUnits, 0) / rows.length).toFixed(10)) : null
    };
  }));

  return Object.freeze({
    symbol: market,
    provider,
    dataKind: "tick",
    signalsReceived: signals.length,
    evaluatedRows: results.length,
    skippedSignalsOrHorizons: Object.values(skipped).reduce((sum, count) => sum + count, 0),
    skipped,
    summary,
    summaryBySide,
    results,
    validationNotice: "Historical replay is a research estimate, not proof of live fill quality or future performance."
  });
}
