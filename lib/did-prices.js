// Prices for the self-serve "Buy phone numbers" flow (/did/* routes).
//
// The browser never computes a total: every amount it shows comes from
// quote() here, and /did/pay charges exactly the quote stored on the order.
// Amounts are kept in integer cents so 13% tax on $39.00 is $5.07, not
// $5.069999.
//
// Basic matches OnlineOrdering's live per-DID rental ($2.00/month, EXLNP_SBDID).
// Vanity repeats the BRD's illustrative example and is NOT approved by
// Finance — `approved: false` makes the pages show "Example pricing".
// Override everything with DID_PRICES_JSON (same shape as DEFAULT_PRICES).

export const DEFAULT_PRICES = {
  version: "2026-10-21-example",
  currency: "CAD",
  approved: false,
  taxRate: 0.13, // flat, as OnlineOrdering; the production tax engine replaces this
  categories: {
    basic: { label: "Basic", setup: 0, monthly: 2.0 },
    vanity: { label: "Vanity", setup: 49.0, monthly: 4.0 },
  },
};

export function loadPrices(env = process.env) {
  if (!env.DID_PRICES_JSON) return DEFAULT_PRICES;
  try {
    const p = JSON.parse(env.DID_PRICES_JSON);
    if (!p || !p.categories || !p.categories.basic) throw new Error("categories.basic missing");
    return { ...DEFAULT_PRICES, ...p };
  } catch (e) {
    console.error("[did] DID_PRICES_JSON is invalid, using defaults:", e.message);
    return DEFAULT_PRICES;
  }
}

const cents = (dollars) => Math.round(Number(dollars) * 100);
export const money = (c) => (c / 100).toFixed(2);

// lines: [{ did, category }] → per-line prices and the totals the review page shows.
// Due today = every setup fee + the first month of rental + tax on both.
export function quote(lines, prices = loadPrices()) {
  const out = [];
  let setup = 0, monthly = 0;
  for (const l of lines) {
    const cat = prices.categories[l.category] || prices.categories.basic;
    const s = cents(cat.setup), m = cents(cat.monthly);
    setup += s;
    monthly += m;
    out.push({ did: l.did, category: prices.categories[l.category] ? l.category : "basic", setup: money(s), monthly: money(m) });
  }
  const subtotal = setup + monthly;
  const tax = Math.round(subtotal * prices.taxRate);
  return {
    version: prices.version,
    currency: prices.currency,
    approved: !!prices.approved,
    taxRate: prices.taxRate,
    lines: out,
    setup: money(setup),
    firstMonth: money(monthly),
    subtotal: money(subtotal),
    tax: money(tax),
    dueToday: money(subtotal + tax),
    dueTodayCents: subtotal + tax,
    monthly: money(monthly),
    monthlyTax: money(Math.round(monthly * prices.taxRate)),
  };
}

// What the search results show next to each number.
export function priceFor(category, prices = loadPrices()) {
  const cat = prices.categories[category] || prices.categories.basic;
  return { setup: money(cents(cat.setup)), monthly: money(cents(cat.monthly)) };
}
