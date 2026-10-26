// "Buy phone numbers" step app text: English and French must stay complete
// (BRD v1.4 decision D4: every customer-facing string exists in both languages).
//   node test/did-i18n.test.js

import fs from "fs";
import vm from "vm";

const read = (f) => fs.readFileSync(new URL(`../public/did/${f}`, import.meta.url), "utf8");
const box = { window: {} };
vm.runInNewContext(read("i18n.js"), box);
const { en, fr } = box.window.IriOrdI18n;
const app = read("app.js");

const failed = [];
async function test(name, fn) {
  try { await fn(); console.log("ok  ", name); }
  catch (e) { failed.push(name); console.log("FAIL", name, "\n     ", e.message); }
}
const holes = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(",");

await test("en and fr have the same keys", () => {
  const onlyEn = Object.keys(en).filter((k) => !(k in fr));
  const onlyFr = Object.keys(fr).filter((k) => !(k in en));
  if (onlyEn.length || onlyFr.length) throw new Error(`only en: ${onlyEn.join(" ")} | only fr: ${onlyFr.join(" ")}`);
});

await test("each fr string has the same {placeholders} as en, and none is empty", () => {
  const bad = Object.keys(en).filter((k) => holes(en[k]) !== holes(fr[k]) || !String(fr[k]).trim() || !String(en[k]).trim());
  if (bad.length) throw new Error(bad.join(" "));
});

await test("every literal t()/tn() key in app.js exists", () => {
  const plain = [...app.matchAll(/\bt\("([\w.]+)"(?!\s*\+)/g)].map((m) => m[1]);
  const plural = [...app.matchAll(/\btn\("([\w.]+)"(?!\s*\+)/g)].map((m) => m[1]);
  const missing = [...new Set(plain)].filter((k) => !(k in en))
    .concat([...new Set(plural)].filter((k) => !(`${k}_one` in en && `${k}_other` in en)).map((k) => `${k}_one/_other`));
  if (missing.length) throw new Error(missing.join(" "));
});

await test("keys the app builds at run time exist", () => {
  const paths = ["pbx", "iristel", "forward"];
  const want = [
    ...["find", "account", "connect", "review", "order"].map((s) => `step.${s}`),
    ...["account", "connect", "e911", "review", "order"].map((s) => `title.${s}`),
    ...["find", "account", "connect", "e911", "review", "order"].map((s) => `iris.purpose.${s}`),
    ...["rent", "purchase"].flatMap((m) => [`mode.${m}`, `mode.${m}.t`, `mode.${m}.sub`, `mode.${m}.long`, `bar.mode.${m}`]),
    ...["all", "basic", "vanity", "speciality"].map((c) => `cat.${c}`),
    ...["exact", "partial", "voice"].map((b) => `badge.${b}`),
    ...["repeat", "pairs", "round", "sequence"].map((r) => `why.special.${r}`),
    ...["best", "price", "number"].map((s) => `sort.${s}`),
    ...[1, 2, 3, 4].flatMap((i) => [`how.${i}.t`, `how.${i}.d`, `e911.b${i}`]),
    "e911.c2", "e911.c3",
    ...paths.flatMap((p) => [`path.${p}`, `path.${p}.d`, `path.short.${p}`, `dest.incl.${p}`, `help.why.${p}`, `qa.not.${p}`, `guide.t.${p}`,
      `guide.${p}.1`, `guide.${p}.2`, `guide.${p}.3`]),
    "act.test2.pbx", "act.test2.iristel", "act.caps.inout", "act.caps.fwd",
    ...["reg", "ip", "managed"].flatMap((m) => [`method.${m}`, `method.${m}.d`, `method.short.${m}`]),
    ...[1, 2, 3].map((i) => `conn.ready.${i}`),
    ...["num", "dest", "cap", "e911", "check"].map((c) => `dest.col.${c}`),
    ...["num", "plan", "dest", "status", "since"].map((c) => `act.col.${c}`),
    ...["active", "pending", "payment", "activating", "none"].map((s) => `act.s.${s}`),
    ...["held", "reserving", "paying", "completing", "active", "delayed", "payment_unknown", "expired", "cancelled", "rejected"].map((s) => `ostate.${s}`),
    "hero.eyebrow", "hero.h1", "hero.lede", "acct.tab.signin", "acct.tab.create", "acct.type.business", "acct.type.residential",
    "help.q1", "help.q2", "help.q3", "help.yes", "help.no", "help.unsure",
    "plan.reason.tierRent", "plan.reason.noPrice", "plan.reason.notOnline", "pay.note.decline",
    ...["NETWORK", "DISABLED", "INVENTORY_UNAVAILABLE", "HOLD_EXPIRED", "HOLD_PENDING", "BUSY", "RATE_LIMITED", "NUMBER_UNAVAILABLE",
      "DETAILS_REQUIRED", "CONNECT_REQUIRED", "PAYMENT_UNAVAILABLE", "DECLINED", "VALIDATION_ERROR", "INVALID_REQUEST", "NOT_FOUND",
      "FORBIDDEN", "INELIGIBLE_STATUS"].map((c) => `err.${c}`),
  ];
  const missing = want.filter((k) => !(k in en));
  if (missing.length) throw new Error(missing.join(" "));
});

await test("every error code the /did routes send has a translation", () => {
  const routes = fs.readFileSync(new URL("../lib/did-routes.js", import.meta.url), "utf8");
  const codes = [...new Set([...routes.matchAll(/fail\(res, \d+, "([A-Z_]+)"/g)].map((m) => m[1]))];
  const missing = codes.filter((c) => !(`err.${c}` in en));
  if (missing.length) throw new Error(missing.join(" "));
});

await test("approved D10 Iris disclosure copy is verbatim", () => {
  if (en["iris.ask"] !== "Ask Iris (AI)" || fr["iris.ask"] !== "Demander à Iris (IA)") throw new Error("entry label");
  if (!fr["iris.footer"].startsWith("Iris est l'assistante IA d'Iristel et peut faire des erreurs.")) throw new Error("fr footer");
  if (fr["cat.vanity"] !== "Personnalisé" || fr["cat.basic"] !== "De base" || fr["cat.speciality"] !== "Spécialité") throw new Error("fr categories");
});

console.log(failed.length ? `\n${failed.length} failed` : "\nall passed");
process.exit(failed.length ? 1 : 0);
