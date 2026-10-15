export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const configured = Boolean(process.env.DATABASE_URL && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_OWNER_ID);
  // Presence of credentials is not proof of a live connection. Until provider
  // probes are implemented and successful, report integrations as unverified.
  return res.status(200).json({
    application: "ONLINE",
    marketData: "Not verified",
    marketConnected: false,
    telegram: "Not verified",
    telegramConnected: false,
    engine: "PAUSED",
    safeMode: true,
    backendConfigured: configured,
    note: "Credentials and live provider health have not been verified; signal generation and publishing remain disabled."
  });
}
