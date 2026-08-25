import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());

// Allowed origins. If ALLOWED_ORIGIN is unset -> allow all. Otherwise allow the
// listed origins PLUS any *.webflow.io subdomain (handy for staging).
const ALLOW = (process.env.ALLOWED_ORIGIN || "")
  .split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                       // curl / server-to-server
    const clean = origin.replace(/\/+$/, "");
    if (ALLOW.length === 0) return cb(null, true);            // not configured -> allow all
    if (ALLOW.includes(clean)) return cb(null, true);
    try { if (/\.webflow\.io$/.test(new URL(origin).hostname)) return cb(null, true); } catch {}
    return cb(null, false);
  },
}));

const LA_KEY    = process.env.LIVEAVATAR_API_KEY;     // your (rotated) LiveAvatar key
const SECRET_ID = process.env.LIVEAVATAR_SECRET_ID;   // from the one-time secret registration
const AVATAR_ID = process.env.LIVEAVATAR_AVATAR_ID;   // the avatar you picked in LiveAvatar
const AGENT_ID  = process.env.ELEVENLABS_AGENT_ID || "agent_4301kq7pcrscezmrvnegnz2sqp95";

// ---- D365 CRM (sandbox) lead capture ----
const D365 = {
  tenant:       process.env.D365_TENANT_ID,
  clientId:     process.env.D365_CLIENT_ID,
  clientSecret: process.env.D365_CLIENT_SECRET,
  orgUrl:       (process.env.D365_ORG_URL || "").replace(/\/+$/, ""), // e.g. https://yourorg-sandbox.crm3.dynamics.com
  toolSecret:   process.env.IRIS_TOOL_SECRET,                          // shared secret for the ElevenLabs webhook tool
};

let d365Token = { value: null, exp: 0 };

async function getD365Token() {
  if (d365Token.value && Date.now() < d365Token.exp - 60000) return d365Token.value;
  const r = await fetch(`https://login.microsoftonline.com/${D365.tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: D365.clientId,
      client_secret: D365.clientSecret,
      scope: `${D365.orgUrl}/.default`,
    }),
  });
  const json = await r.json();
  if (!json.access_token) {
    throw new Error("D365 token failed: " + JSON.stringify(json));
  }
  d365Token = { value: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return d365Token.value;
}

app.get("/", (_req, res) =>
  res.json({ service: "iris-liveavatar-backend", status: "up", endpoints: ["/health", "/avatar-session", "/crm/lead"] }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Debug: shows which vars are SET (true/false) without revealing secret values.
app.get("/config", (_req, res) => res.json({
  LIVEAVATAR_API_KEY:   !!LA_KEY,
  LIVEAVATAR_SECRET_ID: !!SECRET_ID,
  LIVEAVATAR_AVATAR_ID: !!AVATAR_ID,
  ELEVENLABS_AGENT_ID:  AGENT_ID,
  D365_TENANT_ID:       !!D365.tenant,
  D365_CLIENT_ID:       !!D365.clientId,
  D365_CLIENT_SECRET:   !!D365.clientSecret,
  D365_ORG_URL:         !!D365.orgUrl,
  IRIS_TOOL_SECRET:     !!D365.toolSecret,
}));

// The browser calls this to get a short-lived session token for the avatar.
app.get("/avatar-session", async (_req, res) => {
  const missing = [];
  if (!LA_KEY)    missing.push("LIVEAVATAR_API_KEY");
  if (!SECRET_ID) missing.push("LIVEAVATAR_SECRET_ID");
  if (!AVATAR_ID) missing.push("LIVEAVATAR_AVATAR_ID");
  if (missing.length) {
    return res.status(500).json({ error: "Missing env vars", missing });
  }
  try {
    const r = await fetch("https://api.liveavatar.com/v1/sessions/token", {
      method: "POST",
      headers: { "X-API-KEY": LA_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        mode: "LITE",
        avatar_id: AVATAR_ID,
        elevenlabs_agent_config: { secret_id: SECRET_ID, agent_id: AGENT_ID },
      }),
    });
    const json = await r.json();
    if (!r.ok) {
      console.error("LiveAvatar error:", r.status, json);
      return res.status(r.status).json(json);
    }
    // hand the browser only what it needs
    res.json({ session_id: json?.data?.session_id, session_token: json?.data?.session_token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "session_failed" });
  }
});

// ElevenLabs webhook tool "create_lead" calls this (server-to-server).
// Guarded by the x-iris-secret header — NOT meant to be called from the browser.
app.post("/crm/lead", async (req, res) => {
  const missing = [];
  if (!D365.tenant)       missing.push("D365_TENANT_ID");
  if (!D365.clientId)     missing.push("D365_CLIENT_ID");
  if (!D365.clientSecret) missing.push("D365_CLIENT_SECRET");
  if (!D365.orgUrl)       missing.push("D365_ORG_URL");
  if (!D365.toolSecret)   missing.push("IRIS_TOOL_SECRET");
  if (missing.length) {
    return res.status(500).json({ error: "Missing env vars", missing });
  }

  // Only the ElevenLabs tool (holding the shared secret) may call this.
  if (req.headers["x-iris-secret"] !== D365.toolSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { first_name, last_name, email, company, topic } = req.body || {};
  if (!first_name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      status: "invalid",
      message: "A first name and a valid email address are required.",
    });
  }

  try {
    const token = await getD365Token();
    const api = `${D365.orgUrl}/api/data/v9.2`;

    // Dedupe: skip if an OPEN lead (statecode 0) already has this email.
    const safeEmail = email.replace(/'/g, "''");
    const q = `${api}/leads?$select=leadid&$filter=emailaddress1 eq '${safeEmail}' and statecode eq 0&$top=1`;
    const dupRes = await fetch(q, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const dup = await dupRes.json();
    if (dupRes.ok && dup.value && dup.value.length) {
      console.log("[iris-crm] duplicate open lead for", email);
      return res.json({ status: "exists", message: "This visitor already has an open lead in the CRM." });
    }

    const create = await fetch(`${api}/leads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        Accept: "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        subject: topic ? `Website lead — ${topic}` : "Website lead — Iris AI assistant",
        firstname: first_name,
        lastname: last_name || "(not provided)",
        emailaddress1: email,
        ...(company ? { companyname: company } : {}),
        description: `Captured by Iris (AI assistant) on iristel.com — ${new Date().toISOString()}` +
          (topic ? `\nTopic of interest: ${topic}` : ""),
      }),
    });

    if (!create.ok) {
      const errText = await create.text();
      console.error("[iris-crm] create failed:", create.status, errText);
      return res.status(502).json({ status: "error", message: "CRM save failed." });
    }

    const lead = await create.json();
    console.log("[iris-crm] lead created:", lead.leadid, email);
    res.json({ status: "created", message: "Lead saved successfully. A team member will follow up." });
  } catch (e) {
    console.error("[iris-crm] failed:", e.message);
    res.status(500).json({ status: "error", message: "CRM save failed." });
  }
});

const PORT = process.env.PORT || 3000;   // Railway injects PORT automatically
app.listen(PORT, () => console.log("LiveAvatar token server listening on", PORT));
