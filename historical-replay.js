import { listArchives, exportArchive } from "./tick-archive.js";
import { replayScalpingSignals } from "./lib/scalping-historical-replay.js";

const $ = (id) => document.getElementById(id);
const status = $("replayStatus");
const archiveSelect = $("archiveSelect");
const signalFile = $("signalFile");
const runButton = $("runReplay");
const report = $("replayReport");
const HORIZONS = [5, 15, 30, 60];
let selectedArchive = null;
let lastReport = null;

function message(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}
function strictTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  const datePart = value.slice(0, 10);
  const [year, month, day] = datePart.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return NaN;
  return time;
}
function parseSignals(text, filename, symbol) {
  let metadata, signals;
  if (filename.toLowerCase().endsWith(".json")) {
    const parsed = JSON.parse(text);
    metadata = parsed.metadata;
    signals = parsed.signals;
  } else if (filename.toLowerCase().endsWith(".csv")) {
    const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    const headers = lines.shift().split(",").map((v) => v.trim().toLowerCase());
    const indexes = Object.fromEntries(headers.map((v, i) => [v, i]));
    if (["timestamp", "symbol", "side"].some((key) => indexes[key] === undefined)) throw new Error("Signal CSV requires timestamp,symbol,side columns; id is optional.");
    signals = lines.filter(Boolean).map((line, index) => {
      if (line.includes('"')) throw new Error("Quoted CSV fields are not supported in signal logs; use plain comma-separated fields.");
      const cells = line.split(",");
      if (cells.length !== headers.length) throw new Error("Signal CSV column mismatch at data row " + (index + 1) + ".");
      return { id: indexes.id === undefined ? null : cells[indexes.id].trim(), timestamp: cells[indexes.timestamp].trim(), symbol: cells[indexes.symbol].trim(), side: cells[indexes.side].trim().toUpperCase() };
    });
    metadata = { sourceReference: filename, strategy: "imported_signal_log" };
  } else throw new Error("Import a .json or .csv signal log.");
  if (!metadata || typeof metadata.sourceReference !== "string" || !metadata.sourceReference.trim()) throw new Error("Signal-log provenance is required in metadata.sourceReference.");
  if (!Array.isArray(signals) || !signals.length || signals.length > 50000) throw new Error("Signal log must contain 1–50,000 signals.");
  const clean = [];
  for (let i = 0; i < signals.length; i++) {
    const item = signals[i];
    const timestampMs = strictTime(item?.timestamp);
    const side = String(item?.side || "").toUpperCase();
    const itemSymbol = String(item?.symbol || "").toUpperCase();
    if (!Number.isFinite(timestampMs)) throw new Error("Signal " + (i + 1) + " has an invalid or timezone-ambiguous timestamp.");
    if (itemSymbol !== symbol) throw new Error("Signal " + (i + 1) + " has the wrong symbol.");
    if (side !== "BUY" && side !== "SELL") throw new Error("Signal " + (i + 1) + " must be BUY or SELL.");
    clean.push({ id: typeof item.id === "string" ? item.id : "signal-" + (i + 1), symbol, side, timestamp: new Date(timestampMs).toISOString(), timestampMs });
  }
  clean.sort((a, b) => a.timestampMs - b.timestampMs);
  return { metadata: { sourceReference: metadata.sourceReference, strategy: metadata.strategy || "unspecified" }, signals: clean };
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
  for (const [name, data] of Object.entries(result.partitions)) {
    const section = document.createElement("section");
    section.className = "partition";
    const title = document.createElement("h3");
    title.textContent = name + " · " + data.quoteCount.toLocaleString() + " quotes · " + data.signalCount.toLocaleString() + " signals";
    section.append(title);
    renderTable(section, ["Horizon", "Evaluated", "Wins", "Losses", "Flats", "Hit rate", "Mean move (price units)"],
      data.summary.map((r) => [r.horizonSeconds + "s", r.evaluated, r.wins, r.losses, r.flats, r.hitRatePercent == null ? "—" : r.hitRatePercent + "%", r.meanMovePriceUnits]));
    renderTable(section, ["Side", "Horizon", "Evaluated", "Wins", "Losses", "Hit rate", "Mean move"],
      data.summaryBySide.map((r) => [r.side, r.horizonSeconds + "s", r.evaluated, r.wins, r.losses, r.hitRatePercent == null ? "—" : r.hitRatePercent + "%", r.meanMovePriceUnits]));
    const skipped = document.createElement("p");
    skipped.className = "notice";
    skipped.textContent = "Skipped signals/horizons: " + data.skippedSignalsOrHorizons + " · " + JSON.stringify(data.skipped);
    section.append(skipped);
    report.append(section);
  }
  const boundary = document.createElement("p");
  boundary.className = "warning";
  boundary.textContent = "Research estimate only. Bid/Ask spread is embedded in executable-side entry/exit prices. Commission, slippage beyond observed ticks, execution latency, partial fills and Exness fill parity are not modelled. Do not treat hit rate as profitability or validated live accuracy.";
  report.append(boundary);
}
async function loadArchives() {
  const archives = await listArchives();
  archiveSelect.replaceChildren();
  if (!archives.length) {
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
  runButton.disabled = false;
}
archiveSelect.addEventListener("change", async () => {
  selectedArchive = await exportArchive(archiveSelect.value);
  message(selectedArchive ? "Selected immutable local archive " + archiveSelect.value.slice(0, 16) + "…" : "Archive unavailable.", !selectedArchive);
});
$("refreshArchives").addEventListener("click", () => loadArchives().then(() => message("Archive list refreshed.")).catch((e) => message(e.message, true)));
$("runReplay").addEventListener("click", async () => {
  try {
    if (!selectedArchive) throw new Error("Import a tick archive first.");
    const file = signalFile.files[0];
    if (!file) throw new Error("Import a timestamped signal log. The replay does not invent BUY/SELL signals.");
    if (file.size > 5 * 1024 * 1024) throw new Error("Signal log exceeds the 5 MB limit.");
    runButton.disabled = true;
    message("Validating signal provenance and running isolated chronological replays…");
    const parsed = parseSignals(await file.text(), file.name, selectedArchive.manifest.symbol);
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
        maxExitWaitMs: 1500
      });
      partitions[key] = { quoteCount: quotes.length, signalCount: signals.length, summary: result.summary, summaryBySide: result.summaryBySide, skippedSignalsOrHorizons: result.skippedSignalsOrHorizons, skipped: result.skipped, results: result.results };
    }
    lastReport = {
      reportType: "veltrix_chronological_tick_replay_v1",
      generatedAt: new Date().toISOString(),
      archive: { id: archiveSelect.value, ...manifest },
      signalSource: parsed.metadata.sourceReference,
      strategy: parsed.metadata.strategy,
      signalCount: parsed.signals.length,
      splitMethod: manifest.splitMethod,
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
