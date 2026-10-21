// espresso (EspressoDID) REST client — number inventory and DID orders.
// Ported from OnlineOrdering/server.js (the espresso REST block, the order
// status mapping and placeDidOrder's create step), where it is proven in
// production. Stateless: callers pass order ids explicitly and persist what
// comes back. The only things cached here are read-only — the one shared
// token and the company / routing profile.
//
// Env is read at call time (espressoConfig), never at import:
//   ESPRESSO_REST_URL            default the sandbox
//   ESPRESSO_CLIENT_ID / _SECRET OAuth2 client
//   ESPRESSO_REST_USER / _PASS   OAuth2 password-grant login
//   ESPRESSO_OCN                 default 154E (Iristel's own numbers)
//   ESPRESSO_DID_PROFILE         routing profile label to pin
//   ESPRESSO_ROUTING_PROFILE_ID  or the profile id itself
//   ESPRESSO_COMPANY_ID          else the login's single active company
//   ESPRESSO_ACQUISITION         BUY (default) or LEASE
import crypto from "crypto";

const SANDBOX_URL = "https://api-sandbox.espressodid.com";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Non-secret settings only — safe to log or return from a status endpoint.
export function espressoConfig() {
  const env = process.env;
  const c = credentials();
  return {
    url: String(env.ESPRESSO_REST_URL || SANDBOX_URL).trim().replace(/\/+$/, ""),
    // Iristel's own numbers — the only OCN the order API accepts
    ocn: String(env.ESPRESSO_OCN || "154E").trim(),
    profileLabel: String(env.ESPRESSO_DID_PROFILE || "").trim(),
    // The spec takes uppercase only
    acquisition: String(env.ESPRESSO_ACQUISITION || "BUY").trim().toUpperCase(),
    configured: !!(c.clientId && c.clientSecret && c.user && c.pass),
  };
}

function credentials() {
  const env = process.env;
  return {
    clientId: env.ESPRESSO_CLIENT_ID || "",
    clientSecret: env.ESPRESSO_CLIENT_SECRET || "",
    user: env.ESPRESSO_REST_USER || "",
    pass: env.ESPRESSO_REST_PASS || "",
  };
}

// err.apiCode is what a caller branches on
function espressoRestError(message, fields) {
  return Object.assign(new Error(message), { status: 502 }, fields || {});
}

// 10-digit form for people, the CRM and UBoss; espresso and MIND use 11
// (elevenDigits). The conversion happens only at those edges.
export function tenDigits(n) {
  const d = String(n ?? "").replace(/\D/g, "");
  return d.length === 11 && d[0] === "1" ? d.slice(1) : d;
}

// espresso and MIND expect the 11-digit E.164-without-plus form (12045551234)
export function elevenDigits(n) {
  const d = String(n ?? "").replace(/\D/g, "");
  return d.length === 10 ? "1" + d : d;
}

// fetch with a timeout that never follows redirects (espressoRest decides),
// with network failures turned into Errors whose message / code say what
// happened ("request timeout", ECONNRESET …).
async function httpRequest(url, { method = "GET", headers = {}, body = null, timeout = 30000 } = {}) {
  try {
    const r = await fetch(url, {
      method, headers, body: body == null ? undefined : body,
      redirect: "manual", signal: AbortSignal.timeout(timeout),
    });
    const raw = await r.text();
    return { status: r.status, location: r.headers.get("location"), raw };
  } catch (e) {
    const cause = e && e.cause;
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    const message = timedOut ? "request timeout"
      : [e && e.message, cause && (cause.code || cause.message)].filter(Boolean).join(": ");
    throw Object.assign(new Error(message || "network error"), { code: (cause && cause.code) || (e && e.code) || null });
  }
}

// ---- Token ----
// espresso keeps at most 5 live tokens per user and revokes the oldest, so
// one token is shared by every request and refreshed just before it expires.
let restToken = null;         // { access, refresh, expiresAt }
let restTokenPending = null;  // the one in-flight fetch everyone waits on

async function requestRestToken(grant) {
  const { url } = espressoConfig();
  const { clientId, clientSecret } = credentials();
  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...grant }).toString();
  let r;
  try {
    r = await httpRequest(`${url}/ws/v1/auth/token`, {
      method: "POST", body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    });
  } catch (e) {
    // Nothing was sent past the login, so this is never "may have happened"
    throw espressoRestError(`espresso REST login — no answer: ${e.message}`, { status: 503, apiCode: "ESPRESSO_AUTH" });
  }
  let data = null;
  try { data = JSON.parse(r.raw); } catch {}
  if (r.status !== 200 || !data || !data.access_token) {
    throw espressoRestError(`espresso REST login failed (HTTP ${r.status}): `
      + ((data && (data.error_description || data.error)) || String(r.raw || "").slice(0, 200)),
      { status: 503, apiCode: "ESPRESSO_AUTH", espressoStatus: r.status });
  }
  restToken = {
    access: data.access_token, refresh: data.refresh_token || null,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return restToken.access;
}

function espressoRestToken() {
  if (restToken && restToken.expiresAt - 60000 > Date.now()) return Promise.resolve(restToken.access);
  if (!restTokenPending) {
    const prev = restToken;
    restTokenPending = (async () => {
      if (prev && prev.refresh) {
        try { return await requestRestToken({ grant_type: "refresh_token", refresh_token: prev.refresh }); }
        catch (e) { console.warn("[espresso] token refresh failed — logging in again:", e.message); }
      }
      const { user, pass } = credentials();
      return requestRestToken({ grant_type: "password", username: user, password: pass });
    })().finally(() => { restTokenPending = null; });
  }
  return restTokenPending;
}

// One REST call. Errors keep espresso's HTTP status and first error code
// (espressoStatus / espressoCode); err.transport marks a call whose answer
// never arrived — for an order that means "may or may not exist".
export async function espressoRest(method, apiPath, body) {
  const cfg = espressoConfig();
  if (!cfg.configured) {
    throw espressoRestError("espresso REST API not configured (set ESPRESSO_CLIENT_ID / ESPRESSO_CLIENT_SECRET / "
      + "ESPRESSO_REST_USER / ESPRESSO_REST_PASS)", { status: 503, apiCode: "ESPRESSO_NOT_CONFIGURED" });
  }
  const payload = body === undefined ? null : JSON.stringify(body);
  let url = cfg.url + apiPath;
  let reauthed = false, redirects = 0;
  for (;;) {
    const token = await espressoRestToken();
    let r;
    try {
      r = await httpRequest(url, {
        method, body: payload,
        headers: {
          Authorization: `Bearer ${token}`, Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch (e) {
      throw espressoRestError(`espresso ${method} ${apiPath} — no answer: ${e.message}`, { status: 503, transport: true });
    }
    // nginx 301s /ws/v1/dids/orders to the trailing-slash form. A redirect
    // means nothing was processed, so the same request is sent again there —
    // never to another host.
    if (r.status >= 300 && r.status < 400 && r.location && redirects < 2) {
      const next = new URL(r.location, url);
      if (next.host === new URL(url).host) { url = next.href; redirects++; continue; }
    }
    // Expired or revoked token: rejected before any processing, so one fresh
    // login and a retry is safe even when placing an order
    if (r.status === 401 && !reauthed) { reauthed = true; restToken = null; continue; }
    let data = null;
    try { data = r.raw ? JSON.parse(r.raw) : {}; } catch {}
    if (r.status >= 200 && r.status < 300) {
      if (data === null) {
        throw espressoRestError(`espresso ${method} ${apiPath} answered HTTP ${r.status} with something that isn't JSON`,
          { apiCode: "ESPRESSO_BAD_RESPONSE", espressoStatus: r.status });
      }
      return data;
    }
    const errs = data && Array.isArray(data.errors) ? data.errors : [];
    throw espressoRestError(`espresso ${method} ${apiPath} → HTTP ${r.status}: `
      + (errs.length ? errs.map(x => [x.code, x.message].filter(v => v != null && v !== "").join(" ")).join("; ")
        : String(r.raw || "").slice(0, 200)),
      { status: r.status >= 500 ? 503 : 502, espressoStatus: r.status,
        espressoCode: errs[0] && errs[0].code != null ? String(errs[0].code) : null, errors: errs });
  }
}

// ---- Company and routing profile ----
// Resolved once and cached for an hour. The routing profile decides where the
// numbers ring — a wrong one provisions fine but routes calls nowhere — so it
// is matched by the pinned label (ESPRESSO_DID_PROFILE), never guessed.
const REST_ACCOUNT_TTL_MS = 60 * 60 * 1000;
let restAccount = null; // { companyId, routingProfileId, profileLabel, at }

async function restRoutingProfiles(companyId) {
  const q = new URLSearchParams({ from: "0", size: "1000", ...(companyId ? { company_id: companyId } : {}) });
  const page = await espressoRest("GET", `/ws/v1/network/routing_profiles?${q}`);
  return Array.isArray(page) ? page : (page && Array.isArray(page.data) ? page.data : []);
}

export async function espressoAccount(fresh) {
  if (!fresh && restAccount && Date.now() - restAccount.at < REST_ACCOUNT_TTL_MS) {
    const { companyId, routingProfileId, profileLabel } = restAccount;
    return { companyId, routingProfileId, profileLabel };
  }
  let companyId = process.env.ESPRESSO_COMPANY_ID || "";
  if (!companyId) {
    const r = await espressoRest("GET", "/ws/v1/general/companies");
    const active = (Array.isArray(r) ? r : (r && r.data) || []).filter(c => c && c.id && c.active !== false);
    if (active.length !== 1) {
      throw espressoRestError(`espresso lists ${active.length} active companies for this login — set ESPRESSO_COMPANY_ID`,
        { status: 503, apiCode: "ESPRESSO_NOT_READY" });
    }
    companyId = active[0].id;
  }
  let routingProfileId = process.env.ESPRESSO_ROUTING_PROFILE_ID || "";
  let profileLabel = null;
  if (!routingProfileId) {
    const label = espressoConfig().profileLabel;
    const did = (await restRoutingProfiles(companyId)).filter(p => p && p.id && p.type === "did" && p.active !== false);
    const pin = label.toLowerCase();
    const pick = pin ? did.find(p => String(p.label || "").trim().toLowerCase() === pin)
      : (did.length === 1 ? did[0] : null);
    if (!pick) {
      throw espressoRestError(`Routing profile "${label || "(not pinned)"}" not found among active DID profiles: `
        + (did.map(p => p.label).join(", ") || "none"), { status: 503, apiCode: "ESPRESSO_NOT_READY" });
    }
    routingProfileId = pick.id;
    profileLabel = pick.label;
  }
  restAccount = { companyId, routingProfileId, profileLabel, at: Date.now() };
  return { companyId, routingProfileId, profileLabel };
}

// ---- Inventory ----
export const invFilter = (name, value, eq = "=") =>
  ({ category_name: name, category_operator: "and", category_eq: eq, category_value: String(value) });

// The spec's defaults are odd (limit 0, offset 1024), so both are always sent.
// Documented as one object; a bare array or a {data:[…]} page parse too.
export async function inventorySearch(filters, { limit = 50, offset = 0 } = {}) {
  const data = await espressoRest("POST", "/ws/v1/dids/inventory/search",
    { limit, offset, order_by: ["number asc"], filter: filters });
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  return data && data.number ? [data] : [];
}

// Free to sell: available, nobody's account, not vanity (unless asked for),
// Iristel's OCN
export function inventoryRowFree(row, { allowVanity = false } = {}) {
  const ocn = espressoConfig().ocn.toUpperCase();
  return !!row && String(row.status || "").toLowerCase() === "available" && !row.account
    && (allowVanity || row.vanity !== true) && (!row.ocn || String(row.ocn).toUpperCase() === ocn);
}

// ---- Orders ----
// Recent orders, newest-updated first — used to find an order by its
// reference or ORD- number when the caller doesn't have its id
async function recentOrders(match, pages = 3) {
  const { companyId } = await espressoAccount();
  for (let page = 1; page <= pages; page++) {
    const q = new URLSearchParams({ accountId: companyId, page: String(page), size: "50" });
    const r = await espressoRest("GET", `/ws/v1/dids/orders?${q}`);
    const rows = (r && Array.isArray(r.data)) ? r.data : [];
    const hit = rows.find(match);
    if (hit) return hit;
    if (rows.length < 50) break;
  }
  return null;
}

// The order summary created with this reference, or null. This is how a
// create whose answer was lost is recovered: persist the reference BEFORE
// createOrder, and look it up here instead of creating again.
export async function findOrderByReference(reference) {
  if (!reference) return null;
  return recentOrders(o => o && o.reference === reference);
}

// The browser/caller-facing code for an espresso failure
function espressoApiCode(e) {
  if (e.apiCode) return e.apiCode;
  if (e.espressoStatus === 401 || e.espressoStatus === 403) return "INVENTORY_FORBIDDEN";
  if (e.transport || e.espressoStatus >= 500 || e.espressoStatus === 409) return "ESPRESSO_BUSY";
  return null;
}

// Orders the exact numbers picked (one number request, a `did` filter).
// With selectDids true the order waits in PENDING until completeOrder — so
// nothing is bought until the caller has been paid. The create is never
// retried blindly: when its answer is lost, the order is looked up by its
// reference, so a retry can't buy the numbers twice. err.ambiguous = true
// means it may exist anyway — keep the reference and check again later.
export async function createOrder({ dids, vanity = false, reference, selectDids = true } = {}) {
  const list = (Array.isArray(dids) ? dids : []).map(elevenDigits);
  if (!list.length || list.length > 1000 || list.some(d => !/^1\d{10}$/.test(d))) {
    throw Object.assign(new TypeError("createOrder: dids must be 1 to 1000 ten- or eleven-digit NANP numbers"),
      { status: 400, apiCode: "INVALID_REQUEST" });
  }
  if (new Set(list).size !== list.length) {
    throw Object.assign(new TypeError("createOrder: a number is listed twice"), { status: 400, apiCode: "DUPLICATE_PICK" });
  }
  const ref = String(reference || `iris:${crypto.randomBytes(6).toString("hex")}`);
  if (Buffer.byteLength(ref) > 255) {
    throw Object.assign(new TypeError("createOrder: reference is over 255 bytes"), { status: 400, apiCode: "INVALID_REQUEST" });
  }
  const cfg = espressoConfig();
  const acct = await espressoAccount();
  const body = {
    accountId: acct.companyId, countryId: "1", ocn: cfg.ocn, vanity: !!vanity, selectDids: !!selectDids,
    acquisitionType: cfg.acquisition, routingProfileId: acct.routingProfileId, reference: ref,
    numberRequests: [{ quantity: list.length, filters: [{ categoryName: "did", categoryValue: list }] }],
  };
  try {
    const order = await espressoRest("POST", "/ws/v1/dids/orders", body);
    if (!order || !order.id) {
      throw espressoRestError("espresso accepted the order but sent back no order id", { apiCode: "ESPRESSO_BAD_RESPONSE" });
    }
    return order;
  } catch (e) {
    // No answer, or a server error: the order may exist anyway.
    // ACCOUNT_MAPPING_UNAVAILABLE is a 503 refused before anything is stored.
    const ambiguous = !!(e.transport || e.apiCode === "ESPRESSO_BAD_RESPONSE"
      || (e.espressoStatus >= 500 && e.espressoCode !== "ACCOUNT_MAPPING_UNAVAILABLE"));
    if (ambiguous) {
      const found = await findOrderByReference(ref).catch(() => null);
      if (found) return getOrder(found.id).catch(() => found);
    }
    const code = espressoApiCode(e);
    const keep = { reference: ref, ambiguous, espressoStatus: e.espressoStatus ?? null,
      espressoCode: e.espressoCode ?? null, errors: e.errors || [] };
    if (ambiguous || code === "ESPRESSO_BUSY") {
      throw Object.assign(new Error(ambiguous ? `espresso didn't confirm the order (reference ${ref}) — ${e.message}` : e.message),
        { status: 503, apiCode: "ESPRESSO_BUSY", ...keep });
    }
    // Refused outright — nothing was created, so a new create may go
    throw Object.assign(new Error(e.message),
      { status: code === "INVENTORY_FORBIDDEN" ? 503 : 502, apiCode: code || "ESPRESSO_REJECTED", ...keep });
  }
}

function orderPath(id, suffix = "") {
  const ref = String(id ?? "").trim();
  if (!ref) throw Object.assign(new TypeError("order id is required"), { status: 400, apiCode: "INVALID_REQUEST" });
  return `/ws/v1/dids/orders/${encodeURIComponent(ref)}${suffix}`;
}

// By order id (UUID) or ORD- number
export async function getOrder(id) {
  const ref = String(id ?? "").trim();
  if (ref && !UUID_RE.test(ref) && /^ORD-/i.test(ref)) {
    const found = await recentOrders(o => o && o.orderNumber === ref);
    if (!found) throw espressoRestError(`Order ${ref} not found`, { status: 404, apiCode: "ORDER_NOT_FOUND" });
    return espressoRest("GET", orderPath(found.id));
  }
  return espressoRest("GET", orderPath(ref));
}

// selectDids orders only, once orderState says 'ready' and before
// reservationExpiresAt. `numbers` keeps a subset of the reserved ones; omit
// it to take them all. A lost answer is not retried blindly either: re-read
// the order — a repeat is refused (INELIGIBLE_STATUS / ORDER_BUSY) once it
// has moved on, so it can't assign twice.
export async function completeOrder(id, numbers) {
  const body = Array.isArray(numbers) && numbers.length ? { numbers: [...new Set(numbers.map(elevenDigits))] } : {};
  return espressoRest("POST", orderPath(id, "/complete"), body);
}

// A PENDING order that isn't reserving at this moment; cancelling one that
// is already CANCELLED succeeds unchanged
export async function cancelOrder(id, reason) {
  const body = reason ? { reason: String(reason).slice(0, 1000) } : {};
  return espressoRest("POST", orderPath(id, "/cancel"), body);
}

// espresso status → what the caller acts on (the spec's order lifecycle and
// the OnlineOrdering status page's rules):
//   reserving  — PENDING, numbers still being reserved: poll
//   ready      — PENDING with canComplete (selectDids): complete before
//                reservationExpiresAt
//   processing — completion requested; numbers being assigned and routed
//   completed  — numbers assigned
//   rejected   — inventory couldn't satisfy a request; nothing bought, the
//                customer can pick other numbers
//   failed     — technical error while processing; may need reconciliation
//   expired    — the reservation passed before completion
//   cancelled  — cancelled before completion
// needsReview: failed/expired, or ended rejected/cancelled with numbers
// ASSIGNED — stop and let ops look (never send the customer to buy again).
export function orderState(order) {
  const o = order || {};
  const numbers = Array.isArray(o.numbers) ? o.numbers : [];
  const withStatus = s => numbers.filter(n => n && n.status === s).map(n => tenDigits(n.did));
  const assigned = withStatus("ASSIGNED");
  const why = o.rejectionReason || o.failureReason || null;
  const reason = why ? { code: why.code || null, message: why.message || why.code || null } : null;
  let state;
  switch (String(o.status || "").toUpperCase()) {
    case "PENDING": state = o.canComplete === true ? "ready" : "reserving"; break;
    case "PROCESSING": state = "processing"; break;
    case "COMPLETED": state = "completed"; break;
    case "REJECTED": state = "rejected"; break;
    case "FAILED": state = "failed"; break;
    case "EXPIRED": state = "expired"; break;
    case "CANCELLED": state = "cancelled"; break;
    // Anything new is treated as still going, as the source did
    default: state = "processing";
  }
  const needsReview = state === "failed" || state === "expired"
    || ((state === "rejected" || state === "cancelled") && assigned.length > 0);
  return {
    state, reason, needsReview, canComplete: o.canComplete === true,
    espressoStatus: o.status || null, orderId: o.id || null, orderNumber: o.orderNumber || null,
    reservationExpiresAt: o.reservationExpiresAt || null,
    reserved: withStatus("RESERVED"), assigned,
  };
}

// Numbers by request position, from numberRequestId → numberRequests[].index
// (10 digits). `statuses` limits it, e.g. ['ASSIGNED'].
export function numbersByRequest(order, statuses) {
  const indexOf = new Map(((order && order.numberRequests) || []).map(r => [r.id, r.index]));
  const groups = new Map();
  for (const n of (order && order.numbers) || []) {
    if (statuses && !statuses.includes(n.status)) continue;
    const idx = indexOf.has(n.numberRequestId) ? indexOf.get(n.numberRequestId) : null;
    if (!groups.has(idx)) groups.set(idx, []);
    groups.get(idx).push(tenDigits(n.did));
  }
  return [...groups.entries()].map(([index, dids]) => ({ index, dids }));
}

// Tests only: forget the cached token and company / routing profile.
export function _resetForTests() {
  restToken = null;
  restTokenPending = null;
  restAccount = null;
}
