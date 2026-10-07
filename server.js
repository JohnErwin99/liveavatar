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
  res.json({ service: "iris-liveavatar-backend", status: "up", endpoints: ["/health", "/avatar-session", "/crm/lead", "/crm/quote", "/crm/website-lead", "/crm/marketplace-lead"] }));

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
  QUOTE_PRICE_LIST_ID:          !!QUOTE.priceListId,
  QUOTE_PRICE_LIST_EXISTING_ID: !!QUOTE.priceListExistingId,
  QUOTE_OWNER_USER_ID:          !!QUOTE.ownerUserId,
  QUOTE_DEFAULT_TEMPLATE:       QUOTE.defaultTemplate,
  QUOTE_PRODUCT_OVERRIDES:      Object.keys(QUOTE_PRODUCT_OVERRIDES).length,
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

// ---- Quotes in Dynamics 365 (Iris-Sales) — replaces NiftyQuoter ----
// Iris calls create_quote once; the server finds/creates the account + contact,
// builds the quote on the price list, renders the PDF from the developer's
// quote Word template, attaches it, and leaves a review task for sales.
// Quotes are drafts: a rep reviews and sends them from Iris-Sales.
const QUOTE = {
  priceListId:         process.env.QUOTE_PRICE_LIST_ID || "",
  priceListExistingId: process.env.QUOTE_PRICE_LIST_EXISTING_ID || "",
  currencyId:          process.env.QUOTE_CURRENCY_ID || "cb89c237-08c9-f011-8543-000d3af4e871", // CAD
  ownerUserId:         process.env.QUOTE_OWNER_USER_ID || "",
  defaultTemplate:     process.env.QUOTE_DEFAULT_TEMPLATE || "Print quote for customer",
};
// Testing only: {"sc_pro_new":"TEST-PRD-01", ...} points catalog ids at other
// D365 product numbers until the real products are published.
const QUOTE_PRODUCT_OVERRIDES = (() => {
  try { return JSON.parse(process.env.QUOTE_PRODUCT_OVERRIDES || "{}"); }
  catch { console.warn("[iris-quote] QUOTE_PRODUCT_OVERRIDES is not valid JSON — ignored"); return {}; }
})();

// Iris catalog id -> D365 product number, friendly name, catalog price (used
// only for a write-in line when the product isn't active on the price list),
// line description, and which quote template family it belongs to.
const QUOTE_PRODUCTS = {
  sc_essentials_new: { pn: "BNDL1", name: "Essentials Smart Connect Bundle", price: 25, family: "webex",
    desc: "Cloud Calling, Webex Basic, Standard Call Recording, Virtual Fax, Eset Cybersecurity Training, Smarter Messaging Entry" },
  sc_pro_new: { pn: "BNDL2", name: "Pro Smart Connect Bundle", price: 45, family: "webex",
    desc: "Cloud Calling, Standard Webex, Unified Capture Call Recording, Virtual Fax, Eset Cybersecurity Protect Advanced, Smarter Messaging Growth" },
  sc_premium_new: { pn: "BNDL3", name: "Premium Smart Connect Bundle", price: 75, family: "webex",
    desc: "Cloud Calling, Standard Webex, Insights & AI Call Recording, Virtual Fax, Eset Cybersecurity Protect Advanced + training, Smarter Messaging Ultimate" },
  sc_essentials: { pn: "BNDL1", name: "Essentials Smart Connect Bundle (existing customer)", price: 23, family: "webex",
    desc: "Cloud Calling, Standard Webex or Teams, Standard Call Recording, Virtual Fax, Cybersecurity Training, IP Vulnerability Scan, SMS" },
  sc_pro: { pn: "BNDL2", name: "Pro Smart Connect Bundle (existing customer)", price: 33, family: "webex",
    desc: "Cloud Calling, Standard Webex or Teams, Unified Capture Call Recording, Virtual Fax 50pg, Cybersecurity Training, SMS 100 outgoing, IP Scan" },
  sc_premium: { pn: "BNDL3", name: "Premium Smart Connect Bundle (existing customer)", price: 63, family: "webex",
    desc: "Cloud Calling, Standard Webex or Teams, Insights & AI Call Recording, Virtual Fax 200pg, Cybersecurity Training, SMS 300 outgoing, IP Scan" },
  pbx_unite: { pn: "CC1", name: "Iristel Unite", price: 20, family: "webex", desc: "Cloud Voice, Unlimited Canada & US Calling, DID, Auto Attendant, BLF" },
  pbx_webex_basic: { pn: "CC2", name: "Iristel Unite with Webex Basic", price: 24, family: "webex", desc: "Cloud Voice + Webex Softphone, Messaging, File Sharing" },
  pbx_webex_standard: { pn: "CC3", name: "Iristel Unite with Webex Standard", price: 29, family: "webex", desc: "Cloud Voice + Webex, Meeting Room (25 capacity)" },
  pbx_webex_premium: { pn: "CC4", name: "Iristel Unite with Webex Premium", price: 46, family: "webex", desc: "Cloud Voice + Webex, Meeting Room (1000 capacity)" },
  pbx_common_area: { pn: "CC5", name: "Common Area Extension", price: 10, family: "webex" },
  pbx_auto_attendant: { pn: "CC6", name: "Auto-Attendant", price: 30, family: "webex" },
  pbx_aa_activation: { pn: null, name: "Auto-Attendant Activation (one-time)", price: 50, family: "webex" },
  pbx_call_queue_basic: { pn: "CC8", name: "Call Queue Basic (per agent)", price: 10, family: "webex" },
  pbx_call_queue_premium: { pn: "CC9", name: "Call Queue Premium (per agent)", price: 20, family: "webex" },
  pbx_virtual_fwd: { pn: "CC10", name: "Virtual Number with Call Forwarding", price: 10, family: "webex" },
  pbx_virtual_vm: { pn: "CC11", name: "Virtual Number with Voicemail", price: 15, family: "webex" },
  pbx_hunt_group: { pn: "CC12", name: "Hunt Group", price: 5, family: "webex" },
  pbx_sms_webex: { pn: null, name: "SMS on Webex", price: 7, family: "webex" },
  pbx_key_system: { pn: "CC13", name: "Key System User", price: 10, family: "webex" },
  pbx_cloud_connect: { pn: "CCI1", name: "Cloud Connect for Webex Calling", price: 10, family: "webex" },
  pbx_user_activation: { pn: "CC7", name: "User Activation (one-time, per user)", price: 25, family: "webex" },
  cc_core_voice: { pn: "CON1", name: "Cloud Contact Center — Core Voice", price: 80, family: "contact", desc: "Manage all Inbound, Outbound, and Blended campaigns" },
  cc_omni_channel: { pn: "CON2", name: "Cloud Contact Center — Omni Channel", price: 110, family: "contact", desc: "Manage all interactions across every channel with the Unified Inbox" },
  cc_setup_fee: { pn: "CON3", name: "Cloud Contact Center Set Up (one-time)", price: 4000, family: "contact" },
  cc_recording_ai: { pn: "CON4", name: "Cloud Contact Call Recording AI", price: 7, family: "contact" },
  cc_custom_dev: { pn: "CON5", name: "Custom Development (per hour)", price: 200, family: "contact" },
};
// Quote Word templates by family (name prefix; the highest active "vN" wins,
// so a new version is picked up without a code change). Families without a
// template — and the SIP / Teams templates, kept for products added later —
// fall back to QUOTE.defaultTemplate.
const QUOTE_TEMPLATE_PREFIX = {
  webex: "Iristel Unite with Webex",
  sip: "Iristel SIP Channel Service",
  teams: "Iristel Operator Connect for Teams",
};

async function d365(method, path, body, headers) {
  const token = await getD365Token();
  const r = await fetch(`${D365.orgUrl}/api/data/v9.2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "content-type": "application/json",
      "OData-MaxVersion": "4.0", "OData-Version": "4.0",
      ...(headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, json, text };
}
const odq = (s) => String(s).replace(/'/g, "''");
const must = (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r; };

// MIND account -> CRM fields. The email lookup's field names are mapped
// defensively (the gateway has returned both flat and nested shapes).
function mindDetails(mind) {
  const c = mind.contact || {};
  const pick = (...v) => v.map((x) => (x == null ? "" : String(x).trim())).find(Boolean) || "";
  const phone = typeof c.phone === "object" && c.phone
    ? pick(c.phone.mobile, c.phone.work, c.phone.home) : pick(c.phone, mind.phone, mind.telephoneNumber);
  return {
    number: pick(mind.accountId, mind.account_code, mind.accountCode, mind.code),
    name: pick(mind.name),
    firstname: pick(c.fname, c.firstName, mind.fname),
    lastname: pick(c.lname, c.lastName, mind.lname),
    phone,
    address1: pick(c.address1, mind.address1, mind.address && mind.address.line1),
    city: pick(c.city, mind.city, mind.address && mind.address.city),
    province: pick(c.province, mind.province, mind.address && mind.address.province),
    postalCode: pick(c.postalCode, mind.postalCode, mind.address && mind.address.postalCode),
    country: pick(c.country, mind.country, mind.address && mind.address.country),
  };
}
const dropEmpty = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === "") delete o[k]; return o; };

// Upsert the contact by email, link it to the account, make it primary.
async function linkQuoteContact(accountId, existing, email, f) {
  const fields = dropEmpty({
    firstname: f.firstname, lastname: f.lastname, telephone1: f.phone,
    "parentcustomerid_account@odata.bind": `/accounts(${accountId})`,
  });
  let contactId;
  if (existing) {
    contactId = existing.contactid;
    must(await d365("PATCH", `/contacts(${contactId})`, fields, { "If-Match": "*" }), "contact update");
  } else {
    const r = await d365("POST", "/contacts", {
      ...fields, emailaddress1: email, lastname: f.lastname || "(not provided)",
      description: "Created by Iris for a quote request",
    }, { Prefer: "return=representation" });
    contactId = must(r, "contact create").json.contactid;
  }
  must(await d365("PATCH", `/accounts(${accountId})`, { "primarycontactid@odata.bind": `/contacts(${contactId})` }, { "If-Match": "*" }),
    "primary contact");
  return contactId;
}

// Who is the quote for? Three paths, decided from the confirmed email:
//   crm  — already in Dynamics (contact's account, or account by email / MIND number)
//   mind — an Iristel (MIND) customer with no CRM account: create it from MIND
//   lead — a new prospect: create/reuse the lead and qualify it to an
//          opportunity (Dynamics can't put a quote on a lead directly)
async function resolveQuoteCustomer({ first_name, last_name, email, company, phone, topic, conversation_id }) {
  const typed = { firstname: first_name, lastname: last_name, phone: phone ? String(phone).trim() : "" };

  // 1. CRM by email.
  const c = must(await d365("GET", `/contacts?$select=contactid,_parentcustomerid_value&$filter=emailaddress1 eq '${odq(email)}'&$top=1`), "contact lookup");
  const contact = c.json.value[0];
  let accountId = contact && contact._parentcustomerid_value;
  if (accountId && !(await d365("GET", `/accounts(${accountId})?$select=accountid`)).ok) accountId = null; // parent may be a contact
  if (!accountId) {
    const a = must(await d365("GET", `/accounts?$select=accountid&$filter=emailaddress1 eq '${odq(email)}'&$top=1`), "account lookup");
    accountId = a.json.value[0] && a.json.value[0].accountid;
  }

  // 2. MIND (email check); its account number can also find the CRM account.
  const mind = await lookupMindAccount(email);
  const m = mind ? mindDetails(mind) : null;
  if (!accountId && m && m.number) {
    const a = await d365("GET", `/accounts?$select=accountid&$filter=cr57d_mindaccountnumber eq '${odq(m.number)}'&$top=1`);
    accountId = a.ok && a.json.value[0] && a.json.value[0].accountid;
  }

  if (accountId) {
    const acc = must(await d365("GET", `/accounts(${accountId})?$select=name`), "account read").json;
    const contactId = await linkQuoteContact(accountId, contact, email, typed);
    // A prospect whose lead was already qualified: keep quoting on that
    // still-open opportunity so sales sees every quote in one place.
    const open = await openLeadOpportunity(email);
    if (open && open.o._parentaccountid_value === accountId) {
      return { ...(await quoteFromOpportunity(open.leadId, open.opportunityId, open.o, null, email)), path: "lead" };
    }
    return { path: "crm", accountId, contactId, accountName: acc.name, isCustomer: !!m };
  }

  if (m) {
    const name = m.name || company || [first_name, last_name].filter(Boolean).join(" ") || email;
    const a = await d365("POST", "/accounts", dropEmpty({
      name, emailaddress1: email,
      telephone1: m.phone || typed.phone,
      address1_line1: m.address1, address1_city: m.city, address1_stateorprovince: m.province,
      address1_postalcode: m.postalCode, address1_country: m.country,
      cr57d_mindaccountnumber: m.number,
      description: `Created by Iris from MIND account${m.number ? " " + m.number : ""}`,
    }), { Prefer: "return=representation" });
    accountId = must(a, "account create").json.accountid;
    const contactId = await linkQuoteContact(accountId, contact, email, {
      firstname: m.firstname || typed.firstname, lastname: m.lastname || typed.lastname, phone: m.phone || typed.phone,
    });
    return { path: "mind", accountId, contactId, accountName: name, isCustomer: true };
  }

  // 3. New prospect. A lead already qualified for this email reuses its opportunity.
  const open = await openLeadOpportunity(email);
  if (open) return quoteFromOpportunity(open.leadId, open.opportunityId, open.o, company, email);
  const lead = await createOrFindLead({
    first_name: first_name || "(not provided)", last_name, email, company, phone, topic,
    conversation_id, source: "iris", details: [],
  });
  // Qualification makes the account from the lead's company name.
  if (company) {
    must(await d365("PATCH", `/leads(${lead.leadid})`, { companyname: company }, { "If-Match": "*" }), "lead company");
  }
  const qr = await d365("POST", `/leads(${lead.leadid})/Microsoft.Dynamics.CRM.QualifyLead`, {
    CreateAccount: !!company, CreateContact: true, CreateOpportunity: true, Status: 3,
    OpportunityCurrencyId: { "@odata.type": "Microsoft.Dynamics.CRM.transactioncurrency", transactioncurrencyid: QUOTE.currencyId },
    SuppressDuplicateDetection: true,
  });
  must(qr, "lead qualify");
  const made = (qr.json && qr.json.value) || [];
  const opp = made.find((x) => x.opportunityid);
  if (!opp) throw new Error("lead qualify: no opportunity returned");
  const o = must(await d365("GET", `/opportunities(${opp.opportunityid})?$select=statecode,_parentaccountid_value,_parentcontactid_value,_customerid_value`), "opportunity read").json;
  return quoteFromOpportunity(lead.leadid, opp.opportunityid, o, company, email);
}

// The still-open opportunity of this email's most recent qualified lead, if any.
async function openLeadOpportunity(email) {
  const q = await d365("GET", `/leads?$select=leadid,_qualifyingopportunityid_value&$filter=emailaddress1 eq '${odq(email)}' and statecode eq 1 and _qualifyingopportunityid_value ne null&$orderby=modifiedon desc&$top=1`);
  const lead = q.ok && q.json.value[0];
  if (!lead) return null;
  const r = await d365("GET", `/opportunities(${lead._qualifyingopportunityid_value})?$select=statecode,_parentaccountid_value,_parentcontactid_value,_customerid_value`);
  if (!r.ok || r.json.statecode !== 0) return null;
  return { leadId: lead.leadid, opportunityId: lead._qualifyingopportunityid_value, o: r.json };
}

async function quoteFromOpportunity(leadId, opportunityId, o, company, email) {
  const accountId = o._parentaccountid_value || null;
  const contactId = o._parentcontactid_value || null;
  let accountName = company || email;
  if (accountId) {
    const a = await d365("GET", `/accounts(${accountId})?$select=name`);
    if (a.ok) accountName = a.json.name;
  }
  return { path: "lead", leadId, opportunityId, accountId, contactId, accountName, isCustomer: false };
}

// Is this product active and on the price list? Returns { productId, uomId } or null.
async function quotePriceListProduct(productNumber, priceListId) {
  if (!productNumber) return null;
  const p = await d365("GET", `/products?$select=productid,statecode,_defaultuomid_value&$filter=productnumber eq '${odq(productNumber)}' and statecode eq 0&$top=1`);
  const prod = p.ok && p.json.value[0];
  if (!prod) return null;
  const ppl = await d365("GET", `/productpricelevels?$select=_uomid_value&$filter=_productid_value eq ${prod.productid} and _pricelevelid_value eq ${priceListId}&$top=1`);
  const item = ppl.ok && ppl.json.value[0];
  if (!item) return null;
  return { productId: prod.productid, uomId: item._uomid_value || prod._defaultuomid_value };
}

// Highest active version of a quote template whose name starts with prefix.
async function quoteTemplateId(prefix) {
  const r = await d365("GET", `/documenttemplates?$select=documenttemplateid,name&$filter=associatedentitytypecode eq 'quote' and status eq false and startswith(name,'${odq(prefix)}')`);
  if (!r.ok || !r.json.value.length) return null;
  const ver = (n) => +((String(n).match(/v(\d+)\s*$/i) || [])[1] || 0);
  return r.json.value.sort((a, b) => ver(b.name) - ver(a.name))[0];
}

// Render the quote PDF from a Word template and attach it to the quote as a note.
async function attachQuotePdf(quoteId, template, fileName) {
  const r = await d365("POST", "/ExportPdfDocument", {
    EntityTypeCode: 1084,
    SelectedTemplate: { "@odata.type": "Microsoft.Dynamics.CRM.documenttemplate", documenttemplateid: template.documenttemplateid },
    SelectedRecords: JSON.stringify([quoteId]),
  });
  must(r, "PDF export");
  const pdf = r.json && r.json.PdfFile;
  if (!pdf) throw new Error("PDF export returned no file");
  must(await d365("POST", "/annotations", {
    subject: `Quote PDF — ${template.name}`,
    notetext: "Generated by Iris from the quote template. Review, then send to the customer.",
    filename: fileName, mimetype: "application/pdf", documentbody: pdf,
    "objectid_quote@odata.bind": `/quotes(${quoteId})`,
  }), "PDF attach");
}

async function createQuote({ first_name, last_name, email, company, phone, customer_type, items, notes, conversation_id }) {
  const products = items.map((i) => ({ ...QUOTE_PRODUCTS[i.product], id: i.product, quantity: i.quantity }));
  const who = await resolveQuoteCustomer({
    first_name, last_name, email, company, phone, conversation_id,
    topic: `Quote request — ${[...new Set(products.map((p) => p.name))].join(", ")}`.slice(0, 250),
  });
  const { accountId, contactId, accountName } = who;
  // Existing-customer pricing when Iris says so or MIND confirms it.
  const existing = customer_type === "existing" || who.isCustomer;
  const priceListId = (existing && QUOTE.priceListExistingId) || QUOTE.priceListId;
  const pathNote = {
    crm: "Existing CRM customer.",
    mind: "Iristel (MIND) customer — CRM account created from MIND.",
    lead: "New prospect — lead qualified to an opportunity.",
  }[who.path];
  if (who.opportunityId) {
    // The opportunity carries the same price list as the quote.
    const up = await d365("PATCH", `/opportunities(${who.opportunityId})`,
      { "pricelevelid@odata.bind": `/pricelevels(${priceListId})` }, { "If-Match": "*" });
    if (!up.ok) console.warn("[iris-quote] opportunity price list:", up.status, up.text.slice(0, 200));
  }
  const title = `${accountName} Quote — ${[...new Set(products.map((p) => p.name))].join(", ")}`.slice(0, 300);
  const owner = QUOTE.ownerUserId ? { "ownerid@odata.bind": `/systemusers(${QUOTE.ownerUserId})` }
    : D365.ownerUserId ? { "ownerid@odata.bind": `/systemusers(${D365.ownerUserId})` }
    : D365.ownerTeamId ? { "ownerid@odata.bind": `/teams(${D365.ownerTeamId})` } : {};
  const q = await d365("POST", "/quotes", {
    name: title,
    ...(accountId ? { "customerid_account@odata.bind": `/accounts(${accountId})` }
      : { "customerid_contact@odata.bind": `/contacts(${contactId})` }),
    ...(who.opportunityId ? { "opportunityid@odata.bind": `/opportunities(${who.opportunityId})` } : {}),
    "pricelevelid@odata.bind": `/pricelevels(${priceListId})`,
    "transactioncurrencyid@odata.bind": `/transactioncurrencies(${QUOTE.currencyId})`,
    ...owner,
    description: [
      `Created by Iris (AI assistant) for ${[first_name, last_name].filter(Boolean).join(" ")} <${email}>.`,
      pathNote,
      ...(who.leadId ? [`Lead: ${who.leadId}`] : []),
      ...(who.opportunityId ? [`Opportunity: ${who.opportunityId}`] : []),
      ...(conversation_id ? [`Conversation: ${conversation_id}`] : []),
      ...(notes ? [`Notes: ${notes}`] : []),
    ].join("\n").slice(0, 2000),
  }, { Prefer: "return=representation" });
  const quote = must(q, "quote create").json;

  const lines = [];
  const writeIns = [];
  for (const p of products) {
    const pn = QUOTE_PRODUCT_OVERRIDES[p.id] || p.pn;
    const onList = await quotePriceListProduct(pn, priceListId);
    const line = onList
      ? { "productid@odata.bind": `/products(${onList.productId})`, "uomid@odata.bind": `/uoms(${onList.uomId})` }
      : { isproductoverridden: true, productdescription: p.name, ispriceoverridden: true, priceperunit: p.price };
    if (!onList) writeIns.push(p.name);
    const d = await d365("POST", "/quotedetails", {
      "quoteid@odata.bind": `/quotes(${quote.quoteid})`,
      quantity: p.quantity,
      ...line,
      ...(p.desc || !onList ? { description: [p.desc, !onList ? "Price to confirm — product not yet on the price list." : null].filter(Boolean).join("\n") } : {}),
    }, { Prefer: "return=representation" });
    const row = must(d, `line ${p.name}`).json;
    lines.push({ name: p.name, quantity: p.quantity, unit_price: row.priceperunit, amount: row.extendedamount });
  }

  // PDF(s) from the developer's templates — one per product family present.
  const pdfNotes = [];
  const families = [...new Set(products.map((p) => p.family))];
  const templates = new Map();
  for (const f of families) {
    const t = (QUOTE_TEMPLATE_PREFIX[f] && await quoteTemplateId(QUOTE_TEMPLATE_PREFIX[f])) || await quoteTemplateId(QUOTE.defaultTemplate);
    if (t) templates.set(t.documenttemplateid, t);
    else pdfNotes.push(`No quote template found for ${f} products.`);
  }
  for (const t of templates.values()) {
    try {
      await attachQuotePdf(quote.quoteid, t, `${quote.quotenumber} - ${accountName}${templates.size > 1 ? ` - ${t.name}` : ""}.pdf`.replace(/[\\/:*?"<>|]/g, " "));
    } catch (e) {
      console.error("[iris-quote] PDF failed:", t.name, e.message);
      pdfNotes.push(`PDF from "${t.name}" failed: ${e.message.slice(0, 200)}`);
    }
  }

  const totals = await d365("GET", `/quotes(${quote.quoteid})?$select=totalamount,quotenumber`);
  const total = totals.ok ? totals.json.totalamount : null;

  // Review task so a rep picks it up.
  const task = await d365("POST", "/tasks", {
    subject: `Review & send Iris quote ${quote.quotenumber} to ${email}`.slice(0, 200),
    description: [
      `Iris built this quote for ${accountName} (${email}). Check the lines and the attached PDF, then send it to the customer.`,
      pathNote,
      ...(writeIns.length ? [`Write-in lines (not on the price list yet — confirm price): ${writeIns.join(", ")}`] : []),
      ...pdfNotes,
    ].join("\n"),
    "regardingobjectid_quote@odata.bind": `/quotes(${quote.quoteid})`,
    ...owner,
  });
  if (!task.ok) console.error("[iris-quote] task create failed:", task.status, task.text.slice(0, 300));

  return { path: who.path, quote_number: quote.quotenumber, quote_id: quote.quoteid, total, lines, write_ins: writeIns, pdfs: templates.size, pdf_notes: pdfNotes };
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

// ElevenLabs webhook tool "create_quote" (server-to-server, x-iris-secret).
// Builds a draft quote in Dynamics for sales to review and send.
app.post("/crm/quote", async (req, res) => {
  const missing = [];
  if (!D365.tenant)       missing.push("D365_TENANT_ID");
  if (!D365.clientId)     missing.push("D365_CLIENT_ID");
  if (!D365.clientSecret) missing.push("D365_CLIENT_SECRET");
  if (!D365.orgUrl)       missing.push("D365_ORG_URL");
  if (!D365.toolSecret)   missing.push("IRIS_TOOL_SECRET");
  if (!QUOTE.priceListId) missing.push("QUOTE_PRICE_LIST_ID");
  if (missing.length) return res.status(500).json({ status: "error", error: "Missing env vars", missing });
  if (req.headers["x-iris-secret"] !== D365.toolSecret) return res.status(401).json({ error: "unauthorized" });

  const b = req.body || {};
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ status: "invalid", message: "A confirmed, valid email address is required for the quote." });
  }
  // Items may arrive as an array or a JSON string (ElevenLabs LLM params).
  let items = b.items;
  if (typeof items === "string") { try { items = JSON.parse(items); } catch { items = null; } }
  items = (Array.isArray(items) ? items : [])
    .map((i) => ({ product: String(i && i.product || "").trim(), quantity: Math.round(Number(i && i.quantity) || 1) }));
  const unknown = items.filter((i) => !QUOTE_PRODUCTS[i.product]).map((i) => i.product);
  if (!items.length || unknown.length) {
    return res.status(400).json({ status: "invalid",
      message: unknown.length ? `Unknown product: ${unknown.join(", ")}. Use only catalog products.` : "Add at least one product to the quote." });
  }
  if (items.some((i) => i.quantity < 1 || i.quantity > 10000)) {
    return res.status(400).json({ status: "invalid", message: "Each quantity must be between 1 and 10000." });
  }

  try {
    const q = await createQuote({
      first_name: String(b.first_name || "").trim(), last_name: String(b.last_name || "").trim(),
      email, company: String(b.company || "").trim(), phone: b.phone,
      customer_type: b.customer_type, items,
      notes: b.notes ? String(b.notes).slice(0, 1000) : "", conversation_id: b.conversation_id,
    });
    console.log("[iris-quote] created", q.quote_number, email, "path:", q.path, "lines:", q.lines.length, "write-ins:", q.write_ins.length, "pdfs:", q.pdfs);
    res.json({
      status: "created",
      quote_number: q.quote_number,
      total: q.total,
      lines: q.lines,
      message: `Quote ${q.quote_number} is prepared. Tell the customer our team will review it and email it to ${email} shortly, and give the quote number as their reference. Do not read prices from this response unless asked; never mention any system.`,
    });
  } catch (e) {
    console.error("[iris-quote] failed:", e.message);
    res.status(500).json({ status: "error", message: "The quote could not be created. Tell the customer the team will follow up by email, and escalate." });
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
