// Demo stand-in for lib/espresso.js on the "Buy phone numbers" flow.
//
// With DID_DEMO=true, a basket started with { demo: true } runs the real /did
// routes against this module instead of Espresso: a search returns sample
// numbers built to match its filters, a hold is "reserving" for 3 s and then
// ready for an hour, and completing assigns the numbers at once. Nothing here
// touches the network. For demo baskets the routes also skip MIND, IristelX,
// the CRM and email, and take test cards only (lib/did-routes.js).
//
// Same exports the routes use from espresso.js, so the hold, refresh, cancel
// and complete logic is the real one.

import crypto from "crypto";
import { catalog, isNanp10, ten } from "./did-orders.js";
import { invFilter, orderState } from "./espresso.js";

export { invFilter, orderState };

export const DEMO_READY_MS = 3000;         // how long a hold shows "reserving"
export const DEMO_HOLD_MS = 60 * 60000;    // Espresso's one-hour hold
export const TEST_CARDS = { approve: "4242424242424242", decline: "4000000000000002" };

const OCN = "154E";
let clock = () => Date.now();

export function espressoConfig() {
  return { url: "demo", ocn: OCN, profileLabel: "Demo", acquisition: "BUY", configured: true };
}

// ---------- Inventory ----------
const RCS = catalog().rateCentres;

// Area codes the filters allow: the prefix, else the rate centre's, else the province's
function npasFor(filters) {
  const get = (name) => (filters.find((f) => f.category_name === name) || {}).category_value;
  const prefix = get("prefix"), rc = get("ratecenter"), prov = get("province");
  if (prefix) return [String(prefix).slice(1)];
  const rcs = rc ? RCS.filter((r) => r.rc === rc) : prov ? RCS.filter((r) => r.prov === prov) : RCS;
  return [...new Set(rcs.flatMap((r) => r.npas))].sort();
}

// The did filter inventoryFilters() builds → the digits to place and where
function didPattern(f) {
  if (!f) return null;
  const v = String(f.category_value);
  if (f.category_eq !== "like") return { core: v, at: "exact" };
  const s = v.startsWith("%"), e = v.endsWith("%");
  return { core: v.replace(/^%|%$/g, ""), at: s && e ? "any" : s ? "end" : e ? "start" : "exact" };
}

function likeRe(p) {
  const body = p.core.replace(/_/g, "\\d");
  return new RegExp((p.at === "start" || p.at === "exact" ? "^" : "") + body + (p.at === "end" || p.at === "exact" ? "$" : ""));
}

// Easy-to-remember endings: these are the "vanity" numbers
const TAILS = [
  (r) => { const a = digit(r); return a + a + a + a; },                      // 7777
  (r) => { const a = digit(r), b = digit(r); return a + b + a + b; },        // 2323
  (r) => { const a = digit(r), b = digit(r); return a + a + b + b; },        // 2255
  (r) => digit(r, 1) + "000",                                               // 5000
  (r) => { const i = Math.floor(r() * 7); return "0123456789".slice(i, i + 4); }, // 3456
];

export function isVanity(did) {
  const t = String(did).slice(-4);
  return /^(\d)\1\1\1$/.test(t) || /^(\d)(\d)\1\2$/.test(t) || /^(\d)\1(\d)\2$/.test(t) || /^[1-9]000$/.test(t)
    || "0123456789".includes(t) || "9876543210".includes(t);
}

function digit(r, min = 0) { return String(min + Math.floor(r() * (10 - min))); }

// Seeded, so the same search shows the same numbers every time
function prng(seed) {
  let a = crypto.createHash("sha1").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One 11-digit number on this area code that fits the pattern, or null
function build(npa, pat, r, allowed) {
  let ex;
  do { ex = digit(r, 2) + digit(r) + digit(r); } while (ex.endsWith("11"));
  const tail = r() < 0.2 ? TAILS[Math.floor(r() * TAILS.length)](r) : digit(r) + digit(r) + digit(r) + digit(r);
  const d = ("1" + npa + ex + tail).split("");
  if (pat) {
    const L = pat.core.length;
    if (L > 11) return null;
    let pos = 0;
    if (pat.at === "end") pos = 11 - L;
    else if (pat.at === "any") {
      // inside the local 7 digits when it fits, as a customer expects
      const lo = L <= 7 ? 4 : 1;
      pos = lo + Math.floor(r() * (11 - L - lo + 1));
    }
    for (let i = 0; i < L; i++) if (pat.core[i] !== "_") d[pos + i] = pat.core[i];
  }
  const n = d.join("");
  if (n[0] !== "1" || !allowed.has(n.slice(1, 4)) || !isNanp10(n.slice(1))) return null;
  return !pat || likeRe(pat).test(n) ? n : null;
}

const row = (n) => ({ number: n, status: "available", vanity: isVanity(n), ocn: OCN, account: null });

export async function inventorySearch(filters = [], { limit = 50, offset = 0 } = {}) {
  const pat = didPattern(filters.find((f) => f.category_name === "did"));
  const npas = npasFor(filters);
  const allowed = new Set(npas);
  if (!npas.length) return [];
  // One number asked for by name (the hold re-check, or an exact search)
  if (pat && pat.at === "exact" && !pat.core.includes("_")) {
    const d = ten(pat.core);
    return isNanp10(d) && allowed.has(d.slice(0, 3)) ? [row(`1${d}`)] : [];
  }
  const r = prng(`${JSON.stringify(filters)}|${offset}`);
  const out = new Set();
  for (let tries = 0; out.size < limit && tries < limit * 30; tries++) {
    const n = build(npas[Math.floor(r() * npas.length)], pat, r, allowed);
    if (n) out.add(n);
  }
  return [...out].sort().map(row);
}

export function inventoryRowFree(row, { allowVanity = false } = {}) {
  return !!row && row.status === "available" && !row.account && (allowVanity || row.vanity !== true);
}

// ---------- Orders ----------
// The id carries the creation time and the numbers, so a demo order still
// reads correctly after a restart; only "completed" and "cancelled" live in
// memory, and the basket record keeps those states itself.
const marks = new Map();

function notFound() { return Object.assign(new Error("demo order not found"), { status: 404, espressoCode: "NOT_FOUND" }); }

export async function createOrder({ dids = [] } = {}) {
  const id = `demo:${clock()}:${crypto.randomBytes(4).toString("hex")}:${dids.map((d) => `1${ten(d)}`).join("-")}`;
  return getOrder(id);
}

export async function getOrder(id) {
  const m = /^demo:(\d+):([0-9a-f]+):([\d-]*)$/.exec(String(id));
  if (!m) throw notFound();
  const created = Number(m[1]), now = clock(), mark = marks.get(id);
  const expires = created + DEMO_HOLD_MS;
  const status = mark ? mark.status : now > expires ? "EXPIRED" : "PENDING";
  const each = status === "COMPLETED" ? "ASSIGNED" : status === "PENDING" ? "RESERVED" : "RELEASED";
  const dids = (mark && mark.numbers) || (m[3] ? m[3].split("-") : []);
  return {
    id, orderNumber: `DEMO-${m[2].toUpperCase()}`, status,
    canComplete: status === "PENDING" && now - created >= DEMO_READY_MS,
    reservationExpiresAt: new Date(expires).toISOString(),
    numbers: dids.map((did) => ({ did, status: each })),
  };
}

export async function completeOrder(id, numbers) {
  const o = await getOrder(id);
  if (o.status === "COMPLETED") return o;
  if (o.status === "EXPIRED") throw Object.assign(new Error("hold expired"), { status: 409, espressoCode: "RESERVATION_EXPIRED" });
  if (o.status !== "PENDING") throw Object.assign(new Error(`order is ${o.status}`), { status: 409, espressoCode: "INELIGIBLE_STATUS" });
  marks.set(id, { status: "COMPLETED", numbers: (numbers && numbers.length ? numbers : o.numbers.map((n) => n.did)).map((d) => `1${ten(d)}`) });
  return getOrder(id);
}

export async function cancelOrder(id) {
  const o = await getOrder(id);
  if (o.status === "PENDING") marks.set(id, { status: "CANCELLED" });
  return getOrder(id);
}

// For tests
export function _setClock(fn) { clock = fn || (() => Date.now()); }
export function _reset() { marks.clear(); clock = () => Date.now(); }
