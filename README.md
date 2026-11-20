# RIP MODE — SFB Connect Dialer (standalone)

Standalone RIP MODE dialer for https://sixfigureblueprints.com/ripmode

- Login gate: only romanroyce, loganwells, braylengarrett. First sign-in sets a
  password (min 8 chars, stored only as a salted PBKDF2-SHA256 hash in
  Cloudflare KV). Sessions last 30 days. No email reset.
- Calling/texting via Google Voice (213) 495-3536 — free, no Twilio.
  Google Voice has no API, so CALL/TEXT open Google Voice; nothing here
  auto-dials, auto-plays a script, auto-drops voicemail, or auto-sends SMS.
- Backend: Cloudflare Worker `sfb-ripmode-router` (proxy + /api/*) with KV
  namespace `ripmode-data`. Frontend: static files on Vercel (`sfb-ripmode`).
- $0: free Vercel hobby + free Cloudflare.

## Deploy
1. Push to GitHub (this repo) — Vercel auto-deploys, or `vercel deploy`.
2. Cloudflare worker `sfb-ripmode-router` proxies sixfigureblueprints.com/ripmode*
   to the Vercel app and serves /ripmode/api/* from KV. See worker/router.js.
