import test from "node:test";
import assert from "node:assert/strict";
import { formatSignalMessage, buildSignalCardSvg } from "../lib/telegram.js";

function candidate(overrides = {}) {
  return {
    status: "SIGNAL_CANDIDATE",
    quality: 80,
    signal: {
      symbol: "XAUUSD",
      side: "BUY",
      entry: 4171,
      takeProfit: 4211,
      stopLoss: 4151,
      riskReward: 2,
      riskPercent: 0.5,
      riskAmount: 5,
      accountCurrency: "USD",
      timeframe: "H1 + M15",
      setup: "MSNR",
      candleTime: "2026-10-16T08:00:00Z",
      explanation: [
        "H1 trend confirmation",
        "Support/resistance confirmation",
        "M15 momentum confirmation"
      ],
      ...overrides
    }
  };
}

test("formats a BUY candidate with entry, target, stop, risk, and disclaimer", () => {
  const message = formatSignalMessage(candidate());
  assert.match(message, /BUY XAUUSD — SIGNAL CANDIDATE/);
  assert.match(message, /Entry:<\/b> 4171\.00/);
  assert.match(message, /TP1:<\/b> 4211\.00/);
  assert.match(message, /SL:<\/b> 4151\.00/);
  assert.match(message, /Risk\/Reward:<\/b> 1:2\.00/);
  assert.match(message, /Signal quality:<\/b> 80\/100/);
  assert.match(message, /Risk budget:<\/b> 5\.00 USD \(0\.5%\)/);
  assert.match(message, /H1 trend confirmation/);
  assert.match(message, /No broker order has been placed/);
});

test("formats a SELL candidate and uses the red direction marker", () => {
  const message = formatSignalMessage(candidate({
    side: "SELL", entry: 4171, takeProfit: 4131, stopLoss: 4191
  }));
  assert.match(message, /🟥 SELL XAUUSD — SIGNAL CANDIDATE/);
  assert.match(message, /TP1:<\/b> 4131\.00/);
  assert.match(message, /SL:<\/b> 4191\.00/);
});

test("labels pending entries and includes the quote observed before entry", () => {
  const base = candidate();
  const message = formatSignalMessage({
    ...base,
    currentPrice: 4168.5,
    signal: { ...base.signal, status: "PENDING" }
  });
  assert.match(message, /BUY XAUUSD — PENDING ENTRY/);
  assert.match(message, /Current price at alert:<\/b> 4168\.50/);
  assert.match(message, /Wait for price to reach the entry; do not enter early/);
});

test("rejects missing signals and invalid directions", () => {
  assert.throws(() => formatSignalMessage({ status: "NO_TRADE", signal: null }), /missing signal/i);
  assert.throws(() => formatSignalMessage(candidate({ side: "HOLD" })), /invalid direction/i);
});

test("rejects BUY prices whose stop or target is on the wrong side of entry", () => {
  assert.throws(() => formatSignalMessage(candidate({ stopLoss: 4172 })), /do not match the trade direction/i);
  assert.throws(() => formatSignalMessage(candidate({ takeProfit: 4170 })), /do not match the trade direction/i);
});

test("rejects SELL prices whose stop or target is on the wrong side of entry", () => {
  assert.throws(() => formatSignalMessage(candidate({
    side: "SELL", stopLoss: 4170, takeProfit: 4151
  })), /do not match the trade direction/i);
  assert.throws(() => formatSignalMessage(candidate({
    side: "SELL", stopLoss: 4191, takeProfit: 4172
  })), /do not match the trade direction/i);
});

test("rejects non-finite and non-positive prices", () => {
  assert.throws(() => formatSignalMessage(candidate({ entry: Number.NaN })), /invalid price/i);
  assert.throws(() => formatSignalMessage(candidate({ takeProfit: 0 })), /invalid price/i);
});

test("caps explanation lines and strips HTML angle brackets from free text", () => {
  const message = formatSignalMessage(candidate({
    timeframe: "<script>alert(1)</script>",
    explanation: ["<b>unsafe</b>", "reason 2", "reason 3", "reason 4", "reason 5"]
  }));
  assert.doesNotMatch(message, /<script>|<b>unsafe<\/b>/i);
  assert.match(message, /• unsafe/);
  assert.doesNotMatch(message, /reason 5/);
  assert.equal((message.match(/• /g) || []).length, 4);
});


test("labels confirmed entry updates and includes the confirmation candle", () => {
  const base = candidate();
  const message = formatSignalMessage({
    ...base,
    signal: { ...base.signal, status: "CONFIRMED" },
    confirmation: { status: "ENTRY_CONFIRMED", candleTime: "2026-10-16T09:15:00Z" }
  });
  assert.match(message, /BUY XAUUSD — ENTRY CONFIRMED/);
  assert.match(message, /Entry confirmation candle:<\/b> 2026-10-16T09:15:00Z/);
});

test("formats BTCUSD as BTCUSD and never labels it XAUUSD", () => {
  const base = candidate();
  const message = formatSignalMessage({
    ...base,
    symbol: "BTCUSD",
    signal: { ...base.signal, symbol: "BTCUSD", entry: 65000, takeProfit: 67000, stopLoss: 64000, riskReward: 2 }
  });
  assert.match(message, /BUY BTCUSD — SIGNAL CANDIDATE/);
  assert.doesNotMatch(message, /XAUUSD/);
});


test("builds a premium black-and-blue BUY image card with live signal levels", () => {
  const svg = buildSignalCardSvg(candidate());
  assert.match(svg, /<svg/);
  assert.match(svg, /#35A7FF/);
  assert.match(svg, /BUY/);
  assert.match(svg, /4171\.00/);
  assert.match(svg, /4211\.00/);
  assert.match(svg, /4151\.00/);
  assert.match(svg, /MANUAL REVIEW ONLY/);
});

test("builds a black-and-red SELL image card and uses BTCUSD when supplied", () => {
  const base = candidate({
    side: "SELL", symbol: "BTCUSD", entry: 65000, takeProfit: 63000, stopLoss: 66000,
    riskReward: 2
  });
  const svg = buildSignalCardSvg({ ...base, symbol: "BTCUSD" });
  assert.match(svg, /#FF4D61/);
  assert.match(svg, /SELL/);
  assert.match(svg, /BTCUSD/);
  assert.match(svg, /65000\.00/);
});

test("refuses to render a card with invalid trade levels", () => {
  assert.throws(() => buildSignalCardSvg(candidate({ side: "BUY", stopLoss: 4180 })), /do not match the trade direction/i);
});
