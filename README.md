# RIP MODE — SFB Connect Dialer (standalone)

Live app: https://sfb-ripmode-router.2romanroyce8.workers.dev
Target URL (needs one dashboard step, see below): https://sixfigureblueprints.com/ripmode

## What it is
Standalone RIP MODE dialer — login, RIP MODE, Leads, 5-stage Pipeline,
Cal.com-mirrored Calendar, Call Log + conversations, Connections.

- Login gate: only romanroyce, loganwells, braylengarrett. First sign-in sets a
  4-digit passcode (stored only as a salted PBKDF2-SHA256 hash in
  Cloudflare KV — 100,000 iterations, the Workers cap). Sessions last 30 days.
  No email reset: forget your passcode and the account is cleared, then you
  sign up again. The passcode field is numeric-only (inputmode="numeric",
  maxlength 4); anything that is not exactly 4 digits is rejected with
  "Enter a 4-digit passcode".
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
  (regenerate after editing the app: `python3 build.py`)
- build.py — regenerates worker/standalone.js from router.js + the app files
- deploy.py — deploys worker/standalone.js WITH the RIPMODE_KV binding.
  ALWAYS deploy with this script. `cf.py worker-put` uploads metadata with
  no bindings and silently DROPS the KV binding — the API then throws 1101
  on every call that touches KV (found 2026-11-20, fixed by re-uploading
  with the binding; no data was lost, KV lives outside the worker).

## UI — SFB Staff UI Template, applied exactly (2026-11-20)
Rome asked for the SFB Staff UI Template to be used exactly as-is, not
recreated, and confirmed twice to go ahead despite a system security flag
on the template files. The template's files are in `template/` (29 files,
copied verbatim from Rome's individual uploads — never the zip, never run:
no npm, no build, no package scripts).

- `style.css` contains all 7 template stylesheets VERBATIM, concatenated
  in the template layout.tsx import order (light.generated, appearance,
  team-chat, invitation-cards, team, staff, productivity), followed by a
  RIP MODE section covering only what the template does not: the approved
  black login and dialer-specific pieces (stats, mic bar, pipeline
  columns, Cal.com picker, chat threads).
- `index.html` dashboard shell follows the template's `page.tsx` /
  `AccountMenu.tsx` / `OrbMark.tsx` structure exactly: 248px sidebar
  (brand, workspace badge "Six Figure Blueprints", WORKSPACE nav,
  scope card, sidebar profile), topbar (mobile menu, breadcrumbs,
  appearance toggle, notifications "No notifications yet.", role chip,
  account menu with workspace switching), `page-heading` eyebrow + h1
  per tab, template `.card` / `.btn` / `.btn--primary` / `.input` /
  `.select` / `.table-wrap` classes. Nav tabs are RIP MODE's own
  (RIP MODE, Leads, Pipeline, Calendar, Call Log, Connections).
- Dark/light toggle works as the template does (data-appearance on
  .shell, persisted as `sfb-dashboard-appearance` in localStorage).
- The black split-screen login is unchanged (approved 2026-11-20).

Deliberate deviations (nothing else):
- Brand mark: the template's `/brand/sfb-blueprint-mark.png` was only in
  the blocked zip and was never uploaded individually — but on 2026-11-20
  the same asset was fetched from the live sixfigureblueprints.com
  homepage (`/brand/sfb-blueprint-mark.png`, the header logo) and is now
  used verbatim in the LOGIN (embedded as a data URI; source in `brand/`).
  The dashboard sidebar still uses the white star orb (template shell). Brand text is "SFB Connect /
  RIP MODE dialer" (the template's staff Brand reads "Sales Team /
  Universal employee workspace" — the dialer keeps its own identity).
- CALL / success green (#34d399, the template's base --green) is kept
  for the CALL button and success badges; the staff theme otherwise
  renders monochrome grey.
- The executive sample panels (Approvals / Failures / Hiring, with
  sample fixtures) are preserved as template source only — their sample
  data is NOT shown anywhere in the dialer. No fake data anywhere.
- Account-menu links that are not part of the dialer (Personal info,
  Account security, Templates, Manage users, Workspace settings,
  workspace switching/creation) say so plainly instead of faking a page.
  Logout works for real.

## UI (2026-11-20 redesign — superseded, see Login v3 below)
Black split-screen login in the reference style: left black panel with
"SFB CONNECT" and a white asterisk star, right dark panel with "Login",
underline Username/Password fields, round white SIGN IN button.
Same black system across the whole app (white primary actions, green only
for CALL/success). Critical CSS is inlined in index.html so the page can
never render as a plain white unstyled page even if style.css fails to
load (that is what Rome saw on 2026-11-20). Autofill guard: if a browser
fills an email into Username, it is cleared on load and login rejects any
username containing "@" with "Use your username, not your email".

## Login v2 — centred card + 4-digit passcode (2026-11-20)
Rome could not type in the split-screen login and the UI still looked
terrible, so the login was rebuilt to the dark centred-card reference:
small orb/star logo top-centre, "Yooo, welcome back!", "First time here?
Sign up for free", rounded dark Username + 4-digit Passcode fields, and a
full-width white pill "Sign in" button. No email field (username only),
no magic link, no SSO — those do not exist and are never faked. The
dashboard behind the login keeps the SFB Staff UI Template shell.

Typing fix — the real cause: the previous login's fields started
`readonly` and only became editable on focus, and `clearAutofill()`
timers (300/600/2000ms) wiped values after load. On Rome's device the
readonly field never became editable, so he could not type at all. Both
are GONE: the fields are plain inputs, no readonly, no disabled, no
timers, nothing clears typed text. Autofill is discouraged only by
autocomplete="off" / "new-password" and the visible "Username, not your
email" hint; if Chrome autofills an email, submit rejects "@" and the
user can tap and retype. Passcode inputs filter to digits only as typed
(max 4), never clearing the field.

## Login v3 — full-screen, SFB logo, Enter can never 404 (2026-11-20)
Rome signed in, pressed Enter, and landed on the sixfigureblueprints.com
404 ("This Page Isn't Part of the Build"). Root cause, confirmed live:
a native form GET submit navigates to `/ripmode?username=...&passcode=...`,
and any `/ripmode` URL with a query string 404s — verified by curl
(plain `/ripmode` 200, `/ripmode?test=1` 404). The Cloudflare routes
(`sixfigureblueprints.com/ripmode`, `sixfigureblueprints.com/ripmode/*`)
never deliver a query-string URL to this worker at all (the worker itself
serves the app for any `/ripmode` path regardless of query), so the fix
has to be in the app: the login form can never navigate, period.
- The form carries inline `onsubmit="return false"` +
  `action="javascript:void(0)"` in index.html, so even if app.js is stale
  or fails to load, Enter can never trigger a native navigation. app.js
  still handles submit with preventDefault + fetch, and the dashboard
  renders in place on the same page — no reload, no redirect, no query
  string, ever.
- Second bug fixed in the same pass: `doLogin()` set `doLogin.busy = true`
  BEFORE validation and returned early on validation errors without
  resetting it, permanently locking Sign in until a reload. Validation
  now runs first; busy is only set once the attempt is real.
- Rome's account state as found: `romanroyce` was `hasAccount:false` —
  his signup never completed server-side (the navigation aborted the API
  call before it ran), so NO passcode of his exists anywhere. He must
  sign up fresh: username romanroyce + a 4-digit passcode of his choice.
  Nothing of his was reset, cleared, or re-created. (All three users were
  hasAccount:false before and after this fix; the E2E test account was
  deleted.)
- Logo: the white star orb is GONE from the login. It is now the actual
  sixfigureblueprints.com logo — the white cube/blueprint mark from the
  site header's own asset (`/brand/sfb-blueprint-mark.png`, fetched from
  the live homepage 2026-11-20) + "SIX FIGURE BLUEPRINTS" wordmark,
  embedded as a data URI in index.html so the login never depends on the
  homepage worker. The source PNG is kept in `brand/` (cropped to the
  mark only; the mark itself is verbatim). The dashboard sidebar still
  uses the template's star orb (template shell, untouched).
- Layout: the login is now FULL-SCREEN — no card, no border, the content
  column (logo, wordmark, "Yooo, welcome back!", Username + 4-digit
  Passcode, full-width white pill Sign in, hints, Google Voice footer)
  fills the viewport (100dvh) with breathing room and nothing clipped or
  cropped, desktop and mobile. The inline critical CSS in index.html was
  updated to match, so a style.css failure still renders full-screen dark.
- Known route-level quirk that REMAINS: `/ripmode?anything` still 404s
  at the Cloudflare route level (no route/DNS change was made, per the
  brief). It can no longer be triggered from inside the app — but a
  bookmarked or pasted link with a query string would still 404. The
  live-browser check for the parent: type a non-allowlisted username +
  any 4 digits, press Enter — it must show a plain rejection and STAY on
  /ripmode, never 404.
- Verified 2026-11-20 ~13:27 UTC: deployed with deploy.py (KV binding
  preserved, worker modified 13:27:25 UTC); live text fetch confirms the
  new login serves (SFB logo data URI, onsubmit guard, 100dvh, "Yooo,
  welcome back!", 4-digit passcode; zero `login-orb`); E2E as temporary
  loganwells / 4-digit passcode passed (signup 200, duplicate 400, wrong
  401, short 401, login 200, state loads with Jax + Performance, logout
  200, post-logout state 401) and the test user + both sessions were
  deleted from KV — all three users confirmed hasAccount:false after
  (one stale KV read briefly showed loganwells true right after the
  delete; three re-checks after propagation all show false). Zero
  occurrences of the personal forwarding number in the app/worker.
