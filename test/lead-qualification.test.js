// Tests for lib/lead-qualification.js — no dependencies, no network.
// Run: node test/lead-qualification.test.js
import assert from "assert/strict";
import { readFileSync } from "fs";
import {
  PRODUCT_LABELS, OTHER_PRODUCT, normLabel, canonicalProduct, splitList, parseProducts, normalizeSegment,
  timelineToTimeframe, optionIndex, parseMultiSelect, unionMultiSelect, mapLeadQualification,
  qualificationPatch, fmtStamp, fmtDate, dedupeLines, stampedBlock, appendBlock, quoteRequestRef,
  quoteBilling, quoteProductLabel, money, buildQuoteRequest, dcValue, fmtDuration, normalizeRecap, buildRecapNote,
} from "../lib/lead-qualification.js";

let passed = 0;
const failed = [];
function test(name, fn) {
  try { fn(); passed++; console.log("ok  ", name); }
  catch (e) { failed.push(name); console.log("FAIL", name, "\n     ", e.message.split("\n").join("\n      ")); }
}

// Dynamics metadata shapes, as the Web API returns them.
const opt = (Value, Label) => ({ Value, Label: { UserLocalizedLabel: { Label } } });
const PRODUCT_OPTIONS = optionIndex(PRODUCT_LABELS.map((l, i) => opt(649950000 + i, l)));
const SEGMENT_OPTIONS = optionIndex([opt(649950000, "Enterprise"), opt(649950001, "Wholesale")]);
const OPTIONS = { segment: SEGMENT_OPTIONS, products: PRODUCT_OPTIONS };
const pv = (label) => 649950000 + PRODUCT_LABELS.indexOf(label);

// ---- label normalisation / mapping ----

test("normLabel strips case, punctuation, accents; center -> centre", () => {
  assert.equal(normLabel("  STIR/SHAKEN "), "stir shaken");
  assert.equal(normLabel("Contact Center"), "contact centre");
  assert.equal(normLabel("Téléphonie & SMS"), "telephonie and sms");
});

test("every canonical label maps to itself", () => {
  assert.equal(PRODUCT_LABELS.length, 21);
  for (const l of PRODUCT_LABELS) assert.equal(canonicalProduct(l), l);
  for (const l of PRODUCT_LABELS) assert.equal(canonicalProduct(l.toUpperCase()), l);
});

test("legacy form / booking names map to canonical labels", () => {
  const cases = {
    "Contact centre": "Contact centre (Cloud Contact)",
    "Contact center": "Contact centre (Cloud Contact)",
    "Managed cybersecurity (EDR, SIEM, consulting)": "Managed cybersecurity",
    "Messaging Services": "Business messaging / SMS",
    "Wholesale Voice Termination": "Wholesale voice termination",
    "SIP Trunking": "SIP trunking",
    "Cloud Calling (Hosted PBX)": "Cloud calling / Hosted PBX",
    "Wholesale Phone Numbers": "DID numbers",
    "Teams Calling (Operator Connect)": "Microsoft Teams calling (Operator Connect)",
    "Unite with Webex": "Webex calling (Unite with Webex)",
    "Business Messaging": "Business messaging / SMS",
    "A2P / P2P Messaging": "A2P / P2P messaging",
    "Voice Termination": "Wholesale voice termination",
    "stir shaken": "STIR/SHAKEN",
    "Smart Connect bundle": "Smart Connect bundles",
    "toll free number": "Toll-free numbers",
    "SIP trunking (20 channels)": "SIP trunking",
    "Not sure": OTHER_PRODUCT,
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(canonicalProduct(raw), want, raw);
  assert.equal(canonicalProduct("fax to email"), null);
  assert.equal(canonicalProduct(""), null);
});

test("splitList keeps commas inside parentheses", () => {
  assert.deepEqual(splitList("SIP trunking, Managed cybersecurity (EDR, SIEM, consulting); DID numbers"),
    ["SIP trunking", "Managed cybersecurity (EDR, SIEM, consulting)", "DID numbers"]);
  assert.deepEqual(splitList(["A, B", "C"]), ["A", "B", "C"]);
  assert.deepEqual(splitList(" , unknown, "), []);
});

test("parseProducts: canonical, deduped, unknown -> Not sure / other + raw kept", () => {
  assert.deepEqual(parseProducts("sip trunking, SIP Trunking, Contact centre"),
    { labels: ["SIP trunking", "Contact centre (Cloud Contact)"], unknown: [] });
  assert.deepEqual(parseProducts("SIP trunking, fax to email"),
    { labels: ["SIP trunking", OTHER_PRODUCT], unknown: ["fax to email"] });
});

test("normalizeSegment", () => {
  assert.equal(normalizeSegment("enterprise"), "enterprise");
  assert.equal(normalizeSegment("Enterprise – Direct"), "enterprise");
  assert.equal(normalizeSegment("WHOLESALE"), "wholesale");
  assert.equal(normalizeSegment("unknown"), "");
  assert.equal(normalizeSegment(undefined), "");
});

// ---- timeline -> purchasetimeframe ----

test("timeline labels map to purchasetimeframe 0-4", () => {
  const cases = {
    "As soon as possible": 0, "Within 1-3 months": 1, "Within 1–3 months": 1, "Within 3-6 months": 2,
    "3-6 months": 2, "6+ months": 3, "Just researching": 4, "Exploring / no fixed date": 4,
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(timelineToTimeframe(raw), want, raw);
  assert.equal(timelineToTimeframe(""), undefined);
  assert.equal(timelineToTimeframe("whenever"), undefined);
});

// ---- option index / multi-select ----

test("optionIndex reads metadata labels both ways", () => {
  assert.equal(SEGMENT_OPTIONS.byKey.get("enterprise"), 649950000);
  assert.equal(SEGMENT_OPTIONS.byValue.get(649950001), "Wholesale");
  const localized = optionIndex([{ Value: 7, Label: { LocalizedLabels: [{ Label: "Seven" }] } }]);
  assert.equal(localized.byValue.get(7), "Seven");
});

test("products union keeps existing values and adds new ones", () => {
  assert.deepEqual(parseMultiSelect("649950000, 649950003"), [649950000, 649950003]);
  assert.deepEqual(parseMultiSelect(null), []);
  assert.equal(unionMultiSelect("649950003,649950000", [649950003, 649950005]), "649950000,649950003,649950005");
  assert.equal(unionMultiSelect(null, [649950002]), "649950002");
  assert.equal(unionMultiSelect("649950000,649950003", [649950003]), null);
  assert.equal(unionMultiSelect("649950000", []), null);
});

// ---- mapLeadQualification / qualificationPatch ----

test("mapLeadQualification maps to Dataverse fields and answer lines", () => {
  const q = mapLeadQualification({
    country: "Canada", segment: "enterprise", account_path: "Enterprise – Direct",
    products: "SIP Trunking, Contact centre, fax to email", job_title: "IT Director",
    website: "acme.example", timeline: "Within 1-3 months",
  }, OPTIONS);
  assert.deepEqual(q.fields, {
    address1_country: "Canada",
    cr57d_customersegment: 649950000,
    cr57d_productsofinterest: [pv("SIP trunking"), pv("Contact centre (Cloud Contact)"), pv(OTHER_PRODUCT)].sort((a, b) => a - b).join(","),
    jobtitle: "IT Director",
    websiteurl: "acme.example",
    purchasetimeframe: 1,
  });
  assert.deepEqual(q.lines, [
    "Country: Canada",
    "Customer segment: Enterprise",
    "Account path: Enterprise – Direct",
    "Products of interest: SIP trunking, Contact centre (Cloud Contact), Not sure / other",
    "Products (as described): fax to email",
    "Job title: IT Director",
    "Website: acme.example",
    "Timeline: Within 1-3 months",
  ]);
});

test("missing choice columns are skipped but values stay in the lines", () => {
  const q = mapLeadQualification({ segment: "wholesale", products: "DID numbers", country: "unknown" }, { segment: null, products: null });
  assert.deepEqual(q.fields, {});
  assert.deepEqual(q.lines, ["Customer segment: Wholesale", "Products of interest: DID numbers"]);
  assert.deepEqual(q.productValues, []);
});

test("a product only Dynamics knows still resolves by its option label", () => {
  const idx = optionIndex([...PRODUCT_LABELS.map((l, i) => opt(649950000 + i, l)), opt(649950099, "Virtual fax")]);
  const q = mapLeadQualification({ products: "virtual fax" }, { products: idx });
  assert.equal(q.fields.cr57d_productsofinterest, "649950099");
  assert.deepEqual(q.lines, ["Products of interest: Virtual fax"]);
});

test("qualificationPatch: newest wins with history lines, products merged", () => {
  const qual = mapLeadQualification({ country: "Canada", segment: "wholesale", products: "DID numbers", timeline: "6+ months", job_title: "cto" }, OPTIONS);
  const existing = {
    address1_country: "United States", jobtitle: "CTO", websiteurl: null, purchasetimeframe: 0,
    cr57d_customersegment: 649950000, cr57d_productsofinterest: String(pv("SIP trunking")),
  };
  const { patch, history } = qualificationPatch(existing, qual);
  assert.deepEqual(patch, {
    address1_country: "Canada",
    purchasetimeframe: 3,
    cr57d_customersegment: 649950001,
    cr57d_productsofinterest: [pv("SIP trunking"), pv("DID numbers")].join(","),
  });
  assert.deepEqual(history, [
    "Country changed: United States → Canada",
    "Purchase timeframe changed: Immediate → This Year",
    "Customer segment changed: Enterprise → Wholesale",
  ]);
});

test("qualificationPatch fillOnly fills empty fields only (products still merged)", () => {
  const qual = mapLeadQualification({ country: "Canada", segment: "enterprise", products: "SIP trunking" }, OPTIONS);
  const r1 = qualificationPatch({ address1_country: "Mexico", cr57d_customersegment: null, cr57d_productsofinterest: null }, qual, { fillOnly: true });
  assert.deepEqual(r1.patch, { cr57d_customersegment: 649950000, cr57d_productsofinterest: String(pv("SIP trunking")) });
  assert.deepEqual(r1.history, []);
  const r2 = qualificationPatch({ address1_country: "Canada", cr57d_customersegment: 649950001, cr57d_productsofinterest: String(pv("SIP trunking")) }, qual, { fillOnly: true });
  assert.deepEqual(r2.patch, {});
});

// ---- stamped answers block ----

test("fmtStamp / fmtDate use Toronto time", () => {
  assert.equal(fmtStamp(new Date("2026-10-19T14:05:00Z")), "2026-10-19 10:05 ET");
  assert.equal(fmtDate(new Date("2026-10-20T02:00:00Z")), "2026-10-19");
  assert.equal(fmtStamp(new Date("2026-01-15T17:30:00Z")), "2026-01-15 12:30 ET");
});

test("stampedBlock: date, source, what they asked for, deduped answers", () => {
  const block = stampedBlock({
    source: "website-form", at: new Date("2026-10-19T14:05:00Z"), topic: "SIP trunking",
    lines: ["Country: Canada", "", "Message: hi", "Country: Canada"],
  });
  assert.equal(block, [
    "--- 2026-10-19 10:05 ET · Website contact form ---",
    "Asked for: SIP trunking",
    "Country: Canada",
    "Message: hi",
  ].join("\n"));
  assert.match(stampedBlock({ source: "iris", lines: ["x"] }), /^--- \d{4}-\d{2}-\d{2} \d{2}:\d{2} (ET|UTC) · Iris \(AI assistant\) ---\nx$/);
  assert.doesNotMatch(block, /conv_|New conversation/);
});

test("appendBlock appends after a blank line and keeps the newest 4000 chars", () => {
  assert.equal(appendBlock("", "B"), "B");
  assert.equal(appendBlock(null, "B"), "B");
  assert.equal(appendBlock("A", "B"), "A\n\nB");
  const long = appendBlock("x".repeat(5000), "NEW");
  assert.equal(long.length, 4000);
  assert.ok(long.endsWith("\n\nNEW"));
});

test("dedupeLines drops blanks and repeats", () => {
  assert.deepEqual(dedupeLines([" a ", "b", "a", "", null, "b"]), ["a", "b"]);
});

// ---- quote requests ----

// The real catalog ids, read from server.js (prices for the totals test below).
const SERVER = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const CATALOG_IDS = [...SERVER.matchAll(/^ {2}(\w+): \{ pn: /gm)].map((m) => m[1]);
const CATALOG = {
  sc_pro_new: { name: "Pro Smart Connect Bundle", price: 45 },
  sc_pro: { name: "Pro Smart Connect Bundle (existing customer)", price: 33 },
  pbx_auto_attendant: { name: "Auto-Attendant", price: 30 },
  pbx_aa_activation: { name: "Auto-Attendant Activation (one-time)", price: 50 },
  pbx_user_activation: { name: "User Activation (one-time, per user)", price: 25 },
  cc_custom_dev: { name: "Custom Development (per hour)", price: 200 },
  cc_setup_fee: { name: "Cloud Contact Center Set Up (one-time)", price: 4000 },
};

test("QR reference format QR-YYMMDD-XXXX (Toronto date)", () => {
  const seq = [0, 1, 2, 31];
  assert.equal(quoteRequestRef(new Date("2026-10-20T02:00:00Z"), () => seq.shift()), "QR-261019-ABC9");
  for (let i = 0; i < 50; i++) assert.match(quoteRequestRef(), /^QR-\d{6}-[A-Z0-9]{4}$/);
});

test("one-time vs monthly billing", () => {
  assert.equal(quoteBilling("Auto-Attendant Activation (one-time)"), "one-time");
  assert.equal(quoteBilling("User Activation (one-time, per user)"), "one-time");
  assert.equal(quoteBilling("Custom Development (per hour)"), "one-time");
  assert.equal(quoteBilling("Pro Smart Connect Bundle"), "monthly");
  assert.equal(quoteBilling("Call Queue Basic (per agent)"), "monthly");
});

test("money formatting", () => {
  assert.equal(money(0), "$0.00");
  assert.equal(money(45), "$45.00");
  assert.equal(money(1234.5), "$1,234.50");
  assert.equal(money(1000000), "$1,000,000.00");
});

test("catalog ids map to canonical products of interest", () => {
  assert.ok(CATALOG_IDS.length >= 25, "catalog ids parsed from server.js");
  for (const id of CATALOG_IDS) assert.ok(PRODUCT_LABELS.includes(quoteProductLabel(id)), id);
  assert.equal(quoteProductLabel("sc_premium_new"), "Smart Connect bundles");
  assert.equal(quoteProductLabel("pbx_webex_standard"), "Webex calling (Unite with Webex)");
  assert.equal(quoteProductLabel("pbx_cloud_connect"), "Unified communications / Cloud Connect");
  assert.equal(quoteProductLabel("pbx_unite"), "Cloud calling / Hosted PBX");
  assert.equal(quoteProductLabel("pbx_hunt_group"), "Cloud calling / Hosted PBX");
  assert.equal(quoteProductLabel("cc_core_voice"), "Contact centre (Cloud Contact)");
  assert.equal(quoteProductLabel("cc_recording_ai"), "Conversation capture / Call recording");
});

test("quote-request block: lines, monthly and one-time totals, reference", () => {
  const r = buildQuoteRequest({
    items: [
      { product: "sc_pro_new", quantity: 8 }, { product: "pbx_auto_attendant", quantity: 1 },
      { product: "pbx_aa_activation", quantity: 1 }, { product: "cc_custom_dev", quantity: 5 },
      { product: "sc_pro_new", quantity: 2 },
    ],
    catalog: CATALOG, existing: false, company: "Acme Ltd", country: "Canada", segment: "enterprise",
    account_path: "Enterprise – Direct", notes: "Two sites, start in January.", ref: "QR-261019-ABCD",
  });
  assert.equal(r.monthlyTotal, 480);   // 10 × 45 + 30
  assert.equal(r.oneTimeTotal, 1050);  // 50 + 5 × 200
  assert.deepEqual(r.productNames, ["Pro Smart Connect Bundle", "Auto-Attendant", "Auto-Attendant Activation (one-time)", "Custom Development (per hour)"]);
  assert.deepEqual(r.productLabels, ["Smart Connect bundles", "Cloud calling / Hosted PBX", "Contact centre (Cloud Contact)"]);
  assert.deepEqual(r.lines, [
    "Quote request:",
    "- 10 × Pro Smart Connect Bundle — $45.00/mo each = $450.00/mo",
    "- 1 × Auto-Attendant — $30.00/mo each = $30.00/mo",
    "- 1 × Auto-Attendant Activation (one-time) — $50.00 each = $50.00 one-time",
    "- 5 × Custom Development (per hour) — $200.00/hr each = $1,000.00 one-time",
    "Estimated monthly total: $480.00/mo",
    "Estimated one-time total: $1,050.00",
    "Catalog list prices in CAD before taxes; sales confirms the final quote.",
    "Customer type: New customer",
    "Company: Acme Ltd",
    "Country: Canada",
    "Customer segment: Enterprise",
    "Account path: Enterprise – Direct",
    "Notes: Two sites, start in January.",
    "Quote request ref: QR-261019-ABCD",
  ]);
});

test("quote-request block: existing customer, monthly only, empty optionals omitted", () => {
  const r = buildQuoteRequest({
    items: [{ product: "sc_pro", quantity: 3 }], catalog: CATALOG, existing: true,
    company: "", country: "unknown", segment: "unknown", account_path: "", notes: "", ref: "QR-261019-WXYZ",
  });
  assert.equal(r.oneTimeTotal, 0);
  assert.ok(!r.lines.some((l) => /one-time total|Company:|Country:|segment|Account path|Notes:/.test(l)));
  assert.ok(r.lines.includes("Estimated monthly total: $99.00/mo"));
  assert.ok(r.lines.includes("Customer type: Existing Iristel customer (existing-customer pricing applies)"));
  assert.equal(r.lines[r.lines.length - 1], "Quote request ref: QR-261019-WXYZ");
});

test("quote block + qualification lines dedupe inside one stamped block", () => {
  const r = buildQuoteRequest({ items: [{ product: "sc_pro_new", quantity: 1 }], catalog: CATALOG, existing: false,
    country: "Canada", segment: "enterprise", ref: "QR-261019-AAAA" });
  const q = mapLeadQualification({ country: "Canada", segment: "enterprise", products: r.productLabels }, OPTIONS);
  const block = stampedBlock({ source: "iris", topic: "Quote request — Pro Smart Connect Bundle", lines: [...q.lines, ...r.lines] });
  assert.equal(block.match(/^Country: Canada$/gm).length, 1);
  assert.equal(block.match(/^Customer segment: Enterprise$/gm).length, 1);
  assert.match(block, /^Products of interest: Smart Connect bundles$/m);
  assert.match(block, /^Quote request ref: QR-261019-AAAA$/m);
});

// ---- post-call recap note ----

test("dcValue reads data_collection_results values, empty-ish -> ''", () => {
  const dc = {
    country: { data_collection_id: "country", value: " Canada ", rationale: "..." },
    customer_segment: { value: "unknown" },
    products_of_interest: { value: null },
  };
  assert.equal(dcValue(dc, "country"), "Canada");
  assert.equal(dcValue(dc, "customer_segment"), "");
  assert.equal(dcValue(dc, "products_of_interest"), "");
  assert.equal(dcValue(dc, "sales_recap"), "");
  assert.equal(dcValue(undefined, "country"), "");
});

test("fmtDuration", () => {
  assert.equal(fmtDuration(200), "3 min 20 s");
  assert.equal(fmtDuration(180), "3 min");
  assert.equal(fmtDuration(45), "45 s");
  assert.equal(fmtDuration(0), "");
  assert.equal(fmtDuration(undefined), "");
});

test("normalizeRecap tidies bullets and blank lines", () => {
  assert.equal(normalizeRecap("* Needs SIP  \r\n\r\n\r\n• 20 channels\n- Port 15 DIDs"), "- Needs SIP\n\n- 20 channels\n- Port 15 DIDs");
});

test("recap note: title with date + duration, fields line, recap, conversation ref", () => {
  const note = buildRecapNote({
    at: new Date("2026-10-19T14:05:00Z"), durationSecs: 200,
    country: "Canada", segment: "enterprise", products: "SIP Trunking, fax to email",
    recap: "• Needs SIP trunks for 40 users\n• 3CX PBX, 20 channels", conversationId: "conv_123",
  });
  assert.equal(note.subject, "Iris recap — 2026-10-19 (3 min 20 s)");
  assert.equal(note.notetext, [
    "Country: Canada · Segment: Enterprise · Products: SIP trunking, Not sure / other (fax to email)",
    "",
    "- Needs SIP trunks for 40 users",
    "- 3CX PBX, 20 channels",
    "",
    "Conversation: conv_123",
  ].join("\n"));
  assert.doesNotMatch(note.notetext, /contextual|transcript|SUMMARY/i);
});

test("recap note: no fields line when nothing known, null when recap empty", () => {
  const note = buildRecapNote({ at: new Date("2026-10-19T14:05:00Z"), recap: "Asked about pricing.", segment: "unknown" });
  assert.equal(note.subject, "Iris recap — 2026-10-19");
  assert.equal(note.notetext, "Asked about pricing.");
  assert.equal(buildRecapNote({ recap: "   ", country: "Canada" }), null);
  assert.equal(buildRecapNote({ recap: undefined }), null);
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
