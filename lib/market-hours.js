// Conservative XAU/USD spot-market hours in UTC. The close/open guard intentionally
// errs on the side of skipping an hour rather than trusting weekend pseudo-candles.
export function getGoldMarketStatus(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) {
    return { open: false, status: "UNKNOWN", reason: "Clock value is invalid; gold market status cannot be verified." };
  }

  const day = date.getUTCDay(); // Sunday=0, Friday=5, Saturday=6
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();

  if (day === 6) {
    return { open: false, status: "CLOSED", reason: "XAU/USD spot market is closed on Saturday; no market-data analysis is permitted." };
  }
  if (day === 0 && (hour < 22)) {
    return { open: false, status: "CLOSED", reason: "XAU/USD spot market has not reopened for the week; weekend candles are not treated as live data." };
  }
  if (day === 5 && (hour > 21 || (hour === 21 && minute >= 0))) {
    return { open: false, status: "CLOSED", reason: "XAU/USD spot market is closed for the weekend; no new analysis or entry confirmation is permitted." };
  }
  return { open: true, status: "OPEN", reason: "Within the conservative XAU/USD spot-market trading window." };
}
