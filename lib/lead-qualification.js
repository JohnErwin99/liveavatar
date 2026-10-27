// Pure helpers for lead qualification (no network, no env) — imported by
// server.js and covered by test/lead-qualification.test.js.
//
// One product list is shared by Iris, the website contact form and the
// booking page. Dynamics option VALUES are never hard-coded here: server.js
// reads them by label from the column metadata and passes them in as an
// option index (see optionIndex), so labels can be edited in Dynamics later.
import crypto from "crypto";

// Canonical "Products of interest" labels, in the column's option order.
export const PRODUCT_LABELS = [
  "SIP trunking",
  "Microsoft Teams calling (Operator Connect)",
  "Webex calling (Unite with Webex)",
  "Unified communications / Cloud Connect",
  "Cloud calling / Hosted PBX",
  "Smart Connect bundles",
  "Contact centre (Cloud Contact)",
  "Business messaging / SMS",
  "Managed cybersecurity",
  "Conversation capture / Call recording",
  "Toll-free numbers",
  "Wireless / mobility",
  "Wholesale voice termination",
  "Voice origination",
  "DID numbers",
  "International voice",
  "A2P / P2P messaging",
  "Number porting",
  "STIR/SHAKEN",
  "Infrastructure enablement",
  "Not sure / other",
];
export const OTHER_PRODUCT = "Not sure / other";

// Customer segment API values -> Dynamics option labels.
export const SEGMENT_LABELS = { enterprise: "Enterprise", wholesale: "Wholesale" };

// purchasetimeframe is a built-in global choice with fixed values.
export const TIMEFRAME_LABELS = ["Immediate", "This Quarter", "Next Quarter", "This Year", "Unknown"];

// Older / looser names -> canonical label. Matching is case-insensitive and
// ignores punctuation and plurals (see productKey), so only real wording
// differences need an entry here.
const PRODUCT_ALIASES = {
  // legacy website form + booking page names
  "Contact centre": "Contact centre (Cloud Contact)",
  "Cloud Contact": "Contact centre (Cloud Contact)",
  "Cloud Contact Centre": "Contact centre (Cloud Contact)",
  "Managed cybersecurity (EDR, SIEM, consulting)": "Managed cybersecurity",
  "Cybersecurity": "Managed cybersecurity",
  "Messaging Services": "Business messaging / SMS",
  "Business Messaging": "Business messaging / SMS",
  "SMS": "Business messaging / SMS",
  "Voice Termination": "Wholesale voice termination",
  "Cloud Calling (Hosted PBX)": "Cloud calling / Hosted PBX",
  "Cloud calling": "Cloud calling / Hosted PBX",
  "Hosted PBX": "Cloud calling / Hosted PBX",
  "Cloud PBX": "Cloud calling / Hosted PBX",
  "Wholesale Phone Numbers": "DID numbers",
  "DID": "DID numbers",
  "Phone numbers": "DID numbers",
  "Teams Calling (Operator Connect)": "Microsoft Teams calling (Operator Connect)",
  "Teams calling": "Microsoft Teams calling (Operator Connect)",
  "Microsoft Teams calling": "Microsoft Teams calling (Operator Connect)",
  "Microsoft Teams": "Microsoft Teams calling (Operator Connect)",
  "Operator Connect": "Microsoft Teams calling (Operator Connect)",
  "Unite with Webex": "Webex calling (Unite with Webex)",
  "Iristel Unite with Webex": "Webex calling (Unite with Webex)",
  "Webex calling": "Webex calling (Unite with Webex)",
  "Webex": "Webex calling (Unite with Webex)",
  "Unified communications": "Unified communications / Cloud Connect",
  "Cloud Connect": "Unified communications / Cloud Connect",
  "Smart Connect": "Smart Connect bundles",
  "Conversation capture": "Conversation capture / Call recording",
  "Call recording": "Conversation capture / Call recording",
  "Toll-free": "Toll-free numbers",
  "Wireless": "Wireless / mobility",
  "Mobility": "Wireless / mobility",
  "A2P": "A2P / P2P messaging",
  "P2P": "A2P / P2P messaging",
  "A2P messaging": "A2P / P2P messaging",
  "SIP trunks": "SIP trunking",
  "SIP": "SIP trunking",
  "Porting": "Number porting",
  "Not sure": OTHER_PRODUCT,
  "Other": OTHER_PRODUCT,
  // remaining options of the pre-2026-10-19 contact form (still posts until
  // the new form is published)
  "Cloud Connect for Webex": "Unified communications / Cloud Connect",
  "Smart Manager": "Microsoft Teams calling (Operator Connect)",
  "Virtual Fax": "Cloud calling / Hosted PBX",
  "IP Phones": "Cloud calling / Hosted PBX",
  "Managed EDR": "Managed cybersecurity",
  "Managed SIEM": "Managed cybersecurity",
  "Cybersecurity Awareness Training": "Managed cybersecurity",
  "Vulnerability Assessment": "Managed cybersecurity",
  "Cybersecurity Consulting": "Managed cybersecurity",
  "Cybersecurity (General)": "Managed cybersecurity",
  "Wholesale SIP Trunking": "Wholesale voice termination",
  "Infrastructure Enablement": "Infrastructure enablement",
  "Other / Not sure": OTHER_PRODUCT,
};

// Values Iris / ElevenLabs use for "nothing known" — treated as empty.
const EMPTYISH = new Set(["", "unknown", "none", "null", "undefined", "n/a", "na", "not provided",
  "not mentioned", "not specified"]);

// "  Canada " -> "Canada"; placeholders -> "".
export function cleanText(v) {
  if (v === undefined || v === null) return "";
  const s = String(v).trim();
  return EMPTYISH.has(s.toLowerCase()) ? "" : s;
}

// Lowercase, accents/punctuation stripped, "center" -> "centre".
export function normLabel(s) {
  return String(s == null ? "" : s)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bcenter\b/g, "centre")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// normLabel plus a trailing-plural strip per word ("bundles" == "bundle").
export function productKey(s) {
  return normLabel(s).split(" ").map((w) => (w.length > 3 ? w.replace(/s$/, "") : w)).join(" ");
}

const CANON = new Map();
for (const label of PRODUCT_LABELS) CANON.set(productKey(label), label);
for (const [alias, label] of Object.entries(PRODUCT_ALIASES)) {
  if (!CANON.has(productKey(alias))) CANON.set(productKey(alias), label);
}

// One product name -> canonical label, or null when not recognised.
// "SIP trunking (20 channels)" still matches by dropping the parenthetical.
export function canonicalProduct(name) {
  const key = productKey(name);
  if (!key) return null;
  if (CANON.has(key)) return CANON.get(key);
  const bare = productKey(String(name).replace(/\([^)]*\)/g, " "));
  return (bare && CANON.get(bare)) || null;
}

// "A, B (x, y); C" -> ["A", "B (x, y)", "C"]. Arrays are flattened. Commas
// inside parentheses don't split (legacy "Managed cybersecurity (EDR, SIEM, consulting)").
export function splitList(input) {
  if (Array.isArray(input)) return input.flatMap(splitList);
  const out = [];
  let depth = 0, cur = "";
  for (const ch of String(input == null ? "" : input)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;\n|]/.test(ch)) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((t) => t.replace(/^[\s\-•*]+/, "").trim()).filter((t) => cleanText(t));
}

// Free text -> { labels: canonical labels (unique, in input order), unknown: raw
// names nobody recognised }. Unknown text adds "Not sure / other"; the raw
// wording is kept by the caller in the answers block.
export function parseProducts(input) {
  const labels = [];
  const unknown = [];
  for (const raw of splitList(input)) {
    const label = canonicalProduct(raw);
    if (label) { if (!labels.includes(label)) labels.push(label); }
    else if (!unknown.includes(raw)) unknown.push(raw);
  }
  if (unknown.length && !labels.includes(OTHER_PRODUCT)) labels.push(OTHER_PRODUCT);
  return { labels, unknown };
}

// "enterprise" | "Enterprise – Direct" | "WHOLESALE" -> "enterprise" | "wholesale" | "".
export function normalizeSegment(v) {
  const s = normLabel(v);
  if (s.startsWith("enterprise")) return "enterprise";
  if (s.startsWith("wholesale")) return "wholesale";
  return "";
}

// Form / Iris timeline wording -> purchasetimeframe value (0-4), or undefined.
export function timelineToTimeframe(v) {
  const s = normLabel(v);
  if (!s) return undefined;
  if (/\b(asap|as soon as possible|immediate|immediately|right away)\b/.test(s)) return 0;
  if (/\b1 (to )?3\b|\bthis quarter\b/.test(s)) return 1;
  if (/\b3 (to )?6\b|\bnext quarter\b/.test(s)) return 2;
  if (/\b(6|12)\b|\byear\b/.test(s)) return 3;
  if (/research|explor|no fixed|not sure|undecided|unknown/.test(s)) return 4;
  return undefined;
}

// Iris saves Step C timing as a "Timing: …" (or "Timeline: …") line in the
// tool's details — the tools have no timeline field. -> { timeline, rest }:
// the last such line's value, and the details without that line (the
// qualification adds its own "Timeline:" line, so it isn't shown twice).
export function timelineFromDetails(details) {
  const lines = details || [];
  const re = /^\s*(timing|timeline)\s*:\s*(\S.*)$/i;
  let at = -1;
  lines.forEach((l, i) => { if (re.test(String(l))) at = i; });
  if (at < 0) return { timeline: "", rest: lines };
  return { timeline: re.exec(String(lines[at]))[2].trim(), rest: lines.filter((_, i) => i !== at) };
}

// Attribute metadata Options[] -> { byKey: productKey(label) -> value, byValue: value -> label }.
export function optionIndex(options) {
  const byKey = new Map();
  const byValue = new Map();
  for (const o of options || []) {
    const label = (o.Label && o.Label.UserLocalizedLabel && o.Label.UserLocalizedLabel.Label)
      || (o.Label && o.Label.LocalizedLabels && o.Label.LocalizedLabels[0] && o.Label.LocalizedLabels[0].Label);
    if (label == null || o.Value == null) continue;
    byKey.set(productKey(label), o.Value);
    byValue.set(o.Value, label);
  }
  return { byKey, byValue };
}

// Multi-select read format "649950000,649950003" -> [649950000, 649950003].
export function parseMultiSelect(v) {
  if (v === undefined || v === null || v === "") return [];
  return String(v).split(",").map((x) => Number(x.trim())).filter(Number.isFinite);
}

// Existing multi-select value + new option values -> the union as the Web API
// write format (sorted, comma-separated), or null when nothing new was added.
export function unionMultiSelect(existing, add) {
  const cur = parseMultiSelect(existing);
  const extra = (add || []).filter((v) => !cur.includes(v));
  if (!extra.length) return null;
  return [...new Set([...cur, ...extra])].sort((a, b) => a - b).join(",");
}

export function segmentLine(segment) {
  const s = SEGMENT_LABELS[normalizeSegment(segment)];
  return s ? `Customer segment: ${s}` : "";
}

// Qualification answers -> Dataverse lead columns + readable answer lines.
//   q:       { country, segment, products, job_title, website, timeline, account_path }
//   options: { segment: optionIndex|null, products: optionIndex|null } — a
//            null/missing index means the column doesn't exist (or couldn't be
//            read): the column is skipped and the value lives only in the lines.
export function mapLeadQualification(q = {}, options = {}) {
  const fields = {};
  const lines = [];
  const country = cleanText(q.country);
  const segment = normalizeSegment(q.segment);
  const accountPath = cleanText(q.account_path);
  const jobTitle = cleanText(q.job_title);
  const website = cleanText(q.website);
  const timeline = cleanText(q.timeline);
  const timeframe = timelineToTimeframe(timeline);

  if (country) { fields.address1_country = country.slice(0, 80); lines.push(`Country: ${country}`); }
  if (segment) {
    lines.push(segmentLine(segment));
    const v = options.segment && options.segment.byKey.get(productKey(SEGMENT_LABELS[segment]));
    if (v !== undefined && v !== null) fields.cr57d_customersegment = v;
  }
  if (accountPath) lines.push(`Account path: ${accountPath}`);

  // Products: the label is the canonical one (aliases included); the value is
  // the Dynamics option whose label matches the raw text (covers options added
  // in Dynamics later) or the canonical label. Unrecognised text -> "Not sure / other".
  const idx = options.products;
  const productLabels = [];
  const productValues = [];
  const unknownProducts = [];
  for (const raw of splitList(q.products)) {
    let label = canonicalProduct(raw);
    let v = idx ? idx.byKey.get(productKey(raw)) : undefined;
    // A Dynamics option named exactly like the raw text wins over an alias.
    if (v !== undefined) label = idx.byValue.get(v) || label;
    if (v === undefined && idx && label) v = idx.byKey.get(productKey(label));
    if (!label) {
      unknownProducts.push(raw);
      label = OTHER_PRODUCT;
      if (idx) v = idx.byKey.get(productKey(OTHER_PRODUCT));
    }
    if (!productLabels.includes(label)) productLabels.push(label);
    if (v !== undefined && v !== null && !productValues.includes(v)) productValues.push(v);
  }
  if (productLabels.length) lines.push(`Products of interest: ${productLabels.join(", ")}`);
  if (unknownProducts.length) lines.push(`Products (as described): ${unknownProducts.join(", ")}`);
  if (productValues.length) fields.cr57d_productsofinterest = [...productValues].sort((a, b) => a - b).join(",");

  if (jobTitle) { fields.jobtitle = jobTitle.slice(0, 100); lines.push(`Job title: ${jobTitle}`); }
  if (website) { fields.websiteurl = website.slice(0, 200); lines.push(`Website: ${website}`); }
  if (timeline) lines.push(`Timeline: ${timeline}`);
  if (timeframe !== undefined) fields.purchasetimeframe = timeframe;

  return {
    fields, lines, segment, timeframe,
    productLabels, productValues, unknownProducts,
    segmentLabels: options.segment ? options.segment.byValue : null,
  };
}

// Mapped qualification vs the existing open lead -> { patch, history }.
// Newest value wins (a history line records the old one); fillOnly only
// fills empty columns (post-call webhook). Products are always a union.
export function qualificationPatch(existing, qual, { fillOnly = false } = {}) {
  const patch = {};
  const history = [];
  const f = qual.fields;
  for (const [col, label] of [["address1_country", "Country"], ["jobtitle", "Job title"], ["websiteurl", "Website"]]) {
    if (!f[col]) continue;
    const old = existing[col];
    if (old && (fillOnly || normLabel(old) === normLabel(f[col]))) continue;
    patch[col] = f[col];
    if (old) history.push(`${label} changed: ${old} → ${f[col]}`);
  }
  const choice = (col, label, name) => {
    if (f[col] === undefined) return;
    const old = existing[col];
    const has = old !== undefined && old !== null;
    if (has && (fillOnly || old === f[col])) return;
    patch[col] = f[col];
    if (has) history.push(`${label} changed: ${name(old)} → ${name(f[col])}`);
  };
  choice("purchasetimeframe", "Purchase timeframe", (v) => TIMEFRAME_LABELS[v] || String(v));
  choice("cr57d_customersegment", "Customer segment", (v) => (qual.segmentLabels && qual.segmentLabels.get(v)) || String(v));
  if (f.cr57d_productsofinterest) {
    const u = unionMultiSelect(existing.cr57d_productsofinterest, qual.productValues);
    if (u) patch.cr57d_productsofinterest = u;
  }
  return { patch, history };
}

// ---- stamped answers blocks (cr57d_formanswers) ----

const SOURCE_LABELS = {
  iris: "Iris (AI assistant)",
  "website-form": "Website contact form",
  mailchimp: "Mailchimp landing page",
};

// Date parts in UTC: every date written on a lead is UTC (owner, 2026-10-27).
function utcParts(at) {
  const iso = at.toISOString();
  return { y: iso.slice(0, 4), m: iso.slice(5, 7), d: iso.slice(8, 10), hh: iso.slice(11, 13), mm: iso.slice(14, 16), tz: "UTC" };
}

export function fmtDate(at = new Date()) {
  const p = utcParts(at);
  return `${p.y}-${p.m}-${p.d}`;
}

export function fmtStamp(at = new Date()) {
  const p = utcParts(at);
  return `${p.y}-${p.m}-${p.d} ${p.hh}:${p.mm} ${p.tz}`;
}

// Drop blank and repeated lines, keeping the first occurrence.
export function dedupeLines(lines) {
  const seen = new Set();
  const out = [];
  for (const l of lines || []) {
    const s = String(l == null ? "" : l).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// One readable submission block: when, where from, what they asked for, answers.
export function stampedBlock({ source, at = new Date(), topic, lines = [] }) {
  return [
    `--- ${fmtStamp(at)} · ${SOURCE_LABELS[source] || source} ---`,
    ...(topic ? [`Asked for: ${topic}`] : []),
    ...dedupeLines(lines),
  ].join("\n");
}

// Append a block to the answers history, keeping it within 4000 characters.
export function appendBlock(prev, block, max = 4000) {
  // A block longer than the field on its own keeps its head (stamp, "Asked
  // for", qualification lines) and loses its tail instead.
  const MARK = "\n[truncated]";
  if (block.length >= max) return block.slice(0, max - MARK.length) + MARK;
  const all = (prev ? prev + "\n\n" : "") + block;
  if (all.length <= max) return all;
  // Too long: keep the newest blocks whole, newest first. The newest older
  // block that only partly fits keeps its head the same way (when there's
  // real room for it); anything older is dropped.
  const older = prev.split(/\n\n(?=--- )/);
  const kept = [block];
  let size = block.length;
  for (let i = older.length - 1; i >= 0; i--) {
    const b = older[i];
    if (size + 2 + b.length <= max) { kept.unshift(b); size += 2 + b.length; continue; }
    const room = max - size - 2;
    if (room >= 200) kept.unshift(b.slice(0, room - MARK.length) + MARK);
    break;
  }
  return kept.join("\n\n");
}

// True when the history already holds a block with this block's header line
// (a retried webhook must not append the same recap twice).
export function hasBlock(prev, block) {
  const head = String(block || "").split("\n")[0];
  return !!head && String(prev || "").split("\n").includes(head);
}

// ---- quote requests (QUOTE_MODE=lead) ----

// Quote request reference "QR-YYMMDD-XXXX" (UTC date). The 4 characters
// skip 0/O/1/I so the reference reads back cleanly by voice.
const REF_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function quoteRequestRef(at = new Date(), randomInt = crypto.randomInt) {
  const p = utcParts(at);
  let tail = "";
  for (let i = 0; i < 4; i++) tail += REF_CHARS[randomInt(REF_CHARS.length)];
  return `QR-${p.y.slice(2)}${p.m}${p.d}-${tail}`;
}

// Recurring vs non-recurring. Catalog names flag one-time charges with
// "(one-time ...)" (activation, setup); "(per hour)" custom development is
// also billed once for the hours worked, so both count toward the one-time
// total — everything else is a monthly per-user/line/agent charge.
export function quoteBilling(name) {
  return /one-time|per hour/i.test(String(name)) ? "one-time" : "monthly";
}

// Iris catalog id -> products-of-interest label.
export function quoteProductLabel(id) {
  if (/^sc_/.test(id)) return "Smart Connect bundles";
  if (id === "cc_recording_ai") return "Conversation capture / Call recording";
  if (/^cc_/.test(id)) return "Contact centre (Cloud Contact)";
  if (id === "pbx_cloud_connect") return "Unified communications / Cloud Connect";
  if (/^pbx_webex_/.test(id)) return "Webex calling (Unite with Webex)";
  if (/^pbx_/.test(id)) return "Cloud calling / Hosted PBX";
  return OTHER_PRODUCT;
}

// 1234.5 -> "$1,234.50"
export function money(n) {
  const [whole, cents] = (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

// The quote-request block sales prices from. items: [{ product, quantity }]
// (already validated against catalog). Returns the lines plus totals and the
// product names / labels for the lead's topic and products of interest.
export function buildQuoteRequest({ items, catalog, existing, company, country, segment, account_path, notes, ref }) {
  // The same product twice is one line with the quantities added.
  const merged = [];
  for (const i of items) {
    const same = merged.find((m) => m.product === i.product);
    if (same) same.quantity += i.quantity;
    else merged.push({ product: i.product, quantity: i.quantity });
  }
  const rows = merged.map((i) => {
    const p = catalog[i.product];
    const unit = Number(p.price) || 0;
    return { id: i.product, name: p.name, quantity: i.quantity, unit, amount: unit * i.quantity, billing: quoteBilling(p.name) };
  });
  const monthly = rows.filter((r) => r.billing === "monthly");
  const oneTime = rows.filter((r) => r.billing === "one-time");
  const monthlyTotal = monthly.reduce((s, r) => s + r.amount, 0);
  const oneTimeTotal = oneTime.reduce((s, r) => s + r.amount, 0);
  const each = (r) => (r.billing === "monthly" ? "/mo" : /per hour/i.test(r.name) ? "/hr" : "");
  const countryText = cleanText(country);
  const pathText = cleanText(account_path);
  const companyText = cleanText(company);
  const notesText = cleanText(notes);

  const lines = [
    "Quote request:",
    ...rows.map((r) => `- ${r.quantity} × ${r.name} — ${money(r.unit)}${each(r)} each = ${money(r.amount)}${r.billing === "monthly" ? "/mo" : " one-time"}`),
    ...(monthly.length ? [`Estimated monthly total: ${money(monthlyTotal)}/mo`] : []),
    ...(oneTime.length ? [`Estimated one-time total: ${money(oneTimeTotal)}`] : []),
    "Catalog list prices in CAD before taxes; sales confirms the final quote.",
    `Customer type: ${existing ? "Existing Iristel customer (existing-customer pricing applies)" : "New customer"}`,
    ...(companyText ? [`Company: ${companyText}`] : []),
    ...(countryText ? [`Country: ${countryText}`] : []),
    ...(segmentLine(segment) ? [segmentLine(segment)] : []),
    ...(pathText ? [`Account path: ${pathText}`] : []),
    ...(notesText ? [`Notes: ${notesText}`] : []),
    `Quote request ref: ${ref}`,
  ];
  return {
    lines, monthlyTotal, oneTimeTotal,
    productNames: [...new Set(rows.map((r) => r.name))],
    productLabels: [...new Set(rows.map((r) => quoteProductLabel(r.id)))],
  };
}

// ---- post-call recap note (ElevenLabs data collection) ----

// data.analysis.data_collection_results[id].value -> trimmed text ("" when empty).
export function dcValue(results, id) {
  const r = results && results[id];
  return cleanText(r && typeof r === "object" ? r.value : undefined);
}

// 200 -> "3 min 20 s"; 45 -> "45 s"; 180 -> "3 min".
export function fmtDuration(secs) {
  const total = Math.round(Number(secs) || 0);
  if (total <= 0) return "";
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (!m) return `${s} s`;
  return s ? `${m} min ${s} s` : `${m} min`;
}

// Bullets normalised to "- ", trailing spaces and repeated blank lines dropped.
export function normalizeRecap(text) {
  return String(text == null ? "" : text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd().replace(/^\s*[*•·–-]\s+/, "- "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The recap text, normalised; "" when empty or the model's "nothing to
// report" wording (then neither the note nor the Form Answers block is written).
export function recapBody(recap) {
  const body = normalizeRecap(recap);
  if (!cleanText(body) || /^no sales (conversation|discussion|activity)\.?$/i.test(body)) return "";
  return body;
}

// "Country: Canada · Segment: Enterprise · Products: SIP trunking", or "".
export function recapFieldsLine({ country, segment, products } = {}) {
  const seg = SEGMENT_LABELS[normalizeSegment(segment)];
  const prod = parseProducts(products);
  const prodText = prod.labels
    .map((l) => (l === OTHER_PRODUCT && prod.unknown.length ? `${l} (${prod.unknown.join(", ")})` : l))
    .join(", ");
  return [
    cleanText(country) ? `Country: ${cleanText(country)}` : "",
    seg ? `Segment: ${seg}` : "",
    prodText ? `Products: ${prodText}` : "",
  ].filter(Boolean).join(" · ");
}

// The sales note: title with date + duration, one fields line, the recap.
// The closing "Conversation: <id>" line makes the note idempotent per
// conversation and lets a customer's contact be found by it. Null when the
// recap is empty (no note).
export function buildRecapNote({ at = new Date(), durationSecs, country, segment, products, recap, conversationId }) {
  const body = recapBody(recap);
  if (!body) return null;
  const dur = fmtDuration(durationSecs);
  const fieldsLine = recapFieldsLine({ country, segment, products });
  const notetext = [
    ...(fieldsLine ? [fieldsLine, ""] : []),
    body,
    ...(conversationId ? ["", `Conversation: ${conversationId}`] : []),
  ].join("\n");
  return {
    subject: `Iris recap — ${fmtDate(at)}${dur ? ` (${dur})` : ""}`,
    notetext: notetext.length > 90000 ? notetext.slice(0, 90000) + "\n[truncated]" : notetext,
  };
}

// The same recap as a Form Answers block, so the lead's AI summary (which
// reads columns, not notes) sees it: a stamped header, the fields line, the
// recap lines. No blank lines (they separate blocks) and no conversation id
// (it lives in cr57d_conversationid). Capped so one long recap can't push the
// whole answers history out of the 4000-character column. Null when the recap
// is empty, exactly when buildRecapNote gives no note.
export const RECAP_BLOCK_MAX = 1500;
export function recapBlock({ at = new Date(), durationSecs, country, segment, products, recap, max = RECAP_BLOCK_MAX }) {
  const body = recapBody(recap);
  if (!body) return null;
  const dur = fmtDuration(durationSecs);
  const fieldsLine = recapFieldsLine({ country, segment, products });
  const lines = [
    `--- ${fmtStamp(at)} · Iris recap${dur ? ` (${dur})` : ""} ---`,
    ...(fieldsLine ? [fieldsLine] : []),
    ...body.split("\n").filter((l) => l.trim()),
  ];
  const all = lines.join("\n");
  if (all.length <= max) return all;
  // Keep whole lines while they fit; a long line that doesn't fit is cut
  // when there's real room left for it.
  const mark = "\n[truncated]";
  let out = lines[0];
  for (const line of lines.slice(1)) {
    const room = max - mark.length - out.length - 1;
    if (line.length <= room) { out += "\n" + line; continue; }
    if (room >= 40) out += "\n" + line.slice(0, room);
    break;
  }
  return out + mark;
}
