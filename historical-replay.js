import { listArchives, exportArchive } from "./tick-archive.js";
import { replayScalpingSignals } from "./lib/scalping-historical-replay.js";
import { parseHistoricalSignalLog } from "./lib/scalping-signal-dataset.js";

const $ = (id) => document.getElementById(id);
const status = $("replayStatus");
const archiveSelect = $("archiveSelect");
const signalFile = $("signalFile");
const runButton = $("runReplay");
const report = $("replayReport");
const HORIZONS = [5, 15, 30, 60];
let selectedArchive = null;
let lastReport = null;
let journalSignalBundle = null;

function message(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}
function partitionQuotes(quotes, start, end) {
  return quotes.filter((q) => {
    const t = Date.parse(q.timestamp);
    return t >= Date.parse(start) && t <= Date.parse(end);
  });
}
function partitionSignals(signals, start, end) {
  const a = Date.parse(start), b = Date.parse(end);
  return signals.filter((s) => s.timestampMs >= a && s.timestampMs <= b);
}
function addCell(row, value, header = false) {
  const cell = document.createElement(header ? "th" : "td");
  cell.textContent = value == null ? "—" : String(value);
  row.append(cell);
}
function renderTable(container, headings, rows) {
  const table = document.createElement("table");
  const thead = document.createElement("thead"), header = document.createElement("tr");
  headings.forEach((h) => addCell(header, h, true)); thead.append(header); table.append(thead);
  const tbody = document.createElement("tbody");
  rows.forEach((values) => { const tr = document.createElement("tr"); values.forEach((v) => addCell(tr, v)); tbody.append(tr); });
  table.append(tbody); container.append(table);
}
function renderReport(result) {
  report.replaceChildren();
  const meta = document.createElement("p");
  meta.className = "notice";
  meta.textContent = result.archive.symbol + " · " + result.archive.provider + " · " + result.archive.tickCount.toLocaleString() + " ticks · " + result.signalCount + " imported signals · " + result.signalSource;
  report.append(meta);
  const confidenceNote = document.createElement("p");
  confidenceNote.className = "notice";
  confidenceNote.textContent = "Hit-rate confidence intervals use the Wilson 95% method and exclude flat outcomes. Small samples produce wide intervals; always inspect decisive sample counts."; 
  report.append(confidenceNote);
  for (const [name, data] of Object.entries(result.partitions)) {
    const section = document.createElement("section");
    section.className = "partition";
    const title = document.createElement("h3");
    title.textContent = name + " · " + data.quoteCount.toLocaleString() + " quotes · " + data.signalCount.toLocaleString() + " signals";
    section.append(title);
    renderTable(section, ["Horizon", "Evaluated", "Gross wins", "Gross hit", "Gross 95% CI", "Mean gross", "Net evaluated", "Net wins", "Net hit", "Net 95% CI", "Mean net"],
      data.summary.map((r) => [r.horizonSeconds + "s", r.evaluated, r.wins, r.hitRatePercent == null ? "—" : r.hitRatePercent + "%", r.hitRate95CI ? r.hitRate95CI.lowerPercent + "–" + r.hitRate95CI.upperPercent + "%" : "—", r.meanMovePriceUnits, r.netEvaluated, r.netWins, r.netHitRatePercent == null ? "—" : r.netHitRatePercent + "%", r.netHitRate95CI ? r.netHitRate95CI.lowerPercent + "–" + r.netHitRate95CI.upperPercent + "%" : "—", r.meanNetMovePriceUnits]));
    renderTable(section, ["Side", "Horizon", "Evaluated", "Gross hit", "Gross 95% CI", "Mean gross", "Net evaluated", "Net hit", "Net 95% CI", "Mean net"],
      data.summaryBySide.map((r) => [r.side, r.horizonSeconds + "s", r.evaluated, r.hitRatePercent == null ? "—" : r.hitRatePercent + "%", r.hitRate95CI ? r.hitRate95CI.lowerPercent + "–" + r.hitRate95CI.upperPercent + "%" : "—", r.meanMovePriceUnits, r.netEvaluated, r.netHitRatePercent == null ? "—" : r.netHitRatePercent + "%", r.netHitRate95CI ? r.netHitRate95CI.lowerPercent + "–" + r.netHitRate95CI.upperPercent + "%" : "—", r.meanNetMovePriceUnits]));
    const skipped = document.createElement("p");
    skipped.className = "notice";
    skipped.textContent = "Skipped signals/horizons: " + data.skippedSignalsOrHorizons + " · " + JSON.stringify(data.skipped);
    section.append(skipped);
    report.append(section);
  }
  const boundary = document.createElement("p");
  boundary.className = "warning";
  boundary.textContent = "Research estimate only. Bid/Ask spread is embedded in executable-side entry/exit prices. " + (result.costModel.roundTripAdditionalCostPriceUnits === null ? "Additional commission/slippage costs were not supplied, so net results are unavailable. " : "The manually supplied additional round-trip cost of " + result.costModel.roundTripAdditionalCostPriceUnits + " price units was deducted; this is an estimate, not a broker-verified cost. ") + "Execution latency, partial fills and Exness fill parity are not modelled. Do not treat hit rate as validated live accuracy or profitability.";
  report.append(boundary);
}
async function loadArchives() {
  const archives = await listArchives();
  archiveSelect.replaceChildren();
  if (!archives.length) {
    selectedArchive = null;
    journalSignalBundle = null;
    const option = document.createElement("option"); option.textContent = "No local tick archives"; option.value = ""; archiveSelect.append(option);
    runButton.disabled = true; return;
  }
  for (const item of archives) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.manifest.symbol + " · " + item.manifest.provider + " · " + item.manifest.tickCount.toLocaleString() + " ticks · " + item.manifest.startAt.slice(0, 10);
    archiveSelect.append(option);
  }
  selectedArchive = await exportArchive(archiveSelect.value);
  journalSignalBundle = null;
  runButton.disabled = false;
}
archiveSelect.addEventListener("change", async () => {
  journalSignalBundle = null;
  selectedArchive = await exportArchive(archiveSelect.value);
  message(selectedArchive ? "Selected immutable local archive " + archiveSelect.value.slice(0, 16) + "…" : "Archive unavailable.", !selectedArchive);
});
$("refreshArchives").addEventListener("click", () => loadArchives().then(() => message("Archive list refreshed.")).catch((e) => message(e.message, true)));
signalFile.addEventListener("change", () => { journalSignalBundle = null; });
$("loadJournalSignals").addEventListener("click", async () => {
  try {
    if (!selectedArchive) throw new Error("Select a validated tick archive first.");
    const m = selectedArchive.manifest;
    message("Loading genuine SIGNAL events from the authenticated journal…");
    const query = new URLSearchParams({ type: "SIGNAL", symbol: m.symbol, from: m.startAt, to: m.endAt, limit: "1000" });
    const response = await fetch("/api/scalping-events?" + query.toString(), { credentials: "same-origin", cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Signal journal request failed (HTTP " + response.status + "). Sign in to the dashboard first.");
    if (body.truncated) throw new Error("The journal returned more than 1,000 signals for this archive. Narrow the archive period before replay; partial signal histories are not accepted.");
    const candidateEvents = body.events || [];
    const signals = candidateEvents.filter((event) =>
      (event.side === "BUY" || event.side === "SELL") &&
      event.payload?.provider === "biquote" &&
      event.payload?.signalQuoteSource === "mt5_screen_ocr" &&
      event.payload?.mt5ReferenceQuoteVerification === "MATCHED" &&
      typeof event.payload?.tickTimestamp === "string"
    ).map((event) => ({ id: event.eventId, timestamp: event.payload.tickTimestamp, symbol: event.symbol, side: event.side, provider: "biquote" }));
    if (!signals.length) throw new Error("No broker-matched BUY/SELL SIGNAL events were found in this period. Unverified or reference-only signals are excluded.");
    journalSignalBundle = { metadata: { sourceReference: "authenticated_veltrix_scalping_events:" + m.symbol + ":" + m.startAt + ":" + m.endAt, strategy: "mobile_scalping_engine", provider: "biquote" }, signals };
    signalFile.value = "";
    message("Loaded " + signals.length + " recorded signals from the authenticated journal. These are original engine events, not generated replay inputs.");
  } catch (error) { journalSignalBundle = null; message(error.message || "Signal journal load failed.", true); }
});
$("runReplay").addEventListener("click", async () => {
  try {
    if (!selectedArchive) throw new Error("Import a tick archive first.");
    const file = signalFile.files[0];
    if (!file && !journalSignalBundle) throw new Error("Load recorded journal signals or import a timestamped signal log. The replay does not invent BUY/SELL signals.");
    if (file && file.size > 5 * 1024 * 1024) throw new Error("Signal log exceeds the 5 MB limit.");
    runButton.disabled = true;
    message("Validating signal provenance and running isolated chronological replays…");
    const signalText = file ? await file.text() : JSON.stringify(journalSignalBundle);
    const parsed = parseHistoricalSignalLog({ name: file ? file.name : "journal.json", text: signalText, expectedSymbol: selectedArchive.manifest.symbol });
    if (parsed.metadata.provider && !selectedArchive.manifest.provider.toLowerCase().includes(parsed.metadata.provider.toLowerCase())) {
      throw new Error("Signal source provider and tick archive provider do not match; cross-provider replay is blocked.");
    }
    const signalDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signalText));
    const signalFileSha256 = [...new Uint8Array(signalDigest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const costText = $("roundTripCost").value.trim();
    const roundTripAdditionalCostPriceUnits = costText === "" ? null : Number(costText);
    if (roundTripAdditionalCostPriceUnits !== null && (!Number.isFinite(roundTripAdditionalCostPriceUnits) || roundTripAdditionalCostPriceUnits < 0)) {
      throw new Error("Additional round-trip cost must be a finite non-negative quote price-unit value.");
    }
    const manifest = selectedArchive.manifest;
    const partitions = {};
    for (const key of ["train", "validation", "heldOutTest"]) {
      const bounds = manifest.partitions[key];
      const quotes = partitionQuotes(selectedArchive.quotes, bounds.startAt, bounds.endAt);
      const signals = partitionSignals(parsed.signals, bounds.startAt, bounds.endAt);
      const result = replayScalpingSignals({
        symbol: manifest.symbol,
        quotes,
        signals,
        horizonsSeconds: HORIZONS,
        maxEntryDelayMs: 1500,
        maxExitWaitMs: 1500,
        roundTripAdditionalCostPriceUnits
      });
      partitions[key] = { quoteCount: quotes.length, signalCount: signals.length, summary: result.summary, summaryBySide: result.summaryBySide, skippedSignalsOrHorizons: result.skippedSignalsOrHorizons, skipped: result.skipped, results: result.results };
    }
    lastReport = {
      reportType: "veltrix_chronological_tick_replay_v1",
      generatedAt: new Date().toISOString(),
      archive: { id: archiveSelect.value, ...manifest },
      signalSource: parsed.metadata.sourceReference,
      signalFileSha256,
      strategy: parsed.metadata.strategy,
      signalCount: parsed.signals.length,
      splitMethod: manifest.splitMethod,
      costModel: { roundTripAdditionalCostPriceUnits, includesBidAskSpread: false },
      partitions
    };
    renderReport(lastReport);
    message("Replay complete. Training, validation and held-out test periods were processed separately.");
  } catch (error) {
    message(error.message || "Replay failed.", true);
  } finally { runButton.disabled = false; }
});
$("exportReplay").addEventListener("click", () => {
  if (!lastReport) { message("Run a replay before exporting.", true); return; }
  const blob = new Blob([JSON.stringify(lastReport, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = "veltrix-replay-" + lastReport.archive.symbol + "-" + new Date().toISOString().slice(0, 10) + ".json";
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
loadArchives().catch((error) => message("Cannot load local archives: " + error.message, true));
