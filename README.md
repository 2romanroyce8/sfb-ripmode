# RIP MODE — SFB Connect Dialer (standalone)

Live app: https://sfb-ripmode-router.2romanroyce8.workers.dev
Target URL (needs one dashboard step, see below): https://sixfigureblueprints.com/ripmode

## What it is
Standalone RIP MODE dialer — login, RIP MODE, Leads, 5-stage Pipeline,
Cal.com-mirrored Calendar, Call Log + conversations, Connections.

- Login gate: only romanroyce, loganwells, braylengarrett. First sign-in sets a
  password (min 8 chars, stored only as a salted PBKDF2-SHA256 hash in
  Cloudflare KV — 100,000 iterations, the Workers cap). Sessions last 30 days.
  No email reset: forget your password and the account is cleared, then you
  sign up again.
- Calling/texting via Google Voice (213) 495-3536 — free, no Twilio.
  Google Voice has no API, so CALL/TEXT open Google Voice; nothing here
  auto-dials, auto-plays a script, auto-drops voicemail, or auto-sends SMS.
  Meeting emails are queued until Resend is wired; SMS opens Google Voice
  with the text ready — never claimed as sent automatically.
- Backend: Cloudflare Worker `sfb-ripmode-router` + KV namespace `ripmode-data`
  (shared state: leads, call log, conversations, meetings, session stats).
  The worker serves the frontend itself from embedded files.

## Hosting reality (2026-11-20)
- Vercel: the connected Vercel token CANNOT create projects or deployments
  (403 "You don't have permission to create the project" on create_project,
  create_deployment, and create_git_project). Files upload fine, but no
  deployment can be created through it. To move to Vercel later: in the
  Vercel dashboard, Add New -> Project -> import this repo
  (2romanroyce8/sfb-ripmode); it auto-deploys. Then point the worker's
  UPSTREAM at the new *.vercel.app URL, or keep the worker-hosted version.
- Cloudflare: the connected token CAN upload/edit workers and use KV, but
  CANNOT create zone worker routes (403 on POST /zones/:id/workers/routes)
  and cannot list DNS records. So the custom-domain binding needs one manual
  step in the Cloudflare dashboard (see below). The worker is already live
  on its workers.dev URL.

## One step to go live at sixfigureblueprints.com/ripmode
In the Cloudflare dashboard: Workers & Pages -> sfb-ripmode-router ->
Settings -> Triggers -> Add route, add BOTH patterns:
- sixfigureblueprints.com/ripmode
- sixfigureblueprints.com/ripmode/*
(More specific routes win over the homepage worker's /* catch-all, same as
the /billme router.) No code or DNS change needed.

## Files
- index.html / app.js / style.css — the app (also embedded in worker/standalone.js)
- vercel.json — rewrites for a future Vercel deploy
- worker/router.js — worker source (proxy version; UPSTREAM = Vercel app)
- worker/standalone.js — generated worker that serves the app + API from KV
  (regenerate after editing the app: see the build step in git history)
