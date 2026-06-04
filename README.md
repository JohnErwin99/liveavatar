# Iris LiveAvatar backend (Railway)

Tiny server that mints LiveAvatar session tokens for your ElevenLabs agent
(`agent_4301kq7pcrscezmrvnegnz2sqp95`) in LITE mode. Your secret keys live here,
never in the browser.

## Before you deploy

1. **Rotate your LiveAvatar API key** (the one pasted in chat is compromised) and use the new one.
2. In **LiveAvatar**, pick/create the avatar you want and copy its `avatar_id` (a UUID).
3. In **ElevenLabs**, create an API key with `convai_read`, `user_read`, `voices_read`.
4. In your **ElevenLabs agent**, set audio to **PCM 24000 Hz** — output under
   Voice settings → TTS output formats, input under Advanced → User input audio format.

## Deploy to Railway

1. Put these four files (`server.js`, `register-secret.js`, `package.json`, `.env.example`)
   in a GitHub repo (or use the Railway CLI: `railway init` then `railway up`).
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
   It auto-detects Node and runs `npm start`. (PORT is injected automatically.)
3. Add Variables (see `.env.example`): `LIVEAVATAR_API_KEY`, `LIVEAVATAR_AVATAR_ID`,
   `ELEVENLABS_AGENT_ID`, `ALLOWED_ORIGIN`, and `ELEVENLABS_API_KEY` (for the next step).

## One-time: register your ElevenLabs key

Run once to get a `secret_id`:

```
railway run npm run register-secret
```

Copy the printed `secret_id` into a new Railway variable **`LIVEAVATAR_SECRET_ID`**,
then redeploy. (You can remove `ELEVENLABS_API_KEY` afterward if you like — it's only
needed for registration.)

## Test

- `GET https://<your-app>.up.railway.app/health` → `{ "ok": true }`
- `GET https://<your-app>.up.railway.app/avatar-session` →
  `{ "session_id": "...", "session_token": "..." }`

If `/avatar-session` returns that token, the backend is done. The browser widget then
fetches it and renders the avatar via `@heygen/liveavatar-web-sdk`.

## Note on cost/abuse

Each session burns LiveAvatar credits (~1 credit/min). Keep `ALLOWED_ORIGIN` locked to
your domains; consider adding a rate limit if the endpoint is public.
