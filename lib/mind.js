// MIND (IristelX billing) — accounts, services, number availability and
// number assignment. Ported from OnlineOrdering/server.js, where these calls
// are proven in production. Stateless: the source kept an email-keyed store
// to make each step idempotent; here callers pass account / service ids
// explicitly and persist what comes back. The only caches are read-only:
// MIND's city list and the short-lived pick verdicts.
//
// Env (read at call time):
//   MIND_API_KEY      header iristelx-api-key — accounts, services, numbers
//   UBOSS_API_KEY     header x-api-key — /account-details-with-phone
//   IRISTELX_API_URL  default https://api.iristelx.com
import { tenDigits } from "./espresso.js";

const DEFAULT_BASE = "https://api.iristelx.com";
const baseUrl = () => String(process.env.IRISTELX_API_URL || DEFAULT_BASE).trim().replace(/\/+$/, "");
const enc = encodeURIComponent;
const normEmail = (email) => String(email || "").trim().toLowerCase();

// MIND expects the 11-digit E.164-without-plus form (e.g. 12045551234)
export function mindDigits(n) {
  const d = String(n ?? "").replace(/\D/g, "");
  return d.length === 10 ? "1" + d : d;
}

function keyHeader(which) {
  const name = which === "uboss" ? "UBOSS_API_KEY" : "MIND_API_KEY";
  const key = process.env[name] || "";
  if (!key) throw Object.assign(new Error(`${name} is not set`), { status: 503, apiCode: "MIND_NOT_CONFIGURED" });
  return which === "uboss" ? { "x-api-key": key } : { "iristelx-api-key": key };
}

// One MIND call → { status, raw, data } (data null when the answer isn't
// JSON). Network failures throw an Error whose message / code say what
// happened, so retryRead can tell a timeout or reset from a real answer.
async function mindCall(method, path, { body, key = "mind", timeout = 30000 } = {}) {
  const headers = { ...keyHeader(key), Accept: "application/json" };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  let r, raw;
  try {
    r = await fetch(baseUrl() + path, { method, headers, body: payload, redirect: "manual", signal: AbortSignal.timeout(timeout) });
    raw = await r.text();
  } catch (e) {
    const cause = e && e.cause;
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    const message = timedOut ? "request timeout"
      : [e && e.message, cause && (cause.code || cause.message)].filter(Boolean).join(": ");
    throw Object.assign(new Error(message || "network error"), { code: (cause && cause.code) || (e && e.code) || null });
  }
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  return { status: r.status, raw: raw || "", data };
}

const ok = (r) => r.status >= 200 && r.status < 300;
const snippet = (r) => String(r.raw || "").slice(0, 200);
const fail = (message, fields) => Object.assign(new Error(message), { status: 502 }, fields || {});

// Read-only calls are retried once when the answer never arrived.
// UND_ERR_SOCKET is fetch's (undici's) "socket hang up".
async function retryRead(fn) {
  try { return await fn(); }
  catch (e) {
    if (!/timeout|ECONNRESET|socket hang up|UND_ERR_SOCKET|EAI_AGAIN|ETIMEDOUT/i.test(`${e.message} ${e.code || ""}`)) throw e;
    return fn();
  }
}

// ---- Availability, read-only ----
// Pick time and submit time look only: nothing is added to MIND until the
// numbers are bought. A number is free only when all three lookups agree —
// a service carrying it, the reserved pool, and the account lookup (the one
// that sees numbers held by wholesale accounts). Any error throws: an
// unclear answer is never "free".

// Who already holds a number in MIND: one row per service carrying it, []
// when nobody does; row.code is that service's id. Only the 11-digit form
// matches — a 10-digit query silently comes back empty, i.e. a false "free".
// (The newer /account-details-with-phone misses SIP trunk services, so this
// is the lookup.) Fails closed.
export async function mindNumberHolders(number) {
  const digits = mindDigits(number);
  const r = await mindCall("GET", `/telephone-numbers/account-details/${enc(digits)}`);
  if (!ok(r) || !Array.isArray(r.data)) {
    throw fail(`MIND number lookup failed for ${digits} (HTTP ${r.status}): ${snippet(r)}`);
  }
  return r.data;
}

// MIND's number inventory entry for a number, or null. This is where a
// trunk's EXTRA DIDs live: a service carries only one number (the primary),
// so the rest sit here — serviceId null, inUse false — and the service
// lookup above never sees them. Same 11-digit rule (a 10-digit fullNumber is
// a 400) and the same fail-closed handling.
export async function mindInventoryEntry(number) {
  const digits = mindDigits(number);
  const r = await mindCall("GET", `/telephone-numbers/reserved?fullNumber=${enc(digits)}`);
  if (!ok(r) || !r.data || !Array.isArray(r.data.telephoneNumbers)) {
    throw fail(`MIND inventory lookup failed for ${digits} (HTTP ${r.status}): ${snippet(r)}`);
  }
  return r.data.telephoneNumbers.find(t => mindDigits(t && t.telephoneNumber) === digits) || null;
}

// Which MIND accounts hold a number, per account-details-with-phone (the
// UBoss-gateway lookup). Account codes only, never names or contact details.
// Strict: an answer that isn't clearly "nobody" throws.
async function mindPhoneAccountsStrict(number) {
  const digits = mindDigits(number);
  const r = await mindCall("GET", `/account-details-with-phone?telephoneNumber=${enc(digits)}`, { key: "uboss" });
  const data = r.data;
  if (ok(r) && data && Array.isArray(data.accounts)) {
    if (data.accounts.length) {
      return data.accounts.map(a => ({ code: String(a.code || a.accountId || ""), product: (a.product && a.product.code) || null }));
    }
    if (data.isExist === false || /does not exist/i.test(String(data.message || ""))) return [];
  }
  throw fail(`MIND account lookup failed for ${digits} (HTTP ${r.status}): ${snippet(r)}`);
}

// Best-effort version — used only as evidence after an attach, so a failure
// returns []
async function mindPhoneAccounts(number) {
  try { return await mindPhoneAccountsStrict(number); } catch { return []; }
}

// → { free: true } | { free: false, via: 'service' | 'inventory' | 'account' }
export async function mindPickVerdict(number) {
  const [rows, inv, accounts] = await Promise.all([
    retryRead(() => mindNumberHolders(number)),
    retryRead(() => mindInventoryEntry(number)),
    retryRead(() => mindPhoneAccountsStrict(number)),
  ]);
  if (rows.length) return { free: false, via: "service" };
  if (inv) return { free: false, via: "inventory" };
  if (accounts.length) return { free: false, via: "account" };
  return { free: true };
}

// A picker re-shows the same numbers on a reload, so verdicts are cached
// briefly. Re-check uncached (mindPickVerdict) right before buying.
const PICK_VERDICT_TTL_MS = 3 * 60 * 1000;
const pickVerdictCache = new Map(); // 11 digits → { at, verdict }

export async function cachedPickVerdict(digits) {
  const key = mindDigits(digits);
  const hit = pickVerdictCache.get(key);
  if (hit && Date.now() - hit.at < PICK_VERDICT_TTL_MS) return hit.verdict;
  const verdict = await mindPickVerdict(key);
  pickVerdictCache.set(key, { at: Date.now(), verdict });
  if (pickVerdictCache.size > 5000) pickVerdictCache.delete(pickVerdictCache.keys().next().value);
  return verdict;
}

// ---- Accounts and services ----

// Asks MIND whether this email already has an account. MIND ignores query
// filters and returns every account, so the match is done here. Prefers an
// ACTIVE account, then the most recently created. A lookup failure returns
// null (the source's rule: it must not block signup) — pass strict to get
// the error instead, since without the source's store a null here is the
// only guard against a second account for the same person.
export async function findMindAccountByEmail(email, { strict = false } = {}) {
  const target = normEmail(email);
  if (!target) return null;
  try {
    const r = await mindCall("GET", "/accounts", { timeout: 45000 });
    if (!ok(r)) throw new Error(`HTTP ${r.status}`);
    if (!r.data) throw new Error("unparseable response");
    const matches = (r.data.accounts || []).filter(a => a && a.contact && normEmail(a.contact.emailAddress) === target);
    if (!matches.length) return null;
    matches.sort((a, b) =>
      (String(b.status) === "ACTIVE") - (String(a.status) === "ACTIVE")
      || String(b.createdOn || "").localeCompare(String(a.createdOn || "")));
    if (matches.length > 1) console.warn("[mind]", matches.length, "MIND accounts share", target, "— using", matches[0].accountId);
    return matches[0];
  } catch (e) {
    if (strict) throw Object.assign(new Error(`MIND account lookup failed: ${e.message}`), { status: 502 });
    console.warn("[mind] account lookup failed (continuing):", e.message);
    return null;
  }
}

function mindErrorDetail(data) {
  return data && Array.isArray(data.errors) ? data.errors.map(e => e && e.message).filter(Boolean).join(" ") : "";
}

// Creates a MIND account (business unit 1). No reuse check here: the caller
// decides — findMindAccountByEmail, or an account id it already persisted.
export async function createMindAccount(contact, email) {
  const c = contact || {};
  const body = {
    contact: {
      fname: c.fname, lname: c.lname,
      address1: c.address1, city: c.city,
      province: c.province, country: c.country,
      postalCode: c.postalCode, emailAddress: c.emailAddress || email,
      phone: { mobile: c.phone },
    },
    language: c.language || "en",
    businessUnit: "1",
  };
  const r = await mindCall("POST", "/accounts", { body, timeout: 45000 });
  if (!ok(r) || !r.data) {
    const detail = mindErrorDetail(r.data);
    throw Object.assign(new Error(((r.data && r.data.message) || `Account creation failed (HTTP ${r.status})`) + (detail ? " — " + detail : "")),
      { status: r.status >= 400 && r.status < 500 ? r.status : 502 });
  }
  const accountId = r.data.accountId || r.data.id || r.data.accountcode;
  if (!accountId) throw fail("Account created but no id returned");
  return { accountId: String(accountId) };
}

// Creates the service (SIP trunk plan by default) on an account. Mints a new
// service every call — the caller keeps the serviceId so a retry or resume
// reuses it instead of creating another.
export async function createMindService(accountId, planCode, contact, email) {
  if (!accountId) throw new TypeError("accountId is required");
  const c = contact || {};
  const body = {
    accountId: String(accountId),
    planCode: planCode || "EXLNP_SBSIPTRNK",
    contact: {
      fname: c.fname, lname: c.lname,
      address1: c.address1, city: c.city,
      province: c.province, country: c.country,
      postalCode: c.postalCode, emailAddress: c.emailAddress || email,
      phone: c.phone || "",
    },
  };
  const r = await mindCall("POST", `/accounts/${enc(accountId)}/services`, { body, timeout: 45000 });
  if (!ok(r) || !r.data) {
    throw Object.assign(new Error((r.data && r.data.message) || `Service creation failed (HTTP ${r.status})`),
      { status: r.status >= 400 && r.status < 500 ? r.status : 502 });
  }
  const d = r.data;
  const serviceId = d.serviceId || d.id || (d.service && (d.service.serviceId || d.service.id));
  if (!serviceId) throw fail("Service created but no id returned");
  return { serviceId: String(serviceId) };
}

// The SIP trunk service carries one billable line per channel
// (EXLNP_SBSIPTRNK) and one per DID (EXLNP_SBDID — every DID is billed, none
// comes with the trunk). Quantities are set with PUT …/quantity. Get
// Services and the add-on list don't carry quantities; the service journal
// (GET /accounts/{a}/services/{s}/log, field SRV_QUANTITY) is the only
// read-back. New lines start at quantity 1, so write every line — even 0 —
// rather than leave MIND's default or an earlier, higher count standing.
export const SIP_QTY_CODES = { channels: "EXLNP_SBSIPTRNK", dids: "EXLNP_SBDID" };

// The billable lines on a service, e.g. ['EXLNP_SBSIPTRNK', 'EXLNP_SBDID']
export async function mindServiceLines(accountId, serviceId) {
  const r = await mindCall("GET", `/accounts/${enc(accountId)}/services/${enc(serviceId)}/add-on`);
  if (!ok(r) || !r.data || !Array.isArray(r.data.services)) {
    throw fail(`MIND service lines lookup failed (HTTP ${r.status}): ${snippet(r)}`);
  }
  return r.data.services.map(s => String(s.code || ""));
}

// Throws unless MIND echoes the quantity back
export async function putServiceQuantity(accountId, serviceId, code, qty) {
  const r = await mindCall("PUT", `/accounts/${enc(accountId)}/services/${enc(serviceId)}/quantity`,
    { body: { serviceCode: code, quantity: String(qty) } });
  if (!ok(r) || !r.data || String(r.data.quantity) !== String(qty)) {
    throw fail(`MIND quantity update failed for ${code}=${qty} (HTTP ${r.status}): ${snippet(r)}`);
  }
  return r.data;
}

// ---- MIND city for a rate center ----
// Numbers are added to MIND under a city, and MIND has no city for many
// espresso rate centers (CHATHAM among them). Resolution, per rate center:
//   1. a MIND city of the same name (in the NPA's province)
//   2. a nearby city from MIND_CITY_ALIASES
//   3. the NPA's default city from NPA_MIND_CITY
// Every city named below exists in MIND's list (checked 2026-10-20).
const NPA_MIND_CITY = [
  [["416", "437", "647", "942"], "TORONTO", ["ON"]],
  [["905", "289", "365", "742"], "HAMILTON", ["ON"]],
  [["519", "226", "548", "382"], "LONDON", ["ON"]],
  [["613", "343", "753"], "CARLETON", ["ON"]],
  [["705", "249", "683"], "SUDBURY", ["ON"]],
  [["807"], "THUNDER BAY", ["ON"]],
  [["514", "438", "263"], "MONTREAL", ["QC"]],
  [["450", "579", "354"], "LONGUEUIL", ["QC"]],
  [["418", "581", "367"], "QUEBEC", ["QC"]],
  [["819", "873", "468"], "SHERBROOKE", ["QC"]],
  [["204", "431", "584"], "WINNIPEG", ["MB"]],
  [["306", "639", "474"], "REGINA", ["SK"]],
  [["403", "587", "825", "368"], "CALGARY", ["AB"]],
  [["780"], "EDMONTON", ["AB"]],
  [["604", "778", "236", "672"], "VANCOUVER", ["BC"]],
  [["250"], "VICTORIA", ["BC"]],
  [["902", "782"], "HALIFAX", ["NS", "PE"]],
  [["506", "428"], "MONCTON", ["NB"]],
  [["709", "879"], "ST. JOHN'S", ["NL"]],
  [["867"], "WHITEHORSE", ["YT", "NT", "NU"]],
].reduce((map, [npas, city, provinces]) => {
  npas.forEach(n => { map[n] = { city, provinces }; });
  return map;
}, {});

// Rate centers MIND has no city for → the nearest one it has
const MIND_CITY_ALIASES = {
  CHATHAM: "WINDSOR",
};

const cityKey = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
let mindCitiesCache = null; // { at, byKey: Map<cityKey, city> }

// The list is large and MIND is slow to send it (24 s seen on 2026-10-21),
// so it gets a longer timeout, and a failed hourly refresh keeps the last
// good copy — cities rarely change.
async function mindCities() {
  if (mindCitiesCache && mindCitiesCache.at > Date.now() - 3600000) return mindCitiesCache;
  let list = [], failure = null;
  try {
    const r = await retryRead(() => mindCall("GET", "/telephone-numbers/cities", { timeout: 60000 }));
    list = ((r.data && r.data.cities) || []).filter(c => c && c.city && c.id != null);
    if (!list.length) failure = `HTTP ${r.status}`;
  } catch (e) {
    failure = e.message;
  }
  if (list.length) {
    mindCitiesCache = { at: Date.now(), byKey: new Map(list.map(c => [cityKey(c.city), c])) };
    return mindCitiesCache;
  }
  if (mindCitiesCache) {
    console.warn("[mind] city list refresh failed (" + failure + ") — keeping the copy from",
      new Date(mindCitiesCache.at).toISOString());
    return mindCitiesCache;
  }
  // Never had one: nothing to fall back on, and nothing is cached
  throw Object.assign(new Error(`MIND city list unavailable: ${failure}`), { status: 503, apiCode: "MIND_UNAVAILABLE" });
}

// → { id, city, via: 'exact' | 'alias' | 'npa' }, or null when nothing fits.
// Resolve it before buying: a number is never added to MIND without a city.
export async function resolveMindCity({ ratecenter, npa } = {}) {
  const { byKey } = await mindCities();
  const info = NPA_MIND_CITY[String(npa)] || null;
  const fits = c => !info || !c.province || info.provinces.includes(String(c.province).toUpperCase());
  const exact = ratecenter && byKey.get(cityKey(ratecenter));
  if (exact && fits(exact)) return { id: exact.id, city: exact.city, via: "exact" };
  const alias = ratecenter && MIND_CITY_ALIASES[cityKey(ratecenter)];
  const aliased = alias && byKey.get(cityKey(alias));
  if (aliased && fits(aliased)) return { id: aliased.id, city: aliased.city, via: "alias" };
  const fallback = info && byKey.get(cityKey(info.city));
  return fallback ? { id: fallback.id, city: fallback.city, via: "npa" } : null;
}

// The city a number goes in. `city` is one resolved city ({ id, city }) for
// every number, or an object keyed by number (10 or 11 digits) when they
// came from different rate centers. Fails closed — a number is never added
// to MIND without a city.
function cityFor(city, digits) {
  let c = null;
  if (city && city.id != null) c = city;
  else if (city && typeof city === "object") c = city[digits] || city[tenDigits(digits)] || null;
  if (!c || c.id == null) {
    throw Object.assign(new Error(`MIND has no city for ${digits} (${digits.slice(1, 4)}) — resolve one with `
      + "resolveMindCity, or add one to MIND_CITY_ALIASES / NPA_MIND_CITY"), { status: 502, apiCode: "NO_MIND_CITY", number: digits });
  }
  return c;
}

// ---- Inventory and assignment ----
// The espresso DID API has no notion of a customer — numbers are ordered into
// a routing profile on the company account — so nothing downstream tells MIND
// which service the numbers belong to. Numbers must exist in the IristelX
// (MIND) database before they can be attached to a service — the PATCH 403s
// otherwise. Inventory add wants ranges: { start, end, cityId }.

// Adds one number to MIND's inventory (the *reserved* pool). The response is
// layered and comes back HTTP 200 either way:
//   - MIND:        "INSERTED IN MIND", or "NOT INSERTED IN MIND … already
//                  exists" (code 3100) → the number is used by someone.
//   - IristelX DB: may add "NOT INSERTED IN THE DATABASE … ER_DUP_ENTRY" —
//                  IGNORED: the lookups that run before the add already
//                  catch numbers that are in the pool, and MIND is what
//                  matters.
// MIND's layer is the verdict ('inserted' | 'exists'); anything else throws.
async function mindInventoryAdd(digits, cityId, cityName) {
  if (cityId == null) throw fail(`MIND inventory add for ${digits} needs a city`);
  const r = await mindCall("POST", "/telephone-numbers",
    { body: { telephoneNumbers: [{ start: digits, end: digits, cityId }] } });
  const data = r.data;
  const errors = data && Array.isArray(data.errors) ? data.errors : [];
  const mindErrors = errors.filter(x => !/DATABASE|ER_DUP_ENTRY/i.test(JSON.stringify(x)));
  if ((r.status === 400 && /exist/i.test(r.raw)) || mindErrors.some(x => /exist/i.test(JSON.stringify(x)))) {
    return "exists";
  }
  const inserted = (data && Array.isArray(data.telephoneNumbers) ? data.telephoneNumbers : [])
    .some(t => /INSERTED IN MIND/i.test(String((t && t.status) || "")));
  if (!ok(r) || mindErrors.length || !inserted) {
    throw fail(`MIND inventory add failed for ${digits} (HTTP ${r.status}, city ${cityName || cityId}): ${snippet(r)}`);
  }
  console.log("[mind] inventory added", digits, `(${cityName || "city"} ${cityId})`);
  return "inserted";
}

// Puts numbers in MIND's reserved pool. "Already exists" counts as done, but
// a number MIND already had is not this customer's to claim — only `added`
// marks a number as theirs, so persist `added` (attachNumbersToService takes
// it back as `owned`). On a failure the error carries the partial
// added / existing lists.
export async function ensureNumbersInMindInventory(numbers, city) {
  const list = [...new Set((numbers || []).map(mindDigits))];
  // Every city first, so a missing one stops it before anything is written
  const plan = list.map(d => [d, cityFor(city, d)]);
  const added = [], existing = [];
  for (const [digits, c] of plan) {
    let verdict;
    try { verdict = await mindInventoryAdd(digits, c.id, c.city); }
    catch (e) { throw Object.assign(e, { number: digits, added: [...added], existing: [...existing] }); }
    if (verdict === "inserted") added.push(digits);
    else { existing.push(digits); console.warn("[mind] inventory already had", digits, "— not recorded as added"); }
  }
  return { added, existing };
}

function takenError(message, number, fields) {
  return Object.assign(new Error(message), { status: 409, apiCode: "MIND_NUMBER_TAKEN", takenNumber: number }, fields || {});
}

// Attaches numbers to a MIND service. The service carries a single MSISDN,
// so only the PRIMARY number (first in the list — put the trunk's primary
// first) is attached; the rest go into the reserved pool against this unit,
// so a later order can't be handed them. Steps, as MIND support laid them
// out:
//   0. never attach a number another service already carries (a resume or
//      catch-up call lands here too); a number neither lookup knows is added
//      to the pool — the add is the final word: MIND says "already exists"
//      for numbers it holds in states no lookup returns
//   1. ALL numbers into the reserved pool
//   2. the primary must now sit in the pool, unattached or on this service
//   3. PATCH /accounts/{a}/services/{s}/telephone-number { telephoneNumber }
//   4. confirm: the pool entry shows inUse on this service (it lags the
//      PATCH by a few seconds, so it is read again once)
// Stateless stand-ins for the source's store: `owned` lists numbers the
// caller recorded as added to the pool earlier (ensureNumbersInMindInventory
// .added, or this call's .added), so a resume doesn't read its own pooled
// numbers as someone else's; and a primary the pool already shows in use on
// this service counts as attached — it is not PATCHed again.
// Throws on a taken number (err.takenNumber, apiCode MIND_NUMBER_TAKEN) or a
// failed PATCH; otherwise → { primary, assigned, results, added, verify }.
export async function attachNumbersToService(accountId, serviceId, numbers, city, { owned = [], verifyDelayMs = 5000 } = {}) {
  if (!accountId) throw new TypeError("accountId is required");
  if (!serviceId) throw new TypeError("serviceId is required");
  if (!Array.isArray(numbers) || !numbers.length) throw new TypeError("no numbers to assign");
  const normalized = [...new Set(numbers.map(mindDigits))];
  const primary = normalized[0];
  const ownedSet = new Set((owned || []).map(mindDigits));
  const svc = String(serviceId);
  // Fail closed before any write: every number that may be added has a city
  normalized.forEach(d => { if (!ownedSet.has(d)) cityFor(city, d); });

  // Step 0 — the primary's verdict
  const [rows, inv] = await Promise.all([mindNumberHolders(primary), mindInventoryEntry(primary)]);
  const added = [];
  if (!rows.length && !inv) {
    const c = cityFor(city, primary);
    if (await mindInventoryAdd(primary, c.id, c.city) === "exists") {
      throw takenError(`Number ${primary} is already known to MIND (it refuses to add it) — not attaching it`, primary, { via: "mind" });
    }
    if (!(await mindInventoryEntry(primary))) {
      throw fail(`Number ${primary} was added to MIND but is not in the reserved pool`);
    }
    added.push(primary);
  } else {
    // Only the holder's service id and plan are kept: the rows also carry
    // the other customer's contact details
    const foreign = rows.find(r => String(r.code) !== svc);
    if (foreign) {
      throw takenError(`Number ${primary} is already on MIND service ${foreign.code} — not attaching it`, primary,
        { via: "service", holderServiceId: String(foreign.code || ""), holderPlan: foreign.planCode || null });
    }
    if (inv && inv.serviceId && String(inv.serviceId) !== svc) {
      throw takenError(`Number ${primary} is in the reserved pool on service ${inv.serviceId} — not attaching it`, primary,
        { via: "inventory", holderServiceId: String(inv.serviceId) });
    }
    if (inv && !inv.serviceId && !rows.length && !ownedSet.has(primary)) {
      throw takenError(`Number ${primary} is in MIND's number inventory but was not added for this order — not attaching it`,
        primary, { via: "inventory", holderServiceId: null });
    }
  }

  // Step 1 — the other numbers into the pool (the primary is there by now:
  // just added, or already known to be in the pool / on this service)
  const rest = normalized.slice(1).filter(d => !ownedSet.has(d));
  const pooled = await ensureNumbersInMindInventory(rest, city);
  added.push(...pooled.added);

  // Step 2 — the primary must now sit in the pool, unattached or on this service
  const entry = await mindInventoryEntry(primary);
  if (entry && entry.serviceId && String(entry.serviceId) !== svc) {
    throw takenError(`Number ${primary} is in the reserved pool on service ${entry.serviceId} — not attaching it`, primary,
      { via: "inventory", holderServiceId: String(entry.serviceId) });
  }
  if (!entry) console.warn("[mind] primary", primary, "not visible in the reserved pool before attach — PATCH will decide");
  const attachedHere = (e) => !!(e && e.inUse && String(e.serviceId || "") === svc);
  const alreadyAttached = attachedHere(entry) || rows.some(r => String(r.code) === svc);

  // Step 3 — attach the primary
  if (!alreadyAttached) {
    const r = await mindCall("PATCH", `/accounts/${enc(accountId)}/services/${enc(svc)}/telephone-number`,
      { body: { telephoneNumber: primary } });
    if (!ok(r)) {
      // 10008 "no longer available": MIND holds the number in a state the
      // lookups don't show — it can't be this customer's, so it is taken
      if (/no longer available|"10008"|:10008\b/i.test(r.raw)) {
        throw takenError(`MIND telephone-number update failed for ${primary} (HTTP ${r.status}): ${snippet(r)}`, primary,
          { via: "mind", status: 502 });
      }
      throw fail(`MIND telephone-number update failed for ${primary} (HTTP ${r.status}): ${snippet(r)}`);
    }
    console.log("[mind] assigned primary", primary, "to service", svc, "on account", accountId,
      normalized.length > 1 ? `(${normalized.length - 1} more in reserved pool)` : "");
  }

  // Step 4 — confirm. The pool entry is the reliable signal; the
  // account-details-with-phone lookup is kept as evidence only — what it
  // returns for an attached SIP trunk number isn't established, so it never
  // blocks. A failed verify never fails the attach.
  let verify = null;
  try {
    let after = alreadyAttached && attachedHere(entry) ? entry : await mindInventoryEntry(primary);
    if (!attachedHere(after) && verifyDelayMs > 0) {
      await new Promise(res => setTimeout(res, verifyDelayMs));
      after = await mindInventoryEntry(primary);
    }
    const step4 = await mindPhoneAccounts(primary);
    verify = { confirmed: attachedHere(after), inUse: after ? !!after.inUse : null, poolServiceId: after ? after.serviceId || null : null, step4 };
    if (!verify.confirmed) console.warn("[mind] primary", primary, "attached to service", svc, "but the reserved pool does not confirm it");
  } catch (e) {
    console.warn("[mind] attach verify failed for", primary, "-", e.message);
  }

  const results = normalized.map(d => d === primary
    ? { number: d, status: alreadyAttached ? "already-attached" : "attached" }
    : { number: d, status: "pooled", inventory: ownedSet.has(d) ? "owned" : pooled.existing.includes(d) ? "exists" : "inserted" });
  return { serviceId: svc, accountId: String(accountId), primary, assigned: [primary], results, added, verify };
}

// ---- Activation ----
// Accounts and services are created with status NEW; once the order has
// fully provisioned they are flipped to ACTIVE via PATCH /accounts/{id} and
// PATCH /accounts/{id}/services/{id}. Best-effort: never throws — a failure
// here must never fail the completion, only be logged.
async function patchMindStatus(path, label) {
  const r = await mindCall("PATCH", path, { body: { status: "ACTIVE" } });
  if (!ok(r)) throw new Error(`${label} activation failed (HTTP ${r.status}): ${snippet(r)}`);
}

export async function activateMind(accountId, serviceId) {
  const out = { account: false, service: serviceId ? false : null, errors: [] };
  if (!accountId) {
    out.errors.push("no accountId — skipping status activation");
    console.warn("[mind] no accountId — skipping status activation");
    return out;
  }
  try {
    await patchMindStatus(`/accounts/${enc(accountId)}`, "account");
    out.account = true;
  } catch (e) {
    out.errors.push(e.message);
    console.warn("[mind]", e.message);
  }
  if (serviceId) {
    try {
      await patchMindStatus(`/accounts/${enc(accountId)}/services/${enc(serviceId)}`, "service");
      out.service = true;
    } catch (e) {
      out.errors.push(e.message);
      console.warn("[mind]", e.message);
    }
  }
  return out;
}

// Tests only: forget the city list and pick verdicts.
export function _resetForTests() {
  mindCitiesCache = null;
  pickVerdictCache.clear();
}
