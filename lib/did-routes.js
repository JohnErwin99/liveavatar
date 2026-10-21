// /did/* — self-serve "Buy phone numbers" for iristel.com (Webflow pages
// /phone-numbers/find → account → connect → review → order).
//
// Flow (BRD v2.0, Rent model only; Purchase stays behind its flag):
//   search   Espresso inventory (available, OCN 154E), each number re-checked in MIND
//   hold     an Espresso order with selectDids:true per vanity group → a one-hour hold
//   details  customer (business or residential) and billing address
//   connect  where calls go; saved for provisioning (routing is profile "Profile 718524 DID E164")
//   pay      MIND account → card saved through IristelX → "bot payment" for today's total
//   fulfil   complete the Espresso order(s) → MIND service + DID quantity + numbers → D365 → emails
// Espresso and IristelX credentials never reach the browser; the browser holds
// only the basket token (ref + HMAC).

import express from "express";
import {
  openStore, getOrder, putOrder, allOrders, logEvent, pruneStore, newRef, makeToken, verifyToken,
  ten, isNanp10, displayNumber, catalog, findRateCentre, locationFor, searchPlan, inventoryFilters,
  matchesPattern, validateDetails, validateConnect, rateLimit, publicOrder, MAX_NUMBERS, HOLD_MINUTES,
  ACTIVATION_WAIT_MS,
} from "./did-orders.js";
import { loadPrices, quote, priceFor } from "./did-prices.js";
import * as espresso from "./espresso.js";
import * as mind from "./mind.js";
import * as pay from "./iristelx-pay.js";
import { sendMail, opsAlert, confirmationHtml, opsHtml, destinationLines } from "./did-mail.js";

const enabled = () => process.env.DID_ORDERING_ENABLED === "true";
const mindCheckOn = () => process.env.DID_MIND_CHECK !== "off" && !!process.env.MIND_API_KEY;
const SITE = () => (process.env.DID_SITE_URL || "https://iristel.webflow.io").replace(/\/+$/, "");
const stateOf = (o) => { const s = espresso.orderState(o); return typeof s === "string" ? s : (s && s.state) || "unknown"; };
const reasonOf = (o) => { const s = espresso.orderState(o); return (s && s.reason && (s.reason.message || s.reason.code)) || o?.rejectionReason?.message || o?.failureReason?.message || ""; };
const eleven = (d) => `1${ten(d)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ code, message, ...extra });
}

function tokenFrom(req) {
  return req.get("X-Order-Token") || req.query.t || (req.body && req.body.token) || "";
}

// The basket for this request, or an error response
function basket(req, res) {
  const ref = verifyToken(tokenFrom(req));
  if (!ref) { fail(res, 403, "FORBIDDEN", "This order link is not valid."); return null; }
  const rec = getOrder(ref);
  if (!rec) { fail(res, 404, "NOT_FOUND", "We couldn't find this order."); return null; }
  return rec;
}

const live = (rec) => (rec.numbers || []).filter((n) => !n.removed);

function requote(rec) {
  rec.quote = quote(live(rec).map((n) => ({ did: n.did, category: n.category })));
  return rec.quote;
}

// Numbers on other baskets that still hold or own them
function numbersInOtherBaskets(exceptRef) {
  const held = new Set();
  for (const r of allOrders()) {
    if (r.ref === exceptRef || ["expired", "cancelled", "rejected"].includes(r.state)) continue;
    live(r).forEach((n) => held.add(n.did));
  }
  return held;
}

// ---------- Hold refresh ----------
// Reads each Espresso order of a basket and moves the basket along:
// reserving → held (all canComplete) | rejected (a number was gone) | expired.
async function refreshHold(rec) {
  if (!["reserving", "held"].includes(rec.state)) return rec;
  let ready = 0, expiries = [];
  for (const e of rec.espresso || []) {
    if (["cancelled", "rejected", "failed", "expired", "completed"].includes(e.state)) continue;
    let o;
    try { o = await espresso.getOrder(e.id); } catch (err) { logEvent(rec, "espresso-read-failed", err.message); continue; }
    e.state = stateOf(o);
    e.status = o.status;
    e.orderNumber = o.orderNumber || e.orderNumber;
    if (o.reservationExpiresAt) e.reservationExpiresAt = o.reservationExpiresAt;
    if (e.state === "ready") { ready++; expiries.push(Date.parse(o.reservationExpiresAt)); }
    if (e.state === "rejected" || e.state === "failed") {
      // Which of the basket's numbers Espresso could not reserve
      const got = new Set((o.numbers || []).map((n) => ten(n.did)));
      rec.taken = [...new Set([...(rec.taken || []), ...e.dids.filter((d) => !got.has(d))])];
      e.reason = reasonOf(o);
    }
  }
  const active = (rec.espresso || []).filter((e) => !["cancelled"].includes(e.state));
  if (active.some((e) => e.state === "rejected" || e.state === "failed")) {
    rec.state = "rejected";
    rec.publicMessage = "Some of these numbers are no longer available. Choose other numbers to continue.";
    await cancelBasket(rec, "another number in the basket could not be reserved");
    rec.state = "rejected";
  } else if (active.some((e) => e.state === "expired")) {
    rec.state = "expired";
  } else if (active.length && ready === active.length) {
    rec.state = "held";
    rec.holdExpiresAt = new Date(Math.min(...expiries)).toISOString();
  }
  if (rec.state === "held" && rec.holdExpiresAt && Date.parse(rec.holdExpiresAt) < Date.now()) rec.state = "expired";
  putOrder(rec);
  return rec;
}

async function cancelBasket(rec, reason) {
  for (const e of rec.espresso || []) {
    if (!["reserving", "ready"].includes(e.state)) continue;
    try { await espresso.cancelOrder(e.id, reason); e.state = "cancelled"; }
    catch (err) { logEvent(rec, "espresso-cancel-failed", err.message); }
  }
  rec.state = "cancelled";
  putOrder(rec);
}

// ---------- Fulfilment ----------
// Runs after a successful charge, again from the background loop until done.
// Every step is recorded, so a restart resumes where it stopped and nothing
// is done twice.
const fulfilling = new Set();

async function fulfil(ref) {
  if (fulfilling.has(ref)) return;
  fulfilling.add(ref);
  const rec = getOrder(ref);
  try {
    if (!rec || !["completing", "delayed"].includes(rec.state)) return;
    const s = (rec.steps = rec.steps || {});
    const kept = live(rec).map((n) => n.did);

    // 1. Espresso: complete each order, keeping only the numbers still in the basket
    for (const e of rec.espresso || []) {
      if (e.state === "completed") continue;
      const mine = e.dids.filter((d) => kept.includes(d));
      if (!e.completeRequested) {
        try {
          await espresso.completeOrder(e.id, mine.map(eleven));
          e.completeRequested = new Date().toISOString();
          logEvent(rec, "espresso-complete-requested", e.id);
        } catch (err) {
          if (err.espressoCode === "INELIGIBLE_STATUS") e.completeRequested = new Date().toISOString();
          else {
            logEvent(rec, "espresso-complete-failed", `${err.espressoCode || ""} ${err.message}`);
            return delay(rec, `Espresso refused to complete order ${e.orderNumber || e.id}: ${err.espressoCode || err.message}. `
              + (err.espressoCode === "RESERVATION_EXPIRED" ? "The hold expired after payment — re-order these numbers or refund." : ""));
          }
        }
      }
      const deadline = Date.now() + 30000;
      for (;;) {
        let o;
        try { o = await espresso.getOrder(e.id); } catch (err) { logEvent(rec, "espresso-read-failed", err.message); break; }
        e.state = stateOf(o); e.status = o.status;
        if (e.state === "completed") {
          for (const n of o.numbers || []) {
            const hit = rec.numbers.find((x) => x.did === ten(n.did));
            if (hit) hit.status = n.status;
          }
          break;
        }
        if (["failed", "rejected", "expired", "cancelled"].includes(e.state)) {
          return delay(rec, `Espresso order ${e.orderNumber || e.id} ended ${o.status}: ${reasonOf(o)}`);
        }
        if (Date.now() > deadline) break;
        await sleep(3000);
      }
    }
    putOrder(rec);
    if ((rec.espresso || []).some((e) => e.state !== "completed")) {
      if (Date.now() - Date.parse(rec.payment.chargedAt) > ACTIVATION_WAIT_MS && rec.state !== "delayed") {
        return delay(rec, "Espresso has not finished assigning the numbers within 120 seconds.");
      }
      return; // the background loop tries again
    }
    s.espresso = s.espresso || new Date().toISOString();

    // 2. MIND: service on the account, DID quantity, numbers attached, active
    const contact = mindContact(rec.details);
    if (!rec.mind.serviceId) {
      const r = await mind.createMindService(rec.mind.accountId, process.env.DID_MIND_PLAN || "EXLNP_SBSIPTRNK", contact, rec.details.email);
      rec.mind.serviceId = r.serviceId;
      putOrder(rec);
    }
    if (!s.mindQty) {
      const lines = await mind.mindServiceLines(rec.mind.accountId, rec.mind.serviceId);
      const want = { EXLNP_SBDID: kept.length, EXLNP_SBSIPTRNK: Number(process.env.DID_MIND_CHANNELS || 0) };
      for (const [code, qty] of Object.entries(want)) {
        if (!lines.includes(code)) { if (qty) throw new Error(`MIND service ${rec.mind.serviceId} has no ${code} line`); continue; }
        await mind.putServiceQuantity(rec.mind.accountId, rec.mind.serviceId, code, qty);
      }
      s.mindQty = new Date().toISOString();
      putOrder(rec);
    }
    if (!s.mindNumbers) {
      // One call for all numbers, primary first: it adds them to MIND's
      // inventory itself and attaches the primary (a service holds one
      // number; the rest sit in the account's reserved pool). A separate
      // inventory add first would make our own numbers look taken. Numbers
      // added on an earlier attempt are passed back as `owned`.
      const cities = {};
      for (const n of live(rec)) {
        const city = await mind.resolveMindCity({ ratecenter: n.rc || null, npa: n.did.slice(0, 3) });
        if (!city) throw new Error(`MIND has no city for ${n.rc || "area code " + n.did.slice(0, 3)}`);
        cities[eleven(n.did)] = city;
      }
      const r = await mind.attachNumbersToService(rec.mind.accountId, rec.mind.serviceId, live(rec).map((n) => eleven(n.did)),
        cities, { owned: rec.mind.owned || [] });
      rec.mind.owned = [...new Set([...(rec.mind.owned || []), ...(r.added || [])])];
      rec.mind.primary = r.primary || null;
      s.mindNumbers = new Date().toISOString();
      putOrder(rec);
    }
    if (!s.mindActive) { await mind.activateMind(rec.mind.accountId, rec.mind.serviceId); s.mindActive = new Date().toISOString(); }

    // 3. Active. CRM and email are best-effort and never undo it.
    rec.state = "active";
    rec.activatedAt = rec.activatedAt || new Date().toISOString();
    live(rec).forEach((n) => { n.status = "ACTIVE"; });
    rec.publicMessage = null;
    putOrder(rec);
    await afterActive(rec);
  } catch (err) {
    logEvent(rec, "fulfil-error", err.message);
    console.error("[did] fulfil", ref, err.message);
    if (rec && rec.state === "completing" && Date.now() - Date.parse(rec.payment.chargedAt) > ACTIVATION_WAIT_MS) {
      await delay(rec, `Fulfilment error: ${err.message}`);
    } else if (rec) putOrder(rec);
  } finally {
    fulfilling.delete(ref);
  }
}

async function delay(rec, why) {
  const first = rec.state !== "delayed";
  rec.state = "delayed";
  rec.publicMessage = "Your payment is confirmed and your order is processing. We'll email you as soon as your numbers are active — there's no need to pay again.";
  logEvent(rec, "delayed", why);
  putOrder(rec);
  if (first) await opsAlert(`Phone numbers order ${rec.ref} needs attention`, opsHtml(rec, "Activation delayed after payment", [why]), { ref: rec.ref });
}

async function afterActive(rec) {
  const s = rec.steps;
  const orderUrl = `${SITE()}/phone-numbers/order?ref=${encodeURIComponent(rec.ref)}&t=${encodeURIComponent(makeToken(rec.ref))}`;
  if (!s.crm && deps.crmLead) {
    try {
      const d = rec.details;
      await deps.crmLead({
        first_name: d.firstName, last_name: d.lastName, email: d.email, company: d.company || "", phone: d.phone,
        topic: "Phone numbers", source: "phone-numbers-order",
        details: [
          `Online order: ${rec.ref} (paid, active)`,
          `Numbers: ${live(rec).map((n) => displayNumber(n.did)).join(", ")}`,
          `Paid today: $${rec.quote.dueToday} CAD, reference ${rec.payment.reference}; then $${rec.quote.monthly}/month`,
          `Customer type: ${d.segment}`,
          `MIND account ${rec.mind.accountId}, service ${rec.mind.serviceId}`,
          ...destinationLines(rec.connect),
        ],
        qualification: { country: "Canada", products: "Phone numbers" },
      });
      s.crm = new Date().toISOString();
    } catch (e) { logEvent(rec, "crm-failed", e.message); }
  }
  if (!s.mailCustomer && await sendMail({ to: rec.details.email, subject: `Your Iristel phone numbers — order ${rec.ref}`, html: confirmationHtml(rec, orderUrl) })) {
    s.mailCustomer = new Date().toISOString();
  }
  if (!s.mailOps && await opsAlert(`New online phone numbers order ${rec.ref}`, opsHtml(rec, "New self-serve phone numbers order — connect the customer's destination"), { ref: rec.ref })) {
    s.mailOps = new Date().toISOString();
  }
  putOrder(rec);
}

function mindContact(d) {
  return { fname: d.firstName, lname: d.lastName, address1: d.address1, city: d.city, province: d.province,
    country: "CA", postalCode: d.postalCode, emailAddress: d.email, phone: d.phone, language: "en" };
}

// Housekeeping: resume fulfilment, expire holds, flag payments that never answered
function sweep() {
  for (const rec of allOrders()) {
    if (["completing", "delayed"].includes(rec.state)) fulfil(rec.ref).catch(() => {});
    if (rec.state === "held" && rec.holdExpiresAt && Date.parse(rec.holdExpiresAt) < Date.now()) { rec.state = "expired"; putOrder(rec); }
    if (rec.state === "paying" && rec.payment?.outcome === "pending" && Date.now() - Date.parse(rec.payment.startedAt) > 5 * 60000) {
      rec.payment.outcome = "unknown";
      rec.state = "payment_unknown";
      putOrder(rec);
      opsAlert(`Payment outcome unknown — order ${rec.ref}`, opsHtml(rec, "A payment never returned a result. Check MIND/Moneris before anyone retries."), { ref: rec.ref });
    }
  }
  pruneStore();
}

const deps = {};

export function createDidRouter({ crmLead } = {}) {
  deps.crmLead = crmLead;
  openStore();
  const timer = setInterval(sweep, 30000);
  timer.unref?.();

  const r = express.Router();
  const searchLimit = rateLimit({ windowMs: 60000, max: 30 });
  const holdLimit = rateLimit({ windowMs: 10 * 60000, max: 8 });
  const payLimit = rateLimit({ windowMs: 10 * 60000, max: 6 });

  // Config the pages read first: the kill switch, prices, limits
  r.get("/config", (_req, res) => {
    const p = loadPrices();
    res.json({
      enabled: enabled(),
      purchaseEnabled: false,
      maxNumbers: MAX_NUMBERS,
      holdMinutes: HOLD_MINUTES,
      prices: { approved: !!p.approved, currency: p.currency, taxRate: p.taxRate,
        categories: Object.fromEntries(Object.entries(p.categories).map(([k, v]) => [k, { label: v.label, ...priceFor(k, p) }])) },
      espresso: { configured: espresso.espressoConfig().configured },
    });
  });

  r.get("/catalog", (_req, res) => { res.set("Cache-Control", "public, max-age=3600"); res.json(catalog()); });

  // The step app the Webflow pages load (kept here so it ships with the API it calls)
  const appDir = new URL("../public/did/", import.meta.url);
  r.get(["/app.js", "/app.css"], (req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.type(req.path.endsWith(".css") ? "text/css" : "application/javascript");
    res.sendFile(new URL("." + req.path, appDir).pathname);
  });

  // The kill switch stops new orders; existing baskets and order status stay
  // readable (BRD launch rollback), and a basket can still be cancelled.
  const on = (req, res, next) => (enabled() ? next() : fail(res, 503, "DISABLED", "Online ordering is temporarily unavailable. Please call 1 833 IRISTEL (474 7835)."));

  r.post("/search", on, searchLimit, async (req, res) => {
    const plan = searchPlan(req.body || {});
    if (Object.keys(plan.errors).length) return fail(res, 400, "INVALID_REQUEST", "Check the search fields.", { errors: plan.errors });
    if (!plan.rc && !plan.province && !plan.npa) return fail(res, 400, "INVALID_REQUEST", "Choose a province, a city or an area code.", { errors: { province: "Choose a province, a city or an area code." } });
    const want = 12;
    try {
      const cfg = espresso.espressoConfig();
      const filters = inventoryFilters(plan, cfg.ocn, espresso.invFilter);
      const busy = numbersInOtherBaskets(null);
      const rows = await espresso.inventorySearch(filters, { limit: 100, offset: plan.page * 100 });
      const candidates = [];
      for (const row of rows) {
        if (!espresso.inventoryRowFree(row, { allowVanity: plan.type !== "basic" })) continue;
        const did = ten(row.number);
        const category = row.vanity ? "vanity" : "basic";
        if (!isNanp10(did) || busy.has(did) || !matchesPattern(did, plan)) continue;
        if (plan.type === "vanity" && category !== "vanity") continue;
        candidates.push({ did, category });
      }
      const results = [];
      for (let i = 0; i < candidates.length && results.length < want; i += 5) {
        const batch = candidates.slice(i, i + 5);
        const verdicts = await Promise.all(batch.map((c) => (mindCheckOn()
          ? mind.cachedPickVerdict(eleven(c.did)).catch(() => ({ free: false }))
          : Promise.resolve({ free: true }))));
        batch.forEach((c, j) => { if (verdicts[j].free && results.length < want) results.push(c); });
      }
      const prices = loadPrices();
      res.json({
        page: plan.page,
        more: rows.length === 100,
        match: plan.pattern ? { pattern: plan.pattern, word: plan.word, type: plan.match } : null,
        results: results.map((c) => ({
          did: c.did, display: displayNumber(c.did), category: c.category,
          location: locationFor(c.did, plan.rc), rc: plan.rc ? plan.rc.rc : null,
          capabilities: ["voice"], ...priceFor(c.category, prices),
        })),
      });
    } catch (e) {
      console.error("[did] search", e.message);
      return fail(res, 503, "INVENTORY_UNAVAILABLE", "Number search is temporarily unavailable. Please try again shortly.");
    }
  });

  // Hold the chosen numbers (one Espresso order per vanity group)
  r.post("/hold", on, holdLimit, async (req, res) => {
    const picks = Array.isArray(req.body?.numbers) ? req.body.numbers : [];
    const dids = [...new Set(picks.map((p) => ten(typeof p === "string" ? p : p.did)))];
    if (!dids.length || dids.length > MAX_NUMBERS || !dids.every(isNanp10)) {
      return fail(res, 400, "INVALID_REQUEST", `Choose between 1 and ${MAX_NUMBERS} numbers.`);
    }
    // A basket being replaced (the customer went back and changed numbers)
    const oldRef = verifyToken(tokenFrom(req));
    const old = oldRef && getOrder(oldRef);
    try {
      const busy = numbersInOtherBaskets(oldRef);
      // One inventory lookup per number, as OnlineOrdering's unavailablePicks does
      const byDid = new Map();
      await Promise.all(dids.map(async (d) => {
        const rows = await espresso.inventorySearch([espresso.invFilter("did", `1${d}`)], { limit: 5, offset: 0 });
        byDid.set(d, rows.find((row) => ten(row.number) === d) || null);
      }));
      const taken = [], numbers = [];
      for (const did of dids) {
        const row = byDid.get(did);
        if (!row || !espresso.inventoryRowFree(row, { allowVanity: true }) || busy.has(did)) { taken.push(did); continue; }
        if (mindCheckOn()) {
          const v = await mind.mindPickVerdict(`1${did}`).catch(() => ({ free: false }));
          if (!v.free) { taken.push(did); continue; }
        }
        const pick = picks.find((p) => ten(typeof p === "string" ? p : p.did) === did) || {};
        const rc = pick.rc ? findRateCentre(pick.rc) : null;
        numbers.push({ did, category: row.vanity ? "vanity" : "basic", rc: rc ? rc.rc : null, location: locationFor(did, rc) });
      }
      if (taken.length) {
        return fail(res, 409, "NUMBER_UNAVAILABLE", "Some numbers are no longer available. Choose another.", { taken });
      }
      if (old && ["reserving", "held"].includes(old.state)) await cancelBasket(old, "customer changed the selection");

      const rec = { ref: newRef(), createdAt: new Date().toISOString(), state: "reserving", model: "rent",
        numbers, espresso: [], taken: [], mind: {}, steps: {}, events: [] };
      for (const vanity of [false, true]) {
        const group = numbers.filter((n) => (n.category === "vanity") === vanity).map((n) => n.did);
        if (!group.length) continue;
        try {
          const o = await espresso.createOrder({ dids: group.map(eleven), vanity, reference: `${rec.ref}${vanity ? "-V" : ""}`, selectDids: true });
          rec.espresso.push({ id: o.id, orderNumber: o.orderNumber, vanity, dids: group, state: stateOf(o), status: o.status });
        } catch (err) {
          logEvent(rec, "espresso-create-failed", `${err.espressoCode || ""} ${err.message}`);
          putOrder(rec);
          await cancelBasket(rec, "order could not be placed");
          if (err.espressoCode === "ADMISSION_LIMIT") return fail(res, 503, "BUSY", "We're handling a lot of orders right now. Please try again in a few minutes.");
          throw err;
        }
      }
      requote(rec);
      logEvent(rec, "held", rec.espresso.map((e) => e.orderNumber).join(","));
      putOrder(rec);
      res.status(201).json({ token: makeToken(rec.ref), order: publicOrder(rec) });
    } catch (e) {
      console.error("[did] hold", e.message);
      return fail(res, 503, "INVENTORY_UNAVAILABLE", "We couldn't reserve these numbers right now. Please try again shortly.");
    }
  });

  r.get("/basket", async (req, res) => {
    const rec = basket(req, res);
    if (!rec) return;
    await refreshHold(rec);
    res.json({ order: publicOrder(rec) });
  });

  r.post("/basket/remove", on, async (req, res) => {
    const rec = basket(req, res);
    if (!rec) return;
    if (!["reserving", "held"].includes(rec.state)) return fail(res, 409, "INELIGIBLE_STATUS", "This order can no longer be changed.");
    const did = ten(req.body?.did);
    const n = rec.numbers.find((x) => x.did === did && !x.removed);
    if (!n) return fail(res, 404, "NOT_FOUND", "That number isn't in your order.");
    n.removed = true;
    if (!live(rec).length) await cancelBasket(rec, "customer removed every number");
    requote(rec);
    putOrder(rec);
    res.json({ order: publicOrder(rec) });
  });

  r.post("/basket/cancel", async (req, res) => {
    const rec = basket(req, res);
    if (!rec) return;
    if (["reserving", "held"].includes(rec.state)) await cancelBasket(rec, "customer cancelled");
    res.json({ order: publicOrder(rec) });
  });

  r.post("/details", on, async (req, res) => {
    const rec = basket(req, res);
    if (!rec) return;
    await refreshHold(rec);
    if (rec.state !== "held" && rec.state !== "reserving") return fail(res, 409, "HOLD_EXPIRED", "Your reservation expired. Check availability to continue.");
    const { details, errors } = validateDetails(req.body || {});
    if (Object.keys(errors).length) return fail(res, 400, "VALIDATION_ERROR", "Check the highlighted fields.", { errors });
    rec.details = details;
    putOrder(rec);
    res.json({ order: publicOrder(rec) });
  });

  r.post("/connect", on, async (req, res) => {
    const rec = basket(req, res);
    if (!rec) return;
    await refreshHold(rec);
    if (rec.state !== "held") return fail(res, 409, rec.state === "reserving" ? "HOLD_PENDING" : "HOLD_EXPIRED",
      rec.state === "reserving" ? "Your numbers are still being reserved. Try again in a moment." : "Your reservation expired. Check availability to continue.");
    const { connect, errors } = validateConnect(req.body || {}, live(rec).map((n) => n.did));
    if (Object.keys(errors).length) return fail(res, 400, "VALIDATION_ERROR", "Check the highlighted fields.", { errors });
    rec.connect = connect;
    putOrder(rec);
    res.json({ order: publicOrder(rec) });
  });

  r.post("/pay", on, payLimit, async (req, res) => {
    const rec = basket(req, res);
    if (!rec) return;
    const b = req.body || {};
    // A payment already started for this order: never send the card twice
    if (rec.payment?.outcome === "success") return res.json({ order: publicOrder(rec) });
    if (rec.payment?.outcome === "pending") return fail(res, 409, "PAYMENT_PENDING", "We're still processing your payment. Don't pay again — this page will update.", { reference: rec.payment.reference });
    if (rec.payment?.outcome === "unknown") return fail(res, 409, "PAYMENT_UNKNOWN", "We're checking your payment. Do not pay again. Contact us with this reference.", { reference: rec.payment.reference });

    await refreshHold(rec);
    if (rec.state !== "held") return fail(res, 409, "HOLD_EXPIRED", "Your reservation expired. Check availability to continue.");
    if (!rec.details) return fail(res, 409, "DETAILS_REQUIRED", "Add your details first.");
    if (!rec.connect) return fail(res, 409, "CONNECT_REQUIRED", "Choose where calls will go first.");
    if (!b.consents?.terms || !b.consents?.recurring) {
      return fail(res, 400, "VALIDATION_ERROR", "Accept the terms and the recurring billing authorization.", { errors: { consents: "Required to place the order." } });
    }
    const q = requote(rec);
    if (String(b.amount) !== q.dueToday || b.quoteVersion !== q.version) {
      putOrder(rec);
      return fail(res, 409, "PRICE_CHANGED", "The price changed. Review the new total before you pay.", { order: publicOrder(rec) });
    }
    const card = { number: String(b.card?.number || "").replace(/\D/g, ""), expMonth: String(b.card?.expMonth || ""),
      expYear: String(b.card?.expYear || ""), cvv: String(b.card?.cvv || ""), holder: String(b.card?.holder || "").trim() };
    const v = pay.validateCard(card);
    if (!v.ok) return fail(res, 400, "VALIDATION_ERROR", "Check your card details.", { errors: v.errors });

    try {
      // MIND account first: the card and the charge belong to it
      if (!rec.mind.accountId) {
        // strict: a failed lookup stops here rather than minting a second MIND account
        const found = await mind.findMindAccountByEmail(rec.details.email, { strict: true });
        rec.mind.accountId = found?.accountId ? String(found.accountId)
          : (await mind.createMindAccount(mindContact(rec.details), rec.details.email)).accountId;
        logEvent(rec, "mind-account", found ? "existing" : "created");
        putOrder(rec);
      }
      const saved = await pay.saveCard(rec.mind.accountId, card);

      rec.payment = { reference: `IRN-${rec.ref.slice(-6)}-${Date.now().toString(36).toUpperCase()}`, outcome: "pending",
        amount: q.dueToday, masked: saved.masked, startedAt: new Date().toISOString() };
      rec.state = "paying";
      putOrder(rec);
      const r2 = await pay.charge({ accountId: rec.mind.accountId, amount: q.dueToday, reference: rec.payment.reference,
        remark: `Online phone numbers ${rec.ref}`, card: { ...saved, cvv: card.cvv } });

      if (r2.outcome === "declined") {
        rec.payment = null; // a clean decline: retrying is allowed
        rec.state = "held";
        logEvent(rec, "payment-declined");
        putOrder(rec);
        return fail(res, 402, "DECLINED", "Payment was not approved. Try another card.");
      }
      if (r2.outcome !== "success") {
        rec.payment.outcome = "unknown";
        rec.state = "payment_unknown";
        logEvent(rec, "payment-unknown", r2.detail);
        putOrder(rec);
        opsAlert(`Payment outcome unknown — order ${rec.ref}`, opsHtml(rec, "A payment returned no clear result. Check MIND/Moneris before anyone retries."), { ref: rec.ref });
        return fail(res, 409, "PAYMENT_UNKNOWN", "We're checking your payment. Do not pay again. Contact us with this reference.", { reference: rec.payment.reference });
      }
      rec.payment.outcome = "success";
      rec.payment.chargedAt = new Date().toISOString();
      const nb = new Date(); nb.setMonth(nb.getMonth() + 1);
      rec.nextBill = nb.toISOString().slice(0, 10);
      rec.state = "completing";
      logEvent(rec, "paid", rec.payment.reference);
      putOrder(rec);
      fulfil(rec.ref).catch((e) => console.error("[did] fulfil", rec.ref, e.message));
      res.status(202).json({ order: publicOrder(rec) });
    } catch (e) {
      console.error("[did] pay", rec.ref, e.message);
      if (rec.payment?.outcome === "pending") return fail(res, 409, "PAYMENT_PENDING", "We're still processing your payment. Don't pay again.", { reference: rec.payment.reference });
      return fail(res, e.status === 400 ? 400 : 503, e.status === 400 ? "VALIDATION_ERROR" : "PAYMENT_UNAVAILABLE",
        e.status === 400 ? "Check your card details." : "Payment is temporarily unavailable. You have not been charged.");
    }
  });

  r.get("/order", async (req, res) => {
    const rec = basket(req, res);
    if (!rec) return;
    if (["reserving", "held"].includes(rec.state)) await refreshHold(rec);
    res.json({ order: publicOrder(rec) });
  });

  return r;
}

// For tests
export const _internal = { refreshHold, fulfil, sweep, requote };
