// Emails for the "Buy phone numbers" flow: the customer's confirmation and the
// alert provisioning needs to point the trunk at the customer's PBX.
//
// Same route as OnlineOrdering's snag mail: Microsoft Graph sendMail with the
// Azure app already used for D365 (needs the Mail.Send APPLICATION permission
// with admin consent) from DID_MAIL_FROM. Ops alerts go to the Power Automate
// flow in SNAG_WEBHOOK_URL when it is set. Mail never blocks an order: a
// failure is logged and the order page still has the receipt.

let graphToken = null; // { token, exp }

async function graphGetToken() {
  if (graphToken && graphToken.exp > Date.now() + 60000) return graphToken.token;
  const { D365_TENANT_ID: tenant, D365_CLIENT_ID: id, D365_CLIENT_SECRET: secret } = process.env;
  if (!tenant || !id || !secret) throw new Error("Azure app (D365_*) not configured");
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret,
      scope: "https://graph.microsoft.com/.default" }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error("Graph auth failed: " + (j.error_description || r.status));
  graphToken = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return graphToken.token;
}

export async function sendMail({ to, subject, html }) {
  const from = process.env.DID_MAIL_FROM || process.env.SNAG_MAIL_FROM || "";
  if (!from) { console.warn("[did-mail] DID_MAIL_FROM not set — not sent:", subject); return false; }
  try {
    const token = await graphGetToken();
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { subject, body: { contentType: "HTML", content: html },
        toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true }),
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 202) return true;
    console.error("[did-mail] Graph sendMail HTTP", r.status, r.status === 403 ? "— the Azure app needs Mail.Send (application) with admin consent" : "");
  } catch (e) {
    console.error("[did-mail] send failed:", e.message);
  }
  return false;
}

export async function opsAlert(subject, html, payload = {}) {
  const hook = process.env.SNAG_WEBHOOK_URL;
  if (hook) {
    try {
      const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body: html, source: "did-ordering", ...payload }), signal: AbortSignal.timeout(15000) });
      if (r.ok) return true;
      console.error("[did-mail] ops webhook HTTP", r.status);
    } catch (e) { console.error("[did-mail] ops webhook failed:", e.message); }
  }
  return sendMail({ to: process.env.DID_OPS_EMAIL || "provisioning@iristel.com", subject, html });
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const DEST_LABEL = { pbx: "Your own PBX or calling platform", iristel: "An Iristel service", forward: "Call forwarding" };
const METHOD_LABEL = { static: "Static IP registration", dynamic: "Dynamic user registration", managed: "External managed platform" };

export function destinationLines(c) {
  if (!c) return [];
  const l = [`Destination: ${DEST_LABEL[c.type] || c.type}`];
  if (c.method) l.push(`SIP connection: ${METHOD_LABEL[c.method] || c.method}`);
  if (c.platform) l.push(`Platform: ${c.platform}`);
  if (c.host) l.push(`Endpoint: ${c.host}:${c.port} (${String(c.transport).toUpperCase()})`);
  if (c.failover) l.push(`Failover: ${c.failover}`);
  if (c.provider) l.push(`Provider: ${c.provider}`);
  if (c.forwardTo) l.push(`Forward to: ${c.forwardTo}`);
  if (c.notes) l.push(`Notes: ${c.notes}`);
  return l;
}

export function confirmationHtml(rec, orderUrl) {
  const nums = (rec.numbers || []).filter((n) => !n.removed)
    .map((n) => `<li><strong>${esc(n.display || n.did)}</strong> — ${esc(n.location || "")}</li>`).join("");
  const q = rec.quote || {};
  return `<div style="font-family:Arial,sans-serif;color:#0b1f3a;max-width:560px">
<h2 style="color:#01111e">Your Iristel phone numbers</h2>
<p>Thanks, ${esc(rec.details?.firstName)}. Order <strong>${esc(rec.ref)}</strong> is confirmed.</p>
<ul>${nums}</ul>
<p>Paid today: <strong>$${esc(q.dueToday)} CAD</strong> (card ${esc(rec.payment?.masked || "")}).<br>
Then $${esc(q.monthly)} a month + applicable tax, renewing monthly until you cancel.</p>
<p>${destinationLines(rec.connect).map(esc).join("<br>")}</p>
<p>Our provisioning team uses these details to connect your numbers. Activation covers inbound voice only; outbound calling, 9-1-1 and texting are separate services.</p>
<p><a href="${esc(orderUrl)}" style="color:#004a9f">See your order status</a></p>
<p style="font-size:12px;color:#626262">Questions? Call 1 833 IRISTEL (474 7835), Monday to Friday, 9 AM to 5 PM ET, and quote ${esc(rec.ref)}. We never send passwords or full card numbers by email.</p></div>`;
}

export function opsHtml(rec, title, extra = []) {
  const d = rec.details || {};
  const rows = [
    `Order: ${rec.ref} (${rec.state})`,
    `Customer: ${d.firstName || ""} ${d.lastName || ""} ${d.company ? "— " + d.company : ""} (${d.segment || ""})`,
    `Email / phone: ${d.email || ""} / ${d.phone || ""}`,
    `Numbers: ${(rec.numbers || []).filter((n) => !n.removed).map((n) => n.did).join(", ")}`,
    `Payment: ${rec.payment?.outcome || "none"} ${rec.payment?.reference || ""} $${rec.quote?.dueToday || ""}`,
    `MIND account / service: ${rec.mind?.accountId || "-"} / ${rec.mind?.serviceId || "-"}`,
    `Espresso orders: ${(rec.espresso || []).map((e) => `${e.orderNumber || e.id} ${e.status || ""}`).join("; ")}`,
    ...destinationLines(rec.connect),
    ...extra,
  ];
  return `<div style="font-family:Arial,sans-serif"><h3>${esc(title)}</h3><p>${rows.map(esc).join("<br>")}</p></div>`;
}
