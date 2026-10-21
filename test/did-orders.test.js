// Tests for lib/did-prices.js and lib/did-orders.js — no network.
// Run: node test/did-orders.test.js
import assert from "assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { quote, loadPrices, DEFAULT_PRICES, priceFor } from "../lib/did-prices.js";
import {
  makeToken, verifyToken, newRef, keypadDigits, searchPlan, inventoryFilters, matchesPattern, validateDetails,
  validateConnect, isPublicIPv4, isFqdn, ten, isNanp10, displayNumber, catalog, findRateCentre, locationFor,
  openStore, putOrder, getOrder, publicOrder, pruneStore,
} from "../lib/did-orders.js";

let passed = 0;
const failed = [];
function test(name, fn) {
  try { fn(); passed++; console.log("ok  ", name); }
  catch (e) { failed.push(name); console.log("FAIL", name, "\n     ", e.message.split("\n").join("\n      ")); }
}
const invFilter = (name, value, eq = "=") => ({ category_name: name, category_operator: "and", category_eq: eq, category_value: String(value) });

test("quote: BRD worked example — $35 setup + $4 rental → $39.00, tax $5.07, due $44.07", () => {
  const prices = { ...DEFAULT_PRICES, categories: { basic: { setup: 5, monthly: 2 }, pristine: { setup: 30, monthly: 2 } } };
  const q = quote([{ did: "4165550100", category: "basic" }, { did: "4165550101", category: "pristine" }], prices);
  assert.equal(q.setup, "35.00");
  assert.equal(q.firstMonth, "4.00");
  assert.equal(q.subtotal, "39.00");
  assert.equal(q.tax, "5.07");
  assert.equal(q.dueToday, "44.07");
  assert.equal(q.monthly, "4.00");
  assert.equal(q.monthlyTax, "0.52");
});

test("quote: defaults are Basic $0 + $2/mo, unknown category priced as Basic, version carried", () => {
  const q = quote([{ did: "4165550100", category: "basic" }, { did: "4165550102", category: "weird" }]);
  assert.equal(q.dueToday, "4.52");
  assert.equal(q.lines[1].category, "basic");
  assert.equal(q.version, DEFAULT_PRICES.version);
  assert.equal(q.approved, false);
  assert.deepEqual(priceFor("vanity"), { setup: "49.00", monthly: "4.00" });
});

test("loadPrices: DID_PRICES_JSON overrides; invalid JSON falls back to defaults", () => {
  const p = loadPrices({ DID_PRICES_JSON: JSON.stringify({ version: "v2", approved: true, categories: { basic: { setup: 1, monthly: 3 } } }) });
  assert.equal(p.version, "v2");
  assert.equal(p.taxRate, 0.13);
  assert.equal(loadPrices({ DID_PRICES_JSON: "{nope" }), DEFAULT_PRICES);
});

test("tokens: round trip, forged and foreign tokens refused, missing secret refused", () => {
  const ref = newRef(new Date("2026-10-21T12:00:00Z"));
  assert.match(ref, /^IR261021-[A-Z2-9]{6}$/);
  const t = makeToken(ref, "s3cret");
  assert.equal(verifyToken(t, "s3cret"), ref);
  assert.equal(verifyToken(t, "other"), null);
  assert.equal(verifyToken(t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"), "s3cret"), null);
  assert.equal(verifyToken(`IR261021-ZZZZZZ.${t.split(".")[1]}`, "s3cret"), null);
  assert.equal(verifyToken("garbage", "s3cret"), null);
  assert.equal(verifyToken(t, ""), null);
  assert.throws(() => makeToken(ref, ""));
});

test("numbers: ten(), NANP check, display", () => {
  assert.equal(ten("+1 (416) 555-0100"), "4165550100");
  assert.equal(ten("14165550100"), "4165550100");
  assert.ok(isNanp10("4165550100"));
  assert.ok(!isNanp10("1165550100"));
  assert.ok(!isNanp10("4161550100"));
  assert.equal(displayNumber("4165550100"), "416 555 0100");
});

test("keypad: FLOWERS → 3569377, digits pass through", () => {
  assert.equal(keypadDigits("FLOWERS"), "3569377");
  assert.equal(keypadDigits("Pizza2"), "749922");
});

test("catalog: provinces with names, rate centres, lookups", () => {
  const c = catalog();
  assert.ok(c.provinces.some((p) => p.code === "ON" && p.name === "Ontario"));
  assert.ok(c.rateCentres.length > 300);
  const t = findRateCentre("toronto", "ON");
  assert.ok(t && t.npas.includes("416"));
  assert.equal(locationFor("4165550100", t), `${t.name}, ON`);
  assert.equal(locationFor("4165550100", null), "Area code 416, ON");
});

test("search plan: validation errors", () => {
  const p = searchPlan({ province: "XX", areaCode: "12", digits: "12345678901", ratecenter: "NOWHERE" });
  assert.ok(p.errors.province && p.errors.areaCode && p.errors.digits && p.errors.ratecenter);
  assert.ok(searchPlan({ word: "FLÖWERS" }).errors.word);
});

test("search filters: base filters, rate centre wins over province, prefix and LIKE patterns", () => {
  let f = inventoryFilters(searchPlan({ province: "ON" }), "154E", invFilter);
  assert.deepEqual(f.map((x) => [x.category_name, x.category_value]), [["status", "available"], ["provider_code", "154E"], ["province", "ON"]]);
  f = inventoryFilters(searchPlan({ province: "ON", ratecenter: "TORONTO", areaCode: "416", digits: "2255", match: "contains" }), "154E", invFilter);
  assert.deepEqual(f.slice(2).map((x) => [x.category_name, x.category_eq, x.category_value]),
    [["ratecenter", "=", "TORONTO"], ["prefix", "=", "1416"], ["did", "like", "%2255%"]]);
  const starts = inventoryFilters(searchPlan({ areaCode: "416", digits: "555", match: "starts" }), "154E", invFilter).pop();
  assert.equal(starts.category_value, "1416555%");
  const ends = inventoryFilters(searchPlan({ province: "ON", word: "PIZZA", match: "ends" }), "154E", invFilter).pop();
  assert.equal(ends.category_value, "%74992");
  const exact = inventoryFilters(searchPlan({ province: "ON", digits: "4165550100", match: "exact" }), "154E", invFilter).pop();
  assert.equal(exact.category_value, "14165550100");
});

test("matchesPattern re-checks every row", () => {
  const plan = (o) => searchPlan({ province: "ON", ...o });
  assert.ok(matchesPattern("4165552255", plan({ digits: "2255" })));
  assert.ok(!matchesPattern("4165550100", plan({ digits: "2255" })));
  assert.ok(matchesPattern("4165550100", plan({ digits: "555", match: "starts" })));
  assert.ok(matchesPattern("4165550100", plan({ digits: "0100", match: "ends" })));
  assert.ok(matchesPattern("4165550100", plan({ digits: "5550100", match: "exact" })));
  assert.ok(!matchesPattern("4165550100", plan({ digits: "550100", match: "exact" })));
});

test("details: business needs a company; residential drops it; postal code normalised", () => {
  const ok = validateDetails({ segment: "residential", firstName: "Ana", lastName: "Li", email: "ANA@Example.com", phone: "416-555-0100",
    company: "ignored", address1: "1 Main St", city: "Toronto", province: "on", postalCode: "m5v3l9" });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.details.company, "");
  assert.equal(ok.details.email, "ana@example.com");
  assert.equal(ok.details.postalCode, "M5V 3L9");
  const biz = validateDetails({ segment: "business", firstName: "A", lastName: "B", email: "a@b.co", phone: "4165550100",
    address1: "x", city: "y", province: "ON", postalCode: "M5V 3L9" });
  assert.ok(biz.errors.company);
  const bad = validateDetails({ email: "nope", phone: "123", postalCode: "12345", province: "ZZ" });
  assert.ok(bad.errors.email && bad.errors.phone && bad.errors.postalCode && bad.errors.province && bad.errors.firstName);
});

test("connect: public endpoints only, ports, forwarding loop refused", () => {
  assert.ok(isPublicIPv4("203.0.113.10"));
  for (const ip of ["10.0.0.1", "192.168.1.1", "172.20.0.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "300.1.1.1"]) assert.ok(!isPublicIPv4(ip), ip);
  assert.ok(isFqdn("sip.example.com"));
  assert.ok(!isFqdn("pbx.local") && !isFqdn("localhost"));
  let r = validateConnect({ type: "pbx", method: "static", host: "10.1.1.1", port: "70000", platform: "3CX" });
  assert.ok(r.errors.host && r.errors.port);
  r = validateConnect({ type: "pbx", method: "static", host: "sip.example.com", port: "5061", transport: "TLS", platform: "3CX" });
  assert.deepEqual(r.errors, {});
  assert.equal(r.connect.transport, "tls");
  r = validateConnect({ type: "forward", forwardTo: "4165550100" }, ["4165550100"]);
  assert.ok(r.errors.forwardTo);
  assert.ok(validateConnect({}).errors.type);
});

test("store: persists, public view hides MIND ids and card token, prune keeps paid work", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "did-"));
  openStore(dir);
  putOrder({ ref: "IR261021-AAAAAA", createdAt: "2026-01-01T00:00:00Z", state: "active", numbers: [{ did: "4165550100", category: "basic", location: "Toronto, ON" }],
    mind: { accountId: "secret-acct" }, payment: { outcome: "success", reference: "R1", amount: "2.26", masked: "**** 4242", token: "tok_x" } });
  putOrder({ ref: "IR261021-BBBBBB", createdAt: "2026-01-01T00:00:00Z", state: "delayed", numbers: [] });
  openStore(dir); // reload from disk
  const pub = publicOrder(getOrder("IR261021-AAAAAA"));
  assert.equal(pub.numbers[0].display, "416 555 0100");
  assert.equal(JSON.stringify(pub).includes("secret-acct"), false);
  assert.equal(JSON.stringify(pub).includes("tok_x"), false);
  const store = JSON.parse(fs.readFileSync(path.join(dir, "did-orders.json"), "utf8"));
  store.orders["IR261021-AAAAAA"].updatedAt = "2026-01-01T00:00:00Z";
  fs.writeFileSync(path.join(dir, "did-orders.json"), JSON.stringify(store));
  openStore(dir);
  assert.equal(pruneStore(Date.parse("2026-10-21T00:00:00Z")), 1);
  assert.equal(getOrder("IR261021-AAAAAA"), null);
  assert.ok(getOrder("IR261021-BBBBBB"), "a delayed (paid) order is never pruned");
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
