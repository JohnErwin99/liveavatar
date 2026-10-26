/* Sample data for the "Buy phone numbers" step app (public/did/app.js) while
   the backend for these parts doesn't exist yet: MyIristel sign-in, saved
   connections and cards, Canada Post address search, Rent/Purchase
   eligibility, connection tests and the Customer Care handoff.

   Loaded only in demo mode. Every value is fictitious (BRD v1.4 example
   account "Sweet Crumb Bakery") and the app marks it EXAMPLE. Nothing here
   calls a network: sign-in accepts any email and password and keeps neither.
   Saved cards are the demo test cards (4242 approves, 0002 declines). */
(function () {
  "use strict";
  function later(v, ms) { return new Promise(function (ok) { setTimeout(function () { ok(v); }, ms || 500); }); }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }

  var ACCOUNT = {
    id: "EX-2041", name: "Sweet Crumb Bakery", initials: "SC", userInitials: "JA", type: "business", masked: "•••• 2041",
    contact: { firstName: "Jamie", lastName: "Avery", email: "", phone: "4165550199" },
    address: { street: "100 Example Street, Unit 2", city: "Toronto", province: "ON", postalCode: "M5V 0A1" },
    connections: [
      { id: "bakery-pbx", label: "Bakery PBX", method: "ip", host: "sip.example-bakery.ca", port: "5060", transport: "tls", platform: "3CX",
        lastTest: "2026-10-12T15:00:00Z", reachable: true }
    ],
    cards: [
      { id: "visa4242", brand: "Visa", last4: "4242", exp: "08/28", expMonth: "08", expYear: "2028", number: "4242424242424242", isDefault: true },
      { id: "visa0002", brand: "Visa", last4: "0002", exp: "02/27", expMonth: "02", expYear: "2027", number: "4000000000000002", note: "decline" }
    ]
  };

  var ADDRESSES = [
    { street: "100 Example Street, Unit 2", city: "Toronto", province: "ON", postalCode: "M5V 0A1" },
    { street: "250 Sample Avenue", city: "Toronto", province: "ON", postalCode: "M4W 1A8" },
    { street: "45 Example Lane", city: "Mississauga", province: "ON", postalCode: "L5B 3C2" },
    { street: "18 Demo Crescent", city: "Ottawa", province: "ON", postalCode: "K1P 5G4" },
    { street: "77 rue Exemple", city: "Montréal", province: "QC", postalCode: "H2X 1Y4" },
    { street: "300 Example Road SW", city: "Calgary", province: "AB", postalCode: "T2P 1J9" },
    { street: "1200 Sample Way", city: "Vancouver", province: "BC", postalCode: "V6B 1A1" },
    { street: "9 Placeholder Drive", city: "Halifax", province: "NS", postalCode: "B3J 1T5" }
  ];
  function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }

  window.IriOrdPreview = {
    // MyIristel sign-in stand-in: any email signs in to the example account
    signIn: function (email) {
      var a = copy(ACCOUNT);
      a.contact.email = String(email || "").trim().toLowerCase();
      return later(a, 700);
    },
    // Canada Post AddressComplete stand-in: matches the typed words against sample addresses
    findAddress: function (q) {
      var words = norm(q).split(" ").filter(Boolean);
      if (!words.length || norm(q).length < 2) return later([], 50);
      var hits = ADDRESSES.filter(function (a) {
        var hay = norm([a.street, a.city, a.province, a.postalCode].join(" "));
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      });
      return later(copy(hits.slice(0, 5)), 150);
    },
    // Espresso allowed_modes stand-in (decision D6): per number, with a customer-safe reason key
    eligibility: function (numbers, purchaseEnabled) {
      return numbers.map(function (n) {
        var vanity = n.cat === "vanity" || n.cat === "speciality" || n.category === "vanity";
        return { did: n.did, display: n.display, rent: true, purchase: false, example: true,
          reasonKey: vanity ? "plan.reason.tierRent" : purchaseEnabled ? "plan.reason.noPrice" : "plan.reason.notOnline" };
      });
    },
    testConnection: function () { return later({ ok: true, at: new Date().toISOString() }, 900); },
    handoff: function () { return later({ ref: "CS-EX-" + String(Math.floor(1000 + Math.random() * 9000)) }, 700); }
  };
})();
