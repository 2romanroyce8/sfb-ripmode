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
- Calling: in-dashboard via Twilio Voice (2026-11-20, see "In-dashboard
  calling — Twilio Voice" below). TEXT stays Google Voice (213) 495-3536 —
  free, no API, so TEXT opens Google Voice with the message ready; nothing
  here auto-sends SMS. Until Twilio is configured on the server, CALL falls
  back to opening Google Voice and says so plainly — never a fake dial.
  Meeting emails are queued until Resend is wired; SMS opens Google Voice
  with the text ready — never claimed as sent automatically.
- Login has NO <form> (2026-11-20): Sign in is a `type="button"` button
  plus an explicit Enter keydown on the login inputs, both calling the one
  doLogin() path. With no form, Enter can never trigger a native GET
  submit to /ripmode?username=... .
- Asset URLs in index.html are ABSOLUTE (/ripmode/app.js?v=4,
  /ripmode/style.css?v=4) — never relative. See "Enter-key 404 root cause"
  below; relative URLs broke the app in real browsers.
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

## Enter-key 404 root cause (2026-11-20, found by live-request diagnosis)
Pressing Enter on the login twice sent the browser to
`/ripmode?username=...` and the homepage 404 ("This Page Isn't Part of the
Build") — even though the submit listener was present in the served
app.js, the form id matched, `node --check` passed, and shell-side fetches
of /ripmode/app.js looked perfect. The real cause: the page URL is
`/ripmode` with NO trailing slash, so the browser resolved the RELATIVE
`app.js` / `style.css` against the site root -> `/app.js` and `/style.css`
-> those paths do NOT match the worker routes (/ripmode, /ripmode/*), so
they went to the homepage (Next.js) worker, which 404s. Verified live:
`GET sixfigureblueprints.com/app.js` = homepage 404 HTML, while
`GET sixfigureblueprints.com/ripmode/app.js` = the real file. So in a real
browser app.js NEVER loaded: no listener, no doLogin, nothing — and the
login only looked right because of the inline fallback CSS (style.css
never loaded either, which is also why the dashboard looked unstyled).
Fix (deployed 2026-11-20 13:40 UTC): absolute asset URLs
`/ripmode/app.js?v=4` and `/ripmode/style.css?v=4` in index.html, AND the
<form> removed entirely (div + type="button" + explicit Enter keydown ->
doLogin()). Live fetch after deploy confirms the served index.html has no
<form>, absolute versioned asset URLs, and the served app.js matches local
byte-for-byte. E2E API test as a temporary loganwells account passed
(signup 200, duplicate rejected, wrong passcode 401, correct passcode 200,
state loads Jax + Performance, logout, post-logout 401); test user and
sessions deleted, all three users back to hasAccount:false, state untouched.
Note: one immediate re-login 401 right after signup was KV read-after-write
propagation lag across edge POPs, not a code bug — the signup token itself
worked, and the same login succeeded a minute later. The app logs users in
directly from the signup token, so this lag cannot bite a real sign-in.

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
- **SUPERSEDED by v3.1 below — this guard was itself the bug.** The form
  carried inline `onsubmit="return false"` + `action="javascript:void(0)"`
  in index.html, meant so that even if app.js is stale or fails to load,
  Enter can never trigger a native navigation. In practice the inline
  handler swallows the submit event before the app.js listener runs, so
  Enter silently did nothing at all (seen live 2026-11-20). Do NOT re-add it.
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

## Login v3.1 — Enter fix: remove the inline submit guard (2026-11-20)
The v3 guard backfired. A live-browser test typed a NON-allowlisted
username ("testuser") + "1234" and pressed Enter: the page stayed on
/ripmode (no 404 — that part was fixed), but Enter produced NO visible
response at all — no error, no success, no loading state, form unchanged.
Root cause, verified in code: the inline `onsubmit="return false"` on
#login-form swallows the submit event, so the app.js submit listener
never runs and doLogin() is never called. The fix:
- index.html: the form is now plain `<form id="login-form"
  autocomplete="off" novalidate>` — NO inline onsubmit, NO
  `action="javascript:void(0)"`. The app.js listener is the ONLY
  navigation guard: `loginForm.addEventListener("submit", (e) => {
  e.preventDefault(); doLogin(); })` — exactly one submit path, no
  separate click/keydown handlers (those would double-fire doLogin).
  Never re-add the inline guard; the comments in index.html and app.js
  say so. Trade-off accepted: if app.js ever fails to load, Enter will
  do a native GET submit and 404 loudly instead of dying silently.
- doLogin() now shows a visible loading state: the Sign in button reads
  "Signing in…" and is disabled while the request runs, restored in the
  `finally` block. Every outcome is visible: non-allowlisted username
  → "That username is not on the team…", bad passcode → "Enter a 4-digit
  passcode.", wrong passcode → 401 "Invalid username or passcode.",
  success → dashboard. Never a silent no-op, never a navigation, never
  a query string in the URL.
- Busy-flag fix from v3 confirmed still in place: validation runs BEFORE
  `doLogin.busy = true`, and `finally` always resets busy + button.
- Typing fix NOT regressed: no readonly, no clearAutofill timers.
  Full-screen layout, SFB logo, "Yooo, welcome back!", 4-digit passcode,
  required copy and Google Voice (213) 495-3536 all unchanged.
- Verified 2026-11-20 ~13:33 UTC: deployed with deploy.py (KV binding
  preserved, worker modified 13:33:09 UTC). First live fetch hit a stale
  edge cache (old page); re-fetch seconds later served the new page.
  Live text fetch confirms: no `onsubmit=`, no `javascript:void(0)`,
  clean form tag, "Yooo, welcome back!", SFB logo data URI,
  4-digit passcode; served app.js has the single submit listener,
  preventDefault + doLogin, and the "Signing in…" label. E2E as
  temporary loganwells / 4829 passed via the live API (signup 200,
  duplicate 400, wrong passcode 401, short passcode 401, correct login
  200; state via curl loads Jax + Performance, both New, stats zeroed;
  logout 200, post-logout state 401). Test user + all 3 test sessions
  deleted from KV (only `state` remains); all three users confirmed
  hasAccount:false after. Zero occurrences of the personal forwarding
  number in the app/worker.
- Testing notes (do not re-learn the hard way): (1) Python urllib's
  default User-Agent gets Cloudflare 1010 on this zone — always send
  `User-Agent: curl/8.0` (same lesson as the Cal.com helper). (2) When
  truncating a token for logging, NEVER reuse the truncated value as
  the token — a truncated token 401s on every authed call and looks
  exactly like a broken session store.
- Honest limitation: no live-browser tool in this session, so the Enter
  key itself was verified only in code + API. The parent MUST re-run the
  live-browser Enter test (non-allowlisted username + 4 digits + Enter):
  it must show a visible rejection and stay on /ripmode. Do not claim
  Enter works until that live check passes.

## Dashboard logo fix — sidebar star orb replaced with SFB logo (2026-11-20)
Rome signed in as @romanroyce and the dashboard still showed the template's
white asterisk/star orb (OrbMark) in the sidebar header next to "SFB Connect"
/ "RIP MODE dialer" — the same star already removed from the login. Fix:
- index.html: the sidebar brand `<span class="orb orb--md">` star SVG is
  replaced with `<img class="brand-logo">` using the SAME sixfigureblueprints.com
  cube-logo data URI as the login (brand/sfb-blueprint-mark.png, verbatim).
  The data URI is duplicated, not shared via JS — the sidebar renders even if
  app.js fails. "SFB Connect" / "RIP MODE dialer" text kept (the PNG is the
  mark only, no wordmark, so there is no duplicate text).
- Sizing: .brand-logo is 34x34px with object-fit:contain, matching the old
  orb--md slot in the flex .brand row — fully visible, not cropped, not
  stretched. Light-mode rule inverts it (mirrors the template's .orb
  invert treatment) so the white mark stays visible on a light sidebar.
- Other "logo-like" spots left alone: the "S" letter avatar in the "Six
  Figure Blueprints / Selected workspace" card and the "S" workspace letters
  in the account menu are letter avatars, not the orb; account-menu avatars
  are user initials. No other orb/star SVG exists in the app HTML/JS (the
  .orb rules left in style.css are dead template CSS for markup that no
  longer exists). Login untouched; no functionality changed.
- Verified 2026-11-20 ~14:01 UTC: deployed with deploy.py (KV binding
  preserved, worker modified 14:01:02 UTC). Live text fetch of
  sixfigureblueprints.com/ripmode serves the new page: brand-logo img x1,
  .brand-logo CSS rules x2, zero orb--md, zero star-SVG lines, login intact
  ("Yooo, welcome back!"), Google Voice (213) 495-3536. Read-only
  /auth/check: romanroyce hasAccount:true (Rome signed in himself — never
  touched), loganwells/braylengarrett hasAccount:false. No accounts created,
  logged in as, or modified; no E2E run. Zero occurrences of the personal
  forwarding number in the app/worker.
- Honest limitation: the dashboard is behind login, so it could not be
  visually verified in this session without Rome's passcode. Rome must check
  the sidebar himself after a hard refresh.

## Calendar tab — Cal.com booking layout (2026-11-20)
Rome sent a Cal.com booking-page screenshot and asked for the Calendar
tab to look like it. Rebuilt to that layout (not the reference's content):
- Left event-detail panel: host avatar (RR initials) + "Roman Royce",
  the 5 event-type picker, selected event title + description, duration,
  Google Meet, and a timezone dropdown defaulting to America/New_York
  (US zones only). No price — Rome's bookings are free.
- Right side: month grid for the CURRENT month (November 2026), SUN–SAT
  headers, dark date tiles, today marked with a dot, selected date as a
  white tile with a black dot (as in the reference), prev/next month
  arrows (prev disabled on the current month; past days and other-month
  days are dimmed and disabled). Selecting a date shows that day's time
  slots below the grid, then Book-for-lead, Confirm booking, and Book on
  Cal.com — the existing booking flow, unchanged.
- Real data only: Rome's 5 verified Cal.com event types (15 min meeting,
  30 min meeting, Secret meeting, Six Figure Blueprints — Discovery Call,
  Bingled — Website Strategy Call), booking link
  https://cal.com/roman-royce/30min. NOTHING copied from the reference:
  no "Ash", no "$20.00", no "Asia/Kuala Lumpur", no "Personalized Career
  Consultation" / "Let's Redefine Your Career" copy, no November 2025.
- Implementation: renderCalendar/bindCalendar in app.js now use a real
  month grid (calMonth/calDate state, today selected by default) instead
  of the old 14-day strip (nextDays() removed). New `.calbook*` /
  `.calday*` CSS appended to ripmode.css (source) and style.css (served
  file, same block). Asset versions bumped v=4 → v=5 in index.html so
  browsers fetch the new app.js/style.css.
- Verified 2026-11-20 ~14:16 UTC: deployed with deploy.py (KV binding
  preserved, worker modified 14:16:10 UTC). A Node harness rendering the
  real renderCalendar() passed 27 checks (all 5 event names, November
  2026, 35 day tiles, Nov 20 selected + today-marked, no forbidden
  reference strings, December navigation). Live fetch of
  sixfigureblueprints.com/ripmode serves the v=5 page; served
  /ripmode/app.js?v=5 and /ripmode/style.css?v=5 match local
  byte-for-byte. Zero occurrences of the personal forwarding number in
  the app/worker. No accounts created, logged in as, or modified; no E2E
  run (nothing mutates state).
- Honest limitation: the Calendar tab is behind login, so it could not be
  visually verified in this session without Rome's passcode. Rome must
  check the Calendar tab himself after a hard refresh.

## Button / pill hardening + iMessage + Recents (2026-11-20)
Rome sent the Connections screenshot: the Resend "Key pending" pill was a
tall round oval with "Key" / "pending" wrapped on two lines, next to clean
"Connected" pills. Same fault made Call Log "New" badges circles.
- Root cause: `.badge` / `.pill` are flex items in rows (`.kv`,
  `.conv-item`) whose default `align-items:stretch` stretched them to the
  full row height, and with no `white-space:nowrap` a long label wrapped
  inside. A stretched, wrapped pill reads as a circle. Fix (same block in
  ripmode.css and style.css): every pill/badge is `white-space:nowrap`,
  `flex-shrink:0`, self-aligned to its natural height (`.badge` top,
  `.pill` centred); `.kv` rows align to the top; `.btn` / `.slot` / `.day`
  / `.role-chip` are nowrap too. One consistent pill style app-wide —
  same font, radius, padding; colour only marks state (green connected,
  amber pending, grey neutral). No copy, colours' meaning, or behaviour
  changed. (One deliberate exception: `#book-meeting-btn` keeps
  `white-space:normal` — it is a full-width CTA whose long label may wrap
  on very narrow screens rather than overflow.)
- Call Log conversations are now iPhone Messages style: list rows with a
  round avatar circle (lead initials, e.g. JR / PR), bold lead name, grey
  preview line, last-activity time on the right, and a small blue dot for
  "New" leads instead of the old circle badge (no text in a circle ever).
  Opened thread: outgoing messages in blue bubbles on the right, incoming
  in grey bubbles on the left, centred grey timestamps above messages,
  calls as centred grey system rows ("Call — No answer · Nov 20, 2026 ·
  9:15 AM"), and an iMessage input bar (rounded field + round blue ↑ send
  button, same `#chat-send` id and behaviour).
- Call Log CALLS list is now iPhone Phone Recents style: each row shows
  the lead name, call type (↙ "Missed call" in red for no_answer /
  voicemail, ↗ "Outgoing call" for connected/dialed outcomes, with the
  readable outcome label), date/time on the right (time if today, else
  date), and an info chevron; tapping a row still opens that lead's chat
  thread. Empty state unchanged and honest ("No calls logged yet. Dial in
  RIP MODE and log the outcome.") — both leads currently have zero calls,
  so nothing is shown until a real call is logged. No messages, times, or
  history invented anywhere; all times/dates come from the stored call
  logs and messages.
- Verified 2026-11-20: `node --check` clean; a Node harness rendering the
  real `renderCallLog()` passed 26/26 checks (empty state, avatars,
  previews, blue dot, Recents rows, missed/outgoing, chevron, time/date,
  thread bubbles, stamps, send arrow, no table markup left). Deployed
  with deploy.py (KV binding preserved); asset versions bumped v=5 → v=6.
- Honest limitation: every tab is behind login, so the pills/bubbles/
  Recents rows could not be visually verified in this session without
  Rome's passcode. Rome must hard-refresh and check the Connections tab
  (Resend "Key pending" pill) and the Call Log tab himself.
- Pre-existing drift noted, not changed: style.css's RIP MODE login block
  still holds the superseded v2 centred-card rules while ripmode.css has
  the current v3 full-screen login — the live login renders full-screen
  because index.html's inline critical CSS wins. Out of scope for this
  fix; the files should be re-synced on the next login touch.

## Mock iPhone 18 — Call Log (2026-11-20)
Rome asked for the Call Log to look like an iPhone: a mock iPhone 18
with the Messages UI inside it, blue iMessage bubbles, same functions.
- The Call Log tab content renders inside a CSS iPhone (`.iphone`):
  rounded frame, thin bezel, Dynamic Island, side buttons, status bar
  (9:41 + signal/wifi/battery), home indicator bar. The phone is a
  FRAME around the existing working UI, not a picture of one.
- Inside the screen: ONE unified list (2026-11-20, replaces the old
  Messages/Recents segmented split — `phoneView` is gone). Each lead
  appears once, sorted most recent first, showing its latest activity:
  latest message text, or latest call type + outcome ("↗ Outgoing call
  · Dialed", "↙ Missed call · No answer" in red), with avatar initials,
  bold name, grey preview, time, blue unread dot. An iOS search bar
  sits under the "Messages" title (rounded grey field, magnifier,
  "Search" placeholder, × clear button): typing filters the list live
  by lead name / phone / message text / call outcome, with no re-render
  so the input keeps focus; no match shows an honest "No results. Try
  a different search." Tapping a row opens its thread inside the phone
  (iOS thread header: back chevron, avatar, name, phone · N calls
  logged); back returns to the list. Typing + Send saves to that
  lead's thread (same `#chat-input` / `#chat-send` ids and `addMessage`
  behaviour). Messages are iMessage bubbles — outgoing blue on the
  right, incoming grey on the left — with centred grey timestamps and
  calls as centred grey system rows. The Google Voice thread note
  stays ("Outbound texts go through Google Voice — use the TEXT button
  in RIP MODE to send them.").
- Real data only: Jax's real Dialed calls (Nov 20, 2026, 2:26 PM +
  2:27 PM + 2:30 PM — 3 logged) show exactly as logged; no messages
  exist yet, so threads show the honest empty state until Rome types
  one. Nothing invented. The phone is always dark (iOS Messages dark),
  whatever the dashboard appearance toggle is set to.
- Verified 2026-11-20: `node --check` clean; a Node harness loading the
  real app.js in a fake DOM passed 36/36 checks (unified list, each lead
  once, recency sort, search by name/phone/message/outcome, clear
  restores, thread with all 3 real sys rows, GV note kept, no invented
  content). Deployed with deploy.py (KV binding preserved); asset
  versions bumped v=7 → v=8.
- Honest limitation: the Call Log tab is behind login, so the phone
  mockup could not be visually verified in this session without Rome's
  passcode. Rome must hard-refresh and check the Call Log tab himself.

## Removals at Rome's request (2026-11-20, same deploy)
- RIP MODE subtitle deleted: "Dialer — calling from Google Voice
  (213) 495-3536. Google Voice has no API, so Call opens Google Voice
  with this lead's number ready — you talk, then log the outcome here."
  The "RIP MODE" heading stays with no replacement text; `render()`
  omits the subtitle paragraph when a tab's subtitle is empty, so no
  empty `<p>` is left behind. Other tabs keep their subtitles.
- CALL/TEXT explainer note deleted: "Call opens Google Voice (calls
  page) — dial (904) 621-6005 from (213) 495-3536. Text opens Google
  Voice messages — send from (213) 495-3536." The CALL and TEXT
  buttons themselves are unchanged and still open Google Voice with
  the lead's number from (213) 495-3536. The thread's own Google Voice
  note (above) stays.

## In-dashboard calling — Twilio Voice (2026-11-20)
Rome: "when i click call and text button it takes me out and opens google
voice thats not what should happen the call should start in dashboard."
Google Voice has no API, so no dashboard can call through it — the fix is
Twilio Voice in the browser. Rome approved it ("lets do it") after the
price check: one local number $1.15/mo, outbound $0.014/min + $0.004/min
browser leg (~$0.018/min of talking); 300–500 calls/day with 40–60
pickups ≈ $50–100/mo. One number serves all three users at once, and all
three can be on calls at the same time.

### How it works
- CALL uses the Twilio Voice JS SDK 2.19.0 (pinned CDN:
  https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.19.0/dist/twilio.min.js —
  verified 200, exposes window.Twilio.Device with getLocalStream /
  sendDigits / mute). The SDK loads lazily, only when CALL is pressed; the
  dashboard never depends on the CDN to render.
- Call states, all visible in the dialer: Dialing → Ringing → Connecting
  (→ Connected with live timer) → Ended, plus Failed / Busy / No answer.
  The mic row now has a phone icon + call state ("Ready to dial" /
  "Dialing…" / "Ringing…" / "Connected 00:42"), and the mic bar is the
  LIVE level. While a call is active the CALL button becomes red END CALL.
- Mic level: live from the call's own local stream
  (call.getLocalStream()) via a Web Audio analyser; if the SDK has no
  local stream, it falls back to the READY mic (getUserMedia). The
  standalone READY stream is stopped while the call owns the mic, so the
  mic is never captured twice.
- MUTE really mutes the Twilio call (call.mute) and updates in place —
  it never re-renders mid-call. KEYPAD sends real DTMF (call.sendDigits)
  once connected; before that it says to wait. SCRIPT opens the script
  panel (read it yourself — never auto-played). DROP VM ends the call and
  logs Voicemail. After a call ends, exactly ONE outcome is logged to the
  Call Log + session stats + the lead's thread, from the real call:
  Connected (stat connected), No answer (stat noAnswer), Busy (stat
  dials), failed dial (outcome "dialed", stat dials). Busy is detected
  best-effort from the SDK error text. Rome can still tap the manual
  disposition buttons afterwards, as before.
- TEXT stays Google Voice (Twilio SMS is a separate step, out of scope).

### Token endpoint (worker/router.js)
- GET /api/voice/status (session required) → {configured: bool}. No token
  minted; the client checks this on login to decide the CALL path.
- POST /api/voice/token (session required) → {token}, a 1-hour Twilio
  Access Token (JWT, HMAC-SHA256, cty twilio-fpa;v=1) minted in the worker
  with WebCrypto from env vars ONLY:
  TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET,
  TWILIO_TWIML_APP_SID. Set them in the Cloudflare dashboard (Workers ->
  sfb-ripmode-router -> Settings -> Variables). No secret value may ever
  appear in this repo, in any file, or in any response — only the var
  names. If any var is missing, the endpoint returns 503 "Calling not
  set up yet" and CALL falls back to Google Voice.
- The worker never dials anything itself — it only mints tokens; the
  browser SDK places the call.

### TwiML App setup (operator step — needs the Twilio dashboard)
1. Upgrade the account (Rome's step — see checklist below).
2. Number: the trial already has +1 737 232 4091 — verify it survives
   the upgrade as the calling number before buying another. If not, buy
   a US local number (Phone Numbers -> Buy a number, ~$1.15/mo).
3. Create an API Key (Console -> Account -> API keys -> Create API Key).
   The secret is shown ONCE — save it for the worker env vars. Never
   use the Account Auth Token in the worker; API keys are scoped and
   revocable.
4. Create a Twilio Function (Functions -> Create) that dials the lead
   with the Twilio number as caller ID:
   ```js
   exports.handler = function (context, event, callback) {
     const twiml = new Twilio.twiml.VoiceResponse();
     const dial = twiml.dial({ callerId: context.TWILIO_CALLER_ID }); // the purchased number
     dial.number(event.To); // the lead's number, passed by the dashboard
     callback(null, twiml);
   };
   ```
   Set TWILIO_CALLER_ID in the Function's environment variables to the
   purchased Twilio number.
5. Create a TwiML App (Voice -> TwiML Apps -> Create): Voice Request URL
   = the Function's URL (POST). Copy its SID — that is TWILIO_TWIML_APP_SID.
6. Set the four worker env vars (above) in the Cloudflare dashboard.
   Worker deploys do not wipe variables; no redeploy is needed after
   setting them — but the dashboard must be hard-refreshed to pick up
   the new CALL path (the status check runs on login).

### Test call box — owner only (2026-11-20)
- RIP MODE has a small "Test call — owner only" box (number input + CALL),
  rendered ONLY when the signed-in user is the owner (romanroyce). It is not
  rendered at all for staff (not hidden with CSS — not in the DOM).
- It dials the typed number through the EXACT same Twilio path as a lead
  call: same token endpoint, same SDK device, same TwiML App + Function,
  caller ID +1 239 349 9491. Same states (Dialing → Ringing → Connecting →
  Connected with timer), live mic level, MUTE, KEYPAD, END CALL. No Google
  Voice fallback for test calls — if Twilio is not live, it says so.
- The typed number is NEVER saved: not to KV, leads, the Call Log,
  conversations, session stats, or any file. It lives only in the input box
  and a module-memory draft, both wiped when the call ends (or the attempt
  fails). The outcome shows only in the dialer UI ("Test call ended —
  Connected 00:37. Not logged anywhere."). The status line never echoes the
  typed number. Rome's personal number must never be typed into any file,
  test, or harness — the harness uses +15551234567.
- Verified 2026-11-20 ~15:30 UTC: Node harness (/tmp/testcall-harness.js)
  29/29 against the real app.js — owner sees the box, staff do not; invalid
  numbers are rejected before dialling; the test call dials the typed number
  via device.connect; its outcome is UI-only with zero logDisposition posts
  and the input cleared; a lead call still logs exactly one disposition;
  the test button is blocked during a lead call; zero occurrences of Rome's
  personal number in the app. Deployed with deploy.py (KV binding preserved);
  asset versions v=9 → v=10. Live fetch: /ripmode 200, served app.js?v=10
  and style.css?v=10 match local byte-for-byte (sha256). /api/auth/check:
  romanroyce hasAccount:true — KV intact, no accounts touched, NO NUMBER
  DIALED. The box itself could not be visually verified without Rome's
  passcode — he must hard-refresh, sign in, and use it himself.

### Setup checklist (in order — live calling is BLOCKED until all done)
(a) Upgrade: DONE 2026-11-20 ~10:01 ET — Rome paid, account Active
    pay-as-you-go, balance $20.00.
(b) Number: DONE 2026-11-20 ~10:11 ET — +1 239 349 9491 (North Fort Myers,
    FL, $1.15/mo) bought and in inventory. The old trial number did NOT
    survive the upgrade.
(c) API key + TwiML App + Function exist; all four env vars set on the
    worker. PARTIALLY DONE, then broken — see "Vars wiped by the v=10
    deploy" below. As of ~10:37 ET the worker has TWILIO_ACCOUNT_SID and
    TWILIO_API_KEY_SECRET only; TWILIO_API_KEY_SID and TWILIO_TWIML_APP_SID
    still need to be re-supplied (values exist only in the Twilio console).
(d) Test call to Rome only, to his confirmed phone, before any lead is dialed.

### Known limits (honest)
- DROP VM ends the call and logs Voicemail — it does NOT play a recorded
  message into the call. Real voicemail-drop needs a recording + answering
  -machine detection, a future step.
- Busy detection is best-effort (SDK error text); a failed dial before
  answer logs as no_answer unless the error says busy/invalid.
- Stale tokens: the SDK device is cached per page load; if a token is
  older than 1 hour the call retries once with a fresh token.
- The dashboard must be hard-refreshed after the env vars are set (the
  Twilio check runs at login).

### Verified 2026-11-20 ~14:46 UTC
- Node harness (/tmp/twilio-harness.js) 39/39: JWT minting (structure,
  grants, 1h expiry, HMAC-SHA256 verifies, null on missing env) and the
  call-state machine (outcome mapping, timer labels, mute toggling a fake
  call, DTMF send, endCall logging connected/no_answer/voicemail with
  correct stats, checkTwilio false when unconfigured). The harness caught
  one real bug before deploy (endCall called a misnamed analyser
  function) — fixed and re-tested.
- Deployed with deploy.py (KV binding preserved, worker modified
  14:46:15 UTC); asset versions v=8 → v=9. Live fetch: /ripmode 200,
  served app.js?v=9 and style.css?v=9 match local byte-for-byte (sha256).
  /api/voice/status and /api/voice/token without a session return 401
  "Not signed in." — endpoints exist and are session-guarded.
  /api/auth/check: romanroyce hasAccount:true, loganwells false — KV
  intact, no accounts touched, no E2E run, NO NUMBER DIALED.
- NOT claimed: a real call has not been made. Live calling is blocked
  until the four checklist steps above are done.

### Vars wiped by the v=10 deploy — root cause + fix (2026-11-20 ~10:33–10:37 ET)
- SYMPTOM: Rome hit the Test call box and got "In-dashboard calling is not
  set up yet — the test call needs Twilio live", and the dialer showed
  "Calling via Google Voice until Twilio is live" — even though all four
  Twilio vars had been set in the Cloudflare dashboard at ~10:20 ET.
- ROOT CAUSE (proven via the Cloudflare API, GET .../workers/scripts/
  sfb-ripmode-router/settings): a script upload REPLACES the worker's
  bindings. The old deploy.py uploaded metadata with ONLY the KV binding,
  so the v=10 deploy (run AFTER the dashboard vars were set) silently
  wiped the three plain-text vars — TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID,
  TWILIO_TWIML_APP_SID. Only TWILIO_API_KEY_SECRET survived, because
  secrets live outside script metadata. /api/voice/status then returned
  configured:false. A second, smaller bug made it stick: checkTwilio() in
  app.js cached a `false` result for the whole page lifetime
  (`if (twilioReady !== null) return twilioReady`), so one check run while
  the vars were missing made the entire session believe Twilio was dead.
- FIX (deployed v=11, 2026-11-20 ~15:37 UTC):
  1. deploy.py now GETs the live worker's settings first and re-sends every
     existing binding (KV + plain-text vars) in the upload metadata, so a
     deploy can never wipe a var again. Secrets are deliberately excluded
     from upload metadata (the API rejects a secret binding without a text
     value) — they persist independently and are left untouched. Plain-text
     vars can also be supplied as environment variables at deploy time
     (e.g. TWILIO_ACCOUNT_SID=AC... python3 deploy.py); values are never
     printed. RULE: never deploy with cf.py worker-put or the old deploy.py
     after vars are set — only this deploy.py.
  2. app.js checkTwilio() now caches ONLY `true`. A `false` is re-checked
     against /api/voice/status on every CALL / test-call attempt, so fixing
     the server takes effect mid-session without a fresh login. The lead
     CALL handler re-checks on every attempt instead of only when
     twilioReady === null.
  3. TWILIO_ACCOUNT_SID was restored via the fixed deploy.py (value known).
     Verified after deploy: live settings show RIPMODE_KV,
     TWILIO_ACCOUNT_SID (plain_text) and TWILIO_API_KEY_SECRET
     (secret_text) — deploy did not wipe anything.
- STILL BLOCKED (values exist nowhere on this machine — do NOT guess them):
  TWILIO_API_KEY_SID and TWILIO_TWIML_APP_SID were wiped with the v=10
  deploy and cannot be recovered from any file, log, or API here. A browser
  task must read them from the Twilio console (API keys page / TwiML Apps
  page) and set them in the Cloudflare dashboard (Workers ->
  sfb-ripmode-router -> Settings -> Variables), or pass them as env vars
  to the fixed deploy.py. Until both are set, /api/voice/status stays
  configured:false and CALL keeps falling back to Google Voice — by design,
  never a fake dial.
- VERIFIED: Node harness (/tmp/checktwilio2-harness.js) 9/9 against the
  real app.js — false never cached, status re-fetched on every attempt,
  test call blocked while unconfigured then dials in the same session once
  the server reports configured, lead CALL re-checks instead of falling
  straight to Google Voice; original test-call harness still 29/29.
  Live fetch: /ripmode 200 serving v=11, served app.js?v=11 and
  style.css?v=11 match local byte-for-byte (sha256). /api/voice/status
  without a session returns 401 as before. NO NUMBER DIALED. Zero
  occurrences of Rome's personal number in any file.

### "Call failed — Call failed." — diagnosis + error-surfacing fix (2026-11-20 ~10:47 ET, deployed v=12)
- SYMPTOM: after all four Twilio vars were restored (~10:43 ET) and Rome
  signed out/in, the test call showed "Dialing…" then the alert "Call
  failed — Call failed." Twilio's own logs showed NO call attempt at all
  (call logs empty, Debugger empty for 24h, Function never invoked) — the
  failure happened upstream, in the browser SDK / token / device.connect
  step, before Twilio was reached. The TwiML App, the deployed Function
  and TWILIO_CALLER_ID were all verified correct in the Twilio console.
- DIAGNOSIS (code read, not guessed):
  1. The toast came from startTwilioCallTo's connect() catch:
     `callError = (e && e.message) || "Call failed."`, then
     `lastCallNote = "Call failed — " + callError`. It discarded e.code
     everywhere, and fell back to the bare "Call failed." when e.message
     was falsy. The Twilio Voice SDK 2.19.0 source (jsDelivr) was read:
     every generated TwilioError sets .message as "Name (code): message"
     and there is NO literal "Call failed" string in the SDK — so the
     rejection that produced the toast was not a TwilioError, or its
     message was empty. call.on("error") stored only e.message || e.code
     and device.on("error") only console.warned.
  2. PRIME BLACK HOLE — device registration: ensureTwilioDevice swallowed
     register() errors (`try { await device.register(); } catch (_) {}`).
     In SDK 2.x, register() awaits Registered-or-Unregistered, so an auth
     failure (31201/31202/31204/31205) resolves as Unregistered and the
     error is delivered ONLY via the device 'error' event — which the app
     never surfaced. The app then called device.connect() on an
     unregistered device with a dead stream. This is the leading
     explanation for a messageless connect() failure with zero Twilio log
     entries.
  3. Token minting (worker/router.js mintVoiceToken) verified CORRECT:
     header {typ:"JWT", alg:"HS256", cty:"twilio-fpa;v=1"}; payload jti /
     iss = API key SID / sub = account SID / exp = now+3600 / grants
     {identity: username, voice: {outgoing: {application_sid},
     incoming: {allow: true}}}; HMAC-SHA256 with the API key secret;
     b64/b64url correct. No minting bug found. Minor hardening only:
     same-second re-mints were byte-identical (jti had no random part).
  4. All four var NAMES confirmed present on the live worker via the
     Cloudflare API before the fix — the dashboard "deploy" after
     restoring them did not wipe them.
- FIX (deployed v=12, 2026-11-20):
  1. app.js `twilioErrorDetail(e)` formatter: code + message +
     description/explanation, recursing into .originalError, JSON fallback
     for plain objects, never an empty string, never a token/secret. Used
     in the connect() catch, the ensure-device catch, device.on("error")
     and call.on("error"). The dialer now shows e.g. "Call failed —
     (31202) AccessTokenSignatureValidationFailed: …" in the toast/alert
     AND as a persistent "Last call error" line (lastCallNote, rendered
     by #call-status-line) in the RIP MODE dialer panel, readable off a
     screenshot. A device sign-in failure is appended as "[Device
     sign-in also failed: …]".
  2. ensureTwilioDevice now CAPTURES register() failures: device 'error'
     events are stored in lastDeviceError (and shown live when idle), a
     register() throw is recorded, and a device whose state is still not
     "registered" after register() resolves is recorded as "did not
     register" instead of silently proceeding to connect().
  3. Auth-code retry: connect() failures with code 31201/31202/31204/
     31205 now also trigger the one fresh-token retry (previously only
     token/expiry message text did).
  4. endCall: a failed test call notes "Test call failed — (code): …"
     (still never logged anywhere); a failed lead call appends the error
     to its note. callOutcomeFor: an SDK-error failure now logs as
     "dialed" (a failed dial) instead of "no_answer" — no-answer is
     reserved for calls that rang with no error.
  5. worker/router.js: token jti now has a random suffix, so two tokens
     minted in the same second are never byte-identical.
  6. Google Voice fallback for lead calls is unchanged. No API key was
     rotated or created. The Function and TwiML App were not changed.
- WHAT THE NEXT RETRY WILL TELL US (Rome must retry the test call and
  screenshot the new error line — that is the real proof): 31202 = the
  stored API key secret (or Account/Key SID) is wrong → fix is a NEW API
  key via a browser task (the secret is shown once at creation and
  cannot be re-read; do not invent one). 31204 = malformed JWT (minting
  bug — none found in code). 31205 = expired. 31005/31009 = network /
  transport. 31401/31402 = microphone.
- VERIFIED: Node harness (/tmp/callerror-harness.js) 32/32 against the
  real app.js + real worker/router.js — error code/message surfaces for
  SDK errors (code-only, full TwilioError, string, null), device
  registration failures captured and appended, async call 'error' after
  connect surfaces in the test-call note with nothing logged, outcome
  mapping (error → dialed, silent → no_answer, busy → busy), 31204
  rejection retries once with a fresh token and dials, and token minting
  still produces a verifiable JWT (HMAC-SHA256 signature verifies,
  cty/iss/sub/exp/grants correct, jti unique across same-second mints,
  missing var → null). Previous harness (/tmp/checktwilio2-harness.js)
  still 9/9. Deployed with the FIXED deploy.py only; verified after
  deploy via the Cloudflare API that all five bindings are still present
  (RIPMODE_KV, TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID). Live fetch:
  /ripmode 200 serving v=12, served app.js?v=12, style.css?v=12 and
  index.html match local byte-for-byte. NO NUMBER DIALED. Zero
  occurrences of Rome's personal number in any file.

## AI Rep tab (2026-11-21, v=13) — see + customize the AI receptionist

New sidebar tab "AI Rep" (after Call Log), same template shell/cards/pills
as the other tabs. All three users can VIEW it; only the owner
(romanroyce) can SAVE changes — enforced in the browser AND in the
worker (403 for staff).

SEE:
- Status card: Live, answering number +1 239 349 9491, engine
  (ConversationRelay + Workers AI Llama 3.3 70B), cost ≈ $0.0785/min,
  calls today / total (from the receptionist KV).
- Recent calls: time (ET), caller number, outcome pill (Booked / Booking /
  Message / Question / Missed), AI summary; tap a call to expand the full
  transcript (Caller / Receptionist turns) and the owner-SMS status.

CUSTOMIZE (owner only) — what callers hear on the NEXT call:
- Greeting (first thing every caller hears), business name, short name,
  what the receptionist offers, about-the-business facts (only verified
  facts — this is all it may say about the company), booking link +
  booking label + offer-booking toggle, take-messages toggle.
- Save shows "Saved — live for the next call." A failed save shows the
  real error; a failed save never wipes what was typed.
- NOT editable from this tab, by design: the owner's notify number
  (NOTIFY_NUMBER — worker env var on sfb-receptionist) and the voice
  model / token limits.

HOW IT WORKS (proxy, no key in the browser):
- The receptionist WORKER_KEY is a SECRET env var (RECEPTIONIST_KEY) on
  sfb-ripmode-router, set via the Cloudflare API (never in a file, never
  in the client bundle, never in a URL). The router adds it server-side
  only: GET /api/airep/status, GET /api/airep/calls,
  GET /api/airep/config, POST /api/airep/config (owner-only).
- The receptionist worker reads its live config from KV key "config:live"
  on EVERY call (getConfig merges over DEFAULT_CONFIG) and serves it at
  GET /api/config; POST /api/config validates a patch and stores it.
  Twilio fetches /voice fresh per inbound call, so a save changes the
  greeting on the very next call — no redeploy.
- RULE: never deploy with cf.py worker-put or the old deploy.py after
  vars are set — only the fixed deploy.py (it re-sends existing
  bindings; secrets persist independently).

VERIFIED: Node harness (/tmp/airep-harness.mjs) 40/40 against the real
receptionist worker + real router.js + real app.js — config API auth
(403 without/wrong key), validation rejects (unknown field, non-https
link, short greeting, booking-on with no link), KV round-trip, /voice
TwiML carries the NEW greeting after a save, full simulated relay call
proves the live business name + offers reach the LLM system prompt,
toggle-off sim proves the prompt says booking/messages are off, proxy
owner-only save (staff 403), proxy never leaks the worker key in any
response, 503 with no RECEPTIONIST_KEY, static checks (tab/nav/v=13,
zero occurrences of Rome's personal number in all served assets).
Deployed v=13 with the fixed deploy.py scripts only; verified after
deploy via the Cloudflare API that all bindings are still present on
both workers (ripmode: RECEPTIONIST_KEY secret + RIPMODE_KV + 4 Twilio
vars; receptionist: AI + RECEPTIONIST_KV + WORKER_KEY + NOTIFY_NUMBER +
3 Twilio vars). Live: /ripmode 200, served app.js?v=13 and style.css?v=13
byte-identical to local, /api/airep/status without a session → 401,
receptionist /voice still serves the default SFB greeting (no live
config has been saved yet), /api/config without a key → 403.
NO NUMBER DIALED. No account touched.

## Analytics tab (2026-11-21, v=15) — real numbers from the dialer + receptionist

New sidebar tab "Analytics" (after AI Rep), same template shell/cards/
stat-boxes/pills as the other tabs. All three users can view it.

SHOWS (all computed live from the stored dialer state + receptionist
call log — nothing invented, nothing seeded):
- Stat cards: total dials, connected, connect rate %, no answer,
  voicemail, meetings booked, meeting conversion % (meetings ÷
  connected), dials per hour today, receptionist calls.
- Costs card: receptionist minutes × ≈ $0.0785/min (estimate, labelled);
  outbound talk cost — "Not tracked yet" (talk minutes aren't recorded
  by the dialer, so it cannot be totalled; ≈ $0.018/min when tracked);
  Twilio balance — "last confirmed $20.00 on Nov 20, 2026 — this is not
  a live balance" (labelled with the date, never claimed as current).
- CSS-bar charts (no chart library): calls per day, outcome breakdown,
  meetings per day, receptionist outcomes (Booked / Message / Question /
  Missed).
- Tables: per lead (dials, connected, last outcome, meetings) and per
  rep (Roman Royce / Logan Wells / Braylen Garrett — zeros shown honestly
  until a rep calls), plus the 5 most recent receptionist calls with
  outcome + summary (reuse of the AI Rep proxy) and a button back to AI
  Rep.
- Date filter: Today / Last 7 days / All time — actually filters every
  number on the tab (range buttons re-compute from the loaded state,
  no refetch needed; Refresh reloads state + receptionist calls).

HONEST RULES, built in:
- Empty state: "No calls yet — dial a lead in RIP MODE or wait for an
  inbound call." — shown whenever the selected range has zero outbound
  and zero receptionist calls.
- "Dials" follows the app's existing semantics: one logged callLog event
  counts once. A call that ends in a booking logs twice (the call and
  the booking), so Dials can run ahead of calls placed — the tab says
  this in a footnote under the stat cards.
- "Connected" = an outcome where a human picked up: connected,
  meeting_booked, not_interested, callback, receptionist, send_vsl
  (a manual "Conversation" disposition implies the person answered).
- Meetings are counted from the meeting_booked call-log entries (the
  booking event, server-dated "Nov 20, 2026"). The calendar's scheduled
  dates have no year and cannot be ranged reliably, so they are not
  used for Analytics.
- Date parsing trap, fixed: Date.parse guesses the WRONG year (2001)
  for year-less dates like "Friday, November 20", so parseStoredDate
  parses those by hand with the current year (verified by harness).
- Dials per hour today = today's dials ÷ hours since midnight, with a
  15-minute floor so one early dial does not read as 60/hour.
- Receptionist minutes come from durationSec; calls with no duration
  (missed / hung up before the relay) count as 0 minutes and are
  flagged ("N calls have no duration recorded, so the minutes above are
  a lower bound"), never guessed.
- Fast: computes from the state payload already loaded for the session
  plus the AI Rep proxy; no new KV writes on any view.

HOW IT WORKS: pure function computeAnalytics(state, repCalls, range,
nowMs) in app.js — every number is derivable in a Node harness without
a browser. loadAnalytics() reloads state + receptionist calls (reusing
aiRepCalls when the AI Rep tab already loaded them), then re-renders.
CSS bars (.an-bar-*) appended to BOTH ripmode.css and style.css (the
served file is style.css; keep them in sync, same as the .calbook
rules).

VERIFIED: Node harness (/tmp/analytics-harness.mjs) 65/65 against the
real app.js — parseStoredDate (server format, year-less format, garbage
→ null), hand-computed fixture (9 dials / 5 connected / 1 meeting all
time; 8/5/1 last 7 days; 3/2/0 today; connect rates 55.6% / 62.5% /
66.7%; receptionist 5.0 min ≈ $0.39 all time, 3.0 min ≈ $0.24 today),
per-day buckets, per-lead, per-rep (Logan 1 dial all time, 0 in 7d;
Braylen 0), empty state, render output (stat values, "Not tracked yet",
balance note with date, double-log footnote), tab wiring via
onNavigate("analytics"), zero occurrences of Rome's personal number.
Deployed v=15 with the fixed deploy.py only; verified after deploy via
the Cloudflare API that all bindings are still present on the worker
(RECEPTIONIST_KEY secret + RIPMODE_KV c4dd1ffc… + TWILIO_ACCOUNT_SID +
TWILIO_API_KEY_SID + TWILIO_TWIML_APP_SID + TWILIO_API_KEY_SECRET).
Live: /ripmode 200, served app.js?v=15 and style.css?v=15
byte-identical to local (sha256 match), Analytics nav present, zero
occurrences of Rome's personal number in all served files.
NO NUMBER DIALED. No account touched.

## BillMe sync

BillMe invoices sync into this CRM via Stripe webhooks (test mode).
Stripe -> sfb-billme-bridge worker (signature-verified) -> POST
/api/billme/sync (shared secret BILLME_SYNC_SECRET, secret env var) ->
Leads + Pipeline. Match by email, then business name. Paid invoice ->
Won, with amount + PaymentIntent ID + Stripe event ID on the deal.
Sent/open invoice -> Proposal. Duplicate Stripe events are no-ops.
See ~/workspace/billme-sync/README.md for setup and the deploy note.
