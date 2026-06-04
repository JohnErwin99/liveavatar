// RUN ONCE to register your ElevenLabs API key with LiveAvatar.
// It returns a secret_id you then store as LIVEAVATAR_SECRET_ID.
//
//   LIVEAVATAR_API_KEY=xxx ELEVENLABS_API_KEY=yyy node register-secret.js
//
// (On Railway you can also run:  railway run node register-secret.js)

async function main() {
  const LA_KEY = process.env.LIVEAVATAR_API_KEY;
  const EL_KEY = process.env.ELEVENLABS_API_KEY;   // needs convai_read, user_read, voices_read
  if (!LA_KEY || !EL_KEY) {
    console.error("Set LIVEAVATAR_API_KEY and ELEVENLABS_API_KEY first.");
    process.exit(1);
  }

  const r = await fetch("https://api.liveavatar.com/v1/secrets", {
    method: "POST",
    headers: { "X-API-KEY": LA_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      secret_type: "ELEVENLABS_API_KEY",
      secret_value: EL_KEY,
      secret_name: "Iris ElevenLabs Agent Key",
    }),
  });

  const json = await r.json();
  console.log(JSON.stringify(json, null, 2));
  const secretId = json?.data?.secret_id || json?.secret_id;
  if (secretId) {
    console.log("\n✅ secret_id:", secretId);
    console.log("→ Set this as LIVEAVATAR_SECRET_ID in your Railway variables.");
  } else {
    console.log("\n⚠️  Couldn't find secret_id in the response above — check the key/permissions.");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
