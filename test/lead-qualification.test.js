// Tests for lib/lead-qualification.js — no dependencies, no network.
// Run: node test/lead-qualification.test.js
import assert from "assert/strict";
import { readFileSync } from "fs";
import {
  PRODUCT_LABELS, OTHER_PRODUCT, normLabel, canonicalProduct, splitList, parseProducts, normalizeSegment,
  timelineToTimeframe, timelineFromDetails, optionIndex, parseMultiSelect, unionMultiSelect, mapLeadQualification,
  qualificationPatch, fmtStamp, fmtDate, dedupeLines, stampedBlock, appendBlock, quoteRequestRef,
  quoteBilling, quoteProductLabel, money, buildQuoteRequest, dcValue, fmtDuration, normalizeRecap, buildRecapNote,
  recapBody, recapFieldsLine, recapBlock, RECAP_BLOCK_MAX, hasBlock,
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

test("Iris 'Timing:' details line -> timeline, line taken out of the details", () => {
  const details = ["SIP — PBX/SBC: 3CX 18", "Timing: Exploring / no fixed date", "Could stop it: budget"];
  const t = timelineFromDetails(details);
  assert.equal(t.timeline, "Exploring / no fixed date");
  assert.deepEqual(t.rest, ["SIP — PBX/SBC: 3CX 18", "Could stop it: budget"]);
  const q = mapLeadQualification({ timeline: t.timeline });
  assert.equal(q.fields.purchasetimeframe, 4);
  assert.deepEqual(q.lines, ["Timeline: Exploring / no fixed date"]);
  // "Timeline:" works too, case-insensitive; the last one wins and only it is removed.
  const t2 = timelineFromDetails(["timing: 6+ months", "TIMELINE:  Within 3-6 months "]);
  assert.equal(t2.timeline, "Within 3-6 months");
  assert.equal(timelineToTimeframe(t2.timeline), 2);
  assert.deepEqual(t2.rest, ["timing: 6+ months"]);
  // No timing line, an empty one, or a module-prefixed label -> nothing taken.
  for (const d of [[], undefined, ["Timing:"], ["Must be true: Timing: sign by Q1"], ["SIP — Timing: soon"]]) {
    const r = timelineFromDetails(d);
    assert.equal(r.timeline, "");
    assert.deepEqual(r.rest, d || []);
  }
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

test("appendBlock appends after a blank line and stays within 4000 chars", () => {
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

test("recap note: 'No sales conversation' wording gives no note", () => {
  assert.equal(buildRecapNote({ recap: "No sales conversation" }), null);
  assert.equal(buildRecapNote({ recap: "No sales conversation." }), null);
  assert.ok(buildRecapNote({ recap: "No sales conversation yet, asked about 911 address." }));
});

test("legacy contact-form product names map to canonical labels", () => {
  for (const [legacy, label] of [
    ["Cloud Connect for Webex", "Unified communications / Cloud Connect"],
    ["Smart Manager", "Microsoft Teams calling (Operator Connect)"],
    ["Virtual Fax", "Cloud calling / Hosted PBX"],
    ["IP Phones", "Cloud calling / Hosted PBX"],
    ["Managed EDR", "Managed cybersecurity"],
    ["Managed SIEM", "Managed cybersecurity"],
    ["Cybersecurity Awareness Training", "Managed cybersecurity"],
    ["Vulnerability Assessment", "Managed cybersecurity"],
    ["Cybersecurity Consulting", "Managed cybersecurity"],
    ["Cybersecurity (General)", "Managed cybersecurity"],
    ["Wholesale SIP Trunking", "Wholesale voice termination"],
    ["Infrastructure Enablement", "Infrastructure enablement"],
    ["Other / Not sure", OTHER_PRODUCT],
  ]) assert.equal(canonicalProduct(legacy), label, legacy);
  // ...and with the real option list they land on the canonical value.
  const q = mapLeadQualification({ products: "Managed EDR, IP Phones" }, OPTIONS);
  assert.equal(q.fields.cr57d_productsofinterest, [pv("Cloud calling / Hosted PBX"), pv("Managed cybersecurity")].join(","));
});

test("appendBlock: an oversized block keeps its head", () => {
  const block = "--- stamp · Iris ---\nAsked for: SIP trunking\n" + "x".repeat(5000);
  const out = appendBlock("older history", block);
  assert.ok(out.length <= 4000);
  assert.ok(out.startsWith("--- stamp · Iris ---\nAsked for: SIP trunking"));
  assert.ok(out.endsWith("[truncated]"));
  assert.equal(appendBlock("a", "b"), "a\n\nb");
});

// ---- Iris recap in Form Answers ----

test("recap block: ET header at call end with duration, fields line, bullets, no blank lines or ids", () => {
  const block = recapBlock({
    at: new Date("2026-10-19T14:05:00Z"), durationSecs: 200,
    country: "Canada", segment: "enterprise", products: "SIP Trunking, fax to email",
    recap: "Needs:\n• SIP trunks for 40 users\n\n• 3CX PBX, 20 channels\nNext step:\n• Quote by Friday",
  });
  assert.equal(block, [
    "--- 2026-10-19 10:05 ET · Iris recap (3 min 20 s) ---",
    "Country: Canada · Segment: Enterprise · Products: SIP trunking, Not sure / other (fax to email)",
    "Needs:",
    "- SIP trunks for 40 users",
    "- 3CX PBX, 20 channels",
    "Next step:",
    "- Quote by Friday",
  ].join("\n"));
  assert.doesNotMatch(block, /\n\n|conv_|Conversation:/);
});

test("recap block: optional parts omitted; a bullet repeated under two headings is kept", () => {
  const block = recapBlock({ at: new Date("2026-10-19T14:05:00Z"), recap: "A:\n- same\nB:\n- same", segment: "unknown" });
  assert.equal(block, "--- 2026-10-19 10:05 ET · Iris recap ---\nA:\n- same\nB:\n- same");
});

test("recap block is null exactly when the recap note is", () => {
  for (const recap of ["", "   ", undefined, null, "No sales conversation", "No sales conversation.",
    "no sales activity", "Asked about 911 address.", "No sales conversation yet, asked about pricing."]) {
    assert.equal(recapBlock({ recap, country: "Canada" }) === null, buildRecapNote({ recap, country: "Canada" }) === null, String(recap));
  }
  assert.equal(recapBody("No sales conversation."), "");
  assert.equal(recapFieldsLine({ segment: "wholesale" }), "Segment: Wholesale");
  assert.equal(recapFieldsLine({}), "");
});

test("recap block: capped at whole lines, header kept, history survives the append", () => {
  const recap = Array.from({ length: 300 }, (_, i) => `- point number ${i} about the customer's needs`).join("\n");
  const block = recapBlock({ at: new Date("2026-10-19T14:05:00Z"), durationSecs: 61, recap });
  assert.ok(block.length <= RECAP_BLOCK_MAX, String(block.length));
  assert.ok(block.startsWith("--- 2026-10-19 10:05 ET · Iris recap (1 min 1 s) ---\n- point number 0 "));
  assert.ok(block.endsWith("\n[truncated]"));
  assert.match(block.split("\n").slice(-2)[0], /^- point number \d+ about the customer's needs$/);
  // History + recap over 4000: the older block keeps its head, not wiped.
  const out = appendBlock("--- old · Website contact form ---\nAsked for: SIP trunking\n" + "h".repeat(2600), block);
  assert.ok(out.length <= 4000, String(out.length));
  assert.ok(out.endsWith("\n[truncated]\n\n" + block));
  assert.ok(out.startsWith("--- old · Website contact form ---\nAsked for: SIP trunking\nhhh"));
  // One huge recap line is cut, not dropped.
  const one = recapBlock({ recap: "x".repeat(5000) });
  assert.ok(one.length <= RECAP_BLOCK_MAX && /\nx{40,}\n\[truncated\]$/.test(one));
});

test("hasBlock matches a block's header line exactly", () => {
  const block = "--- 2026-10-19 10:05 ET · Iris recap (3 min 20 s) ---\n- a";
  assert.equal(hasBlock("--- older ---\nx\n\n" + block, block), true);
  assert.equal(hasBlock("--- 2026-10-19 10:05 ET · Iris recap (3 min 21 s) ---\n- a", block), false);
  assert.equal(hasBlock("", block), false);
  assert.equal(hasBlock(null, block), false);
  assert.equal(hasBlock("x", ""), false);
});

test("appendBlock trims oldest history by whole blocks; a partly-fitting block keeps its head", () => {
  const blk = (n) => `--- 2026-10-1${n} 09:00 ET · Website contact form ---\n` + String(n).repeat(1795);
  // 1 + 2 + 3 > 4000: 2 and 3 whole, 1 keeps its head (304 chars of room).
  const out = appendBlock([blk(1), blk(2)].join("\n\n"), blk(3));
  assert.ok(out.length <= 4000);
  assert.ok(out.startsWith("--- 2026-10-11 09:00 ET"), out.slice(0, 40));
  assert.ok(out.includes("\n[truncated]\n\n" + blk(2) + "\n\n" + blk(3)));
  // Too little room left (< 200) for the oldest: it's dropped, not shown as a stub.
  const a = "--- A ---\n" + "a".repeat(100), b = "--- B ---\n" + "b".repeat(3000);
  const c = "--- C ---\n" + "c".repeat(4000 - b.length - 2 - 10); // b + "\n\n" + c is exactly 4000
  assert.equal(appendBlock(a + "\n\n" + b, c), b + "\n\n" + c);
  // Older block fits whole once the one before it is dropped (no off-by-one).
  const b2 = "--- B ---\n" + "b".repeat(2000);
  for (const extra of [0, 1, 2, 3]) {
    const c2 = "--- C ---\n" + "c".repeat(4000 - b2.length - 2 - 10 - extra);
    assert.equal(appendBlock(a + "\n\n" + b2, c2), b2 + "\n\n" + c2, `extra ${extra}`);
  }
  // Reviewer scenario: one big website block + a long recap -> the block's head survives.
  const form = stampedBlock({ source: "website-form", at: new Date("2026-10-19T14:02:00Z"), topic: "SIP trunking",
    lines: ["Country: Canada", "Company size: 51-200", "Message: " + "m".repeat(2500)] });
  const recapB = recapBlock({ at: new Date("2026-10-19T15:00:00Z"), recap: Array.from({ length: 40 }, (_, i) => `- point ${i} ` + "r".repeat(25)).join("\n") });
  const mixed = appendBlock(form, recapB);
  assert.ok(mixed.length <= 4000);
  assert.ok(mixed.includes("Asked for: SIP trunking") && mixed.includes("Company size: 51-200"));
  assert.ok(mixed.endsWith(recapB));
  // Legacy history with no block headers: its head is kept, marked.
  const legacy = appendBlock("legacy details " + "x".repeat(5000), "NEW");
  assert.equal(legacy.length, 4000);
  assert.ok(legacy.startsWith("legacy details ") && legacy.endsWith("\n[truncated]\n\nNEW"));
});

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
