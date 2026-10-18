import { hasOwnerSession } from "../lib/auth.js";
import { sendTelegramSignal } from "../lib/telegram.js";

function previewSignal(symbol, side) {
  const isBuy = side === "BUY";
  const entry = symbol === "BTCUSD" ? 65000 : 4171;
  const distance = symbol === "BTCUSD" ? 1000 : 20;
  return {
    preview: true,
    status: "DESIGN_PREVIEW",
    quality: 88,
    symbol,
    signal: {
      symbol,
      side,
      status: "PREVIEW",
      entry,
      takeProfit: isBuy ? entry + distance * 2 : entry - distance * 2,
      stopLoss: isBuy ? entry - distance : entry + distance,
      riskReward: 2,
      riskPercent: 0.5,
      riskAmount: 5,
      accountCurrency: "USD",
      timeframe: "H1 + M15",
      setup: "MSNR — DESIGN SAMPLE",
      candleTime: "SAMPLE ONLY",
      explanation: ["Preview of the signal-card layout", "Prices are placeholders, not live market data"]
    }
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!hasOwnerSession(req)) return res.status(401).json({ error: "Owner login required." });

  const buy = await sendTelegramSignal(previewSignal("XAUUSD", "BUY"));
  if (!buy.sent) {
    const code = buy.status === "NOT_CONFIGURED" ? 503 : 502;
    return res.status(code).json({ ok: false, ...buy, message: "BUY preview could not be delivered." });
  }
  const sell = await sendTelegramSignal(previewSignal("BTCUSD", "SELL"));
  if (!sell.sent) {
    return res.status(502).json({
      ok: false,
      status: "PARTIAL",
      message: "BUY preview delivered, but SELL preview failed.",
      buyMessageId: buy.messageId,
      sellError: sell.message
    });
  }
  return res.status(200).json({
    ok: true,
    status: "SENT",
    message: "Both design previews delivered: blue BUY (XAUUSD) and red SELL (BTCUSD). Sample prices only; neither is a live trading signal.",
    messageIds: [buy.messageId, sell.messageId]
  });
}
