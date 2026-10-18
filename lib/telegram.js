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
  const quality = Number(result.quality);
  const riskPct = Number(s.riskPercent);
  const riskAmount = Number(s.riskAmount);
  const currency = safeText(s.accountCurrency || "account currency");
  const status = s.status === "CONFIRMED" ? "ENTRY CONFIRMED" : s.status === "PENDING" ? "PENDING ENTRY" : "SIGNAL CANDIDATE";

  return [
    `<b>${side === "BUY" ? "🟦" : "🟥"} ${side} ${safeText(s.symbol || "XAUUSD")} — ${status}</b>`,
    "",
    `<b>Entry:</b> ${price(s.entry)}`,
    `<b>TP1:</b> ${price(s.takeProfit)}`,
    `<b>SL:</b> ${price(s.stopLoss)}`,
    `<b>Risk/Reward:</b> 1:${Number.isFinite(rr) ? rr.toFixed(2) : "N/A"}`,
    `<b>Signal quality:</b> ${Number.isFinite(quality) ? quality + "/100" : "N/A"} (not win probability)`,
    ...(result.scoreBreakdown ? [
      "<b>Score breakdown:</b>",
      ...Object.entries(result.scoreBreakdown).map(([key, value]) => "• " + safeText(key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())) + ": " + Number(value) + " pts"),
      `Threshold: ${Number(result.scoreThreshold ?? 70)}/100`
    ] : []),
    `<b>Risk budget:</b> ${Number.isFinite(riskAmount) && Number.isFinite(riskPct) ? riskAmount.toFixed(2) + " " + currency + " (" + riskPct + "%)" : "Check account settings"}`,
    `<b>Timeframe:</b> ${safeText(s.timeframe || "H1 + M15")}`,
    `<b>Setup:</b> ${safeText(s.setup || "MSNR")}`,
    ...(s.tradingSession ? [`<b>Session:</b> ${safeText(s.tradingSession)}`] : []),
    `<b>Signal candle:</b> ${safeText(s.candleTime || "not provided")}`,
    ...(result.newsStatus ? [`<b>News filter:</b> ${safeText(result.newsStatus.status)} — ${safeText(result.newsStatus.reason)}`] : []),
    `<b>Scan time:</b> ${safeText(result.checkedAt || new Date().toISOString())}`,
    ...(result.confirmation?.candleTime ? [`<b>Entry confirmation candle:</b> ${safeText(result.confirmation.candleTime)}`] : []),
    ...(reasons.length ? ["", "<b>Why this setup:</b>", ...reasons.slice(0, 4).map((reason) => "• " + safeText(reason))] : []),
    "",
    "<b>⚠️ MANAGE RISK</b>",
    "Manual-review signal only. Verify current price, spread, and news. No broker order has been placed."
  ].join("\n");
}
