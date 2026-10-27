// Tests for demo mode: lib/did-demo.js and the /did routes running a demo
// basket end to end. globalThis.fetch is stubbed to throw, so any call out of
// this process (Espresso, IristelX, MIND, CRM, mail) fails the test.
// Run: node test/did-demo.test.js
import assert from "assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import express from "express";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "did-demo-"));
Object.assign(process.env, { STATE_DIR: dir, ORDER_TOKEN_SECRET: "test-secret", DID_DEMO: "true" });
for (const k of ["DID_ORDERING_ENABLED", "MIND_API_KEY", "PAYMENT_API_KEY", "ESPRESSO_CLIENT_ID", "SNAG_WEBHOOK_URL", "DID_MAIL_FROM", "SNAG_MAIL_FROM"]) delete process.env[k];

const outside = [];
globalThis.fetch = async (url) => { outside.push(String(url)); throw new Error("network call in a demo test: " + url); };

const demo = await import("../lib/did-demo.js");
const { searchPlan, inventoryFilters, matchesPattern, isNanp10, ten, pruneStore, getOrder } = await import("../lib/did-orders.js");
const { createDidRouter, _internal } = await import("../lib/did-routes.js");

let passed = 0;
const failed = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok  ", name); }
  catch (e) { failed.push(name); console.log("FAIL", name, "\n     ", e.stack.split("\n").slice(0, 3).join("\n      ")); }
}
const search = (q) => demo.inventorySearch(inventoryFilters(searchPlan(q), "154E", demo.invFilter), { limit: 100, offset: 0 });

// ---------- emulator ----------
await test("search: every number is NANP, on the asked area code, and fits the pattern", async () => {
  for (const q of [
    { province: "ON", ratecenter: "TORONTO", areaCode: "416", digits: "2255", match: "contains" },
    { province: "ON", areaCode: "613", digits: "555", match: "starts" },
    { province: "BC", digits: "0100", match: "ends" },
    { province: "ON", word: "PIZZA", match: "ends" },
    { province: "QC", areaCode: "514", digits: "2345678", match: "exact" },
  ]) {
    const plan = searchPlan(q);
    const rows = await search(q);
    assert.ok(rows.length > 0, JSON.stringify(q));
    for (const r of rows) {
      const d = ten(r.number);
      assert.ok(isNanp10(d), r.number);
      if (plan.npa) assert.equal(d.slice(0, 3), plan.npa);
      assert.ok(matchesPattern(d, plan), `${d} vs ${JSON.stringify(q)}`);
    }
  }
});

await test("search: same filters give the same numbers; next page differs; rate centre keeps its area codes", async () => {
  const q = { province: "ON", ratecenter: "TORONTO" };
  const a = await search(q), b = await search(q);
  assert.deepEqual(a, b);
  const p1 = await demo.inventorySearch(inventoryFilters(searchPlan(q), "154E", demo.invFilter), { limit: 100, offset: 100 });
  assert.notDeepEqual(a.map((r) => r.number), p1.map((r) => r.number));
  const npas = new Set(a.map((r) => ten(r.number).slice(0, 3)));
  for (const n of npas) assert.ok(["416", "647", "437", "942"].includes(n), n);
});

await test("search: some vanity numbers, and the hold lookup agrees on vanity", async () => {
  const rows = await search({ province: "ON", areaCode: "416" });
  const v = rows.filter((r) => r.vanity);
  assert.ok(v.length >= 5 && v.length < rows.length, `${v.length} vanity of ${rows.length}`);
  for (const r of rows.slice(0, 20)) {
    const [again] = await demo.inventorySearch([demo.invFilter("did", r.number)], { limit: 5 });
    assert.equal(again.vanity, r.vanity);
    assert.ok(demo.inventoryRowFree(again, { allowVanity: true }));
  }
  assert.equal(demo.inventoryRowFree(v[0]), false, "vanity needs allowVanity");
});

await test("exact 10-digit search returns that number only; a US area code returns nothing", async () => {
  const rows = await search({ province: "ON", digits: "4165552255", match: "exact" });
  assert.deepEqual(rows.map((r) => r.number), ["14165552255"]);
  assert.deepEqual(await demo.inventorySearch([demo.invFilter("did", "12125550100")]), []);
});

await test("orders: reserving → ready after 3 s → completed; cancel; expiry after an hour", async () => {
  const t0 = Date.now();
  demo._setClock(() => t0);
  let o = await demo.createOrder({ dids: ["14165552255", "14165550100"] });
  assert.equal(demo.orderState(o).state, "reserving");
  demo._setClock(() => t0 + 3500);
  o = await demo.getOrder(o.id);
  assert.equal(demo.orderState(o).state, "ready");
  assert.equal(Date.parse(o.reservationExpiresAt), t0 + 3600000);
  o = await demo.completeOrder(o.id, ["14165552255"]);
  assert.equal(demo.orderState(o).state, "completed");
  assert.deepEqual(o.numbers, [{ did: "14165552255", status: "ASSIGNED" }]);
  const c = await demo.cancelOrder((await demo.createOrder({ dids: ["14165550101"] })).id);
  assert.equal(c.status, "CANCELLED");
  const x = await demo.createOrder({ dids: ["14165550102"] });
  demo._setClock(() => t0 + 3600000 + 4000);
  assert.equal((await demo.getOrder(x.id)).status, "EXPIRED");
  await assert.rejects(demo.completeOrder(x.id), (e) => e.espressoCode === "RESERVATION_EXPIRED");
  demo._reset();
});

// ---------- the routes, end to end ----------
const app = express();
app.use(express.json());
let crmCalls = 0;
app.use("/did", createDidRouter({ crmLead: async () => { crmCalls++; } }));
const server = app.listen(0);
const port = server.address().port;

function call(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: "127.0.0.1", port, method, path: "/did" + p, agent: false,
      headers: { Accept: "application/json", ...(data ? { "Content-Type": "application/json" } : {}), ...(token ? { "X-Order-Token": token } : {}) } },
    (res) => { let s = ""; res.on("data", (c) => { s += c; }); res.on("end", () => resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null })); });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const details = { segment: "residential", firstName: "Ana", lastName: "Li", email: "ana@example.com", phone: "416-555-0100",
  address1: "1 Main St", city: "Toronto", province: "ON", postalCode: "M5V 3L9" };
const card = (number) => ({ holder: "Ana Li", number, expMonth: "12", expYear: String(new Date().getFullYear() + 1), cvv: "123" });

await test("routes: the page scripts are served minified and still parse; the CSS as it is", async () => {
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: "/did" + p, agent: false }, (res) => {
      let s = ""; res.on("data", (c) => { s += c; }); res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: s }));
    }).on("error", reject);
  });
  for (const f of ["app.js", "i18n.js", "preview.js"]) {
    const src = fs.readFileSync(new URL(`../public/did/${f}`, import.meta.url), "utf8");
    const r = await get("/" + f);
    assert.equal(r.status, 200, f);
    assert.match(r.type, /application\/javascript/, f);
    assert.ok(r.body.length < src.length && r.body.split("\n").length === 1, `${f}: ${r.body.length} of ${src.length}`);
    assert.doesNotThrow(() => new Function(r.body), f);
  }
  const css = await get("/app.css");
  assert.equal(css.body, fs.readFileSync(new URL("../public/did/app.css", import.meta.url), "utf8"));
});

let token, order;
await test("routes: config says demo; a request without demo is still refused while the switch is off", async () => {
  const c = await call("GET", "/config");
  assert.equal(c.json.demo, true);
  assert.equal(c.json.enabled, false);
  const r = await call("POST", "/search", { province: "ON" });
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "DISABLED");
});

await test("routes: demo search → hold (reserving, then held) with a DEMO ref", async () => {
  const s = await call("POST", "/search", { province: "ON", ratecenter: "TORONTO", areaCode: "416", digits: "2255", demo: true });
  assert.equal(s.status, 200);
  assert.ok(s.json.results.length >= 2);
  assert.ok(s.json.results.every((n) => n.did.includes("2255") && n.location === "Toronto, ON"));
  const picks = s.json.results.slice(0, 2).map((n) => ({ did: n.did, rc: n.rc }));
  const h = await call("POST", "/hold", { numbers: picks, demo: true });
  assert.equal(h.status, 201, JSON.stringify(h.json));
  token = h.json.token;
  assert.match(h.json.order.ref, /^DEMO\d{6}-/);
  assert.equal(h.json.order.demo, true);
  let b = await call("GET", "/basket", null, token);
  assert.equal(b.json.order.state, "reserving");
  await sleep(demo.DEMO_READY_MS + 300);
  b = await call("GET", "/basket", null, token);
  assert.equal(b.json.order.state, "held");
  assert.ok(Date.parse(b.json.order.holdExpiresAt) > Date.now() + 55 * 60000);
  order = b.json.order;
});

await test("routes: remove, details and connect work on a demo basket while the switch is off", async () => {
  let r = await call("POST", "/basket/remove", { did: order.numbers[1].did }, token);
  assert.equal(r.status, 200);
  assert.equal(r.json.order.numbers.length, 1);
  r = await call("POST", "/details", details, token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await call("POST", "/connect", { type: "forward", forwardTo: "6135550199" }, token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  order = r.json.order;
});

await test("routes: demo pay — 0002 declines and keeps the hold; a real-looking card is refused", async () => {
  const base = { amount: order.quote.dueToday, quoteVersion: order.quote.version, consents: { terms: true, recurring: true } };
  let r = await call("POST", "/pay", { ...base, card: card(demo.TEST_CARDS.decline) }, token);
  assert.equal(r.status, 402);
  assert.equal(r.json.code, "DECLINED");
  assert.equal((await call("GET", "/basket", null, token)).json.order.state, "held");
  r = await call("POST", "/pay", { ...base, card: card("5555555555554444") }, token);
  assert.equal(r.status, 400);
  assert.match(r.json.errors.number, /test card 4242/);
});

await test("routes: demo pay with 4242 → active, no charge, no CRM lead, nothing sent out", async () => {
  const r = await call("POST", "/pay", { amount: order.quote.dueToday, quoteVersion: order.quote.version,
    consents: { terms: true, recurring: true }, card: card("4242 4242 4242 4242") }, token);
  assert.equal(r.status, 202, JSON.stringify(r.json));
  let o;
  for (let i = 0; i < 20; i++) { o = (await call("GET", "/order", null, token)).json.order; if (o.state === "active") break; await sleep(100); }
  assert.equal(o.state, "active");
  assert.equal(o.demo, true);
  assert.match(o.payment.reference, /^DEMO-/);
  assert.equal(o.payment.masked, "424242******4242");
  assert.ok(o.numbers.every((n) => n.status === "ACTIVE"));
  const rec = getOrder(o.ref);
  assert.deepEqual(rec.mind, {});
  assert.equal(rec.steps.crm, undefined);
  assert.equal(crmCalls, 0);
  assert.deepEqual(outside, []);
});

// ---------- changing a held basket (the "Your numbers" panel) ----------
const basicSearch = { province: "ON", ratecenter: "TORONTO", areaCode: "416", type: "basic", demo: true };
async function heldBasket(picks) {
  const h = await call("POST", "/hold", { numbers: picks, demo: true });
  assert.equal(h.status, 201, JSON.stringify(h.json));
  await sleep(demo.DEMO_READY_MS + 300);
  const b = await call("GET", "/basket", null, h.json.token);
  assert.equal(b.json.order.state, "held");
  return { token: h.json.token, order: b.json.order };
}
let t2, picks2, spare;
await test("routes: search lists the customer's own held numbers first; nobody else sees them", async () => {
  const s = await call("POST", "/search", basicSearch);
  picks2 = s.json.results.slice(0, 2).map((n) => ({ did: n.did, rc: n.rc }));
  spare = s.json.results.slice(2, 4).map((n) => ({ did: n.did, rc: n.rc }));
  ({ token: t2 } = await heldBasket(picks2));
  const mineFirst = await call("POST", "/search", basicSearch, t2);
  assert.deepEqual(mineFirst.json.results.slice(0, 2).map((n) => [n.did, n.held]), picks2.map((p) => [p.did, true]));
  assert.equal(new Set(mineFirst.json.results.map((n) => n.did)).size, mineFirst.json.results.length);
  const others = await call("POST", "/search", basicSearch);
  assert.ok(others.json.results.every((n) => !picks2.some((p) => p.did === n.did) && !n.held));
  // a search the held numbers don't fit doesn't list them
  const elsewhere = await call("POST", "/search", { province: "ON", areaCode: "613", demo: true }, t2);
  assert.ok(elsewhere.json.results.every((n) => !n.held));
});

await test("routes: changing the numbers keeps the basket, its details and connection; only new numbers are reserved", async () => {
  let r = await call("POST", "/details", details, t2);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await call("POST", "/connect", { type: "forward", forwardTo: "6135550199" }, t2);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const before = getOrder(r.json.order.ref);
  const h = await call("POST", "/hold", { numbers: [picks2[0], spare[0]], demo: true, token: t2 });
  assert.equal(h.status, 200, JSON.stringify(h.json));
  assert.equal(h.json.order.ref, before.ref);
  assert.deepEqual(h.json.order.numbers.map((n) => n.did).sort(), [picks2[0].did, spare[0].did].sort());
  assert.ok(h.json.order.details && h.json.order.connect, "details and connection kept");
  const rec = getOrder(before.ref);
  assert.equal(rec.espresso.length, 2, "one new Espresso order, for the new number only");
  assert.deepEqual(rec.espresso[1].dids, [spare[0].did]);
  assert.ok(["reserving", "ready"].includes(rec.espresso[0].state), "the first order still holds the kept number");
  await sleep(demo.DEMO_READY_MS + 300);
  assert.equal((await call("GET", "/basket", null, t2)).json.order.state, "held");
});

await test("routes: removing every number of one Espresso order releases it; completing assigns only kept numbers", async () => {
  const ref = getOrder((await call("GET", "/basket", null, t2)).json.order.ref).ref;
  let r = await call("POST", "/basket/remove", { did: spare[0].did }, t2);
  assert.equal(r.status, 200);
  const rec = getOrder(ref), [first, second] = rec.espresso;
  assert.equal(second.state, "cancelled");
  assert.equal((await demo.getOrder(second.id)).status, "CANCELLED");
  r = await call("GET", "/basket", null, t2);
  assert.equal(r.json.order.state, "held");
  const q = r.json.order.quote;
  r = await call("POST", "/pay", { amount: q.dueToday, quoteVersion: q.version, consents: { terms: true, recurring: true }, card: card("4242424242424242") }, t2);
  assert.equal(r.status, 202, JSON.stringify(r.json));
  let o;
  for (let i = 0; i < 20; i++) { o = (await call("GET", "/order", null, t2)).json.order; if (o.state === "active") break; await sleep(100); }
  assert.equal(o.state, "active");
  assert.deepEqual(o.numbers.map((n) => n.did), [picks2[0].did]);
  assert.deepEqual((await demo.getOrder(first.id)).numbers.map((n) => n.did), [`1${picks2[0].did}`], "removed numbers are not assigned");
  assert.equal((await demo.getOrder(second.id)).status, "CANCELLED", "the emptied order is never completed");
});

await test("routes: while a payment runs the basket can't change and a second payment is refused", async () => {
  const { token: t3, order: o3 } = await heldBasket([spare[1], picks2[1]]);
  _internal.payingNow.add(o3.ref);
  try {
    for (const [m, p, b] of [["POST", "/basket/remove", { did: spare[1].did }], ["POST", "/hold", { numbers: [spare[1]], demo: true }],
      ["POST", "/details", details], ["POST", "/connect", { type: "iristel" }],
      ["POST", "/pay", { amount: o3.quote.dueToday, quoteVersion: o3.quote.version, consents: { terms: true, recurring: true }, card: card("4242424242424242") }]]) {
      const r = await call(m, p, b, t3);
      assert.equal(r.status, 409, `${p}: ${JSON.stringify(r.json)}`);
      assert.equal(r.json.code, "PAYMENT_PENDING", p);
    }
  } finally { _internal.payingNow.delete(o3.ref); }
  assert.equal(getOrder(o3.ref).numbers.filter((n) => !n.removed).length, 2);
  assert.equal((await call("POST", "/basket/remove", { did: spare[1].did }, t3)).status, 200);
});

await test("store: demo orders are dropped a day after their last change", async () => {
  const ref = order.ref;
  assert.ok(getOrder(ref));
  pruneStore(Date.now() + 25 * 3600 * 1000);
  assert.equal(getOrder(ref), null);
});

server.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
