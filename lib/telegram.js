import { Resvg } from "@resvg/resvg-js";
export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, status: "NOT_CONFIGURED", message: "Telegram credentials are not configured." };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      return { sent: false, status: "FAILED", message: String(payload?.description || "Telegram rejected the message.").slice(0, 180) };
    }
    return { sent: true, status: "SENT", messageId: payload.result?.message_id ?? null };
  } catch (error) {
    return { sent: false, status: "FAILED", message: error?.name === "AbortError" ? "Telegram request timed out." : "Telegram delivery failed." };
  } finally {
    clearTimeout(timeout);
  }
}

function safeText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatSignalMessage(result) {
  const s = result?.signal;
  if (!s) throw new Error("Cannot format a missing signal.");

  const side = s.side === "BUY" ? "BUY" : s.side === "SELL" ? "SELL" : null;
  if (!side) throw new Error("Cannot format a signal with an invalid direction.");

  const price = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error("Signal contains an invalid price.");
    return number.toFixed(2);
  };
  // Validate all prices before checking direction so NaN/Infinity receives a
  // precise validation error instead of being misreported as a direction error.
  price(s.entry);
  price(s.stopLoss);
  price(s.takeProfit);
  const entry = Number(s.entry);
  const stop = Number(s.stopLoss);
  const target = Number(s.takeProfit);
  if (side === "BUY" ? !(stop < entry && target > entry) : !(stop > entry && target < entry)) {
    throw new Error("Signal prices do not match the trade direction.");
  }

  const reasons = Array.isArray(s.explanation) ? s.explanation : [];
  const rr = Number(s.riskReward);
  const actualRR = Math.abs(target - entry) / Math.abs(entry - stop);
  if (!Number.isFinite(rr) || !Number.isFinite(actualRR) || rr < 1.5 ||
      actualRR + 1e-9 < rr || actualRR + 1e-9 < 1.5) {
    throw new Error("Signal fails minimum 1.5R Telegram delivery validation.");
  }
  const quality = Number(result.quality);
  const riskPct = Number(s.riskPercent);
  const riskAmount = Number(s.riskAmount);
  const currency = safeText(s.accountCurrency || "account currency");
  const status = s.status === "CONFIRMED" ? "ENTRY CONFIRMED" : s.status === "PENDING" ? "PENDING ENTRY" : "SIGNAL CANDIDATE";

  return [
    `<b>${side === "BUY" ? "🟦" : "🟥"} ${side} ${safeText(s.symbol || result.symbol || "XAUUSD")} — ${status}</b>`,
    "",
    `<b>Entry:</b> ${price(s.entry)}`,
    ...(s.status === "PENDING" && Number.isFinite(Number(result.currentPrice)) && Number(result.currentPrice) > 0
      ? [`<b>Current price at alert:</b> ${price(result.currentPrice)}`]
      : []),
    `<b>TP1:</b> ${price(s.takeProfit)}`,
    `<b>SL:</b> ${price(s.stopLoss)}`,
    `<b>Risk/Reward:</b> 1:${Number.isFinite(rr) ? rr.toFixed(2) : "N/A"}`,
    `<b>Signal quality:</b> ${Number.isFinite(quality) ? quality + "/100" : "N/A"} (not win probability)`,
    `<b>Risk budget:</b> ${Number.isFinite(riskAmount) && Number.isFinite(riskPct) ? riskAmount.toFixed(2) + " " + currency + " (" + riskPct + "%)" : "Check account settings"}`,
    `<b>Timeframe:</b> ${safeText(s.timeframe || "H1 + M15")}`,
    `<b>Setup:</b> ${safeText(s.setup || "MSNR")}`,
    ...(result.newsStatus ? [`<b>News filter:</b> ${safeText(result.newsStatus.status)} — ${safeText(result.newsStatus.reason)}`] : []),
    `<b>Signal candle:</b> ${safeText(s.candleTime || "not provided")}`,
    ...(s.signalRef ? [`<b>Signal reference:</b> ${safeText(s.signalRef)}`] : []),
    ...(result.confirmation?.candleTime ? [`<b>Entry confirmation candle:</b> ${safeText(result.confirmation.candleTime)}`] : []),
    ...(reasons.length ? ["", "<b>Why this setup:</b>", ...reasons.slice(0, 4).map((reason) => "• " + safeText(reason))] : []),
    "",
    ...(s.status === "PENDING" ? ["", "Wait for price to reach the entry; do not enter early."] : []),
    "<b>⚠️ MANAGE RISK</b>",
    "Manual-review signal only. Verify current price, spread, and news. No broker order has been placed."
  ].join("\n");
}

export function formatRsiRejectionMessage(result, symbol = "XAUUSD") {
  const setup = result?.potentialSetup;
  if (!setup || !["BUY", "SELL"].includes(setup.side)) {
    throw new Error("Cannot format a missing or invalid RSI-rejected setup.");
  }
  const market = symbol === "BTCUSD" ? "BTCUSD" : "XAUUSD";
  const rsiValue = Number(setup.rsi ?? result?.indicators?.rsi);
  const zonePrice = Number(setup.zone?.price);
  const safePrice = Number.isFinite(zonePrice) ? zonePrice.toFixed(3) : "not available";
  return [
    `<b>🔎 ${market} POTENTIAL SETUP — RSI REJECTION</b>`,
    "",
    `<b>Direction:</b> ${setup.side}`,
    `<b>Strategy:</b> MSNR — ${safeText(setup.setup || "potential rejection/retest")}`,
    `<b>H1 trend:</b> ${safeText(setup.h1Trend || (setup.side === "BUY" ? "Bullish" : "Bearish"))}`,
    `<b>M15 RSI:</b> ${Number.isFinite(rsiValue) ? rsiValue.toFixed(2) : "not available"}`,
    `<b>Relevant zone:</b> ${safeText(setup.zone?.type || "support/resistance")} at ${safePrice}`,
    `<b>Setup candle (UTC):</b> ${safeText(setup.candleTime || "not available")}`,
    "",
    "<b>Status: NOT CONFIRMED</b>",
    "Reason: M15 RSI momentum does not confirm the H1 direction.",
    "",
    "This is an early-warning alert only. No entry, stop-loss, or take-profit is approved.",
    "<b>Do not enter a trade based on this alert.</b> Wait for the normal confirmation rules."
  ].join("\n");
}


function xmlText(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function cardPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("Signal card contains an invalid price.");
  return number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function buildSignalCardSvg(result) {
  const s = result?.signal;
  if (!s || !["BUY", "SELL"].includes(s.side)) throw new Error("Cannot build a card for a missing or invalid signal.");
  // Reuse the same strict risk/price validation used for text alerts.
  formatSignalMessage(result);
  const buy = s.side === "BUY";
  const accent = buy ? "#35A7FF" : "#FF4D61";
  const accentSoft = buy ? "#0D4D80" : "#7A1D2B";
  const symbol = xmlText(s.symbol || result.symbol || "XAUUSD");
  const status = result.preview ? "DESIGN PREVIEW — SAMPLE DATA" : s.status === "CONFIRMED" ? "ENTRY CONFIRMED" : s.status === "PENDING" ? "PENDING ENTRY" : "SIGNAL";
  const quality = Number(result.quality);
  const rr = Number(s.riskReward);
  const risk = Number(s.riskAmount);
  const riskPct = Number(s.riskPercent);
  const currency = xmlText(s.accountCurrency || "account currency");
  const timeframe = xmlText(s.timeframe || "H1 + M15");
  const setup = xmlText(s.setup || "MSNR");
  const explanations = (Array.isArray(s.explanation) ? s.explanation : []).slice(0, 2).map((item) => xmlText(item).slice(0, 95));
  const reasonRows = explanations.map((item, index) => `<text x="88" y="${785 + index * 32}" class="reason">• ${item}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="940" viewBox="0 0 1200 940">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#080B12"/><stop offset="1" stop-color="#101725"/></linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${accentSoft}"/></linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="18"/></filter>
    <style>
      .brand{font:600 25px Arial,sans-serif;letter-spacing:5px;fill:#AAB7CA}
      .status{font:600 22px Arial,sans-serif;letter-spacing:3px;fill:#DCE6F5}
      .side{font:900 116px Arial,sans-serif;letter-spacing:3px;fill:${accent}}
      .symbol{font:700 34px Arial,sans-serif;fill:#F4F7FC;letter-spacing:2px}
      .label{font:600 18px Arial,sans-serif;fill:#8E9DB3;letter-spacing:2px}
      .value{font:700 35px Arial,sans-serif;fill:#F4F7FC}
      .meta{font:600 20px Arial,sans-serif;fill:#C1CDDE}
      .reason{font:500 20px Arial,sans-serif;fill:#AAB8CC}
      .foot{font:500 17px Arial,sans-serif;fill:#718198;letter-spacing:1px}
    </style>
  </defs>
  <rect width="1200" height="940" rx="36" fill="url(#bg)"/>
  <circle cx="1030" cy="105" r="150" fill="${accent}" opacity=".12" filter="url(#glow)"/>
  <rect x="28" y="28" width="1144" height="884" rx="28" fill="none" stroke="#293447" stroke-width="2"/>
  <rect x="62" y="62" width="7" height="68" rx="3" fill="url(#accent)"/>
  <text x="91" y="91" class="brand">GOLD SCALPER</text>
  <text x="91" y="123" class="status">${xmlText(status)}</text>
  <text x="1100" y="98" text-anchor="end" class="symbol">${symbol}</text>
  <text x="72" y="280" class="side">${s.side}</text>
  <text x="78" y="324" class="meta">${buy ? "BULLISH SETUP" : "BEARISH SETUP"}  •  ${timeframe}</text>
  <rect x="72" y="365" width="1056" height="2" fill="#293447"/>
  <g transform="translate(72 414)">
    <text x="0" y="0" class="label">ENTRY</text><text x="0" y="49" class="value">${cardPrice(s.entry)}</text>
    <text x="360" y="0" class="label">TAKE PROFIT</text><text x="360" y="49" class="value">${cardPrice(s.takeProfit)}</text>
    <text x="720" y="0" class="label">STOP LOSS</text><text x="720" y="49" class="value">${cardPrice(s.stopLoss)}</text>
  </g>
  <rect x="72" y="505" width="1056" height="2" fill="#293447"/>
  <g transform="translate(72 554)">
    <text x="0" y="0" class="label">RISK / REWARD</text><text x="0" y="43" class="value">1:${Number.isFinite(rr) ? rr.toFixed(2) : "N/A"}</text>
    <text x="360" y="0" class="label">QUALITY SCORE</text><text x="360" y="43" class="value">${Number.isFinite(quality) ? quality + "/100" : "N/A"}</text>
    <text x="720" y="0" class="label">RISK BUDGET</text><text x="720" y="43" class="value" font-size="29">${Number.isFinite(risk) && Number.isFinite(riskPct) ? xmlText(risk.toFixed(2) + " " + currency) : "Check settings"}</text>
    <text x="720" y="73" class="meta">${Number.isFinite(riskPct) ? riskPct + "% risk" : ""}</text>
  </g>
  <rect x="72" y="655" width="1056" height="2" fill="#293447"/>
  <text x="78" y="704" class="meta">${result.preview ? "PREVIEW MODE • NOT A LIVE SIGNAL" : "STRATEGY  " + setup}</text>
  ${reasonRows}
  <text x="78" y="866" class="foot">${result.preview ? "SAMPLE VALUES • NOT A LIVE SIGNAL" : "MANUAL REVIEW ONLY  •  VERIFY PRICE, SPREAD &amp; NEWS"}</text>
  <text x="1120" y="866" text-anchor="end" class="foot">NO BROKER ORDER PLACED</text>
</svg>`;
}

export async function sendTelegramSignal(result) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, status: "NOT_CONFIGURED", message: "Telegram credentials are not configured." };
  const svg = buildSignalCardSvg(result);
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
  const s = result.signal;
  const side = s.side;
  const status = s.status === "CONFIRMED" ? "ENTRY CONFIRMED" : s.status === "PENDING" ? "PENDING ENTRY" : "SIGNAL";
  const caption = result.preview\n    ? `DESIGN PREVIEW — ${side} ${s.symbol || result.symbol || "XAUUSD"}\\nSample values only. Not a live trading signal.`\n    : `${side} ${s.symbol || result.symbol || "XAUUSD"} — ${status}\\nManual-review only. No broker order has been placed.`;
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([png], { type: "image/png" }), "gold-scalper-signal.png");
  form.append("caption", caption);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form, signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) return { sent: false, status: "FAILED", message: String(payload?.description || "Telegram rejected the signal card.").slice(0, 180) };
    return { sent: true, status: "SENT", messageId: payload.result?.message_id ?? null };
  } catch (error) {
    return { sent: false, status: "FAILED", message: error?.name === "AbortError" ? "Telegram image request timed out." : "Telegram image delivery failed." };
  } finally {
    clearTimeout(timeout);
  }
}
