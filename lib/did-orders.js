// Order records, basket tokens and input rules for the self-serve
// "Buy phone numbers" flow (/did/* routes in lib/did-routes.js).
//
// Espresso holds the numbers; MIND bills them; this file only remembers which
// Espresso orders, customer details, destination and payment belong to one
// basket, so a refresh, a second tab or a server restart never loses them.
// Records live in a JSON file under STATE_DIR (a Render persistent disk in
// production) and are written atomically after every change.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const CATALOG = require("./did-catalog.json");

export const MAX_NUMBERS = 10;          // BRD FR03 proposed online limit
export const HOLD_MINUTES = 60;         // Espresso holds selectDids orders for one hour
export const ACTIVATION_WAIT_MS = 120000; // BRD: "Activation delayed" after 120 s

// ---------- Store ----------
let storePath = null;
let store = { orders: {} };

export function openStore(dir = process.env.STATE_DIR || ".") {
  storePath = path.join(dir, "did-orders.json");
  try { store = JSON.parse(fs.readFileSync(storePath, "utf8")); }
  catch { store = { orders: {} }; }
  if (!store.orders) store.orders = {};
  return store;
}

export function saveStore() {
  if (!storePath) openStore();
  const tmp = storePath + ".tmp";
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, storePath);
  } catch (e) {
    // A lost write can mean a second charge after a restart, so say so loudly.
    console.error("[did] ORDER STORE NOT PERSISTED —", e.message, "— set STATE_DIR to a Render disk mount");
  }
}

export const getOrder = (ref) => store.orders[ref] || null;
export const allOrders = () => Object.values(store.orders);

export function putOrder(rec) {
  rec.updatedAt = new Date().toISOString();
  store.orders[rec.ref] = rec;
  saveStore();
  return rec;
}

export function logEvent(rec, type, detail) {
  (rec.events = rec.events || []).push({ at: new Date().toISOString(), type, ...(detail ? { detail: String(detail).slice(0, 500) } : {}) });
  if (rec.events.length > 60) rec.events.splice(0, rec.events.length - 60);
}

// Finished or abandoned orders older than 30 days are dropped; anything that
// took money is kept until fulfilment is resolved.
export function pruneStore(now = Date.now()) {
  const keepMs = 30 * 24 * 3600 * 1000;
  let n = 0;
  for (const [ref, r] of Object.entries(store.orders)) {
    const done = ["active", "expired", "cancelled", "failed"].includes(r.state);
    if (done && now - Date.parse(r.updatedAt || r.createdAt) > keepMs) { delete store.orders[ref]; n++; }
  }
  if (n) saveStore();
  return n;
}

// ---------- Refs and basket tokens ----------
// The ref is readable (shown to customers and on the receipt). The token is
// ref + HMAC, so only the browser that created the basket — or the link in
// the confirmation email — can read or change it.
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newRef(now = new Date()) {
  const d = now.toISOString().slice(2, 10).replace(/-/g, "");
  let s = "";
  for (const b of crypto.randomBytes(6)) s += B32[b % B32.length];
  return `IR${d}-${s}`;
}

function sign(ref, secret) {
  return crypto.createHmac("sha256", secret).update(`did-basket:${ref}`).digest("base64url").slice(0, 32);
}

export function makeToken(ref, secret = process.env.ORDER_TOKEN_SECRET) {
  if (!secret) throw new Error("ORDER_TOKEN_SECRET is not set");
  return `${ref}.${sign(ref, secret)}`;
}

// → the ref, or null when the token is missing, malformed or forged
export function verifyToken(token, secret = process.env.ORDER_TOKEN_SECRET) {
  if (!secret || typeof token !== "string") return null;
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const ref = token.slice(0, i), sig = token.slice(i + 1);
  const want = sign(ref, secret);
  if (sig.length !== want.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) ? ref : null;
}

// ---------- Numbers ----------
export const digitsOnly = (s) => String(s == null ? "" : s).replace(/\D/g, "");

// 10-digit NANP (what the browser, the store and the receipt use)
export function ten(n) {
  const d = digitsOnly(n);
  return d.length === 11 && d[0] === "1" ? d.slice(1) : d;
}

export const isNanp10 = (d) => /^[2-9]\d{2}[2-9]\d{6}$/.test(d);
export const displayNumber = (d) => (d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : d);

// Phone keypad letters → digits (BRD: "Normalize keypad letters to digits")
const KEYPAD = { a: 2, b: 2, c: 2, d: 3, e: 3, f: 3, g: 4, h: 4, i: 4, j: 5, k: 5, l: 5, m: 6, n: 6, o: 6,
  p: 7, q: 7, r: 7, s: 7, t: 8, u: 8, v: 8, w: 9, x: 9, y: 9, z: 9 };

export function keypadDigits(word) {
  return String(word || "").toLowerCase().split("").map((c) => (/\d/.test(c) ? c : KEYPAD[c] ?? "")).join("");
}

// ---------- Catalog ----------
export const PROVINCES = { AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut",
  ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon" };

export function catalog() {
  const provs = [...new Set(CATALOG.rateCentres.map((r) => r.prov))].sort()
    .map((code) => ({ code, name: PROVINCES[code] || code }));
  return { provinces: provs, rateCentres: CATALOG.rateCentres };
}

const NPA_PROV = new Map();
for (const r of CATALOG.rateCentres) for (const n of r.npas) if (!NPA_PROV.has(n)) NPA_PROV.set(n, r.prov);
const RC_BY_KEY = new Map(CATALOG.rateCentres.map((r) => [`${r.prov}|${r.rc}`, r]));

export function findRateCentre(rc, prov) {
  if (!rc) return null;
  const key = String(rc).trim().toUpperCase();
  return RC_BY_KEY.get(`${String(prov || "").toUpperCase()}|${key}`)
    || CATALOG.rateCentres.find((r) => r.rc === key) || null;
}

export function locationFor(did, rateCentre) {
  if (rateCentre) return `${rateCentre.name}, ${rateCentre.prov}`;
  const prov = NPA_PROV.get(did.slice(0, 3));
  return prov ? `Area code ${did.slice(0, 3)}, ${prov}` : `Area code ${did.slice(0, 3)}`;
}

// ---------- Search ----------
// Turns the search panel into Espresso inventory filters. The digit pattern
// uses the inventory's LIKE operator on the 11-digit number; matchesPattern()
// re-checks every row, so a pattern the inventory can't apply never shows a
// wrong number.
export const MATCHES = ["contains", "starts", "ends", "exact"];

export function searchPlan(q = {}) {
  const errors = {};
  const province = q.province ? String(q.province).toUpperCase() : "";
  if (province && !PROVINCES[province]) errors.province = "Choose a province or territory from the list.";
  const rc = q.ratecenter ? findRateCentre(q.ratecenter, province) : null;
  if (q.ratecenter && !rc) errors.ratecenter = "Choose a city or rate centre from the list.";
  const npa = digitsOnly(q.areaCode);
  if (npa && !/^[2-9]\d\d$/.test(npa)) errors.areaCode = "Enter a 3-digit area code.";
  const fromWord = q.word ? keypadDigits(q.word) : "";
  if (q.word && fromWord.length !== String(q.word).replace(/[\s-]/g, "").length) {
    errors.word = "Use letters and digits only.";
  }
  const pattern = digitsOnly(q.digits) || fromWord;
  if (pattern.length > 10) errors.digits = "Enter up to 10 digits or letters.";
  const match = MATCHES.includes(q.match) ? q.match : "contains";
  const type = ["all", "basic", "vanity"].includes(q.type) ? q.type : "all";
  const page = Math.max(0, Math.min(20, parseInt(q.page, 10) || 0));
  return { errors, province, rc, npa, pattern, word: q.word ? String(q.word).toUpperCase() : "", match, type, page };
}

export function inventoryFilters(plan, ocn, invFilter) {
  const f = [invFilter("status", "available"), invFilter("provider_code", ocn)];
  if (plan.rc) f.push(invFilter("ratecenter", plan.rc.rc));
  else if (plan.province) f.push(invFilter("province", plan.province));
  if (plan.npa) f.push(invFilter("prefix", `1${plan.npa}`));
  if (plan.pattern) {
    const p = plan.pattern;
    let like = `%${p}%`;
    if (plan.match === "ends") like = `%${p}`;
    if (plan.match === "starts") like = plan.npa ? `1${plan.npa}${p}%` : `1___${p}%`;
    if (plan.match === "exact" && p.length === 10) like = `1${p}`;
    else if (plan.match === "exact" && p.length === 7 && plan.npa) like = `1${plan.npa}${p}`;
    f.push(invFilter("did", like, "like"));
  }
  return f;
}

export function matchesPattern(did, plan) {
  const p = plan.pattern;
  if (!p) return true;
  const local = did.slice(3);
  switch (plan.match) {
    case "starts": return local.startsWith(p) || did.startsWith(p);
    case "ends": return did.endsWith(p);
    case "exact": return did === p || (p.length === 7 && local === p);
    default: return did.includes(p);
  }
}

// ---------- Customer details (S02) ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTAL_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d$/i;
const clean = (v, max = 120) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

export function validateDetails(b = {}) {
  const d = {
    segment: b.segment === "residential" ? "residential" : "business",
    firstName: clean(b.firstName, 60), lastName: clean(b.lastName, 60),
    email: clean(b.email, 160).toLowerCase(), phone: digitsOnly(b.phone).slice(-11),
    company: clean(b.company, 120), address1: clean(b.address1, 160), city: clean(b.city, 80),
    province: clean(b.province, 2).toUpperCase(), postalCode: clean(b.postalCode, 7).toUpperCase(), country: "CA",
  };
  const errors = {};
  if (!d.firstName) errors.firstName = "Enter your first name.";
  if (!d.lastName) errors.lastName = "Enter your last name.";
  if (!EMAIL_RE.test(d.email)) errors.email = "Enter a valid email address.";
  if (!isNanp10(ten(d.phone))) errors.phone = "Enter a 10-digit phone number.";
  else d.phone = ten(d.phone);
  // BRD: residential accounts never need a business name
  if (d.segment === "business" && !d.company) errors.company = "Enter your business name.";
  if (d.segment === "residential") d.company = "";
  if (!d.address1) errors.address1 = "Enter your billing address.";
  if (!d.city) errors.city = "Enter your city.";
  if (!PROVINCES[d.province]) errors.province = "Choose a province or territory.";
  if (!POSTAL_RE.test(d.postalCode)) errors.postalCode = "Enter a valid Canadian postal code.";
  else d.postalCode = d.postalCode.replace(/[ -]/, "").replace(/^(.{3})/, "$1 ");
  return { details: d, errors };
}

// ---------- Destination (S03) ----------
// Numbers route through Espresso profile "Profile 718524 DID E164"; what the
// customer enters here is saved on the order and sent to provisioning, who
// point the trunk at it. Private, loopback and link-local addresses are
// refused (they can't be a customer's public SIP endpoint, and probing them
// would be server-side request abuse — BRD External PBX section).
const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^2(2[4-9]|[3-5]\d)\./];

export function isPublicIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s || "");
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return false;
  return !PRIVATE_V4.some((re) => re.test(s));
}

export const isFqdn = (s) => /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(s || "")
  && !/(^|\.)(localhost|local|internal|lan|home|corp)$/i.test(s || "");

export function validateConnect(b = {}, orderedNumbers = []) {
  const type = ["pbx", "iristel", "forward"].includes(b.type) ? b.type : "";
  const out = { type, method: "", host: "", port: "", transport: "", platform: clean(b.platform, 80),
    failover: "", provider: "", forwardTo: "", notes: clean(b.notes, 500) };
  const errors = {};
  if (!type) errors.type = "Choose where calls should go.";
  if (type === "pbx") {
    out.method = ["static", "dynamic", "managed"].includes(b.method) ? b.method : "";
    if (!out.method) errors.method = "Choose a SIP connection method.";
    if (out.method === "static") {
      out.host = clean(b.host, 253).toLowerCase();
      if (!isPublicIPv4(out.host) && !isFqdn(out.host)) errors.host = "Enter a public IP address or a fully qualified domain name.";
      const port = parseInt(b.port || "5060", 10);
      if (!(port >= 1 && port <= 65535)) errors.port = "Enter a port from 1 to 65535.";
      out.port = String(port);
      out.transport = ["udp", "tcp", "tls"].includes(String(b.transport).toLowerCase()) ? String(b.transport).toLowerCase() : "udp";
      if (b.failover) {
        out.failover = clean(b.failover, 253).toLowerCase();
        if (!isPublicIPv4(out.failover) && !isFqdn(out.failover)) errors.failover = "Enter a public IP address or domain, or leave it empty.";
      }
    }
    if (out.method === "managed") {
      out.provider = clean(b.provider, 80);
      if (!out.provider) errors.provider = "Enter the platform provider's name.";
    }
    if (!out.platform && out.method !== "managed") errors.platform = "Tell us which PBX or calling platform you use.";
  }
  if (type === "forward") {
    out.forwardTo = ten(b.forwardTo);
    if (!isNanp10(out.forwardTo)) errors.forwardTo = "Enter a 10-digit Canadian or US number.";
    else if (orderedNumbers.includes(out.forwardTo)) errors.forwardTo = "Forward to a different number than the one you are buying.";
  }
  return { connect: out, errors };
}

// ---------- Rate limits ----------
// Render sits behind a proxy, so the client is the first X-Forwarded-For hop.
export function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket?.remoteAddress || "unknown";
}

export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(), ip = clientIp(req);
    const h = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (h.length >= max) {
      res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ code: "RATE_LIMITED", message: "Please try again in a moment." });
    }
    h.push(now);
    hits.set(ip, h);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    next();
  };
}

// ---------- Public view ----------
// What the browser may see: never the card token, the MIND ids or the event log.
export function publicOrder(rec) {
  if (!rec) return null;
  return {
    ref: rec.ref,
    state: rec.state,
    model: rec.model || "rent",
    holdExpiresAt: rec.holdExpiresAt || null,
    numbers: (rec.numbers || []).filter((n) => !n.removed).map((n) => ({
      did: n.did, display: displayNumber(n.did), category: n.category, location: n.location,
      capabilities: ["voice"], status: n.status || null,
    })),
    taken: rec.taken || [],
    details: rec.details ? { ...rec.details } : null,
    connect: rec.connect || null,
    quote: rec.quote || null,
    payment: rec.payment && rec.payment.outcome
      ? { outcome: rec.payment.outcome, reference: rec.payment.reference, amount: rec.payment.amount,
          masked: rec.payment.masked || null, paidAt: rec.payment.chargedAt || null }
      : null,
    activatedAt: rec.activatedAt || null,
    nextBill: rec.nextBill || null,
    message: rec.publicMessage || null,
  };
}
