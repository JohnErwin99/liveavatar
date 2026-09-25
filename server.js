import express from "express";
import cors from "cors";
import crypto from "crypto";
import { readFileSync as fsReadFileSync } from "fs";

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }, // raw body kept for webhook HMAC checks
}));
// Mailchimp webhooks are application/x-www-form-urlencoded with bracketed keys
// (data[merges][FNAME]); extended:true parses those into nested objects.
app.use(express.urlencoded({ extended: true }));

// Allowed origins. If ALLOWED_ORIGIN is unset -> allow all. Otherwise allow the
// listed origins PLUS any *.webflow.io subdomain (handy for staging).
// NOTE: the API Marketplace form lives on the partner portal — if ALLOWED_ORIGIN
// is set, make sure it includes https://iristelpartnerportal.com and
// https://www.iristelpartnerportal.com (webflow.io staging is auto-allowed).
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
// Stored LiveAvatar Voice Agent (recommended path — created at
// app.liveavatar.com/voice-agent). When set, sessions reference it by id
// instead of passing secret_id/agent_id inline. Inline stays as fallback.
const VOICE_AGENT_ID = process.env.LIVEAVATAR_VOICE_AGENT_ID || "";

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

// ---- Mailchimp landing-page webhook. Mailchimp can't send custom headers,
// so the secret rides in the URL: /webhooks/mailchimp?key=<MAILCHIMP_WEBHOOK_KEY>
const MC_WEBHOOK_KEY = process.env.MAILCHIMP_WEBHOOK_KEY || "";

// ---- ServiceNow (Ciprian's API) — leave unset until credentials arrive.
// The /support/ticket endpoint runs in "queued" mode without them, so the
// agent flow can ship first and light up when the integration is ready.
//
// IMPORTANT: customers get CASES, not incidents. Incidents are internal-only
// and not visible to the customer; a customer-opened support request must be a
// Customer Service Management (CSM) Case so the customer can see it. The
// endpoint therefore posts to the case table by default.
//
//   SERVICENOW_TABLE = sn_customerservice_case   (default — Table API on the case table)
//
// To use the purpose-built CSM Case API instead (runs case business rules and
// assignment), set SERVICENOW_CASE_API=/api/sn_customerservice/case; otherwise
// we hit /api/now/table/<SERVICENOW_TABLE>. Both accept the same case fields
// and return result.number (a CS… number for cases).
const SN = {
  instanceUrl: (process.env.SERVICENOW_INSTANCE_URL || "").replace(/\/+$/, ""),
  apiKey:      process.env.SERVICENOW_API_KEY || "",   // sent as x-sn-apikey header
  table:       process.env.SERVICENOW_TABLE || "sn_customerservice_case", // customer CASES, not incidents
  // Default to Cip's CSM Case API. Set SERVICENOW_CASE_API="" to fall back to
  // the Table API on SERVICENOW_TABLE instead.
  caseApi:     (process.env.SERVICENOW_CASE_API ?? "/api/sn_customerservice/case").replace(/\/+$/, ""),
};

// Rebuild a valid PEM no matter how the env var was pasted (single line,
// literal \n sequences, or spaces where newlines belong). PEM is just
// "-----BEGIN X-----", base64 in 64-char lines, "-----END X-----".
function loadPrivateKey() {
  // Prefer a key file committed to the repo (robust — no env-var mangling).
  // Set DOCUSIGN_PRIVATE_KEY_PATH=./docusign_private.key, or fall back to the
  // env var. Either way the value is normalized into valid PEM.
  const p = process.env.DOCUSIGN_PRIVATE_KEY_PATH;
  if (p) {
    try {
      const fromFile = fsReadFileSync(p, "utf8");
      if (fromFile && fromFile.trim()) return normalizePem(fromFile);
      console.error("[docusign] key file empty:", p);
    } catch (e) {
      console.error("[docusign] key file read failed:", e.message);
    }
  }
  return normalizePem(process.env.DOCUSIGN_PRIVATE_KEY || "");
}

function normalizePem(raw) {
  if (!raw) return "";
  let s = raw.replace(/\\n/g, "\n").trim();
  const m = s.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (m) {
    const label = m[1];
    const body = m[2].replace(/[^A-Za-z0-9+/=]/g, ""); // strip ALL whitespace/newlines
    const lines = body.match(/.{1,64}/g) || [];
    return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
  }
  // No armor found — if what's left looks like a bare base64 key body
  // (the BEGIN/END lines got stripped on paste), wrap it as PKCS#1 RSA.
  const bare = s.replace(/[^A-Za-z0-9+/=]/g, "");
  if (bare.length > 500 && /^MII/.test(bare)) {
    const lines = bare.match(/.{1,64}/g) || [];
    return `-----BEGIN RSA PRIVATE KEY-----\n${lines.join("\n")}\n-----END RSA PRIVATE KEY-----\n`;
  }
  return s; // give crypto the raw value and let it report the problem
}

// ---- DocuSign (NDA sending) — JWT grant, no SDK needed.
// Setup once in DocuSign Admin: create an app (integration key), generate an
// RSA keypair, grant consent for "signature impersonation", and build the NDA
// as a template with one recipient role named "Signer".
const DS = {
  authServer:     process.env.DOCUSIGN_AUTH_SERVER || "account-d.docusign.com", // account.docusign.com in prod
  baseUrl:        (process.env.DOCUSIGN_BASE_URL || "").replace(/\/+$/, ""),     // e.g. https://demo.docusign.net/restapi
  accountId:      process.env.DOCUSIGN_ACCOUNT_ID || "",
  integrationKey: process.env.DOCUSIGN_INTEGRATION_KEY || "",
  userId:         process.env.DOCUSIGN_USER_ID || "",
  privateKey:     loadPrivateKey(),
  ndaTemplateId:  process.env.DOCUSIGN_NDA_TEMPLATE_ID || "",
};

let dsToken = { value: null, exp: 0 };

function b64url(input) {
  return Buffer.from(input).toString("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getDocuSignToken() {
  if (dsToken.value && Date.now() < dsToken.exp - 60000) return dsToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: DS.integrationKey,
    sub: DS.userId,
    aud: DS.authServer,
    iat: now,
    exp: now + 3600,
    scope: "signature impersonation",
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(DS.privateKey, "base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = `${header}.${payload}.${signature}`;

  const r = await fetch(`https://${DS.authServer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const json = await r.json();
  if (!json.access_token) throw new Error("DocuSign token failed: " + JSON.stringify(json));
  dsToken = { value: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return dsToken.value;
}

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
  res.json({ service: "iris-liveavatar-backend", status: "up", endpoints: ["/health", "/avatar-session", "/crm/lead", "/crm/website-lead", "/crm/marketplace-lead"] }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Debug: shows which vars are SET (true/false) without revealing secret values.
app.get("/config", (_req, res) => res.json({
  LIVEAVATAR_API_KEY:   !!LA_KEY,
  LIVEAVATAR_SECRET_ID: !!SECRET_ID,
  LIVEAVATAR_AVATAR_ID: !!AVATAR_ID,
  ELEVENLABS_AGENT_ID:  AGENT_ID,
  LIVEAVATAR_VOICE_AGENT_ID: VOICE_AGENT_ID || "(inline agent config)",
  D365_TENANT_ID:       !!D365.tenant,
  D365_CLIENT_ID:       !!D365.clientId,
  D365_CLIENT_SECRET:   !!D365.clientSecret,
  D365_ORG_URL:         !!D365.orgUrl,
  IRIS_TOOL_SECRET:     !!D365.toolSecret,
  D365_OWNER_USER_ID:   !!D365.ownerUserId,
  D365_OWNER_TEAM_ID:   !!D365.ownerTeamId,
  ELEVENLABS_WEBHOOK_SECRET: !!EL_WEBHOOK_SECRET,
  MAILCHIMP_WEBHOOK_KEY:     !!MC_WEBHOOK_KEY,
  MIND_API_KEY:            !!process.env.MIND_API_KEY,
  SERVICENOW_INSTANCE_URL: !!SN.instanceUrl,
  SERVICENOW_API_KEY:      !!SN.apiKey,
  SERVICENOW_TABLE:        SN.table,
  SERVICENOW_CASE_API:     SN.caseApi || "(table api)",
  DOCUSIGN_BASE_URL:        !!DS.baseUrl,
  DOCUSIGN_ACCOUNT_ID:      !!DS.accountId,
  DOCUSIGN_INTEGRATION_KEY: !!DS.integrationKey,
  DOCUSIGN_USER_ID:         !!DS.userId,
  DOCUSIGN_PRIVATE_KEY:     !!DS.privateKey,
  DOCUSIGN_NDA_TEMPLATE_ID: !!DS.ndaTemplateId,
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
        avatar_id: AVATAR_ID,
        // Stored voice agent: send NO mode field — the API derives it from the
        // agent type (400: "mode=FULL does not apply to a voice_agent of type
        // 'elevenlabs_agent'; omit mode and let it derive from the agent").
        // Do NOT add per-session language/dynamic_variables either (400).
        // Legacy inline config stays on LITE as fallback.
        ...(VOICE_AGENT_ID
          ? { voice_agent: { id: VOICE_AGENT_ID } }
          : { mode: "LITE", elevenlabs_agent_config: { secret_id: SECRET_ID, agent_id: AGENT_ID } }),
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
// Shared lead creation used by both Iris (/crm/lead) and the Mailchimp webhook.
// Returns { status: "created" | "exists", ... } or throws.
function buildLeadSubject(source, topic) {
  const prefix =
    source === "mailchimp" ? "Golf Lead" :
    source === "website-form" ? "Website Lead" :
    "Iris Lead";
  return `${prefix}${topic ? ` — ${topic}` : ""}`;
}

async function createOrFindLead({ first_name, last_name, email, company, topic, conversation_id, source, details, phone }) {
  const token = await getD365Token();
  const api = `${D365.orgUrl}/api/data/v9.2`;

  const safeEmail = email.replace(/'/g, "''");
  const q = `${api}/leads?$select=leadid,subject,firstname,lastname,telephone1,companyname,cr57d_topicofinterest,cr57d_formanswers,cr57d_conversationid&$filter=emailaddress1 eq '${safeEmail}' and statecode eq 0&$top=1`;
  const dupRes = await fetch(q, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const dup = await dupRes.json();
  if (dupRes.ok && dup.value && dup.value.length) {
    const existing = dup.value[0];

    // Refresh the lead with anything new from this submission. Only fill or
    // correct — never blank out a field because the new submission omitted it.
    const patch = {};
    const isPlaceholder = (v) => !v || v === "(not provided)";
    if (first_name && first_name !== existing.firstname) patch.firstname = first_name;
    if (last_name && (isPlaceholder(existing.lastname) || last_name !== existing.lastname)) patch.lastname = last_name;
    if (phone && String(phone).trim() && String(phone).trim() !== existing.telephone1) patch.telephone1 = String(phone).trim();
    if (company && company !== existing.companyname) patch.companyname = company;
    if (topic && topic !== existing.cr57d_topicofinterest) patch.cr57d_topicofinterest = topic.slice(0, 250);
    // Refresh the Topic (subject) to the latest channel + interest so it never
    // stays frozen on a stale prefix like "Landing page lead".
    const freshSubject = buildLeadSubject(source, topic || existing.cr57d_topicofinterest);
    if (freshSubject !== existing.subject) patch.subject = freshSubject;
    // Point the lead at the LATEST conversation so the post-call webhook can
    // attach this call's summary (it matches on cr57d_conversationid).
    if (conversation_id && conversation_id !== existing.cr57d_conversationid) {
      patch.cr57d_conversationid = conversation_id;
    }
    // Always leave a stamped trace of the repeat contact in the answers history.
    const traceLines = [...(details || [])];
    if (conversation_id && conversation_id !== existing.cr57d_conversationid) {
      traceLines.push(`New conversation: ${conversation_id}`);
    }
    if (topic && topic !== existing.cr57d_topicofinterest) {
      traceLines.push(`Topic: ${topic}`);
    }
    if (traceLines.length) {
      const stamp = `--- ${source} ${new Date().toISOString().slice(0, 16)} ---`;
      const prev = existing.cr57d_formanswers ? existing.cr57d_formanswers + "\n\n" : "";
      patch.cr57d_formanswers = (prev + stamp + "\n" + traceLines.join("\n")).slice(-4000);
    }

    if (Object.keys(patch).length) {
      const up = await fetch(`${api}/leads(${existing.leadid})`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
          Accept: "application/json",
          "If-Match": "*",
        },
        body: JSON.stringify(patch),
      });
      if (!up.ok) console.error("[iris-crm] lead update failed:", up.status, await up.text());
      else console.log("[iris-crm] lead updated:", existing.leadid, "fields:", Object.keys(patch).join(","));
    }

    const knownFirst = patch.firstname || existing.firstname || first_name;
    const knownName = [patch.firstname || existing.firstname, patch.lastname || existing.lastname]
      .filter(Boolean).filter(n => n !== "(not provided)").join(" ") || knownFirst;
    return { status: "exists", first_name: knownFirst, full_name: knownName, leadid: existing.leadid, updated: Object.keys(patch) };
  }

  const subject = buildLeadSubject(source, topic);
  const origin =
    source === "mailchimp" ? "Captured from Mailchimp landing page" :
    source === "website-form" ? "Captured from website pricing form" :
    "Captured by Iris (AI assistant) on iristel.com";

  const create = await fetch(`${api}/leads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      ...(D365.ownerUserId
        ? { "ownerid@odata.bind": `/systemusers(${D365.ownerUserId})` }
        : D365.ownerTeamId
          ? { "ownerid@odata.bind": `/teams(${D365.ownerTeamId})` }
          : {}),
      subject,
      // Lead Source: Advertisement (1) for Mailchimp landing pages, Web (8) for Iris.
      leadsourcecode: source === "mailchimp" ? 1 : 8,  // Advertisement (1) vs Web (8)
      firstname: first_name,
      lastname: last_name || "(not provided)",
      emailaddress1: email,
      ...(company ? { companyname: company } : {}),
      ...(phone ? { telephone1: String(phone).trim() } : {}),
      description: `${origin} — ${new Date().toISOString()}`,
      // Structured custom fields (replaces jamming everything into description).
      cr57d_leadsourcedetail: source,                               // "iris" | "mailchimp" | ...
      ...(topic ? { cr57d_topicofinterest: topic.slice(0, 250) } : {}),
      ...(conversation_id ? { cr57d_conversationid: conversation_id } : {}),
      ...(details && details.length
        ? { cr57d_formanswers: details.join("\n").slice(0, 4000) } : {}),
      cr57d_capturedon: new Date().toISOString(),
    }),
  });
  if (!create.ok) throw new Error(`D365 create ${create.status}: ${await create.text()}`);
  const lead = await create.json();
  return { status: "created", leadid: lead.leadid };
}

// MIND (Iristel-X) account lookup by email. A hit means the person is an
// EXISTING CUSTOMER — they must never become a Lead; their interactions are
// recorded on a Contact under their Account instead (see upsertCustomerContact).
// Fails open: any error returns null so capture still lands as a lead.
const MIND_API_KEY = process.env.MIND_API_KEY || "";

async function lookupMindAccount(email) {
  if (!MIND_API_KEY || !email) return null;
  try {
    const r = await fetch(`https://api.iristelx.com/?email=${encodeURIComponent(email)}`, {
      headers: { "x-api-key": MIND_API_KEY, Accept: "application/json" },
    });
    if (!r.ok) return null;
    const json = await r.json().catch(() => null);
    // The gateway answers HTTP 200 with {statusCode:404, body:"...not found..."}
    // on a miss — that shape means "no account", not an error.
    if (!json || json.statusCode === 404 || !json.name) return null;
    return json;
  } catch (e) {
    console.warn("[iris-mind] lookup failed:", e.message);
    return null;
  }
}

// Customer path for /crm/lead: upsert a Dynamics Contact (matched by email),
// hang it off the Account named after the MIND account, and record the
// interaction (topic + discovery details) as an annotation on the contact —
// the customer-side equivalent of cr57d_formanswers on a lead.
async function upsertCustomerContact({ first_name, last_name, email, company, topic, phone, details, conversation_id, mind }) {
  const token = await getD365Token();
  const api = `${D365.orgUrl}/api/data/v9.2`;
  const H = {
    Authorization: `Bearer ${token}`,
    "content-type": "application/json",
    Accept: "application/json",
  };
  const safeEmail = email.replace(/'/g, "''");
  const accountName = String(mind.name || company || "").trim();

  // 1. Account by name (create if missing) — the MIND account name is the anchor.
  let accountId = null;
  if (accountName) {
    const safeName = accountName.replace(/'/g, "''");
    const aRes = await fetch(`${api}/accounts?$select=accountid&$filter=name eq '${safeName}'&$top=1`, { headers: H });
    const aJson = await aRes.json().catch(() => ({}));
    if (aRes.ok && aJson.value?.length) {
      accountId = aJson.value[0].accountid;
    } else {
      const aCreate = await fetch(`${api}/accounts`, {
        method: "POST",
        headers: { ...H, Prefer: "return=representation" },
        body: JSON.stringify({ name: accountName }),
      });
      if (aCreate.ok) accountId = (await aCreate.json()).accountid;
      else console.error("[iris-crm] account create failed:", aCreate.status, await aCreate.text());
    }
  }

  // 2. Contact by email: PATCH (fill/correct, never blank) or POST.
  const cRes = await fetch(
    `${api}/contacts?$select=contactid,firstname,lastname,telephone1,_parentcustomerid_value&$filter=emailaddress1 eq '${safeEmail}'&$top=1`,
    { headers: H });
  const cJson = await cRes.json().catch(() => ({}));
  let contactId = cRes.ok && cJson.value?.length ? cJson.value[0].contactid : null;

  if (contactId) {
    const existing = cJson.value[0];
    const patch = {};
    if (first_name && first_name !== existing.firstname) patch.firstname = first_name;
    if (last_name && last_name !== existing.lastname) patch.lastname = last_name;
    if (phone && String(phone).trim() && String(phone).trim() !== existing.telephone1) patch.telephone1 = String(phone).trim();
    if (accountId && existing._parentcustomerid_value !== accountId) {
      patch["parentcustomerid_account@odata.bind"] = `/accounts(${accountId})`;
    }
    if (Object.keys(patch).length) {
      const up = await fetch(`${api}/contacts(${contactId})`, {
        method: "PATCH", headers: { ...H, "If-Match": "*" }, body: JSON.stringify(patch),
      });
      if (!up.ok) console.error("[iris-crm] contact update failed:", up.status, await up.text());
    }
  } else {
    const cCreate = await fetch(`${api}/contacts`, {
      method: "POST",
      headers: { ...H, Prefer: "return=representation" },
      body: JSON.stringify({
        firstname: first_name,
        lastname: last_name || "(not provided)",
        emailaddress1: email,
        ...(phone ? { telephone1: String(phone).trim() } : {}),
        ...(accountId ? { "parentcustomerid_account@odata.bind": `/accounts(${accountId})` } : {}),
      }),
    });
    if (!cCreate.ok) throw new Error(`D365 contact create ${cCreate.status}: ${await cCreate.text()}`);
    contactId = (await cCreate.json()).contactid;
  }

  // 3. Record the interaction as a note on the contact.
  const noteLines = [
    ...(topic ? [`Topic: ${topic}`] : []),
    ...(details || []),
    ...(conversation_id ? [`Conversation: ${conversation_id}`] : []),
  ];
  if (noteLines.length) {
    const note = await fetch(`${api}/annotations`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        subject: `Iris conversation — ${new Date().toISOString().slice(0, 16)}`,
        notetext: noteLines.join("\n").slice(0, 4000),
        "objectid_contact@odata.bind": `/contacts(${contactId})`,
      }),
    });
    if (!note.ok) console.error("[iris-crm] annotation failed:", note.status, await note.text());
  }

  return { status: "customer", contactid: contactId, account_name: accountName };
}

// Browser-facing contact form on the website. Called directly from the page,
// so it is CORS-guarded (see cors() config) rather than secret-guarded — a
// shared secret can't live safely in page source. Reuses createOrFindLead.
app.post("/crm/website-lead", async (req, res) => {
  const missing = [];
  if (!D365.tenant)   missing.push("D365_TENANT_ID");
  if (!D365.orgUrl)   missing.push("D365_ORG_URL");
  if (missing.length) return res.status(500).json({ status: "error", message: "CRM not configured." });

  // The pricing-page form sends: first_name, last_name, email, phone, company,
  // product (the dropdown), message. Map product -> topic.
  const { first_name, last_name, email, company, phone, message } = req.body || {};
  const topic = (req.body && (req.body.topic || req.body.product) || "").trim();
  if (!first_name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ status: "invalid", message: "Please provide your name and a valid email." });
  }

  // Fold phone + free-text message into the form-answers field.
  const details = [];
  if (phone && String(phone).trim())   details.push(`Phone: ${String(phone).trim()}`);
  if (message && String(message).trim()) details.push(`Message: ${String(message).trim()}`);

  try {
    const r = await createOrFindLead({
      first_name, last_name, email, company, topic, phone,
      source: "website-form", details,
    });
    // Return statuses the form's success check accepts ("created" | "exists").
    if (r.status === "exists") {
      return res.json({ status: "exists", message: `Thanks ${r.first_name}, we already have your details — our team will be in touch.` });
    }
    console.log("[iris-web] lead created:", r.leadid, email, "topic:", topic || "-");
    res.json({ status: "created", message: "Thanks! Our team will reach out shortly with pricing." });
  } catch (e) {
    console.error("[iris-web] failed:", e.message);
    res.status(500).json({ status: "error", message: "Something went wrong — please try again or email sales@iristel.com." });
  }
});

// API Marketplace access request form on the partner portal (/api-marketplace).
// Browser-facing like /crm/website-lead: CORS-guarded, no shared secret.
// Writes the structured cr57d_ marketplace fields instead of stuffing the
// application details into description or form answers.
app.post("/crm/marketplace-lead", async (req, res) => {
  const missing = [];
  if (!D365.tenant) missing.push("D365_TENANT_ID");
  if (!D365.orgUrl) missing.push("D365_ORG_URL");
  if (missing.length) return res.status(500).json({ status: "error", message: "CRM not configured." });

  const {
    first_name, last_name, email, company,
    application_name, business_owner, technical_owner, business_purpose,
    environment, data_classification, requested_scopes,
  } = req.body || {};

  if (!first_name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ status: "invalid", message: "Please provide your name and a valid work email." });
  }
  if (!application_name || !String(application_name).trim()) {
    return res.status(400).json({ status: "invalid", message: "An application name is required." });
  }

  // cr57d_environment / cr57d_dataclassification are Choice (option set)
  // columns -> Dataverse expects the option's integer value, not its label.
  // Default local option-set values are assigned in creation order starting at
  // 100000000. If your columns use different values (check the column in the
  // maker portal), adjust these maps.
  const ENV_OPTIONS = {
    "sandbox": 649950000,
    "sandbox → production": 649950001,
    "sandbox -> production": 649950001,
    "production": 649950002,
  };
  const CLASS_OPTIONS = {
    "public": 649950000,
    "internal": 649950001,
    "customer confidential": 649950002,
    "restricted": 649950003,
  };
  const envValue = environment != null
    ? ENV_OPTIONS[String(environment).trim().toLowerCase()] : undefined;
  const classValue = data_classification != null
    ? CLASS_OPTIONS[String(data_classification).trim().toLowerCase()] : undefined;
  if (environment && envValue === undefined)
    console.warn("[iris-mkt] unknown environment label, skipping:", environment);
  if (data_classification && classValue === undefined)
    console.warn("[iris-mkt] unknown data classification label, skipping:", data_classification);

  // Marketplace-specific structured fields, applied on both create and repeat.
  const mkFields = {
    ...(application_name ? { cr57d_applicationname: String(application_name).trim().slice(0, 150) } : {}),
    ...(business_owner ? { cr57d_businessowner: String(business_owner).trim().slice(0, 150) } : {}),
    ...(technical_owner ? { cr57d_technicalowner: String(technical_owner).trim().slice(0, 150) } : {}),
    ...(business_purpose ? { cr57d_businesspurpose: String(business_purpose).trim().slice(0, 2000) } : {}),
    ...(envValue !== undefined ? { cr57d_environment: envValue } : {}),
    ...(classValue !== undefined ? { cr57d_dataclassification: classValue } : {}),
    ...(requested_scopes ? { cr57d_requestedscopes: String(requested_scopes).trim().slice(0, 500) } : {}),
  };

  try {
    const token = await getD365Token();
    const api = `${D365.orgUrl}/api/data/v9.2`;
    const subject = `API Marketplace request — ${String(application_name).trim().slice(0, 150)}`;

    // Dedupe on email + open lead (same rule as createOrFindLead).
    const safeEmail = email.replace(/'/g, "''");
    const q = `${api}/leads?$select=leadid&$filter=emailaddress1 eq '${safeEmail}' and statecode eq 0&$top=1`;
    const dupRes = await fetch(q, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const dup = await dupRes.json();

    if (dupRes.ok && dup.value && dup.value.length) {
      // Repeat request: refresh the open lead with the latest application
      // details (bumps modifiedon -> floats to the top of sales views).
      const leadid = dup.value[0].leadid;
      const patch = await fetch(`${api}/leads(${leadid})`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
          Accept: "application/json",
          "If-Match": "*",
        },
        body: JSON.stringify({
          subject,
          ...(company ? { companyname: company } : {}),
          cr57d_leadsourcedetail: "api-marketplace",
          cr57d_topicofinterest: "API Marketplace access",
          ...mkFields,
        }),
      });
      if (!patch.ok) throw new Error(`D365 patch ${patch.status}: ${await patch.text()}`);
      console.log("[iris-mkt] repeat request, lead updated:", leadid, email, "app:", application_name);
      return res.json({ status: "exists", message: "Request received — your existing record was updated for review." });
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
        ...(D365.ownerUserId
          ? { "ownerid@odata.bind": `/systemusers(${D365.ownerUserId})` }
          : D365.ownerTeamId
            ? { "ownerid@odata.bind": `/teams(${D365.ownerTeamId})` }
            : {}),
        subject,
        leadsourcecode: 8, // Web
        firstname: first_name,
        lastname: last_name || "(not provided)",
        emailaddress1: email,
        ...(company ? { companyname: company } : {}),
        description: `Captured from API Marketplace page (partner portal) — ${new Date().toISOString()}`,
        cr57d_leadsourcedetail: "api-marketplace",
        cr57d_topicofinterest: "API Marketplace access",
        cr57d_capturedon: new Date().toISOString(),
        ...mkFields,
      }),
    });
    if (!create.ok) throw new Error(`D365 create ${create.status}: ${await create.text()}`);
    const lead = await create.json();
    console.log("[iris-mkt] lead created:", lead.leadid, email, "app:", application_name);
    res.json({ status: "created", message: "Request submitted for review." });
  } catch (e) {
    console.error("[iris-mkt] failed:", e.message);
    res.status(500).json({ status: "error", message: "CRM save failed." });
  }
});

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

  const { first_name, last_name, email, company, topic, conversation_id, phone } = req.body || {};
  if (!first_name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      status: "invalid",
      message: "A first name and a valid email address are required.",
    });
  }

  // Discovery-survey answers arrive as one newline-separated string from the
  // ElevenLabs tool; split into the lines createOrFindLead appends to
  // cr57d_formanswers (arrays accepted too, for parity with the other routes).
  const details = typeof req.body?.details === "string"
    ? req.body.details.split("\n").map(s => s.trim()).filter(Boolean)
    : Array.isArray(req.body?.details) ? req.body.details : [];

  try {
    // Existing MIND account = existing CUSTOMER: never create a lead for them.
    // Record the interaction on a Contact under their Account instead.
    const mind = await lookupMindAccount(email);
    if (mind) {
      const c = await upsertCustomerContact({ first_name, last_name, email, company, topic, phone, details, conversation_id, mind });
      console.log("[iris-crm] customer contact:", c.contactid, email, "account:", c.account_name || "-");
      return res.json({
        status: "customer",
        first_name,
        account_name: c.account_name,
        message: `Existing customer${c.account_name ? ` — account ${c.account_name}` : ""}. Greet warmly and use existing-customer pricing. Do not mention any lookup or system.`,
      });
    }

    const r = await createOrFindLead({ first_name, last_name, email, company, topic, conversation_id, phone, source: "iris", details });
    if (r.status === "exists") {
      console.log("[iris-crm] returning customer:", email, "->", r.full_name);
      return res.json({
        status: "exists",
        first_name: r.first_name,
        full_name: r.full_name,
        message: `Returning customer — greet them warmly by name: ${r.first_name}.`,
      });
    }
    console.log("[iris-crm] lead created:", r.leadid, email);
    res.json({ status: "created", message: "Lead saved successfully. A team member will follow up." });
  } catch (e) {
    console.error("[iris-crm] failed:", e.message);
    res.status(500).json({ status: "error", message: "CRM save failed." });
  }
});

// ElevenLabs tool "update_lead" — pushes information gathered later in the
// conversation (company, phone, topic, discovery answers) onto the lead that
// create_lead opened. Reuses createOrFindLead: its exists-path fills/corrects
// fields and appends stamped detail lines to cr57d_formanswers. If no open
// lead exists for the email (earlier create failed or was skipped), it is
// created — a safe upsert, so late info is never lost.
app.post("/crm/lead/update", async (req, res) => {
  if (req.headers["x-iris-secret"] !== D365.toolSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { first_name, last_name, email, company, topic, conversation_id, phone } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      status: "invalid",
      message: "A valid email address is required to update the contact.",
    });
  }

  const details = typeof req.body?.details === "string"
    ? req.body.details.split("\n").map(s => s.trim()).filter(Boolean)
    : Array.isArray(req.body?.details) ? req.body.details : [];

  try {
    const r = await createOrFindLead({
      first_name: first_name || "(not provided)", last_name, email, company,
      topic, conversation_id, phone, source: "iris", details,
    });
    const status = r.status === "exists" ? "updated" : "created";
    console.log("[iris-crm] lead update:", status, email, "details:", details.length);
    res.json({ status, message: "Contact information saved." });
  } catch (e) {
    console.error("[iris-crm] update failed:", e.message);
    res.status(500).json({ status: "error", message: "CRM update failed." });
  }
});

// Mailchimp audience webhook -> D365 lead. Fires on new landing-page signups.
// Mailchimp probes the URL with GET during setup and expects 200.
app.get("/webhooks/mailchimp", (_req, res) => res.status(200).send("ok"));
app.post("/webhooks/mailchimp", async (req, res) => {
  if (!MC_WEBHOOK_KEY || req.query.key !== MC_WEBHOOK_KEY) {
    return res.status(401).send("unauthorized");
  }
  // Ack immediately — Mailchimp retries on non-200 and eventually disables.
  res.status(200).send("ok");

  try {
    const type = req.body.type;
    if (type !== "subscribe") { console.log("[iris-mc] ignoring event:", type); return; }

    const d = req.body.data || {};
    const m = d.merges || {};
    const email = (d.email || m.EMAIL || "").trim();
    if (!email) { console.warn("[iris-mc] subscribe event with no email"); return; }

    // Field mapping: prefer FNAME/LNAME; fall back to a full-name field split.
    let first_name = (m.FNAME || "").trim();
    let last_name  = (m.LNAME || "").trim();
    if (!first_name) {
      const full = (m.NAME || m.FULLNAME || m.MMERGE1 || "").trim();
      if (full) { const parts = full.split(/\s+/); first_name = parts.shift(); last_name = parts.join(" "); }
    }
    if (!first_name) first_name = email.split("@")[0]; // last resort — never drop a lead

    const company = (m.COMPANY || m.MMERGE3 || "").trim();

    // Checkbox/radio answers arrive as GROUPINGS: [{ name, groups: "A, B" }, ...]
    const groupings = Array.isArray(m.GROUPINGS) ? m.GROUPINGS : [];
    const answered = groupings
      .map(g => ({ name: (g.name || "").trim(), groups: (g.groups || "").trim() }))
      .filter(g => g.name && g.groups);

    // Topic priority: explicit TOPIC/INTEREST merge field, then the product-interest
    // question, then the challenge question, then the first answered group.
    const byName = (frag) => answered.find(g => g.name.toLowerCase().includes(frag));
    const topic =
      (m.TOPIC || m.INTEREST || "").trim() ||
      (byName("product")?.groups) ||
      (byName("challenge")?.groups) ||
      (answered[0]?.groups) || "";

    // Description details: every answered group question, plus any non-empty
    // merge field we don't already map elsewhere. New form fields flow through
    // automatically — no code change needed when the form evolves.
    const SKIP = new Set(["EMAIL", "FNAME", "LNAME", "COMPANY", "GROUPINGS", "INTERESTS", "TOPIC"]);
    const details = [
      ...answered.map(g => `${g.name}: ${g.groups}`),
      ...Object.entries(m)
        .filter(([k, v]) => !SKIP.has(k) && typeof v === "string" && v.trim())
        .map(([k, v]) => `${k}: ${v.trim()}`),
    ];

    const result = await createOrFindLead({
      first_name, last_name, email, company, topic, source: "mailchimp", details,
    });
    console.log("[iris-mc]", result.status, email, "topic:", topic || "-", "details:", details.length);
  } catch (e) {
    console.error("[iris-mc] failed:", e.message);
  }
});

// Resolve a ServiceNow customer_contact (and its account) from an email, so
// the case can be LINKED to the real customer record instead of only naming
// them in the description. Returns { contact, account } sys_ids, or {} if no
// match / lookup fails. Best-effort — never blocks case creation.
async function lookupSnContact(email) {
  if (!email) return {};
  try {
    const q = `${SN.instanceUrl}/api/now/table/customer_contact` +
      `?sysparm_query=email=${encodeURIComponent(email)}` +
      `&sysparm_fields=sys_id,account&sysparm_limit=1`;
    const r = await fetch(q, {
      headers: { "x-sn-apikey": SN.apiKey, Accept: "application/json" },
    });
    if (!r.ok) {
      console.warn("[iris-sn] contact lookup failed:", r.status);
      return {};
    }
    const json = await r.json().catch(() => ({}));
    const row = json.result?.[0];
    if (!row) return {};
    // account may be a reference object { value } or a bare sys_id string.
    const account = row.account?.value || row.account || "";
    return { contact: row.sys_id, account: account || undefined };
  } catch (e) {
    console.warn("[iris-sn] contact lookup error:", e.message);
    return {};
  }
}

// ElevenLabs webhook tool "create_support_ticket" calls this before a live
// escalation, so the CASE exists WITH context before any human handoff.
//
// Creates a customer-facing CSM CASE (sn_customerservice_case), NOT an
// incident. Incidents are internal-only and never shown to the customer; a
// support request the customer opens must be a Case so they can see it in the
// portal. Table used is configurable via SERVICENOW_TABLE (defaults to the
// case table); set SERVICENOW_CASE_API to hit the CSM Case API instead.
app.post("/support/ticket", async (req, res) => {
  if (req.headers["x-iris-secret"] !== D365.toolSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const {
    first_name, last_name, email, company,
    issue_summary, urgency, conversation_id,
  } = req.body || {};

  if (!issue_summary) {
    return res.status(400).json({ status: "invalid", message: "An issue summary is required." });
  }

  const contact = [
    [first_name, last_name].filter(Boolean).join(" "),
    email, company,
  ].filter(Boolean).join(" | ") || "not provided";

  const description =
    `Escalated by Iris (AI assistant) on iristel.com — ${new Date().toISOString()}\n` +
    `Contact: ${contact}\n` +
    (conversation_id ? `Conversation: ${conversation_id}\n` : "") +
    `\nISSUE\n${issue_summary}`;

  // ServiceNow not wired yet -> queue mode: log everything, promise follow-up.
  if (!SN.instanceUrl || !SN.apiKey) {
    console.log("[iris-sn] QUEUED (ServiceNow not configured):\n" + description);
    return res.json({
      status: "queued",
      message: "The support request was recorded and the team will follow up by email.",
    });
  }

  // Target URL: CSM Case API if configured, else the Table API on the case table.
  const url = SN.caseApi
    ? `${SN.instanceUrl}${SN.caseApi}`
    : `${SN.instanceUrl}/api/now/table/${SN.table}`;

  // Try to link the case to an existing customer_contact by email. Best-effort:
  // if no match (or the lookup fails), the case is still created — the contact's
  // name/email remain in the description.
  const { contact: contactSysId, account: accountSysId } = await lookupSnContact(email);
  if (contactSysId) console.log("[iris-sn] linked contact:", contactSysId, accountSysId ? `(account ${accountSysId})` : "");

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "x-sn-apikey": SN.apiKey,
        "content-type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        short_description: `Iris escalation: ${issue_summary.slice(0, 120)}`,
        description,
        // Case priority: 1 Critical … 4 Low. Map from the caller's urgency.
        priority: urgency === "high" ? "1" : urgency === "low" ? "4" : "3",
        // "web" is the value real Iristel cases use (see CS0014673); "chat" may
        // not be a valid contact_type choice on this instance.
        contact_type: "web",
        // Link to the real customer record when we resolved one by email.
        ...(contactSysId ? { contact: contactSysId } : {}),
        ...(accountSysId ? { account: accountSysId } : {}),
      }),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Surface ServiceNow's own error so auth/field problems are self-explanatory
      // (e.g. "User is not authenticated" = the API key's REST API Access Policy
      // doesn't cover this endpoint — a ServiceNow-side fix, not a code change).
      const snError = json?.error?.message || json?.error?.detail || JSON.stringify(json);
      console.error("[iris-sn] case create failed:", r.status, snError);
      return res.status(502).json({
        status: "error",
        message: "Case creation failed.",
        servicenow_status: r.status,
        servicenow_error: snError,
      });
    }
    const number = json.result?.number;
    console.log("[iris-sn] case created:", number, "conv:", conversation_id || "-");
    res.json({
      status: "created",
      ticket_number: number,
      message: `Support case ${number} was created. A specialist will follow up.`,
    });
  } catch (e) {
    console.error("[iris-sn] failed:", e.message);
    res.status(500).json({ status: "error", message: "Case creation failed." });
  }
});

// ElevenLabs webhook tool "send_nda" calls this to email the partner NDA
// for signature via DocuSign, gating partner/wholesale pricing.
app.post("/nda/send", async (req, res) => {
  if (req.headers["x-iris-secret"] !== D365.toolSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { first_name, last_name, email, company, conversation_id } = req.body || {};
  if (!first_name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      status: "invalid",
      message: "A first name and a valid email address are required.",
    });
  }

  const fullName = [first_name, last_name].filter(Boolean).join(" ");

  // DocuSign not wired yet -> queue mode.
  const dsMissing = !DS.baseUrl || !DS.accountId || !DS.integrationKey ||
                    !DS.userId || !DS.privateKey || !DS.ndaTemplateId;
  if (dsMissing) {
    console.log("[iris-nda] QUEUED (DocuSign not configured):", fullName, email,
      company || "-", "conv:", conversation_id || "-");
    return res.json({
      status: "queued",
      message: "The NDA request was recorded — the team will send it by email shortly.",
    });
  }

  try {
    const token = await getDocuSignToken();
    const r = await fetch(`${DS.baseUrl}/v2.1/accounts/${DS.accountId}/envelopes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        templateId: DS.ndaTemplateId,
        templateRoles: [{
          roleName: "Signer",
          name: fullName,
          email,
        }],
        emailSubject: "Iristel Partner NDA for signature",
        status: "sent", // sends the signing email immediately
      }),
    });
    const json = await r.json();
    if (!r.ok) {
      console.error("[iris-nda] envelope failed:", r.status, JSON.stringify(json));
      return res.status(502).json({ status: "error", message: "NDA sending failed." });
    }
    console.log("[iris-nda] envelope sent:", json.envelopeId, "to", email,
      "conv:", conversation_id || "-");
    res.json({
      status: "sent",
      message: `The NDA is on its way to ${email} for signature via DocuSign.`,
    });
  } catch (e) {
    console.error("[iris-nda] failed:", e.message);
    res.status(500).json({ status: "error", message: "NDA sending failed." });
  }
});

// ElevenLabs webhook tool "check_nda_status" calls this to see whether a
// customer's NDA has been signed, keyed by their email address.
app.post("/nda/status", async (req, res) => {
  if (req.headers["x-iris-secret"] !== D365.toolSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ status: "invalid", message: "A valid email address is required." });
  }

  const dsMissing = !DS.baseUrl || !DS.accountId || !DS.integrationKey || !DS.userId || !DS.privateKey;
  if (dsMissing) {
    console.log("[iris-nda] status check QUEUED (DocuSign not configured):", email);
    return res.json({ status: "unknown", message: "Unable to check signature status right now." });
  }

  try {
    const token = await getDocuSignToken();
    // Search the last 90 days for envelopes whose recipient email matches.
    const from = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const url = `${DS.baseUrl}/v2.1/accounts/${DS.accountId}/envelopes` +
      `?from_date=${from}&search_text=${encodeURIComponent(email)}` +
      `&include=recipients&order=desc&order_by=last_modified`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const json = await r.json();
    if (!r.ok) {
      console.error("[iris-nda] status search failed:", r.status, JSON.stringify(json));
      return res.status(502).json({ status: "unknown", message: "Couldn't check signature status." });
    }

    const envelopes = json.envelopes || [];
    if (!envelopes.length) {
      return res.json({ status: "none", signed: false, message: "No NDA was found for this email — none has been sent yet." });
    }

    // Most recent envelope for this recipient.
    const env = envelopes[0];
    const signed = env.status === "completed";
    console.log("[iris-nda] status for", email, "->", env.status);

    res.json({
      status: signed ? "signed" : "pending",
      signed,
      envelope_status: env.status, // completed | sent | delivered | declined | voided ...
      message: signed
        ? "The NDA is signed and complete — partner pricing can be shared."
        : `The NDA has been sent but is not signed yet (currently: ${env.status}).`,
    });
  } catch (e) {
    console.error("[iris-nda] status failed:", e.message);
    res.status(500).json({ status: "unknown", message: "Couldn't check signature status." });
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

    // Attach the AI-generated summary only — not the full transcript.
    const summary = data.analysis?.transcript_summary || "";
    const durationSecs = data.metadata?.call_duration_secs;

    // Nothing worth attaching if there's no summary.
    if (!summary) {
      console.log("[iris-crm] webhook: no summary for conversation", convId, "— skipping note");
      return;
    }

    let noteText =
      `SUMMARY\n${summary}` +
      (durationSecs ? `\n\nDuration: ${Math.round(durationSecs / 60)} min ${durationSecs % 60} s` : "");
    // Annotation notetext is capped; keep a wide margin.
    if (noteText.length > 90000) noteText = noteText.slice(0, 90000) + "\n[truncated]";

    const token = await getD365Token();
    const api = `${D365.orgUrl}/api/data/v9.2`;

    // Find the lead stamped with this conversation id.
    // Prefer the structured field; fall back to the legacy [conv:] description tag
    // for leads created before the field migration.
    const safeConv = String(convId).replace(/'/g, "''");
    const q = `${api}/leads?$select=leadid&$filter=` +
      `cr57d_conversationid eq '${safeConv}' or contains(description,'[conv:${safeConv}]')&$top=1`;
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
