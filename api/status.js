export default async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow","GET"); return res.status(405).json({ error: "Method not allowed" }); }
  const keyConfigured = Boolean(process.env.TWELVEDATA_API_KEY);
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  return res.status(200).json({
    application: "ONLINE",
    marketData: keyConfigured ? "Key configured; live feed unverified" : "API key required",
    marketConnected: false,
    marketKeyConfigured: keyConfigured,
    engine: "PAUSED",
    safeMode: true,
    backendConfigured: databaseConfigured,
    note: "Provider access and candle freshness must pass a live request before market data is marked verified. Controls and settings remain disabled until owner authentication and persistent storage are configured."
  });
}
