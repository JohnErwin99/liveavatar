import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());

// Allowed origins. If ALLOWED_ORIGIN is unset -> allow all. Otherwise allow the
// listed origins PLUS any *.webflow.io subdomain (handy for staging).
const ALLOW = (process.env.ALLOWED_ORIGIN || "")
  .split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                       // curl / server-to-server
    const clean = origin.replace(/\/+$/, "");
    if (ALLOW.length === 0) return cb(null, true);            // not configured -> allow all
    if (ALLOW.includes(clean)) return cb(null, true);
    try { if (/\.webflow\.io$/.test(new URL(origin).hostname)) return cb(null, true); } catch {}
    return cb(null, false);
  },
}));

const LA_KEY    = process.env.LIVEAVATAR_API_KEY;     // your (rotated) LiveAvatar key
const SECRET_ID = process.env.LIVEAVATAR_SECRET_ID;   // from the one-time secret registration
const AVATAR_ID = process.env.LIVEAVATAR_AVATAR_ID;   // the avatar you picked in LiveAvatar
const AGENT_ID  = process.env.ELEVENLABS_AGENT_ID || "agent_4301kq7pcrscezmrvnegnz2sqp95";

app.get("/", (_req, res) =>
  res.json({ service: "iris-liveavatar-backend", status: "up", endpoints: ["/health", "/avatar-session"] }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Debug: shows which vars are SET (true/false) without revealing secret values.
app.get("/config", (_req, res) => res.json({
  LIVEAVATAR_API_KEY:   !!LA_KEY,
  LIVEAVATAR_SECRET_ID: !!SECRET_ID,
  LIVEAVATAR_AVATAR_ID: !!AVATAR_ID,
  ELEVENLABS_AGENT_ID:  AGENT_ID,
}));

// The browser calls this to get a short-lived session token for the avatar.
app.get("/avatar-session", async (_req, res) => {
  const missing = [];
  if (!LA_KEY)    missing.push("LIVEAVATAR_API_KEY");
  if (!SECRET_ID) missing.push("LIVEAVATAR_SECRET_ID");
  if (!AVATAR_ID) missing.push("LIVEAVATAR_AVATAR_ID");
  if (missing.length) {
    return res.status(500).json({ error: "Missing env vars", missing });
  }
  try {
    const r = await fetch("https://api.liveavatar.com/v1/sessions/token", {
      method: "POST",
      headers: { "X-API-KEY": LA_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        mode: "LITE",
        avatar_id: AVATAR_ID,
        elevenlabs_agent_config: { secret_id: SECRET_ID, agent_id: AGENT_ID },
      }),
    });
    const json = await r.json();
    if (!r.ok) {
      console.error("LiveAvatar error:", r.status, json);
      return res.status(r.status).json(json);
    }
    // hand the browser only what it needs
    res.json({ session_id: json?.data?.session_id, session_token: json?.data?.session_token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "session_failed" });
  }
});

const PORT = process.env.PORT || 3000;   // Railway injects PORT automatically
app.listen(PORT, () => console.log("LiveAvatar token server listening on", PORT));
