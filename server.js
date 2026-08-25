import express from "express";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }, // raw body kept for webhook HMAC checks
}));

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
  // Optional lead routing. Set ONE of these (a GUID) to make new leads land
  // in a real user's "My Open Leads" or a team's view instead of being owned
  // by the application user:
  //   D365_OWNER_USER_ID = systemuser GUID  (Settings > Users > user > copy id from URL)
  //   D365_OWNER_TEAM_ID = team GUID
  ownerUserId:  process.env.D365_OWNER_USER_ID || "",
  ownerTeamId:  process.env.D365_OWNER_TEAM_ID || "",
};

// HMAC secret from ElevenLabs post-call webhook setup (Agents settings > Webhooks).
const EL_WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET || "";

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
  D365_OWNER_USER_ID:   !!D365.ownerUserId,
  D365_OWNER_TEAM_ID:   !!D365.ownerTeamId,
  ELEVENLABS_WEBHOOK_SECRET: !!EL_WEBHOOK_SECRET,
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

  const { first_name, last_name, email, company, topic, conversation_id } = req.body || {};
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
        // Route ownership if configured; otherwise the app user owns the lead
        // (it will then appear in "All Leads" but NOT in anyone's "My Open Leads").
        ...(D365.ownerUserId
          ? { "ownerid@odata.bind": `/systemusers(${D365.ownerUserId})` }
          : D365.ownerTeamId
            ? { "ownerid@odata.bind": `/teams(${D365.ownerTeamId})` }
            : {}),
        subject: topic ? `Website lead — ${topic}` : "Website lead — Iris AI assistant",
        firstname: first_name,
        lastname: last_name || "(not provided)",
        emailaddress1: email,
        ...(company ? { companyname: company } : {}),
        description: `Captured by Iris (AI assistant) on iristel.com — ${new Date().toISOString()}` +
          (topic ? `\nTopic of interest: ${topic}` : "") +
          (conversation_id ? `\n[conv:${conversation_id}]` : ""),
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

// ---- ElevenLabs post-call webhook: attach the transcript to the lead ----
// Enable in ElevenLabs: Agents settings > Webhooks > post_call_transcription,
// pointing at POST /webhooks/elevenlabs. Store the generated HMAC secret in
// ELEVENLABS_WEBHOOK_SECRET.

function verifyElevenLabsSignature(req) {
  if (!EL_WEBHOOK_SECRET) return false;
  const header = req.headers["elevenlabs-signature"];
  if (!header || !req.rawBody) return false;
  // Header format: t=<unix_ts>,v0=<hex hmac of "<t>.<raw body>">
  const parts = Object.fromEntries(header.split(",").map(kv => kv.split("=")));
  if (!parts.t || !parts.v0) return false;
  // Reject stale deliveries (older than 30 minutes) to block replays.
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 1800) return false;
  const expected = "v0=" + crypto
    .createHmac("sha256", EL_WEBHOOK_SECRET)
    .update(`${parts.t}.${req.rawBody}`)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from("v0=" + parts.v0), Buffer.from(expected));
  } catch { return false; }
}

app.post("/webhooks/elevenlabs", async (req, res) => {
  if (!verifyElevenLabsSignature(req)) {
    return res.status(401).json({ error: "invalid signature" });
  }
  // Ack fast — ElevenLabs disables webhooks that keep failing. Everything
  // below is best-effort and must not affect the response.
  res.json({ received: true });

  try {
    const { type, data } = req.body || {};
    if (type !== "post_call_transcription" || !data) return;

    const convId = data.conversation_id;
    if (!convId) return;

    // Build a readable transcript.
    const lines = (data.transcript || [])
      .filter(t => t && t.message)
      .map(t => `${t.role === "agent" ? "Iris" : "Customer"}: ${t.message}`);
    const summary = data.analysis?.transcript_summary || "";
    const durationSecs = data.metadata?.call_duration_secs;

    let noteText =
      (summary ? `SUMMARY\n${summary}\n\n` : "") +
      (durationSecs ? `Duration: ${Math.round(durationSecs / 60)} min ${durationSecs % 60} s\n\n` : "") +
      `TRANSCRIPT\n` + lines.join("\n");
    // Annotation notetext is capped; keep a wide margin.
    if (noteText.length > 90000) noteText = noteText.slice(0, 90000) + "\n[truncated]";

    const token = await getD365Token();
    const api = `${D365.orgUrl}/api/data/v9.2`;

    // Find the lead stamped with this conversation id.
    const q = `${api}/leads?$select=leadid&$filter=contains(description,'[conv:${convId}]')&$top=1`;
    const found = await (await fetch(q, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })).json();

    if (!found.value || !found.value.length) {
      console.log("[iris-crm] webhook: no lead for conversation", convId);
      return;
    }
    const leadId = found.value[0].leadid;

    // Idempotency: retried webhook deliveries must not duplicate the note.
    const dupQ = `${api}/annotations?$select=annotationid&$filter=_objectid_value eq ${leadId} and subject eq 'Iris conversation ${convId}'&$top=1`;
    const dup = await (await fetch(dupQ, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })).json();
    if (dup.value && dup.value.length) {
      console.log("[iris-crm] webhook: note already attached for", convId);
      return;
    }

    const note = await fetch(`${api}/annotations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        subject: `Iris conversation ${convId}`,
        notetext: noteText,
        "objectid_lead@odata.bind": `/leads(${leadId})`,
      }),
    });

    if (!note.ok) {
      console.error("[iris-crm] webhook: note create failed:", note.status, await note.text());
      return;
    }
    console.log("[iris-crm] webhook: transcript attached to lead", leadId, "conv", convId);
  } catch (e) {
    console.error("[iris-crm] webhook processing failed:", e.message);
  }
});

const PORT = process.env.PORT || 3000;   // Railway injects PORT automatically
app.listen(PORT, () => console.log("LiveAvatar token server listening on", PORT));
