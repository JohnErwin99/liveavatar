/* Iristel "Buy phone numbers" — the step app mounted in <div id="iri-ord">.
   Served by the Iris backend (/did/app.js) next to the API it calls (/did/*).

   Each Webflow page holds a native header (eyebrow, H1, lede) and an embed:
     <link rel="stylesheet" href="https://iris-liveavatar.onrender.com/did/app.css">
     <div id="iri-ord" data-step="find" data-api="https://iris-liveavatar.onrender.com/did"></div>
     <script src="https://iris-liveavatar.onrender.com/did/app.js" defer></script>
     <script>window.IriOrder&&IriOrder.init()</script>
   The last line matters with swup: the site loads an external script only once
   per visit, but inline scripts run again on every page swap.

   The browser keeps only the basket token (sessionStorage) and the numbers
   picked before the hold; every price, hold expiry and status comes from the
   server. Nothing here sees an Espresso or IristelX credential. */
(function () {
  "use strict";
  var STEPS = [["find", "Find numbers"], ["account", "Your details"], ["connect", "Connect"], ["review", "Review & pay"]];
  var KEY = "iriOrd";
  var S, mount, cfg, cat, timer, poller;

  // ---------- helpers ----------
  function el(tag, attrs) {
    var e = document.createElement(tag), i, a, k;
    attrs = attrs || {};
    for (k in attrs) {
      a = attrs[k];
      if (a == null || a === false) continue;
      if (k === "class") e.className = a;
      else if (k === "text") e.textContent = a;
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), a);
      else e.setAttribute(k, a === true ? "" : a);
    }
    for (i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(p, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(p, x); }); return; }
    p.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  function money(v) { return "$" + Number(v || 0).toFixed(2); }
  function load() { try { return JSON.parse(sessionStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify({ token: S.token, sel: S.sel, search: S.search })); } catch (e) {} }
  function qs(name) { var m = new RegExp("[?&]" + name + "=([^&]*)").exec(location.search); return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : ""; }
  function url(step) {
    var custom = S.urls && S.urls[step];
    return custom || (S.base + step);
  }
  function go(step, extra) { location.href = url(step) + (extra || ""); }
  function say(msg) { var l = document.getElementById("iri-ord-live"); if (l) { l.textContent = ""; setTimeout(function () { l.textContent = msg; }, 50); } }

  function api(path, opts) {
    opts = opts || {};
    var h = { Accept: "application/json" };
    if (S.token) h["X-Order-Token"] = S.token;
    if (opts.body) h["Content-Type"] = "application/json";
    return fetch(S.api + path, { method: opts.method || (opts.body ? "POST" : "GET"), headers: h,
      body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.message || "Something went wrong. Please try again."); e.status = r.status; e.code = j.code; e.data = j; throw e; }
          return j;
        });
      }, function () {
        var e = new Error("We couldn't reach Iristel. Check your connection and try again."); e.code = "NETWORK"; throw e;
      });
  }

  function callout(kind, title, text, actions) {
    return el("div", { class: "iri-ord-callout" + (kind ? " is-" + kind : ""), role: kind === "error" ? "alert" : null },
      el("div", null, title ? el("strong", { text: title }) : null, text ? el("span", { text: text }) : null, actions || null));
  }

  function field(label, input, opts) {
    opts = opts || {};
    var id = input.id || ("f-" + Math.random().toString(36).slice(2, 8));
    input.id = id;
    var err = el("div", { class: "iri-ord-error", id: id + "-err", "aria-live": "polite" });
    input.setAttribute("aria-describedby", (opts.help ? id + "-help " : "") + id + "-err");
    return el("div", { class: "iri-ord-field" + (opts.cls ? " " + opts.cls : ""), "data-field": opts.name || input.name },
      el("label", { for: id, text: label }), input,
      opts.help ? el("div", { class: "iri-ord-help", id: id + "-help", text: opts.help }) : null, err);
  }
  function input(name, value, attrs) { var a = { type: "text", name: name, value: value || "" }; for (var k in attrs) a[k] = attrs[k]; return el("input", a); }
  function select(name, options, value) {
    var s = el("select", { name: name });
    options.forEach(function (o) { var op = el("option", { value: o[0], text: o[1] }); if (String(o[0]) === String(value || "")) op.selected = true; s.appendChild(op); });
    return s;
  }
  function showErrors(form, errors) {
    form.querySelectorAll(".iri-ord-field").forEach(function (f) { f.classList.remove("is-invalid"); var e = f.querySelector(".iri-ord-error"); if (e) e.textContent = ""; });
    var first = null;
    Object.keys(errors || {}).forEach(function (k) {
      var f = form.querySelector('[data-field="' + k + '"]');
      if (!f) return;
      f.classList.add("is-invalid");
      f.querySelector(".iri-ord-error").textContent = errors[k];
      var i = f.querySelector("input,select,textarea,button");
      if (i) i.setAttribute("aria-invalid", "true");
      if (!first) first = i;
    });
    if (first) first.focus();
  }
  function busy(btn, on, label) {
    if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = ""; add(btn, [el("span", { class: "iri-ord-spinner", "aria-hidden": "true" }), label || "Working…"]); }
    else { btn.disabled = false; btn.textContent = btn.dataset.label || btn.textContent; }
  }

  // ---------- shell ----------
  function stepper(current) {
    var idx = STEPS.map(function (s) { return s[0]; }).indexOf(current);
    return el("ol", { class: "iri-ord-steps", "aria-label": "Order progress" }, STEPS.map(function (s, i) {
      return el("li", { class: i < idx ? "is-done" : i === idx ? "is-current" : "", "aria-current": i === idx ? "step" : null },
        el("span", { class: "n", "aria-hidden": "true", text: i < idx ? "✓" : String(i + 1) }),
        el("span", { class: "t", text: s[1] }), i < idx ? el("span", { class: "sr", text: " (completed)" }) : null);
    }));
  }
  function frame(step, main, summary, opts) {
    opts = opts || {};
    mount.textContent = "";
    var top = el("div", { class: "iri-ord-wrap" },
      step !== "order" ? stepper(step) : null,
      step !== "order" && cfg && cfg.prices && !cfg.prices.approved ? el("p", { style: "margin:-8px 0 18px" }, el("span", { class: "iri-ord-chip", text: "Example pricing in CAD · confirmed before you pay" })) : null,
      el("div", { class: "iri-ord-layout" + (opts.bar ? " has-bar" : "") + (step === "review" ? " is-review" : "") },
        el("div", { class: "iri-ord-main" }, main), summary ? el("aside", { class: "iri-ord-summary", "aria-label": "Order summary" }, summary) : null));
    add(mount, [top, opts.bar || null, el("div", { id: "iri-ord-live", class: "sr", "aria-live": "polite" })]);
  }

  // Summary card: the tray before the hold, the held order after it
  function summary(o, cta) {
    var card = el("div", { class: "iri-ord-card" }), items, lines;
    if (o && o.holdExpiresAt && ["held", "reserving"].indexOf(o.state) >= 0) {
      card.appendChild(el("div", { class: "iri-ord-hold", "data-hold": o.holdExpiresAt },
        el("div", null, el("strong", { text: "Numbers held for you" }), el("br"), "Server-timed hold"),
        el("div", { class: "clock", "aria-hidden": "true", text: "--:--" }), el("span", { class: "sr", "data-hold-sr": "1" })));
    }
    var nums = o ? o.numbers : S.sel;
    card.appendChild(el("h3", { text: "Your numbers" }));
    if (!nums.length) card.appendChild(el("p", { class: "iri-ord-help", style: "margin:8px 0 14px", text: "Select up to " + cfg.maxNumbers + " numbers from the results." }));
    items = el("ul", { class: "iri-ord-items" });
    nums.forEach(function (n) {
      var price = o ? findLine(o, n.did) : n;
      items.appendChild(el("li", null,
        el("div", null, el("b", { text: n.display }), el("br"), el("span", { class: "iri-ord-badge" + (n.category === "vanity" ? " is-vanity" : ""), text: cap(n.category) }),
          o ? null : el("button", { type: "button", class: "iri-ord-link", text: "Remove", "aria-label": "Remove " + n.display, onclick: function () { toggle(n); } })),
        el("div", { style: "text-align:right" }, money(price.setup) + " setup", el("br"), el("span", { class: "iri-ord-help", text: money(price.monthly) + "/month" }))));
    });
    card.appendChild(items);
    if (nums.length) {
      lines = el("div", { class: "iri-ord-lines" });
      if (o && o.quote) {
        add(lines, [el("span", { text: "One-time setup" }), el("span", { text: money(o.quote.setup) }),
          el("span", { text: "First month rental" }), el("span", { text: money(o.quote.firstMonth) }),
          el("span", { class: "muted", text: "Tax (" + Math.round(o.quote.taxRate * 100) + "%, estimated)" }), el("span", { class: "muted", text: money(o.quote.tax) })]);
        card.appendChild(lines);
        card.appendChild(el("div", { class: "iri-ord-total" }, el("span", { text: "Due today" }), el("b", { text: money(o.quote.dueToday) })));
        card.appendChild(el("p", { class: "iri-ord-recurring", text: "Then " + money(o.quote.monthly) + "/month + tax. Month to month, cancel any time." }));
      } else {
        var setup = 0, month = 0;
        S.sel.forEach(function (n) { setup += Number(n.setup); month += Number(n.monthly); });
        add(lines, [el("span", { text: "One-time setup" }), el("span", { text: money(setup) }), el("span", { text: "First month rental" }), el("span", { text: money(month) }),
          el("span", { class: "muted", text: "Taxes" }), el("span", { class: "muted", text: "at review" })]);
        card.appendChild(lines);
        card.appendChild(el("div", { class: "iri-ord-total" }, el("span", { text: "Before tax" }), el("b", { text: money(setup + month) })));
      }
    }
    if (cta) card.appendChild(cta);
    card.appendChild(el("p", { class: "iri-ord-help", style: "margin-top:12px", text: "Inbound voice numbers. Outbound calling, 9-1-1 and texting are separate services." }));
    return card;
  }
  function findLine(o, did) { var l = (o.quote && o.quote.lines || []).filter(function (x) { return x.did === did; })[0]; return l || { setup: 0, monthly: 0 }; }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

  function mobileBar(count, total, label, onclick, disabled) {
    return el("div", { class: "iri-ord-bar" },
      el("div", null, count + (count === 1 ? " number" : " numbers"), el("b", { text: total }), el("span", { "data-bar-clock": "1" })),
      el("button", { type: "button", class: "iri-ord-btn", text: label, onclick: onclick, disabled: disabled || null }));
  }

  // Hold countdown, synced to the server's expiry; re-read when the tab comes back
  function startClock() {
    clearInterval(timer);
    function tick() {
      document.querySelectorAll("[data-hold]").forEach(function (h) {
        var left = Math.max(0, Date.parse(h.getAttribute("data-hold")) - Date.now());
        var m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
        var txt = (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
        h.querySelector(".clock").textContent = txt;
        h.classList.toggle("is-warning", left < 5 * 60000);
        document.querySelectorAll("[data-bar-clock]").forEach(function (b) { b.textContent = " · held " + txt; });
        var sr = h.querySelector("[data-hold-sr]");
        if (sr && (m === 5 || m === 1) && s === 0) say("Your numbers are held for " + m + " more minute" + (m === 1 ? "" : "s") + ".");
        if (!left && !S.expiredShown) { S.expiredShown = true; refresh(); }
      });
    }
    tick();
    timer = setInterval(tick, 1000);
  }
  function refresh() { if (S.token) api("/basket").then(function (j) { S.order = j.order; route(); }).catch(function () {}); }

  function expiredView(step) {
    frame(step, el("div", { class: "iri-ord-card" },
      callout("warning", "Your reservation expired.", " Check availability to continue. We'll try to reserve the same numbers again.",
        el("div", { class: "iri-ord-actions" },
          el("button", { type: "button", class: "iri-ord-btn", text: "Check availability", onclick: function (e) {
            var nums = (S.order && S.order.numbers || []).map(function (n) { return { did: n.did, display: n.display, category: n.category }; });
            hold(nums, e.currentTarget);
          } }),
          el("a", { class: "iri-ord-btn is-secondary", href: url("find"), text: "Choose other numbers" })))));
  }

  // ---------- step 1: find ----------
  function findStep() {
    var s = S.search;
    var provs = [["", "Choose…"]].concat(cat.provinces.map(function (p) { return [p.code, p.name]; }));
    var prov = select("province", provs, s.province);
    var rc = select("ratecenter", [["", "Any"]], s.ratecenter);
    var npa = select("areaCode", [["", "Any"]], s.areaCode);
    function fillRc() {
      var list = cat.rateCentres.filter(function (r) { return !prov.value || r.prov === prov.value; });
      rc.textContent = ""; add(rc, [["", "Any"]].concat(list.map(function (r) { return [r.rc, r.name + (prov.value ? "" : ", " + r.prov)]; })).map(function (o) { var op = el("option", { value: o[0], text: o[1] }); if (o[0] === s.ratecenter) op.selected = true; return op; }));
      fillNpa();
    }
    function fillNpa() {
      var set = {};
      cat.rateCentres.forEach(function (r) { if ((!prov.value || r.prov === prov.value) && (!rc.value || r.rc === rc.value)) r.npas.forEach(function (n) { set[n] = 1; }); });
      npa.textContent = ""; add(npa, [["", "Any"]].concat(Object.keys(set).sort().map(function (n) { return [n, n]; })).map(function (o) { var op = el("option", { value: o[0], text: o[1] }); if (o[0] === s.areaCode) op.selected = true; return op; }));
    }
    prov.addEventListener("change", function () { s.ratecenter = ""; s.areaCode = ""; fillRc(); });
    rc.addEventListener("change", function () { s.areaCode = ""; fillNpa(); });
    fillRc();

    var tabs = el("div", { class: "iri-ord-tabs", role: "group", "aria-label": "Number type" });
    [["all", "All types"], ["basic", "Basic"], ["vanity", "Vanity"]].forEach(function (t) {
      tabs.appendChild(el("button", { type: "button", "aria-pressed": String((s.type || "all") === t[0]), text: t[1], onclick: function () {
        s.type = t[0]; tabs.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", String(b === this)); }, this); search(0);
      } }));
    });
    var digits = input("digits", s.digits || s.word, { placeholder: "e.g. 2255 or FLOWERS", autocomplete: "off", maxlength: "12" });
    var match = select("match", [["contains", "Contains"], ["starts", "Starts with"], ["ends", "Ends with"], ["exact", "Exact"]], s.match);
    var form = el("form", { class: "iri-ord-card", novalidate: true, onsubmit: function (e) { e.preventDefault(); search(0); } },
      el("h2", { text: "Search available numbers" }), el("p", { class: "iri-ord-help", style: "margin:4px 0 16px", text: "Canadian local numbers. Pick a location, then narrow by digits or a word." }),
      tabs,
      el("div", { class: "iri-ord-grid" },
        field("Province or territory", prov, { name: "province" }), field("City or rate centre", rc, { name: "ratecenter" }),
        field("Area code", npa, { name: "areaCode" }), field("Match", match, { name: "match" }),
        field("Digits or a word", digits, { name: "digits", cls: "is-wide", help: "Letters become keypad digits (FLOWERS → 3569377)." }),
        el("div", { class: "iri-ord-field", style: "justify-content:flex-end" }, el("button", { type: "submit", class: "iri-ord-btn is-full", text: "Search" }))));
    var results = el("div", { class: "iri-ord-card", id: "iri-ord-results", "aria-busy": "false" });
    var info = el("div", { class: "iri-ord-card" }, el("h3", { text: "About number types" }),
      el("p", { class: "iri-ord-help", style: "margin-top:8px" }, el("strong", { text: "Basic: " }), "a standard local number. ",
        el("strong", { text: "Vanity: " }), "a number that spells a word or follows a sequence you choose. Every number works for inbound voice calls on Iristel's network."));

    function search(page) {
      var v = digits.value.trim();
      s.province = prov.value; s.ratecenter = rc.value; s.areaCode = npa.value; s.match = match.value;
      s.digits = /[a-z]/i.test(v) ? "" : v; s.word = /[a-z]/i.test(v) ? v : "";
      save();
      if (!s.province && !s.ratecenter && !s.areaCode) { showErrors(form, { province: "Choose a province, a city or an area code." }); return; }
      showErrors(form, {});
      results.setAttribute("aria-busy", "true");
      if (!page) { results.textContent = ""; results.appendChild(el("p", { class: "iri-ord-empty", text: "Searching…" })); }
      api("/search", { body: { province: s.province, ratecenter: s.ratecenter, areaCode: s.areaCode, digits: s.digits, word: s.word, match: s.match, type: s.type || "all", page: page } })
        .then(function (j) { S.results = page ? S.results.concat(j.results) : j.results; S.more = j.more; S.page = page; S.lastMatch = j.match; drawResults(results); say(S.results.length + " numbers found."); })
        .catch(function (e) { results.textContent = ""; if (e.data && e.data.errors) showErrors(form, e.data.errors); results.appendChild(callout(e.code === "INVENTORY_UNAVAILABLE" ? "warning" : "error", e.code === "INVENTORY_UNAVAILABLE" ? "Number search is temporarily unavailable." : "", e.message)); })
        .then(function () { results.setAttribute("aria-busy", "false"); });
    }
    S.searchFn = search;
    var cta = el("button", { type: "button", class: "iri-ord-btn is-full", disabled: !S.sel.length || null,
      text: S.sel.length ? "Continue with " + S.sel.length + (S.sel.length === 1 ? " number" : " numbers") : "Select a number", onclick: function (e) { hold(S.sel, e.currentTarget); } });
    frame("find", [S.notice || null, form, results, info], summary(null, cta),
      { bar: S.sel.length ? mobileBar(S.sel.length, "Before tax", "Continue", function (e) { hold(S.sel, e.currentTarget); }) : null });
    S.notice = null;
    if (S.results) drawResults(results); else if (s.province || s.ratecenter || s.areaCode) search(0);
    else { results.appendChild(el("p", { class: "iri-ord-empty", text: "Choose a location to see available numbers." })); }
  }

  function drawResults(box) {
    box.textContent = "";
    var head = el("div", { style: "display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:12px" },
      el("h2", { text: S.results.length ? S.results.length + (S.more ? "+" : "") + " numbers available" : "Results" }),
      el("span", { class: "iri-ord-help", text: "Prices in CAD, before tax" }));
    box.appendChild(head);
    if (S.lastMatch && S.lastMatch.word) box.appendChild(callout("", "", "Showing numbers that contain " + S.lastMatch.word + " (" + S.lastMatch.pattern + ") on the keypad."));
    if (!S.results.length) {
      box.appendChild(callout("warning", "No matching numbers available.", " Change your filters: try another area code, a nearby city, or fewer digits."));
      return;
    }
    box.appendChild(el("div", { class: "iri-ord-rowhead", "aria-hidden": "true" }, el("span", { text: "Number" }), el("span", { text: "Location" }),
      el("span", { text: "Type" }), el("span", { text: "Setup" }), el("span", { text: "Monthly" }), el("span")));
    var list = el("ul", { class: "iri-ord-results" });
    S.results.forEach(function (n) {
      var picked = S.sel.some(function (x) { return x.did === n.did; });
      var full = !picked && S.sel.length >= cfg.maxNumbers;
      list.appendChild(el("li", { class: "iri-ord-row" },
        el("div", { class: "c-num iri-ord-num" }, n.display, n.category === "vanity" ? el("small", { text: "Vanity pattern" }) : null),
        el("div", { class: "c-loc", text: n.location }),
        el("div", { class: "c-badges" }, el("span", { class: "iri-ord-badge" + (n.category === "vanity" ? " is-vanity" : ""), text: cap(n.category) }), el("span", { class: "iri-ord-badge is-voice", text: "Voice" })),
        el("div", { class: "c-setup iri-ord-price" }, money(n.setup), el("small", { text: "setup" })),
        el("div", { class: "c-monthly iri-ord-price" }, money(n.monthly), el("small", { text: "per month" })),
        el("div", { class: "c-sel" }, el("button", { type: "button", class: "iri-ord-btn is-small" + (picked ? " is-selected" : " is-secondary"),
          "aria-pressed": String(picked), "aria-label": (picked ? "Selected: " : "Select ") + n.display, disabled: full || null,
          text: picked ? "✓ Selected" : "Select", onclick: function () { toggle(n); } }))));
    });
    box.appendChild(list);
    if (S.more) box.appendChild(el("div", { class: "iri-ord-more" }, el("button", { type: "button", class: "iri-ord-btn is-secondary", text: "Show more numbers",
      onclick: function () { if (S.searchFn) S.searchFn(S.page + 1); } })));
  }

  function toggle(n) {
    var i = S.sel.map(function (x) { return x.did; }).indexOf(n.did);
    if (i >= 0) S.sel.splice(i, 1);
    else if (S.sel.length < cfg.maxNumbers) S.sel.push({ did: n.did, display: n.display, category: n.category, rc: n.rc, setup: n.setup, monthly: n.monthly });
    save();
    say(i >= 0 ? n.display + " removed." : n.display + " selected.");
    var y = window.scrollY;
    findStep();
    window.scrollTo(0, y);
  }

  // Reserve the selection, then wait until Espresso confirms the hold
  function hold(nums, btn) {
    if (!nums.length) return;
    busy(btn, true, "Reserving your numbers…");
    api("/hold", { body: { numbers: nums.map(function (n) { return { did: n.did, rc: n.rc || null }; }), token: S.token || undefined } })
      .then(function (j) {
        S.token = j.token; S.order = j.order; save();
        return waitHeld(30);
      })
      .then(function () { S.sel = []; save(); go("account"); })
      .catch(function (e) {
        busy(btn, false);
        if (e.code === "NUMBER_UNAVAILABLE" || e.code === "TAKEN") {
          var gone = (e.data && e.data.taken) || [];
          S.sel = S.sel.filter(function (n) { return gone.indexOf(n.did) < 0; });
          S.results = (S.results || []).filter(function (n) { return gone.indexOf(n.did) < 0; });
          save();
          S.notice = callout("warning", "This number is no longer available.", " " + gone.map(fmt).join(", ") + (gone.length > 1 ? " were" : " was") + " taken. Choose another.");
        } else {
          S.notice = callout("error", "", e.message);
        }
        if (S.step === "find") findStep(); else go("find");
      });
  }
  function fmt(d) { return d.slice(0, 3) + " " + d.slice(3, 6) + " " + d.slice(6); }
  function waitHeld(tries) {
    return api("/basket").then(function (j) {
      S.order = j.order;
      if (j.order.state === "held") return j.order;
      if (j.order.state === "rejected") { var e = new Error(j.order.message); e.code = "NUMBER_UNAVAILABLE"; e.data = { taken: j.order.taken }; throw e; }
      if (tries <= 0) throw new Error("Reserving is taking longer than usual. Please try again.");
      return new Promise(function (r) { setTimeout(r, 2000); }).then(function () { return waitHeld(tries - 1); });
    });
  }

  // ---------- step 2: your details ----------
  function accountStep() {
    var o = S.order, d = o.details || {};
    var seg = d.segment || "business";
    var segBox = el("div", { class: "iri-ord-tabs", role: "radiogroup", "aria-label": "Account type" });
    var company;
    [["business", "Business"], ["residential", "Residential"]].forEach(function (t) {
      segBox.appendChild(el("button", { type: "button", role: "radio", "aria-checked": String(seg === t[0]), text: t[1], onclick: function () {
        seg = t[0]; segBox.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-checked", String(b.textContent === t[1])); });
        company.style.display = seg === "business" ? "" : "none";
      } }));
    });
    var provs = [["", "Choose…"]].concat(cat.provinces.map(function (p) { return [p.code, p.name]; }));
    company = field("Business name", input("company", d.company, { autocomplete: "organization" }), { name: "company", cls: "is-full" });
    company.style.display = seg === "business" ? "" : "none";
    var form = el("form", { class: "iri-ord-card", novalidate: true },
      el("h2", { text: "Who is this order for?" }),
      el("p", { class: "iri-ord-help", style: "margin:4px 0 16px", text: "We use these details to set up your Iristel account and billing. Residential orders don't need a business name." }),
      segBox,
      el("div", { class: "iri-ord-grid is-2" },
        company,
        field("First name", input("firstName", d.firstName, { autocomplete: "given-name" }), { name: "firstName" }),
        field("Last name", input("lastName", d.lastName, { autocomplete: "family-name" }), { name: "lastName" }),
        field("Email", input("email", d.email, { type: "email", autocomplete: "email" }), { name: "email", help: "Your receipt and setup details go here." }),
        field("Phone", input("phone", d.phone, { type: "tel", autocomplete: "tel" }), { name: "phone" }),
        field("Billing address", input("address1", d.address1, { autocomplete: "address-line1" }), { name: "address1", cls: "is-full" }),
        field("City", input("city", d.city, { autocomplete: "address-level2" }), { name: "city" }),
        field("Province or territory", select("province", provs, d.province), { name: "province" }),
        field("Postal code", input("postalCode", d.postalCode, { autocomplete: "postal-code", maxlength: "7" }), { name: "postalCode" })),
      el("div", { class: "iri-ord-actions" },
        el("button", { type: "submit", class: "iri-ord-btn", text: "Continue to setup" }),
        el("a", { class: "iri-ord-link", href: url("find"), text: "Back to numbers" })));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector("[type=submit]"), body = { segment: seg };
      form.querySelectorAll("input,select").forEach(function (i) { if (i.name) body[i.name] = i.value; });
      busy(btn, true, "Saving…");
      api("/details", { body: body }).then(function () { go("connect"); })
        .catch(function (err) { busy(btn, false); if (err.code === "HOLD_EXPIRED") return refresh(); showErrors(form, err.data && err.data.errors); if (!(err.data && err.data.errors)) form.insertBefore(callout("error", "", err.message), form.firstChild); });
    });
    frame("account", form, summary(o), { bar: mobileBar(o.numbers.length, money(o.quote && o.quote.dueToday) + " today", "Continue", function () { form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit")); }) });
    startClock();
  }

  // ---------- step 3: connect ----------
  function connectStep() {
    var o = S.order, c = o.connect || {};
    var type = c.type || "pbx", method = c.method || "static";
    var form = el("form", { class: "iri-ord-card", novalidate: true });
    function choiceGroup(label, opts, value, onpick) {
      var g = el("div", { class: "iri-ord-choices", role: "radiogroup", "aria-label": label });
      opts.forEach(function (op, i) {
        var b = el("button", { type: "button", class: "iri-ord-choice", role: "radio", "aria-checked": String(value === op[0]), tabindex: value === op[0] ? "0" : "-1",
          onclick: function () { onpick(op[0]); },
          onkeydown: function (e) {
            if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].indexOf(e.key) < 0) return;
            e.preventDefault();
            var n = opts[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : opts.length - 1)) % opts.length][0];
            onpick(n);
            var t = g.querySelector('[data-v="' + n + '"]'); if (t) t.focus();
          }, "data-v": op[0] },
          el("span", { class: "dot", "aria-hidden": "true" }), el("div", null, el("strong", { text: op[1] }), el("span", { text: op[2] })));
        g.appendChild(b);
      });
      return g;
    }
    function draw() {
      form.textContent = "";
      add(form, [el("h2", { text: "Destination and connection" }),
        el("p", { class: "iri-ord-help", style: "margin:4px 0 16px", text: "Your numbers arrive on Iristel's network. Tell us where to send the calls; our provisioning team uses these details to connect them." }),
        el("div", { class: "lbl", style: "margin-bottom:8px", text: "Destination" }),
        choiceGroup("Destination", [["pbx", "My own PBX or calling platform", "Delivered over an Iristel SIP connection. No Iristel hosted PBX needed."],
          ["iristel", "An Iristel service", "Use the numbers with a service you already have with us."],
          ["forward", "Forward to another number", "Calls ring a Canadian or US number you choose. Forwarding minutes are billed separately."]],
          type, function (v) { type = v; draw(); })]);
      var box = el("div", { style: "margin-top:20px" });
      if (type === "pbx") {
        add(box, [el("div", { class: "lbl", style: "margin-bottom:8px", text: "SIP connection" }),
          choiceGroup("SIP connection", [["static", "Static IP", "Your platform's public IP or domain. Iristel trusts that address."],
            ["dynamic", "Dynamic registration", "Your PBX registers with Iristel. We send credentials securely after activation."],
            ["managed", "External managed platform", "A hosted platform that supports external SIP (BYOC)."]], method, function (v) { method = v; draw(); })]);
        var g = el("div", { class: "iri-ord-grid is-2", style: "margin-top:16px" });
        if (method !== "managed") g.appendChild(field("PBX or platform", input("platform", c.platform, { placeholder: "e.g. 3CX, FreePBX, Asterisk" }), { name: "platform", cls: "is-full" }));
        if (method === "static") {
          add(g, [field("Public IP address or domain", input("host", c.host, { placeholder: "203.0.113.10 or sip.example.com", autocomplete: "off" }), { name: "host", cls: "is-full" }),
            field("SIP port", input("port", c.port || "5060", { inputmode: "numeric" }), { name: "port" }),
            field("Transport", select("transport", [["udp", "UDP"], ["tcp", "TCP"], ["tls", "TLS"]], c.transport), { name: "transport" }),
            field("Failover address (optional)", input("failover", c.failover), { name: "failover", cls: "is-full" })]);
        }
        if (method === "managed") g.appendChild(field("Platform provider", input("provider", c.provider, { placeholder: "e.g. Microsoft Teams Direct Routing partner" }), { name: "provider", cls: "is-full" }));
        g.appendChild(field("Notes for our team (optional)", el("textarea", { name: "notes", text: c.notes || "" }), { name: "notes", cls: "is-full", help: "Never include passwords. We never ask for your platform's admin password." }));
        box.appendChild(g);
      } else if (type === "forward") {
        add(box, [el("div", { class: "iri-ord-grid is-2" }, field("Forward calls to", input("forwardTo", c.forwardTo, { type: "tel", autocomplete: "tel" }), { name: "forwardTo", help: "A 10-digit Canadian or US number." }))]);
      } else {
        add(box, [el("div", { class: "iri-ord-grid is-2" }, field("Which service? (optional)", el("textarea", { name: "notes", text: c.notes || "", placeholder: "e.g. Cloud Calling account 12345" }), { name: "notes", cls: "is-full" }))]);
      }
      form.appendChild(box);
      form.appendChild(el("div", { class: "iri-ord-card", style: "margin-top:20px;box-shadow:none;background:#f4fafe" },
        el("h3", { text: "What's included" }),
        el("p", { class: "iri-ord-help", style: "margin-top:6px", text: "Inbound voice delivery to your destination. Outbound calling, caller ID, 9-1-1 and texting are separate services and aren't part of this order." })));
      form.appendChild(el("div", { class: "iri-ord-actions" }, el("button", { type: "submit", class: "iri-ord-btn", text: "Review order" }),
        el("a", { class: "iri-ord-link", href: url("account"), text: "Back to your details" })));
    }
    draw();
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector("[type=submit]"), body = { type: type, method: type === "pbx" ? method : "" };
      form.querySelectorAll("input,select,textarea").forEach(function (i) { if (i.name) body[i.name] = i.value; });
      c = body;
      busy(btn, true, "Checking…");
      api("/connect", { body: body }).then(function () { go("review"); })
        .catch(function (err) { busy(btn, false); if (err.code === "HOLD_EXPIRED") return refresh(); showErrors(form, err.data && err.data.errors); if (!(err.data && err.data.errors)) form.insertBefore(callout("error", "", err.message), form.firstChild); });
    });
    frame("connect", form, summary(o), { bar: mobileBar(o.numbers.length, money(o.quote && o.quote.dueToday) + " today", "Continue", function () { form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit")); }) });
    startClock();
  }

  // ---------- step 4: review & pay ----------
  function reviewStep(notice) {
    var o = S.order, q = o.quote, d = o.details || {}, c = o.connect || {};
    var dest = { pbx: "My own PBX or calling platform", iristel: "An Iristel service", forward: "Forward to " + (c.forwardTo ? fmt(c.forwardTo) : "another number") }[c.type] || "";
    var numbers = el("div", { class: "iri-ord-card" },
      el("div", { style: "display:flex;justify-content:space-between;gap:12px" }, el("h2", { text: "Numbers and destination" }), el("a", { class: "iri-ord-link", href: url("connect"), text: "Edit" })),
      el("ul", { class: "iri-ord-status", style: "margin-top:8px" }, o.numbers.map(function (n) {
        return el("li", null, el("div", null, el("b", { class: "iri-ord-num", text: n.display }), el("br"), el("span", { class: "iri-ord-help", text: n.location + " · " + cap(n.category) + " · Voice" })),
          el("span", { class: "iri-ord-help", text: dest }));
      })),
      el("p", { class: "iri-ord-help", style: "margin-top:10px", text: "Order type: Rent (monthly number rental). Billed to " + [d.firstName, d.lastName].join(" ") + (d.company ? ", " + d.company : "") + " · " + d.email }));
    var charges = el("div", { class: "iri-ord-card" }, el("h2", { text: "Charges" }), el("div", { class: "iri-ord-charges", style: "margin-top:12px" },
      el("div", { class: "iri-ord-charge is-primary" }, el("div", { class: "lbl", text: "Due today" }), el("div", { class: "amt", text: money(q.dueToday) }),
        el("p", { text: "Setup " + money(q.setup) + " + first month " + money(q.firstMonth) + " + tax " + money(q.tax) })),
      el("div", { class: "iri-ord-charge" }, el("div", { class: "lbl", text: "Recurring monthly" }), el("div", { class: "amt", text: money(q.monthly) }),
        el("p", { text: "+ applicable tax. Renews monthly until you cancel." })),
      el("div", { class: "iri-ord-charge" }, el("div", { class: "lbl", text: "Usage" }), el("div", { class: "amt", text: "Inbound" }),
        el("p", { text: "Inbound calls to your numbers are included. Forwarding and outbound minutes are billed separately if used." }))));

    var cvv = input("cvv", "", { inputmode: "numeric", autocomplete: "cc-csc", maxlength: "4" });
    var form = el("form", { class: "iri-ord-card", novalidate: true },
      el("h2", { text: "Payment" }),
      el("p", { class: "iri-ord-help", style: "margin:4px 0 16px", text: "Your card is processed by Iristel's payment provider. We don't store your card number or security code." }),
      el("div", { class: "iri-ord-grid is-2" },
        field("Name on card", input("holder", "", { autocomplete: "cc-name" }), { name: "holder", cls: "is-full" }),
        field("Card number", input("number", "", { inputmode: "numeric", autocomplete: "cc-number", maxlength: "23" }), { name: "number", cls: "is-full" }),
        field("Expiry month", select("expMonth", [["", "MM"]].concat(Array.from({ length: 12 }, function (_, i) { var m = String(i + 1).padStart(2, "0"); return [m, m]; })), ""), { name: "expMonth" }),
        field("Expiry year", select("expYear", [["", "YYYY"]].concat(Array.from({ length: 12 }, function (_, i) { var y = String(new Date().getFullYear() + i); return [y, y]; })), ""), { name: "expYear" }),
        field("Security code", cvv, { name: "cvv", help: "3 or 4 digits." })),
      el("div", { "data-field": "consents", class: "iri-ord-field", style: "margin-top:16px;gap:10px" },
        el("label", { class: "iri-ord-check" }, el("input", { type: "checkbox", name: "terms" }),
          el("span", null, "I accept the ", el("a", { href: "/terms-and-privacy", target: "_blank", rel: "noopener", text: "service terms" }), " and understand these numbers deliver inbound voice only; 9-1-1 and outbound calling are separate.")),
        el("label", { class: "iri-ord-check" }, el("input", { type: "checkbox", name: "recurring" }),
          el("span", { text: "I authorize Iristel to charge this card " + money(q.monthly) + " + tax every month until I cancel." })),
        el("div", { class: "iri-ord-error" })),
      el("div", { class: "iri-ord-actions" }, el("button", { type: "submit", class: "iri-ord-btn", text: "Pay " + money(q.dueToday) + " and activate" }),
        el("span", { class: "iri-ord-help", text: q.approved ? "" : "Example pricing for testing. You will see the final price before paying." })));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector("[type=submit]"), f = function (n) { var i = form.querySelector('[name="' + n + '"]'); return i ? (i.type === "checkbox" ? i.checked : i.value) : ""; };
      var body = { amount: q.dueToday, quoteVersion: q.version, consents: { terms: f("terms"), recurring: f("recurring") },
        card: { holder: f("holder"), number: f("number"), expMonth: f("expMonth"), expYear: f("expYear"), cvv: f("cvv") } };
      if (!body.consents.terms || !body.consents.recurring) return showErrors(form, { consents: "Accept both to place the order." });
      busy(btn, true, "Processing payment…");
      api("/pay", { body: body })
        .then(function (j) { S.order = j.order; save(); go("order", "?ref=" + encodeURIComponent(j.order.ref) + "&t=" + encodeURIComponent(S.token)); })
        .catch(function (err) {
          cvv.value = "";
          if (err.code === "PRICE_CHANGED" && err.data && err.data.order) { S.order = err.data.order; return reviewStep(callout("warning", "The price changed.", " Review the new total before you pay.")); }
          if (err.code === "HOLD_EXPIRED") return refresh();
          busy(btn, false);
          if (err.code === "PAYMENT_UNKNOWN" || err.code === "PAYMENT_PENDING") {
            btn.disabled = true;
            form.insertBefore(callout("warning", "We are checking your payment. Do not pay again.", " Reference " + ((err.data && err.data.reference) || "") + ". Call 1 833 IRISTEL (474 7835) if this page doesn't update."), form.firstChild);
            return;
          }
          if (err.data && err.data.errors) return showErrors(form, err.data.errors);
          form.insertBefore(callout("error", err.code === "DECLINED" ? "Payment was not approved." : "", err.code === "DECLINED" ? " Try another card." : err.message), form.firstChild);
          form.querySelector(".iri-ord-callout").scrollIntoView({ block: "center" });
        });
    });
    frame("review", [notice || null, numbers, charges, form], summary(o));
    startClock();
  }

  // ---------- step 5: order status ----------
  function orderStep() {
    var o = S.order;
    var active = o.state === "active";
    var head = active ? callout("success", o.numbers.length > 1 ? "Your numbers are active." : "Your number is active.", " Order " + o.ref + ". A receipt is on its way to " + (o.details && o.details.email) + ".")
      : o.state === "delayed" ? callout("warning", "Your order is processing.", " " + (o.message || "We'll email you as soon as your numbers are active. There's no need to pay again."))
      : o.state === "payment_unknown" ? callout("warning", "We are checking your payment.", " Do not pay again. Reference " + (o.payment && o.payment.reference || "") + ".")
      : ["completing", "paying"].indexOf(o.state) >= 0 ? callout("", "Activating your numbers…", " This usually takes under a minute. You can close this page; we'll email you.")
      : o.state === "expired" || o.state === "cancelled" ? callout("warning", "This order wasn't completed.", " No payment was taken.")
      : callout("", "Order " + o.ref, "");
    var status = el("div", { class: "iri-ord-card" }, el("h2", { text: "Your numbers" }), el("ul", { class: "iri-ord-status", style: "margin-top:8px" },
      o.numbers.map(function (n) {
        var st = active ? ["is-active", "Active"] : o.state === "delayed" ? ["is-pending", "Activation pending"] : ["is-pending", "Activating"];
        return el("li", null, el("div", null, el("b", { class: "iri-ord-num", text: n.display }), el("br"), el("span", { class: "iri-ord-help", text: n.location + " · " + cap(n.category) + " · Voice · Rented" })),
          el("span", { class: "iri-ord-badge " + st[0], text: st[1] }));
      })));
    var p = o.payment || {}, q = o.quote || {};
    var receipt = el("div", { class: "iri-ord-card" }, el("h3", { text: "Receipt" }), el("div", { class: "iri-ord-lines", style: "border-top:0" },
      el("span", { text: "Order" }), el("span", { text: o.ref }),
      el("span", { text: "Paid" }), el("span", { text: p.outcome === "success" ? money(p.amount) + " CAD" : "—" }),
      el("span", { text: "Card" }), el("span", { text: p.masked || "—" }),
      el("span", { text: "Payment reference" }), el("span", { text: p.reference || "—" }),
      el("span", { text: "Next bill" }), el("span", { text: o.nextBill ? o.nextBill + " · " + money(q.monthly) + " + tax" : "—" })),
      el("button", { type: "button", class: "iri-ord-btn is-secondary is-full", text: "Print receipt", onclick: function () { window.print(); } }));
    var next = el("div", { class: "iri-ord-card" }, el("h2", { text: "Next steps" }), el("div", { class: "iri-ord-next", style: "margin-top:12px" },
      el("div", null, el("h3", { text: "Test an inbound call" }), el("p", { class: "iri-ord-help", text: "Once active, call one of your numbers from a mobile phone and check it reaches your destination." })),
      el("div", null, el("h3", { text: "Connection details" }), el("p", { class: "iri-ord-help", text: "Our provisioning team emails your SIP connection details. We never send passwords by email." })),
      el("div", null, el("h3", { text: "Need help?" }), el("p", { class: "iri-ord-help" }, "Call 1 833 IRISTEL (474 7835), Monday to Friday, 9 AM to 5 PM ET, with order ", el("strong", { text: o.ref }), "."))),
      el("div", { class: "iri-ord-actions" }, el("a", { class: "iri-ord-btn", href: url("find"), text: "Buy more numbers", onclick: function () { S.token = null; S.sel = []; save(); } })));
    frame("order", [head, status, next], receipt);
    clearTimeout(poller);
    if (["completing", "paying"].indexOf(o.state) >= 0) poller = setTimeout(function () { api("/order").then(function (j) { S.order = j.order; if (S.step === "order") orderStep(); if (j.order.state === "active") say("Your numbers are active."); }).catch(function () {}); }, 4000);
  }

  // ---------- routing ----------
  function route() {
    var o = S.order;
    if (S.step === "find") return findStep();
    if (S.step === "order") return o ? orderStep() : frame("order", callout("warning", "We couldn't find this order.", " Use the link in your confirmation email."));
    if (!o || ["cancelled", "rejected"].indexOf(o.state) >= 0) return go("find");
    if (["paying", "completing", "active", "delayed", "payment_unknown"].indexOf(o.state) >= 0) return go("order", "?ref=" + encodeURIComponent(o.ref) + "&t=" + encodeURIComponent(S.token));
    if (o.state === "expired") return expiredView(S.step);
    if (o.state === "reserving") return waitHeld(15).then(route, function () { go("find"); });
    if (S.step === "connect" && !o.details) return go("account");
    if (S.step === "review" && !o.connect) return go(o.details ? "connect" : "account");
    return ({ account: accountStep, connect: connectStep, review: reviewStep })[S.step]();
  }

  function init() {
    mount = document.getElementById("iri-ord");
    if (!mount || mount.getAttribute("data-ready")) return;
    mount.setAttribute("data-ready", "1");
    mount.className = "iri-ord";
    var st = load();
    S = { api: (mount.getAttribute("data-api") || "").replace(/\/+$/, ""), step: mount.getAttribute("data-step") || "find",
      base: mount.getAttribute("data-base") || "/phone-numbers/", urls: null,
      token: st.token || null, sel: st.sel || [], search: st.search || { province: "ON", type: "all", match: "contains" }, results: null };
    try { S.urls = JSON.parse(mount.getAttribute("data-urls") || "null"); } catch (e) {}
    if (qs("t")) { S.token = qs("t"); save(); }
    // Steps after the search are per-visitor pages: keep them out of search results
    if (S.step !== "find" && !document.querySelector('meta[name="robots"][content*="noindex"]')) {
      document.head.appendChild(el("meta", { name: "robots", content: "noindex, nofollow" }));
    }
    mount.textContent = "";
    mount.appendChild(el("div", { class: "iri-ord-wrap" }, el("p", { class: "iri-ord-empty", text: "Loading…" })));
    Promise.all([api("/config"), api("/catalog")]).then(function (r) {
      cfg = r[0]; cat = r[1];
      if (!cfg.enabled && S.step !== "order") {
        frame(S.step, callout("warning", "Online ordering is temporarily unavailable.", " Call 1 833 IRISTEL (474 7835) and our team will set up your numbers."));
        return;
      }
      if (S.step === "find" || !S.token) return route();
      return api(S.step === "order" ? "/order" : "/basket").then(function (j) { S.order = j.order; route(); },
        function (e) { if (S.step === "order") { S.order = null; return route(); } S.token = null; save(); go("find"); });
    }).catch(function (e) { frame(S.step, callout("error", "We couldn't load the order form.", " " + e.message)); });
  }

  document.addEventListener("visibilitychange", function () { if (!document.hidden && S && S.token && ["account", "connect", "review"].indexOf(S.step) >= 0) refresh(); });
  document.addEventListener("swup:page:view", init);
  window.IriOrder = { init: init };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
