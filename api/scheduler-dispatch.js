import { timingSafeEqual } from "node:crypto";

const REPOSITORY = "Nexora-Apparel/gold-scalper";
const WORKFLOW = "gold-scalper-scheduled-monitor.yml";
const TARGET_REF = "main";

function bearerMatches(header, expected) {
  if (typeof header !== "string" || !expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const configured = Buffer.from(expected, "utf8");
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const schedulerSecret = process.env.SCHEDULER_TRIGGER_SECRET;
  const githubToken = process.env.GITHUB_DISPATCH_TOKEN;
  if (!schedulerSecret || !githubToken) {
    return res.status(503).json({
      ok: false,
      error: "Scheduler relay is not configured"
    });
  }

  if (!bearerMatches(req.headers.authorization, schedulerSecret)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ref: TARGET_REF }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (response.status !== 204) {
      // Do not return GitHub response bodies or credentials to the caller.
      console.error("GitHub workflow dispatch failed with HTTP", response.status);
      return res.status(502).json({
        ok: false,
        error: "GitHub did not accept the workflow dispatch",
        upstreamStatus: response.status
      });
    }

    return res.status(202).json({
      ok: true,
      queued: true,
      workflow: WORKFLOW,
      ref: TARGET_REF
    });
  } catch (error) {
    console.error("GitHub workflow dispatch request failed:", error?.name || "unknown error");
    return res.status(502).json({
      ok: false,
      error: "Could not reach GitHub to dispatch the workflow"
    });
  }
}

export { bearerMatches };
