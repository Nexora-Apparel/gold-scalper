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
  const currency = String(s.accountCurrency || "account currency").replace(/[<>]/g, "");
  const status = s.status === "PENDING" ? "PENDING ENTRY" : "SIGNAL CANDIDATE";

  return [
    `<b>${side === "BUY" ? "🟦" : "🟥"} ${side} XAUUSD — ${status}</b>`,
    "",
    `<b>Entry:</b> ${price(s.entry)}`,
    `<b>TP1:</b> ${price(s.takeProfit)}`,
    `<b>SL:</b> ${price(s.stopLoss)}`,
    `<b>Risk/Reward:</b> 1:${Number.isFinite(rr) ? rr.toFixed(2) : "N/A"}`,
    `<b>Signal quality:</b> ${Number.isFinite(quality) ? quality + "/100" : "N/A"} (not win probability)`,
    `<b>Risk budget:</b> ${Number.isFinite(riskAmount) && Number.isFinite(riskPct) ? riskAmount.toFixed(2) + " " + currency + " (" + riskPct + "%)" : "Check account settings"}`,
    `<b>Timeframe:</b> ${String(s.timeframe || "H1 + M15").replace(/[<>]/g, "")}`,
    `<b>Setup:</b> ${String(s.setup || "MSNR").replace(/[<>]/g, "")}`,
    `<b>Signal candle:</b> ${String(s.candleTime || "not provided").replace(/[<>]/g, "")}`,
    ...(reasons.length ? ["", "<b>Why this setup:</b>", ...reasons.slice(0, 4).map((reason) => "• " + String(reason).replace(/[<>]/g, ""))] : []),
    "",
    "<b>⚠️ MANAGE RISK</b>",
    "Manual-review signal only. Verify current price, spread, and news. No broker order has been placed."
  ].join("\n");
}
