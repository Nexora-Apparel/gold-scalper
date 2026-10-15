export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const configured = Boolean(process.env.DATABASE_URL);
  // Presence of credentials is not proof of a live connection. Until provider
  // probes are implemented and successful, report integrations as unverified.
  return res.status(200).json({
    application: "ONLINE",
    marketData: "Not verified",
    marketConnected: false,
    engine: "PAUSED",
    safeMode: true,
    backendConfigured: configured,
    note: "Database credentials and live market-data health have not been verified; signal generation remains disabled."
  });
}
