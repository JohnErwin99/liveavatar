/* Iristel "Buy phone numbers" — the step app mounted in <div id="iri-ord">.
   Served by the Iris backend (/did/app.js) next to the API it calls (/did/*).

   Each Webflow page holds an embed:
     <link rel="stylesheet" href="https://iris-liveavatar.onrender.com/did/app.css">
     <div id="iri-ord" data-step="find" data-api="https://iris-liveavatar.onrender.com/did"></div>
     <script src="https://iris-liveavatar.onrender.com/did/app.js" defer></script>
     <script>window.IriOrder&&IriOrder.init()</script>
   The last line matters with swup: the site loads an external script only once
   per visit, but inline scripts run again on every page swap.

   Journey (BRD v1.4, 24 Oct 2026): Find a number → MyIristel → Connect (with
   the 9-1-1 address sub-step) → Review and pay → Activate. English and French.

   This pass is the UI only. Everything the /did API already does (search,
   hold, details, connect, pay, order status) runs through it; the pieces with
   no backend yet (MyIristel sign-in, address search, 9-1-1 confirmations,
   saved cards, connection tests, activation checks) run on the sample data in
   preview.js, in demo mode only, marked EXAMPLE. Outside demo the checkout
   stays closed until /did/config reports 9-1-1 support (BRD: no payment
   without a confirmed 9-1-1 address).

   The browser keeps only the basket token, the picks before the hold and the
   UI choices that have no backend yet (sessionStorage); every price, hold
   expiry and status comes from the server. Nothing here sees an Espresso or
   IristelX credential. */
(function () {
  "use strict";
  var STEPS = ["find", "account", "connect", "review", "order"];
  var KEY = "iriOrd";
  // Calling and 9-1-1 rates from BRD decision D8 (provided by Iristel 24 Oct 2026, CAD before tax)
  var RATES = { version: "D8-2026-10-24", ca: 0.025, us: 0.035, e911: 5 };
  var TERMS_VERSION = "ToS-3a-2026-10-24";
  var TERMS_URL = "/terms-and-privacy";
  var MYIRISTEL = "https://my.iristel.com";
  var PLATFORMS = ["3CX", "FreePBX", "Asterisk", "Yeastar", "Grandstream UCM", "Cisco CUBE", "Avaya IP Office", "Mitel", "Microsoft Teams (Direct Routing)"];
  var S, mount, cfg, cat, timer, poller, P, loaded = {};

  // ---------- text ----------
  function dict(lang) { var d = window.IriOrdI18n || {}; return d[lang] || {}; }
  function t(k, v) {
    var s = dict(S && S.lang)[k];
    if (s == null) s = dict("en")[k];
    if (s == null) return k;
    return String(s).replace(/\{(\w+)\}/g, function (_, n) { return v && v[n] != null ? v[n] : ""; });
  }
  function tn(k, n, v) {
    v = v || {}; v.n = n;
    var one = S.lang === "fr" ? n <= 1 : n === 1;
    return t(k + (one ? "_one" : "_other"), v);
  }
  function has(k) { return dict(S.lang)[k] != null || dict("en")[k] != null; }
  function locale() { return S.lang === "fr" ? "fr-CA" : "en-CA"; }
  function money(v, digits) {
    digits = digits || 2;
    try { return new Intl.NumberFormat(locale(), { style: "currency", currency: "CAD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(v || 0)); }
    catch (e) { return "$" + Number(v || 0).toFixed(digits); }
  }
  function day(d) {
    // A bare YYYY-MM-DD (the server's next bill date) is a calendar day, not UTC midnight
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(d))) { var p = String(d).split("-"); d = new Date(+p[0], p[1] - 1, +p[2]); }
    try { return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", year: "numeric" }).format(new Date(d)); }
    catch (e) { return String(d).slice(0, 10); }
  }
  function clock(d) {
    try { return new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit" }).format(new Date(d)); }
    catch (e) { return String(d).slice(11, 19); }
  }
  function pct(r) { return Math.round(Number(r || 0) * 100) + " %".replace(" ", S.lang === "fr" ? " " : ""); }
  function errText(e) { return e && e.code && has("err." + e.code) ? t("err." + e.code) : (e && e.message) || t("err.generic"); }

  // ---------- DOM helpers ----------
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
  var ICONS = {
    sparkle: '<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5"/>',
    cloud: '<path d="M7 18a4 4 0 0 1-.5-8 6 6 0 0 1 11.5 2 3 3 0 0 1 0 6z"/>',
    fwd: '<path d="M4 6v5a4 4 0 0 0 4 4h12M16 11l4 4-4 4"/>',
    headset: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1"/><rect x="17" y="14" width="4" height="6" rx="1"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    send: '<path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    print: '<path d="M7 9V3h10v6M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="7" y="14" width="10" height="7"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>'
  };
  function ic(n, cls) {
    var s = el("span", { class: "iri-ic" + (cls ? " " + cls : ""), "aria-hidden": "true" });
    s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">' + (ICONS[n] || "") + "</svg>";
    return s;
  }
  function example() { return S.demo ? el("span", { class: "iri-ord-ex", text: t("ex") }) : null; }
  function chip(text, cls) { return el("span", { class: "iri-ord-chip" + (cls ? " " + cls : "") }, text); }
  // Phones show each table row as a stack of "label  value" lines; the labels come from the column headers
  function stacked(tbl) {
    var heads = Array.prototype.map.call(tbl.querySelectorAll("thead th"), function (h) { return h.textContent; });
    Array.prototype.forEach.call(tbl.querySelectorAll("tbody tr"), function (tr) {
      Array.prototype.forEach.call(tr.children, function (cell, i) { if (cell.tagName === "TD") cell.setAttribute("data-label", heads[i] || ""); });
    });
    tbl.classList.add("is-stack");
    return tbl;
  }

  // ---------- state ----------
  function load() { try { return JSON.parse(sessionStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save() {
    // UI-only data per basket: keep the three most recent baskets
    var keys = Object.keys(S.ui || {});
    if (keys.length > 3) keys.slice(0, keys.length - 3).forEach(function (k) { delete S.ui[k]; });
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ token: S.token, sel: S.sel, search: S.search, demo: S.demo || undefined,
        lang: S.lang, mode: S.mode, acct: S.acct || undefined, ui: S.ui, hideAi: S.hideAi || undefined, pending: S.pendingIris || undefined }));
    } catch (e) {}
  }
  function refOf(tok) { return tok ? String(tok).split(".")[0] : ""; }
  function ui() { var r = refOf(S.token) || "_"; S.ui = S.ui || {}; return (S.ui[r] = S.ui[r] || {}); }
  function qs(name) { var m = new RegExp("[?&]" + name + "=([^&]*)").exec(location.search); return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : ""; }
  function url(step) { return (S.urls && S.urls[step]) || (S.base + step); }
  // swup keeps the page (and a live Iris call) instead of a full reload
  function go(step, extra) {
    var u = url(step) + (extra || "");
    var sw = window.swup;
    if (sw && typeof sw.navigate === "function") { try { sw.navigate(u); return; } catch (e) {} }
    location.href = u;
  }
  function say(msg) { var l = document.getElementById("iri-ord-live"); if (l) { l.textContent = ""; setTimeout(function () { l.textContent = msg; }, 50); } }
  function rerender() { if (S.render) S.render(); }

  function api(path, opts) {
    opts = opts || {};
    var h = { Accept: "application/json" };
    if (S.token) h["X-Order-Token"] = S.token;
    if (opts.body) h["Content-Type"] = "application/json";
    return fetch(S.api + path, { method: opts.method || (opts.body ? "POST" : "GET"), headers: h,
      body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) {
            var e = new Error(j.message || t("err.generic")); e.status = r.status; e.code = j.code; e.data = j;
            // Every step handles an expired hold the same way: re-read the basket and show "check availability"
            if (j.code === "HOLD_EXPIRED" && path !== "/basket") { e.handled = true; refresh(); }
            throw e;
          }
          return j;
        });
      }, function () {
        var e = new Error(t("err.NETWORK")); e.code = "NETWORK"; throw e;
      });
  }
  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise(function (ok, fail) {
      var s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = function () { ok(); };
      s.onerror = function () { delete loaded[src]; fail(new Error("load " + src)); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  // ---------- form helpers ----------
  function callout(kind, title, text, actions, icon) {
    return el("div", { class: "iri-ord-callout" + (kind ? " is-" + kind : ""), role: kind === "error" ? "alert" : null },
      ic(icon || (kind === "success" ? "check" : kind === "warning" || kind === "error" ? "warn" : "info")),
      el("div", null, title ? el("strong", { text: title }) : null, text ? el("span", null, text) : null, actions || null));
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
    form.querySelectorAll(".iri-ord-field").forEach(function (f) {
      f.classList.remove("is-invalid"); var e = f.querySelector(".iri-ord-error"); if (e) e.textContent = "";
      var i = f.querySelector("[aria-invalid]"); if (i) i.removeAttribute("aria-invalid");
    });
    var first = null;
    Object.keys(errors || {}).forEach(function (k) {
      var f = form.querySelector('[data-field="' + k + '"]');
      if (!f) return;
      f.classList.add("is-invalid");
      f.querySelector(".iri-ord-error").textContent = has("fe." + k) && /^[A-Z]/.test(errors[k]) && S.lang === "fr" ? t("fe." + k) : errors[k];
      var i = f.querySelector("input,select,textarea,button");
      if (i) i.setAttribute("aria-invalid", "true");
    });
    first = form.querySelector('[aria-invalid="true"]'); // first on screen, not first in the server's list
    if (first) first.focus();
  }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.html = btn.innerHTML; btn.disabled = true; btn.textContent = ""; add(btn, [el("span", { class: "iri-ord-spinner", "aria-hidden": "true" }), label || t("busy")]); }
    else { btn.disabled = false; if (btn.dataset.html != null) btn.innerHTML = btn.dataset.html; }
  }
  // Radio cards with arrow-key movement (WAI-ARIA radio group)
  function radioGroup(label, items, value, onpick, cls) {
    var g = el("div", { class: "iri-ord-radios" + (cls ? " " + cls : ""), role: "radiogroup", "aria-label": label });
    var enabled = items.filter(function (i) { return !i.disabled; });
    items.forEach(function (it) {
      var on = it.v === value;
      g.appendChild(el("div", { class: "iri-ord-radio" + (on ? " is-on" : "") + (it.disabled ? " is-off" : ""), role: "radio", "data-v": it.v,
        "aria-checked": String(on), "aria-disabled": it.disabled ? "true" : null,
        tabindex: on || (!value && it === enabled[0]) ? "0" : "-1",
        onclick: function (e) { if (e.target.closest("a,button,input,select,textarea")) return; if (!it.disabled) onpick(it.v); },
        onkeydown: function (e) {
          if (e.key === " " || e.key === "Enter") { if (e.target !== e.currentTarget) return; e.preventDefault(); if (!it.disabled) onpick(it.v); return; }
          if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].indexOf(e.key) < 0 || e.target !== e.currentTarget) return;
          e.preventDefault();
          var i = enabled.indexOf(it), n = enabled[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : enabled.length - 1)) % enabled.length];
          if (!n) return;
          onpick(n.v);
          var t2 = mount.querySelector('[role=radiogroup][aria-label="' + label.replace(/"/g, '\\"') + '"] [data-v="' + n.v + '"]'); if (t2) t2.focus();
        } },
        el("span", { class: "dot", "aria-hidden": "true" }), el("div", { class: "body" }, it.content)));
    });
    return g;
  }
  function toggleSwitch(label, on, onchange, id) {
    var b = el("button", { type: "button", role: "switch", class: "iri-ord-switch", "aria-checked": String(!!on), id: id || null,
      onclick: function () { onchange(!on); } }, el("span", { class: "knob", "aria-hidden": "true" }));
    return el("div", { class: "iri-ord-switchrow" }, b, el("span", { class: "lbl", onclick: function () { onchange(!on); } }, label));
  }
  function checkbox(name, checked, label, onchange) {
    return el("label", { class: "iri-ord-check" }, el("input", { type: "checkbox", name: name, checked: !!checked || null,
      onchange: function (e) { onchange(e.target.checked); } }), el("span", null, label));
  }

  // ---------- numbers: keypad, categories, reasons ----------
  var KEYPAD = { a: 2, b: 2, c: 2, d: 3, e: 3, f: 3, g: 4, h: 4, i: 4, j: 5, k: 5, l: 5, m: 6, n: 6, o: 6, p: 7, q: 7, r: 7, s: 7, t: 8, u: 8, v: 8, w: 9, x: 9, y: 9, z: 9 };
  function keypad(w) { return String(w || "").toLowerCase().split("").map(function (c) { return /\d/.test(c) ? c : KEYPAD[c] || ""; }).join(""); }
  function fmt(d) { return d.slice(0, 3) + " " + d.slice(3, 6) + " " + d.slice(6); }
  // Speciality: repeats or sequences in the last four digits (product rule placeholder, same as the demo inventory)
  function specialRule(did) {
    var e = String(did).slice(-4);
    if (/^(\d)\1\1\1$/.test(e)) return "repeat";
    if (/^(\d)(\d)\1\2$/.test(e) || /^(\d)\1(\d)\2$/.test(e)) return "pairs";
    if (/^[1-9]000$/.test(e)) return "round";
    if ("0123456789".indexOf(e) >= 0 || "9876543210".indexOf(e) >= 0) return "sequence";
    return "";
  }
  function catOf(n) {
    // The category follows the price tier the server quoted; a word match is its own badge
    if (n.cat) return n.cat;
    if (n.category === "vanity" && specialRule(n.did)) return "speciality";
    return n.category === "vanity" ? "vanity" : "basic";
  }
  function cityOf(n) { var l = String(n.location || ""); return /^area code/i.test(l) ? "" : l.split(",")[0]; }
  function provOf(n) { var p = String(n.location || "").split(","); return p.length > 1 ? p[p.length - 1].trim() : ""; }
  // Where the searched word sits on the keypad, for the spelled form and the exact/partial label
  function matchFor(n, word, partialOf) {
    if (!word) return null;
    var k = keypad(word), at = n.did.lastIndexOf(k);
    if (at < 0) return null;
    return { word: word.toUpperCase(), full: (partialOf || word).toUpperCase(), at: at, exact: !partialOf };
  }
  function spellEl(n) {
    var m = n.match;
    if (!m) return null;
    var d = n.did.split(""), i, out = [];
    for (i = 0; i < 10; i++) {
      // 416-555-CAKE, but never a dash inside the word (416-2CAKE94)
      if ((i === 3 || i === 6) && !(i > m.at && i < m.at + m.word.length)) out.push("-");
      out.push(i >= m.at && i < m.at + m.word.length ? m.word[i - m.at] : d[i]);
    }
    var rest = m.full.slice(m.word.length);
    return el("div", { class: "iri-ord-spell", "aria-label": t("res.spells", { w: m.full }) }, out.join(""), rest ? el("span", { class: "miss", text: rest }) : null);
  }
  function reasonOf(n) {
    var m = n.match, c = catOf(n), city = cityOf(n);
    if (m && m.exact) return t("why.exact", { w: m.word });
    if (m) return t("why.partial", { w: m.word, full: m.full });
    if (c === "speciality") return t("why.special." + specialRule(n.did));
    if (c === "vanity") return t("why.vanity");
    return city ? t("why.basicCity", { city: city }) : t("why.basic");
  }
  function catLabel(c) { return t("cat." + c); }
  function badge(kind, text) { return el("span", { class: "iri-ord-badge is-" + kind, text: text || t("badge." + kind) }); }

  // ---------- shell ----------
  function stepBar(cur) {
    var idx = STEPS.indexOf(cur);
    var list = el("ol", { class: "iri-ord-steps", "aria-label": t("steps.label") }, STEPS.map(function (s, i) {
      var done = i < idx, now = i === idx;
      var label = t("step." + s) + (now && s === "connect" && S.sub === "e911" ? " · " + t("step.e911") : "");
      return el("li", { class: done ? "is-done" : now ? "is-current" : "", "aria-current": now ? "step" : null },
        el("span", { class: "n", "aria-hidden": "true" }, done ? ic("check") : String(i + 1)),
        el("span", { class: "t" }, label, s === "account" && S.acct && done ? el("small", { class: "tag", text: t("step.signedIn") }) : null),
        done ? el("span", { class: "sr", text: t("steps.done") }) : null);
    }));
    var mob = el("div", { class: "iri-ord-steps-m" },
      el("span", { text: t("steps.mobile", { i: idx + 1, n: STEPS.length, name: t("step." + cur) }) }),
      el("span", { class: "bar", "aria-hidden": "true" }, el("span", { style: "width:" + Math.round((idx + 1) / STEPS.length * 100) + "%" })));
    return el("div", { class: "iri-ord-top" }, el("div", { class: "iri-ord-top-in" }, list, mob, barRight(cur)));
  }
  function barRight(cur) {
    var o = S.order, held = o && ["held", "reserving"].indexOf(o.state) >= 0 && o.holdExpiresAt && cur !== "order";
    var r = el("div", { class: "iri-ord-top-r" });
    if (cur === "find" && !held && !S.sel.length) r.appendChild(el("span", { class: "iri-ord-top-note", text: t("bar.browse") }));
    if (cur === "review" && S.acct && S.demo && S.acct.cards && S.acct.cards.length) r.appendChild(chip(t("bar.fast"), "is-ok is-fast"));
    if (cur !== "order" && (held || S.sel.length || cur !== "find")) r.appendChild(chip(cur === "find" ? t("bar.mode." + S.mode) : t("mode." + S.mode), "is-mode"));
    if (held) r.appendChild(el("span", { class: "iri-ord-chip is-hold", "data-hold": o.holdExpiresAt, "data-long": cur === "find" ? "1" : null },
      ic("clock"), el("span", { class: "txt", text: "--:--" })));
    if (cur === "order" && o) r.appendChild(el("span", { class: "iri-ord-top-note" }, t("bar.order", { ref: o.ref }), " ", example()));
    var lang = el("div", { class: "iri-ord-lang", role: "group", "aria-label": t("lang.label") });
    [["en", "EN", "English"], ["fr", "FR", "Français"]].forEach(function (l) {
      lang.appendChild(el("button", { type: "button", "aria-pressed": String(S.lang === l[0]), lang: l[0], "aria-label": l[2], text: l[1],
        onclick: function () { if (S.lang === l[0]) return; S.lang = l[0]; save(); rerender(); say(t("lang.changed")); var b = mount.querySelector('.iri-ord-lang [lang="' + l[0] + '"]'); if (b) b.focus(); } }));
    });
    r.appendChild(lang);
    if (S.acct) r.appendChild(el("span", { class: "iri-ord-acct" }, el("span", { class: "av", "aria-hidden": "true", text: S.acct.userInitials }),
      el("span", { class: "nm", text: t("bar.acct", { name: S.acct.name }) })));
    return r;
  }
  function demoBanner() {
    var b = el("div", { class: "iri-ord-demo", role: "status" }, el("strong", { text: t("demo.title") }), " ", t("demo.text"));
    return b;
  }
  // main: content of the main column. opts.rail (default true), opts.bar (mobile bar), opts.focus, opts.wide
  // The /phone-numbers hero is Webflow text (English). In French, swap in the FR copy;
  // back in English, restore whatever Webflow had.
  function heroLang() {
    var hero = document.querySelector(".iri-ord-hero");
    if (!hero) return;
    hero.setAttribute("lang", S.lang);
    [["iri-ord-eyebrow", "hero.eyebrow"], ["iri-ord-h1", "hero.h1"], ["iri-ord-lede", "hero.lede"]].forEach(function (x) {
      var e = hero.querySelector("." + x[0]);
      if (!e || e.children.length) return;
      if (e.getAttribute("data-en") === null) e.setAttribute("data-en", e.textContent);
      var en = e.getAttribute("data-en"), mark = (en.match(/^[^\w\s]+\s*/) || [""])[0];
      e.textContent = S.lang === "fr" ? mark + t(x[1]) : en;
    });
  }
  // A re-render replaces the DOM; find the same control again so keyboard focus doesn't fall back to <body>
  function focusKey() {
    var e = document.activeElement;
    if (!e || e === document.body || !mount.contains(e)) return null;
    if (e.id) return { sel: "#" + e.id, i: 0 };
    if (e.name) return { sel: e.tagName.toLowerCase() + '[name="' + e.name + '"]' + (e.type === "radio" || e.type === "checkbox" ? '[value="' + e.value + '"]' : ""), i: 0 };
    var sel = e.tagName.toLowerCase() + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).join(".") : "");
    return { sel: sel, i: Array.prototype.indexOf.call(mount.querySelectorAll(sel), e) };
  }
  function refocus(k) {
    if (!k) return;
    var all; try { all = mount.querySelectorAll(k.sel); } catch (e) { return; }
    var e = all[Math.min(k.i, all.length - 1)];
    if (e) { try { e.focus({ preventScroll: true }); } catch (x) { e.focus(); } }
  }
  // The site's own menu (.nav-wrapper) is sticky on desktop; keep the sticky Iris column below it
  function navOffset() {
    var n = document.querySelector(".nav-wrapper"), h = 0;
    try { if (n && /sticky|fixed/.test(getComputedStyle(n).position)) h = Math.round(n.getBoundingClientRect().height); } catch (e) {}
    mount.style.setProperty("--iri-ord-navh", h + "px");
  }
  function frame(step, main, opts) {
    opts = opts || {};
    var keep = focusKey();
    navOffset();
    mount.textContent = "";
    mount.setAttribute("lang", S.lang);
    heroLang();
    var rail = opts.rail === false ? null : irisRail(step);
    var irisOn = S.irisNote ? callout("success", "", t("iris.onTap"),
      el("div", { class: "iri-ord-actions is-tight" }, el("button", { type: "button", class: "iri-ord-btn is-iris is-small", "data-iris-on": "1", onclick: openIris }, ic("sparkle"), t("iris.ask"))), "sparkle") : null;
    var body = el("div", { class: "iri-ord-wrap" },
      S.demo ? demoBanner() : null,
      el("div", { class: "iri-ord-layout" + (rail ? " has-rail" : "") + (opts.bar ? " has-bar" : "") + (opts.cls ? " " + opts.cls : "") },
        el("div", { class: "iri-ord-main" }, irisOn, main), rail));
    if (opts.bar) S.barStep = step; else S.basketOpen = false;
    add(mount, [opts.bare ? null : stepBar(step), body, opts.bar || null, irisSheet(), el("div", { id: "iri-ord-live", class: "sr", "aria-live": "polite" }),
      opts.bar && S.basketOpen ? basketSheet(step) : null]);
    if (step !== "find") document.title = t("title." + (step === "connect" && S.sub === "e911" ? "e911" : step)) + " · Iristel";
    var onBtn = S.irisNote && !S.irisNoteShown && mount.querySelector("[data-iris-on]");
    if (onBtn) { S.irisNoteShown = true; onBtn.scrollIntoView({ block: "center" }); onBtn.focus({ preventScroll: true }); }
    else if (opts.focus) {
      var h = mount.querySelector(".iri-ord-main h1, .iri-ord-main h2");
      if (h) { h.setAttribute("tabindex", "-1"); try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); } }
    } else refocus(keep);
    barSpace();
    startClock();
    emitContext();
  }
  // The site's Iris dock sits above the phone bottom bar (app.css); the bar's height varies with wrapping and safe areas
  function barSpace() {
    var bar = mount && mount.querySelector(".iri-ord-mbar"), h = bar ? bar.offsetHeight : 0, root = document.documentElement;
    root.style.setProperty("--iri-ord-mbar-h", h + "px");
    root.classList.toggle("iri-ord-bar", h > 0);
    if (window.ResizeObserver) {
      barSpace.ro = barSpace.ro || new ResizeObserver(function () { barSpace(); });
      if (barSpace.ro.el !== bar) { barSpace.ro.disconnect(); barSpace.ro.el = bar; if (bar) barSpace.ro.observe(bar); }
    }
  }
  function head(title, lede, extra) {
    return el("div", { class: "iri-ord-head" }, el("h1", null, title, extra || null), lede ? el("p", { class: "lede", text: lede }) : null);
  }
  function mobileBar(top, total, label, onclick) {
    return el("div", { class: "iri-ord-mbar" + (S.basketOpen ? " is-open" : "") },
      el("button", { type: "button", class: "iri-ord-mbar-sum", "aria-expanded": String(!!S.basketOpen), "aria-controls": "iri-ord-basket",
        onclick: function () { toggleBasket(!S.basketOpen); } },
        el("small", null, top, el("span", { "data-bar-clock": "1" })), el("b", { text: total }),
        el("span", { class: "more" }, t("mbar.edit"), ic("chev"))),
      // Continue closes "Your numbers" first, so the step's own messages and focus are never hidden behind it
      el("button", { type: "button", class: "iri-ord-btn is-light", onclick: function (e) { if (S.basketOpen) toggleBasket(false); onclick(e); } }, label, ic("chev")));
  }

  // ---------- "Your numbers": opens from the phone bar (and the desktop tray) to remove or add numbers (BRD UX05, FR03) ----------
  // Opening and closing never re-render the step, so nothing typed into its form is lost.
  function toggleBasket(open) {
    var cur = mount.querySelector(".iri-ord-basket-wrap"), bar = mount.querySelector(".iri-ord-mbar"), sum = bar && bar.querySelector(".iri-ord-mbar-sum");
    S.basketOpen = !!open;
    if (!open) S.basketErr = null;
    if (cur) cur.parentNode.removeChild(cur);
    var sh = open ? basketSheet(S.barStep) : null;
    if (sh) mount.appendChild(sh);
    if (bar) bar.classList.toggle("is-open", !!sh);
    if (sum) sum.setAttribute("aria-expanded", String(!!sh));
    focusFirst(sh ? ["#iri-ord-basket-h"] : [".iri-ord-mbar-sum", ".iri-ord-tray-edit"]);
  }
  // Focus the first of these that is on screen (headings get tabindex=-1)
  function focusFirst(sels) {
    for (var i = 0; i < sels.length; i++) {
      var f = mount.querySelector(sels[i]);
      if (!f || f.offsetParent === null) continue;
      if (f.tagName === "H2" && !f.hasAttribute("tabindex")) f.setAttribute("tabindex", "-1");
      try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); }
      return f;
    }
    return null;
  }
  function heldNow(o) { return !!o && ["held", "reserving"].indexOf(o.state) >= 0; }
  // A held number comes out through the server, which reprices, releases it and keeps the other inputs.
  // The basket keeps at least one number (removing the last one would cancel it).
  function serverRemovable(did) {
    var o = S.order;
    return heldNow(o) && !S.paying && o.numbers.length > 1 && o.numbers.some(function (x) { return x.did === did; });
  }
  function basketSheet(step) {
    var o = S.order, later = step !== "find";
    var list = later ? (o && o.numbers || []).map(metaOf) : S.sel;
    if (!list.length) { S.basketOpen = false; return null; }
    var setup = 0, month = 0;
    list.forEach(function (n) { var l = later ? lineOf(n.did) : n; setup += Number(l.setup || 0); month += Number(l.monthly || 0); });
    var q = later && o.quote, fixed = 0;
    var line = function (k, v) { return [el("dt", { text: k }), el("dd", { text: v })]; };
    var rows = el("ul", { class: "iri-ord-lines-n" }, list.map(function (n) {
      var l = later ? lineOf(n.did) : n;
      // Step 1 changes the selection; a number held for this basket comes out through the server when it can
      var held = heldNow(o) && o.numbers.some(function (x) { return x.did === n.did; });
      var via = serverRemovable(n.did) ? "server" : later ? null : "local";
      if (!via) fixed++;
      return el("li", null,
        el("div", null, el("b", { class: "iri-ord-num is-sm", text: n.display }), el("small", { text: [catLabel(catOf(n)), cityOf(n)].filter(Boolean).join(" · ") })),
        el("div", { class: "r" }, el("span", { text: t("res.setupAmt", { amt: money(l.setup) }) }), el("small", { text: t("tray.perMonth", { amt: money(l.monthly) }) }),
          via ? el("button", { type: "button", class: "iri-ord-link is-rm", "data-rm": n.did, "aria-label": t("chips.remove", { label: n.display }),
            onclick: function (e) { removeNum(n, e.currentTarget, via === "server" && held); } }, t("basket.remove")) : null));
    }));
    var more = later || list.length < cfg.maxNumbers;
    var help = !later ? (more ? t("basket.max", { max: cfg.maxNumbers }) : t("basket.full", { max: cfg.maxNumbers }))
      : list.length === 1 ? t("basket.only") : fixed ? t("basket.someFixed") : t("basket.laterNote");
    var sheet = el("div", { id: "iri-ord-basket", class: "iri-ord-basket", role: "dialog", "aria-modal": "true", "aria-labelledby": "iri-ord-basket-h" },
      el("div", { class: "iri-ord-basket-h" },
        el("h2", { id: "iri-ord-basket-h", tabindex: "-1", text: tn("basket.title", list.length) }),
        el("button", { type: "button", class: "iri-ord-icon", "aria-label": t("basket.close"), title: t("basket.close"), onclick: function () { toggleBasket(false); } }, ic("x"))),
      el("p", { id: "iri-ord-basket-live", class: "sr", role: "status" }),
      S.basketErr ? callout("error", "", S.basketErr) : null,
      rows,
      el("dl", { class: "iri-ord-dl" }, q ? line(t("rev.due"), money(q.dueToday)) : null,
        line(t("tray.setup"), money(q ? q.setup : setup)), line(t("tray.monthly"), t("tray.perMonth", { amt: money(q ? q.monthly : month) }))),
      el("p", { class: "iri-ord-help", text: help }),
      el("div", { class: "iri-ord-actions" },
        more ? el("button", { type: "button", class: "iri-ord-btn is-secondary", onclick: function () { addMore(later); } }, ic("plus"), t(later ? "basket.change" : "basket.add")) : null,
        el("button", { type: "button", class: "iri-ord-btn", onclick: function () { toggleBasket(false); } }, t("basket.done"))));
    return el("div", { class: "iri-ord-basket-wrap" }, el("div", { class: "iri-ord-basket-bg", "aria-hidden": "true", onclick: function () { toggleBasket(false); } }), sheet);
  }
  // While "Your numbers" is open: Escape closes it and Tab stays inside it, wherever focus is
  document.addEventListener("keydown", function (e) {
    var sheet = S && S.basketOpen && mount && mount.querySelector("#iri-ord-basket");
    if (!sheet) return;
    if (e.key === "Escape") { e.preventDefault(); toggleBasket(false); return; }
    if (e.key !== "Tab") return;
    var f = Array.prototype.filter.call(sheet.querySelectorAll("button:not([disabled]), [href]"), function (x) { return x.offsetParent !== null; });
    if (!f.length) return;
    var a = document.activeElement, first = f[0], last = f[f.length - 1], inside = sheet.contains(a) && a !== sheet.querySelector("h2");
    if (e.shiftKey && (!inside || a === first)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (!sheet.contains(a) || a === last)) { e.preventDefault(); first.focus(); }
  });
  function addMore(later) {
    if (later) return go("find");
    toggleBasket(false);
    // The results are where numbers are added; with none on screen, the search box
    var to = focusFirst([".iri-ord-reshead h2", ".iri-ord-search .q"]);
    if (to) to.scrollIntoView({ block: "start" });
  }
  // Remove one number: from the selection on step 1, or from the held basket through the server (repriced; the other
  // inputs stay). Used by "Your numbers" and by the review step's number list.
  function removeNum(n, btn, viaServer) {
    if (S.paying || S.removing) return;
    var ownFocus = null;
    var at = Array.prototype.map.call(mount.querySelectorAll("[data-rm]"), function (b) { return b.getAttribute("data-rm"); }).indexOf(n.did);
    var done = function () {
      var y = window.scrollY;
      rerender();
      window.scrollTo(0, y);
      // Focus moves only while the panel is still open or when it was lost in the re-render (not if the customer has moved on)
      var a = document.activeElement, left = mount.querySelectorAll("[data-rm]"), f = left[Math.min(at, left.length - 1)];
      if (S.basketOpen || !a || a === document.body || (ownFocus && a.id === ownFocus.id)) {
        if (f) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
        else focusFirst(["#iri-ord-basket-h", "#iri-ord-yn-h", ".iri-ord-mbar-sum", ".iri-ord-tray-edit", ".iri-ord-reshead h2", ".iri-ord-main h1", ".iri-ord-search .q"]);
      }
      // After the re-render, so the message lands in the live region that is on the page (inside the open panel if there is one)
      var count = S.view === "find" ? S.sel.length : (S.order && S.order.numbers.length) || 0;
      var msg = t("res.removed", { n: n.display }) + (count ? " " + tn("tray.count", count) + "." : "");
      var live = mount.querySelector("#iri-ord-basket-live");
      if (live) setTimeout(function () { live.textContent = msg; }, 50); else say(msg);
    };
    S.basketErr = null;
    if (!viaServer) {
      S.sel = S.sel.filter(function (x) { return x.did !== n.did; });
      save();
      return done();
    }
    // One removal at a time; focus moves off the button before it's disabled, so Escape and Tab keep working
    S.removing = true;
    ownFocus = focusFirst(["#iri-ord-basket-h", "#iri-ord-yn-h"]);
    mount.querySelectorAll("[data-rm]").forEach(function (b) { b.disabled = true; });
    busy(btn, true, t("basket.removing"));
    api("/basket/remove", { body: { did: n.did } }).then(function (j) {
      S.removing = false;
      S.order = j.order;
      if (!heldNow(S.order)) return route();
      S.sel = S.view === "find" ? S.sel.filter(function (x) { return x.did !== n.did; }) : S.order.numbers.map(function (x) { return metaOf(x); });
      save();
      if (S.view === "review") S.notice = callout("success", "", t("basket.revRemoved", { n: n.display, amt: money(S.order.quote.dueToday) }));
      done();
    }).catch(function (e) {
      S.removing = false;
      if (e.handled) return;
      busy(btn, false);
      mount.querySelectorAll("[data-rm]").forEach(function (b) { b.disabled = false; });
      if (S.basketOpen) { S.basketErr = errText(e); return toggleBasket(true); }
      S.notice = callout("error", "", errText(e));
      rerender();
    });
  }

  // ---------- Iris rail (live Iris lives in the site's dock; this column carries her context and cards) ----------
  function irisRail(step) {
    if (S.hideAi) {
      return el("aside", { class: "iri-ord-rail is-min", "aria-label": t("iris.label") },
        el("button", { type: "button", class: "iri-ord-btn is-iris is-small", onclick: function () { S.hideAi = false; save(); rerender(); } }, ic("sparkle"), t("iris.show")));
    }
    var v = step === "connect" && S.sub === "e911" ? "e911" : step;
    return el("aside", { class: "iri-ord-rail", "aria-label": t("iris.label") },
      el("div", { class: "iri-ord-rail-h" }, el("span", { class: "iri-ord-av", "aria-hidden": "true" }, ic("sparkle")),
        el("div", null, el("strong", { text: "Iris" }), el("small", { text: t("iris.sub", { what: t("iris.purpose." + v) }) })),
        el("button", { type: "button", class: "iri-ord-icon", "aria-label": t("iris.hide"), title: t("iris.hide"),
          onclick: function () { S.hideAi = true; save(); rerender(); } }, ic("x"))),
      el("div", { class: "iri-ord-rail-b", role: "log", "aria-live": "polite", "aria-relevant": "additions" },
        el("p", { class: "iri-ord-ctx" }, ic("info"), t("iris.context", { ctx: contextLine(v) })),
        S.irisDown ? callout("", "", t("iris.unavailable")) : el("div", { class: "iri-ord-msg", text: t("iris.intro") }),
        railExtras(v),
        S.cards.map(cardEl)),
      el("div", { class: "iri-ord-rail-f" },
        el("button", { type: "button", class: "iri-ord-btn is-iris is-full", onclick: openIris }, ic("sparkle"), t("iris.ask")),
        el("p", { class: "iri-ord-disc", text: t("iris.footer") })));
  }
  // Mobile: a pending Iris card shows as a labelled bottom sheet above the bar
  function irisSheet() {
    if (!S.cards.length || S.hideAi) return null;
    var c = S.cards[S.cards.length - 1];
    return el("div", { class: "iri-ord-sheet", role: "region", "aria-label": t("iris.label") }, cardEl(c));
  }
  function contextLine(v) {
    var o = S.order, u = S.token ? ui() : {};
    if (v === "find") return [t("ctx.search"), t("mode." + S.mode), locLabel(S.search.filters)].filter(Boolean).join(" · ");
    if (v === "account") return t("ctx.plan") + (o ? " · " + t("ctx.quote", { ref: o.ref }) : "");
    if (v === "connect") return t("ctx.connect") + (u.conn ? " · " + t("path.short." + u.conn.path) : "");
    if (v === "e911") return t("ctx.e911");
    if (v === "review") return t("ctx.quote", { ref: o ? o.ref : "" }) + " · " + t("ctx.readonly");
    return t("ctx.order", { ref: o ? o.ref : "", state: o ? t("ostate." + o.state) : "" });
  }
  function railExtras(v) {
    var o = S.order;
    if (v === "review" && o && o.quote) {
      var q = o.quote, box = el("div", { class: "iri-ord-qq" });
      var qs2 = [["today", t("qq.today", { amt: money(q.dueToday) })], ["next", t("qq.next")], ["not", t("qq.not")]];
      add(box, [el("div", { class: "iri-ord-qq-btns" }, qs2.map(function (x) {
        return el("button", { type: "button", class: "iri-ord-pill", "aria-pressed": String(S.qq === x[0]), onclick: function () { S.qq = x[0]; rerender(); } }, x[1]);
      })), S.qq ? quoteAnswer(S.qq) : null, el("div", { class: "iri-ord-msg is-soft", text: t("qq.pay") })]);
      return box;
    }
    if (v === "find" && S.porting) return portingCard();
    return null;
  }
  // Explain charges: rendered from the quote by template, never calculated by AI (BRD AI04)
  function quoteAnswer(k) {
    var o = S.order, q = o.quote, n = o.numbers.length, path = pathOf();
    var body;
    if (k === "today") body = el("div", null, el("p", { text: t("qa.today.lead") }), el("ul", null,
      el("li", null, tn("qa.today.setup", n, { amt: money(q.setup) })), el("li", null, t("qa.today.first", { amt: money(q.firstMonth) })),
      el("li", null, t("qa.today.tax", { amt: money(q.tax) }))));
    else if (k === "next") body = el("p", null, t("qa.next", { amt: money(q.monthly), incl: money(Number(q.monthly) + Number(q.monthlyTax)), date: day(nextBill()) }), " ", usageSentence(path));
    else body = el("p", null, t("qa.not." + path));
    return el("div", { class: "iri-ord-msg is-answer" }, body, el("p", { class: "src" }, ic("shield"), t("qa.src", { ref: o.ref })));
  }
  // Opens the site's own Iris (iris-widget-v3-1, unchanged) the way its "Enable Iris & continue"
  // button does: the widget listens for iris:audio-unlocked, shows the dock and starts the call.
  // This runs inside the customer's click, so audio is allowed. Turned off or missing → fallback text.
  function irisOff() {
    try { if (localStorage.getItem("iris_disabled") === "1") return true; } catch (e) {}
    return /(^|;)\s*iris_disabled=1/.test(document.cookie);
  }
  function openIris(e) {
    // Switched off on this device: turn her on the way the site's "Turn on Iris" pill does (reloads the page;
    // the basket and filters are in sessionStorage). After the reload a notice asks for one more tap.
    if (irisOff() && window.IrisOptOut && IrisOptOut.enable) {
      try { sessionStorage.setItem("iriOrdIrisOn", "1"); } catch (x) {}
      if (e && e.currentTarget) busy(e.currentTarget, true, t("iris.turningOn"));
      say(t("iris.turningOn"));
      IrisOptOut.enable();
      return;
    }
    var dock = document.getElementById("iris-dock");
    if (!dock || irisOff()) { if (!S.irisDown) { S.irisDown = true; refreshRail(); } return; }
    dock.classList.add("iris-in"); // visible even if it was closed on this page, so a call never runs hidden
    try { window.dispatchEvent(new Event("iris:audio-unlocked")); } catch (x) {}
    if (S.irisDown || S.irisNote) { S.irisDown = false; S.irisNote = false; rerender(); }
  }
  function refreshRail() {
    var old = mount && mount.querySelector(".iri-ord-rail");
    if (old) old.parentNode.replaceChild(irisRail(S.step), old);
    var sh = mount && mount.querySelector(".iri-ord-sheet"), ns = irisSheet();
    if (sh) sh.parentNode.removeChild(sh);
    if (ns) mount.insertBefore(ns, document.getElementById("iri-ord-live"));
  }
  // An Iris proposal: shows what would change and runs only on the customer's click (BRD action cards)
  function cardEl(c) {
    return el("div", { class: "iri-ord-card-iris", "data-card": c.id },
      el("div", { class: "eb", text: t("card.eyebrow") }),
      c.title ? el("strong", { text: c.title }) : null, c.text ? el("p", { text: c.text }) : null,
      c.actions && c.actions.length ? el("div", { class: "acts" }, c.actions.map(function (a, i) {
        return el("button", { type: "button", class: "iri-ord-btn is-small" + (i ? " is-ghost" : " is-secondary"),
          onclick: function () { dropCard(c.id); if (a.fn) a.fn(); else refreshRail(); } }, a.label);
      })) : null,
      el("p", { class: "note" }, ic("lock"), c.note || t("card.note")));
  }
  function pushCard(c) { c.id = c.id || "c" + Date.now().toString(36); S.cards = S.cards.filter(function (x) { return x.id !== c.id; }).concat([c]).slice(-3); refreshRail(); say(t("card.new")); }
  function dropCard(id) { S.cards = S.cards.filter(function (x) { return x.id !== id; }); }
  function portingCard() {
    return el("div", { class: "iri-ord-card-iris" }, el("div", { class: "eb", text: t("scope.eyebrow") }),
      el("p", { text: t("scope.porting") }),
      el("div", { class: "acts" }, el("a", { class: "iri-ord-btn is-small is-secondary", href: "/contact-us", text: t("scope.contact") }),
        el("button", { type: "button", class: "iri-ord-btn is-small is-ghost", onclick: function () { S.porting = false; refreshRail(); } }, t("card.notNow"))));
  }

  // Context for the Iris widget: step facts only, no names, emails, addresses or card data
  function emitContext(extra) {
    if (!S) return;
    var o = S.order, q = o && o.quote, u = S.token ? ui() : {};
    var d = { flow: "buy-phone-numbers", step: S.view || S.step, lang: S.lang, mode: S.mode, demo: !!S.demo,
      numbers: (o && S.step !== "find" ? o.numbers : S.sel).map(function (n) { return { number: n.display, type: catOf(metaOf(n)) }; }),
      holdSecondsLeft: holdLeft(), path: u.conn ? u.conn.path : null, e911Confirmed: !!(u.e911 && u.e911.done),
      quote: q ? { ref: o.ref, dueToday: q.dueToday, setup: q.setup, firstMonth: q.firstMonth, tax: q.tax, taxRate: q.taxRate, monthly: q.monthly, monthlyTax: q.monthlyTax, approved: !!q.approved } : null,
      usageRates: { version: RATES.version, canadaPerMin: RATES.ca, usPerMin: RATES.us, per911Call: RATES.e911 },
      order: o && S.step === "order" ? { ref: o.ref, state: o.state, statuses: o.numbers.map(function (n) { return n.status; }) } : null,
      search: S.step === "find" ? { filters: chipsOf().map(function (c) { return c.label; }), results: S.results ? S.results.length : null, error: S.findError || null } : null };
    for (var k in (extra || {})) d[k] = extra[k];
    window.IriOrderContext = d;
    try { document.dispatchEvent(new CustomEvent("iri-ord:context", { detail: d })); } catch (e) {}
  }

  // ---------- hold clock (server-timed) ----------
  function holdLeft() {
    var o = S.order;
    if (!o || !o.holdExpiresAt || ["held", "reserving"].indexOf(o.state) < 0) return null;
    return Math.max(0, Math.round((Date.parse(o.holdExpiresAt) - Date.now()) / 1000));
  }
  function startClock() {
    clearInterval(timer);
    function tick() {
      var o = S.order;
      if (!o || !o.holdExpiresAt) return;
      var left = Math.max(0, Date.parse(o.holdExpiresAt) - Date.now());
      var m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
      var txt = (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
      mount.querySelectorAll("[data-hold]").forEach(function (h) {
        h.querySelector(".txt").textContent = h.getAttribute("data-long") ? t("bar.held", { t: txt }) : t("bar.left", { t: txt });
        h.classList.toggle("is-warning", left < 2 * 60000);
      });
      mount.querySelectorAll("[data-hold-clock]").forEach(function (b) { b.textContent = txt; });
      mount.querySelectorAll("[data-bar-clock]").forEach(function (b) { b.textContent = " · " + t("bar.heldShort", { t: txt }); });
      // One announcement at two minutes (BRD UX10)
      if (left < 2 * 60000 && left > 0 && S.warned !== o.holdExpiresAt) { S.warned = o.holdExpiresAt; say(t("hold.warn")); }
      if (!left && !S.expiredShown) { S.expiredShown = true; refresh(); }
    }
    tick();
    timer = setInterval(tick, 1000);
  }
  function refresh() { if (S.token) api("/basket").then(function (j) { S.order = j.order; route(); }).catch(function () {}); }

  function expiredView(step) {
    S.render = function () { expiredView(step); };
    frame(step, [head(t("hold.expiredT")), el("div", { class: "iri-ord-card" },
      callout("warning", "", t("hold.expired"),
        el("div", { class: "iri-ord-actions" },
          el("button", { type: "button", class: "iri-ord-btn", text: t("hold.recheck"), onclick: function (e) {
            var nums = (S.order && S.order.numbers || []).map(function (n) { return { did: n.did, display: n.display, category: n.category }; });
            hold(nums, e.currentTarget);
          } }),
          el("a", { class: "iri-ord-btn is-secondary", href: url("find"), text: t("hold.other") }))))], { focus: true });
  }

  // ---------- search parsing (structured input never needs AI, BRD SS01) ----------
  function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }
  var STOP = ("a an the for my me our we i in at of to with and or number numbers phone line lines local new get want need find memorable easy remember "
    + "that spells spell word words good nice some please business home near around like canada canadian de du des la le les un une pour mon ma mes notre "
    + "numero numeros telephone ligne lignes facile retenir memorable qui mot mots avec et ou au aux en dans pres digit digits chiffre chiffres").split(" ");
  function npaSet() { var s = {}; cat.rateCentres.forEach(function (r) { r.npas.forEach(function (n) { s[n] = 1; }); }); return s; }
  function provOfNpa(npa) { var r = cat.rateCentres.filter(function (x) { return x.npas.indexOf(npa) >= 0; })[0]; return r ? r.prov : ""; }
  function findCity(s, raw) {
    var best = null;
    cat.rateCentres.forEach(function (r) {
      var nm = norm(r.name), alt = norm(r.rc.replace(/-/g, " "));
      [nm, alt].forEach(function (k) {
        if (!k) return;
        var re = new RegExp("(^| )" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "( |$)");
        if (re.test(s) && (!best || k.length > best.k.length)) best = { r: r, k: k };
      });
    });
    if (!best) return null;
    // Same name in two provinces: a province code in the text decides
    var same = cat.rateCentres.filter(function (r) { return norm(r.name) === norm(best.r.name); });
    if (same.length > 1) { var code = (/\b([A-Z]{2})\b/.exec(raw || "") || [])[1]; best.r = same.filter(function (r) { return r.prov === code; })[0] || best.r; }
    return best;
  }
  function parseQuery(raw) {
    var out = { npa: "", rc: "", province: "", digits: "", word: "", count: 0, category: "", free: false, exact: false };
    var s = norm(raw);
    if (!s) { out.empty = true; return out; }
    var m = /^(\d{1,2})\s+(?:numbers?|numeros?|lines?|lignes?)\s+(?:in|a|au|en|dans|for|pour)\s+(.+)$/.exec(s);
    if (m) { out.count = Math.min(+m[1], cfg.maxNumbers); s = m[2]; }
    if (/\b(repeating|repeat|repeated|repetitifs?|repetes?|repetition|repetitive)\b/.test(s)) { out.category = "speciality"; s = s.replace(/\b(repeating|repeat|repeated|repetitifs?|repetes?|repetition|repetitive)\b/g, " "); }
    var all = s.replace(/\D/g, "");
    if (/^[\d ]+$/.test(s) && (all.length === 10 || (all.length === 11 && all[0] === "1"))) {
      out.digits = all.slice(-10); out.npa = out.digits.slice(0, 3); out.province = provOfNpa(out.npa); out.exact = true; return out;
    }
    var city = findCity(s, raw);
    if (city) { out.rc = city.r.rc; out.province = city.r.prov; s = (" " + s + " ").replace(" " + city.k + " ", " ").trim(); }
    var npas = npaSet(), rest = [];
    s.split(" ").forEach(function (tok) {
      if (!tok) return;
      if (/^\d{3}$/.test(tok) && npas[tok] && !out.npa) { out.npa = tok; if (!out.province) out.province = provOfNpa(tok); return; }
      if (/^\d{4,7}$/.test(tok) && !out.digits) { out.digits = tok; return; }
      if (cat.provinces.some(function (p) { return norm(p.name) === tok; })) { if (!out.province) out.province = cat.provinces.filter(function (p) { return norm(p.name) === tok; })[0].code; return; }
      if (/^[a-z]{2}$/.test(tok) && cat.provinces.some(function (p) { return p.code.toLowerCase() === tok; }) && new RegExp("\\b" + tok.toUpperCase() + "\\b").test(raw)) { if (!out.province) out.province = tok.toUpperCase(); return; }
      rest.push(tok);
    });
    // A rate centre plus its own area code: keep both; a different province wins over nothing
    var words = rest.filter(function (w) { return STOP.indexOf(w) < 0 && /^[a-z]{2,10}$/.test(w); });
    var noise = rest.filter(function (w) { return STOP.indexOf(w) < 0; }).length - words.length;
    if (rest.length <= 2 && words.length === 1 && !noise && !out.digits) out.word = words[0].toUpperCase();
    else if (rest.length) out.free = rest.some(function (w) { return STOP.indexOf(w) < 0; }) || rest.length > 2;
    if (out.free) out.word = "";
    return out;
  }
  function locLabel(f) {
    if (!f) return "";
    if (f.ratecenter) { var r = cat.rateCentres.filter(function (x) { return x.rc === f.ratecenter; })[0]; if (r) return r.name + (f.areaCode ? " · " + f.areaCode : ""); }
    if (f.areaCode) return t("chip.npa", { npa: f.areaCode });
    if (f.province) { var p = cat.provinces.filter(function (x) { return x.code === f.province; })[0]; return p ? p.name : f.province; }
    return "";
  }
  function chipsOf() {
    var f = S.search.filters || {}, c = [];
    if (f.ratecenter) {
      var r = cat.rateCentres.filter(function (x) { return x.rc === f.ratecenter; })[0];
      c.push({ key: "loc", label: r ? t("chip.city", { city: r.name, npas: (f.areaCode ? [f.areaCode] : r.npas).join(", ") }) : f.ratecenter });
    } else if (f.areaCode) c.push({ key: "loc", label: t("chip.npa", { npa: f.areaCode }) });
    else if (f.province) c.push({ key: "loc", label: locLabel(f) });
    if (f.word) c.push({ key: "word", label: t(S.search.partial ? "chip.partial" : "chip.word", { w: f.word }) });
    if (f.digits) c.push({ key: "digits", label: t(f.match === "exact" ? "chip.exact" : "chip.digits", { d: f.match === "exact" ? fmt(f.digits) : f.digits }) });
    if (f.category && f.category !== "all") c.push({ key: "category", label: catLabel(f.category) });
    if (S.search.count) c.push({ key: "count", label: tn("chip.count", S.search.count), fixed: true });
    c.push({ key: "voice", label: t("badge.voice"), fixed: true });
    c.push({ key: "mode", label: t("mode." + S.mode), fixed: true });
    return c;
  }
  function blankFilters() { return { province: "", ratecenter: "", areaCode: "", digits: "", word: "", match: "contains", category: "all" }; }

  // ---------- step 1: find a number ----------
  function findStep() {
    S.view = "find"; S.render = findStep;
    // Coming back with a hold: start from the held numbers once (later, an emptied selection stays empty)
    if (!S.seeded && S.order && S.order.state === "held" && !S.sel.length) S.sel = S.order.numbers.map(function (n) { return metaOf(n); });
    S.seeded = true;
    if (qs("preview") === "states" && S.demo) return statesGallery();
    var landing = !S.results && !S.searching;
    document.body.classList.toggle("iri-ord-compact", !landing);
    if (landing) {
      frame("find", el("div", { class: "iri-ord-landing" },
        modeToggle(), modeHelp(),
        S.findError ? callout("warning", "", S.findError, S.findAsk ? el("button", { type: "button", class: "iri-ord-link", onclick: openIris }, t("iris.ask")) : null) : null, S.notice || null,
        searchBox(true), tryChips(),
        el("p", { class: "iri-ord-hint", text: t("find.hint") }),
        el("ol", { class: "iri-ord-how" }, [1, 2, 3, 4].map(function (i) {
          return el("li", null, el("span", { class: "n", text: String(i) }), el("strong", { text: t("how." + i + ".t") }), el("p", { text: t("how." + i + ".d", { max: cfg.maxNumbers }) }));
        })),
        el("ul", { class: "iri-ord-trust" }, el("li", null, ic("shield"), t("trust.prices")), el("li", null, ic("lock"), t("trust.pay")), el("li", null, ic("info"), "English | Français")),
        S.porting ? el("div", { class: "iri-ord-landing-card" }, portingCard()) : null, S.sel.length ? tray() : null), { rail: false, cls: "is-landing", bar: findBar() });
      S.notice = null;
      return;
    }
    var box = el("div", { class: "iri-ord-results-box", "aria-busy": String(!!S.searching) });
    var main = [searchBox(false), chipRow(), S.search.more ? filtersPanel() : null, S.notice || null, box,
      el("p", { class: "iri-ord-foot" }, t("find.calling", { ca: money(RATES.ca, 3), us: money(RATES.us, 3), e911: money(RATES.e911) }))];
    drawResults(box);
    frame("find", main, { bar: findBar() });
    S.notice = null;
  }
  function findBar() {
    if (!S.sel.length) return null;
    var setup = 0, month = 0;
    S.sel.forEach(function (n) { setup += Number(n.setup || 0); month += Number(n.monthly || 0); });
    return mobileBar(tn("tray.count", S.sel.length), t("mbar.total", { setup: money(setup), month: money(month) }), t("mbar.continue"), function (e) { cont(e.currentTarget); });
  }
  function modeToggle() {
    var g = el("div", { class: "iri-ord-mode", role: "radiogroup", "aria-label": t("mode.label") });
    ["rent", "purchase"].forEach(function (m) {
      var off = m === "purchase" && !cfg.purchaseEnabled, on = S.mode === m;
      g.appendChild(el("button", { type: "button", role: "radio", class: "opt", "aria-checked": String(on), "aria-disabled": off ? "true" : null,
        tabindex: on ? "0" : "-1", "aria-describedby": off ? "iri-ord-mode-off" : null,
        onclick: function () { if (off) { S.modeHelp = true; rerender(); return; } setMode(m); },
        onkeydown: function (e) { if (["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].indexOf(e.key) >= 0) { e.preventDefault(); if (!cfg.purchaseEnabled) { S.modeHelp = true; rerender(); } else setMode(S.mode === "rent" ? "purchase" : "rent"); } } },
        el("strong", { text: t("mode." + m + ".t") }), el("span", { text: t("mode." + m + ".sub") })));
    });
    return g;
  }
  function setMode(m) {
    if (S.mode === m) return;
    S.mode = m; save();
    if (S.results) runSearch(0); else rerender();
  }
  function modeHelp() {
    var w = el("div", { class: "iri-ord-modehelp" }, t("mode.note"), " ",
      el("button", { type: "button", class: "iri-ord-link", "aria-expanded": String(!!S.modeHelp), onclick: function () { S.modeHelp = !S.modeHelp; rerender(); } }, t("mode.diff")));
    if (!S.modeHelp) return w;
    return el("div", null, w, el("div", { class: "iri-ord-explain" },
      el("div", null, el("strong", { text: t("mode.rent.t") + " — " + t("mode.rent.sub") }), el("p", { text: t("mode.rent.long") })),
      el("div", null, el("strong", { text: t("mode.purchase.t") + " — " + t("mode.purchase.sub") }), el("p", { text: t("mode.purchase.long") })),
      !cfg.purchaseEnabled ? el("p", { class: "off", id: "iri-ord-mode-off", text: t("mode.purchase.off") }) : null));
  }
  function searchBox(big) {
    var inp = el("input", { type: "search", name: "q", class: "q", value: S.search.q || "", placeholder: t("find.placeholder"),
      "aria-label": t("find.label"), autocomplete: "off", maxlength: "120", enterkeyhint: "search" });
    return el("form", { class: "iri-ord-search" + (big ? " is-big" : ""), role: "search", novalidate: true,
      onsubmit: function (e) { e.preventDefault(); runQuery(inp.value); } },
      ic("sparkle", "lead"), inp,
      el("button", { type: "submit", class: "iri-ord-btn" }, ic("search"), big ? t("find.go") : t("find.update")));
  }
  function tryChips() {
    var items = [
      { label: [ic("pin"), "Toronto · 416"], q: "Toronto 416" },
      { label: "Ottawa · 613", q: "Ottawa 613" },
      { label: t("try.word"), q: t("try.wordQ") },
      { label: t("try.repeat"), q: t("try.repeatQ") },
      { label: t("try.multi"), q: t("try.multiQ") }
    ];
    return el("div", { class: "iri-ord-try" }, el("span", { class: "lbl", text: t("try.label") }),
      items.map(function (it) { return el("button", { type: "button", class: "iri-ord-pill", onclick: function () { runQuery(it.q); } }, it.label); }),
      el("button", { type: "button", class: "iri-ord-pill", onclick: function () { S.porting = true; rerender(); } }, t("try.keep"), el("small", { class: "tag", text: t("try.porting") })));
  }
  function runQuery(q, fromIris) {
    var p = parseQuery(q);
    S.findError = null; S.findAsk = false;
    S.search.q = q; S.search.fromIris = !!fromIris; S.search.partial = false; S.search.ideas = fromIris ? S.search.ideas : null;
    if (p.empty) { S.findError = t("find.errEmpty"); save(); rerender(); return; }
    var f = S.search.filters = blankFilters();
    f.province = p.province; f.ratecenter = p.rc; f.areaCode = p.npa; f.digits = p.digits; f.word = p.word;
    f.match = p.exact ? "exact" : "contains"; f.category = p.category || "all";
    S.search.count = p.count;
    if (p.free) askIris(q);
    if (!f.province && !f.ratecenter && !f.areaCode) {
      S.findError = p.free ? t("find.errPlaceFree") : t("find.errPlace");
      S.findAsk = !!p.free; // "…or ask Iris" needs a way to ask her
      S.results = null; save(); rerender();
      var i = mount.querySelector(".iri-ord-search .q"); if (i) i.focus();
      return;
    }
    if (p.free) S.notice = callout("", "", t("find.freeNote", { loc: locLabel(f) }), el("button", { type: "button", class: "iri-ord-link", onclick: openIris }, t("iris.ask")), "sparkle");
    runSearch(0);
  }
  // Free text goes to Iris only (the deterministic search never interprets it)
  function askIris(text) {
    try { document.dispatchEvent(new CustomEvent("iris:ask", { detail: { text: String(text).slice(0, 300), step: "find", lang: S.lang } })); } catch (e) {}
  }
  function runSearch(page) {
    var f = S.search.filters || blankFilters();
    S.searching = !page; S.findError = null; save();
    if (!page) { S.results = null; rerender(); }
    var word = S.search.partial ? f.word.slice(0, S.search.partial) : f.word;
    api("/search", { body: { province: f.province, ratecenter: f.ratecenter, areaCode: f.areaCode, digits: word ? "" : f.digits,
      word: word, match: f.match, type: f.category === "basic" ? "basic" : f.category === "vanity" || f.category === "speciality" ? "vanity" : "all",
      page: page, demo: S.demo || undefined } })
      .then(function (j) {
        var rows = j.results.map(function (n) {
          n.match = matchFor(n, word, S.search.partial ? f.word : null);
          return n;
        }).filter(function (n) { return f.category !== "speciality" || catOf(n) === "speciality"; });
        S.results = page ? S.results.concat(rows) : rows; S.more = j.more; S.page = page;
        S.searching = false; rerender(); say(tn("res.found", S.results.length));
      })
      .catch(function (e) {
        S.searching = false; S.results = S.results || [];
        S.findError = e.data && e.data.errors ? Object.keys(e.data.errors).map(function (k) { return has("fe." + k) ? t("fe." + k) : e.data.errors[k]; }).join(" ") : errText(e);
        rerender();
      });
  }
  function chipRow() {
    var row = el("div", { class: "iri-ord-chips" }, el("span", { class: "lbl" }, S.search.fromIris ? [el("span", { class: "iri-ord-av is-xs", "aria-hidden": "true" }, ic("sparkle")), t("chips.iris")] : t("chips.plain")));
    chipsOf().forEach(function (c) {
      row.appendChild(el("span", { class: "iri-ord-fchip" + (c.fixed ? " is-fixed" : "") }, c.label,
        c.fixed ? null : el("button", { type: "button", "aria-label": t("chips.remove", { label: c.label }), onclick: function () { removeChip(c.key); } }, ic("x"))));
    });
    (S.search.ideas || []).forEach(function (w) {
      if (w === (S.search.filters || {}).word) return;
      row.appendChild(el("button", { type: "button", class: "iri-ord-fchip is-idea", onclick: function () { S.search.filters.word = w; S.search.partial = false; runSearch(0); } }, ic("sparkle"), w));
    });
    row.appendChild(el("button", { type: "button", class: "iri-ord-fchip is-more", "aria-expanded": String(!!S.search.more),
      onclick: function () { S.search.more = !S.search.more; rerender(); } }, ic("plus"), t("chips.more")));
    return row;
  }
  function removeChip(k) {
    var f = S.search.filters;
    if (k === "loc") { f.province = ""; f.ratecenter = ""; f.areaCode = ""; }
    if (k === "word") { f.word = ""; S.search.partial = false; }
    if (k === "digits") { f.digits = ""; f.match = "contains"; }
    if (k === "category") f.category = "all";
    S.search.q = ""; S.search.fromIris = false;
    if (!f.province && !f.ratecenter && !f.areaCode) { S.results = null; S.findError = t("find.errPlace"); save(); rerender(); return; }
    runSearch(0);
  }
  function filtersPanel() {
    var f = S.search.filters || blankFilters();
    var provs = [["", t("f.any")]].concat(cat.provinces.map(function (p) { return [p.code, p.name]; }));
    var prov = select("province", provs, f.province), rc = select("ratecenter", [["", t("f.any")]], f.ratecenter), npa = select("areaCode", [["", t("f.any")]], f.areaCode);
    function fillRc() {
      var list = cat.rateCentres.filter(function (r) { return !prov.value || r.prov === prov.value; });
      rc.textContent = "";
      add(rc, [["", t("f.any")]].concat(list.map(function (r) { return [r.rc, r.name + (prov.value ? "" : ", " + r.prov)]; })).map(function (o) { var op = el("option", { value: o[0], text: o[1] }); if (o[0] === f.ratecenter) op.selected = true; return op; }));
      fillNpa();
    }
    function fillNpa() {
      var set = {};
      cat.rateCentres.forEach(function (r) { if ((!prov.value || r.prov === prov.value) && (!rc.value || r.rc === rc.value)) r.npas.forEach(function (n) { set[n] = 1; }); });
      npa.textContent = "";
      add(npa, [["", t("f.any")]].concat(Object.keys(set).sort().map(function (n) { return [n, n]; })).map(function (o) { var op = el("option", { value: o[0], text: o[1] }); if (o[0] === f.areaCode) op.selected = true; return op; }));
    }
    prov.addEventListener("change", function () { f.ratecenter = ""; f.areaCode = ""; fillRc(); });
    rc.addEventListener("change", function () { f.areaCode = ""; fillNpa(); });
    fillRc();
    var dw = input("dw", f.word || f.digits, { placeholder: t("f.dwPh"), autocomplete: "off", maxlength: "12" });
    var match = select("match", [["contains", t("f.m.contains")], ["starts", t("f.m.starts")], ["ends", t("f.m.ends")], ["exact", t("f.m.exact")]], f.match);
    var catSel = select("category", [["all", t("cat.all")], ["basic", catLabel("basic")], ["vanity", catLabel("vanity")], ["speciality", catLabel("speciality")]], f.category);
    var form = el("form", { class: "iri-ord-filters", novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      var v = dw.value.trim();
      f.province = prov.value; f.ratecenter = rc.value; f.areaCode = npa.value; f.match = match.value; f.category = catSel.value;
      f.word = /[a-z]/i.test(v) ? v.toUpperCase() : ""; f.digits = /[a-z]/i.test(v) ? "" : v.replace(/\D/g, "");
      if (!f.province && !f.ratecenter && !f.areaCode) return showErrors(form, { province: t("find.errPlace") });
      S.search.q = ""; S.search.fromIris = false; S.search.partial = false; S.search.more = false;
      runSearch(0);
    } },
      el("div", { class: "iri-ord-grid" },
        field(t("f.province"), prov, { name: "province" }), field(t("f.rc"), rc, { name: "ratecenter" }), field(t("f.npa"), npa, { name: "areaCode" }),
        field(t("f.category"), catSel, { name: "category" }), field(t("f.dw"), dw, { name: "dw", cls: "is-wide", help: t("f.dwHelp") }), field(t("f.match"), match, { name: "match" }),
        el("div", { class: "iri-ord-field is-end" }, el("button", { type: "submit", class: "iri-ord-btn is-full", text: t("f.apply") }))));
    return form;
  }
  function sorted(list) {
    var by = S.search.sort || "best", rank = { exact: 4, partial: 3, speciality: 2, vanity: 1, basic: 0 };
    return list.slice().sort(function (a, b) {
      if (by === "price") return (Number(a.setup) + Number(a.monthly)) - (Number(b.setup) + Number(b.monthly)) || (a.did < b.did ? -1 : 1);
      if (by === "number") return a.did < b.did ? -1 : 1;
      var ra = a.match ? (a.match.exact ? rank.exact : rank.partial) : rank[catOf(a)], rb = b.match ? (b.match.exact ? rank.exact : rank.partial) : rank[catOf(b)];
      return rb - ra || (a.did < b.did ? -1 : 1);
    });
  }
  function drawResults(box) {
    box.textContent = "";
    if (S.searching) { box.appendChild(el("p", { class: "iri-ord-empty" }, el("span", { class: "iri-ord-spinner is-dark", "aria-hidden": "true" }), t("res.searching"))); return; }
    if (S.findError) box.appendChild(callout("warning", "", S.findError));
    var f = S.search.filters || {}, list = S.results || [];
    if (f.word && list.length && S.search.partial) box.appendChild(callout("warning", "", t("res.partialNote", { w: f.word, part: f.word.slice(0, S.search.partial) })));
    if (!list.length && !S.findError) { box.appendChild(noResults()); return; }
    if (!list.length) return;
    var sorts = el("div", { class: "iri-ord-sort", role: "group", "aria-label": t("sort.label") }, el("span", { text: t("sort.label") }),
      ["best", "price", "number"].map(function (k) {
        return el("button", { type: "button", class: "iri-ord-pill", "aria-pressed": String((S.search.sort || "best") === k), onclick: function () { S.search.sort = k; save(); rerender(); } }, t("sort." + k));
      }));
    box.appendChild(el("div", { class: "iri-ord-reshead" }, el("h2", null, el("b", { text: tn("res.count", list.length, { more: S.more ? "+" : "" }) }), " ", tn("res.match", list.length), " ", example()), sorts));
    var ul = el("ul", { class: "iri-ord-res" });
    sorted(list).forEach(function (n) { ul.appendChild(resultCard(n)); });
    box.appendChild(ul);
    if (S.more) box.appendChild(el("div", { class: "iri-ord-more" }, el("button", { type: "button", class: "iri-ord-btn is-secondary", text: t("res.more"), onclick: function () { runSearch(S.page + 1); } })));
    if (S.sel.length) box.appendChild(tray());
  }
  function noResults() {
    var f = S.search.filters || {}, ideas = [];
    if (f.word && f.word.length > 3) {
      ideas.push(el("button", { type: "button", class: "iri-ord-pill", onclick: function () { S.search.partial = Math.max(3, Math.ceil(f.word.length * 0.6)); runSearch(0); } }, t("nr.partial")));
    }
    var r = cat.rateCentres.filter(function (x) { return x.rc === f.ratecenter; })[0];
    var near = (r ? r.npas : cat.rateCentres.filter(function (x) { return x.prov === f.province; }).reduce(function (a, x) { return a.concat(x.npas); }, []))
      .filter(function (n, i, a) { return n !== f.areaCode && a.indexOf(n) === i; }).slice(0, 3);
    near.forEach(function (n) { ideas.push(el("button", { type: "button", class: "iri-ord-pill", onclick: function () { f.areaCode = n; runSearch(0); } }, t("nr.npa", { npa: n }))); });
    if (f.word || f.digits) ideas.push(el("button", { type: "button", class: "iri-ord-pill", onclick: function () { f.word = ""; f.digits = ""; S.search.partial = false; runSearch(0); } }, t("nr.clear")));
    var title = f.word ? t("nr.wordT", { w: f.word, loc: locLabel(f) }) : t("nr.t");
    var why = f.word && keypad(f.word).length > 7 ? t("nr.tooLong", { w: f.word }) : t("nr.d");
    return callout("warning", title, why, ideas.length ? el("div", { class: "iri-ord-try is-tight" }, ideas) : null);
  }
  function isSel(did) { return S.sel.some(function (x) { return x.did === did; }); }
  function resultCard(n) {
    var picked = isSel(n.did), full = !picked && S.sel.length >= cfg.maxNumbers, c = catOf(n), city = cityOf(n);
    return el("li", { class: "iri-ord-rescard" + (picked ? " is-picked" : "") },
      el("div", { class: "c-num" }, el("div", { class: "iri-ord-num", text: n.display }), spellEl(n),
        el("p", { class: "why" }, ic("dot"), reasonOf(n))),
      el("div", { class: "c-badges" }, badge(c, catLabel(c)), n.match ? badge(n.match.exact ? "exact" : "partial") : null,
        city ? badge("loc", city) : null, badge("voice")),
      el("div", { class: "c-price" }, S.mode === "rent"
        ? [el("b", null, money(n.setup), " ", el("span", { text: t("res.setup") })), el("span", { text: t("res.thenMonthly", { amt: money(n.monthly) }) })]
        : [el("b", { text: t("res.noPurchase") })]),
      el("div", { class: "c-sel" }, el("button", { type: "button", class: "iri-ord-btn is-small" + (picked ? " is-picked" : " is-secondary"),
        "aria-pressed": String(picked), "aria-label": (picked ? t("res.selectedA") : t("res.selectA")) + " " + n.display, disabled: full || null, "data-did": n.did,
        onclick: function () { toggle(n); } }, picked ? [ic("check"), t("res.selected")] : t("res.select"))));
  }
  function toggle(n) {
    var i = S.sel.map(function (x) { return x.did; }).indexOf(n.did);
    if (i >= 0) S.sel.splice(i, 1);
    else if (S.sel.length < cfg.maxNumbers) S.sel.push({ did: n.did, display: n.display, category: n.category, cat: catOf(n), rc: n.rc, location: n.location,
      setup: n.setup, monthly: n.monthly, match: n.match || null });
    save();
    var y = window.scrollY;
    rerender();
    window.scrollTo(0, y);
    say(i >= 0 ? t("res.removed", { n: n.display }) : t("res.added", { n: n.display }));
    var b = mount.querySelector('[data-did="' + n.did + '"]'); if (b) { try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); } }
  }
  function tray() {
    var setup = 0, month = 0, held = heldSame();
    S.sel.forEach(function (n) { setup += Number(n.setup || 0); month += Number(n.monthly || 0); });
    var cell = function (k, v) { return el("div", { class: "cell" }, el("small", { text: k }), el("b", null, v)); };
    return el("div", { class: "iri-ord-tray", role: "region", "aria-label": t("tray.label") },
      cell(t("tray.selected"), [tn("tray.count", S.sel.length), " ", el("button", { type: "button", class: "iri-ord-link is-light iri-ord-tray-edit", "aria-haspopup": "dialog",
        onclick: function () { toggleBasket(true); } }, t("mbar.edit"))]),
      held ? cell(t("tray.held"), el("span", { "data-hold-clock": "1", text: "--:--" })) : null,
      cell(t("tray.setup"), money(setup)), cell(t("tray.monthly"), t("tray.perMonth", { amt: money(month) })),
      el("p", { class: "note", text: cfg.prices && cfg.prices.approved ? t("tray.noteFinal") : t("tray.noteEx") }),
      el("button", { type: "button", class: "iri-ord-btn is-light", onclick: function (e) { cont(e.currentTarget); } }, tn("tray.continue", S.sel.length), ic("chev")));
  }
  function heldSame() {
    var o = S.order;
    if (!o || o.state !== "held") return false;
    var a = o.numbers.map(function (n) { return n.did; }).sort().join(), b = S.sel.map(function (n) { return n.did; }).sort().join();
    return a === b;
  }
  function cont(btn) { if (!S.sel.length) return; if (heldSame()) return go("account"); hold(S.sel, btn); }

  // Reserve the selection, then wait until Espresso confirms the hold
  function hold(nums, btn) {
    if (!nums.length) return;
    busy(btn, true, t("busy.hold"));
    var meta = {};
    nums.forEach(function (n) { meta[n.did] = { cat: n.cat || catOf(n), match: n.match || null }; });
    var prev = S.token ? ui() : null, had = heldNow(S.order) ? S.order.numbers.map(function (n) { return n.did; }) : [];
    api("/hold", { body: { numbers: nums.map(function (n) { return { did: n.did, rc: n.rc || null }; }), token: S.token || undefined, demo: S.demo || undefined } })
      .then(function (j) {
        S.token = j.token; S.order = j.order;
        var u = ui();
        if (prev && prev !== u) {
          if (prev.details && !u.details) u.details = prev.details;
          if (prev.conn && !u.conn) u.conn = prev.conn;
          if (prev.e911 && !u.e911) { u.e911 = JSON.parse(JSON.stringify(prev.e911)); u.e911.done = false; u.e911.confirms = [false, false, false]; u.e911.rcOk = false; }
        }
        // Same basket with numbers added (the server changes a held basket in place): the 9-1-1 address must be confirmed
        // again for the new numbers
        if (prev === u && u.e911 && S.order.numbers.some(function (n) { return had.indexOf(n.did) < 0; })) {
          u.e911.done = false; u.e911.confirms = [false, false, false]; u.e911.rcOk = false;
        }
        for (var k in meta) (u.meta = u.meta || {})[k] = meta[k];
        save();
        return waitHeld(30);
      })
      .then(function () { S.sel = S.order.numbers.map(function (n) { return metaOf(n); }); save(); go("account"); })
      .catch(function (e) {
        busy(btn, false);
        if (e.code === "NUMBER_UNAVAILABLE" || e.code === "TAKEN") {
          var gone = (e.data && e.data.taken) || [];
          S.sel = S.sel.filter(function (n) { return gone.indexOf(n.did) < 0; });
          S.results = (S.results || []).filter(function (n) { return gone.indexOf(n.did) < 0; });
          save();
          S.notice = callout("warning", tn("taken.t", gone.length), tn("taken.d", gone.length, { list: gone.map(fmt).join(", ") }));
        } else S.notice = callout("error", "", errText(e));
        if (S.step === "find") findStep(); else go("find");
      });
  }
  function waitHeld(tries) {
    return api("/basket").then(function (j) {
      S.order = j.order;
      if (j.order.state === "held") return j.order;
      if (j.order.state === "rejected") { var e = new Error(j.order.message); e.code = "NUMBER_UNAVAILABLE"; e.data = { taken: j.order.taken }; throw e; }
      if (tries <= 0) { var x = new Error(t("err.slowHold")); throw x; }
      return new Promise(function (r) { setTimeout(r, 2000); }).then(function () { return waitHeld(tries - 1); });
    });
  }
  // A held number with what the search knew about it (category, word match)
  function metaOf(n) {
    var m = (S.token && ui().meta && ui().meta[n.did]) || {};
    var o = {}; for (var k in n) o[k] = n[k];
    if (m.cat) o.cat = m.cat;
    if (m.match) o.match = m.match;
    if (!o.setup && S.order && S.order.quote) { var l = lineOf(n.did); o.setup = l.setup; o.monthly = l.monthly; }
    return o;
  }
  function lineOf(did) { var l = (S.order && S.order.quote && S.order.quote.lines || []).filter(function (x) { return x.did === did; })[0]; return l || { setup: 0, monthly: 0 }; }

  // ---------- step 2: MyIristel ----------
  function accountStep() {
    S.view = "account"; S.render = accountStep;
    var o = S.order;
    if (S.acct && S.demo) {
      if (!o.details) {
        frame("account", el("p", { class: "iri-ord-empty" }, el("span", { class: "iri-ord-spinner is-dark", "aria-hidden": "true" }), t("acct.loading")));
        return postDetails(acctDetails()).then(accountStep, function (e) { if (e.handled) return; S.acct = null; save(); S.notice = callout("error", "", errText(e)); accountStep(); });
      }
      return signedInView();
    }
    var tab = S.acctTab || "signin";
    var tabs = el("div", { class: "iri-ord-tabs", role: "tablist", "aria-label": t("acct.tabs") }, ["signin", "create"].map(function (k) {
      return el("button", { type: "button", role: "tab", id: "iri-ord-tab-" + k, "aria-selected": String(tab === k), "aria-controls": "iri-ord-panel-" + k, tabindex: tab === k ? "0" : "-1",
        onclick: function () { S.acctTab = k; rerender(); var b = document.getElementById("iri-ord-tab-" + k); if (b) b.focus(); },
        onkeydown: function (e) { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); S.acctTab = tab === "signin" ? "create" : "signin"; rerender(); var b = document.getElementById("iri-ord-tab-" + S.acctTab); if (b) b.focus(); } } },
        t("acct.tab." + k));
    }));
    var panel = tab === "signin" ? signInPanel() : createPanel();
    frame("account", [head(t("acct.title"), t("acct.lede")), S.notice || null, el("div", { class: "iri-ord-card" }, tabs, panel)],
      { focus: !S.rendered.account, bar: mobileBar(tn("tray.count", o.numbers.length), t("mbar.today", { amt: money(o.quote && o.quote.dueToday) }), t("mbar.continue"), function () {
        var f = mount.querySelector(".iri-ord-main form"); if (f) f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event("submit")); }) });
    S.rendered.account = true; S.notice = null;
  }
  function signInPanel() {
    var on = !!(S.demo && P);
    // The typed email survives a re-render (e.g. a number removed from "Your numbers"); kept in memory only, never the password
    var email = input("email", S.signinEmail || "", { type: "email", autocomplete: "username", disabled: on ? null : true }), pw = input("password", "", { type: "password", autocomplete: "current-password", disabled: on ? null : true });
    email.addEventListener("input", function () { S.signinEmail = email.value; });
    var form = el("form", { class: "iri-ord-panel", role: "tabpanel", id: "iri-ord-panel-signin", "aria-labelledby": "iri-ord-tab-signin", novalidate: true },
      el("p", { class: "iri-ord-help", text: t("acct.signinLede") }),
      on ? callout("demo", t("acct.demoT"), t("acct.demo")) : callout("", t("acct.soonT"), t("acct.soon")),
      el("div", { class: "iri-ord-grid is-2" },
        field(t("acct.email"), email, { name: "email", cls: "is-full" }), field(t("acct.password"), pw, { name: "password", cls: "is-full" })),
      el("div", { class: "iri-ord-actions" },
        el("button", { type: "submit", class: "iri-ord-btn", disabled: on ? null : true }, t("acct.signin")),
        el("a", { class: "iri-ord-link", href: MYIRISTEL, target: "_blank", rel: "noopener" }, t("acct.forgot"), el("span", { class: "sr", text: t("newtab") })),
        el("button", { type: "button", class: "iri-ord-link", onclick: function () { S.acctTab = "create"; rerender(); } }, t("acct.new"))));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!on) return;
      var errs = {};
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) errs.email = t("fe.email");
      if (!pw.value) errs.password = t("fe.password");
      if (Object.keys(errs).length) return showErrors(form, errs);
      var btn = form.querySelector("[type=submit]");
      busy(btn, true, t("busy.signin"));
      P.signIn(email.value.trim()).then(function (a) {
        pw.value = "";
        S.acct = a; save();
        return postDetails(acctDetails());
      }).then(function () { say(t("acct.signedIn", { name: S.acct.name })); accountStep(); })
        .catch(function (err) { busy(btn, false); if (err.handled) return; S.acct = null; save(); form.insertBefore(callout("error", "", errText(err)), form.firstChild); });
    });
    return form;
  }
  function acctDetails() {
    var a = S.acct, c = a.contact, ad = a.address;
    return { segment: a.type, company: a.type === "business" ? a.name : "", firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone,
      address1: ad.street, city: ad.city, province: ad.province, postalCode: ad.postalCode };
  }
  function postDetails(body) { return api("/details", { body: body }).then(function (j) { S.order = j.order; return j; }); }
  function createPanel() {
    var o = S.order, u = ui(), d = u.details = u.details || o.details || {};
    var seg = d.segment || "business";
    var provs = [["", t("f.choose")]].concat(cat.provinces.map(function (p) { return [p.code, p.name]; }));
    var form = el("form", { class: "iri-ord-panel", role: "tabpanel", id: "iri-ord-panel-create", "aria-labelledby": "iri-ord-tab-create", novalidate: true,
      oninput: function (e) { if (e.target.name) { d[e.target.name] = e.target.value; save(); } } },
      el("p", { class: "iri-ord-help", text: t("acct.createLede") }),
      el("div", { class: "lbl", text: t("acct.type") }),
      radioGroup(t("acct.type"), [{ v: "business", content: el("strong", { text: t("acct.type.business") }) }, { v: "residential", content: el("strong", { text: t("acct.type.residential") }) }],
        seg, function (v) { d.segment = v; save(); rerender(); }, "is-inline"),
      el("div", { class: "iri-ord-grid is-2" },
        seg === "business" ? field(t("acct.company"), input("company", d.company, { autocomplete: "organization" }), { name: "company", cls: "is-full" }) : null,
        field(t("acct.first"), input("firstName", d.firstName, { autocomplete: "given-name" }), { name: "firstName" }),
        field(t("acct.last"), input("lastName", d.lastName, { autocomplete: "family-name" }), { name: "lastName" }),
        field(t("acct.email"), input("email", d.email, { type: "email", autocomplete: "email" }), { name: "email", help: t("acct.emailHelp") }),
        field(t("acct.phone"), input("phone", d.phone, { type: "tel", autocomplete: "tel" }), { name: "phone" }),
        field(t("acct.address"), input("address1", d.address1, { autocomplete: "address-line1" }), { name: "address1", cls: "is-full" }),
        field(t("acct.city"), input("city", d.city, { autocomplete: "address-level2" }), { name: "city" }),
        field(t("acct.province"), select("province", provs, d.province), { name: "province" }),
        field(t("acct.postal"), input("postalCode", d.postalCode, { autocomplete: "postal-code", maxlength: "7" }), { name: "postalCode" })),
      el("div", { class: "iri-ord-actions" },
        el("a", { class: "iri-ord-btn is-secondary", href: url("find"), onclick: function (e) { e.preventDefault(); go("find"); } }, t("acct.back")),
        el("button", { type: "submit", class: "iri-ord-btn" }, t("acct.continue"), ic("chev"))));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector("[type=submit]"), body = { segment: seg };
      form.querySelectorAll("input,select").forEach(function (i) { if (i.name) body[i.name] = i.value; });
      busy(btn, true, t("busy.save"));
      postDetails(body).then(function () { go("connect"); })
        .catch(function (err) { busy(btn, false); if (err.handled) return; showErrors(form, err.data && err.data.errors); if (!(err.data && err.data.errors)) form.insertBefore(callout("error", "", errText(err)), form.firstChild); });
    });
    return form;
  }
  function signedInView() {
    var o = S.order, q = o.quote, a = S.acct, n = o.numbers.length;
    var elig = P && P.eligibility ? P.eligibility(o.numbers.map(metaOf), cfg.purchaseEnabled) : o.numbers.map(function (x) { return { did: x.did, display: x.display, rent: true, purchase: false, reasonKey: "plan.reason.notOnline" }; });
    var notPurch = elig.filter(function (x) { return !x.purchase; });
    var year = Number(q.setup) + 12 * Number(q.monthly);
    var rent = el("div", { class: "iri-ord-plan is-on" },
      el("div", { class: "top" }, el("span", { class: "dot is-on", "aria-hidden": "true" }), el("strong", { text: t("mode.rent.t") }), badge("ok", n === 1 ? t("plan.eligible1") : t("plan.eligibleAll"))),
      el("p", { class: "d", text: t("plan.rentD") }),
      el("dl", null, el("dt", { text: t("plan.setupToday") }), el("dd", { text: money(q.setup) }),
        el("dt", { text: t("plan.rental") }), el("dd", { text: t("tray.perMonth", { amt: money(q.monthly) }) }),
        el("dt", { text: t("plan.year") }), el("dd", { text: money(year) })));
    var purch = el("div", { class: "iri-ord-plan is-off", "aria-disabled": "true" },
      el("div", { class: "top" }, el("span", { class: "dot", "aria-hidden": "true" }), el("strong", { text: t("mode.purchase.t") }),
        badge("err", notPurch.length === n ? t("plan.notOnline") : tn("plan.notEligible", notPurch.length))),
      el("p", { class: "d", text: t("plan.purchD") }),
      notPurch.length ? el("div", { class: "why" }, ic("info"), el("div", null, notPurch.map(function (x) {
        return el("p", null, el("b", { text: x.display }), " ", t("plan.rentOnly"), " ", t(x.reasonKey), " ", x.example ? example() : null);
      }), el("p", { text: t("plan.noSwap") }))) : null,
      el("p", { class: "d is-muted", text: t("plan.noCompare") }));
    var main = [
      head(t("acct.inTitle"), t("acct.inLede")),
      S.notice || null,
      el("div", { class: "iri-ord-card" },
        el("div", { class: "iri-ord-acctrow" }, el("span", { class: "iri-ord-avatar", "aria-hidden": "true", text: a.initials }),
          el("div", null, el("strong", null, a.name, " ", example()), el("small", { text: t("acct.sub", { type: t("acct.type." + a.type), masked: a.masked }) })),
          el("button", { type: "button", class: "iri-ord-link", onclick: function () { S.acct = null; S.acctTab = "signin"; save(); rerender(); } }, t("acct.switch"))),
        callout("success", "", t("acct.noChange"))),
      el("section", { class: "iri-ord-card", "aria-labelledby": "iri-ord-plan-h" },
        el("div", { class: "iri-ord-cardhead" }, el("h2", { id: "iri-ord-plan-h", text: t("plan.title") }), el("small", { text: t("plan.until") })),
        el("div", { class: "iri-ord-plans" }, rent, purch),
        el("p", { class: "iri-ord-help is-foot", text: S.demo ? t("plan.footEx") : t("plan.foot") })),
      el("div", { class: "iri-ord-actions is-end" },
        el("a", { class: "iri-ord-btn is-secondary", href: url("find"), onclick: function (e) { e.preventDefault(); go("find"); } }, t("plan.back")),
        el("button", { type: "button", class: "iri-ord-btn is-lg", onclick: function () { go("connect"); } }, t("plan.keepRent"), ic("chev")))];
    frame("account", main, { focus: !S.rendered.account, bar: mobileBar(tn("tray.count", n), t("mbar.today", { amt: money(q.dueToday) }), t("mbar.continue"), function () { go("connect"); }) });
    S.rendered.account = true; S.notice = null;
  }

  // ---------- step 3: connect ----------
  function pathOf() { var u = S.token ? ui() : {}; return (u.conn && u.conn.path) || (S.order && S.order.connect && S.order.connect.type) || "pbx"; }
  function seedConn() {
    var c = S.order.connect, saved = S.acct && S.acct.connections && S.acct.connections[0];
    if (c) {
      var m = { static: "ip", dynamic: "reg", managed: "managed" }[c.method] || "reg";
      return { path: c.type || "pbx", savedId: null, method: m, platform: c.platform, host: c.host, port: c.port, transport: c.transport, failover: c.failover,
        provider: c.provider, forwardTo: c.forwardTo, notes: c.notes, label: "", same: true, per: {} };
    }
    return { path: "pbx", savedId: saved ? saved.id : null, method: "reg", port: "5060", transport: "udp", same: true, per: {} };
  }
  function savedConns() { return (S.demo && S.acct && S.acct.connections) || []; }
  function connOf(id) { return savedConns().filter(function (x) { return x.id === id; })[0]; }
  function destLabel(c, did) {
    if (c.path === "iristel") return t("path.short.iristel");
    if (c.path === "forward") return c.forwardTo ? t("dest.fwd", { n: fmt(String(c.forwardTo).replace(/\D/g, "").slice(-10)) }) : t("path.short.forward");
    var id = !c.same && c.per[did] ? c.per[did] : c.savedId;
    var s = id && id !== "new" ? connOf(id) : null;
    return s ? s.label : c.label || (c.platform ? c.platform : t("dest.newConn"));
  }
  function connectStep() {
    if (S.sub === "e911") return e911Step();
    S.view = "connect"; S.render = connectStep;
    var o = S.order, u = ui(), c = u.conn = u.conn || seedConn();
    function set(k, v) { c[k] = v; save(); rerender(); }
    var paths = [
      { v: "pbx", content: [el("div", { class: "pt" }, ic("plug"), el("strong", { text: t("path.pbx") })), el("p", { text: t("path.pbx.d") }),
        el("dl", null, el("dt", { text: t("rate.ca") }), el("dd", { text: t("rate.perMin", { amt: money(RATES.ca, 3) }) }),
          el("dt", { text: t("rate.us") }), el("dd", { text: t("rate.perMin", { amt: money(RATES.us, 3) }) }),
          el("dt", { text: t("rate.e911") }), el("dd", { text: t("rate.perCall", { amt: money(RATES.e911) }) }),
          el("dt", { text: t("rate.in") }), el("dd", { text: t("rate.incl") }))] },
      { v: "iristel", content: [el("div", { class: "pt" }, ic("cloud"), el("strong", { text: t("path.iristel") })), el("p", { text: t("path.iristel.d") }),
        el("dl", null, el("dt", { text: t("rate.na") }), el("dd", { text: t("rate.unlimited") }),
          el("dt", { text: t("rate.e911s") }), el("dd", { text: t("rate.noExtra") }),
          el("dt", { text: t("rate.plan") }), el("dd", { text: t("rate.planShown") })), el("p", { class: "fine", text: t("rate.fair") })] },
      { v: "forward", content: [el("div", { class: "pt" }, ic("fwd"), el("strong", { text: t("path.forward") })), el("p", { text: t("path.forward.d") })] }
    ];
    var form = el("form", { class: "iri-ord-connect", novalidate: true, oninput: function (e) { if (e.target.name && e.target.name !== "per") { c[e.target.name] = e.target.value; save(); } } });
    add(form, [
      radioGroup(t("path.label"), paths, c.path, function (v) { set("path", v); }, "is-paths"),
      el("p", { class: "iri-ord-sub" }, el("button", { type: "button", class: "iri-ord-link", "aria-expanded": String(!!S.help), onclick: function () { S.help = S.help ? null : { step: 1 }; rerender(); } }, ic("sparkle"), t("help.open")),
        " · ", t("path.usageNote")),
      S.help ? helpChoose(c) : null]);
    if (c.path === "pbx") add(form, pbxFields(c, set));
    else if (c.path === "forward") form.appendChild(el("div", { class: "iri-ord-card" }, el("div", { class: "iri-ord-grid is-2" },
      field(t("conn.fwdTo"), input("forwardTo", c.forwardTo, { type: "tel", autocomplete: "tel" }), { name: "forwardTo", help: t("conn.fwdHelp") }))));
    else form.appendChild(el("div", { class: "iri-ord-card" }, el("div", { class: "iri-ord-grid is-2" },
      field(t("conn.service"), el("textarea", { name: "notes", text: c.notes || "", placeholder: t("conn.servicePh") }), { name: "notes", cls: "is-full", help: t("conn.serviceHelp") }))));
    form.appendChild(destTable(c, set));
    form.appendChild(el("div", { class: "iri-ord-actions is-end is-split" },
      el("p", { class: "iri-ord-help" }, t("conn.todayNote")),
      el("button", { type: "submit", class: "iri-ord-btn is-lg" }, t("conn.continue"), ic("chev"))));
    form.addEventListener("submit", function (e) { e.preventDefault(); saveConnect(form, c); });
    frame("connect", [head(t("conn.title"), t("conn.lede")), S.notice || null, form], { focus: !S.rendered.connect,
      bar: mobileBar(tn("tray.count", o.numbers.length), t("mbar.today", { amt: money(o.quote.dueToday) }), t("mbar.continue"), function () { form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit")); }) });
    S.rendered.connect = true; S.notice = null;
  }
  function pbxFields(c, set) {
    var out = [], saved = savedConns();
    if (saved.length) {
      out.push(el("section", { class: "iri-ord-card", "aria-labelledby": "iri-ord-saved-h" },
        el("div", { class: "iri-ord-cardhead" }, el("h2", { id: "iri-ord-saved-h", text: t("conn.saved") }),
          el("button", { type: "button", class: "iri-ord-link", onclick: function () { set("savedId", null); } }, ic("plus"), t("conn.new"))),
        el("div", { class: "iri-ord-savedlist", role: "radiogroup", "aria-label": t("conn.saved") }, saved.map(function (s) {
          var tested = s.testedAt || s.lastTest, id = "iri-ord-sv-" + s.id, on = c.savedId === s.id;
          return el("div", { class: "iri-ord-saved" + (on ? " is-on" : "") },
            el("input", { type: "radio", name: "savedConn", id: id, value: s.id, checked: on || null, onchange: function () { set("savedId", s.id); } }),
            el("label", { for: id }, el("strong", { text: s.label }), " ", el("span", { class: "meta", text: t("method.short." + s.method) + " · " + s.host + ":" + s.port + " · " + s.transport.toUpperCase() }),
              el("small", null, t("conn.lastTest", { date: day(tested) }), " ", example())),
            el("div", { class: "r" }, s.reachable ? el("span", { class: "iri-ord-ok" }, ic("dot"), t("conn.reachable")) : null,
              el("button", { type: "button", class: "iri-ord-btn is-small is-secondary", "aria-label": t("conn.test") + " — " + s.label, onclick: function (e) { testConn(s, e.currentTarget); } }, ic("refresh"), t("conn.test"))));
        }))));
    }
    if (!saved.length || !c.savedId) out.push(newConnection(c, set));
    return out;
  }
  function newConnection(c, set) {
    var m = c.method || "reg";
    var methods = ["reg", "ip", "managed"].map(function (k) { return { v: k, content: [el("strong", { text: t("method." + k) }), el("span", { text: t("method." + k + ".d") })] }; });
    var g = el("div", { class: "iri-ord-grid is-2" });
    if (m !== "managed") g.appendChild(field(t("conn.platform"), select("platform", [["", t("f.choose")]].concat(PLATFORMS.map(function (p) { return [p, p]; })).concat([["Other", t("conn.other")]]), c.platform), { name: "platform" }));
    g.appendChild(field(t("conn.label"), input("label", c.label, { placeholder: t("conn.labelPh") }), { name: "label", help: t("conn.labelHelp") }));
    if (m === "ip") add(g, [
      field(t("conn.host"), input("host", c.host, { placeholder: "203.0.113.10 / sip.example.com", autocomplete: "off", spellcheck: "false" }), { name: "host", cls: "is-full", help: t("conn.hostHelp") }),
      field(t("conn.port"), input("port", c.port || "5060", { inputmode: "numeric" }), { name: "port" }),
      field(t("conn.transport"), select("transport", [["udp", "UDP"], ["tcp", "TCP"], ["tls", "TLS"]], c.transport), { name: "transport" }),
      field(t("conn.failover"), input("failover", c.failover, { autocomplete: "off", spellcheck: "false" }), { name: "failover", cls: "is-full" })]);
    if (m === "reg") g.appendChild(el("div", { class: "iri-ord-field is-full" }, callout("", "", t("conn.regNote"), null, "lock")));
    if (m === "managed") g.appendChild(field(t("conn.provider"), input("provider", c.provider, { placeholder: t("conn.providerPh") }), { name: "provider", cls: "is-full", help: t("conn.providerHelp") }));
    g.appendChild(field(t("conn.notes"), el("textarea", { name: "notes", text: c.notes || "" }), { name: "notes", cls: "is-full", help: t("conn.notesHelp") }));
    return el("section", { class: "iri-ord-card", "aria-labelledby": "iri-ord-new-h" },
      el("div", { class: "iri-ord-cardhead" }, el("h2", { id: "iri-ord-new-h", text: t("conn.newT") }),
        savedConns().length ? el("button", { type: "button", class: "iri-ord-link", onclick: function () { set("savedId", savedConns()[0].id); } }, t("conn.useSaved")) : null),
      el("ul", { class: "iri-ord-checklist" }, ["1", "2", "3"].map(function (i) { return el("li", null, ic("check"), t("conn.ready." + i)); })),
      el("div", { class: "lbl", text: t("conn.method") }),
      radioGroup(t("conn.method"), methods, m, function (v) { set("method", v); }, "is-3"), g);
  }
  function testConn(s, btn) {
    if (!P) return;
    busy(btn, true, t("busy.test"));
    P.testConnection(s).then(function (r) { s.reachable = r.ok; s.testedAt = r.at; save(); rerender(); say(r.ok ? t("conn.testOk", { label: s.label }) : t("conn.testFail")); });
  }
  function destTable(c, set) {
    var o = S.order, u = ui(), e911 = u.e911 && u.e911.done;
    var opts = savedConns().map(function (s) { return [s.id, s.label]; }).concat([["new", t("dest.newConn")]]);
    var canPer = c.path === "pbx" && opts.length > 1;
    var rows = o.numbers.map(function (n) {
      var nn = metaOf(n), s = c.path === "pbx" ? connOf(!c.same && c.per[n.did] ? c.per[n.did] : c.savedId) : null;
      var ready = c.path === "pbx" ? !!(s && s.reachable) : false;
      return el("tr", null,
        el("th", { scope: "row" }, el("span", { class: "iri-ord-num is-sm", text: n.display }), nn.match ? el("span", { class: "word", text: nn.match.full }) : null),
        el("td", null, !c.same && canPer ? select("per", opts, c.per[n.did] || c.savedId || "new") : destLabel(c, n.did)),
        el("td", { text: c.path === "forward" ? t("cap.in") : t("cap.inout") }),
        el("td", null, e911 ? badge("ok", t("e911.done")) : badge("err", t("e911.reqNext"))),
        el("td", null, ready ? el("span", { class: "iri-ord-ok" }, ic("check"), t("dest.ready")) : el("span", { class: "iri-ord-muted", text: t("dest.later") })));
    });
    var tbl = el("table", { class: "iri-ord-table" }, el("thead", null, el("tr", null, ["num", "dest", "cap", "e911", "check"].map(function (k) { return el("th", { scope: "col", text: t("dest.col." + k) }); }))),
      el("tbody", { onchange: function (e) { if (e.target.name === "per") { var tr = e.target.closest("tr"), i = Array.prototype.indexOf.call(tr.parentNode.children, tr); c.per[o.numbers[i].did] = e.target.value; save(); rerender(); } } }, rows));
    return el("section", { class: "iri-ord-card is-flush", "aria-labelledby": "iri-ord-dest-h" },
      el("div", { class: "iri-ord-cardhead" }, el("h2", { id: "iri-ord-dest-h", text: t("dest.title") }),
        canPer ? toggleSwitch(t("dest.same"), c.same, function (v) { set("same", v); }) : null),
      el("div", { class: "iri-ord-tablewrap" }, stacked(tbl)),
      el("div", { class: "iri-ord-pad" }, callout("", "", t("dest.incl." + c.path))));
  }
  // Help me choose: three questions at most, deterministic, recommends only supported paths
  function helpChoose(c) {
    var h = S.help, box = el("div", { class: "iri-ord-help-choose", role: "group", "aria-label": t("help.open") });
    function ask(q, answers) {
      return [el("p", { class: "q", text: t(q) }), el("div", { class: "iri-ord-try is-tight" }, answers.map(function (a) {
        return el("button", { type: "button", class: "iri-ord-pill", onclick: a[1] }, t(a[0]));
      }))];
    }
    function rec(p) { S.help = { step: 9, rec: p }; rerender(); }
    if (h.step === 1) add(box, ask("help.q1", [["help.yes", function () { rec("pbx"); }], ["help.no", function () { S.help = { step: 2 }; rerender(); }], ["help.unsure", function () { S.help = { step: 2 }; rerender(); }]]));
    else if (h.step === 2) add(box, ask("help.q2", [["help.yes", function () { rec("iristel"); }], ["help.no", function () { S.help = { step: 3 }; rerender(); }]]));
    else if (h.step === 3) add(box, ask("help.q3", [["help.yes", function () { rec("forward"); }], ["help.no", function () { rec("iristel"); }]]));
    else add(box, [el("p", { class: "q" }, t("help.rec"), " ", el("strong", { text: t("path." + h.rec) })), el("p", { class: "iri-ord-help", text: t("help.why." + h.rec) }),
      el("div", { class: "iri-ord-actions" }, el("button", { type: "button", class: "iri-ord-btn is-small", onclick: function () { c.path = h.rec; S.help = null; save(); rerender(); } }, t("help.use")),
        el("button", { type: "button", class: "iri-ord-btn is-small is-ghost", onclick: function () { S.help = null; rerender(); } }, t("help.close")))]);
    return box;
  }
  // Map the UI choice onto today's /connect contract (pbx/iristel/forward, static/dynamic/managed)
  function connectBody(c) {
    if (c.path === "forward") return { type: "forward", forwardTo: c.forwardTo };
    if (c.path === "iristel") return { type: "iristel", notes: c.notes };
    var s = c.savedId ? connOf(c.savedId) : null;
    if (s) return { type: "pbx", method: s.method === "ip" ? "static" : s.method === "managed" ? "managed" : "dynamic", platform: s.platform, host: s.host, port: s.port, transport: s.transport, notes: "Saved connection: " + s.label };
    var m = c.method === "ip" ? "static" : c.method === "managed" ? "managed" : "dynamic";
    return { type: "pbx", method: m, platform: c.platform === "Other" ? (c.label || "Other") : c.platform, host: c.host, port: c.port, transport: c.transport,
      failover: c.failover, provider: c.provider, notes: [c.label ? "Label: " + c.label : "", c.notes || ""].filter(Boolean).join(" · ") };
  }
  function saveConnect(form, c) {
    var btn = form.querySelector("[type=submit]");
    busy(btn, true, t("busy.check"));
    api("/connect", { body: connectBody(c) }).then(function (j) {
      S.order = j.order; save();
      S.sub = "e911";
      try { history.pushState(null, "", location.pathname + location.search + "#e911"); } catch (e) {}
      window.scrollTo(0, 0);
      S.rendered.e911 = false;
      e911Step();
    }).catch(function (err) {
      busy(btn, false);
      if (err.handled) return;
      var errs = err.data && err.data.errors;
      if (errs) {
        if (errs.platform && c.path === "pbx" && c.method !== "managed") { /* shown on the field */ }
        showErrors(form, errs);
        var miss = Object.keys(errs).filter(function (k) { return !form.querySelector('[data-field="' + k + '"]'); });
        if (miss.length) form.insertBefore(callout("error", "", miss.map(function (k) { return errs[k]; }).join(" ")), form.firstChild);
      } else form.insertBefore(callout("error", "", errText(err)), form.firstChild);
    });
  }

  // ---------- step 3b: 9-1-1 service address (D3, D9, D11; AD01–AD04) ----------
  function acctAddr() {
    if (S.acct && S.demo) { var a = S.acct.address; return { street: a.street, city: a.city, province: a.province, postalCode: a.postalCode, validated: true, source: "account" }; }
    var d = S.order && S.order.details;
    if (d && d.address1) return { street: d.address1, city: d.city, province: d.province, postalCode: d.postalCode, validated: false, source: "billing" }; // typed by the customer, not checked against Canada Post
    return null;
  }
  function addrLine(a) { return a ? [a.street, a.city + " " + a.province + " " + a.postalCode].join(", ") : ""; }
  function e911Step() {
    S.view = "e911"; S.render = e911Step;
    var o = S.order, u = ui(), home = acctAddr();
    var e = u.e911 = u.e911 || { all: true, pick: { choice: home ? "account" : "other" }, per: {}, confirms: [false, false, false], rcOk: false };
    var form = el("form", { class: "iri-ord-e911", novalidate: true });
    var addrCard = el("section", { class: "iri-ord-card", "aria-label": t("e911.addrLabel") },
      e.all ? addressPicker(e.pick, "all", home) : null,
      toggleSwitch(t("e911.allSame"), e.all, function (v) { e.all = v; save(); rerender(); }, "iri-ord-e911-all"),
      e.all ? el("p", { class: "iri-ord-right" }, el("button", { type: "button", class: "iri-ord-link", onclick: function () { e.all = false; save(); rerender(); } }, t("e911.each"))) : null,
      !e.all ? el("div", { class: "iri-ord-per" }, o.numbers.map(function (n) {
        var p = e.per[n.did] = e.per[n.did] || { choice: home ? "account" : "other" };
        return el("fieldset", { class: "iri-ord-perrow" }, el("legend", null, el("span", { class: "iri-ord-num is-sm", text: n.display })), addressPicker(p, n.did, home));
      })) : null,
      rateCheck(e, home));
    var terms = el("section", { class: "iri-ord-card is-terms", "aria-labelledby": "iri-ord-terms-h" },
      el("div", { class: "iri-ord-cardhead" }, el("h2", { id: "iri-ord-terms-h" }, ic("warn"), t("e911.diffT")),
        el("a", { class: "iri-ord-link", href: TERMS_URL + "#section-3", target: "_blank", rel: "noopener" }, t("e911.readTerms"), el("span", { class: "sr", text: t("newtab") }))),
      el("ul", { class: "iri-ord-bullets" }, [1, 2, 3, 4].map(function (i) { return el("li", { text: t("e911.b" + i) }); })),
      S.lang === "fr" ? el("p", { class: "iri-ord-help", text: t("e911.frNote") }) : null,
      el("h3", { text: t("e911.required") + " " + t("e911.toContinue") }),
      el("div", { class: "iri-ord-field", "data-field": "confirms" }, [0, 1, 2].map(function (i) {
        var lbl = i === 0 ? [t("e911.c1a"), el("a", { href: TERMS_URL + "#section-3", target: "_blank", rel: "noopener", text: t("e911.c1link") }), t("e911.c1b")] : t("e911.c" + (i + 1));
        return checkbox("c" + i, e.confirms[i], lbl, function (v) { e.confirms[i] = v; save(); hint(); });
      }), el("div", { class: "iri-ord-error", "aria-live": "polite" })),
      el("p", { class: "iri-ord-help is-foot", text: t("e911.foot") }));
    var hintEl = el("p", { class: "iri-ord-help", id: "iri-ord-e911-hint" });
    function hint() { var miss = e911Missing(e, home); hintEl.textContent = miss.length ? t("e911.missing", { list: miss.join(" ") }) : ""; }
    add(form, [addrCard, terms, el("div", { class: "iri-ord-actions is-end is-split" }, hintEl,
      el("div", { class: "iri-ord-actions-in" },
        el("button", { type: "button", class: "iri-ord-btn is-secondary", onclick: function () { S.sub = null; try { history.pushState(null, "", location.pathname + location.search); } catch (x) {} connectStep(); } }, t("e911.back")),
        el("button", { type: "submit", class: "iri-ord-btn is-lg", "aria-describedby": "iri-ord-e911-hint" }, t("e911.continue"), ic("chev"))))]);
    hint();
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var miss = e911Missing(e, home);
      if (miss.length) {
        var box = form.querySelector(".iri-ord-errsum"); if (box) box.parentNode.removeChild(box);
        var sum = el("div", { class: "iri-ord-callout is-error iri-ord-errsum", role: "alert", tabindex: "-1" }, ic("warn"),
          el("div", null, el("strong", { text: t("e911.errT") }), el("ul", null, miss.map(function (m) { return el("li", { text: m }); }))));
        form.insertBefore(sum, form.firstChild); sum.focus();
        return;
      }
      e.done = true; e.termsVersion = TERMS_VERSION; e.lang = S.lang; e.at = new Date().toISOString(); save();
      go("review");
    });
    frame("connect", [head(t("e911.title"), S.acct && S.demo ? t("e911.lede") + " " + t("e911.ledePre") : t("e911.lede"), chip(t("e911.badge"), "is-err")), S.notice || null, form],
      { focus: !S.rendered.e911, bar: mobileBar(tn("tray.count", o.numbers.length), t("mbar.today", { amt: money(o.quote.dueToday) }), t("mbar.continue"), function () { form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit")); }) });
    S.rendered.e911 = true; S.notice = null;
  }
  function e911Missing(e, home) {
    var miss = [];
    var picks = e.all ? [e.pick] : S.order.numbers.map(function (n) { return e.per[n.did] || {}; });
    if (picks.some(function (p) { return !pickAddr(p, home); })) miss.push(t("e911.m.addr"));
    if (e.confirms.indexOf(false) >= 0) miss.push(t("e911.m.confirm"));
    if (rcStatus(e, home).mismatch && !e.rcOk) miss.push(t("e911.m.rc"));
    return miss;
  }
  function pickAddr(p, home) {
    if (p.choice === "account") return home;
    var a = p.addr;
    if (!a) return null;
    if (a.manual && !(a.street && a.city && a.province && /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i.test(a.postalCode || ""))) return null;
    return a;
  }
  // One address picker: the account address, or a Canada Post-style search with manual entry
  function addressPicker(p, key, home) {
    var items = [];
    if (home) items.push({ v: "account", content: el("div", { class: "iri-ord-addr" },
      el("div", null, el("strong", { text: t(home.source === "account" ? "e911.useAcct" : "e911.useBilling") }), el("span", null, addrLine(home), " ", home.source === "account" ? example() : null)),
      home.validated ? el("span", { class: "iri-ord-ok" }, ic("check"), t("e911.verified")) : badge("warn", t("e911.notValidated"))) });
    items.push({ v: "other", content: el("strong", { text: t("e911.useOther") }) });
    return el("div", { class: "iri-ord-addrpick" }, radioGroup(t("e911.addrLabel") + (key === "all" ? "" : " " + key), items, p.choice, function (v) { p.choice = v; save(); rerender(); }, "is-list"),
      p.choice === "other" ? addressSearch(p, key) : null);
  }
  function addressSearch(p, key) {
    var a = p.addr, id = "iri-ord-as-" + key, live = !!(S.demo && P);
    var wrap = el("div", { class: "iri-ord-asearch" });
    if (a && !a.manual) {
      wrap.appendChild(el("div", { class: "iri-ord-picked" }, el("span", null, addrLine(a), " ", example()), el("span", { class: "iri-ord-ok" }, ic("check"), t("e911.verified")),
        el("button", { type: "button", class: "iri-ord-link", onclick: function () { p.addr = null; save(); rerender(); } }, t("e911.change"))));
      return wrap;
    }
    if (p.manual || !live) {
      var m = p.addr && p.addr.manual ? p.addr : (p.addr = { manual: true, street: "", city: "", province: "", postalCode: "" });
      var provs = [["", t("f.choose")]].concat(cat.provinces.map(function (x) { return [x.code, x.name]; }));
      var g = el("div", { class: "iri-ord-grid is-2", oninput: function (ev) { if (ev.target.name) { m[ev.target.name.replace(key + "-", "")] = ev.target.value; save(); } },
        onchange: function (ev) { if (ev.target.name) { m[ev.target.name.replace(key + "-", "")] = ev.target.value; save(); } } },
        field(t("acct.address"), input(key + "-street", m.street, { autocomplete: "street-address" }), { name: "street", cls: "is-full" }),
        field(t("acct.city"), input(key + "-city", m.city, { autocomplete: "address-level2" }), { name: "city" }),
        field(t("acct.province"), select(key + "-province", provs, m.province), { name: "province" }),
        field(t("acct.postal"), input(key + "-postalCode", m.postalCode, { autocomplete: "postal-code", maxlength: "7" }), { name: "postalCode" }));
      add(wrap, [!live ? callout("", "", t("e911.noLookup")) : null, g, el("p", { class: "iri-ord-help" }, badge("warn", t("e911.notValidated")), " ", t("e911.manualNote")),
        live ? el("button", { type: "button", class: "iri-ord-link", onclick: function () { p.manual = false; p.addr = null; save(); rerender(); } }, t("e911.backSearch")) : null]);
      return wrap;
    }
    var list = el("ul", { class: "iri-ord-listbox", role: "listbox", id: id + "-list", hidden: true });
    var inp = el("input", { type: "text", id: id, role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": id + "-list",
      autocomplete: "off", placeholder: t("e911.searchPh"), value: p.q || "" });
    var timerA, active = -1, cands = [];
    function draw() {
      list.textContent = "";
      cands.forEach(function (c, i) {
        list.appendChild(el("li", { role: "option", id: id + "-o" + i, "aria-selected": String(i === active), class: i === active ? "is-active" : "",
          onmousedown: function (ev) { ev.preventDefault(); choose(c); } }, ic("pin"), el("span", null, el("b", { text: c.street }), " ", c.city + " " + c.province + " " + c.postalCode)));
      });
      list.hidden = !cands.length;
      inp.setAttribute("aria-expanded", String(!!cands.length));
      if (active >= 0) inp.setAttribute("aria-activedescendant", id + "-o" + active); else inp.removeAttribute("aria-activedescendant");
    }
    function choose(c) { p.addr = { street: c.street, city: c.city, province: c.province, postalCode: c.postalCode, validated: true, source: "Canada Post", example: true }; p.q = ""; save(); rerender(); say(t("e911.chosen", { a: addrLine(p.addr) })); }
    inp.addEventListener("input", function () {
      p.q = inp.value; clearTimeout(timerA);
      timerA = setTimeout(function () { P.findAddress(inp.value).then(function (r) { cands = r; active = -1; draw(); say(tn("e911.matches", r.length)); }); }, 200);
    });
    inp.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown" && cands.length) { ev.preventDefault(); active = (active + 1) % cands.length; draw(); }
      else if (ev.key === "ArrowUp" && cands.length) { ev.preventDefault(); active = (active - 1 + cands.length) % cands.length; draw(); }
      else if (ev.key === "Enter" && active >= 0) { ev.preventDefault(); choose(cands[active]); }
      else if (ev.key === "Escape") { cands = []; draw(); }
    });
    add(wrap, [el("label", { for: id, text: t("e911.street") }), el("div", { class: "iri-ord-combo" }, ic("pin"), inp, list),
      el("p", { class: "iri-ord-help" }, t("e911.cpNote"), " ", el("button", { type: "button", class: "iri-ord-link", onclick: function () { p.manual = true; p.addr = null; save(); rerender(); } }, t("e911.manual")))]);
    return wrap;
  }
  // Rate-centre check: the numbers' rate centre against the chosen address (AD03; mismatch rule pending approval)
  function rcStatus(e, home) {
    var res = { mismatch: false, rows: [] };
    S.order.numbers.forEach(function (n) {
      var a = pickAddr(e.all ? e.pick : (e.per[n.did] || {}), home);
      if (!a) return;
      var city = cityOf(n), prov = provOf(n);
      var same = city ? norm(city) === norm(a.city) : !prov || prov === a.province;
      res.rows.push({ n: n, city: city || (prov ? prov : ""), a: a, same: same, known: !!city });
      if (!same) res.mismatch = true;
    });
    return res;
  }
  function rateCheck(e, home) {
    var r = rcStatus(e, home);
    if (!r.rows.length) return null;
    if (!r.mismatch) {
      var cities = r.rows.filter(function (x) { return x.known; }).map(function (x) { return x.city; }).filter(function (c, i, a) { return a.indexOf(c) === i; });
      return el("div", { class: "iri-ord-rc is-ok" }, ic("pin"), el("div", null,
        el("p", null, cities.length ? tn("e911.rcOk", r.rows.length, { rc: cities.join(", ") }) : t("e911.rcProv"), " ", example()),
        el("small", null, t("e911.rcRule"), " ", chip(t("e911.pending"), "is-ex"))));
    }
    var bad = r.rows.filter(function (x) { return !x.same; });
    return el("div", { class: "iri-ord-rc is-warn", role: "status" }, ic("warn"), el("div", null,
      el("p", null, el("strong", { text: t("e911.rcWarnT") }), " ", bad.map(function (x) { return t("e911.rcWarn", { n: x.n.display, rc: x.city || "?", city: x.a.city }); }).join(" ")),
      checkbox("rcOk", e.rcOk, t("e911.rcConfirm"), function (v) { e.rcOk = v; save(); var h = document.getElementById("iri-ord-e911-hint"); if (h) h.textContent = e911Missing(e, home).length ? t("e911.missing", { list: e911Missing(e, home).join(" ") }) : ""; }),
      el("small", null, t("e911.rcNoSwap"), " ", chip(t("e911.pending"), "is-ex"))));
  }

  // ---------- step 4: review and pay ----------
  // Same rule as the server (one month from payment, as YYYY-MM-DD) so Review and Activate agree
  function nextBill() {
    if (S.order && S.order.nextBill) return S.order.nextBill;
    var d = new Date(); d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 10);
  }
  function usageSentence(path) {
    if (path === "iristel") return t("sum.usageIristel");
    if (path === "forward") return t("sum.usageFwd");
    return t("sum.usagePbx", { ca: money(RATES.ca, 3), us: money(RATES.us, 3), e911: money(RATES.e911) });
  }
  function reviewStep(notice) {
    S.view = "review"; S.render = function () { reviewStep(); };
    var o = S.order, q = o.quote, u = ui(), c = u.conn || seedConn(), e = u.e911, path = c.path, n = o.numbers.length;
    if (!e || !e.done) { S.notice = callout("warning", t("rev.needE911T"), t("rev.needE911")); return go("connect", "#e911"); }
    var monthlyIncl = Number(q.monthly) + Number(q.monthlyTax);
    var summary = el("div", { class: "iri-ord-summary" }, ic("doc"), el("div", null,
      el("p", { class: "big" }, el("b", { text: t("sum.today", { amt: money(q.dueToday) }) }), " ",
        S.mode === "rent" ? tn("sum.after", n, { amt: money(monthlyIncl), date: day(nextBill()) }) : "", " ", usageSentence(path), " ", example()),
      el("small", { text: t(q.approved ? "sum.note" : "sum.noteEx", { ref: o.ref, tax: pct(q.taxRate) }) })));
    var addrFor = function (did) { var h = acctAddr(); var a = pickAddr(e.all ? e.pick : (e.per[did] || {}), h); return a ? a.street : ""; };
    var nums = el("ul", { class: "iri-ord-lines-n" }, o.numbers.map(function (x) {
      var mm = metaOf(x), l = lineOf(x.did);
      return el("li", null, el("div", null, el("b", { class: "iri-ord-num is-sm", text: x.display }),
        el("small", { text: [catLabel(catOf(mm)), mm.match ? mm.match.full : null, t("mode." + S.mode), destLabel(c, x.did), t("rev.e911at", { a: addrFor(x.did) })].filter(Boolean).join(" · ") })),
        el("div", { class: "r" }, el("span", { text: t("res.setupAmt", { amt: money(l.setup) }) }), el("small", { text: t("tray.perMonth", { amt: money(l.monthly) }) }),
          serverRemovable(x.did) ? el("button", { type: "button", class: "iri-ord-link is-rm", "data-rm": x.did, "aria-label": t("chips.remove", { label: x.display }),
            onclick: function (ev) { removeNum(x, ev.currentTarget, true); } }, t("basket.remove")) : null));
    }));
    var line = function (k, v, cls) { return [el("dt", { class: cls || null }, k), el("dd", { class: cls || null }, v)]; };
    var usage = path === "iristel" ? [line(t("use.na"), t("rate.inclFair")), line(t("use.e911"), t("rate.incl")), line(t("use.in"), t("rate.incl"))]
      : path === "forward" ? [line(t("use.in"), t("rate.incl")), line(t("use.fwd"), t("use.fwdRate"))]
        : [line(t("use.ca"), t("rate.perMin", { amt: money(RATES.ca, 3) })), line(t("use.us"), t("rate.perMin", { amt: money(RATES.us, 3) })),
          line(t("use.e911p"), t("rate.perCallLong", { amt: money(RATES.e911) })), line(t("use.in"), t("rate.incl"), "muted")];
    var left = el("section", { class: "iri-ord-card", "aria-labelledby": "iri-ord-yn-h" },
      el("div", { class: "iri-ord-cardhead" }, el("h2", { id: "iri-ord-yn-h", text: t("rev.numbers") }),
        el("a", { class: "iri-ord-link", href: url("connect"), onclick: function (ev) { ev.preventDefault(); go("connect"); } }, ic("pencil"), t("rev.edit"))),
      nums,
      heldNow(o) ? el("p", { class: "iri-ord-rev-more" }, el("a", { class: "iri-ord-link", href: url("find"), onclick: function (ev) { ev.preventDefault(); if (!S.paying) go("find"); } }, ic("plus"), t("basket.change"))) : null,
      el("dl", { class: "iri-ord-dl" },
        line(tn("rev.setupN", n), money(q.setup)), line(t("rev.first"), money(q.firstMonth)),
        line(t("rev.sub"), money(q.subtotal)), line(t(q.approved ? "rev.tax" : "rev.taxEx", { tax: pct(q.taxRate) }), money(q.tax))),
      el("div", { class: "iri-ord-due" }, el("span", { text: t("rev.due") }), el("b", { text: money(q.dueToday) + " CAD" })),
      S.mode === "rent" ? el("dl", { class: "iri-ord-dl" }, line(t("rev.monthlyFrom", { date: day(nextBill()) }), t("rev.monthlyAmt", { amt: money(q.monthly), incl: money(monthlyIncl) }), "muted")) : null,
      el("h3", { class: "iri-ord-eb", text: t("rev.usageT") }),
      el("dl", { class: "iri-ord-dl" }, usage),
      path === "iristel" ? el("p", { class: "iri-ord-help", text: t("rev.planNote") }) : null);
    var right = payCard(o, q);
    frame("review", [head(t("rev.title")), notice || S.notice || null, summary, el("div", { class: "iri-ord-review" }, left, right)], { focus: !S.rendered.review });
    S.rendered.review = true; S.notice = null;
  }
  function payCard(o, q) {
    var cards = (S.demo && S.acct && S.acct.cards) || [];
    if (!S.payWith) S.payWith = cards.length ? cards.filter(function (c) { return c.isDefault; }).concat(cards)[0].id : "new";
    var useNew = S.payWith === "new" || !cards.length, d = o.details || {}, draft = S.cardDraft = S.cardDraft || {};
    var cardForm = null;
    if (useNew) {
      cardForm = el("div", { class: "iri-ord-newcard", oninput: function (ev) { if (ev.target.name && ev.target.name !== "cvv" && ev.target.name !== "number") draft[ev.target.name] = ev.target.value; } },
        S.demo ? callout("demo", t("pay.testT"), t("pay.test"), el("div", { class: "iri-ord-actions is-tight" }, el("button", { type: "button", class: "iri-ord-btn is-secondary is-small", text: t("pay.useTest"), onclick: function () {
          var set = function (nm, v) { var i = form.querySelector('[name="' + nm + '"]'); if (i) i.value = v; };
          set("holder", [d.firstName, d.lastName].join(" ").trim() || "Demo Customer"); set("number", "4242 4242 4242 4242");
          set("expMonth", "12"); set("expYear", String(new Date().getFullYear() + 1)); set("cvv", "123");
        } }))) : null,
        el("div", { class: "iri-ord-grid is-2" },
          field(t("pay.holder"), input("holder", draft.holder || "", { autocomplete: "cc-name" }), { name: "holder", cls: "is-full" }),
          field(t("pay.number"), input("number", "", { inputmode: "numeric", autocomplete: "cc-number", maxlength: "23" }), { name: "number", cls: "is-full" }),
          field(t("pay.expMonth"), select("expMonth", [["", "MM"]].concat(Array.from({ length: 12 }, function (_, i) { var m = String(i + 1).padStart(2, "0"); return [m, m]; })), draft.expMonth), { name: "expMonth" }),
          field(t("pay.expYear"), select("expYear", [["", t("pay.yyyy")]].concat(Array.from({ length: 12 }, function (_, i) { var y = String(new Date().getFullYear() + i); return [y, y]; })), draft.expYear), { name: "expYear" }),
          field(t("pay.cvv"), input("cvv", "", { inputmode: "numeric", autocomplete: "cc-csc", maxlength: "4" }), { name: "cvv", help: t("pay.cvvHelp") })));
    }
    var picks = cards.length ? radioGroup(t("pay.label"), cards.map(function (c) {
      return { v: c.id, content: el("div", { class: "iri-ord-cardopt" }, ic("card"), el("div", null, el("strong", null, c.brand + " •••• " + c.last4, c.isDefault ? el("small", { class: "tag", text: t("pay.default") }) : null),
        el("small", null, t("pay.expires", { exp: c.exp }), " ", c.note ? "· " + t("pay.note." + c.note) + " " : "", example()))) };
    }).concat([{ v: "new", content: [el("strong", { class: "has-ic" }, ic("plus"), t("pay.new")), el("small", { text: t("pay.newD") })] }]), S.payWith, function (v) { S.payWith = v; rerender(); }, "is-list") : null;
    var form = el("form", { class: "iri-ord-card iri-ord-pay", novalidate: true, "aria-labelledby": "iri-ord-pay-h" },
      el("div", { class: "iri-ord-cardhead" }, el("h2", { id: "iri-ord-pay-h", text: t("pay.title") }), cards.length ? el("small", { text: t("pay.fromMy") }) : el("small", { text: t("pay.secure") })),
      picks, cardForm,
      el("div", { "data-field": "consents", class: "iri-ord-field iri-ord-consents" },
        el("label", { class: "iri-ord-check" }, el("input", { type: "checkbox", name: "terms" }),
          el("span", null, t("pay.terms1"), el("a", { href: TERMS_URL, target: "_blank", rel: "noopener", text: t("pay.termsLink") }), t("pay.terms2"))),
        S.mode === "rent" ? el("label", { class: "iri-ord-check" }, el("input", { type: "checkbox", name: "recurring" }),
          el("span", { text: t("pay.recurring", { amt: money(q.monthly) }) })) : null,
        el("div", { class: "iri-ord-error", "aria-live": "polite" })),
      el("button", { type: "submit", class: "iri-ord-btn is-full is-lg" }, ic("lock"), S.demo ? t("pay.btnDemo", { amt: money(q.dueToday) }) : t("pay.btn", { amt: money(q.dueToday) })),
      el("p", { class: "iri-ord-help is-center", text: t("pay.once") }));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var btn = form.querySelector("[type=submit]"), f = function (nm) { var i = form.querySelector('[name="' + nm + '"]'); return i ? (i.type === "checkbox" ? i.checked : i.value) : ""; };
      var card;
      if (!useNew) { var sc = cards.filter(function (c) { return c.id === S.payWith; })[0]; card = { holder: S.acct.contact.firstName + " " + S.acct.contact.lastName, number: sc.number, expMonth: sc.expMonth, expYear: sc.expYear, cvv: "123" }; }
      else card = { holder: f("holder"), number: f("number"), expMonth: f("expMonth"), expYear: f("expYear"), cvv: f("cvv") };
      var consents = { terms: f("terms"), recurring: S.mode === "rent" ? f("recurring") : true };
      if (!consents.terms || !consents.recurring) return showErrors(form, { consents: S.mode === "rent" ? t("pay.needBoth") : t("pay.needTerms") });
      busy(btn, true, S.demo ? t("busy.payDemo") : t("busy.pay"));
      S.paying = true; mount.classList.add("is-paying");
      api("/pay", { body: { amount: q.dueToday, quoteVersion: q.version, consents: consents, card: card } })
        .then(function (j) { S.order = j.order; S.cardDraft = null; save(); go("order", "?ref=" + encodeURIComponent(j.order.ref) + "&t=" + encodeURIComponent(S.token)); })
        .catch(function (err) {
          // An unknown payment outcome keeps the basket locked (and Pay disabled) until the page is checked again
          if (err.code !== "PAYMENT_UNKNOWN" && err.code !== "PAYMENT_PENDING") { S.paying = false; mount.classList.remove("is-paying"); }
          var cv = form.querySelector('[name="cvv"]'); if (cv) cv.value = "";
          if (err.code === "PRICE_CHANGED" && err.data && err.data.order) { var old = S.order.quote; S.order = err.data.order; return reviewStep(priceChanged(old, S.order.quote)); }
          if (err.handled) return;
          busy(btn, false);
          if (err.code === "PAYMENT_UNKNOWN" || err.code === "PAYMENT_PENDING") {
            btn.disabled = true;
            form.insertBefore(callout("warning", t("pay.unknownT"), t("pay.unknown", { ref: (err.data && err.data.reference) || "" })), form.firstChild);
            return;
          }
          if (err.data && err.data.errors) return showErrors(form, err.data.errors);
          var old = form.querySelector("[data-pay-error]"); if (old) old.remove();
          var note = callout("error", err.code === "DECLINED" ? t("pay.declinedT") : "", err.code === "DECLINED" ? t("pay.declined") : errText(err));
          note.setAttribute("data-pay-error", "1"); note.setAttribute("tabindex", "-1");
          form.insertBefore(note, form.firstChild);
          // Focus the message so keyboard and screen-reader users hear why, then can tab to the card fields
          try { note.focus({ preventScroll: true }); } catch (x) { note.focus(); }
          note.scrollIntoView({ block: "center" });
        });
    });
    return form;
  }
  // Price changed: highlighted line-by-line difference; nothing changes silently (AT05, AT23)
  function priceChanged(oldQ, newQ) {
    var rows = [["rev.due", "dueToday"], ["rev.first", "firstMonth"], ["tray.setup", "setup"]].filter(function (r) { return oldQ && oldQ[r[1]] !== newQ[r[1]]; });
    return el("div", { class: "iri-ord-callout is-warning", role: "alert" }, ic("warn"), el("div", null,
      el("strong", { text: t("price.changedT") }),
      el("ul", null, rows.map(function (r) { return el("li", null, t(r[0]) + (S.lang === "fr" ? "\u00a0: " : ": "), el("s", { text: money(oldQ[r[1]]) }), " → ", el("b", { text: money(newQ[r[1]]) })); })),
      el("div", { class: "iri-ord-actions is-tight" },
        el("button", { type: "button", class: "iri-ord-btn is-small", onclick: function () { reviewStep(); say(t("price.accepted")); } }, t("price.accept")),
        el("button", { type: "button", class: "iri-ord-btn is-small is-secondary", onclick: function () { go("find"); } }, t("price.review")))));
  }

  // ---------- step 5: activate ----------
  function orderStep() {
    S.view = "order"; S.render = orderStep;
    var o = S.order, u = ui(), c = u.conn || (o.connect ? seedConnFrom(o.connect) : { path: "pbx", same: true, per: {} }), n = o.numbers.length;
    var active = o.state === "active", working = ["completing", "paying"].indexOf(o.state) >= 0;
    var p = o.payment || {}, q = o.quote || {};
    var headEl;
    if (active) headEl = el("div", { class: "iri-ord-done" }, el("span", { class: "big", "aria-hidden": "true" }, ic("check")), el("div", null,
      el("h1", { text: tn("act.activeT", n) }),
      el("p", { class: "lede", text: [o.demo ? t("act.paidDemo", { amt: money(p.amount) }) : t("act.paid", { amt: money(p.amount) }), o.demo ? t("act.noEmail") : t("act.receipt"), t("act.caps." + (c.path === "forward" ? "fwd" : "inout")), t("act.noSms")].join(" · ") })));
    else headEl = head(o.state === "delayed" ? t("act.delayedT") : o.state === "payment_unknown" ? t("pay.unknownT") : working ? t("act.workingT") : o.state === "expired" || o.state === "cancelled" ? t("act.notDoneT") : t("act.orderT", { ref: o.ref }),
      o.state === "delayed" ? t("act.delayed") : o.state === "payment_unknown" ? t("pay.unknown", { ref: p.reference || "" }) : working ? t("act.working") : o.state === "expired" || o.state === "cancelled" ? t("act.notDone") : "");
    var st = function (x) {
      var s = active ? ["ok", "act.s.active"] : o.state === "delayed" ? ["warn", "act.s.pending"] : o.state === "payment_unknown" ? ["warn", "act.s.payment"] : working ? ["info", "act.s.activating"] : ["muted", "act.s.none"];
      return el("span", { class: "iri-ord-status is-" + s[0] }, ic("dot"), t(s[1]));
    };
    var table = el("div", { class: "iri-ord-card is-flush" }, el("div", { class: "iri-ord-tablewrap" }, stacked(el("table", { class: "iri-ord-table" },
      el("thead", null, el("tr", null, ["num", "plan", "dest", "status", "since"].map(function (k) { return el("th", { scope: "col", text: t("act.col." + k) }); }))),
      el("tbody", null, o.numbers.map(function (x) {
        var mm = metaOf(x), l = lineOf(x.did);
        return el("tr", null, el("th", { scope: "row" }, el("span", { class: "iri-ord-num is-sm", text: x.display }), mm.match ? el("span", { class: "word", text: mm.match.full }) : null),
          el("td", { text: t("mode." + (o.model || "rent")) + " · " + t("tray.perMonth", { amt: money(l.monthly) }) }),
          el("td", { text: destLabel(c, x.did) }), el("td", null, st(x)), el("td", { text: active && o.activatedAt ? clock(o.activatedAt) : "—" }));
      }))))));
    var first = o.numbers[0];
    var spelled = first ? first.display + (metaOf(first).match ? " (" + spellText(metaOf(first)) + ")" : "") : "";
    var test = active ? el("section", { class: "iri-ord-card", "aria-labelledby": "iri-ord-test-h" },
      el("h2", { id: "iri-ord-test-h" }, ic("phone"), t("act.testT")),
      el("ol", { class: "iri-ord-steps-list" }, el("li", null, c.path === "forward" && c.forwardTo ? t("act.test1.fwd", { n: spelled, to: fmt(String(c.forwardTo).replace(/\D/g, "").slice(-10)) })
          : t("act.test1", { n: spelled, dest: first ? destLabel(c, first.did) : "" })),
        c.path !== "forward" ? el("li", { text: t("act.test2." + c.path) }) : null),
      el("p", null, el("strong", { text: t("act.no911") })),
      u.test ? callout(u.test.rang ? "success" : "", "", u.test.rang ? t("act.rangOk") : t("act.didntOk"))
        : el("div", { class: "iri-ord-actions is-tight" },
          el("button", { type: "button", class: "iri-ord-btn is-small", onclick: function () { u.test = { rang: true, at: new Date().toISOString() }; save(); rerender(); } }, ic("check"), t("act.rang")),
          el("button", { type: "button", class: "iri-ord-btn is-small is-secondary", onclick: function () { u.test = { rang: false, at: new Date().toISOString() }; S.handoff = { text: handoffText(o, c) }; save(); rerender(); } }, t("act.didnt"))),
      el("p", { class: "iri-ord-help", text: t("act.testNote") })) : null;
    var checks = checksCard(o, c, active, working);
    var actions = el("div", { class: "iri-ord-actions" },
      el("a", { class: "iri-ord-btn", href: MYIRISTEL, target: "_blank", rel: "noopener" }, t("act.manage"), el("span", { class: "sr", text: t("newtab") })),
      el("button", { type: "button", class: "iri-ord-btn is-secondary", "aria-expanded": String(!!S.guide), onclick: function () { S.guide = !S.guide; rerender(); } }, ic("doc"), t("act.guide")),
      el("button", { type: "button", class: "iri-ord-btn is-secondary", onclick: function () { window.print(); } }, ic("print"), t("act.receiptBtn")));
    var guide = S.guide ? el("section", { class: "iri-ord-card", "aria-labelledby": "iri-ord-guide-h" }, el("h2", { id: "iri-ord-guide-h", text: t("guide.t." + c.path) }),
      el("ol", { class: "iri-ord-steps-list" }, [1, 2, 3].map(function (i) { return el("li", { text: t("guide." + c.path + "." + i) }); })),
      el("p", { class: "iri-ord-help", text: t("guide.help") })) : null;
    var receipt = el("section", { class: "iri-ord-card iri-ord-receipt", "aria-labelledby": "iri-ord-rc-h" }, el("h2", { id: "iri-ord-rc-h", text: t("rc.title") }),
      el("dl", { class: "iri-ord-dl" },
        el("dt", { text: t("rc.order") }), el("dd", { text: o.ref }),
        el("dt", { text: o.demo ? t("rc.totalDemo") : t("rc.paid") }), el("dd", { text: p.outcome === "success" ? money(p.amount) + " CAD" + (o.demo ? " " + t("rc.notCharged") : "") : "—" }),
        el("dt", { text: t("rc.card") }), el("dd", { text: p.masked ? "•••• " + String(p.masked).slice(-4) : "—" }),
        el("dt", { text: t("rc.ref") }), el("dd", { text: p.reference || "—" }),
        el("dt", { text: t("rc.next") }), el("dd", { text: o.nextBill ? day(o.nextBill) + " · " + t("rev.monthlyAmt", { amt: money(q.monthly), incl: money(Number(q.monthly || 0) + Number(q.monthlyTax || 0)) }) : "—" })),
      el("p", { class: "iri-ord-help" }, t("rc.help"), " ", el("strong", { text: o.ref }), "."),
      el("a", { class: "iri-ord-link", href: url("find"), onclick: function (ev) { ev.preventDefault(); S.token = null; S.sel = []; S.order = null; S.results = null; save(); go("find"); } }, t("rc.more")));
    frame("order", [headEl, table, active || working ? el("div", { class: "iri-ord-two" }, el("div", null, test, S.handoff ? handoffCard() : null), checks) : null, actions, guide, receipt], { focus: !S.rendered.order });
    S.rendered.order = true;
    clearTimeout(poller);
    if (working) poller = setTimeout(function () { api("/order").then(function (j) { var was = S.order.state; S.order = j.order; if (S.step === "order") orderStep(); if (j.order.state === "active" && was !== "active") say(tn("act.activeT", j.order.numbers.length)); }).catch(function () {}); }, 4000);
  }
  function seedConnFrom(c) { return { path: c.type || "pbx", savedId: null, platform: c.platform, forwardTo: c.forwardTo, same: true, per: {}, label: (/Saved connection: (.+)/.exec(c.notes || "") || [])[1] || "" }; }
  function spellText(n) { var e = spellEl(n); return e ? e.firstChild.textContent : n.display; }
  function checksCard(o, c, active, working) {
    var rows = [], who = S.acct ? S.acct.name : (o.details ? (o.details.company || [o.details.firstName, o.details.lastName].join(" ")) : "");
    var paid = o.payment && o.payment.outcome === "success";
    rows.push({ ok: paid, label: t("chk.paid") });
    rows.push({ ok: active, label: t("chk.assigned", { who: who }) });
    if (S.demo) {
      rows.push({ ok: active, label: t(c.path === "forward" ? "chk.routingFwd" : "chk.routing"), ex: true });
      rows.push({ ok: active, label: tn("chk.e911", o.numbers.length), ex: true });
    }
    rows.push({ ok: active && !!o.nextBill, label: o.nextBill ? t("chk.billing", { date: day(o.nextBill) }) : t("chk.billingPending") });
    if (!active && !working) return null;
    return el("section", { class: "iri-ord-card", "aria-labelledby": "iri-ord-chk-h" }, el("h2", { id: "iri-ord-chk-h", text: t("chk.title") }),
      el("ul", { class: "iri-ord-checks" }, rows.map(function (r) {
        return el("li", { class: r.ok ? "is-ok" : "is-wait" }, r.ok ? el("span", { class: "tick", "aria-hidden": "true" }, ic("check")) : el("span", { class: "iri-ord-spinner is-dark", "aria-hidden": "true" }),
          el("span", null, r.label, r.ok ? "" : " " + t("chk.inProgress"), " ", r.ex ? example() : null));
      })));
  }
  function handoffText(o, c) {
    var first = o.numbers[0];
    return [t("ho.order", { ref: o.ref }), first ? first.display : "", first ? destLabel(c, first.did) : "", o.activatedAt ? t("ho.checks", { time: clock(o.activatedAt) }) : "",
      S.demo ? t("ho.e911") : "", t("ho.didnt")].filter(Boolean).join(" · ");
  }
  // Support handoff: the customer reviews and sends it; nothing goes out from chat alone (AI06)
  function handoffCard() {
    var h = S.handoff;
    if (h.sent) return el("div", { class: "iri-ord-card-iris" }, el("div", { class: "eb", text: t("ho.eyebrow") }), callout("success", "", t("ho.sent", { ref: h.sent })));
    var ta = el("textarea", { class: "iri-ord-ho", "aria-label": t("ho.label"), oninput: function (ev) { h.text = ev.target.value; } });
    ta.value = h.text;
    return el("div", { class: "iri-ord-card-iris" }, el("div", { class: "eb", text: t("ho.eyebrow") }), el("p", { text: t("ho.lead") }), ta,
      el("div", { class: "acts" }, S.demo && P ? el("button", { type: "button", class: "iri-ord-btn is-small", onclick: function (ev) {
        busy(ev.currentTarget, true, t("busy.send"));
        P.handoff(h.text).then(function (r) { h.sent = r.ref; rerender(); say(t("ho.sent", { ref: r.ref })); });
      } }, ic("headset"), t("ho.send")) : el("p", { class: "iri-ord-help", text: t("ho.call") })),
      el("p", { class: "note" }, ic("lock"), t("ho.note")));
  }

  // ---------- state gallery (?preview=states, demo only): the BRD's exceptional states ----------
  function statesGallery() {
    S.render = statesGallery;
    var cardS = function (tag, kind, body, cap) {
      return el("div", { class: "iri-ord-state" }, el("span", { class: "iri-ord-chip is-" + kind, text: tag }), body, el("p", { class: "cap", text: cap }));
    };
    var fakeOld = { dueToday: "99.00", setup: "99.00", firstMonth: "5.00" }, fakeNew = { dueToday: "89.00", setup: "89.00", firstMonth: "5.00" };
    var grid = el("div", { class: "iri-ord-states" },
      cardS(t("st.aiOff"), "muted", el("div", null, callout("", "", t("iris.unavailable")), el("div", { class: "iri-ord-try is-tight" }, el("span", { class: "iri-ord-pill", text: t("f.rc") + ": Toronto" }), el("span", { class: "iri-ord-pill", text: t("f.dw") }), el("span", { class: "iri-ord-pill is-dashed", text: t("chips.more") }))), t("st.aiOffCap")),
      cardS(t("st.unsure"), "info", el("div", { class: "iri-ord-msg" }, el("p", { text: t("st.unsureQ") }), el("div", { class: "iri-ord-try is-tight" }, ["514 · Montréal", "438 · Montréal", "450", t("st.searchAll")].map(function (x) { return el("span", { class: "iri-ord-pill", text: x }); }))), t("st.unsureCap")),
      cardS(t("st.price"), "err", (function () { var b = priceChanged(fakeOld, fakeNew); b.querySelectorAll("button").forEach(function (x) { x.disabled = true; }); return b; })(), t("st.priceCap")),
      cardS(t("st.hold"), "warn", el("div", null, callout("warning", "", t("st.holdD")), el("button", { type: "button", class: "iri-ord-btn is-small", disabled: true }, t("st.extend"))), t("st.holdCap")),
      cardS(t("st.secret"), "err", el("div", null, el("div", { class: "iri-ord-bubble", text: "host=sip.example.ca port=5061 password=••••••••" }), el("div", { class: "iri-ord-msg", text: t("st.secretD") })), t("st.secretCap")),
      cardS(t("st.scope"), "muted", portingCard(), t("st.scopeCap")),
      cardS(t("st.none"), "warn", callout("warning", t("nr.t"), t("nr.d")), t("st.noneCap")),
      cardS(t("st.expired"), "warn", callout("warning", t("hold.expiredT"), t("hold.expired")), t("st.expiredCap")),
      cardS(t("st.taken"), "warn", callout("warning", tn("taken.t", 1), tn("taken.d", 1, { list: "416 555 2732" })), t("st.takenCap")),
      cardS(t("st.declined"), "err", callout("error", t("pay.declinedT"), t("pay.declined")), t("st.declinedCap")),
      cardS(t("st.unknown"), "warn", callout("warning", t("pay.unknownT"), t("pay.unknown", { ref: "IRN-EX1029" })), t("st.unknownCap")),
      cardS(t("st.delayed"), "info", callout("", t("act.delayedT"), t("act.delayed")), t("st.delayedCap")),
      cardS(t("st.partly"), "warn", callout("warning", t("st.partlyT"), t("st.partlyD")), t("st.partlyCap")),
      cardS(t("st.session"), "muted", callout("", t("st.sessionT"), t("st.sessionD")), t("st.sessionCap")),
      cardS(t("st.restricted"), "err", callout("error", t("st.restrictedT"), t("st.restrictedD")), t("st.restrictedCap")));
    frame("find", [head(t("st.title"), t("st.lede")), grid], { rail: false, cls: "is-wide" });
  }

  // ---------- Iris → page (fire-and-forget client tools, rendered as cards the customer clicks) ----------
  function onIrisSearch(d) {
    if (!S || !cat || !d) return;
    var words = (Array.isArray(d.words) ? d.words : d.word ? [d.word] : []).map(function (w) { return String(w).toUpperCase().replace(/[^A-Z]/g, ""); })
      .filter(function (w) { return w.length >= 2 && w.length <= 10; }).slice(0, 5);
    var q = [d.city || "", d.areaCode || "", words[0] || ""].join(" ").trim() || d.query || "";
    var apply = function () {
      if (S.step !== "find") { S.pendingIris = { q: q, words: words }; save(); go("find"); return; }
      S.search.ideas = words;
      runQuery(q, true);
    };
    if (S.step === "find") return apply();
    pushCard({ id: "search", title: t("card.searchT"), text: t("card.searchD", { q: q }), actions: [{ label: t("card.goSearch"), fn: apply }, { label: t("card.notNow") }] });
  }
  function onIrisCard(d) {
    if (!S || !d || !d.kind) return;
    var num = String(d.number || "").replace(/\D/g, "").slice(-10);
    if (d.kind === "select_number") {
      if (num.length !== 10) return; // a proposal without a real number has nothing to show
      var n = (S.results || []).filter(function (x) { return x.did === num; })[0];
      return pushCard({ id: "sel-" + num, title: n ? n.display + " (" + catLabel(catOf(n)) + ")" : fmt(num || "0000000000"),
        text: n ? t("card.selD", { setup: money(n.setup), month: money(n.monthly) }) + (d.reason ? " " + String(d.reason).slice(0, 160) : "") : t("card.notInResults"),
        actions: n && S.step === "find" && !isSel(n.did) ? [{ label: t("card.select"), fn: function () { toggle(n); } }, { label: t("card.notNow") }] : [{ label: t("card.ok") }],
        note: t("card.selNote") });
    }
    if (d.kind === "use_path" && ["pbx", "iristel", "forward"].indexOf(d.path) >= 0 && S.view === "connect") {
      return pushCard({ id: "path", title: t("path." + d.path), text: t("help.why." + d.path),
        actions: [{ label: t("help.use"), fn: function () { var u = ui(); u.conn = u.conn || seedConn(); u.conn.path = d.path; save(); rerender(); } }, { label: t("card.notNow") }] });
    }
    if (d.kind === "send_all_same" && S.view === "connect") {
      return pushCard({ id: "same", title: t("dest.same"), actions: [{ label: t("card.apply"), fn: function () { var u = ui(); if (u.conn) { u.conn.same = true; save(); rerender(); } } }, { label: t("card.notNow") }] });
    }
    if (d.kind === "support_handoff" && S.view === "order") {
      S.handoff = { text: String(d.summary || handoffText(S.order, ui().conn || { path: "pbx", per: {} })).slice(0, 600) };
      return rerender();
    }
    if (d.kind === "out_of_scope") { S.porting = true; refreshRail(); if (S.view === "find" && !S.results) rerender(); }
  }

  // ---------- routing ----------
  function route() {
    var o = S.order;
    S.sub = S.step === "connect" && location.hash === "#e911" ? "e911" : null;
    if (S.step === "find") return findStep();
    if (S.step === "order") {
      if (o) return orderStep();
      S.render = route;
      return frame("order", callout("warning", t("act.missingT"), t("act.missing")), { rail: false });
    }
    if (!o || ["cancelled", "rejected"].indexOf(o.state) >= 0) return go("find");
    if (["paying", "completing", "active", "delayed", "payment_unknown"].indexOf(o.state) >= 0) return go("order", "?ref=" + encodeURIComponent(o.ref) + "&t=" + encodeURIComponent(S.token));
    if (o.state === "expired") return expiredView(S.step);
    if (o.state === "reserving") return waitHeld(15).then(route, function () { go("find"); });
    if (S.step === "connect" && !o.details) return go("account");
    if (S.step === "review" && !o.connect) return go(o.details ? "connect" : "account");
    if (S.step === "connect" && S.sub === "e911" && !o.connect) { S.sub = null; }
    return ({ account: accountStep, connect: connectStep, review: function () { reviewStep(); } })[S.step]();
  }
  // Back on step 1 with numbers chosen (from a later step, or after turning Iris on): show the same search results again,
  // not the landing. Results aren't saved, only the search and its filters, so the search runs again once the step is up.
  function land() {
    route();
    var f = S.search.filters;
    if ((S.irisNote || S.sel.length) && S.render === findStep && f && (f.province || f.ratecenter || f.areaCode)) runSearch(0);
  }
  function unavailable() {
    S.render = unavailable;
    frame(S.step, callout("warning", t("off.t"), t("off.d")), { rail: false, bare: true }); // no steps: nothing can be ordered
  }

  function init() {
    mount = document.getElementById("iri-ord");
    // html.iri-ord-iris scopes the Iris tweaks in app.css to these pages (removed after a swup visit elsewhere)
    document.documentElement.classList.toggle("iri-ord-iris", !!mount);
    if (!mount) {
      clearInterval(timer); clearTimeout(poller);
      if (S) S.basketOpen = false;
      if (barSpace.ro) { barSpace.ro.disconnect(); barSpace.ro.el = null; }
      return;
    }
    if (mount.getAttribute("data-ready")) return;
    // Iris starts only from "Ask Iris (AI)" here: the widget's own once-per-visit flag turns its auto-start off
    try { sessionStorage.setItem("iris_greeted", "1"); } catch (e) {}
    var irisJustOn = false;
    try { irisJustOn = sessionStorage.getItem("iriOrdIrisOn") === "1"; sessionStorage.removeItem("iriOrdIrisOn"); } catch (e) {}
    mount.setAttribute("data-ready", "1");
    mount.className = "iri-ord";
    clearInterval(timer); clearTimeout(poller);
    var st = load();
    S = { api: (mount.getAttribute("data-api") || "").replace(/\/+$/, ""), step: mount.getAttribute("data-step") || "find",
      base: mount.getAttribute("data-base") || "/phone-numbers/", urls: null, token: st.token || null, sel: st.sel || [],
      search: st.search || { q: "", filters: null, sort: "best" }, results: null, lang: (qs("lang") === "fr" || qs("lang") === "en") ? qs("lang") : st.lang || "en",
      mode: st.mode || "rent", acct: st.acct || null, ui: st.ui || {}, hideAi: !!st.hideAi, pendingIris: st.pending || null, cards: [], rendered: {},
      irisNote: irisJustOn && !irisOff() };
    try { S.urls = JSON.parse(mount.getAttribute("data-urls") || "null"); } catch (e) {}
    if (qs("t")) { S.token = qs("t"); save(); }
    // Steps after the search are per-visitor pages: keep them out of search results
    if (S.step !== "find" && !document.querySelector('meta[name="robots"][content*="noindex"]')) {
      document.head.appendChild(el("meta", { name: "robots", content: "noindex, nofollow" }));
    }
    mount.textContent = "";
    mount.appendChild(el("div", { class: "iri-ord-wrap" }, el("p", { class: "iri-ord-empty", text: "Loading… / Chargement…" })));
    loadScript(S.api + "/i18n.js").then(function () { return Promise.all([api("/config"), api("/catalog")]); }).then(function (r) {
      cfg = r[0]; cat = r[1];
      // Demo: automatic while live ordering is off, or asked for with ?demo=1 (?demo=0 leaves it)
      if (qs("demo") === "0") S.demo = false;
      else S.demo = !!cfg.demo && (!cfg.enabled || qs("demo") === "1" || !!st.demo);
      if (!S.demo) S.acct = null; // example accounts never leave demo mode
      save();
      return S.demo ? loadScript(S.api + "/preview.js").then(function () { P = window.IriOrdPreview || null; }, function () { P = null; }) : null;
    }).then(function () {
      if (!cfg) return;
      // Live checkout needs the 9-1-1 backend before anyone can pay (BRD D3, FR13)
      var liveReady = cfg.enabled && cfg.features && cfg.features.e911;
      if (!S.demo && !liveReady && S.step !== "order") return unavailable();
      if (S.pendingIris && S.step === "find") { S.search.ideas = S.pendingIris.words; var pq = S.pendingIris.q; S.pendingIris = null; save(); return runQuery(pq, true); }
      if (S.step === "find" && !S.token) return land();
      if (!S.token) return route();
      return api(S.step === "order" ? "/order" : "/basket").then(function (j) { S.order = j.order; if (j.order && j.order.demo) S.demo = true; land(); },
        function () { if (S.step === "order") { S.order = null; return route(); } if (S.step === "find") { S.token = null; save(); return route(); } S.token = null; save(); go("find"); });
    }).catch(function (e) {
      mount.textContent = "";
      mount.appendChild(el("div", { class: "iri-ord-wrap" }, el("div", { class: "iri-ord-callout is-error", role: "alert" }, el("div", null,
        el("strong", { text: "We couldn't load the order form. / Le formulaire de commande n'a pas pu être chargé." }),
        el("span", { text: " 1 833 IRISTEL (474 7835)" })))));
      console.error("[iri-ord]", e && e.message);
    });
  }

  document.addEventListener("visibilitychange", function () { if (!document.hidden && S && S.token && ["account", "connect", "review"].indexOf(S.step) >= 0 && S.order && S.order.state === "held") refresh(); });
  window.addEventListener("popstate", function () { if (S && S.step === "connect" && S.order) { S.sub = location.hash === "#e911" ? "e911" : null; S.sub ? e911Step() : connectStep(); } });
  document.addEventListener("iris:propose-search", function (e) { onIrisSearch(e.detail); });
  document.addEventListener("iris:action-card", function (e) { onIrisCard(e.detail); });
  document.addEventListener("swup:page:view", init);
  window.addEventListener("resize", function () { if (S && mount) barSpace(); });
  window.IriOrder = { init: init, context: function () { return window.IriOrderContext || null; } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
