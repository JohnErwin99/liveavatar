// IristelX card payments — save a card (tokenize) and charge it. Ported from
// the partner portal's api-marketplace/lib/billing.js (server-side card save)
// and OnlineOrdering's chargeBalance + review page (the charge body that is
// proven to capture on the card). Stateless: the caller records the
// reference BEFORE charging and keeps the outcome.
//
//   Save a card  PATCH {base}/billing/{account}/credit-card
//                header iristelx-api-key: MIND_API_KEY (MIND_RESELL_KEY for
//                accounts in the reseller business unit — a key can't see
//                accounts outside its unit, 404)
//                body {CVV, cardType, expMonth "MM", expYear "YYYY", holder, number}
//                -> { token }
//   Charge it    POST  {base}/bot/{account}/payment
//                header x-api-key: PAYMENT_API_KEY
//
// Card data rule: the card number and CVV pass through to MIND over TLS and
// are never stored, logged, or put in an error. Only the token, masked
// number, card type, expiry and holder are returned for the caller to keep.
const DEFAULT_BASE = "https://api.iristelx.com";
const baseUrl = () => String(process.env.IRISTELX_API_URL || DEFAULT_BASE).trim().replace(/\/+$/, "");
const digitsOf = (s) => String(s ?? "").replace(/\D/g, "");

// ---- card helpers ----
export function luhnOk(number) {
  const num = digitsOf(number);
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = +num[num.length - 1 - i];
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return num.length >= 12 && sum % 10 === 0;
}

// 'visa' | 'mastercard' | 'amex' | 'discover' | null
export function cardType(number) {
  const num = digitsOf(number);
  if (/^4/.test(num)) return "visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(num)) return "mastercard";
  if (/^3[47]/.test(num)) return "amex";
  if (/^(6011|65|64[4-9])/.test(num)) return "discover";
  return null;
}

// First 6 + ****** + last 4 — exactly as OnlineOrdering sends it
export function maskCard(number) {
  const num = digitsOf(number);
  return num.slice(0, 6) + "******" + num.slice(-4);
}

// Normalised copy: MM month, YYYY year, digits-only number and CVV
function normalizeCard({ number, expMonth, expYear, cvv, holder } = {}) {
  const year = String(expYear ?? "").trim();
  return {
    number: digitsOf(number),
    expMonth: String(expMonth ?? "").trim().padStart(2, "0"),
    expYear: /^\d{2}$/.test(year) ? "20" + year : year,
    cvv: digitsOf(cvv),
    holder: String(holder ?? "").trim().slice(0, 80),
  };
}

// → { ok, errors: { field: message } } — messages are safe to show the
// customer and never echo the card data.
export function validateCard(card) {
  const c = normalizeCard(card);
  const errors = {};
  if (!c.holder) errors.holder = "Enter the name on the card.";
  if (!luhnOk(c.number) || !cardType(c.number)) errors.number = "That card number isn't valid.";
  const monthOk = /^(0[1-9]|1[0-2])$/.test(c.expMonth);
  const yearOk = /^\d{4}$/.test(c.expYear);
  if (!monthOk) errors.expMonth = "Check the expiry month.";
  if (!yearOk) errors.expYear = "Check the expiry year.";
  if (monthOk && yearOk) {
    const now = new Date();
    const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
    if (+c.expYear < y) errors.expYear = "This card has expired.";
    else if (+c.expYear === y && +c.expMonth < m) errors.expMonth = "This card has expired.";
  }
  if (!/^\d{3,4}$/.test(c.cvv)) errors.cvv = "Check the security code (CVV).";
  return { ok: Object.keys(errors).length === 0, errors };
}

// One call with one auth header, as OnlineOrdering sends them. Redirects are
// not followed: a payment POST must never be re-sent somewhere else.
async function ixCall(method, path, { header, key }, body, timeout = 45000) {
  const r = await fetch(baseUrl() + path, {
    method, redirect: "manual", signal: AbortSignal.timeout(timeout),
    headers: { [header]: key, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* gateway HTML, not JSON */ }
  return { status: r.status, ok: r.ok, json, text };
}

// What MIND answered, for logs — never our request body. Scrubbed of the
// card number and CVV in case MIND ever echoes them back.
function scrub(text, card) {
  let s = String(text || "");
  const number = card && digitsOf(card.number);
  const cvv = card && digitsOf(card.cvv);
  if (number && number.length >= 12) s = s.split(number).join("[card]");
  if (cvv) s = s.replace(new RegExp(`(^|\\D)${cvv}(?=\\D|$)`, "g"), "$1[cvv]");
  return s;
}
function mindReply(r, card) {
  return scrub(`HTTP ${r.status} ${String(r.text || "").replace(/\s+/g, " ").slice(0, 300)}`, card);
}

// MIND keys only see accounts in their own business unit. Try the main key
// first, then the reseller key when the main one can't see the account.
const MIND_KEYS = ["MIND_API_KEY", "MIND_RESELL_KEY"];

// Tokenizes a card on the MIND account → { token, cardType, masked,
// expMonth, expYear, holder }. cardType is upper case (VISA, MASTERCARD …):
// it is what the charge sends as creditCard.code. Throws (err.status 400
// invalid, 402 not accepted, 502 no answer, 503 not configured); errors
// never carry the card number or CVV.
export async function saveCard(accountId, card) {
  if (!accountId) throw new TypeError("saveCard: accountId is required");
  const c = normalizeCard(card);
  const check = validateCard(c);
  if (!check.ok) {
    throw Object.assign(new Error(Object.values(check.errors)[0]), { status: 400, code: "CARD_INVALID", errors: check.errors });
  }
  const names = MIND_KEYS.filter(n => process.env[n]);
  if (!names.length) throw Object.assign(new Error("Billing is not configured (MIND_API_KEY)."), { status: 503, code: "NOT_CONFIGURED" });
  const type = cardType(c.number);
  const path = `/billing/${encodeURIComponent(accountId)}/credit-card`;
  const body = { CVV: c.cvv, cardType: type, expMonth: c.expMonth, expYear: c.expYear, holder: c.holder, number: c.number };
  let r, keyName;
  for (const name of names) {
    try {
      r = await ixCall("PATCH", path, { header: "iristelx-api-key", key: process.env[name] }, body);
    } catch {
      // The fetch error is dropped on purpose: nothing of the card goes in a log or an error
      console.warn("[pay] save card: MIND unreachable for account", accountId);
      throw Object.assign(new Error("The billing system didn't respond. Try again shortly."), { status: 502, code: "MIND_UNREACHABLE" });
    }
    keyName = name;
    if (![401, 403, 404].includes(r.status)) break;
  }
  const token = r.json && (r.json.token || (r.json.data && r.json.data.token));
  if (!r.ok || !token) {
    const detail = `MIND ${accountId} (${keyName}): ${mindReply(r, c)}`;
    console.warn("[pay] save card not accepted —", detail);
    throw Object.assign(new Error("The card was not accepted. Check the details or try another card."),
      { status: 402, code: "CARD_DECLINED", mindStatus: r.status, detail });
  }
  return { token: String(token), cardType: type.toUpperCase(), masked: maskCard(c.number), expMonth: c.expMonth, expYear: c.expYear, holder: c.holder };
}

// Charges a saved card. Resolves — never rejects — for a decline or an
// unclear answer:
//   { outcome: 'success',  reference, amount, gateway }  JSON + 2xx
//   { outcome: 'declined', reference, message, detail }  JSON + 4xx: the
//        charge definitely did not happen, a retry is fine
//   { outcome: 'unknown',  reference, detail }  no answer, not JSON, 3xx/5xx:
//        the card MAY have been charged — never retry automatically; staff
//        confirm in MIND first
// Throws only before anything is sent (bad arguments, PAYMENT_API_KEY unset).
// card = { token, cardType, masked, expMonth, expYear, holder, cvv? }
export async function charge({ accountId, amount, reference, remark, card } = {}) {
  if (!accountId) throw new TypeError("charge: accountId is required");
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new TypeError("charge: amount must be a positive number");
  if (!reference) throw new TypeError("charge: reference is required — record it before charging");
  if (!card || !card.token) throw new TypeError("charge: card.token is required");
  const key = process.env.PAYMENT_API_KEY || "";
  if (!key) throw Object.assign(new Error("PAYMENT_API_KEY is not configured"), { status: 503, code: "NOT_CONFIGURED" });

  const amountText = value.toFixed(2);
  // MIND's UPDATED payment body — the first shape confirmed to actually
  // capture on the card. creditCard is the full object the review page sends
  // (code, masked number, token, expDate, holder, securityCode); adapterId is
  // numeric 3 (Moneris), issuer is 'SBI' exactly as in the proven test, and
  // our reference rides in externalRefId. securityCode only when we have the
  // CVV: a stored card is charged without it.
  const creditCard = {
    code: String(card.cardType || "").toUpperCase(),
    number: card.masked || "",
    token: card.token,
    expDate: { expMonth: card.expMonth || "", expYear: card.expYear || "" },
    holder: card.holder || "",
    ...(card.cvv ? { securityCode: String(card.cvv) } : {}),
    adapterId: 3, issuer: "SBI", externalRefId: String(reference),
  };
  const body = { amount: amountText, currency: "CAD", remark: remark || "Online phone numbers", creditCard };

  let r;
  try {
    r = await ixCall("POST", `/bot/${encodeURIComponent(accountId)}/payment`, { header: "x-api-key", key }, body);
  } catch (e) {
    const detail = `no answer: ${e && e.name === "TimeoutError" ? "payment gateway timeout" : (e && e.message) || "network error"}`;
    console.error("[pay] charge", reference, "UNKNOWN —", detail);
    return { outcome: "unknown", reference: String(reference), detail };
  }

  // A gateway error says nothing about whether the charge ran upstream
  if (r.json && r.status >= 200 && r.status < 300) {
    console.log("[pay] charge", reference, "success", accountId, amountText);
    return { outcome: "success", reference: String(reference), amount: amountText, gateway: r.json };
  }
  if (r.json && r.status >= 400 && r.status < 500) {
    // Gateway reasons ("Purchase Transaction rejected: Invalid Route
    // Service") are for ops, not customers — kept in detail, with a generic
    // message the customer can act on
    const reasons = Array.isArray(r.json.errors) ? r.json.errors.map(e => e && e.message).filter(Boolean).join(" ") : "";
    const detail = scrub([r.json.message || `HTTP ${r.status}`, reasons].filter(Boolean).join(" — "), card);
    console.warn("[pay] charge", reference, "declined", accountId, amountText, "—", detail);
    return {
      outcome: "declined", reference: String(reference),
      message: "Payment could not be completed. Please verify your card details and try again, or use a different card.",
      detail,
    };
  }
  const detail = scrub(`HTTP ${r.status}${r.json ? "" : " (not JSON)"}: ${String(r.text || "").replace(/\s+/g, " ").slice(0, 200)}`, card);
  console.error("[pay] charge", reference, "UNKNOWN —", detail);
  return { outcome: "unknown", reference: String(reference), detail };
}
