# QA Board lock-screen push (Cloudflare Worker)

Sends a **PWA lock-screen** notification at the bell time. GitHub Pages cannot do this. Calendar is a fallback, not this path.

Private VAPID key stays in Cloudflare secrets — not GitHub.

## Deploy (once)

1. Free Cloudflare account.
2. In this folder:

```
npx wrangler login
npx wrangler kv namespace create SUBS
```

Paste the KV `id` into `wrangler.toml`. Then:

```
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler deploy
```

3. Put the `*.workers.dev` URL into `sheet-config.js` as `window.PUSH_URL`.
4. Push the board (`live`).

## iPhone

1. Open the Pages URL in **Safari**.
2. Share → **Add to Home Screen**.
3. Open **QA Board** from the home-screen icon (not a Safari tab).
4. Bell → **ALERT ON** → **Allow**.
5. Lock the phone. Wait for the time.

iOS 16.4+. Sound is **one OS ping per slot**, not a looping chime. Apple will not loop audio on the lock screen from a PWA.
