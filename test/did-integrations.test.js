// Tests for lib/espresso.js, lib/mind.js and lib/iristelx-pay.js — no
// dependencies, no network: globalThis.fetch is stubbed per test.
// Run: node test/did-integrations.test.js
import assert from "assert/strict";

// Fake, test-only settings — set before anything reads them (all three
// modules read env at call time).
const ENV = {
  ESPRESSO_REST_URL: "https://espresso.test/",
  ESPRESSO_CLIENT_ID: "test-client",
  ESPRESSO_CLIENT_SECRET: "test-client-secret",
  ESPRESSO_REST_USER: "test-user",
  ESPRESSO_REST_PASS: "test-pass",
  ESPRESSO_COMPANY_ID: "company-1",
  ESPRESSO_ROUTING_PROFILE_ID: "profile-1",
  IRISTELX_API_URL: "https://ix.test",
  MIND_API_KEY: "test-mind-key",
  UBOSS_API_KEY: "test-uboss-key",
  PAYMENT_API_KEY: "test-payment-key",
};
const UNSET = ["ESPRESSO_OCN", "ESPRESSO_DID_PROFILE", "ESPRESSO_ACQUISITION", "MIND_RESELL_KEY"];
function resetEnv() {
  Object.assign(process.env, ENV);
  UNSET.forEach(k => { delete process.env[k]; });
}
resetEnv();

const espresso = await import("../lib/espresso.js");
const mind = await import("../lib/mind.js");
const pay = await import("../lib/iristelx-pay.js");
const {
  espressoConfig, espressoRest, espressoAccount, invFilter, inventorySearch, inventoryRowFree, tenDigits, elevenDigits,
  createOrder, getOrder, completeOrder, cancelOrder, orderState, numbersByRequest,
} = espresso;
const {
  mindDigits, mindPickVerdict, cachedPickVerdict, findMindAccountByEmail, createMindAccount, createMindService,
  putServiceQuantity, resolveMindCity, ensureNumbersInMindInventory, attachNumbersToService, activateMind,
} = mind;
const { luhnOk, cardType, maskCard, validateCard, saveCard, charge } = pay;

// ---- fetch stub ----
let calls = [];
let handler = null;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const call = {
    url: String(url), path: u.pathname, query: u.searchParams, method: init.method || "GET",
    headers: init.headers || {}, body: init.body, redirect: init.redirect,
  };
  calls.push(call);
  if (!handler) throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  return handler(call);
};
const json = (status, obj, headers) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...(headers || {}) } });
const html = (status, body) => new Response(body, { status, headers: { "content-type": "text/html" } });
const bodyOf = (call) => (call.body ? JSON.parse(call.body) : undefined);
const apiCalls = () => calls.filter(c => !c.path.endsWith("/ws/v1/auth/token"));
const tokenCalls = () => calls.filter(c => c.path.endsWith("/ws/v1/auth/token"));

// espresso: logins answer with tok1, tok2 …; everything else goes to `routes`
function withLogin(routes) {
  let n = 0;
  return (call) => {
    if (call.path === "/ws/v1/auth/token") {
      n++;
      return json(200, { access_token: `tok${n}`, refresh_token: `refresh${n}`, expires_in: 3600 });
    }
    return routes(call);
  };
}

// ---- runner ----
let passed = 0;
const failed = [];
let logs = [];
async function test(name, fn) {
  resetEnv();
  espresso._resetForTests();
  mind._resetForTests();
  calls = [];
  handler = null;
  logs = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...a) => logs.push(a.map(String).join(" "));
  console.log = console.warn = console.error = capture;
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  Object.assign(console, saved);
  if (!err) { passed++; console.log("ok  ", name); }
  else { failed.push(name); console.log("FAIL", name, "\n     ", String(err.stack || err).split("\n").slice(0, 4).join("\n      ")); }
}

async function rejects(promise, check) {
  let threw = null;
  try { await promise; } catch (e) { threw = e; }
  assert.ok(threw, "expected a rejection");
  if (check) check(threw);
  return threw;
}

// ======================= espresso =======================

await test("tenDigits / elevenDigits convert only at the edges", () => {
  assert.equal(tenDigits("14165550100"), "4165550100");
  assert.equal(tenDigits("+1 (416) 555-0100"), "4165550100");
  assert.equal(tenDigits("4165550100"), "4165550100");
  assert.equal(tenDigits("24165550100"), "24165550100");   // 11 digits not starting with 1: untouched
  assert.equal(tenDigits(null), "");
  assert.equal(elevenDigits("4165550100"), "14165550100");
  assert.equal(elevenDigits("1-416-555-0100"), "14165550100");
  assert.equal(elevenDigits("14165550100"), "14165550100");
  assert.equal(elevenDigits(undefined), "");
  assert.equal(mindDigits("416 555 0100"), "14165550100");
});

await test("espressoConfig reads env at call time, defaults, no secrets", () => {
  const c = espressoConfig();
  assert.deepEqual(c, { url: "https://espresso.test", ocn: "154E", profileLabel: "", acquisition: "BUY", configured: true });
  process.env.ESPRESSO_ACQUISITION = "lease";
  process.env.ESPRESSO_OCN = "999X";
  delete process.env.ESPRESSO_REST_URL;
  const d = espressoConfig();
  assert.equal(d.acquisition, "LEASE");
  assert.equal(d.ocn, "999X");
  assert.equal(d.url, "https://api-sandbox.espressodid.com");
  delete process.env.ESPRESSO_CLIENT_SECRET;
  assert.equal(espressoConfig().configured, false);
  assert.ok(!JSON.stringify(c).includes("test-pass") && !JSON.stringify(c).includes("test-client-secret"));
});

await test("espressoRest refuses to run unconfigured (no fetch)", async () => {
  delete process.env.ESPRESSO_REST_PASS;
  await rejects(espressoRest("GET", "/ws/v1/x"), e => assert.equal(e.apiCode, "ESPRESSO_NOT_CONFIGURED"));
  assert.equal(calls.length, 0);
});

await test("invFilter shape", () => {
  assert.deepEqual(invFilter("prefix", 1416), { category_name: "prefix", category_operator: "and", category_eq: "=", category_value: "1416" });
  assert.equal(invFilter("status", "available", "!=").category_eq, "!=");
});

await test("inventoryRowFree: status, account, vanity, OCN", () => {
  const row = { number: "14165550100", status: "Available", account: null, vanity: false, ocn: "154e" };
  assert.equal(inventoryRowFree(row), true);
  assert.equal(inventoryRowFree({ ...row, ocn: undefined }), true);        // no OCN on the row: fine
  assert.equal(inventoryRowFree({ ...row, status: "reserved" }), false);
  assert.equal(inventoryRowFree({ ...row, account: "ACME" }), false);
  assert.equal(inventoryRowFree({ ...row, vanity: true }), false);
  assert.equal(inventoryRowFree({ ...row, vanity: true }, { allowVanity: true }), true);
  assert.equal(inventoryRowFree({ ...row, ocn: "7777" }), false);
  assert.equal(inventoryRowFree(null), false);
  // usable directly as an Array#filter callback
  assert.deepEqual([row, { ...row, status: "x" }].filter(inventoryRowFree), [row]);
  process.env.ESPRESSO_OCN = "7777";
  assert.equal(inventoryRowFree({ ...row, ocn: "7777" }), true);
  assert.equal(inventoryRowFree(row), false);
});

await test("inventorySearch sends limit/offset/order and parses array, page or single", async () => {
  let reply = [{ number: "1" }];
  handler = withLogin(() => json(200, reply));
  assert.deepEqual(await inventorySearch([invFilter("status", "available")], { limit: 1 }), [{ number: "1" }]);
  const sent = bodyOf(apiCalls()[0]);
  assert.deepEqual(sent, { limit: 1, offset: 0, order_by: ["number asc"], filter: [invFilter("status", "available")] });
  reply = { data: [{ number: "2" }] };
  assert.deepEqual(await inventorySearch([]), [{ number: "2" }]);
  reply = { number: "3" };
  assert.deepEqual(await inventorySearch([]), [{ number: "3" }]);
  reply = {};
  assert.deepEqual(await inventorySearch([]), []);
});

await test("token: concurrent calls share one login (password grant)", async () => {
  handler = withLogin(() => json(200, { ok: true }));
  await Promise.all([espressoRest("GET", "/ws/v1/a"), espressoRest("GET", "/ws/v1/b"), espressoRest("GET", "/ws/v1/c")]);
  assert.equal(tokenCalls().length, 1);
  const form = new URLSearchParams(tokenCalls()[0].body);
  assert.equal(form.get("grant_type"), "password");
  assert.equal(form.get("username"), "test-user");
  assert.equal(form.get("client_id"), "test-client");
  assert.equal(tokenCalls()[0].headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(apiCalls().length, 3);
  apiCalls().forEach(c => assert.equal(c.headers.Authorization, "Bearer tok1"));
  await espressoRest("GET", "/ws/v1/d");
  assert.equal(tokenCalls().length, 1, "cached token reused");
});

await test("token: a 401 gets one fresh login and a retry", async () => {
  let first = true;
  handler = withLogin(() => {
    if (first) { first = false; return json(401, { errors: [{ code: "UNAUTHENTICATED" }] }); }
    return json(200, { ok: 1 });
  });
  assert.deepEqual(await espressoRest("POST", "/ws/v1/x", { a: 1 }), { ok: 1 });
  assert.equal(tokenCalls().length, 2);
  assert.equal(apiCalls().length, 2);
  assert.equal(apiCalls()[1].headers.Authorization, "Bearer tok2");
  assert.equal(apiCalls()[1].body, JSON.stringify({ a: 1 }));
});

await test("token: a second 401 is not retried again", async () => {
  handler = withLogin(() => json(401, { errors: [{ code: "UNAUTHENTICATED", message: "nope" }] }));
  await rejects(espressoRest("GET", "/ws/v1/x"), e => {
    assert.equal(e.espressoStatus, 401);
    assert.equal(e.espressoCode, "UNAUTHENTICATED");
  });
  assert.equal(tokenCalls().length, 2);
  assert.equal(apiCalls().length, 2);
});

await test("token: login failure → ESPRESSO_AUTH", async () => {
  handler = () => json(400, { error: "invalid_grant", error_description: "bad credentials" });
  await rejects(espressoRest("GET", "/ws/v1/x"), e => {
    assert.equal(e.apiCode, "ESPRESSO_AUTH");
    assert.match(e.message, /bad credentials/);
  });
});

await test("redirect: same host is followed with the same request; another host is not", async () => {
  handler = withLogin((c) => {
    if (c.path === "/ws/v1/dids/orders") return new Response(null, { status: 301, headers: { location: "/ws/v1/dids/orders/" } });
    if (c.path === "/ws/v1/dids/orders/") return json(202, { id: "o1" });
    if (c.path === "/ws/v1/elsewhere") return new Response(null, { status: 302, headers: { location: "https://evil.test/x" } });
    return json(404, {});
  });
  assert.deepEqual(await espressoRest("POST", "/ws/v1/dids/orders", { z: 1 }), { id: "o1" });
  const [a, b] = apiCalls();
  assert.equal(a.redirect, "manual");
  assert.equal(b.method, "POST");
  assert.equal(b.body, JSON.stringify({ z: 1 }));
  calls = [];
  await rejects(espressoRest("GET", "/ws/v1/elsewhere"), e => assert.equal(e.espressoStatus, 302));
  assert.ok(!calls.some(c => c.url.includes("evil.test")));
});

await test("errors keep espresso's status/code; no answer → transport; non-JSON 2xx → BAD_RESPONSE", async () => {
  handler = withLogin((c) => {
    if (c.path === "/ws/v1/conflict") return json(409, { errors: [{ type: "logical-error", code: "ADMISSION_LIMIT", message: "too many" }] });
    if (c.path === "/ws/v1/down") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    if (c.path === "/ws/v1/html") return html(200, "<html>");
    return json(500, {});
  });
  await rejects(espressoRest("GET", "/ws/v1/conflict"), e => {
    assert.equal(e.espressoStatus, 409);
    assert.equal(e.espressoCode, "ADMISSION_LIMIT");
    assert.equal(e.errors.length, 1);
    assert.match(e.message, /ADMISSION_LIMIT too many/);
  });
  await rejects(espressoRest("GET", "/ws/v1/down"), e => {
    assert.equal(e.transport, true);
    assert.match(e.message, /ECONNRESET/);
  });
  await rejects(espressoRest("GET", "/ws/v1/html"), e => assert.equal(e.apiCode, "ESPRESSO_BAD_RESPONSE"));
  await rejects(espressoRest("GET", "/ws/v1/other"), e => assert.equal(e.status, 503));
});

await test("espressoAccount: single active company + routing profile pinned by label, cached", async () => {
  delete process.env.ESPRESSO_COMPANY_ID;
  delete process.env.ESPRESSO_ROUTING_PROFILE_ID;
  process.env.ESPRESSO_DID_PROFILE = "Iris DIDs";
  handler = withLogin((c) => {
    if (c.path === "/ws/v1/general/companies") return json(200, { data: [{ id: "c-old", active: false }, { id: "c1" }] });
    if (c.path === "/ws/v1/network/routing_profiles") {
      assert.equal(c.query.get("company_id"), "c1");
      return json(200, { data: [
        { id: "p0", type: "did", label: "iris dids", active: false },
        { id: "p1", type: "tf", label: "Iris DIDs" },
        { id: "p2", type: "did", label: " IRIS DIDs " },
        { id: "p3", type: "did", label: "Other" },
      ] });
    }
    return json(404, {});
  });
  assert.deepEqual(await espressoAccount(), { companyId: "c1", routingProfileId: "p2", profileLabel: " IRIS DIDs " });
  const n = apiCalls().length;
  await espressoAccount();
  assert.equal(apiCalls().length, n, "cached");
  await espressoAccount(true);
  assert.equal(apiCalls().length, n * 2, "fresh re-reads");
});

await test("espressoAccount: unknown label or several companies → ESPRESSO_NOT_READY", async () => {
  delete process.env.ESPRESSO_ROUTING_PROFILE_ID;
  process.env.ESPRESSO_DID_PROFILE = "Missing";
  handler = withLogin(() => json(200, [{ id: "p3", type: "did", label: "Other" }]));
  await rejects(espressoAccount(), e => { assert.equal(e.apiCode, "ESPRESSO_NOT_READY"); assert.match(e.message, /Other/); });
  espresso._resetForTests();
  delete process.env.ESPRESSO_COMPANY_ID;
  handler = withLogin(() => json(200, [{ id: "a" }, { id: "b" }]));
  await rejects(espressoAccount(), e => assert.equal(e.apiCode, "ESPRESSO_NOT_READY"));
});

await test("createOrder: body shape (selectDids, 11-digit did filter, acquisition from env)", async () => {
  process.env.ESPRESSO_ACQUISITION = "LEASE";
  handler = withLogin((c) => {
    if (c.path === "/ws/v1/dids/orders") return new Response(null, { status: 301, headers: { location: "https://espresso.test/ws/v1/dids/orders/" } });
    if (c.path === "/ws/v1/dids/orders/") return json(202, { id: "ord-uuid", orderNumber: "ORD-261021-ABCDEF012345", status: "PENDING", ...bodyOf(c) });
    return json(404, {});
  });
  const order = await createOrder({ dids: ["4165550100", "1 416 555 0101"], reference: "iris:abc" });
  assert.equal(order.id, "ord-uuid");
  const sent = bodyOf(apiCalls().at(-1));
  assert.deepEqual(sent, {
    accountId: "company-1", countryId: "1", ocn: "154E", vanity: false, selectDids: true,
    acquisitionType: "LEASE", routingProfileId: "profile-1", reference: "iris:abc",
    numberRequests: [{ quantity: 2, filters: [{ categoryName: "did", categoryValue: ["14165550100", "14165550101"] }] }],
  });
  calls = [];
  await createOrder({ dids: ["4165550100"], selectDids: false, vanity: true });
  const s2 = bodyOf(apiCalls().at(-1));
  assert.equal(s2.selectDids, false);
  assert.equal(s2.vanity, true);
  assert.match(s2.reference, /^iris:[0-9a-f]{12}$/, "a reference is always sent");
});

await test("createOrder: bad input throws before any call", async () => {
  await rejects(createOrder({ dids: [] }), e => assert.equal(e.apiCode, "INVALID_REQUEST"));
  await rejects(createOrder({ dids: ["555"] }), e => assert.equal(e.status, 400));
  await rejects(createOrder({ dids: ["4165550100", "14165550100"] }), e => assert.equal(e.apiCode, "DUPLICATE_PICK"));
  assert.equal(calls.length, 0);
});

await test("createOrder: refused outright → ESPRESSO_REJECTED, no lookup", async () => {
  handler = withLogin(() => json(400, { errors: [{ type: "validation-error", code: "INVALID_ROUTING_PROFILE", message: "bad" }] }));
  await rejects(createOrder({ dids: ["4165550100"], reference: "r1" }), e => {
    assert.equal(e.apiCode, "ESPRESSO_REJECTED");
    assert.equal(e.ambiguous, false);
    assert.equal(e.espressoCode, "INVALID_ROUTING_PROFILE");
    assert.equal(e.reference, "r1");
  });
  assert.equal(apiCalls().length, 1);
});

await test("createOrder: lost answer → found by reference, not created twice", async () => {
  handler = withLogin((c) => {
    if (c.method === "POST") return json(500, { errors: [{ code: "INTERNAL_ERROR" }] });
    if (c.path === "/ws/v1/dids/orders") {
      assert.equal(c.query.get("accountId"), "company-1");
      return json(200, { data: [{ id: "x", reference: "other" }, { id: "found-id", reference: "r2", status: "PENDING" }] });
    }
    if (c.path === "/ws/v1/dids/orders/found-id") return json(200, { id: "found-id", reference: "r2", status: "PENDING", numbers: [] });
    return json(404, {});
  });
  const order = await createOrder({ dids: ["4165550100"], reference: "r2" });
  assert.equal(order.id, "found-id");
  assert.deepEqual(order.numbers, []);
  assert.equal(apiCalls().filter(c => c.method === "POST").length, 1);
});

await test("createOrder: lost answer and not found → ESPRESSO_BUSY, ambiguous, keeps reference", async () => {
  handler = withLogin((c) => {
    if (c.method === "POST") throw new TypeError("fetch failed");
    return json(200, { data: [] });
  });
  await rejects(createOrder({ dids: ["4165550100"], reference: "r3" }), e => {
    assert.equal(e.apiCode, "ESPRESSO_BUSY");
    assert.equal(e.ambiguous, true);
    assert.equal(e.reference, "r3");
    assert.match(e.message, /r3/);
  });
  // ACCOUNT_MAPPING_UNAVAILABLE is refused before anything is stored: not ambiguous
  calls = [];
  handler = withLogin(() => json(503, { errors: [{ code: "ACCOUNT_MAPPING_UNAVAILABLE" }] }));
  await rejects(createOrder({ dids: ["4165550100"], reference: "r4" }), e => {
    assert.equal(e.ambiguous, false);
    assert.equal(e.apiCode, "ESPRESSO_BUSY");
  });
  assert.equal(apiCalls().length, 1, "no lookup");
});

await test("getOrder / completeOrder / cancelOrder paths and bodies", async () => {
  handler = withLogin((c) => {
    if (c.path === "/ws/v1/dids/orders" && c.method === "GET") return json(200, { data: [{ id: "u-1", orderNumber: "ORD-261021-ABCDEF012345" }] });
    return json(c.method === "GET" ? 200 : 202, { id: "u-1", path: c.path, body: bodyOf(c) });
  });
  assert.equal((await getOrder("u-1")).path, "/ws/v1/dids/orders/u-1");
  assert.equal((await getOrder("ORD-261021-ABCDEF012345")).path, "/ws/v1/dids/orders/u-1");
  const done = await completeOrder("u-1", ["4165550100", "14165550100", "4165550101"]);
  assert.equal(done.path, "/ws/v1/dids/orders/u-1/complete");
  assert.deepEqual(done.body, { numbers: ["14165550100", "14165550101"] });
  assert.deepEqual((await completeOrder("u-1")).body, {});
  const cancelled = await cancelOrder("u-1", "customer left");
  assert.equal(cancelled.path, "/ws/v1/dids/orders/u-1/cancel");
  assert.deepEqual(cancelled.body, { reason: "customer left" });
  assert.deepEqual((await cancelOrder("u-1")).body, {});
  await rejects(completeOrder(""), e => assert.equal(e.status, 400));
});

await test("orderState: every status, canComplete, reason, needsReview", () => {
  const nums = [
    { did: "14165550100", numberRequestId: "nr1", status: "RESERVED" },
    { did: "14165550101", numberRequestId: "nr1", status: "NOT_SELECTED" },
  ];
  const s = (status, extra) => orderState({ id: "u", orderNumber: "ORD-1", status, canComplete: false, numbers: [], ...extra });
  assert.equal(s("PENDING").state, "reserving");
  const ready = s("PENDING", { canComplete: true, numbers: nums, reservationExpiresAt: "2026-10-21T15:00:00Z" });
  assert.equal(ready.state, "ready");
  assert.equal(ready.canComplete, true);
  assert.deepEqual(ready.reserved, ["4165550100"]);
  assert.equal(ready.reservationExpiresAt, "2026-10-21T15:00:00Z");
  assert.equal(s("PROCESSING").state, "processing");
  const done = s("COMPLETED", { numbers: [{ did: "14165550100", status: "ASSIGNED" }] });
  assert.equal(done.state, "completed");
  assert.deepEqual(done.assigned, ["4165550100"]);
  assert.equal(done.needsReview, false);
  const rej = s("REJECTED", { rejectionReason: { code: "INSUFFICIENT_INVENTORY", message: "Unable to fully reserve" } });
  assert.equal(rej.state, "rejected");
  assert.deepEqual(rej.reason, { code: "INSUFFICIENT_INVENTORY", message: "Unable to fully reserve" });
  assert.equal(rej.needsReview, false);
  assert.equal(s("REJECTED", { numbers: [{ did: "14165550100", status: "ASSIGNED" }] }).needsReview, true);
  const failedOrder = s("FAILED", { failureReason: { code: "ROUTING_FAILED" } });
  assert.equal(failedOrder.state, "failed");
  assert.deepEqual(failedOrder.reason, { code: "ROUTING_FAILED", message: "ROUTING_FAILED" });
  assert.equal(failedOrder.needsReview, true);
  assert.equal(s("EXPIRED").state, "expired");
  assert.equal(s("EXPIRED").needsReview, true);
  assert.equal(s("CANCELLED").state, "cancelled");
  assert.equal(s("CANCELLED").needsReview, false);
  assert.equal(s("cancelled").state, "cancelled", "case-insensitive");
  assert.equal(s("SOMETHING_NEW").state, "processing");
  assert.equal(orderState(null).state, "processing");
  assert.equal(s("PENDING").reason, null);
});

await test("numbersByRequest groups by request index", () => {
  const order = {
    numberRequests: [{ id: "a", index: 0 }, { id: "b", index: 1 }],
    numbers: [
      { did: "14165550100", numberRequestId: "a", status: "ASSIGNED" },
      { did: "16135550100", numberRequestId: "b", status: "ASSIGNED" },
      { did: "16135550101", numberRequestId: "b", status: "RELEASED" },
    ],
  };
  assert.deepEqual(numbersByRequest(order, ["ASSIGNED"]), [{ index: 0, dids: ["4165550100"] }, { index: 1, dids: ["6135550100"] }]);
  assert.equal(numbersByRequest(order).length, 2);
});

// ======================= payments =======================

const CARD = { token: "tok-abc", cardType: "visa", masked: "424242******4242", expMonth: "03", expYear: "2031", holder: "Pat Doe", cvv: "123" };

await test("charge: 2xx JSON → success; body has adapterId 3, issuer SBI, externalRefId, amount '12.34'", async () => {
  handler = () => json(200, { transactionId: "T1" });
  const r = await charge({ accountId: "1204506", amount: 12.335, reference: "IRS-DID-1", card: CARD });
  assert.deepEqual(r, { outcome: "success", reference: "IRS-DID-1", amount: "12.34", gateway: { transactionId: "T1" } });
  const [c] = calls;
  assert.equal(c.url, "https://ix.test/bot/1204506/payment");
  assert.equal(c.method, "POST");
  assert.equal(c.headers["x-api-key"], "test-payment-key");
  assert.equal(c.redirect, "manual");
  assert.deepEqual(bodyOf(c), {
    amount: "12.34", currency: "CAD", remark: "Online phone numbers",
    creditCard: {
      code: "VISA", number: "424242******4242", token: "tok-abc", expDate: { expMonth: "03", expYear: "2031" },
      holder: "Pat Doe", securityCode: "123", adapterId: 3, issuer: "SBI", externalRefId: "IRS-DID-1",
    },
  });
  calls = [];
  await charge({ accountId: "1", amount: "5", reference: "R", remark: "Custom", card: { ...CARD, cvv: undefined } });
  const b = bodyOf(calls[0]);
  assert.equal(b.amount, "5.00");
  assert.equal(b.remark, "Custom");
  assert.ok(!("securityCode" in b.creditCard), "no CVV → no securityCode");
});

await test("charge: 4xx JSON → declined (generic message, gateway reason in detail)", async () => {
  for (const status of [402, 400, 422]) {
    handler = () => json(status, { message: "Purchase Transaction rejected", errors: [{ message: "Invalid Route Service" }] });
    const r = await charge({ accountId: "1", amount: 10, reference: "R-" + status, card: CARD });
    assert.equal(r.outcome, "declined");
    assert.equal(r.reference, "R-" + status);
    assert.match(r.message, /could not be completed/);
    assert.ok(!/Invalid Route/.test(r.message));
    assert.match(r.detail, /Invalid Route Service/);
  }
});

await test("charge: 503/502/504, 500 JSON, HTML, 3xx and network errors → unknown (never throws)", async () => {
  const replies = [
    () => json(503, { message: "unavailable" }),
    () => json(502, {}),
    () => json(504, {}),
    () => json(500, { message: "boom" }),
    () => html(200, "<html>ok</html>"),
    () => html(400, "<html>bad</html>"),
    () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
    () => { throw new TypeError("fetch failed"); },
    () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
  ];
  for (const [i, reply] of replies.entries()) {
    handler = reply;
    const r = await charge({ accountId: "1", amount: 1, reference: "U" + i, card: CARD });
    assert.equal(r.outcome, "unknown", `reply ${i}`);
    assert.equal(r.reference, "U" + i);
    assert.ok(r.detail);
  }
  assert.ok(!logs.some(l => l.includes("tok-abc") || /\b123\b/.test(l)), "no card data logged");
});

await test("charge: gateway echoing the CVV is scrubbed from detail", async () => {
  handler = () => json(400, { message: "securityCode 123 rejected" });
  const r = await charge({ accountId: "1", amount: 1, reference: "S", card: CARD });
  assert.ok(!/\b123\b/.test(r.detail), r.detail);
});

await test("charge: programmer/config errors throw before anything is sent", async () => {
  handler = () => json(200, {});
  await rejects(charge({ amount: 1, reference: "R", card: CARD }), e => assert.ok(e instanceof TypeError));
  await rejects(charge({ accountId: "1", amount: 0, reference: "R", card: CARD }));
  await rejects(charge({ accountId: "1", amount: "abc", reference: "R", card: CARD }));
  await rejects(charge({ accountId: "1", amount: 1, card: CARD }));
  await rejects(charge({ accountId: "1", amount: 1, reference: "R", card: { ...CARD, token: "" } }));
  delete process.env.PAYMENT_API_KEY;
  await rejects(charge({ accountId: "1", amount: 1, reference: "R", card: CARD }), e => assert.equal(e.code, "NOT_CONFIGURED"));
  assert.equal(calls.length, 0);
});

await test("luhnOk / cardType / maskCard", () => {
  assert.equal(luhnOk("4242424242424242"), true);
  assert.equal(luhnOk("4242 4242 4242 4242"), true);
  assert.equal(luhnOk("4242424242424241"), false);
  assert.equal(luhnOk("0000"), false);                  // too short
  assert.equal(cardType("4242424242424242"), "visa");
  assert.equal(cardType("5555555555554444"), "mastercard");
  assert.equal(cardType("2223000048400011"), "mastercard");
  assert.equal(cardType("378282246310005"), "amex");
  assert.equal(cardType("6011111111111117"), "discover");
  assert.equal(cardType("9999999999999995"), null);
  assert.equal(maskCard("4242 4242 4242 4242"), "424242******4242");
  assert.equal(maskCard("378282246310005"), "378282******0005");
});

await test("validateCard: holder, Luhn, expiry not in the past, 3–4 digit CVV", () => {
  const y = new Date().getUTCFullYear(), m = new Date().getUTCMonth() + 1;
  const good = { number: "4242 4242 4242 4242", expMonth: "3", expYear: String(y + 2).slice(2), cvv: "123", holder: "Pat" };
  assert.deepEqual(validateCard(good), { ok: true, errors: {} });
  assert.equal(validateCard({ ...good, expMonth: String(m), expYear: String(y) }).ok, true, "this month is still valid");
  assert.equal(validateCard({ ...good, cvv: "1234" }).ok, true);
  const bad = validateCard({ number: "4242424242424241", expMonth: "13", expYear: "20x5", cvv: "12", holder: " " });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ["cvv", "expMonth", "expYear", "holder", "number"]);
  assert.match(validateCard({ ...good, expYear: String(y - 1) }).errors.expYear, /expired/);
  if (m > 1) assert.match(validateCard({ ...good, expMonth: String(m - 1), expYear: String(y) }).errors.expMonth, /expired/);
  assert.ok(validateCard({ ...good, number: "9999999999999995" }).errors.number, "unknown brand rejected");
  assert.ok(!JSON.stringify(bad).includes("4242424242424241"));
});

const NEW_CARD = { number: "4242 4242 4242 4242", expMonth: "3", expYear: "2031", cvv: "987", holder: "Pat Doe" };

await test("saveCard: PATCH /billing/{acct}/credit-card with iristelx-api-key → token + safe fields", async () => {
  handler = () => json(200, { token: "tok-new" });
  const saved = await saveCard("1204506", NEW_CARD);
  assert.deepEqual(saved, { token: "tok-new", cardType: "VISA", masked: "424242******4242", expMonth: "03", expYear: "2031", holder: "Pat Doe" });
  const [c] = calls;
  assert.equal(c.url, "https://ix.test/billing/1204506/credit-card");
  assert.equal(c.method, "PATCH");
  assert.equal(c.headers["iristelx-api-key"], "test-mind-key");
  assert.ok(!("x-api-key" in c.headers));
  assert.deepEqual(bodyOf(c), { CVV: "987", cardType: "visa", expMonth: "03", expYear: "2031", holder: "Pat Doe", number: "4242424242424242" });
  handler = () => json(200, { data: { token: "nested" } });
  assert.equal((await saveCard("1", NEW_CARD)).token, "nested");
  assert.ok(!logs.some(l => l.includes("4242424242424242") || l.includes("987")));
});

await test("saveCard: falls back to MIND_RESELL_KEY when the main key can't see the account", async () => {
  process.env.MIND_RESELL_KEY = "test-resell-key";
  handler = (c) => c.headers["iristelx-api-key"] === "test-mind-key" ? json(404, { message: "not found" }) : json(200, { token: "t2" });
  assert.equal((await saveCard("1", NEW_CARD)).token, "t2");
  assert.deepEqual(calls.map(c => c.headers["iristelx-api-key"]), ["test-mind-key", "test-resell-key"]);
});

await test("saveCard: never puts the CVV or card number in a thrown error (decline, echo, network, invalid)", async () => {
  const leaks = (e) => {
    const all = [e.message, e.detail, JSON.stringify(e), String(e.stack)].join(" ");
    return all.includes("987") || all.includes("4242424242424242");
  };
  handler = () => json(400, { message: "Invalid card 4242424242424242 CVV 987", errors: [{ message: "CVV 987 mismatch" }] });
  const e1 = await rejects(saveCard("1", NEW_CARD));
  assert.equal(e1.status, 402);
  assert.equal(e1.code, "CARD_DECLINED");
  assert.ok(!leaks(e1), "decline leaks card data");
  handler = () => json(200, { message: "no token here 987" });
  const e2 = await rejects(saveCard("1", NEW_CARD));
  assert.ok(!leaks(e2), "missing token leaks card data");
  handler = () => { throw new TypeError("fetch failed for body CVV 987"); };
  const e3 = await rejects(saveCard("1", NEW_CARD));
  assert.equal(e3.status, 502);
  assert.ok(!leaks(e3), "network error leaks card data");
  calls = [];
  const e4 = await rejects(saveCard("1", { ...NEW_CARD, cvv: "98" }));
  assert.equal(e4.status, 400);
  assert.ok(e4.errors.cvv);
  assert.ok(!e4.message.includes("98"));
  assert.equal(calls.length, 0, "invalid card never sent");
  assert.ok(!logs.some(l => l.includes("4242424242424242") || /\b987\b/.test(l)), "no card data logged");
  delete process.env.MIND_API_KEY;
  await rejects(saveCard("1", NEW_CARD), e => assert.equal(e.status, 503));
});

// ======================= MIND =======================

// A small in-memory MIND: holders (service rows per number) and the
// reserved pool, enough for the availability and assignment flows.
function fakeMind({ holders = {}, pool = {}, cities, patchStatus = 200, phoneAccounts = {} } = {}) {
  const state = { holders, pool, patched: [] };
  state.handler = (c) => {
    const p = c.path;
    if (p.startsWith("/telephone-numbers/account-details/")) return json(200, state.holders[p.split("/").pop()] || []);
    if (p === "/telephone-numbers/reserved") {
      const d = c.query.get("fullNumber");
      return json(200, { telephoneNumbers: state.pool[d] ? [{ telephoneNumber: d, ...state.pool[d] }] : [] });
    }
    if (p === "/account-details-with-phone") {
      const d = c.query.get("telephoneNumber");
      const accounts = phoneAccounts[d] || [];
      return json(200, accounts.length ? { accounts } : { accounts: [], isExist: false });
    }
    if (p === "/telephone-numbers/cities") return json(200, { cities: cities || [] });
    if (p === "/telephone-numbers" && c.method === "POST") {
      const { start, cityId } = bodyOf(c).telephoneNumbers[0];
      if (state.pool[start]) {
        return json(200, { telephoneNumbers: [{ status: "NOT INSERTED IN MIND" }], errors: [{ code: 3100, message: "already exists" }] });
      }
      state.pool[start] = { serviceId: null, inUse: false, cityId };
      return json(200, { telephoneNumbers: [{ telephoneNumber: start, status: "INSERTED IN MIND" }],
        errors: [{ message: "NOT INSERTED IN THE DATABASE ER_DUP_ENTRY" }] });
    }
    const m = p.match(/^\/accounts\/([^/]+)\/services\/([^/]+)\/telephone-number$/);
    if (m && c.method === "PATCH") {
      const d = bodyOf(c).telephoneNumber;
      state.patched.push({ account: m[1], service: m[2], number: d });
      if (patchStatus !== 200) return json(patchStatus, { errors: [{ code: "10008", message: "no longer available" }] });
      state.pool[d] = { ...(state.pool[d] || {}), serviceId: m[2], inUse: true };
      return json(200, {});
    }
    return json(404, { message: "no route " + p });
  };
  return state;
}

await test("mindPickVerdict: all three lookups, right keys; any hit → not free", async () => {
  const m = fakeMind();
  handler = m.handler;
  assert.deepEqual(await mindPickVerdict("4165550100"), { free: true });
  const byPath = Object.fromEntries(calls.map(c => [c.path, c]));
  assert.equal(byPath["/telephone-numbers/account-details/14165550100"].headers["iristelx-api-key"], "test-mind-key");
  assert.equal(byPath["/telephone-numbers/reserved"].query.get("fullNumber"), "14165550100");
  assert.equal(byPath["/account-details-with-phone"].headers["x-api-key"], "test-uboss-key");
  m.holders["14165550100"] = [{ code: "svc-9" }];
  assert.deepEqual(await mindPickVerdict("4165550100"), { free: false, via: "service" });
  delete m.holders["14165550100"];
  m.pool["14165550100"] = { serviceId: null, inUse: false };
  assert.deepEqual(await mindPickVerdict("4165550100"), { free: false, via: "inventory" });
});

await test("mindPickVerdict fails closed; a timeout is retried once", async () => {
  handler = () => json(500, { message: "down" });
  await rejects(mindPickVerdict("4165550100"), e => assert.match(e.message, /HTTP 500/));
  calls = [];
  const m = fakeMind();
  let timedOut = 0;
  handler = (c) => {
    if (c.path === "/account-details-with-phone" && !timedOut++) throw new DOMException("aborted due to timeout", "TimeoutError");
    return m.handler(c);
  };
  assert.deepEqual(await mindPickVerdict("4165550100"), { free: true });
  assert.equal(calls.filter(c => c.path === "/account-details-with-phone").length, 2);
});

await test("cachedPickVerdict caches briefly", async () => {
  handler = fakeMind().handler;
  await cachedPickVerdict("14165550100");
  const n = calls.length;
  assert.deepEqual(await cachedPickVerdict("4165550100"), { free: true });
  assert.equal(calls.length, n);
});

const CITIES = [
  { id: 10, city: "Toronto", province: "ON" },
  { id: 11, city: "Windsor", province: "ON" },
  { id: 12, city: "London", province: "ON" },
  { id: 20, city: "Kingston", province: "NS" },   // a same-named city in another province
];

await test("resolveMindCity: exact (province must fit), alias, NPA default, null", async () => {
  handler = fakeMind({ cities: CITIES }).handler;
  assert.deepEqual(await resolveMindCity({ ratecenter: "toronto", npa: "416" }), { id: 10, city: "Toronto", via: "exact" });
  assert.deepEqual(await resolveMindCity({ ratecenter: "CHATHAM", npa: "519" }), { id: 11, city: "Windsor", via: "alias" });
  assert.deepEqual(await resolveMindCity({ ratecenter: "KINGSTON", npa: "226" }), { id: 12, city: "London", via: "npa" }, "wrong province → NPA city");
  assert.equal(await resolveMindCity({ ratecenter: "NOWHERE", npa: "999" }), null);
  assert.equal(calls.filter(c => c.path === "/telephone-numbers/cities").length, 1, "list cached");
});

await test("ensureNumbersInMindInventory: added vs existing; no city → nothing written", async () => {
  const m = fakeMind({ pool: { "14165550101": { serviceId: null, inUse: false } } });
  handler = m.handler;
  const r = await ensureNumbersInMindInventory(["4165550100", "14165550101", "4165550100"], { id: 10, city: "Toronto" });
  assert.deepEqual(r, { added: ["14165550100"], existing: ["14165550101"] });
  assert.deepEqual(bodyOf(calls[0]), { telephoneNumbers: [{ start: "14165550100", end: "14165550100", cityId: 10 }] });
  calls = [];
  await rejects(ensureNumbersInMindInventory(["4165550102"], null), e => assert.equal(e.apiCode, "NO_MIND_CITY"));
  await rejects(ensureNumbersInMindInventory(["4165550102", "6135550100"], { "4165550102": { id: 10 } }), e => assert.equal(e.apiCode, "NO_MIND_CITY"));
  assert.equal(calls.length, 0);
  // per-number cities, keyed by 10 or 11 digits
  const r2 = await ensureNumbersInMindInventory(["4165550102", "6135550100"], { "4165550102": { id: 10 }, "16135550100": { id: 30 } });
  assert.deepEqual(r2.added, ["14165550102", "16135550100"]);
});

await test("attachNumbersToService: primary attached, extras pooled, verified", async () => {
  const m = fakeMind();
  handler = m.handler;
  const r = await attachNumbersToService("acct-1", "svc-1", ["4165550100", "4165550101", "4165550102"], { id: 10, city: "Toronto" }, { verifyDelayMs: 0 });
  assert.deepEqual(m.patched, [{ account: "acct-1", service: "svc-1", number: "14165550100" }]);
  const patch = calls.find(c => c.method === "PATCH");
  assert.deepEqual(bodyOf(patch), { telephoneNumber: "14165550100" });
  assert.equal(patch.headers["iristelx-api-key"], "test-mind-key");
  assert.equal(r.primary, "14165550100");
  assert.deepEqual(r.assigned, ["14165550100"]);
  assert.deepEqual(r.added, ["14165550100", "14165550101", "14165550102"]);
  assert.deepEqual(r.results, [
    { number: "14165550100", status: "attached" },
    { number: "14165550101", status: "pooled", inventory: "inserted" },
    { number: "14165550102", status: "pooled", inventory: "inserted" },
  ]);
  assert.equal(r.verify.confirmed, true);
  // The same call again (a resume): the pool shows it on this service → no second PATCH
  const again = await attachNumbersToService("acct-1", "svc-1", ["4165550100", "4165550101", "4165550102"], { id: 10 },
    { owned: r.added, verifyDelayMs: 0 });
  assert.equal(m.patched.length, 1);
  assert.equal(again.results[0].status, "already-attached");
  assert.equal(again.results[1].inventory, "owned");
  assert.equal(again.verify.confirmed, true);
});

await test("attachNumbersToService: taken primary throws before any write", async () => {
  const m = fakeMind({ holders: { "14165550100": [{ code: "svc-other", planCode: "X", contact: { emailAddress: "someone@else" } }] } });
  handler = m.handler;
  const e = await rejects(attachNumbersToService("acct-1", "svc-1", ["4165550100", "4165550101"], { id: 10 }, { verifyDelayMs: 0 }));
  assert.equal(e.takenNumber, "14165550100");
  assert.equal(e.via, "service");
  assert.equal(e.holderServiceId, "svc-other");
  assert.ok(!JSON.stringify(e).includes("someone@else"), "no other customer's details");
  assert.equal(calls.filter(c => c.method !== "GET").length, 0);
  // Pooled but not ours (not in `owned`) → taken
  const m2 = fakeMind({ pool: { "14165550100": { serviceId: null, inUse: false } } });
  handler = m2.handler;
  await rejects(attachNumbersToService("acct-1", "svc-1", ["4165550100"], { id: 10 }), x => assert.equal(x.via, "inventory"));
  // …and ours when the caller says it added it
  const ok = await attachNumbersToService("acct-1", "svc-1", ["4165550100"], { id: 10 }, { owned: ["4165550100"], verifyDelayMs: 0 });
  assert.equal(ok.results[0].status, "attached");
  // MIND refuses to add it ("already exists" for a number no lookup shows) → taken
  const m3 = fakeMind();
  handler = (c) => (c.path === "/telephone-numbers" && c.method === "POST")
    ? json(200, { errors: [{ code: 3100, message: "NOT INSERTED IN MIND already exists" }] }) : m3.handler(c);
  await rejects(attachNumbersToService("acct-1", "svc-1", ["4165550100"], { id: 10 }), x => assert.equal(x.via, "mind"));
});

await test("attachNumbersToService: 10008 on PATCH → taken; other failures plain errors", async () => {
  const m = fakeMind({ patchStatus: 400 });
  handler = m.handler;
  await rejects(attachNumbersToService("a", "s", ["4165550100"], { id: 10 }, { verifyDelayMs: 0 }),
    e => { assert.equal(e.takenNumber, "14165550100"); assert.equal(e.apiCode, "MIND_NUMBER_TAKEN"); });
  await rejects(attachNumbersToService("a", "s", ["4165550100"], null), e => assert.equal(e.apiCode, "NO_MIND_CITY"));
  await rejects(attachNumbersToService("a", "", ["4165550100"], { id: 1 }), e => assert.ok(e instanceof TypeError));
});

await test("activateMind: PATCHes account and service ACTIVE, never throws", async () => {
  handler = () => json(200, {});
  assert.deepEqual(await activateMind("acct-1", "svc-1"), { account: true, service: true, errors: [] });
  assert.deepEqual(calls.map(c => [c.method, c.path, bodyOf(c)]), [
    ["PATCH", "/accounts/acct-1", { status: "ACTIVE" }],
    ["PATCH", "/accounts/acct-1/services/svc-1", { status: "ACTIVE" }],
  ]);
  handler = () => { throw new TypeError("fetch failed"); };
  const r = await activateMind("acct-1", "svc-1");
  assert.equal(r.account, false);
  assert.equal(r.service, false);
  assert.equal(r.errors.length, 2);
  assert.deepEqual(await activateMind("acct-1"), { account: false, service: null, errors: [r.errors[0]] });
  assert.equal((await activateMind(null)).account, false);
  delete process.env.MIND_API_KEY;
  assert.equal((await activateMind("a", "s")).errors.length, 2);
});

await test("createMindAccount / createMindService / putServiceQuantity", async () => {
  handler = (c) => {
    if (c.path === "/accounts") return json(201, { accountId: 555 });
    if (c.path === "/accounts/555/services") return json(201, { service: { serviceId: 777 } });
    if (c.path.endsWith("/quantity")) return json(200, { quantity: bodyOf(c).quantity === "3" ? "3" : "1", servId: "x" });
    return json(404, {});
  };
  const contact = { fname: "Pat", lname: "Doe", phone: "4165550199", city: "Toronto" };
  assert.deepEqual(await createMindAccount(contact, "pat@example.com"), { accountId: "555" });
  const acctBody = bodyOf(calls[0]);
  assert.equal(acctBody.businessUnit, "1");
  assert.equal(acctBody.language, "en");
  assert.deepEqual(acctBody.contact.phone, { mobile: "4165550199" });
  assert.equal(acctBody.contact.emailAddress, "pat@example.com");
  assert.deepEqual(await createMindService("555", null, contact, "pat@example.com"), { serviceId: "777" });
  const svcBody = bodyOf(calls[1]);
  assert.equal(svcBody.planCode, "EXLNP_SBSIPTRNK");
  assert.equal(svcBody.contact.phone, "4165550199");
  assert.equal((await putServiceQuantity("555", "777", "EXLNP_SBDID", 3)).quantity, "3");
  assert.deepEqual(bodyOf(calls[2]), { serviceCode: "EXLNP_SBDID", quantity: "3" });
  assert.equal(calls[2].method, "PUT");
  await rejects(putServiceQuantity("555", "777", "EXLNP_SBDID", 4), e => assert.match(e.message, /quantity update failed/));
  handler = () => json(400, { message: "Email exists", errors: [{ message: "duplicate" }] });
  await rejects(createMindAccount(contact, "pat@example.com"), e => { assert.equal(e.status, 400); assert.match(e.message, /Email exists — duplicate/); });
});

await test("findMindAccountByEmail: matches here, prefers ACTIVE then newest; failure → null (strict throws)", async () => {
  handler = () => json(200, { accounts: [
    { accountId: "1", status: "NEW", createdOn: "2026-10-20", contact: { emailAddress: "Pat@Example.com" } },
    { accountId: "2", status: "ACTIVE", createdOn: "2026-01-01", contact: { emailAddress: "pat@example.com " } },
    { accountId: "3", status: "NEW", createdOn: "2026-10-21", contact: { emailAddress: "other@example.com" } },
  ] });
  assert.equal((await findMindAccountByEmail(" PAT@example.com")).accountId, "2");
  assert.equal(await findMindAccountByEmail("nobody@example.com"), null);
  assert.equal(await findMindAccountByEmail(""), null);
  handler = () => html(502, "bad gateway");
  assert.equal(await findMindAccountByEmail("pat@example.com"), null);
  await rejects(findMindAccountByEmail("pat@example.com", { strict: true }), e => assert.match(e.message, /HTTP 502/));
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log("Failed:", failed.join(" | "));
  process.exit(1);
}
