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
  const reasons = Array.isArray(s.explanation) ? s.explanation.join("; ") : "Rules-based setup";
  return [
    `<b>GOLD SCALPER — ${s.side} XAUUSD</b>`,
    `Quality: ${result.quality}/100`,
    `Entry: ${s.entry}`,
    `Stop Loss: ${s.stopLoss}`,
    `Take Profit: ${s.takeProfit}`,
    `Risk/Reward: 1:${s.riskReward}`,
    `Risk budget: ${s.riskAmount} ${s.accountCurrency} (${s.riskPercent}%)`,
    `Setup: ${s.timeframe}`,
    `Candle: ${s.candleTime || "not provided"}`,
    `Reason: ${reasons}`,
    "",
    "Manual-review candidate only. Verify live price, spread, and news. Not financial advice; no execution has occurred."
  ].join("\n");
}
