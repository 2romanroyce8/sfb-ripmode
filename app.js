/* RIP MODE standalone — frontend.
   API lives in the Cloudflare router worker (same origin at /ripmode/api when
   served from sixfigureblueprints.com, workers.dev URL when on Vercel).
   In-dashboard calling is Twilio Voice (2026-11-20): CALL dials through the
   browser via the Twilio Voice JS SDK when the token endpoint answers OK.
   Until Twilio is configured on the server, CALL falls back to opening
   Google Voice and says so plainly — never a fake dial. TEXT opens an
   in-app composer and sends a real SMS from +1 239 349 9491 via Twilio
   (POST /api/sms/send). Nothing here auto-plays a script. */
const WORKER_API = "https://sfb-ripmode-router.2romanroyce8.workers.dev/api";
// Prefix-aware (2026-11-21): the app serves at /ripmode AND /salesteam —
// API calls stay on the prefix the page was loaded from. Sessions are
// not bound to the path (same token works under both).
const API_BASE = location.hostname.includes("sixfigureblueprints.com")
  ? (location.pathname.startsWith("/salesteam") ? "/salesteam/api" : "/ripmode/api") : WORKER_API;
const GV_NUMBER = "(213) 495-3536";
/* Twilio Voice JS SDK 2.19.0 (pinned — do not use @latest). Verified live:
   https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.19.0/dist/twilio.min.js
   returns 200 and exposes window.Twilio.Device (plus Call, with
   getLocalStream / sendDigits / mute). Loaded lazily, only when CALL is
   pressed — the dashboard never depends on the CDN to render. */
const TWILIO_SDK_URL = "https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.19.0/dist/twilio.min.js";
const CAL_LINK = "https://cal.com/roman-royce/30min";
const ALLOWED_USERS = ["romanroyce", "loganwells", "braylengarrett"];

/* Token storage: "Remember me" (checked) = 30-day localStorage session;
   unchecked = this browser session only (sessionStorage). */
const TOKEN_KEY = "rip_token";
function readToken() { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ""; }
function saveToken(t) {
  const remember = document.getElementById("login-remember");
  const keep = !remember || remember.checked;
  if (keep) { localStorage.setItem(TOKEN_KEY, t); sessionStorage.removeItem(TOKEN_KEY); }
  else { sessionStorage.setItem(TOKEN_KEY, t); localStorage.removeItem(TOKEN_KEY); }
}
function clearToken() { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); }
let token = readToken();
let me = "";
let state = null;         // shared state from KV: leads, callLogs, conversations, meetings, stats
let currentTab = "dashboard"; // default landing tab (2026-11-21, v23): the overview
let ripIndex = 0;
let calEvent = null, calTime = null;
let calLeadId = null;   // Calendar "Book for lead" picker: selected lead id (null = none picked yet; booking falls back to the first lead, as the old <select> did)
let calLeadQuery = "";  // live search text for the lead picker; survives re-renders like phoneSearch
let calFilter = "all";  // Calendar booked-meetings filter: "all" (Everyone) or "mine" (My calendar) — per-session, default Everyone
const _calToday = new Date(); _calToday.setHours(0, 0, 0, 0);
let calMonth = {y: _calToday.getFullYear(), m: _calToday.getMonth()}; // viewed month
let calDate = new Date(_calToday); // selected day, defaults to today
let calTz = "America/New_York";
const CAL_TZ_LABELS = {"America/New_York": "Eastern", "America/Chicago": "Central", "America/Denver": "Mountain", "America/Los_Angeles": "Pacific", "America/Phoenix": "Mountain (no DST)"};
let activeConv = null;    // lead id for call-log conversation view
let phoneSearch = "";    // live filter text for the unified Call Log list inside the iPhone mockup
let micStream = null, micLevel = 0, micOn = false, muted = false;
let readyOn = false;      // READY toggle state (survives re-renders; the pill is rendered from this)
// In-app TEXT composer (2026-11-21): the TEXT button opens a composer in
// the RIP MODE iPhone frame and sends a real SMS via POST /api/sms/send.
// State survives re-renders in module memory; the draft is cleared only
// on a successful send or when the lead changes.
let smsComposerOpen = false;
let smsDraft = "";
let smsSending = false;
let smsComposerError = "";

/* ---------- Twilio in-dashboard calling (2026-11-20) ----------
   callState: "idle" | "dialing" | "ringing" | "connected" | "ended".
   The call object lives here (module scope) so re-renders never drop it.
   twilioReady: null = not checked yet, true = token endpoint OK (cached),
   false = not configured / check failed — NEVER cached (2026-11-20 fix:
   a stale false made the whole session believe Twilio was dead even after
   the server was fixed). A false result is re-checked on every CALL. */
let twilioReady = null;
let twilioDevice = null, twilioSdkPromise = null;
let activeCall = null;
let callState = "idle";
let callStartTs = 0, callTimerId = null;
let callAccepted = false, callError = "", callLogged = false, connectCancelled = false;
// Last Twilio device/registration error, formatted for the UI. The Voice SDK
// delivers registration/auth failures (31201/31202/31204/31205) on the device
// 'error' event, NOT through the connect() promise — and register() resolves
// even when the device ends up Unregistered — so without this the precise
// error was only ever a console.warn and the dial failed downstream with no
// detail at all. (2026-11-20: Rome's test call failed exactly this way —
// "Call failed — Call failed." — with zero Twilio log entries.)
let lastDeviceError = "";
let lastCallNote = "";
// Owner-only test call (2026-11-20): isTestCall marks a call dialled from the
// Test call box (a typed number, not a lead). A test call is never logged or
// saved anywhere — its outcome shows only in the dialer UI. The typed number
// itself lives only in testNumberDraft (module memory, cleared when the call
// ends) and in the input box; it is never written to KV, leads, the Call Log,
// conversations, session stats, or any file.
let isTestCall = false;
let testNumberDraft = "";
let callAudioCtx = null, callAnalyser = null, callAnalyserRAF = null, analyserSource = null; // "standalone" | "call"

/* ---------- Daily caps (2026-11-21) ----------
   Team caps + per-person caps (equal split, 3 members), reset at
   midnight America/New_York. The WORKER is the authority — every dial,
   talk second and email is checked server-side, so the browser can
   never bypass a cap from the console. The client only reads the
   numbers (GET /api/caps), reserves a dial before dialling
   (POST /api/caps/dial), and reports connected seconds when a call
   ends (POST /api/caps/call-end).
   Team: 500 dials, 150 talk min, 100 texts, 100 emails/day.
   Each person: 167 dials, 50 talk min, 33 texts, 33 emails/day.
   167x3 = 501, so the team 500 caps first — intended.
   Texts are sent by the receptionist as the system (no user
   attribution), so the texts row shows the TEAM line only — never
   invented per-person text numbers.
   Per-call max 3:45 (225s), warning at 3:00, auto-end at 3:45. */
const CAPS_DEFAULT_LIMITS = {
  team: { dials: 500, talkMin: 150, sms: 100, emails: 100, maxCallSec: 225 },
  users: {
    romanroyce: { dials: 167, talkMin: 50, sms: 33, emails: 33 },
    loganwells: { dials: 167, talkMin: 50, sms: 33, emails: 33 },
    braylengarrett: { dials: 167, talkMin: 50, sms: 33, emails: 33 },
  },
};
const CAPS_USERS = [
  { username: "romanroyce", name: "Roman Royce" },
  { username: "loganwells", name: "Logan Wells" },
  { username: "braylengarrett", name: "Braylen Garrett" },
];
let capsData = null;
let capsCutoff = false;
function capsLimits() { return (capsData && capsData.limits) || CAPS_DEFAULT_LIMITS; }
function capsTeam() { return (capsData && capsData.team) || { dials: 0, talkSec: 0, emails: 0, sms: null }; }
function capsMine() { return (capsData && capsData.mine) || { dials: 0, talkSec: 0, emails: 0 }; }
function capsMyLimits() { const l = capsLimits(); return (l.users && l.users[me]) || l.users.romanroyce; }
function capsMaxCallSec() { const t = capsLimits().team; return (t && t.maxCallSec) || 225; }
function capsTalkMin(sec) { const m = (sec || 0) / 60; return String(Math.round(m * 10) / 10); }
function capsCutoffNote() {
  const max = capsMaxCallSec();
  return max === 225 ? "Call ended at the 3:45 daily-limit cutoff." : "Call ended at the " + fmtElapsed(max) + " daily-limit cutoff.";
}
function capsBlockedReason() {
  if (!capsData) return "";
  const t = capsTeam(), m = capsMine(), tl = capsLimits().team, ul = capsMyLimits();
  if (t.dials >= tl.dials) return "Team daily limit reached — " + t.dials + "/" + tl.dials + " dials. Resets midnight ET.";
  if (m.dials >= ul.dials) return "Your daily limit reached — " + m.dials + "/" + ul.dials + " dials. Resets midnight ET.";
  if (t.talkSec >= tl.talkMin * 60) return "Team daily talk limit reached — " + Math.floor(t.talkSec / 60) + "/" + tl.talkMin + " minutes. Resets midnight ET.";
  if (m.talkSec >= ul.talkMin * 60) return "Your daily talk limit reached — " + Math.floor(m.talkSec / 60) + "/" + ul.talkMin + " minutes. Resets midnight ET.";
  return "";
}
function capsSmsBlockedReason() {
  // TEXT cap: team texts only (no per-person count — same as the caps
  // already built). The server is the authority; this only greys the
  // button — a console bypass still hits the server's 403.
  if (!capsData) return "";
  const t = capsTeam(), tl = capsLimits().team;
  if (typeof t.sms === "number" && t.sms >= tl.sms) return "Team daily text limit reached — " + t.sms + "/" + tl.sms + " texts. Resets midnight ET.";
  return "";
}
async function loadCaps() {
  try { capsData = await api("/caps", "GET"); } catch (e) { capsData = null; }
  updateCapsDom();
  syncCallUI();
}
// One progress-bar row: label, used label, numeric used/limit for the bar.
function capsBarRow(label, usedLabel, usedNum, limitNum, limitLabel) {
  const pct = limitNum > 0 ? Math.min(100, Math.round((usedNum / limitNum) * 100)) : 0;
  const over = usedNum >= limitNum;
  return `<div class="an-bar-row"><span class="an-bar-label">${esc(label)}</span><span class="an-bar-track"><span class="an-bar-fill" style="width:${pct}%;${over ? "background:#ff453a" : ""}"></span></span><span class="an-bar-val">${esc(usedLabel)} / ${esc(limitLabel)}</span></div>`;
}
function capsRowsHtml() {
  const t = capsTeam(), m = capsMine(), tl = capsLimits().team, ul = capsMyLimits();
  const smsUsed = (t.sms === null || t.sms === undefined) ? "—" : String(t.sms);
  const smsNum = (typeof t.sms === "number") ? t.sms : 0;
  const talkCost = "$" + ((t.talkSec / 60) * OUTBOUND_COST_PER_MIN).toFixed(2);
  const recep = (capsData && capsData.receptionistMinutes !== null && capsData.receptionistMinutes !== undefined)
    ? "Receptionist today: " + capsData.receptionistMinutes + " min · ≈ $" + (capsData.receptionistCostEst !== null && capsData.receptionistCostEst !== undefined ? capsData.receptionistCostEst.toFixed(2) : "?") + " (est.)"
    : "Receptionist minutes today: not available right now.";
  return `
    ${capsBarRow("Dials — you", String(m.dials), m.dials, ul.dials, String(ul.dials))}
    ${capsBarRow("Dials — team", String(t.dials), t.dials, tl.dials, String(tl.dials))}
    ${capsBarRow("Talk — you", capsTalkMin(m.talkSec) + " min", m.talkSec / 60, ul.talkMin, ul.talkMin + " min")}
    ${capsBarRow("Talk — team", capsTalkMin(t.talkSec) + " min", t.talkSec / 60, tl.talkMin, tl.talkMin + " min")}
    ${capsBarRow("Texts — team", smsUsed, smsNum, tl.sms, String(tl.sms))}
    <p class="caps-note">Texts are system-sent, shared by the team — no per-person count.${capsData && capsData.smsNote ? " " + esc(capsData.smsNote) : ""}</p>
    ${capsBarRow("Emails — you", String(m.emails), m.emails, ul.emails, String(ul.emails))}
    ${capsBarRow("Emails — team", String(t.emails), t.emails, tl.emails, String(tl.emails))}
    ${t.emails === 0 ? `<p class="caps-note">No emails sent yet — Resend not wired.</p>` : ""}
    <p class="caps-note">Outbound talk today ≈ ${talkCost} (est.) · ${esc(recep)} · Inbound receptionist calls are not capped — minutes and cost are shown so spend stays visible. Resets midnight ET.</p>`;
}
function capsStripHtml() {
  if (!capsData) return `<div class="card caps-strip" id="caps-strip"><div class="section-title" style="margin-top:0">Daily limits</div><div class="notice">Loading today's limits…</div></div>`;
  return `<div class="card caps-strip" id="caps-strip"><div class="section-title" style="margin-top:0">Daily limits — resets midnight ET</div>${capsRowsHtml()}</div>`;
}
// Compact caps strip for RIP MODE (2026-11-21): the same 7 numbers as
// capsRowsHtml (dials you/team, talk you/team, texts team-only, emails
// you/team) in one slim 4-column grid + one short notes line — the 8-row
// tall card is gone from this tab. The Analytics Daily Limits card keeps
// the full capsRowsHtml form.
function capsStripCompactHtml() {
  if (!capsData) return `<div class="card caps-strip caps-strip-compact" id="caps-strip"><div class="section-title" style="margin-top:0">Daily limits</div><div class="notice">Loading today's limits…</div></div>`;
  const t = capsTeam(), m = capsMine(), tl = capsLimits().team, ul = capsMyLimits();
  const smsUsed = (t.sms === null || t.sms === undefined) ? "—" : String(t.sms);
  const smsNum = (typeof t.sms === "number") ? t.sms : 0;
  const talkCost = "$" + ((t.talkSec / 60) * OUTBOUND_COST_PER_MIN).toFixed(2);
  const recep = (capsData && capsData.receptionistMinutes !== null && capsData.receptionistMinutes !== undefined)
    ? "Receptionist today: " + capsData.receptionistMinutes + " min" : "Receptionist minutes: n/a";
  const mini = (label, usedNum, limitNum, usedLabel, limitLabel) => {
    const pct = limitNum > 0 ? Math.min(100, Math.round((usedNum / limitNum) * 100)) : 0;
    const over = usedNum >= limitNum;
    return `<div class="caps-mini"><span class="caps-mini-label">${esc(label)}</span><b>${esc(usedLabel)} / ${esc(limitLabel)}</b><span class="caps-mini-bar"><span class="${over ? "over" : ""}" style="width:${pct}%"></span></span></div>`;
  };
  return `<div class="card caps-strip caps-strip-compact" id="caps-strip">
    <div class="section-title" style="margin-top:0">Daily limits — resets midnight ET</div>
    <div class="caps-grid">
      ${mini("Dials — you", m.dials, ul.dials, String(m.dials), String(ul.dials))}
      ${mini("Dials — team", t.dials, tl.dials, String(t.dials), String(tl.dials))}
      ${mini("Talk — you", m.talkSec / 60, ul.talkMin, capsTalkMin(m.talkSec) + " min", ul.talkMin + " min")}
      ${mini("Talk — team", t.talkSec / 60, tl.talkMin, capsTalkMin(t.talkSec) + " min", tl.talkMin + " min")}
      ${mini("Texts — team", smsNum, tl.sms, smsUsed, String(tl.sms))}
      ${mini("Emails — you", m.emails, ul.emails, String(m.emails), String(ul.emails))}
      ${mini("Emails — team", t.emails, tl.emails, String(t.emails), String(tl.emails))}
    </div>
    <p class="hint-line">Texts are team-only · Emails ${t.emails === 0 ? "0/" + tl.emails + " — Resend not wired" : t.emails + "/" + tl.emails} · Outbound talk ≈ ${talkCost} · ${esc(recep)} · Resets midnight ET.</p>
  </div>`;
}
// In-place refresh of the RIP strip (no full re-render, so a live call's
// DOM is never rebuilt under it). The Analytics card is refreshed by
// render() when that tab loads; its form is never wiped mid-edit.
function updateCapsDom() {
  const el = $("#caps-strip");
  if (el && capsData) {
    try { el.outerHTML = (currentTab === "rip" ? capsStripCompactHtml() : capsStripHtml()); } catch (_) {}
  }
}

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function money(amountCents, currency) {
  const n = (amountCents || 0) / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "usd").toUpperCase() }).format(n);
  } catch (_) { return "$" + n.toFixed(2); }
}
const fmtPhone = (p) => p || "";
const todayStr = () => new Date().toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"});
const nowTime = () => new Date().toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit"});
// Display helpers (2026-11-20) — formatting of real stored data only, nothing invented:
// initials for iMessage-style avatars; short date/time ("9:15 AM" if today, else "Nov 19, 2026");
// readable labels for the stored disposition keys (no_answer etc.).
const initialsFor = (name) => (name || "?").split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
const whenShort = (date, time) => (date === todayStr() ? (time || date) : (date || time || ""));
const CALL_LABELS = {no_answer: "No answer", voicemail: "Voicemail", not_interested: "Not interested", callback: "Callback", receptionist: "Receptionist", send_vsl: "VSL sent", dialed: "Dialed", connected: "Connected", busy: "Busy"};
const callLabel = (o) => CALL_LABELS[o] || o;
// Recents call type: the dialer only makes outbound calls. A call nobody
// answered (no_answer / voicemail) reads as a missed call (red, iPhone style);
// a call that connected (or was only dialed) reads as an outgoing call.
const isMissedCall = (c) => c.outcome === "no_answer" || c.outcome === "voicemail";

async function api(path, method, body) {
  const res = await fetch(API_BASE + path, {
    method: method || "GET",
    headers: {"Content-Type": "application/json", ...(token ? {Authorization: "Bearer " + token} : {})},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("Request failed: " + res.status));
  return data;
}

/* ---------- auth ---------- */
function showLogin(msg, isOk) {
  $("#dashboard").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
  const err = $("#login-error");
  if (msg) { err.textContent = msg; err.className = isOk ? "ok-note" : "error"; }
  else err.className = "hidden";
}
const DISPLAY_NAMES = {romanroyce: "Roman Royce", loganwells: "Logan Wells", braylengarrett: "Braylen Garrett"};
const INITIALS = {romanroyce: "RR", loganwells: "LW", braylengarrett: "BG"};
function roleFor(u) { return u === "romanroyce" ? "owner" : "staff"; }

function showDashboard() {
  $("#login-screen").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");
  const role = roleFor(me);
  const initials = INITIALS[me] || me.slice(0, 2).toUpperCase();
  $("#sidebar-avatar").textContent = initials;
  $("#sidebar-name").textContent = "@" + me;
  $("#sidebar-role").textContent = role;
  $("#account-avatar").textContent = initials;
  $("#account-popover-avatar").textContent = initials;
  $("#account-popover-name").textContent = DISPLAY_NAMES[me] || me;
  $("#account-popover-user").textContent = "@" + me;
  $("#role-chip").textContent = role;
  const isOwner = role === "owner";
  $("#manage-users-link").classList.toggle("hidden", !isOwner);
  $("#create-workspace").classList.toggle("hidden", !isOwner);
  const ws = document.querySelector("#account-popover .account-workspaces");
  if (ws) ws.classList.toggle("hidden", !isOwner);
  const ownerLinks = document.querySelector("#account-popover .account-links");
  if (ownerLinks) ownerLinks.classList.toggle("hidden", !isOwner);
  const staffBlock = $("#account-staff");
  if (staffBlock) staffBlock.classList.toggle("hidden", isOwner);
  updateNav();
  checkTwilio(); // fire-and-forget: decides CALL (Twilio vs Google Voice fallback)
  loadCaps(); // fire-and-forget: today's team + per-person limits for the strip
}

async function checkSession() {
  if (!token) { showLogin(); return; }
  try {
    const r = await api("/auth/status", "POST", {});
    me = r.username;
    await loadState();
    showDashboard();
    render();
  } catch (e) { token = ""; clearToken(); showLogin(); }
}

async function doLogin() {
  const username = $("#login-username").value.trim().toLowerCase();
  const passcode = $("#login-passcode").value;
  const confirm = $("#login-confirm").value;
  const err = $("#login-error");
  // Validate BEFORE setting doLogin.busy. The old order set busy=true first
  // and returned early on validation errors without resetting it, which
  // permanently locked the login until a page reload (any Enter with an
  // empty/invalid passcode, or an email in Username, bricked Sign in).
  if (username.includes("@")) {
    err.textContent = "Use your username, not your email.";
    err.className = "error"; return;
  }
  if (!ALLOWED_USERS.includes(username)) {
    err.textContent = "Wrong username or password";
    err.className = "error"; return;
  }
  if (!/^\d{4}$/.test(passcode)) { err.textContent = "Enter a 4-digit passcode."; err.className = "error"; return; }
  if (doLogin.busy) return; // form submit + Enter can double-fire — one attempt at a time
  doLogin.busy = true;
  const btn = $("#login-btn");
  btn.disabled = true;
  btn.dataset.label = btn.textContent;
  btn.textContent = "Signing in\u2026"; // visible loading state while the request runs
  try {
    const status = await api("/auth/check", "POST", {username});
    if (!status.hasAccount) {
      // first sign-in = signup
      if (passcode !== confirm) throw new Error("Passcodes do not match. Type the same 4 digits twice.");
      const r = await api("/auth/signup", "POST", {username, password: passcode});
      token = r.token; saveToken(token); me = username;
      await loadState(); showDashboard(); render();
      showToast("Account created for @" + username + ". That 4-digit passcode is saved — use it next time.");
    } else {
      const r = await api("/auth/login", "POST", {username, password: passcode});
      token = r.token; saveToken(token); me = username;
      await loadState(); showDashboard(); render();
    }
  } catch (e) {
    // Every failed sign-in shows one generic message (2026-11-21): it must
    // never reveal whether the username exists or which half was wrong.
    // The passcode-mismatch hint is the only exception — it is a local
    // format check on the confirm field, not an auth result.
    err.textContent = (e.message && e.message.indexOf("Passcodes do not match") === 0) ? e.message : "Wrong username or password";
    err.className = "error";
    // if account does not exist yet, show the confirm field so first sign-in can set a passcode
    try {
      const s = await api("/auth/check", "POST", {username});
      if (!s.hasAccount) $("#confirm-wrap").classList.remove("hidden");
    } catch (_) {}
  } finally { const b = $("#login-btn"); b.disabled = false; b.textContent = b.dataset.label || "Sign in"; doLogin.busy = false; }
}

function logout() {
  if (token) api("/auth/logout", "POST", {}).catch(() => {});
  token = ""; me = ""; clearToken();
  $("#login-passcode").value = ""; $("#login-confirm").value = "";
  $("#confirm-wrap").classList.add("hidden");
  showLogin();
}

async function loadState() { state = await api("/state", "GET"); }
async function mutate(op, payload) {
  state = await api("/state", "POST", {op, ...payload});
  render();
}
function showToast(msg) { alert(msg); }

/* ---------- shared helpers ---------- */
function leadById(id) { return (state.leads || []).find((l) => l.id === id); }
// Display name for a lead id, even after the lead itself was deleted
// (delete safeguard, 2026-11-21): the name stored on the newest call log
// / conversation / meeting for that lead, so orphaned history never
// renders blank. Falls back to "Deleted lead" — never "" and never a crash.
function leadNameFor(id) {
  const lead = leadById(id);
  if (lead) return lead.business;
  const calls = (state.callLogs || []).filter((c) => c.leadId === id);
  const lastCall = calls[calls.length - 1];
  if (lastCall && lastCall.leadName) return lastCall.leadName;
  const conv = (state.conversations || []).find((c) => c.leadId === id);
  if (conv && conv.leadName) return conv.leadName;
  const mtg = (state.meetings || []).find((m) => m.leadId === id);
  if (mtg && mtg.leadName) return mtg.leadName;
  return "Deleted lead";
}
function callsFor(leadId) { return (state.callLogs || []).filter((c) => c.leadId === leadId); }
function convFor(leadId) { return (state.conversations || []).find((c) => c.leadId === leadId); }
/* ---------- In-app texting (2026-11-21) ----------
   TEXT sends a real SMS from +1 239 349 9491 via POST /api/sms/send.
   A send is stored "sent — delivery not confirmed" (Twilio accept only);
   only a Twilio-confirmed delivery is ever "delivered". */
function smsStarterText(lead) {
  // One short starter in the no-answer follow-up tone. The rep can edit
  // it freely before sending — it is a suggestion, never auto-sent.
  const first = String(lead.owner || "").trim().split(/\s+/)[0] || "";
  const greet = first ? "Hi " + first + "," : "Hi there,";
  return greet + " this is Roman from SFB Connect. Tried you about " + lead.business + " — we help roofers answer every call with AI, so no customer ever gets voicemail. Want a free 30-min call to see how it works? Book here: " + CAL_LINK;
}
function smsStatusLabel(m) {
  // Honest delivery status for an in-app text. Thread messages saved
  // before in-app texting have no sms field: no label either way (the
  // app cannot know after the fact whether they were sent).
  const s = m && m.sms;
  if (!s || !s.status) return "";
  if (s.status === "delivered") return "Delivered";
  if (s.status === "sent-unconfirmed") return "Sent — delivery not confirmed";
  if (s.status === "undelivered") return "Not delivered" + (s.error ? " — " + s.error : "");
  if (s.status === "failed") return "Not delivered — " + (s.error || "send failed");
  if (s.status === "not-sent") return "Not sent — " + (s.error || "send failed");
  return "";
}
async function sendSmsInApp(leadId, text) {
  // Posts to the server (cap-checked + Twilio send + thread store).
  // Returns the server's result; throws with the server's message on
  // cap / config / Twilio failure. The caller reloads state + caps.
  return api("/sms/send", "POST", { leadId, text });
}
function smsComposerHtml(lead) {
  const conv = convFor(lead.id) || { messages: [] };
  const msgs = conv.messages || [];
  return `
  <div id="sms-composer" style="margin-top:10px">
    <div class="section-title">Text ${esc(lead.business)}</div>
    <div class="chat-thread" style="max-height:220px;overflow:auto">
      ${msgs.length ? msgs.map((m) => {
        const st = smsStatusLabel(m);
        return `<div class="msg ${m.from === "me" ? "out" : "in"}">${esc(m.text)}</div>${st ? `<div class="im-stamp" style="text-align:${m.from === "me" ? "right" : "left"}">${esc(st)}${m.sentBy ? " · " + esc(DISPLAY_NAMES[m.sentBy] || m.sentBy) : ""}</div>` : ""}`;
      }).join("") : `<div class="notice">No messages yet for this lead.</div>`}
    </div>
    <textarea class="input" id="sms-input" rows="4" placeholder="Type a text…">${esc(smsDraft)}</textarea>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn btn--primary" id="sms-send-btn" style="flex:1" ${smsSending ? "disabled" : ""}>${smsSending ? "Sending…" : "Send text"}</button>
      <button class="btn" id="sms-close-btn">Close</button>
    </div>
    ${smsComposerError ? `<div class="error" style="margin-top:8px">${esc(smsComposerError)}</div>` : ""}
    <p class="hint-line">Sends from +1 239 349 9491. Delivery is confirmed only when the carrier reports it — A2P registration is still pending, so a text can be blocked after it is sent.</p>
  </div>`;
}
function bumpStat(key) { state.sessionStats[key] = (state.sessionStats[key] || 0) + 1; }

function openGoogleVoiceCall(lead) {
  // CALL fallback only (Twilio not configured): Google Voice has no API
  // and no prefill URL — open the calls screen and let Rome dial from GV
  // itself. Texting never goes through Google Voice anymore (in-app SMS).
  window.open("https://voice.google.com/u/0/calls", "_blank");
}

/* ---------- Twilio in-dashboard calling (2026-11-20) ----------
   CALL dials through the browser via the Twilio Voice JS SDK. States:
   idle -> dialing -> ringing -> connected -> idle (ended). The call object
   lives in module scope so re-renders never drop it. When the token
   endpoint says Twilio is not configured (twilioReady === false), CALL
   falls back to Google Voice and says so plainly — never a fake dial.
   TEXT opens the in-app SMS composer (Twilio, +1 239 349 9491). */
function fmtElapsed(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
}
function callElapsed() { return callStartTs ? (Date.now() - callStartTs) / 1000 : 0; }
function callStateLabel(s, elapsedSec) {
  if (s === "dialing") return "Dialing…";
  if (s === "ringing") return "Ringing…";
  if (s === "connected") return "Connected " + fmtElapsed(elapsedSec);
  if (s === "ended") return "Call ended";
  return "Ready to dial";
}
// Pure: what gets logged when a Twilio call ends. accepted = the far end
// answered (the SDK 'accept' event fired). Busy is detected best-effort
// from the SDK error text; anything else that never connected logs as
// no_answer — dialer convention: nobody picked up. A failed dial (bad
// number) logs as "dialed" so the attempt is still counted.
function callOutcomeFor(o) {
  const accepted = !!(o && o.accepted);
  const errMsg = String((o && o.errorMsg) || "");
  if (accepted) return { outcome: "connected", stat: "connected" };
  if (/busy/i.test(errMsg)) return { outcome: "busy", stat: "dials" };
  if (/invalid|not a valid/i.test(errMsg)) return { outcome: "dialed", stat: "dials" };
  // Any other SDK error means the dial itself failed (bad token, dead
  // signaling, mic) — that is a failed dial, NOT "no answer". No-answer is
  // reserved for calls that rang with no error. (Before this, an auth
  // failure on a lead call was logged as "No answer", hiding the real cause.)
  if (errMsg) return { outcome: "dialed", stat: "dials" };
  return { outcome: "no_answer", stat: "noAnswer" };
}
function callStatusLine() {
  // Per-call cutoff warning (2026-11-21): from 3:00 into a connected call,
  // the status line warns the call ends at the daily-limit cutoff. The
  // exact 3:45 wording is used at the default 225s max; a changed max
  // shows the real remaining seconds instead.
  if (callState === "connected") {
    const elapsed = callElapsed(), maxSec = capsMaxCallSec();
    if (elapsed >= 180 && elapsed < maxSec) {
      return maxSec === 225
        ? "30 seconds left — this call ends at 3:45"
        : "This call ends at " + fmtElapsed(maxSec) + " — " + Math.max(0, Math.round(maxSec - elapsed)) + " seconds left.";
    }
  }
  // Test calls never echo the typed number in the status line — the number
  // is visible only in the input box Rome typed it into.
  if (isTestCall) {
    if (callState === "dialing") return "Dialing test number…";
    if (callState === "ringing") return "Ringing — waiting for an answer…";
    if (callState === "connected") return "Connected — " + fmtElapsed(callElapsed()) + ". Mute, keypad, script and DROP VM all work on this call.";
    if (lastCallNote) return lastCallNote;
    return "";
  }
  const lead = (state && state.leads) ? state.leads[ripIndex] : null;
  if (callState === "dialing") return "Dialing " + (lead ? lead.phone : "") + "…";
  if (callState === "ringing") return "Ringing " + (lead ? lead.business : "") + " — waiting for an answer…";
  if (callState === "connected") return "Connected — " + fmtElapsed(callElapsed()) + ". Mute, keypad, script and DROP VM all work on this call.";
  if (lastCallNote) return lastCallNote;
  if (twilioReady === false) return "Calling via Google Voice until Twilio is live — tap CALL to open Google Voice.";
  return "";
}
function syncCallUI() {
  const pill = $("#call-state");
  if (pill) pill.textContent = callStateLabel(callState, callElapsed());
  const blocked = capsBlockedReason();
  const btn = $("#call-btn");
  if (btn) {
    const active = callState !== "idle";
    btn.textContent = active ? "END CALL" : "CALL";
    btn.classList.toggle("end", active);
    // A cap hit disables CALL (lead calls) — the server is still the
    // authority; this is only the visible half. END CALL stays enabled.
    btn.disabled = !active && !!blocked;
  }
  const tbtn = $("#test-call-btn");
  if (tbtn) {
    tbtn.textContent = (callState !== "idle" && isTestCall) ? "END CALL" : "CALL";
    tbtn.disabled = callState === "idle" && !!blocked;
  }
  const note = $("#caps-block-note");
  if (note) { note.textContent = blocked; note.classList.toggle("hidden", !blocked); }
  const line = $("#call-status-line");
  if (line) { line.textContent = callStatusLine(); line.classList.toggle("hidden", !line.textContent); }
}
function setCallState(s) { callState = s; syncCallUI(); }
function startCallTimer() {
  stopCallTimer();
  capsCutoff = false;
  callTimerId = setInterval(() => {
    if (callState !== "connected") return;
    // Per-call cutoff (2026-11-21): at the daily-limit max (default
    // 3:45) the call ends via endCall("local") — the ended call keeps
    // its real outcome (connected), never mislabelled no-answer.
    if (callElapsed() >= capsMaxCallSec()) { capsCutoff = true; endCall("local"); return; }
    const st = $("#call-state");
    if (st) st.textContent = callStateLabel("connected", callElapsed());
    const line = $("#call-status-line");
    if (line) line.textContent = callStatusLine();
  }, 1000);
}
function stopCallTimer() { if (callTimerId) clearInterval(callTimerId); callTimerId = null; }

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the Twilio calling code. Check the connection and try again."));
    document.head.appendChild(s);
  });
}
// Format any Twilio SDK / device / token error into something Rome can read
// off a screenshot: code + message + description/explanation when present.
// TwilioError objects carry .code/.message/.description/.explanation/.causes
// and sometimes .originalError; raw gateway payloads are plain objects with
// .code/.message. Plain strings pass through. Never returns an empty string,
// and never includes a token or secret — only the error's own fields.
// (The old code read only e.message and fell back to a bare "Call failed.",
// so a rejection with no .message — exactly what Rome hit on 2026-11-20 —
// discarded the code entirely.)
function twilioErrorDetail(e) {
  if (e == null) return "no error detail from the calling code";
  if (typeof e === "string") return e.trim() ? e : "empty error from the calling code";
  const code = (e.code !== undefined && e.code !== null && e.code !== "") ? String(e.code) : "";
  let msg = (e.message || e.description || "") + "";
  const expl = (e.explanation || "") + "";
  // TwilioError.message already reads "Name (code): <explanation|message>".
  if (code && msg.indexOf("(" + code + ")") === -1) msg = "(" + code + ") " + msg;
  if (expl && msg.indexOf(expl) === -1) msg = msg ? msg + " — " + expl : expl;
  if (!msg) {
    if (e.originalError) return twilioErrorDetail(e.originalError);
    try {
      const j = JSON.stringify(e);
      if (j && j !== "{}") return "error object: " + j.slice(0, 300);
    } catch (_) {}
    return "error with no message or code";
  }
  return msg;
}
async function ensureTwilioDevice() {
  if (twilioDevice) return twilioDevice;
  if (!twilioSdkPromise) {
    twilioSdkPromise = (async () => {
      if (!window.Twilio || !window.Twilio.Device) await loadScript(TWILIO_SDK_URL);
      if (!window.Twilio || !window.Twilio.Device) throw new Error("Twilio calling code did not load.");
      const r = await api("/voice/token", "POST", {});
      if (!r.token) throw new Error("Calling not set up yet — Twilio is not configured on the server.");
      const device = new window.Twilio.Device(r.token, { logLevel: 1, codecPreferences: ["opus", "pcmu"] });
      device.on("error", (e) => {
        // Registration/auth failures (31201/31202/31204/31205) arrive HERE,
        // not through connect(). Record the precise error so the next dial
        // can say why instead of a bare "Call failed."
        lastDeviceError = twilioErrorDetail(e);
        console.warn("Twilio device error", e);
        if (callState === "idle" && currentTab === "rip") {
          lastCallNote = "Twilio device error — " + lastDeviceError;
          syncCallUI();
        }
      });
      try {
        await device.register();
      } catch (err) {
        // register() throws on a dead stream / bad state; the gateway auth
        // failure itself arrives via the device 'error' event above.
        lastDeviceError = lastDeviceError || twilioErrorDetail(err);
        console.warn("Twilio device registration failed", err);
      }
      if (device.state && device.state !== "registered") {
        // register() resolves even when the device ends up Unregistered (it
        // waits for Registered OR Unregistered). A device that never
        // registered cannot place a call — record it now instead of letting
        // connect() fail downstream with no detail.
        lastDeviceError = lastDeviceError || ("Twilio device did not register (state: " + device.state + ") — no error code was delivered.");
      }
      twilioDevice = device;
      return device;
    })();
    twilioSdkPromise.catch(() => { twilioSdkPromise = null; });
  }
  return twilioSdkPromise;
}
// Cheap check (no token minted): is Twilio configured on the server?
// Only a `true` result is ever cached. A `false` (not configured yet, or a
// transient failure) is NOT cached — every CALL / test-call attempt re-checks
// /api/voice/status, so fixing the server config takes effect immediately
// without a fresh login. (2026-11-20 root cause: the v=10 deploy wiped the
// plain-text worker vars, the first status check cached false, and the whole
// session then believed Twilio was dead for its entire lifetime.)
async function checkTwilio() {
  if (twilioReady === true) return true;
  try {
    const r = await api("/voice/status", "GET");
    twilioReady = !!r.configured;
  } catch (_) { twilioReady = false; }
  if (currentTab === "rip") render();
  return twilioReady;
}
// Wipes the typed test number from both the draft and the live input box.
// The number then exists nowhere — not in the DOM, not in memory.
function clearTestInput() {
  testNumberDraft = "";
  const ti = $("#test-number"); if (ti) ti.value = "";
}
async function logCallEnd(lead, m) {
  try { await mutate("logDisposition", { leadId: lead.id, outcome: m.outcome, stat: m.stat }); }
  catch (e) { console.warn("Could not log call outcome", e); }
}
// Lead call: dials the selected lead's number.
async function startTwilioCall(lead, retried) {
  return startTwilioCallTo(String(lead.phone || "").replace(/[^\d+]/g, ""), {retried: !!retried, isTest: false, lead});
}
// Owner-only test call: dials a typed number through the EXACT same Twilio
// path as a lead call (same token endpoint, same SDK device, same TwiML App
// and Function, same caller ID). The number is never logged or saved.
async function startTestCall(to) {
  return startTwilioCallTo(to, {isTest: true});
}
async function startTwilioCallTo(to, opts) {
  const isTest = !!(opts && opts.isTest);
  const retried = !!(opts && opts.retried);
  const lead = (opts && opts.lead) || null;
  if (!to) { showToast(isTest ? "Type a number to test-call first." : "This lead has no phone number on file."); return; }
  lastCallNote = "";
  isTestCall = isTest;
  connectCancelled = false;
  callAccepted = false; callError = ""; callLogged = false;
  // Daily caps (2026-11-21): reserve one dial server-side BEFORE the
  // device/token step, for lead calls AND owner test calls (a test call
  // costs the same). A 403 names the cap hit — personal or team — and
  // nothing dials. Only the first attempt reserves: a stale-token retry
  // (retried=true) reuses the reservation instead of counting twice.
  if (!retried) {
    try {
      await api("/caps/dial", "POST", {});
      await loadCaps();
    } catch (e) {
      isTestCall = false;
      lastCallNote = e.message || "Daily limit reached.";
      setCallState("idle");
      if (currentTab === "rip") render();
      showToast(lastCallNote);
      return;
    }
  }
  setCallState("dialing");
  let device;
  try {
    device = await ensureTwilioDevice();
  } catch (e) {
    setCallState("idle");
    if (isTest) { isTestCall = false; clearTestInput(); }
    lastCallNote = twilioErrorDetail(e);
    if (currentTab === "rip") render();
    // Test calls never fall back to Google Voice — there is nothing to open.
    showToast(isTest ? lastCallNote : lastCallNote + " Until Twilio is live, CALL opens Google Voice.");
    return;
  }
  let call;
  try {
    call = await device.connect({ params: { To: to } });
  } catch (e) {
    // Stale/invalid token: drop the cached device and retry once with a fresh
    // token. Match on the numeric code too — the rejection may carry a code
    // with no message at all (exactly what Rome hit on 2026-11-20).
    const code = e && e.code;
    if (!retried && (code === 31201 || code === 31202 || code === 31204 || code === 31205 || /token|expir|auth/i.test((e && e.message) || ""))) {
      twilioDevice = null; twilioSdkPromise = null;
      return startTwilioCallTo(to, {isTest, retried: true, lead});
    }
    callError = twilioErrorDetail(e);
    // If the device never registered (bad token/secret), say so: the connect
    // failure alone rarely carries the code.
    if (lastDeviceError) callError += " [Device sign-in also failed: " + lastDeviceError + "]";
    setCallState("idle");
    if (isTest) { isTestCall = false; clearTestInput(); }
    lastCallNote = "Call failed — " + callError;
    if (currentTab === "rip") render();
    showToast(lastCallNote);
    return;
  }
  if (connectCancelled) {
    try { call.disconnect(); } catch (_) {}
    setCallState("idle");
    if (isTest) {
      // Test call: outcome in the dialer UI only — never logged, never saved.
      lastCallNote = "Test call cancelled before it connected. Not logged anywhere.";
      isTestCall = false; clearTestInput();
      syncCallUI();
    } else {
      lastCallNote = "Call cancelled before it connected.";
      if (!callLogged) { callLogged = true; logCallEnd(lead, { outcome: "dialed", stat: "dials" }); }
    }
    return;
  }
  activeCall = call;
  call.on("ringing", () => { if (callState === "dialing") setCallState("ringing"); });
  call.on("accept", () => {
    callAccepted = true;
    callStartTs = Date.now();
    setCallState("connected");
    startCallTimer();
    attachCallMic(call);
  });
  call.on("disconnect", () => { if (callState !== "idle") endCall("remote"); });
  call.on("cancel", () => { if (callState !== "idle") endCall("cancel"); });
  call.on("error", (e) => { callError = twilioErrorDetail(e); });
  call.on("mute", (isMuted) => { muted = !!isMuted; syncMuteUI(); });
}
// how: "local" (Rome pressed END CALL) | "voicemail" (DROP VM) |
// "remote" (far end hung up / Twilio disconnected) | "cancel".
// Logs exactly ONE outcome per call, then returns to idle.
async function endCall(how) {
  if (callState === "idle") return;
  const wasAccepted = callAccepted;
  const errMsg = callError;
  // Connected seconds are reported FIRST — including test calls, which
  // return early below before any logging. Only time after the 'accept'
  // event counts: callStartTs is set on accept, so a call that never
  // connected reports 0 and is skipped. Ringing seconds never count.
  const connectedSec = wasAccepted ? Math.max(0, Math.round(callElapsed())) : 0;
  if (connectedSec > 0) {
    try { await api("/caps/call-end", "POST", { connectedSec }); } catch (e) { console.warn("Could not record talk time", e); }
  }
  const wasCutoff = capsCutoff; capsCutoff = false;
  try { await loadCaps(); } catch (_) {}
  const call = activeCall;
  activeCall = null;
  stopCallTimer();
  detachAnalyser();
  if ((how === "local" || how === "voicemail") && call) {
    try { call.disconnect(); } catch (_) {}
  }
  setCallState("idle");
  const m = how === "voicemail"
    ? { outcome: "voicemail", stat: "voicemail" }
    : callOutcomeFor({ accepted: wasAccepted, errorMsg: errMsg });
  if (isTestCall) {
    // Test call: outcome shows in the dialer UI only — never logged to the
    // Call Log, never saved to KV, and the typed number is wiped. If the
    // call failed with an SDK error, the note carries the real error (code +
    // message) instead of a bare outcome label — this is the persistent
    // "Last call error" line Rome reads off a screenshot.
    const elapsed = m.outcome === "connected" ? " " + fmtElapsed(callElapsed()) : "";
    lastCallNote = errMsg
      ? "Test call failed — " + errMsg + ". Not logged anywhere."
      : "Test call ended — " + (CALL_LABELS[m.outcome] || m.outcome) + elapsed + (wasCutoff ? " " + capsCutoffNote() : "") + ". Not logged anywhere.";
    isTestCall = false; clearTestInput();
    syncCallUI();
    return;
  }
  const lead = (state && state.leads) ? state.leads[ripIndex] : null;
  if (!lead || callLogged) return;
  callLogged = true;
  lastCallNote = "Call ended — " + (CALL_LABELS[m.outcome] || m.outcome) + (wasCutoff ? " " + capsCutoffNote() : "") + (errMsg ? " — " + errMsg : "") + ". Logged to the Call Log.";
  await logCallEnd(lead, m);
}
function syncMuteUI() {
  const pill = $("#live-pill");
  if (pill) pill.textContent = muted ? "MUTED" : "LIVE";
  const btn = $("#mute-btn");
  if (btn) btn.textContent = muted ? "UNMUTE" : "MUTE";
}
function toggleMute() {
  muted = !muted;
  if (activeCall) { try { activeCall.mute(muted); } catch (_) {} }
  syncMuteUI();
}
function sendDigit(k) {
  if (activeCall && callState === "connected") {
    try { activeCall.sendDigits(String(k)); } catch (e) { showToast("Could not send that key."); }
  } else if (activeCall) {
    showToast("Wait for the call to connect before using the keypad.");
  } else {
    showToast("Keypad works during a Twilio call — start a call first. Google Voice calls use the phone's own keypad.");
  }
}
/* Mic level meter. Two sources, one analyser: the standalone READY mic
   (getUserMedia) or, during a Twilio call, the call's own local stream
   (call.getLocalStream()) — the call already owns the mic, so the
   standalone stream is stopped to avoid capturing it twice. */
function attachAnalyser(stream, source) {
  detachAnalyser(true);
  try {
    if (!callAudioCtx) callAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (callAudioCtx.state === "suspended") callAudioCtx.resume().catch(() => {});
    const src = callAudioCtx.createMediaStreamSource(stream);
    const an = callAudioCtx.createAnalyser(); an.fftSize = 512;
    src.connect(an);
    callAnalyser = an; analyserSource = source;
    const buf = new Uint8Array(an.frequencyBinCount);
    const tick = () => {
      if (!callAnalyser) return;
      an.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      micLevel = Math.min(100, Math.round(avg * 1.6));
      const fill = $("#mic-fill"); if (fill) fill.style.width = micLevel + "%";
      callAnalyserRAF = requestAnimationFrame(tick);
    };
    tick();
  } catch (_) { /* the meter is cosmetic — never break a call over it */ }
}
function detachAnalyser(silent) {
  if (callAnalyserRAF) cancelAnimationFrame(callAnalyserRAF);
  callAnalyserRAF = null;
  if (callAnalyser) { try { callAnalyser.disconnect(); } catch (_) {} }
  callAnalyser = null; analyserSource = null;
  if (!silent && readyOn) startMic();
}
function attachCallMic(call) {
  let stream = null;
  try { stream = call.getLocalStream ? call.getLocalStream() : null; } catch (_) {}
  if (stream) {
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    micOn = true;
    attachAnalyser(stream, "call");
  } else if (!micOn) {
    startMic();
  }
}

/* ---------- shell: template nav / topbar / account menu ---------- */
const TAB_META = {
  dashboard: ["Dashboard", "Your team at a glance — real numbers, nothing invented."],
  rip: ["RIP MODE", ""], // no subtitle under the dialer heading (removed 2026-11-20 at Rome's request; GV number still shown on CALL/TEXT + in the thread note)
  leads: ["Leads", "New leads start in the Pipeline at \"New\"."],
  pipeline: ["Client Pipeline", "5 stages. Move a card with the arrows or the stage picker."],
  calendar: ["Calendar", "Cal.com — pick an event type, a day, and a time. Booking opens your real Cal.com link: https://cal.com/roman-royce/30min"],
  calllog: ["Call Log", "Every call, mirrored as a conversation. Tap a lead to open its chat thread."],
  airep: ["AI Rep", "See every call the AI receptionist takes — and change what callers hear on the next call."],
  analytics: ["Analytics", "Real numbers from the dialer and the receptionist — nothing invented."],
  email: ["Email", "Send follow-ups from roman@sixfigureblueprintsllc.com — honest status, never claimed sent unless Resend accepted."],
  assignments: ["Assignments", "Who's doing what, and by when."],
  announcements: ["Announcements", "Team-wide notes from the owner."],
  today: ["Today's Tasks", "Due today and overdue — yours first."],
  connections: ["Connections", "Honest status — nothing here is marked connected unless it was verified."],
};
function updateNav() {
  document.querySelectorAll(".nav-link").forEach((b) => {
    const on = b.dataset.tab === currentTab;
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    let dot = b.querySelector(".nav-active-dot");
    if (on && !dot) { dot = document.createElement("span"); dot.className = "nav-active-dot"; b.appendChild(dot); }
    if (!on && dot) dot.remove();
  });
  const meta = TAB_META[currentTab] || TAB_META.dashboard;
  const crumb = $("#crumb-title");
  if (crumb) crumb.textContent = meta[0];
}
function onNavigate(next) {
  currentTab = next;
  setMenuOpen(false);
  window.scrollTo(0, 0);
  // Nav reset (2026-11-21, v23): a typed sidebar-search filter or a
  // scrolled sidebar nav must never hide tabs after a navigation — the
  // v22 filter stayed applied when a tab was clicked, and the nav's own
  // scroll hid RIP MODE + Leads while the WORKSPACE label stayed put.
  // Reset both here, on every navigation.
  const navEl = document.querySelector(".nav");
  if (navEl) navEl.scrollTop = 0;
  if (sidebarSearch && sidebarSearch.value) { sidebarSearch.value = ""; filterSidebarNav(""); sbHideResults(); }
  updateNav();
  if (next === "airep") loadAiRep(); // loads status + calls + config, then re-renders
  if (next === "analytics") loadAnalytics(); // reloads state + receptionist calls, then re-renders
  if (next === "dashboard") { loadState().then(() => { if (currentTab === "dashboard") render(); }).catch(() => {}); }
  if (next === "email") loadEmailStatus(); // loads Resend connection state + fresh state, then re-renders
  if (next === "assignments" || next === "announcements" || next === "today") { loadState().then(() => { if (currentTab === next) render(); }).catch(() => {}); }
  render();
}
function setMenuOpen(open) {
  const shell = $("#shell");
  if (!shell) return;
  shell.classList.toggle("shell--menu-open", open);
  const btn = $("#mobile-menu");
  if (btn) {
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  }
}
document.querySelectorAll(".nav-link").forEach((b) => {
  b.addEventListener("click", () => onNavigate(b.dataset.tab));
});

/* Sidebar search (2026-11-21, reference UI): filters the 12 nav items by
   label; a section label hides when none of its links match. Cmd/Ctrl+K
   focuses the box; Escape clears it. */
function filterSidebarNav(q) {
  const query = (q || "").trim().toLowerCase();
  const nav = document.querySelector(".nav");
  if (!nav) return;
  // Walk the nav's children in order; a label owns the links after it.
  let label = document.getElementById("team-nav-label"); // WORKSPACE, above the nav
  let labelHasVisible = false;
  const flushLabel = () => { if (label) label.hidden = !labelHasVisible; };
  Array.from(nav.children).forEach((el) => {
    if (el.classList.contains("nav-label")) { flushLabel(); label = el; labelHasVisible = false; return; }
    if (!el.classList.contains("nav-link")) return;
    const match = !query || (el.textContent || "").toLowerCase().includes(query);
    el.hidden = !match;
    if (match) labelHasVisible = true;
  });
  flushLabel();
}
/* Lead results for the sidebar search (v22): typing also shows a dropdown
   of matching leads — same matching as the calendar's Book-for-lead picker
   (business, city, owner, phone digits or formatted, email). Arrows + Enter
   pick, click picks, Escape closes. Picking a lead switches to RIP MODE
   and selects it (same ripIndex path as Prev/Next lead). The nav filter
   above keeps working alongside it. */
const sidebarSearch = document.getElementById("sidebar-search");
const sidebarResults = document.getElementById("sidebar-search-results");
let sbHl = -1;
function sbHideResults() {
  if (sidebarResults) sidebarResults.classList.add("hidden");
  if (sidebarSearch) sidebarSearch.setAttribute("aria-expanded", "false");
  sbHl = -1;
}
function sbShowResults() {
  if (!sidebarSearch || !sidebarResults) return;
  sidebarResults.innerHTML = leadPickerItems(state ? state.leads : [], sidebarSearch.value, null);
  sidebarResults.querySelectorAll(".lead-picker-item").forEach((el) => { el.onclick = () => sbPickLead(el.dataset.pickLead); });
  sidebarResults.classList.remove("hidden");
  sidebarSearch.setAttribute("aria-expanded", "true");
}
function sbPickLead(id) {
  const idx = (state && state.leads ? state.leads : []).findIndex((l) => l.id === id);
  if (idx < 0) return;
  ripIndex = idx; smsComposerOpen = false; smsDraft = ""; smsComposerError = "";
  sidebarSearch.value = ""; filterSidebarNav(""); sbHideResults();
  onNavigate("rip");
}
function sbSetHl(i) {
  if (!sidebarResults) return;
  const items = Array.prototype.slice.call(sidebarResults.querySelectorAll(".lead-picker-item"));
  sbHl = items.length ? ((i % items.length) + items.length) % items.length : -1;
  items.forEach((el, j) => el.classList.toggle("hl", j === sbHl));
}
if (sidebarSearch) {
  sidebarSearch.addEventListener("input", () => { filterSidebarNav(sidebarSearch.value); sbHl = -1; sbShowResults(); });
  sidebarSearch.addEventListener("focus", () => sbShowResults());
  sidebarSearch.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sbShowResults(); sbSetHl(sbHl + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sbShowResults(); sbSetHl(sbHl - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const items = sidebarResults ? Array.prototype.slice.call(sidebarResults.querySelectorAll(".lead-picker-item")) : [];
      const el = items[sbHl >= 0 ? sbHl : 0];
      if (el) sbPickLead(el.dataset.pickLead);
    }
    else if (e.key === "Escape") { sidebarSearch.value = ""; filterSidebarNav(""); sbHideResults(); sidebarSearch.blur(); }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); sidebarSearch.focus(); sidebarSearch.select(); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!sidebarResults || sidebarResults.classList.contains("hidden")) return;
    let n = e.target, inside = false;
    while (n) { if (n.classList && n.classList.contains("sidebar-search-wrap")) { inside = true; break; } n = n.parentNode; }
    if (!inside) sbHideResults();
  });
}

/* Appearance toggle — exactly as the template: data-appearance on .shell,
   persisted under the template's localStorage key. */
function applyAppearance(a) {
  const shell = $("#shell");
  if (!shell) return;
  shell.dataset.appearance = a;
  $("#appearance-icon-sun").classList.toggle("hidden", a === "light");
  $("#appearance-icon-moon").classList.toggle("hidden", a === "dark");
  $("#appearance-toggle").setAttribute("aria-label", a === "dark" ? "Switch to light mode" : "Switch to dark mode");
}
function initAppearance() {
  applyAppearance(localStorage.getItem("sfb-dashboard-appearance") === "light" ? "light" : "dark");
}
initAppearance();
$("#appearance-toggle").addEventListener("click", () => {
  const shell = $("#shell");
  const next = shell.dataset.appearance === "dark" ? "light" : "dark";
  localStorage.setItem("sfb-dashboard-appearance", next);
  applyAppearance(next);
});

/* Mobile menu + scrim */
$("#mobile-menu").addEventListener("click", () => {
  setMenuOpen(!$("#shell").classList.contains("shell--menu-open"));
});
$("#sidebar-scrim").addEventListener("click", () => setMenuOpen(false));

/* Notifications — the template's popover: "No notifications yet." */
$("#notif-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("#notif-pop");
  const open = pop.classList.toggle("hidden") === false;
  $("#notif-btn").setAttribute("aria-expanded", String(open));
  if (open) $("#account-popover").classList.add("hidden");
});

/* Account menu — mirrors AccountMenu.tsx: outside click / Escape close it. */
$("#account-trigger").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("#account-popover");
  const open = pop.classList.toggle("hidden") === false;
  $("#account-trigger").setAttribute("aria-expanded", String(open));
  if (open) $("#notif-pop").classList.add("hidden");
});
document.addEventListener("pointerdown", (e) => {
  const menu = $("#account-menu");
  if (menu && !menu.contains(e.target)) $("#account-popover").classList.add("hidden");
  const notifBtn = $("#notif-btn");
  if (notifBtn && !notifBtn.contains(e.target)) $("#notif-pop").classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("#account-popover").classList.add("hidden");
    $("#notif-pop").classList.add("hidden");
    setMenuOpen(false);
  }
});
$("#account-logout").addEventListener("click", () => {
  $("#account-popover").classList.add("hidden");
  logout();
});
$("#sidebar-logout").addEventListener("click", logout);
document.querySelectorAll("[data-account-action]").forEach((b) => {
  b.addEventListener("click", () => {
    $("#account-popover").classList.add("hidden");
    showToast("That setting is not part of the RIP MODE dialer.");
  });
});
document.querySelectorAll("[data-workspace]").forEach((b) => {
  b.addEventListener("click", () => {
    $("#account-popover").classList.add("hidden");
    showToast("Workspace switching is not part of the RIP MODE dialer — this workspace is Six Figure Blueprints.");
  });
});
$("#create-workspace").addEventListener("click", () => {
  $("#account-popover").classList.add("hidden");
  showToast("Creating a new workspace is not part of the RIP MODE dialer.");
});
$("#staff-settings-btn").addEventListener("click", () => {
  $("#account-popover").classList.add("hidden");
  openStaffSettings();
});

function render() {
  if (!state) return;
  const main = $("#main");
  const meta = TAB_META[currentTab] || TAB_META.dashboard;
  const sub = currentTab === "leads"
    ? `${(state.leads || []).length} leads. New leads start in the Pipeline at "New".`
    : meta[1];
  let body = "";
  if (currentTab === "dashboard") body = renderDashboard();
  else if (currentTab === "rip") body = renderRip();
  else if (currentTab === "leads") body = renderLeads();
  else if (currentTab === "pipeline") body = renderPipeline();
  else if (currentTab === "calendar") body = renderCalendar();
  else if (currentTab === "calllog") body = renderCallLog();
  else if (currentTab === "airep") body = renderAiRep();
  else if (currentTab === "analytics") body = renderAnalytics();
  else if (currentTab === "email") body = renderEmail();
  else if (currentTab === "assignments") body = renderAssignments();
  else if (currentTab === "announcements") body = renderAnnouncements();
  else if (currentTab === "today") body = renderToday();
  else if (currentTab === "connections") body = renderConnections();
  main.innerHTML = `<div class="page-heading"><div><span class="eyebrow">YOUR WORKSPACE</span><h1>${esc(meta[0])}</h1>${sub ? `<p>${esc(sub)}</p>` : ""}</div></div>` + body;
  // Full-panel Call Log (2026-11-21, v23): the iPad fills the whole panel —
  // the shell class drives the height/width rules in ripmode.css.
  const shell = $("#shell");
  if (shell) shell.classList.toggle("tab-calllog", currentTab === "calllog");
  bindTab();
}

/* ---------- RIP MODE ---------- */
function renderRip() {
  const leads = state.leads || [];
  const lead = leads[ripIndex] || null;
  if (!lead) return `<div class="notice">No leads yet. Add one in the Leads tab.</div>`;
  const isOwner = roleFor(me) === "owner"; // Test call box: owner only — not rendered at all for staff (not hidden with CSS, not in the DOM)
  const calls = callsFor(lead.id);
  const last = calls[calls.length - 1];
  const s = state.sessionStats || {};
  const script = (state.scripts && state.scripts[0]) || {title: "Roofer pitch", body: "Hi, this is Roman from SFB Connect — we build AI receptionists for roofers that answer every call, book jobs, and follow up automatically. Got 60 seconds for me to show you what that looks like for your company?"};
  // Dialer inside the iPhone frame (2026-11-21). Every control ID is the
  // same as the old dialer card, so bindRip / syncCallUI keep working
  // untouched. The business name is SMALL here — the lead card keeps the
  // full details (dedupe: no full-size name heading in both cards).
  const dialerInner = `
      <div class="iphone-dialer">
        <div class="lead-line"><b>${esc(lead.business)}</b> · <span style="color:#98989d;font-size:13px">Ready to dial</span></div>
        <div class="mic-wrap">
          <span class="pill" id="call-pill"><svg class="call-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span id="call-state">${esc(callStateLabel(callState, callElapsed()))}</span></span>
          <div class="mic-bar"><div class="mic-fill" id="mic-fill" style="width:${micLevel}%"></div></div>
          <span class="pill" id="live-pill">${muted ? "MUTED" : "LIVE"}</span>
        </div>
        <div class="lead-line" style="font-size:26px;font-weight:800">${esc(lead.phone)}</div>
        <div id="call-status-line" class="${callStatusLine() ? "notice" : "hidden"}" style="margin-top:6px">${esc(callStatusLine())}</div>
        <div class="ready-row" style="margin-top:10px">
          <button class="btn btn--primary" id="ready-btn" style="flex:1;padding:12px">READY</button>
          <span class="pill on" id="ready-state">${readyOn ? "Ready" : "Not ready"}</span>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn" id="mute-btn" style="flex:1">${muted ? "UNMUTE" : "MUTE"}</button>
          <button class="btn" id="keypad-btn" style="flex:1">KEYPAD</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" id="script-btn" style="flex:1">SCRIPT</button>
          <button class="btn" id="dropvm-btn" style="flex:1">DROP VM</button>
        </div>
        <div id="script-box" class="hidden" style="margin-top:10px">
          <div class="field"><label>${esc(script.title)}</label>
          <textarea class="input" readonly rows="5">${esc(script.body)}</textarea></div>
          <p class="notice">Read it yourself on the call — the script is not played automatically.</p>
        </div>
        <div id="keypad-box" class="hidden" style="margin-top:10px">
          <div class="slots">${["1","2","3","4","5","6","7","8","9","*","0","#"].map((k) => `<button class="slot" data-key="${k}">${k}</button>`).join("")}</div>
        </div>
        <button class="big-call${callState !== "idle" ? " end" : ""}" id="call-btn" ${callState === "idle" && capsBlockedReason() ? "disabled" : ""}>${callState !== "idle" ? "END CALL" : "CALL"}</button>
        <div id="caps-block-note" class="${capsBlockedReason() ? "error" : "hidden"}" style="margin-top:8px">${esc(capsBlockedReason())}</div>
        <button class="btn" id="text-btn" style="width:100%;margin-top:8px;padding:13px" ${capsSmsBlockedReason() ? "disabled" : ""}>TEXT</button>
        ${capsSmsBlockedReason() ? `<div class="error" style="margin-top:8px">${esc(capsSmsBlockedReason())}</div>` : ""}
        ${smsComposerOpen ? smsComposerHtml(lead) : ""}
      </div>`;
  return `
  ${capsStripCompactHtml()}
  <div class="grid2 rip-grid">
    <div class="card rip-compact">
      <div class="lead-line">
        <span class="badge">#${ripIndex + 1} / ${leads.length}</span>
        <div style="margin-top:8px" class="rip-lead-name">${esc(lead.business)}</div>
        <div>${esc(lead.niche || "Roofing")}</div>
        <div>Owner: ${esc(lead.owner || "no name on file")}</div>
        <div>Phone: ${esc(lead.phone)}</div>
        ${lead.email ? `<div>Email: ${esc(lead.email)}</div>` : `<div>Email: none on file</div>`}
      </div>
      ${calls.length ? `
      <div class="section-title">Last Call</div>
      <div class="lead-line">${esc(last.date)} at ${esc(last.time)} — ${esc(last.outcome)}<br>
      Called ${calls.length} time${calls.length === 1 ? "" : "s"} total.</div>` : `
      <div class="section-title">Last Call</div>
      <div class="notice">First call — no call history yet.</div>`}
      <div class="section-title">Session Data</div>
      <div class="stat-strip">
        <div class="stat-cell"><div class="num">${s.dials || 0}</div><div class="lbl">Dials</div></div>
        <div class="stat-cell"><div class="num">${s.connected || 0}</div><div class="lbl">Connected</div></div>
        <div class="stat-cell"><div class="num">${s.noAnswer || 0}</div><div class="lbl">No Answer</div></div>
        <div class="stat-cell"><div class="num">${s.voicemail || 0}</div><div class="lbl">Voicemail</div></div>
        <div class="stat-cell"><div class="num">${s.meetings || 0}</div><div class="lbl">Meetings</div></div>
        <div class="stat-cell"><div class="num">${s.perHour || 0}</div><div class="lbl">Per Hour</div></div>
      </div>
      <div class="section-title">Outcomes</div>
      <div class="dispo-row">
        <button class="btn" data-dispo="no_answer">No Answer</button>
        <button class="btn" data-dispo="voicemail">Voicemail</button>
        <button class="btn" data-dispo="not_interested">Not Interested</button>
        <button class="btn" data-dispo="callback">Callback</button>
        <button class="btn" data-dispo="receptionist">Receptionist</button>
        <button class="btn" data-dispo="send_vsl">Send VSL</button>
      </div>
      <button class="btn btn-green" id="book-meeting-btn" style="width:100%;padding:14px;font-size:16px;margin-top:10px">MEETING BOOKED — CONFIRM + EMAIL + SMS</button>
      <p class="hint-line">Confirm books the meeting; email queued (Resend pending), confirmation text sent in-app.</p>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn" id="prev-lead" ${ripIndex === 0 ? "disabled" : ""}>← Prev lead</button>
        <button class="btn" id="next-lead" ${ripIndex >= leads.length - 1 ? "disabled" : ""}>Next lead →</button>
      </div>
    </div>
    <div>
      ${iphoneChrome(dialerInner, {compact: true, label: "iPhone showing the dialer"})}
      ${isOwner ? `
      <div class="card" style="margin-top:12px">
        <div class="section-title" style="margin-top:0">Test call — owner only</div>
        <div style="display:flex;gap:8px">
          <input class="input" id="test-number" type="tel" inputmode="tel" autocomplete="off" placeholder="Enter a number to test-call" value="${esc(testNumberDraft)}" style="flex:1;min-width:0">
          <button class="btn" id="test-call-btn">${callState !== "idle" && isTestCall ? "END CALL" : "CALL"}</button>
        </div>
        <p class="hint-line">Same Twilio path from +1 239 349 9491. Number never saved.</p>
      </div>` : ""}
    </div>
  </div>`;
}

function bindRip() {
  const leads = state.leads || [];
  const lead = leads[ripIndex];
  if (!lead) return;
  const prev = $("#prev-lead"), next = $("#next-lead");
  // The TEXT composer belongs to one lead: changing leads closes it.
  if (prev) prev.onclick = () => { if (ripIndex > 0) { ripIndex--; smsComposerOpen = false; smsDraft = ""; smsComposerError = ""; render(); } };
  if (next) next.onclick = () => { if (ripIndex < leads.length - 1) { ripIndex++; smsComposerOpen = false; smsDraft = ""; smsComposerError = ""; render(); } };
  document.querySelectorAll("[data-dispo]").forEach((b) => {
    b.onclick = async () => {
      const d = b.dataset.dispo;
      const map = {no_answer: "noAnswer", voicemail: "voicemail", not_interested: "connected", callback: "connected", receptionist: "connected", send_vsl: "connected"};
      await mutate("logDisposition", {leadId: lead.id, outcome: d, stat: map[d] || "connected"});
    };
  });
  const bookBtn = $("#book-meeting-btn");
  if (bookBtn) bookBtn.onclick = async () => {
    await mutate("bookMeeting", {leadId: lead.id});
    const mtgs = (state.meetings || []).filter((x) => x.leadId === lead.id);
    const m = mtgs[mtgs.length - 1];
    const when = m ? (m.date + (m.time ? " " + m.time : "")) : "";
    let emailNote;
    if (!lead.email) {
      emailNote = "No email on file for this lead — confirmation email skipped.";
    } else {
      const e1 = EMAIL_TEMPLATES.find((t) => t.id === "e1");
      const merged = mergeEmailTemplate(e1, lead, when);
      try {
        await mutate("sendEmail", {leadId: lead.id, to: lead.email, subject: merged.subject, body: merged.body});
        emailNote = "Confirmation email sent to " + lead.email + ".";
      } catch (e2) {
        try { await loadState(); } catch (_) {}
        emailNote = "Email not sent — " + (e2.message || "try again.");
        render();
      }
    }
    // Confirmation text, in-app (2026-11-21): the old flow opened Google
    // Voice. The text now goes through POST /api/sms/send — the toast
    // reports what actually happened, never a claimed send.
    const text = `Hi, this is Roman from SFB Connect — confirming our meeting. Here is the booking link if you need it: ${CAL_LINK}`;
    let smsNote;
    try {
      await sendSmsInApp(lead.id, text);
      await loadState(); await loadCaps();
      smsNote = "Confirmation text sent — delivery not confirmed yet.";
    } catch (e2) {
      try { await loadState(); await loadCaps(); } catch (_) {}
      smsNote = "Text not sent — " + (e2.message || "try again.");
    }
    render();
    showToast("Meeting booked for " + lead.business + ". " + emailNote + " " + smsNote);
  };
  const readyBtn = $("#ready-btn");
  if (readyBtn) readyBtn.onclick = async () => {
    readyOn = !readyOn;
    const rs = $("#ready-state");
    rs.textContent = readyOn ? "Ready" : "Not ready";
    if (readyOn) await startMic(); else stopMic();
  };
  const muteBtn = $("#mute-btn");
  if (muteBtn) muteBtn.onclick = () => toggleMute(); // in-place: never re-render mid-call
  const keypadBtn = $("#keypad-btn");
  if (keypadBtn) keypadBtn.onclick = () => $("#keypad-box").classList.toggle("hidden");
  document.querySelectorAll(".slot").forEach((s) => { s.onclick = () => sendDigit(s.dataset.key); });
  const scriptBtn = $("#script-btn");
  if (scriptBtn) scriptBtn.onclick = () => $("#script-box").classList.toggle("hidden");
  const dropVm = $("#dropvm-btn");
  if (dropVm) dropVm.onclick = () => {
    // During a Twilio call: end it and log Voicemail. (Twilio cannot inject
    // a recorded message into a live call without a recording + AMD — that
    // is a future step, documented in the README. This ends + logs, in sync.)
    if (activeCall) { endCall("voicemail"); return; }
    const s = (state.scripts && state.scripts[0]) || {};
    showToast("No active call — start a call first, then DROP VM when it goes to voicemail. The voicemail script:\n\n" + (s.vm || "Hi, this is Roman from SFB Connect — we help roofers answer every call with AI and book more jobs. Call me back at " + GV_NUMBER + "."));
  };
  const callBtn = $("#call-btn");
  if (callBtn) callBtn.onclick = async () => {
    if (callState !== "idle") { endCall("local"); return; } // END CALL
    const blocked = capsBlockedReason();
    if (blocked) { showToast(blocked); return; } // cap hit — the server would refuse too
    if (twilioReady) { await startTwilioCall(lead); return; }
    // Not known-live: re-check the server status on EVERY attempt (a false
    // is never cached — see checkTwilio). Only if it is still not ready do
    // we fall back to Google Voice.
    const ok = await checkTwilio();
    if (ok) { await startTwilioCall(lead); return; }
    // Google Voice fallback (Twilio not configured yet) — same as before:
    // log the dial, then open Google Voice. The status line says so plainly.
    await mutate("logDisposition", {leadId: lead.id, outcome: "dialed", stat: "dials", dialOnly: true});
    openGoogleVoiceCall(lead);
  };
  const textBtn = $("#text-btn");
  if (textBtn) textBtn.onclick = () => {
    const blocked = capsSmsBlockedReason();
    if (blocked) { showToast(blocked); return; }
    smsComposerOpen = !smsComposerOpen;
    if (smsComposerOpen && !smsDraft) smsDraft = smsStarterText(lead);
    smsComposerError = "";
    render();
  };
  // In-app TEXT composer (2026-11-21): lives inside the iPhone frame,
  // under the TEXT button. The draft survives re-renders in module
  // memory; it clears only on a successful send or a lead change.
  const smsInput = $("#sms-input");
  if (smsInput) smsInput.addEventListener("input", () => { smsDraft = smsInput.value; });
  const smsClose = $("#sms-close-btn");
  if (smsClose) smsClose.onclick = () => { smsComposerOpen = false; smsComposerError = ""; render(); };
  const smsSend = $("#sms-send-btn");
  if (smsSend) smsSend.onclick = async () => {
    const text = (smsInput ? smsInput.value : smsDraft).trim();
    if (!text || smsSending) return;
    smsSending = true; smsComposerError = "";
    smsSend.disabled = true; smsSend.textContent = "Sending…";
    try {
      await sendSmsInApp(lead.id, text);
      smsDraft = "";
      await loadState(); await loadCaps();
      render();
    } catch (e) {
      smsComposerError = e.message || "Text failed — try again.";
      try { await loadState(); await loadCaps(); } catch (_) {}
      render();
    }
    smsSending = false;
  };
  // Owner-only test call box (rendered only for the owner — see renderRip).
  // Dials the typed number through the same Twilio path as a lead call, with
  // NO Google Voice fallback and NO logging: the number is never saved.
  const testInput = $("#test-number");
  if (testInput) testInput.addEventListener("input", () => { testNumberDraft = testInput.value; });
  const testBtn = $("#test-call-btn");
  if (testBtn) testBtn.onclick = async () => {
    if (callState !== "idle") {
      if (isTestCall) { endCall("local"); return; } // END CALL on the test call
      showToast("A lead call is in progress — end it before starting a test call.");
      return;
    }
    const to = String((testInput ? testInput.value : "") || "").replace(/[^\d+]/g, "");
    if (!/^\+?\d{7,15}$/.test(to)) { showToast("Type a full phone number to test-call, e.g. +1 555 123 4567."); return; }
    const blocked = capsBlockedReason();
    if (blocked) { showToast(blocked); return; } // test calls count against the caps too
    if (!twilioReady) {
      const ok = await checkTwilio();
      if (!ok) { showToast("In-dashboard calling is not set up yet — the test call needs Twilio live."); return; }
    }
    await startTestCall(to);
  };
}

async function startMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({audio: true});
    micOn = true;
    attachAnalyser(micStream, "standalone");
    const st = $("#call-state"); if (st && callState === "idle") st.textContent = "Mic live — ready to dial";
  } catch (e) {
    micOn = false;
    const st = $("#call-state"); if (st && callState === "idle") st.textContent = "Mic blocked — allow microphone access in the browser";
    showToast("Microphone is not available in this browser — check the site's microphone permission. The mic bar will stay at zero.");
  }
}
function stopMic() {
  micOn = false; micLevel = 0;
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  if (analyserSource === "standalone") detachAnalyser(true);
  const fill = $("#mic-fill"); if (fill) fill.style.width = "0%";
  const st = $("#call-state"); if (st && callState === "idle") st.textContent = "Ready to dial";
}

/* ---------- LEADS ---------- */
function renderLeads() {
  const leads = state.leads || [];
  return `
  <div class="card" style="margin-bottom:16px">
    <div class="grid2">
      <div class="field"><label>Business name</label><input class="input" id="nl-business" type="text" placeholder="Acme Roofing"></div>
      <div class="field"><label>Phone</label><input class="input" id="nl-phone" type="tel" placeholder="(407) 555-0100"></div>
      <div class="field"><label>Niche / what they do</label><input class="input" id="nl-niche" type="text" placeholder="Roofing"></div>
      <div class="field"><label>Owner name (optional)</label><input class="input" id="nl-owner" type="text" placeholder=""></div>
      <div class="field"><label>Email (optional)</label><input class="input" id="nl-email" type="email" placeholder=""></div>
      <div class="field"><label>City (optional)</label><input class="input" id="nl-city" type="text" placeholder=""></div>
    </div>
    <button class="btn btn--primary" id="add-lead-btn">Add lead</button>
    <span style="margin:0 8px;color:var(--muted)">or</span>
    <label class="btn" style="display:inline-grid">Import CSV <input id="csv-input" type="file" accept=".csv" style="display:none"></label>
  </div>
  <div class="card"><div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Business</th><th>Niche</th><th>Phone</th><th>Owner</th><th>Email</th><th>Stage</th><th></th></tr></thead>
    <tbody>${leads.map((l, i) => `<tr>
      <td>${i + 1}</td><td><b>${esc(l.business)}</b></td><td>${esc(l.niche || "")}</td>
      <td>${esc(l.phone)}</td><td>${esc(l.owner || "no name on file")}</td><td>${esc(l.email || "—")}</td>
      <td>${esc(l.stage || "New")}</td>
      <td><button class="btn" data-convert="${l.id}">Convert to client</button>
      <button class="btn btn-danger" data-del="${l.id}">Delete</button></td>
    </tr>`).join("")}</tbody>
  </table></div></div>`;
}
function bindLeads() {
  const add = $("#add-lead-btn");
  if (add) add.onclick = async () => {
    const business = $("#nl-business").value.trim();
    const phone = $("#nl-phone").value.trim();
    if (!business || !phone) { showToast("Business name and phone are required."); return; }
    await mutate("addLead", {business, phone, niche: $("#nl-niche").value.trim(), owner: $("#nl-owner").value.trim(), email: $("#nl-email").value.trim(), city: $("#nl-city").value.trim()});
  };
  const csv = $("#csv-input");
  if (csv) csv.onchange = async () => {
    const file = csv.files[0]; if (!file) return;
    const text = await file.text();
    const rows = text.split(/\r?\n/).filter(Boolean).slice(1);
    for (const row of rows) {
      const c = row.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
      if (c[0] && c[1]) await mutate("addLead", {business: c[0], phone: c[1], niche: c[2] || "", owner: c[3] || "", email: c[4] || "", city: c[5] || ""});
    }
    showToast("CSV imported.");
  };
  document.querySelectorAll("[data-convert]").forEach((b) => b.onclick = async () => {
    await mutate("setStage", {leadId: b.dataset.convert, stage: "In conversation"});
    currentTab = "pipeline"; render();
  });
  document.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => {
    // Delete safeguard (2026-11-21): no native confirm(), no single-click
    // delete. An in-app modal asks first, and the server refuses any
    // delete without confirmed:true — so a stray click or a console call
    // cannot delete silently. The lead's call history is never deleted.
    const lead = leadById(b.dataset.del);
    if (lead) confirmDeleteLead(lead);
  });
}
/* Delete confirm modal — appended to document.body (outside #main) so a
   re-render can never wipe it mid-decision. Template classes only
   (.card / .btn / .btn--primary / .btn-danger). Cancel, Escape, or the
   backdrop closes it and deletes nothing. Confirm sends confirmed:true;
   the server still re-checks it. */
function confirmDeleteLead(lead) {
  closeDeleteConfirm();
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.id = "delete-confirm";
  overlay.innerHTML = `<div class="card confirm-card" role="dialog" aria-label="Delete lead">
    <div class="section-title" style="margin-top:0">Delete this lead?</div>
    <p><b>${esc(lead.business)}</b>${lead.phone ? ` · ${esc(lead.phone)}` : ""}</p>
    <p class="notice">Its call history stays in the Call Log.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn" id="delete-cancel" type="button">Cancel</button>
      <button class="btn btn-danger" id="delete-confirm-btn" type="button">Delete lead</button>
    </div>
  </div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDeleteConfirm(); });
  overlay.querySelector("#delete-cancel").onclick = () => closeDeleteConfirm();
  overlay.querySelector("#delete-confirm-btn").onclick = async (e) => {
    e.target.disabled = true; // one delete only — no double-click double-delete
    closeDeleteConfirm();
    try { await mutate("deleteLead", {leadId: lead.id, confirmed: true}); }
    catch (err2) { showToast("Delete failed — " + (err2.message || "try again.")); }
  };
  document.body.appendChild(overlay);
  document.addEventListener("keydown", confirmDeleteEscape);
  const cancel = overlay.querySelector("#delete-cancel");
  if (cancel) cancel.focus();
}
function confirmDeleteEscape(e) {
  if (e.key === "Escape") closeDeleteConfirm();
}
function closeDeleteConfirm() {
  document.removeEventListener("keydown", confirmDeleteEscape);
  const old = document.getElementById("delete-confirm");
  if (old) old.remove();
}

/* ---------- PIPELINE ---------- */
const STAGES = ["New", "In conversation", "Proposal", "Won", "Lost"];
function renderPipeline() {
  const leads = state.leads || [];
  return `
  <div class="pipeline">${STAGES.map((st) => `
    <div class="stage-col"><div class="stage-head">${esc(st)} (${leads.filter((l) => (l.stage || "New") === st).length})</div>
    ${leads.filter((l) => (l.stage || "New") === st).map((l) => `
      <div class="pcard"><b>${esc(l.business)}</b>
        <div class="meta">${esc(l.niche || "")} · ${esc(l.phone)}</div>
        <div class="meta">${esc(l.owner || "no name on file")}</div>
        ${l.invoice ? `<div class="meta">Invoice ${esc(l.invoice.number || l.invoice.id || "")} · ${l.invoice.status === "paid" ? "Paid" : (l.invoice.status === "sent" ? "Sent" : "Open")} ${money(l.invoice.amountCents, l.invoice.currency)}${l.invoice.status === "paid" && l.invoice.paidAt ? " · " + esc(new Date(l.invoice.paidAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })) : ""}</div>` : ""}
        ${l.source === "billme" ? `<div class="meta">via BillMe</div>` : ""}
        <div style="display:flex;gap:6px;margin-top:8px">
          <button class="btn" data-move="${l.id}|-1" ${STAGES.indexOf(l.stage || "New") === 0 ? "disabled" : ""}>←</button>
          <select class="select" data-stagepick="${l.id}" style="flex:1">${STAGES.map((s) => `<option ${s === (l.stage || "New") ? "selected" : ""}>${s}</option>`).join("")}</select>
          <button class="btn" data-move="${l.id}|1" ${STAGES.indexOf(l.stage || "New") === STAGES.length - 1 ? "disabled" : ""}>→</button>
        </div>
      </div>`).join("") || `<div class="notice">No leads here.</div>`}
    </div>`).join("")}</div>`;
}
function bindPipeline() {
  document.querySelectorAll("[data-move]").forEach((b) => b.onclick = async () => {
    const [id, dir] = b.dataset.move.split("|");
    const l = leadById(id); if (!l) return;
    const i = STAGES.indexOf(l.stage || "New") + Number(dir);
    if (i < 0 || i >= STAGES.length) return;
    await mutate("setStage", {leadId: id, stage: STAGES[i]});
  });
  document.querySelectorAll("[data-stagepick]").forEach((s) => s.onchange = async () => {
    await mutate("setStage", {leadId: s.dataset.stagepick, stage: s.value});
  });
}

/* ---------- CALENDAR (Cal.com mirror) ----------
   Layout rebuilt 2026-11-20 to the Cal.com booking page Rome sent:
   left event-detail panel (host, event type, duration, Google Meet,
   timezone) + right month grid with a white selected-date tile.
   Real data only: Rome's 5 verified Cal.com event types,
   America/New_York, no price (his bookings are free). The grid shows
   the CURRENT month; today is the default selected date. */
/* Event types (2026-11-21): exactly the six Rome named, in his order.
   Four are real Cal.com event types (verified live 2026-11-21 via the
   Cal.com API): 15 min (7747432), 30 min (7747431), Secret (7747430),
   Discovery (7747663). "1 hr" (8013117) and "Client Call" (8013118)
   were CREATED on Cal.com the same day via the API, mirroring the
   30-min type (video call). "Bingled — Website Strategy Call" is gone
   from this picker (the Cal.com type still exists, untouched).
   Lengths are the Cal.com API truth: Secret is 15 min and Discovery
   is 60 min on Cal.com (the old picker said 30 for both). */
const CAL_TYPES = [
  {id: "15min", name: "15 min", desc: "15 minutes · Video call", mins: 15, link: "https://cal.com/roman-royce/15min"},
  {id: "30min", name: "30 min", desc: "30 minutes · Video call", mins: 30, link: "https://cal.com/roman-royce/30min"},
  {id: "1hr", name: "1 hr", desc: "60 minutes · Video call", mins: 60, link: "https://cal.com/roman-royce/1hr"},
  {id: "discovery", name: "Discovery Call", desc: "Discovery · Video call", mins: 60, link: "https://cal.com/roman-royce/sfb-discovery-call"},
  {id: "secret", name: "Secret Meeting", desc: "Private · Video call", mins: 15, link: "https://cal.com/roman-royce/secret"},
  {id: "client-call", name: "Client Call", desc: "Closing deals, updates, check-ins · Video call", mins: 30, link: "https://cal.com/roman-royce/client-call"},
];
const SLOT_TIMES = ["9:00 AM","9:30 AM","10:00 AM","10:30 AM","11:00 AM","11:30 AM","1:00 PM","1:30 PM","2:00 PM","2:30 PM","3:00 PM","3:30 PM","4:00 PM","4:30 PM"];
const CAL_TZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix"];
function _calSameDay(a, b) { return !!(a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()); }
function _calKey(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
/* Searchable lead picker (2026-11-21): shared by the Calendar "Book for
   lead" picker and the Email compose picker. Pure helpers + one binder.
   Search matches business, city, owner, phone (digits or formatted) and
   email, case-insensitive. The list opens upward (the .calbook card has
   overflow:hidden, so a downward list would clip). Keyboard: arrows move,
   Enter selects, Escape closes and restores the selected lead. */
let _pickerOutsideBound = false;
function _leadSearchText(l) {
  return [l.business, l.city, l.owner, l.phone, String(l.phone || "").replace(/\D/g, ""), l.email || ""].join(" ").toLowerCase();
}
function _leadMatches(l, q) {
  q = String(q || "").trim().toLowerCase();
  return !q || _leadSearchText(l).includes(q);
}
function leadPickerItems(leads, q, selectedId) {
  const hits = (leads || []).filter((l) => _leadMatches(l, q));
  if (!hits.length) return `<div class="lead-picker-empty">No leads match</div>`;
  return hits.map((l) => `<button type="button" class="lead-picker-item" role="option" data-pick-lead="${l.id}" aria-selected="${l.id === selectedId}"><span><b>${esc(l.business)}</b>${l.city ? " · " + esc(l.city) : ""}</span><span class="lp-meta">${esc(l.phone || "")}${l.id === selectedId ? " ✓" : ""}</span></button>`).join("");
}
function bindLeadPicker(cfg) {
  const input = $("#" + cfg.inputId), list = $("#" + cfg.listId), clear = $("#" + cfg.clearId);
  if (!input || !list) return;
  let hl = -1;
  const show = () => {
    list.innerHTML = leadPickerItems(state.leads, cfg.getQuery(), cfg.getSelectedId());
    list.querySelectorAll(".lead-picker-item").forEach((el) => { el.onclick = () => pick(el.dataset.pickLead); });
    list.classList.remove("hidden"); input.setAttribute("aria-expanded", "true");
  };
  const hide = () => { list.classList.add("hidden"); input.setAttribute("aria-expanded", "false"); };
  const visibleItems = () => Array.prototype.slice.call(list.querySelectorAll(".lead-picker-item"));
  const setHl = (i) => {
    const items = visibleItems();
    hl = items.length ? ((i % items.length) + items.length) % items.length : -1;
    items.forEach((el, j) => el.classList.toggle("hl", j === hl));
  };
  const pick = (id) => {
    const lead = (state.leads || []).find((l) => l.id === id);
    if (!lead) return;
    cfg.setSelectedId(id); cfg.setQuery(lead.business);
    input.value = lead.business; hide();
    if (clear) clear.style.display = "block";
    if (cfg.onPick) cfg.onPick(lead);
  };
  input.addEventListener("input", () => { cfg.setQuery(input.value); hl = -1; show(); if (clear) clear.style.display = input.value ? "block" : "none"; });
  input.addEventListener("focus", () => show());
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); show(); setHl(hl + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); show(); setHl(hl - 1); }
    else if (e.key === "Enter") { e.preventDefault(); const items = visibleItems(); const el = items[hl >= 0 ? hl : 0]; if (el) pick(el.dataset.pickLead); }
    else if (e.key === "Escape") { e.preventDefault(); hide(); const sel = (state.leads || []).find((l) => l.id === cfg.getSelectedId()) || (state.leads || [])[0] || null; input.value = sel ? sel.business : ""; cfg.setQuery(input.value); if (clear) clear.style.display = input.value ? "block" : "none"; }
  });
  if (clear) clear.addEventListener("click", () => { input.value = ""; cfg.setQuery(""); cfg.setSelectedId(null); if (cfg.onPick) cfg.onPick(null); hl = -1; show(); input.focus(); });
  if (!_pickerOutsideBound) {
    _pickerOutsideBound = true;
    document.addEventListener("pointerdown", (e) => {
      document.querySelectorAll(".lead-picker-list").forEach((el) => {
        if (el.classList.contains("hidden")) return;
        let n = e.target, inside = false;
        while (n) { if (n.classList && n.classList.contains("lead-picker-wrap")) { inside = true; break; } n = n.parentNode; }
        if (!inside) el.classList.add("hidden");
      });
    });
  }
  list.innerHTML = leadPickerItems(state.leads, cfg.getQuery(), cfg.getSelectedId());
  list.querySelectorAll(".lead-picker-item").forEach((el) => { el.onclick = () => pick(el.dataset.pickLead); });
}
function renderCalendar() {
  const type = CAL_TYPES.find((t) => t.id === calEvent) || CAL_TYPES[1];
  const meetings = state.meetings || [];
  // Mine/Everyone filter (2026-11-21): "mine" = booked by the signed-in
  // user (the server stores by: username on every bookMeeting). Default
  // Everyone. Per-session only — it never changes stored data.
  const shownMeetings = calFilter === "mine" ? meetings.filter((m) => m.by === me) : meetings;
  const bookedDays = new Set(shownMeetings.map((m) => { const d = parseStoredDate(m.date, null); return d ? _calKey(d) : ""; }).filter(Boolean));
  const {y, m} = calMonth;
  const first = new Date(y, m, 1);
  const startOffset = first.getDay(); // Sunday = 0
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrev = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push({d: new Date(y, m - 1, daysInPrev - startOffset + 1 + i), outside: true});
  for (let d = 1; d <= daysInMonth; d++) cells.push({d: new Date(y, m, d), outside: false});
  while (cells.length % 7 !== 0) { const last = cells[cells.length - 1].d; cells.push({d: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), outside: true}); }
  const atCurrentMonth = y === _calToday.getFullYear() && m === _calToday.getMonth();
  const monthLabel = first.toLocaleDateString("en-US", {month: "long"});
  const yearLabel = String(y);
  const selLabel = calDate ? calDate.toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric"}) : "Pick a day";
  const selLead = (state.leads || []).find((l) => l.id === calLeadId) || (state.leads || [])[0] || null;
  const leadInputValue = calLeadQuery || (selLead ? selLead.business : "");
  return `
  <div class="calbook">
    <div class="calbook-side">
      <div class="calbook-host"><span class="calbook-avatar">RR</span><b>Roman Royce</b></div>
      <div class="section-title" style="margin-top:0">Event types</div>
      ${CAL_TYPES.map((t) => `<div class="event-type ${type.id === t.id ? "sel" : ""}" data-caltype="${t.id}">
        <b>${esc(t.name)}</b><span>${esc(t.desc)}</span></div>`).join("")}
      <h2 class="calbook-title">${esc(type.name)}</h2>
      <p class="calbook-desc">${esc(type.desc)}</p>
      <div class="calbook-meta">
        <div class="calbook-meta-row"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>${type.mins} minutes</span></div>
        <div class="calbook-meta-row"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10l7-3v10l-7-3"/></svg><span>Google Meet</span></div>
        <div class="calbook-meta-row"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z"/></svg><select class="calbook-tz" id="cal-tz" aria-label="Timezone">${CAL_TZONES.map((z) => `<option value="${z}" ${z === calTz ? "selected" : ""}>${z}</option>`).join("")}</select></div>
      </div>
      <div class="card" style="margin-top:18px">
        <div class="section-title" style="margin-top:0">Booked meetings</div>
        <div class="seg-toggle" role="group" aria-label="Calendar filter" style="margin-bottom:10px">
          <button type="button" data-calfilter="mine" aria-pressed="${calFilter === "mine"}">My calendar</button>
          <button type="button" data-calfilter="all" aria-pressed="${calFilter === "all"}">Everyone</button>
        </div>
        ${shownMeetings.length ? shownMeetings.map((m) => {
          const l = leadById(m.leadId);
          // Deleted lead: show the name stored on the meeting itself.
          return `<div class="kv"><span>${esc(m.leadName || (l ? l.business : "Meeting"))}<br><span style="color:var(--muted);font-size:12px">${esc(m.date)} · ${esc(m.time)} · ${esc(m.typeName || "")}</span></span><span class="badge green">Booked</span></div>`;
        }).join("") : `<div class="notice">${meetings.length ? "Nothing on your calendar in this view." : "No meetings booked yet."}</div>`}
        ${calFilter === "mine" && meetings.length ? `<p class="notice">Showing ${shownMeetings.length} of ${meetings.length} booked meetings.</p>` : ""}
      </div>
    </div>
    <div class="calbook-main">
      <div class="calbook-monthhead">
        <h3>${esc(monthLabel)} <span>${esc(yearLabel)}</span></h3>
        <div class="calbook-nav">
          <button type="button" data-calmonth="prev" ${atCurrentMonth ? "disabled" : ""} aria-label="Previous month">‹</button>
          <button type="button" data-calmonth="next" aria-label="Next month">›</button>
        </div>
      </div>
      <div class="calbook-body">
        <div style="flex:1;min-width:0">
          <div class="calbook-weekdays">${["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((d) => `<span>${d}</span>`).join("")}</div>
          <div class="calbook-grid${calDate ? " calbook-grid--has-sel" : ""}">${cells.map(({d, outside}) => {
            const past = d < _calToday;
            const sel = _calSameDay(d, calDate);
            const isToday = _calSameDay(d, _calToday);
            const booked = bookedDays.has(_calKey(d));
            const nextLabel = outside && d.getDate() === 1 ? `<span class="calday-nextlabel">${esc(d.toLocaleDateString("en-US", {month: "short"}).toUpperCase())}</span>` : "";
            return `<button type="button" class="calday ${sel ? "calday--sel" : ""} ${isToday ? "calday--today" : ""} ${outside ? "calday--outside" : ""} ${booked ? "calday--booked" : ""}" data-caldate="${_calKey(d)}" ${outside || past ? "disabled" : ""}>${nextLabel}<span class="calday-num">${d.getDate()}</span><span class="calday-dot"></span></button>`;
          }).join("")}</div>
        </div>
        <div class="calbook-times">
          <div class="calbook-slots-head">${esc(selLabel)}</div>
          <div class="slots">${SLOT_TIMES.map((t) => `<button type="button" class="slot ${calTime === t ? "sel" : ""}" data-caltime="${t}">${t}</button>`).join("")}</div>
        </div>
      </div>
      <div class="grid2">
        <div class="field"><label>Book for lead</label>
          <div class="lead-picker-wrap">
            <input class="input" id="cal-lead-input" type="text" placeholder="Search leads…" value="${esc(leadInputValue)}" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="cal-lead-list">
            <button type="button" class="lead-picker-clear" id="cal-lead-clear" aria-label="Clear lead search" style="display:${calLeadQuery ? "block" : "none"}">×</button>
            <div class="lead-picker-list hidden" id="cal-lead-list" role="listbox"></div>
          </div>
          <div class="notice" id="cal-lead-selected">${selLead ? "Booking for: <b>" + esc(selLead.business) + "</b>" : "No lead selected"}</div>
        </div>
        <div class="field"><label>Your name</label><input class="input" id="cal-name" type="text" value="Roman Royce"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn--primary" id="cal-confirm">Confirm booking</button>
        <button class="btn" id="cal-open">Book on Cal.com ↗</button>
      </div>
      <p class="notice">Times are shown in ${esc(calTz)} (${esc(CAL_TZ_LABELS[calTz] || "")}). Confirm saves the meeting here and in the call log. The live Cal.com booking itself happens on cal.com — this app does not hold a Cal.com API key.</p>
      <div class="calbook-foot">Cal.com</div>
    </div>
  </div>`;
}

function bindCalendar() {
  document.querySelectorAll("[data-caltype]").forEach((el) => el.onclick = () => { calEvent = el.dataset.caltype; render(); });
  document.querySelectorAll("[data-caldate]").forEach((el) => el.onclick = () => {
    const [yy, mm, dd] = el.dataset.caldate.split("-").map(Number);
    calDate = new Date(yy, mm - 1, dd); render();
  });
  document.querySelectorAll("[data-calmonth]").forEach((el) => el.onclick = () => {
    const dir = el.dataset.calmonth === "next" ? 1 : -1;
    const nd = new Date(calMonth.y, calMonth.m + dir, 1);
    calMonth = {y: nd.getFullYear(), m: nd.getMonth()}; render();
  });
  document.querySelectorAll("[data-caltime]").forEach((el) => el.onclick = () => { calTime = el.dataset.caltime; render(); });
  const tz = $("#cal-tz");
  if (tz) tz.onchange = () => { calTz = tz.value; render(); };
  const open = $("#cal-open");
  if (open) open.onclick = () => { const t = CAL_TYPES.find((x) => x.id === calEvent) || CAL_TYPES[1]; window.open(t.link, "_blank"); };
  const confirm = $("#cal-confirm");
  if (confirm) confirm.onclick = async () => {
    if (!calDate || !calTime) { showToast("Pick a day and a time first."); return; }
    const type = CAL_TYPES.find((t) => t.id === (calEvent || "30min")) || CAL_TYPES[1];
    const date = calDate.toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric"});
    const leadId = calLeadId || (state.leads[0] || {}).id;
    await mutate("bookMeeting", {leadId, date, time: calTime, typeName: type.name});
    showToast("Meeting booked: " + date + " at " + calTime + " (" + type.name + "). Email is queued (Resend pending) — confirm on Cal.com if you want the live invite sent.");
  };
  document.querySelectorAll("[data-calfilter]").forEach((el) => el.onclick = () => { calFilter = el.dataset.calfilter; render(); });
  bindLeadPicker({
    inputId: "cal-lead-input", listId: "cal-lead-list", clearId: "cal-lead-clear",
    getQuery: () => calLeadQuery, setQuery: (v) => { calLeadQuery = v; },
    getSelectedId: () => calLeadId, setSelectedId: (v) => { calLeadId = v; },
    onPick: (lead) => { const lab = $("#cal-lead-selected"); if (lab) lab.innerHTML = lead ? "Booking for: <b>" + esc(lead.business) + "</b>" : "No lead selected"; },
  });
}

/* ---------- CALL LOG + CONVERSATIONS ----------
   Rendered inside a CSS mock iPhone 18 (2026-11-20): the phone is a
   FRAME around the existing working UI, not a picture of one. Same
   functions as before — tap a conversation to open its thread, back
   returns to the list, typing + Send saves to that lead's thread.
   ONE unified list (2026-11-20): Messages and Recents are merged — each
   lead appears once, showing its latest activity (latest message text,
   or latest call type + outcome), sorted most recent first, with an iOS
   search bar on top that filters live by name / phone / message / call.
   All data is real: calls/messages come from state, nothing invented. */
function iphoneChrome(inner, opts) {
  const compact = !!(opts && opts.compact);
  const label = (opts && opts.label) || "iPhone showing the Call Log";
  return `
  <div class="iphone-wrap">
    <div class="iphone${compact ? " iphone--compact" : ""}" role="img" aria-label="${label}">
      <span class="iphone-side iphone-side-l1"></span>
      <span class="iphone-side iphone-side-l2"></span>
      <span class="iphone-side iphone-side-r"></span>
      <div class="iphone-screen">
        <div class="iphone-island"></div>
        <div class="iphone-status"><span>9:41</span><span class="iphone-status-icons"><svg width="17" height="11" viewBox="0 0 17 11" fill="#fff"><rect x="0" y="7" width="3" height="4" rx="1"/><rect x="4.5" y="5" width="3" height="6" rx="1"/><rect x="9" y="2.5" width="3" height="8.5" rx="1"/><rect x="13.5" y="0" width="3" height="11" rx="1"/></svg><svg width="16" height="11" viewBox="0 0 16 12" fill="#fff"><path d="M8 10.8a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8zM8 6.2c1.2 0 2.3.5 3.1 1.3l-1.5 1.5A2.4 2.4 0 0 0 8 8.4c-.7 0-1.3.2-1.7.6L4.9 7.5A4.6 4.6 0 0 1 8 6.2zM8 2c2.4 0 4.6 1 6.2 2.5L12.7 6A6.4 6.4 0 0 0 8 4.2c-1.7 0-3.3.7-4.5 1.8L2 4.5A8.6 8.6 0 0 1 8 2z"/></svg><svg width="25" height="12" viewBox="0 0 25 12" fill="none"><rect x="0.5" y="0.5" width="21" height="11" rx="3.5" stroke="#fff" opacity="0.4"/><rect x="2" y="2" width="16" height="8" rx="2" fill="#fff"/><path d="M23.5 4v4a2 2 0 0 0 0-4z" fill="#fff" opacity="0.4"/></svg></span></div>
        ${inner}
        <div class="iphone-home"></div>
      </div>
    </div>
  </div>`;
}
/* Latest activity for one lead, for the unified Call Log list: whichever
   is newer, the latest message or the latest call. Stored timestamps are
   "Nov 20, 2026" + "2:30 PM" strings — parsed for comparison only. */
function latestActivityFor(leadId) {
  const calls = callsFor(leadId);
  const conv = convFor(leadId);
  const msgs = (conv && conv.messages) || [];
  const lastCall = calls[calls.length - 1] || null;
  const lastMsg = msgs[msgs.length - 1] || null;
  const stamp = (d, t) => { const v = Date.parse((d || "") + " " + (t || "")); return isNaN(v) ? 0 : v; };
  const callStamp = lastCall ? stamp(lastCall.date, lastCall.time) : 0;
  const msgStamp = lastMsg ? stamp(lastMsg.date, lastMsg.time) : 0;
  if (lastMsg && msgStamp >= callStamp) return {kind: "msg", msg: lastMsg, at: msgStamp};
  if (lastCall) return {kind: "call", call: lastCall, at: callStamp};
  return null;
}
/* ---------- iPad frame — Call Log (2026-11-21) ----------
   The Call Log tab renders inside a CSS mock iPad: wider proportions,
   small camera dot in the top bezel, no Dynamic Island, slim status bar.
   Inside it runs Messages in the real iPad layout: conversation list on
   the LEFT, open thread on the RIGHT, side by side in the same frame. */
function ipadChrome(inner) {
  return `
  <div class="ipad-wrap">
    <div class="ipad" role="img" aria-label="iPad showing the Call Log">
      <div class="ipad-cam"></div>
      <div class="ipad-screen">
        <div class="ipad-status"><span>9:41</span><span class="iphone-status-icons"><svg width="17" height="11" viewBox="0 0 17 11" fill="#fff"><rect x="0" y="7" width="3" height="4" rx="1"/><rect x="4.5" y="5" width="3" height="6" rx="1"/><rect x="9" y="2.5" width="3" height="8.5" rx="1"/><rect x="13.5" y="0" width="3" height="11" rx="1"/></svg><svg width="16" height="11" viewBox="0 0 16 12" fill="#fff"><path d="M8 10.8a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8zM8 6.2c1.2 0 2.3.5 3.1 1.3l-1.5 1.5A2.4 2.4 0 0 0 8 8.4c-.7 0-1.3.2-1.7.6L4.9 7.5A4.6 4.6 0 0 1 8 6.2zM8 2c2.4 0 4.6 1 6.2 2.5L12.7 6A6.4 6.4 0 0 0 8 4.2c-1.7 0-3.3.7-4.5 1.8L2 4.5A8.6 8.6 0 0 1 8 2z"/></svg><svg width="25" height="12" viewBox="0 0 25 12" fill="none"><rect x="0.5" y="0.5" width="21" height="11" rx="3.5" stroke="#fff" opacity="0.4"/><rect x="2" y="2" width="16" height="8" rx="2" fill="#fff"/><path d="M23.5 4v4a2 2 0 0 0 0-4z" fill="#fff" opacity="0.4"/></svg></span></div>
        ${inner}
        <div class="ipad-home"></div>
      </div>
    </div>
  </div>`;
}
function renderCallLog() {
  const leads = state.leads || [];
  const searchBar = `
    <div class="iphone-search">
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><circle cx="6.5" cy="6.5" r="5" stroke="#8e8e93" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="#8e8e93" stroke-width="1.6" stroke-linecap="round"/></svg>
      <input id="phone-search" type="text" placeholder="Search" value="${esc(phoneSearch)}" autocomplete="off" aria-label="Search conversations">
      <button type="button" class="iphone-search-clear" id="phone-search-clear" aria-label="Clear search" style="display:${phoneSearch ? "flex" : "none"}">×</button>
    </div>`;
  // Deleted leads still appear (delete safeguard, 2026-11-21): their
  // call history was NOT deleted, so the list shows them under the name
  // stored on their history, with no "New" dot and no phone line.
  const orphanIds = [...new Set([
    ...(state.callLogs || []).map((c) => c.leadId),
    ...(state.conversations || []).map((c) => c.leadId),
  ])].filter((id) => !leads.some((l) => l.id === id));
  const orphanLeads = orphanIds.map((id) => ({id, business: leadNameFor(id), phone: "", stage: "Deleted"}));
  const rows = [...leads, ...orphanLeads].map((l) => ({lead: l, act: latestActivityFor(l.id)}))
    .sort((a, b) => (b.act ? b.act.at : 0) - (a.act ? a.act.at : 0));
  const isTeam = !activeConv || activeConv === "__team__";
  const list = `
      <div class="ipad-list-body"><div class="conv-list">
      <button class="conv-item team-pin${isTeam ? " sel" : ""}" data-openconv="__team__">
        <span class="im-avatar">SFB</span>
        <span class="im-conv-main"><span class="pin-label">Pinned</span><b>SFB SALES TEAM</b><span class="im-preview">Group chat — Roman, Logan, Braylen</span></span>
        <span class="im-conv-right"></span></button>
      ${rows.map(({lead: l, act}) => {
        const missed = act && act.kind === "call" && isMissedCall(act.call);
        const preview = !act ? "No calls or messages yet"
          : act.kind === "msg" ? act.msg.text.slice(0, 60)
          : (missed ? "↙ Missed call" : "↗ Outgoing call") + " · " + callLabel(act.call.outcome);
        const at = act ? whenShort(act.kind === "msg" ? act.msg.date : act.call.date, act.kind === "msg" ? act.msg.time : act.call.time) : "";
        const hay = [l.business, l.phone,
          ...callsFor(l.id).map((c) => callLabel(c.outcome) + " " + (isMissedCall(c) ? "missed call" : "outgoing call")),
          ...((convFor(l.id) || {messages: []}).messages || []).map((m) => m.text)].join(" ").toLowerCase();
        return `<button class="conv-item${activeConv === l.id ? " sel" : ""}" data-openconv="${l.id}" data-search="${esc(hay)}">
          <span class="im-avatar">${esc(initialsFor(l.business))}</span>
          <span class="im-conv-main"><b>${esc(l.business)}</b><span class="im-preview${missed ? " missed" : ""}">${esc(preview)}</span></span>
          <span class="im-conv-right">${at ? `<span class="im-time">${esc(at)}</span>` : ""}${(l.stage || "New") === "New" ? `<span class="im-unread" title="New lead"></span>` : ""}</span></button>`;
      }).join("")}</div></div>
      <div class="notice iphone-empty ipad-noresults" style="display:none">No results. Try a different search.</div>`;
  let thread;
  if (isTeam) {
    // Pinned team group chat (2026-11-21): ONE shared thread in
    // state.teamChat, readable/writable by all three team accounts.
    // Starts EMPTY — never seeded. Mine blue right, others grey with
    // the sender's name above.
    const msgs = ((state.teamChat && state.teamChat.messages) || []);
    thread = `
      <div class="iphone-thread-head">
        <span class="im-avatar iphone-head-avatar">SFB</span>
        <span class="iphone-head-name"><b>SFB SALES TEAM</b><span>Group chat — Roman, Logan, Braylen</span></span>
      </div>
      <div class="iphone-body"><div class="chat-thread iphone-thread">
        ${msgs.length ? msgs.map((m) => {
          const mine = m.by === me;
          const who = DISPLAY_NAMES[m.by] || m.by;
          return `${(m.date || m.time) ? `<div class="im-stamp">${esc(m.date || "")}${m.date && m.time ? " · " : ""}${esc(m.time || "")}</div>` : ""}${mine ? "" : `<div class="im-stamp" style="text-align:left;margin-left:4px">${esc(who)}</div>`}<div class="msg ${mine ? "out" : "in"}">${esc(m.text)}</div>`;
        }).join("") : `<div class="notice iphone-empty">No messages yet — say hi to the team</div>`}
      </div></div>`;
  } else {
    const lead = leadById(activeConv);
    const conv = convFor(activeConv) || {messages: []};
    const calls = callsFor(activeConv);
    // Deleted lead: the thread stays readable under the name stored on
    // its history (delete safeguard, 2026-11-21) — never blank.
    const displayName = lead ? lead.business : leadNameFor(activeConv);
    thread = `
      <div class="iphone-thread-head">
        <span class="im-avatar iphone-head-avatar">${esc(initialsFor(displayName))}</span>
        <span class="iphone-head-name"><b>${esc(displayName)}</b><span>${esc(lead ? lead.phone : "")} · ${calls.length} call${calls.length === 1 ? "" : "s"} logged</span></span>
      </div>
      <div class="iphone-body"><div class="chat-thread iphone-thread">
        ${calls.map((c) => `<div class="im-sys">Call — ${esc(callLabel(c.outcome))} · ${esc(c.date)} · ${esc(c.time)}</div>`).join("")}
        ${(conv.messages || []).map((m) => {
          const st = smsStatusLabel(m);
          return `${(m.date || m.time) ? `<div class="im-stamp">${esc(m.date || "")}${m.date && m.time ? " · " : ""}${esc(m.time || "")}</div>` : ""}<div class="msg ${m.from === "me" ? "out" : "in"}">${esc(m.text)}</div>${st ? `<div class="im-stamp" style="text-align:${m.from === "me" ? "right" : "left"}">${esc(st)}${m.sentBy ? " · " + esc(DISPLAY_NAMES[m.sentBy] || m.sentBy) : ""}</div>` : ""}`;
        }).join("") || ""}
        ${!calls.length && !(conv.messages || []).length ? `<div class="notice iphone-empty">No calls or messages yet for this lead.</div>` : ""}
      </div></div>`;
  }
  return ipadChrome(`
      <div class="ipad-body">
        <div class="ipad-list">
          <div class="iphone-title">Messages</div>
          ${searchBar}
          ${list}
        </div>
        <div class="ipad-thread">
          ${thread}
          <div class="chat-input iphone-input">
            <input class="input" id="chat-input" type="text" placeholder="iMessage">
            <button class="chat-send" id="chat-send" type="button" aria-label="Send">↑</button>
          </div>
          <p class="notice iphone-note">${isTeam ? "Messages here go to the whole team — Roman, Logan, and Braylen." : "Messages you type here are texted to the lead from +1 239 349 9491 — delivery is confirmed only when the carrier reports it."}</p>
        </div>
      </div>`);
}

function bindCallLog() {
  document.querySelectorAll("[data-openconv]").forEach((el) => el.onclick = () => { activeConv = el.dataset.openconv; render(); });
  // iOS search: filters the unified list LIVE without a re-render, so the
  // input keeps focus while typing. Matches lead name / phone / message
  // text / call outcome (each row carries them in data-search). The pinned
  // team row is never hidden by the search. The query survives re-renders
  // (thread open/close) via phoneSearch.
  const search = $("#phone-search");
  const applySearch = () => {
    const q = (search ? search.value : phoneSearch).trim().toLowerCase();
    phoneSearch = search ? search.value : "";
    let shown = 0;
    document.querySelectorAll(".ipad-list-body .conv-item").forEach((el) => {
      if (el.classList.contains("team-pin")) return; // pinned row always stays
      const hit = !q || (el.dataset.search || "").includes(q);
      el.style.display = hit ? "" : "none";
      if (hit) shown++;
    });
    const empty = $(".ipad-noresults");
    if (empty) empty.style.display = shown ? "none" : "";
    const clear = $("#phone-search-clear");
    if (clear) clear.style.display = phoneSearch ? "flex" : "none";
  };
  if (search) {
    search.addEventListener("input", applySearch);
    if (phoneSearch) applySearch();
  }
  const clear = $("#phone-search-clear");
  if (clear) clear.onclick = () => { if (search) search.value = ""; phoneSearch = ""; applySearch(); if (search) search.focus(); };
  const send = $("#chat-send");
  const sendMsg = async () => {
    const inp = $("#chat-input");
    const text = inp.value.trim();
    if (!text) return;
    if (!activeConv || activeConv === "__team__") await mutate("sendTeamMessage", {text});
    else {
      // Lead thread: a real in-app text (2026-11-21). The old path only
      // saved the text to the thread — it never sent anything. Now the
      // server sends it and stores the honest delivery status; a failed
      // send shows in the thread as not delivered.
      try {
        await sendSmsInApp(activeConv, text);
        inp.value = "";
        await loadState(); await loadCaps();
        render();
      } catch (e) {
        try { await loadState(); } catch (_) {}
        render();
        showToast(e.message || "Text failed — try again.");
      }
    }
  };
  if (send) send.onclick = sendMsg;
  const inp = $("#chat-input");
  if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMsg(); });
}

/* ---------- AI REP (AI receptionist) ----------
   SEE: live status + recent inbound calls from the sfb-receptionist
   worker, via the session-checked /api/airep/* proxy in the router —
   the receptionist WORKER_KEY never reaches the browser.
   CUSTOMIZE: owner-only saves. The greeting, business name, booking
   link + toggle, message-taking toggle, offers and description are
   stored in the receptionist KV (config:live) and the NEXT inbound call
   reads them fresh — a save takes effect immediately, no redeploy.
   The owner's notify number is NOT editable here (worker env var). */
let aiRepStatus = null, aiRepCalls = [], aiRepConfig = null;
let aiRepLoaded = false, aiRepLoading = false, aiRepError = "", aiRepNote = "";
let aiRepExpanded = {};
async function loadAiRep() {
  if (aiRepLoading) return;
  aiRepLoading = true; aiRepError = "";
  try {
    const [st, calls, cfg] = await Promise.all([
      api("/airep/status", "GET"),
      api("/airep/calls", "GET"),
      api("/airep/config", "GET"),
    ]);
    aiRepStatus = st; aiRepCalls = calls.calls || []; aiRepConfig = cfg.config || {};
    aiRepLoaded = true;
  } catch (e) {
    aiRepError = e.message || "Could not load the AI receptionist.";
  }
  aiRepLoading = false;
  if (currentTab === "airep") render();
}
function aiRepOutcome(c) {
  const map = {
    "booked-link-sent": ["Booked", "green"], booking: ["Booking", "green"],
    "message-taken": ["Message", ""], message: ["Message", ""], question: ["Question", ""],
    silent: ["Missed", "amber"], "no-relay-session": ["Missed", "amber"],
    other: ["Other", ""],
  };
  return map[c.outcome] || [(c.outcome || "Other"), ""];
}
function aiRepWhen(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", {month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York"});
  } catch (_) { return iso || ""; }
}
// Honest booking-link / SMS status (2026-11-21, receptionist v1.5.0): the
// worker reports bookingLinkSms / sms as {status, error?} with status
// delivered | sent-unconfirmed | failed | undelivered | not-sent (plus the
// older sent / pending / not_sent / skipped). bookingLinkSent is true only
// when delivered on NEW records — but an OLD record with only
// bookingLinkSent:true and no status field cannot prove delivery, so it
// renders as "sent — delivery not confirmed", never "delivered".
function aiRepLinkStatus(c) {
  const s = (c && c.bookingLinkSms) || null;
  const st = s && typeof s.status === "string" ? s.status : null;
  const err = s && s.error ? String(s.error) : "";
  if (st === "delivered") return "Booking link delivered";
  if (st === "failed") return "Booking link not delivered" + (err ? " (" + err + ")" : "");
  if (st === "sent-unconfirmed" || st === "sent" || st === "pending") return "Booking link sent — delivery not confirmed";
  if (st === "undelivered" || st === "not-sent" || st === "not_sent" || st === "skipped") return err ? "Booking link not sent (" + err + ")" : "";
  if (c && c.bookingLinkSent) return "Booking link sent — delivery not confirmed";
  return "";
}
function aiRepSmsStatus(sms) {
  if (!sms) return "";
  const st = typeof sms.status === "string" ? sms.status : null;
  const err = sms.error ? String(sms.error) : "";
  if (st === "delivered") return "delivered";
  if (st === "failed" || st === "undelivered") return "not sent" + (err ? " (" + err + ")" : "");
  if (st === "sent-unconfirmed" || st === "sent" || st === "pending") return "sent — delivery not confirmed";
  if (st === "not-sent" || st === "not_sent" || st === "skipped") return "not sent" + (err ? " (" + err + ")" : "");
  if (sms.ok === true) return "sent — delivery not confirmed";
  if (sms.ok === false) return "not sent" + (err ? " (" + err + ")" : "");
  return "not sent";
}
function renderAiRep() {
  if (!aiRepLoaded) {
    return `<div class="card">${aiRepError
      ? `<div class="error">${esc(aiRepError)}</div><p class="notice">The receptionist worker did not answer. Check the Connections tab — if Twilio is live, try the refresh button below.</p>`
      : `<div class="notice">Loading the AI receptionist…</div>`}
      <button class="btn" id="airep-refresh">Refresh</button></div>`;
  }
  const st = aiRepStatus || {};
  const cfg = aiRepConfig || {};
  const isOwner = roleFor(me) === "owner";
  const dis = isOwner ? "" : "disabled";
  const calls = aiRepCalls || [];
  return `
  <div class="card">
    <div class="kv"><span><b>AI Receptionist</b><br><span style="color:var(--muted);font-size:13px">Answers ${esc(st.number || "+1 239 349 9491")} 24/7 as ${esc(st.businessName || cfg.businessName || "Six Figure Blueprints")}</span></span>
    <span class="badge ${st.live ? "green" : "amber"}">${st.live ? "Live" : "Not connected"}</span></div>
    <div class="kv"><span>Engine</span><span>${esc(st.engine || "ConversationRelay + Workers AI")}</span></div>
    <div class="kv"><span>Cost</span><span>≈ $0.0785 / min — a 3-min call ≈ $0.24</span></div>
    <div class="stat-boxes" style="margin-top:12px">
      <div class="stat-box"><div class="num">${st.callsToday || 0}</div><div class="lbl">Calls today</div></div>
      <div class="stat-box"><div class="num">${st.callsTotal || 0}</div><div class="lbl">Total calls</div></div>
    </div>
    <button class="btn" id="airep-refresh" style="margin-top:12px">Refresh calls</button>
    <a class="btn" href="https://sfb-receptionist.2romanroyce8.workers.dev/demo" target="_blank" rel="noopener" style="margin-top:12px">Hear the demo</a>
  </div>
  <div class="section-title">Recent calls</div>
  ${calls.length ? calls.map((c) => {
    const [label, cls] = aiRepOutcome(c);
    const linkNote = aiRepLinkStatus(c);
    const open = !!aiRepExpanded[c.callSid || c.id];
    const turns = c.turns || [];
    return `<div class="card" style="margin-bottom:12px">
      <div class="kv"><span><b>${esc(c.from || "Unknown caller")}</b><br><span style="color:var(--muted);font-size:13px">${esc(aiRepWhen(c.startedAt))}${c.durationSec ? " · " + fmtElapsed(c.durationSec) : ""}${linkNote ? " · " + esc(linkNote) : ""}</span></span>
      <span class="badge ${cls}">${esc(label)}</span></div>
      <p class="lead-line">${esc(c.summary || "No summary yet.")}</p>
      <button class="btn" data-airep-expand="${esc(c.callSid || c.id)}">${open ? "Hide transcript" : "Show transcript"}</button>
      ${open ? `<div style="margin-top:10px">${turns.length ? turns.map((t) => `<div class="lead-line"><b>${t.role === "user" ? "Caller" : "Receptionist"}:</b> ${esc(t.text)}</div>`).join("") : `<div class="notice">No transcript — the caller hung up before speaking.</div>`}
      ${c.sms ? `<p class="notice">Owner summary SMS: ${esc(aiRepSmsStatus(c.sms))}</p>` : ""}</div>` : ""}
    </div>`;
  }).join("") : `<div class="card"><div class="notice">No inbound calls yet. Call ${esc(st.number || "+1 239 349 9491")} from a phone to test it — the call will show up here.</div></div>`}
  <div class="section-title">Customize — what callers hear</div>
  <div class="card">
    ${isOwner ? "" : `<p class="notice">Only the owner can change the receptionist — you're signed in as staff. You can see calls and settings, but saving is owner-only.</p>`}
    <div class="field"><label>Greeting — the first thing every caller hears</label>
      <textarea class="input" id="airep-greeting" rows="4" ${dis}>${esc(cfg.greeting || "")}</textarea></div>
    <div class="grid2">
      <div class="field"><label>Business name</label><input class="input" id="airep-business" type="text" value="${esc(cfg.businessName || "")}" ${dis}></div>
      <div class="field"><label>Short name (used in the summary text to you)</label><input class="input" id="airep-short" type="text" value="${esc(cfg.shortName || "")}" ${dis}></div>
    </div>
    <div class="field"><label>What the receptionist offers callers</label>
      <textarea class="input" id="airep-offers" rows="2" ${dis}>${esc(cfg.offers || "")}</textarea></div>
    <div class="field"><label>About the business — only verified facts; this is all it may say about the company</label>
      <textarea class="input" id="airep-desc" rows="3" ${dis}>${esc(cfg.description || "")}</textarea></div>
    <div class="grid2">
      <div class="field"><label>Booking link (Cal.com)</label><input class="input" id="airep-booking-link" type="url" value="${esc(cfg.bookingLink || "")}" ${dis}></div>
      <div class="field"><label>Booking label — what the call is called</label><input class="input" id="airep-booking-label" type="text" value="${esc(cfg.bookingLabel || "")}" ${dis}></div>
    </div>
    <div class="dispo-row" style="margin-bottom:12px">
      <label class="btn" style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="airep-booking-on" ${cfg.bookingEnabled ? "checked" : ""} ${dis}> Offer booking</label>
      <label class="btn" style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="airep-message-on" ${cfg.messageTakingEnabled ? "checked" : ""} ${dis}> Take messages</label>
    </div>
    <p class="notice">Press 1 books a call and press 2 leaves a message — the greeting above says so. If you turn booking or messages off, update the greeting to match, or callers will be offered something that is off.</p>
    ${isOwner ? `<button class="btn btn--primary" id="airep-save">Save — live for the next call</button>` : ""}
    <div id="airep-save-note" class="${aiRepNote ? (aiRepNote.indexOf("Saved") === 0 ? "ok-note" : "error") : "hidden"}" style="margin-top:10px">${esc(aiRepNote)}</div>
    <p class="notice">The owner's notify number for the after-call summary text can't be changed from here — it stays as set on the worker.</p>
  </div>`;
}
function bindAiRep() {
  const refresh = $("#airep-refresh");
  if (refresh) refresh.onclick = () => { aiRepLoading = false; loadAiRep(); };
  document.querySelectorAll("[data-airep-expand]").forEach((b) => b.onclick = () => {
    const id = b.dataset.airepExpand;
    aiRepExpanded[id] = !aiRepExpanded[id];
    render();
  });
  const save = $("#airep-save");
  if (save) save.onclick = async () => {
    const greeting = $("#airep-greeting").value.trim();
    const bookingLink = $("#airep-booking-link").value.trim();
    const bookingEnabled = $("#airep-booking-on").checked;
    const note = $("#airep-save-note");
    const fail = (m) => { if (note) { note.textContent = m; note.className = "error"; } };
    if (greeting.length < 10) { fail("Greeting is too short — write what callers should hear first."); return; }
    if (bookingLink && !/^https:\/\//.test(bookingLink)) { fail("Booking link must be a full https:// link."); return; }
    if (bookingEnabled && !bookingLink) { fail("Booking is turned on but there is no booking link — add a link or turn booking off."); return; }
    save.disabled = true; save.textContent = "Saving…";
    try {
      const r = await api("/airep/config", "POST", {
        greeting,
        businessName: $("#airep-business").value.trim(),
        shortName: $("#airep-short").value.trim(),
        offers: $("#airep-offers").value.trim(),
        description: $("#airep-desc").value.trim(),
        bookingLink,
        bookingLabel: $("#airep-booking-label").value.trim(),
        bookingEnabled,
        messageTakingEnabled: $("#airep-message-on").checked,
      });
      aiRepConfig = r.config || {};
      aiRepNote = "Saved — live for the next call.";
      render();
    } catch (e) {
      save.disabled = false; save.textContent = "Save — live for the next call";
      fail("Save failed — " + (e.message || "the receptionist did not answer."));
    }
  };
}

/* ---------- ANALYTICS ----------
   Real numbers only — every figure is computed from the stored dialer
   state (leads, callLogs) and the receptionist call log (via the AI Rep
   proxy). Nothing is invented, nothing is seeded.
   Talk minutes are NOT recorded by the dialer, so outbound talk cost
   cannot be totalled — it says so instead of guessing. */
const ANALYTICS_RANGES = [["today", "Today"], ["7d", "Last 7 days"], ["all", "All time"]];
const OUTBOUND_COST_PER_MIN = 0.018; // Twilio outbound $0.014 + browser leg $0.004 — estimate only
const RECEP_COST_PER_MIN = 0.0785;   // ConversationRelay $0.07 + inbound voice $0.0085 — estimate only
const BALANCE_NOTE = "Twilio balance last confirmed $20.00 on Nov 20, 2026 — this is not a live balance.";
// Outcomes that mean a human picked up (a conversation happened). A manual
// disposition under "Conversation" (not interested / callback / receptionist
// / VSL) implies the same — the person answered. "meeting_booked" is the
// booking event for a call that connected.
const CONNECTED_OUTCOMES = ["connected", "not_interested", "callback", "receptionist", "send_vsl", "meeting_booked"];
const ANALYTICS_REPS = [
  {username: "romanroyce", name: "Roman Royce"},
  {username: "loganwells", name: "Logan Wells"},
  {username: "braylengarrett", name: "Braylen Garrett"},
];
let analyticsRange = "7d";
let analyticsScope = "company"; // "company" | "me" | username — per-session, default Company
let analyticsRepCalls = [], analyticsRepError = "", analyticsError = "";
let analyticsLoading = false, analyticsLoaded = false;

// Parse a stored date string ("Nov 20, 2026" from the server, or the
// calendar's year-less "Friday, November 20") + optional "2:30 PM" time.
// Date.parse guesses the WRONG year (2001) for year-less dates, so those
// are parsed by hand with the current year. Returns a Date or null.
function parseStoredDate(dateStr, timeStr) {
  const s = String(dateStr || "").trim();
  if (!s) return null;
  const v = Date.parse(s + (timeStr ? " " + String(timeStr) : ""));
  if (!isNaN(v)) {
    const d = new Date(v);
    if (d.getFullYear() >= 2026) return d; // the dialer started Nov 2026
  }
  const m = s.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})/i);
  if (m) {
    const months = {january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11};
    const d = new Date(new Date().getFullYear(), months[m[1].toLowerCase()], Number(m[2]));
    const tm = String(timeStr || "").match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (tm) { let h = Number(tm[1]) % 12; if (/pm/i.test(tm[3])) h += 12; d.setHours(h, Number(tm[2]), 0, 0); }
    return d;
  }
  return null;
}
function dayKeyOf(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function dayLabelOf(d) { return d.toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric"}); }

// Pure: every Analytics number from stored state + receptionist calls.
// range: "today" | "7d" | "all". nowMs lets tests pin "today".
// Meetings are counted from the meeting_booked call-log entries (the
// booking event, server-dated) — the calendar's scheduled dates have no
// year, so they cannot be ranged reliably. Entries with unparseable
// dates are excluded (the server always writes "Nov 20, 2026", so this
// should not happen in practice).
function computeAnalytics(st, repCalls, range, nowMs, scopeUser) {
  const now = new Date(nowMs || Date.now());
  const todayStart = startOfDay(now);
  const tomorrowStart = new Date(todayStart); tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  const rangeStart = range === "today" ? todayStart
    : range === "7d" ? new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000)
    : new Date(0);
  const inRange = (d) => !!d && d >= rangeStart && d < tomorrowStart;
  const callsAll = (st.callLogs || []).map((c) => ({...c, at: parseStoredDate(c.date, c.time)})).filter((c) => c.at && inRange(c.at));
  // Scope filter (2026-11-21): null = Company, a username = that person.
  // The leaderboard below always uses callsAll (whole team, any scope).
  const calls = scopeUser ? callsAll.filter((c) => c.by === scopeUser) : callsAll;
  const isConn = (c) => CONNECTED_OUTCOMES.includes(c.outcome);
  const dials = calls.length;
  const connected = calls.filter(isConn).length;
  const noAnswer = calls.filter((c) => c.outcome === "no_answer").length;
  const voicemail = calls.filter((c) => c.outcome === "voicemail").length;
  const busy = calls.filter((c) => c.outcome === "busy").length;
  const meetings = calls.filter((c) => c.outcome === "meeting_booked").length;
  const connectRate = dials ? Math.round((connected / dials) * 1000) / 10 : null;
  const meetingRate = connected ? Math.round((meetings / connected) * 1000) / 10 : null;
  // Dials per hour today: dials logged today over hours since midnight
  // (at least 15 minutes, so one early dial does not read as 60/hour).
  const todayCalls = calls.filter((c) => dayKeyOf(c.at) === dayKeyOf(now));
  const hoursToday = Math.max(0.25, (now - todayStart) / 3600000);
  const dialsPerHour = todayCalls.length ? Math.round((todayCalls.length / hoursToday) * 10) / 10 : null;
  // Per-day buckets: today (1), 7d (7), all (every day with data, most recent 14).
  let days = [];
  if (range === "today") days = [todayStart];
  else if (range === "7d") { for (let i = 6; i >= 0; i--) { const d = new Date(todayStart); d.setDate(d.getDate() - i); days.push(d); } }
  else {
    const keys = {};
    (st.callLogs || []).forEach((c) => { const d = parseStoredDate(c.date, c.time); if (d) keys[dayKeyOf(d)] = startOfDay(d); });
    days = Object.values(keys).sort((a, b) => a - b).slice(-14);
    if (!days.length) days = [todayStart];
  }
  const perDay = days.map((d) => {
    const k = dayKeyOf(d);
    const dc = calls.filter((c) => dayKeyOf(c.at) === k);
    return {key: k, label: dayLabelOf(d), dials: dc.length, connected: dc.filter(isConn).length, meetings: dc.filter((c) => c.outcome === "meeting_booked").length};
  });
  // Outcome breakdown (in range), most common first.
  const outCounts = {};
  calls.forEach((c) => { outCounts[c.outcome] = (outCounts[c.outcome] || 0) + 1; });
  const outcomes = Object.keys(outCounts).map((o) => ({outcome: o, label: callLabel(o), count: outCounts[o], pct: dials ? Math.round((outCounts[o] / dials) * 1000) / 10 : 0})).sort((a, b) => b.count - a.count);
  // Per lead (in range), most dialled first. Deleted leads are NOT
  // dropped (delete safeguard, 2026-11-21): their calls still count, and
  // they appear under the business name stored on the call entry itself,
  // marked "(deleted)" so the totals stay honest.
  const livePerLead = (st.leads || []).map((l) => {
    const lc = calls.filter((c) => c.leadId === l.id);
    const sorted = [...lc].sort((a, b) => a.at - b.at);
    const last = sorted[sorted.length - 1];
    return {id: l.id, business: l.business, dials: lc.length, connected: lc.filter(isConn).length, lastOutcome: last ? callLabel(last.outcome) : null, meetings: lc.filter((c) => c.outcome === "meeting_booked").length};
  });
  const orphanLeadIds = [...new Set(calls.map((c) => c.leadId))].filter((id) => !(st.leads || []).some((l) => l.id === id));
  const orphanPerLead = orphanLeadIds.map((id) => {
    const lc = calls.filter((c) => c.leadId === id);
    const sorted = [...lc].sort((a, b) => a.at - b.at);
    const last = sorted[sorted.length - 1];
    const name = (last && last.leadName) || (lc[0] && lc[0].leadName) || "Deleted lead";
    return {id, business: name + " (deleted)", dials: lc.length, connected: lc.filter(isConn).length, lastOutcome: last ? callLabel(last.outcome) : null, meetings: lc.filter((c) => c.outcome === "meeting_booked").length};
  });
  const perLead = [...livePerLead, ...orphanPerLead]
    .sort((a, b) => b.dials - a.dials || (a.business < b.business ? -1 : 1));
  // Per rep (in range) — all three, zeros and all.
  const perRep = ANALYTICS_REPS.filter((r) => !scopeUser || r.username === scopeUser).map((r) => {
    const rc = calls.filter((c) => c.by === r.username);
    return {username: r.username, name: r.name, dials: rc.length, connected: rc.filter(isConn).length, meetings: rc.filter((c) => c.outcome === "meeting_booked").length};
  });
  // Receptionist (in range). Minutes come from durationSec; calls without
  // one (missed / hung up before the relay) count as 0 minutes and are
  // flagged, not guessed.
  const reps = (repCalls || []).map((c) => ({...c, at: c.startedAt ? new Date(c.startedAt) : null})).filter((c) => c.at && !isNaN(c.at) && inRange(c.at));
  const repMinutes = Math.round((reps.reduce((a, c) => a + (Number(c.durationSec) || 0), 0) / 60) * 10) / 10;
  const repMissingDuration = reps.filter((c) => !(Number(c.durationSec) > 0)).length;
  const repCost = Math.round(repMinutes * RECEP_COST_PER_MIN * 100) / 100;
  const repOutCounts = {};
  reps.forEach((c) => { const [label] = aiRepOutcome(c); repOutCounts[label] = (repOutCounts[label] || 0) + 1; });
  const repOutcomes = Object.keys(repOutCounts).map((label) => ({label, count: repOutCounts[label]})).sort((a, b) => b.count - a.count);
  const repRecent = [...reps].sort((a, b) => b.at - a.at).slice(0, 5);
  // Leaderboard (2026-11-21): whole-team ranking for the selected range —
  // it IGNORES the scope filter (a leaderboard compares the team). Ranked
  // by meetings, then connected, then dials. Talk minutes come from the
  // per-user caps counters, which only exist for today.
  const capsUsers = (capsData && capsData.users) || null;
  const leaderboard = ANALYTICS_REPS.map((r) => {
    const rc = callsAll.filter((c) => c.by === r.username);
    const rDials = rc.length;
    const rConn = rc.filter(isConn).length;
    const rMeetings = rc.filter((c) => c.outcome === "meeting_booked").length;
    const talkSec = capsUsers && capsUsers[r.username] ? (capsUsers[r.username].talkSec || 0) : null;
    return {username: r.username, name: r.name, dials: rDials, connected: rConn, connectRate: rDials ? Math.round((rConn / rDials) * 1000) / 10 : null, meetings: rMeetings, talkMin: (range === "today" && talkSec !== null) ? Math.round((talkSec / 60) * 10) / 10 : null};
  }).sort((a, b) => b.meetings - a.meetings || b.connected - a.connected || b.dials - a.dials);
  return {
    range, rangeLabel: (ANALYTICS_RANGES.find((r) => r[0] === range) || ["", ""])[1],
    leaderboard, leaderboardTalkNote: range === "today" ? "" : "Talk minutes are tracked daily — shown for Today only.", scoped: !!scopeUser,
    dials, connected, noAnswer, voicemail, busy, meetings,
    connectRate, meetingRate, dialsPerHour, todayDials: todayCalls.length,
    perDay, outcomes, perLead, perRep,
    repTotal: reps.length, repMinutes, repCost, repMissingDuration, repOutcomes, repRecent,
    empty: dials === 0 && reps.length === 0,
  };
}

/* Analytics area chart (v22, reference UI): dials + meetings per day as an
   SVG area/line chart — real data only, from computeAnalytics' perDay
   (already range- and scope-filtered; receptionist calls are not plotted —
   they stay team-wide per the existing note). Hover shows date + dials,
   connected, meetings. Zero calls in range → honest empty state, never
   plotted fake points. Pure SVG, no library. */
let _anChartData = [];
function anChartTipHtml(d) {
  return `<b>${esc(d.label)}</b><br>${d.dials} dial${d.dials === 1 ? "" : "s"} · ${d.connected} connected · ${d.meetings} meeting${d.meetings === 1 ? "" : "s"}`;
}
function anAreaChartHtml(a) {
  const pts = a.perDay || [];
  const total = pts.reduce((s, d) => s + d.dials + d.meetings, 0);
  if (!total) {
    return `<div class="notice">No calls logged yet — dial a lead in RIP MODE and this chart fills in from real calls. Nothing here is seeded or estimated.</div>`;
  }
  const W = 660, H = 230, padL = 34, padR = 14, padT = 14, padB = 26;
  const max = Math.max(1, ...pts.map((d) => d.dials));
  const n = pts.length;
  const x = (i) => n === 1 ? W / 2 : padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const line = (get) => pts.map((d, i) => (i ? "L" : "M") + x(i).toFixed(1) + "," + y(get(d)).toFixed(1)).join(" ");
  const area = line((d) => d.dials) + ` L${x(n - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const ticks = [0, Math.round(max / 2), max].filter((v, i, arr) => arr.indexOf(v) === i);
  const step = Math.max(1, Math.ceil(n / 7));
  return `<div class="an-chart-wrap">
  <svg data-an-chart viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Dials and meetings per day">
    <defs><linearGradient id="an-area-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#34d399" stop-opacity="0.28"/><stop offset="100%" stop-color="#34d399" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map((v) => `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" class="an-grid"/><text x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" class="an-axis" text-anchor="end">${v}</text>`).join("")}
    <path d="${area}" fill="url(#an-area-grad)"/>
    <path d="${line((d) => d.dials)}" class="an-line-dials" fill="none"/>
    <path d="${line((d) => d.meetings)}" class="an-line-meetings" fill="none"/>
    ${pts.map((d, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(d.dials).toFixed(1)}" r="3" class="an-dot-dials"/>`).join("")}
    ${pts.map((d, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(d.meetings).toFixed(1)}" r="3" class="an-dot-meetings"/>`).join("")}
    ${pts.map((d, i) => (i % step === 0) ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="an-axis" text-anchor="middle">${esc(d.label)}</text>` : "").join("")}
    <circle id="an-chart-dot" r="4.5" class="an-dot-hl" style="display:none"/>
    <rect data-an-chart-hit x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" fill="transparent"/>
  </svg>
  <div class="an-chart-tip hidden" id="an-chart-tip"></div>
  <div class="an-chart-legend"><span><i class="an-sw-dials"></i>Dials</span><span><i class="an-sw-meetings"></i>Meetings</span></div>
</div>`;
}

function anBarRow(label, value, max, sub) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return `<div class="an-bar-row"><span class="an-bar-label">${esc(label)}</span><span class="an-bar-track"><span class="an-bar-fill" style="width:${pct}%"></span></span><span class="an-bar-val">${esc(String(value))}${sub ? ` <span class="an-bar-sub">${esc(sub)}</span>` : ""}</span></div>`;
}

function capsCardHtml() {
  const isOwner = roleFor(me) === "owner";
  const dis = isOwner ? "" : "disabled";
  const tl = capsLimits().team;
  const users = capsLimits().users || {};
  if (!capsData) {
    return `<div class="card" id="caps-card"><div class="section-title" style="margin-top:0">Daily limits</div><div class="notice">Loading today's limits…</div></div>`;
  }
  const numField = (id, label, value) => `<div class="field"><label>${esc(label)}</label><input class="input" id="${id}" type="number" min="0" step="1" value="${esc(String(value))}" ${dis}></div>`;
  return `<div class="card" id="caps-card">
    <div class="section-title" style="margin-top:0">Daily limits — team + per person, resets midnight ET</div>
    ${capsRowsHtml()}
    <div class="caps-group"><b>Team caps</b><div class="caps-form">
      ${numField("caps-team-dials", "Dials / day", tl.dials)}
      ${numField("caps-team-talk", "Talk minutes / day", tl.talkMin)}
      ${numField("caps-team-sms", "Texts / day", tl.sms)}
      ${numField("caps-team-emails", "Emails / day", tl.emails)}
      ${numField("caps-team-max", "Max seconds / call", tl.maxCallSec)}
    </div></div>
    ${CAPS_USERS.map((u) => {
      const ul = users[u.username] || CAPS_DEFAULT_LIMITS.users[u.username];
      return `<div class="caps-group"><b>${esc(u.name)} — per-person caps</b><div class="caps-form">
        ${numField("caps-u-" + u.username + "-dials", "Dials / day", ul.dials)}
        ${numField("caps-u-" + u.username + "-talk", "Talk minutes / day", ul.talkMin)}
        ${numField("caps-u-" + u.username + "-sms", "Texts / day", ul.sms)}
        ${numField("caps-u-" + u.username + "-emails", "Emails / day", ul.emails)}
      </div></div>`;
    }).join("")}
    ${isOwner
      ? `<button class="btn btn--primary" id="caps-save" style="margin-top:12px">Save caps</button>
         <div id="caps-save-note" class="hidden" style="margin-top:10px"></div>
         <p class="caps-note">Saves live immediately — the next dial checks the new numbers. The team text cap is forwarded to the receptionist best-effort.</p>`
      : `<p class="caps-note">Only the owner can change caps — you're signed in as staff. Values above are read-only.</p>`}
  </div>`;
}

/* ---------- Dashboard overview (2026-11-21, v23) ----------
   The reference screenshot's screen, rebuilt with SFB's REAL data only:
   3 stat cards (Leads / Connect rate / Meetings booked) with vs-last-week
   delta pills, a Dials-over-time area chart (reuses the v22 chart code),
   a Leads Management panel (Status / Sources / Qualification) and a Team
   panel (leaderboard). Read-only: every card and panel links to its real
   tab. No revenue, no CLV, no retention — SFB has none of those yet, so
   they are not shown. No fake numbers anywhere. */
let dbRange = "7d"; // chart range, same options as Analytics
let dbLeadsTab = "status"; // "status" | "sources" | "qual"

/* Pure: this-week vs prior-week deltas from callLogs (server-dated
   "Nov 20, 2026" strings). Returns {dials, ratePts, meetings} where each
   is a number or null when there is nothing to compare (both weeks empty,
   or a rate with no dials in either week). Leads have no creation dates
   in the data, so the Leads card always shows "—". */
function dbWeekDeltas(st, nowMs) {
  const now = new Date(nowMs || Date.now());
  const todayStart = startOfDay(now);
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const thisStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
  const priorStart = new Date(todayStart.getTime() - 13 * 24 * 60 * 60 * 1000);
  const calls = (st.callLogs || []).map((c) => ({...c, at: parseStoredDate(c.date, c.time)})).filter((c) => c.at);
  const isConn = (c) => CONNECTED_OUTCOMES.includes(c.outcome);
  const thisW = calls.filter((c) => c.at >= thisStart && c.at < tomorrowStart);
  const priorW = calls.filter((c) => c.at >= priorStart && c.at < thisStart);
  const diff = (a, b) => (a === 0 && b === 0 ? null : a - b);
  const rate = (cs) => cs.length ? cs.filter(isConn).length / cs.length : null;
  const rThis = rate(thisW), rPrior = rate(priorW);
  const ratePts = (rThis === null || rPrior === null) ? null : Math.round((rThis - rPrior) * 1000) / 10;
  const mThis = thisW.filter((c) => c.outcome === "meeting_booked").length;
  const mPrior = priorW.filter((c) => c.outcome === "meeting_booked").length;
  return {dials: diff(thisW.length, priorW.length), ratePts, meetings: diff(mThis, mPrior)};
}
/* Delta pill: green when up, red when down, neutral "—" when there is
   nothing to compare. The value is an absolute change (dials, meetings)
   or percentage points (connect rate, suffix " pts"). */
function dbDeltaPill(v, suffix) {
  if (v === null || v === undefined) return `<span class="db-delta none">—</span>`;
  const cls = v === 0 ? "none" : (v > 0 ? "up" : "down");
  const sign = v > 0 ? "+" : "";
  return `<span class="db-delta ${cls}">${sign}${v}${suffix || ""}</span>`;
}
function renderDashboard() {
  const leads = state.leads || [];
  const aAll = computeAnalytics(state, [], "all", undefined, null);
  const aChart = computeAnalytics(state, [], dbRange, undefined, null);
  _anChartData = aChart.perDay || [];
  const deltas = dbWeekDeltas(state);
  const connectRate = aAll.connectRate; // null when 0 dials
  const rangeBtns = ANALYTICS_RANGES.map(([v, label]) => `<button class="btn ${dbRange === v ? "btn--primary" : ""}" data-dbrange="${v}" aria-pressed="${dbRange === v}">${label}</button>`).join("");
  // Leads Management — Status: the 5 real pipeline stages with counts.
  const stageCounts = STAGES.map((s) => ({stage: s, n: leads.filter((l) => (l.stage || "New") === s).length}));
  // Sources: by lead list on file — Naples 239 vs Jax / Performance.
  // The data has no source field; the lists are told apart by id prefix.
  const srcCounts = [
    {label: "Naples 239", n: leads.filter((l) => (l.id || "").indexOf("lead-naples-") === 0).length},
    {label: "Jax / Performance", n: leads.filter((l) => (l.id || "").indexOf("lead-naples-") !== 0).length},
  ];
  // Qualification: ICP = Florida residential roofers (the whole list is
  // niche Roofing in Naples / Jacksonville / Oviedo). No lead carries a
  // verification flag in the dialer data, so none is invented here.
  const inIcp = leads.filter((l) => (l.niche || "") === "Roofing").length;
  const maxLeads = Math.max(leads.length, 1);
  const lmBody = dbLeadsTab === "status"
    ? stageCounts.map((s) => anBarRow(s.stage, s.n, maxLeads, "")).join("") + `<p class="notice">Stages move in the Pipeline — a booking moves a lead from New to In conversation.</p>`
    : dbLeadsTab === "sources"
    ? srcCounts.map((s) => anBarRow(s.label, s.n, maxLeads, "")).join("") + `<p class="notice">By lead list on file. The Tampa + Miami lists are not loaded yet.</p>`
    : anBarRow("In ICP — FL residential roofer", inIcp, maxLeads, "") + anBarRow("Outside ICP", leads.length - inIcp, maxLeads, "") + `<p class="notice">ICP = Florida residential roofers, $1–5M/yr, owner-operator. Verification flags (verify / do-not-pitch) live in the research notes, not in dialer data yet.</p>`;
  const maxLbMeetings = Math.max(0, ...aChart.leaderboard.map((r) => r.meetings));
  const teamRows = aChart.leaderboard.map((r, i) => `<div class="lb-row"><span class="lb-rank">#${i + 1}</span><span class="lb-name"><b>${esc(r.name)}</b></span><span class="lb-nums">${r.meetings} meetings · ${r.connected} connected · ${r.dials} dials</span><span class="lb-bar"><span style="width:${maxLbMeetings ? Math.round((r.meetings / maxLbMeetings) * 100) : 0}%"></span></span></div>`).join("");
  return `
  <div class="db-stats">
    <button type="button" class="db-stat" data-dbgo="leads">
      <span class="db-stat-label">Leads</span>
      <span class="db-stat-num">${leads.length}</span>
      <span class="db-stat-sub">${dbDeltaPill(null)} <span>vs last week</span></span>
    </button>
    <button type="button" class="db-stat" data-dbgo="analytics">
      <span class="db-stat-label">Connect rate</span>
      <span class="db-stat-num">${connectRate === null ? "—" : connectRate + "%"}</span>
      <span class="db-stat-sub">${dbDeltaPill(deltas.ratePts, " pts")} <span>vs last week</span></span>
    </button>
    <button type="button" class="db-stat" data-dbgo="calendar">
      <span class="db-stat-label">Meetings booked</span>
      <span class="db-stat-num">${aAll.meetings}</span>
      <span class="db-stat-sub">${dbDeltaPill(deltas.meetings)} <span>vs last week</span></span>
    </button>
  </div>
  <div class="card db-chart-card">
    <div class="db-card-head"><div class="section-title" style="margin-top:0">Dials over time — ${esc(aChart.rangeLabel)}</div><div class="an-range">${rangeBtns}</div></div>
    ${anAreaChartHtml(aChart)}
    <p class="notice">Dials and meetings from real calls only. No revenue is shown — BillMe is in test mode ($0 real money).</p>
  </div>
  <div class="db-panels">
    <div class="card db-panel">
      <div class="db-card-head"><div class="section-title" style="margin-top:0">Leads Management</div><button class="btn" data-dbgo="pipeline">View Pipeline</button></div>
      <div class="seg-toggle" role="group" aria-label="Leads management view">
        <button type="button" data-dbleads="status" aria-pressed="${dbLeadsTab === "status"}">Status</button>
        <button type="button" data-dbleads="sources" aria-pressed="${dbLeadsTab === "sources"}">Sources</button>
        <button type="button" data-dbleads="qual" aria-pressed="${dbLeadsTab === "qual"}">Qualification</button>
      </div>
      <div style="margin-top:14px">${lmBody}</div>
    </div>
    <div class="card db-panel">
      <div class="db-card-head"><div class="section-title" style="margin-top:0">Team — ${esc(aChart.rangeLabel)}</div><button class="btn" data-dbgo="analytics">View Analytics</button></div>
      ${teamRows}
      <p class="notice">Ranked by meetings booked, then connected, then dials. Always the full team.</p>
    </div>
  </div>`;
}
function bindDashboard() {
  document.querySelectorAll("[data-dbgo]").forEach((b) => b.onclick = () => onNavigate(b.dataset.dbgo));
  document.querySelectorAll("[data-dbrange]").forEach((b) => b.onclick = () => { dbRange = b.dataset.dbrange; render(); });
  document.querySelectorAll("[data-dbleads]").forEach((b) => b.onclick = () => { dbLeadsTab = b.dataset.dbleads; render(); });
  bindAreaChart();
}

function renderAnalytics() {
  if (!analyticsLoaded) {
    return `<div class="card"><div class="notice">Loading analytics…</div><button class="btn" id="an-refresh">Refresh</button></div>`;
  }
  const scopeUser = analyticsScope === "me" ? me : (analyticsScope === "company" ? null : analyticsScope);
  const a = computeAnalytics(state, analyticsRepCalls, analyticsRange, undefined, scopeUser);
  _anChartData = a.perDay || [];
  const rangeBtns = ANALYTICS_RANGES.map(([v, label]) => `<button class="btn ${analyticsRange === v ? "btn--primary" : ""}" data-anrange="${v}" aria-pressed="${analyticsRange === v}">${label}</button>`).join("");
  const pct = (v) => (v === null ? "—" : v + "%");
  const maxLbMeetings = Math.max(0, ...a.leaderboard.map((r) => r.meetings));
  const empty = a.empty ? `<div class="card"><div class="notice">No calls yet — dial a lead in RIP MODE or wait for an inbound call. These numbers fill in from real calls only; nothing here is seeded or estimated.</div></div>` : "";
  return `
  <div class="an-range">${rangeBtns}<button class="btn" id="an-refresh">Refresh</button></div>
  <div class="card"><div class="seg-toggle" role="group" aria-label="Analytics scope">
    <button type="button" class="${analyticsScope === "company" ? "seg-on" : ""}" data-anscope="company">Company</button>
    <button type="button" class="${analyticsScope === "me" ? "seg-on" : ""}" data-anscope="me">Personal</button>
  </div>
  <select class="input" id="an-member" style="margin-top:8px" aria-label="Team member">
    <option value="">Team member…</option>
    ${ANALYTICS_REPS.map((r) => `<option value="${r.username}" ${analyticsScope === r.username ? "selected" : ""}>${esc(r.name)}</option>`).join("")}
  </select>
  <p class="notice">Personal shows only your numbers. Picking a team member shows theirs. The leaderboard below always shows the full team.</p></div>
  <div class="card"><div class="section-title" style="margin-top:0">Leaderboard — ${esc(a.rangeLabel)}</div>
    ${a.leaderboard.map((r, i) => `<div class="lb-row"><span class="lb-rank">#${i + 1}</span><span class="lb-name">${esc(r.name)}</span><span class="lb-nums">${r.dials} dials · ${r.connected} connected · ${r.connectRate === null ? "—" : r.connectRate + "%"} · ${r.meetings} meetings · ${r.talkMin === null ? "—" : r.talkMin + " min talk"}</span><span class="lb-bar"><span style="width:${maxLbMeetings ? Math.round((r.meetings / maxLbMeetings) * 100) : 0}%"></span></span></div>`).join("")}
    <p class="notice">Ranked by meetings booked, then connected, then dials. Always the full team, whatever the scope filter is.${a.leaderboardTalkNote ? " " + esc(a.leaderboardTalkNote) : ""}</p></div>
  ${capsCardHtml()}
  ${analyticsError ? `<div class="card"><div class="error">${esc(analyticsError)}</div></div>` : ""}
  ${analyticsRepError ? `<div class="card"><div class="notice">Receptionist calls could not be loaded — ${esc(analyticsRepError)} The outbound numbers below are still real.</div></div>` : ""}
  ${empty}
  <div class="card">
    <div class="section-title" style="margin-top:0">Outbound — ${esc(a.rangeLabel)}</div>
    <div class="stat-boxes">
      <div class="stat-box"><div class="num">${a.dials}</div><div class="lbl">Dials</div></div>
      <div class="stat-box"><div class="num">${a.connected}</div><div class="lbl">Connected</div></div>
      <div class="stat-box"><div class="num">${pct(a.connectRate)}</div><div class="lbl">Connect rate</div></div>
      <div class="stat-box"><div class="num">${a.noAnswer}</div><div class="lbl">No answer</div></div>
      <div class="stat-box"><div class="num">${a.voicemail}</div><div class="lbl">Voicemail</div></div>
      <div class="stat-box"><div class="num">${a.meetings}</div><div class="lbl">Meetings booked</div></div>
      <div class="stat-box"><div class="num">${pct(a.meetingRate)}</div><div class="lbl">Meeting conversion</div></div>
      <div class="stat-box"><div class="num">${a.dialsPerHour === null ? "—" : a.dialsPerHour}</div><div class="lbl">Dials / hour today</div></div>
      <div class="stat-box"><div class="num">${a.repTotal}</div><div class="lbl">Receptionist calls</div></div>
    </div>
    ${scopeUser ? `<p class="notice">Receptionist calls are team-wide — no per-person attribution</p>` : ""}
    <p class="notice">Dials = logged call events. A call that ends in a booking logs twice — the call and the booking — so Dials can run ahead of calls placed. Connect rate = connected ÷ dials. Meeting conversion = meetings ÷ connected.</p>
  </div>
  <div class="card">
    <div class="section-title" style="margin-top:0">Costs — estimates at the rates shown</div>
    <div class="kv"><span>Receptionist</span><span>${a.repMinutes} min · ≈ $${a.repCost.toFixed(2)} (est.)</span></div>
    <div class="kv"><span>Outbound talk</span><span>${capsData ? capsTalkMin(capsTeam().talkSec) + " min today · ≈ $" + ((capsTeam().talkSec / 60) * OUTBOUND_COST_PER_MIN).toFixed(2) + " (est., $" + OUTBOUND_COST_PER_MIN + "/min)" : "Not tracked yet — talk minutes aren't recorded (≈ $" + OUTBOUND_COST_PER_MIN + "/min when tracked)"}</span></div>
    <div class="kv"><span>Twilio balance</span><span>${esc(BALANCE_NOTE)}</span></div>
    ${a.repMissingDuration ? `<p class="notice">${a.repMissingDuration} receptionist call${a.repMissingDuration === 1 ? "" : "s"} in this range have no duration recorded, so the minutes above are a lower bound.</p>` : ""}
  </div>
  <div class="card">
    <div class="section-title" style="margin-top:0">Dials &amp; meetings over time — ${esc(a.rangeLabel)}</div>
    ${anAreaChartHtml(a)}
    <div class="section-title">Calls per day — ${a.range === "today" ? "today" : a.range === "7d" ? "last 7 days" : "all time (last 14 days)"}</div>
    ${a.perDay.map((d) => anBarRow(d.label, d.dials, Math.max(...a.perDay.map((x) => x.dials), 1), d.connected + " connected · " + d.meetings + " mtg")).join("")}
    <div class="section-title">Outcome breakdown — ${esc(a.rangeLabel)}</div>
    ${a.outcomes.length ? a.outcomes.map((o) => anBarRow(o.label, o.count, Math.max(...a.outcomes.map((x) => x.count), 1), o.pct + "%")).join("") : `<div class="notice">No outcomes in this range.</div>`}
    <div class="section-title">Meetings per day</div>
    ${a.perDay.map((d) => anBarRow(d.label, d.meetings, Math.max(...a.perDay.map((x) => x.meetings), 1), "")).join("")}
  </div>
  <div class="card">
    <div class="section-title" style="margin-top:0">Receptionist outcomes — ${esc(a.rangeLabel)}</div>
    ${a.repOutcomes.length ? a.repOutcomes.map((o) => anBarRow(o.label, o.count, Math.max(...a.repOutcomes.map((x) => x.count), 1), "")).join("") : `<div class="notice">No receptionist calls in this range.</div>`}
    ${a.repRecent.length ? `<div class="section-title">Recent receptionist calls</div>` + a.repRecent.map((c) => {
      const [label, cls] = aiRepOutcome(c);
      return `<div class="kv"><span><b>${esc(c.from || "Unknown caller")}</b><br><span style="color:var(--muted);font-size:13px">${esc(aiRepWhen(c.startedAt))} · ${esc(c.summary || "No summary yet.")}</span></span><span class="badge ${cls}">${esc(label)}</span></div>`;
    }).join("") + `<button class="btn" id="an-goto-airep" style="margin-top:12px">See all calls in AI Rep</button>` : ""}
  </div>
  <div class="section-title">Per lead — ${esc(a.rangeLabel)}</div>
  <div class="card"><div class="table-wrap"><table>
    <thead><tr><th>Lead</th><th>Dials</th><th>Connected</th><th>Last outcome</th><th>Meetings</th></tr></thead>
    <tbody>${a.perLead.map((l) => `<tr><td><b>${esc(l.business)}</b></td><td>${l.dials}</td><td>${l.connected}</td><td>${esc(l.lastOutcome || "—")}</td><td>${l.meetings}</td></tr>`).join("") || `<tr><td colspan="5">No leads yet.</td></tr>`}</tbody>
  </table></div></div>
  <div class="section-title">Per rep — ${esc(a.rangeLabel)}</div>
  <div class="card"><div class="table-wrap"><table>
    <thead><tr><th>Rep</th><th>Dials</th><th>Connected</th><th>Meetings</th></tr></thead>
    <tbody>${a.perRep.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${r.dials}</td><td>${r.connected}</td><td>${r.meetings}</td></tr>`).join("")}</tbody>
  </table></div></div>`;
}

/* Area-chart hover (v22, extracted 2026-11-21 v23 so the Dashboard
   overview can reuse it): nearest day by mouse x, tooltip shows the
   real values for that day. Positions are computed in viewBox units
   so the tooltip stays aligned at any rendered width. Wires the
   [data-an-chart] SVG already rendered on the page, using
   _anChartData (set by the render function). */
function bindAreaChart() {
// Area chart hover (v22): nearest day by mouse x, tooltip shows the
// real values for that day. Positions are computed in viewBox units so
// the tooltip stays aligned at any rendered width.
const chartSvg = document.querySelector("[data-an-chart]");
if (chartSvg) {
  const tip = $("#an-chart-tip");
  const dot = $("#an-chart-dot");
  const hit = chartSvg.querySelector("[data-an-chart-hit]");
  const data = _anChartData || [];
  const W = 660, H = 230, padL = 34, padR = 14, padT = 14, padB = 26;
  const move = (e) => {
    if (!data.length || !tip || !dot) return;
    const rect = chartSvg.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const px = frac * W;
    const plotW = W - padL - padR;
    let i = data.length === 1 ? 0 : Math.round((px - padL) / (plotW / (data.length - 1)));
    i = Math.max(0, Math.min(data.length - 1, i));
    const d = data[i];
    const cx = data.length === 1 ? W / 2 : padL + (i * plotW) / (data.length - 1);
    const max = Math.max(1, ...data.map((x) => x.dials));
    const cy = padT + (1 - d.dials / max) * (H - padT - padB);
    dot.setAttribute("cx", cx.toFixed(1)); dot.setAttribute("cy", cy.toFixed(1)); dot.style.display = "";
    tip.innerHTML = anChartTipHtml(d);
    tip.classList.remove("hidden");
    const wrap = chartSvg.closest(".an-chart-wrap");
    const wr = wrap ? wrap.getBoundingClientRect() : rect;
    tip.style.left = Math.max(56, Math.min(wr.width - 56, (cx / W) * wr.width)) + "px";
    tip.style.top = Math.max(0, (cy / H) * wr.height - 56) + "px";
  };
  const leave = () => { if (tip) tip.classList.add("hidden"); if (dot) dot.style.display = "none"; };
  if (hit) { hit.addEventListener("mousemove", move); hit.addEventListener("mouseleave", leave); }
  chartSvg.addEventListener("mouseleave", leave);
}
}

function bindAnalytics() {
  document.querySelectorAll("[data-anrange]").forEach((b) => b.onclick = () => { analyticsRange = b.dataset.anrange; render(); });
  document.querySelectorAll("[data-anscope]").forEach((b) => b.onclick = () => { analyticsScope = b.dataset.anscope; render(); });
  const anMember = $("#an-member");
  if (anMember) anMember.onchange = () => { if (anMember.value) { analyticsScope = anMember.value; render(); } };
  const refresh = $("#an-refresh");
  if (refresh) refresh.onclick = () => { analyticsLoaded = false; loadAnalytics(); };
  const go = $("#an-goto-airep");
  if (go) go.onclick = () => onNavigate("airep");
  bindAreaChart();
  // Owner-only caps save (2026-11-21): team caps + each person's caps.
  // The worker validates every number and 403s staff — a failed save
  // shows the real error and never wipes what was typed.
  const capsSave = $("#caps-save");
  if (capsSave) capsSave.onclick = async () => {
    const num = (id) => { const el = $(id); return el ? Number(el.value) : NaN; };
    const team = { dials: num("#caps-team-dials"), talkMin: num("#caps-team-talk"), sms: num("#caps-team-sms"), emails: num("#caps-team-emails"), maxCallSec: num("#caps-team-max") };
    const users = {};
    CAPS_USERS.forEach((u) => {
      users[u.username] = { dials: num("#caps-u-" + u.username + "-dials"), talkMin: num("#caps-u-" + u.username + "-talk"), sms: num("#caps-u-" + u.username + "-sms"), emails: num("#caps-u-" + u.username + "-emails") };
    });
    const note = $("#caps-save-note");
    const fail = (m) => { if (note) { note.textContent = m; note.className = "error"; } };
    const all = [...Object.values(team), ...Object.values(users).flatMap((o) => Object.values(o))];
    if (all.some((v) => !Number.isInteger(v))) { fail("Caps must be whole numbers."); return; }
    capsSave.disabled = true; capsSave.textContent = "Saving…";
    try {
      const r = await api("/caps/limits", "POST", { team, users });
      if (capsData) capsData.limits = r.limits; else capsData = { limits: r.limits };
      if (note) {
        note.textContent = "Saved — live immediately" + (r.receptionistSmsSync === false ? " (text cap could not be forwarded to the receptionist yet)" : "") + ".";
        note.className = "ok-note";
      }
      render();
    } catch (e) {
      capsSave.disabled = false; capsSave.textContent = "Save caps";
      fail("Save failed — " + (e.message || "the server did not answer."));
    }
  };
}

async function loadAnalytics() {
  if (analyticsLoading) return;
  analyticsLoading = true; analyticsError = ""; analyticsRepError = "";
  await loadCaps(); // today's caps first, so the caps card renders with real numbers
  try { await loadState(); } catch (e) { analyticsError = e.message || "Could not load the dialer data."; }
  if (aiRepLoaded) { analyticsRepCalls = aiRepCalls || []; }
  else {
    try { const r = await api("/airep/calls", "GET"); analyticsRepCalls = r.calls || []; }
    catch (e) { analyticsRepError = e.message || "Could not load the receptionist calls."; analyticsRepCalls = []; }
  }
  analyticsLoading = false; analyticsLoaded = true;
  if (currentTab === "analytics") render();
}

/* ---------- EMAIL ---------- */
// Approved copy — SOP §7, verbatim. Never invent template wording.
// [VSL link] in E4 is an editable placeholder, never a guessed URL.
const EMAIL_TEMPLATES = [
  {id: "e1", name: "Meeting booked confirmation", subject: "Your discovery call is booked — [Business]",
   body: "Hi [Name],\n\nYou're booked in for a free 30-minute discovery call about [Business].\n\nOn the call we'll run your free audit and put together a scope for what we'd build for you — what it would do, and what it would cost. No obligation.\n\nIf you need to move it, reply to this email or rebook here: [Link]\n\nTalk soon,\nRoman Royce — Six Figure Blueprints"},
  {id: "e2", name: "No-answer follow-up", subject: "Missed you — free audit for [Business]",
   body: "Hi [Name],\n\nTried you earlier about [Business] — we help businesses answer every call with AI, so no customer ever gets voicemail again.\n\nI'd like to run a free audit for you: how many calls you're missing, and what those missed calls are costing. It takes 30 minutes and there's no obligation.\n\nBook a time here: [Link]\n\nRoman Royce — Six Figure Blueprints"},
  {id: "e3", name: "Voicemail follow-up", subject: "Left you a voicemail — [Business]",
   body: "Hi [Name],\n\nLeft you a quick voicemail — we build AI receptionists for businesses like [Business], so every call gets answered, booked, or messaged, 24/7.\n\nThe first step is a free 30-minute discovery call. On it we run a free audit of your missed calls and scope out what we'd build.\n\nBook here: [Link]\n\nRoman Royce — Six Figure Blueprints"},
  {id: "e4", name: "Send VSL", subject: "The video I mentioned — [Business]",
   body: "Hi [Name],\n\nHere's the short video on what we do for businesses like [Business]: [VSL link]\n\nIn short: an AI receptionist answers every call, books the job, and follows up — so nothing slips through.\n\nIf you want the free audit we talked about, grab a time here: [Link]\n\nRoman Royce — Six Figure Blueprints"},
  {id: "e5", name: "Callback request", subject: "You asked for a callback — [Business]",
   body: "Hi [Name],\n\nYou asked us to call you back about [Business]. We'll ring you during business hours.\n\nIf it's easier, you can also grab a time for a free discovery call here: [Link] — we'll run your free audit on the call.\n\nRoman Royce — Six Figure Blueprints"},
];
function mergeEmailTemplate(tpl, lead, dateTime) {
  const name = (lead && (lead.owner || lead.business)) || "";
  const biz = (lead && lead.business) || "";
  const sub = (s) => String(s || "").split("[Name]").join(name).split("[Business]").join(biz).split("[Link]").join(CAL_LINK).split("[Date/Time]").join(dateTime || "");
  return {subject: sub(tpl.subject), body: sub(tpl.body)};
}
let emailConnected = null; // null = unknown, true/false from GET /api/email/status
let emailLeadId = null;
let emailQuery = "";
let emailTplKey = "e1";
async function loadEmailStatus() {
  try { const r = await api("/email/status", "GET"); emailConnected = !!r.connected; }
  catch (e) { emailConnected = null; }
  try { await loadState(); } catch (e) {}
  if (currentTab === "email") render();
}
function emailTemplateByKey(key) {
  const b = EMAIL_TEMPLATES.find((t) => t.id === key);
  if (b) return b;
  return (state.emailTemplates || []).find((t) => t.id === key) || null;
}
function renderEmail() {
  const isOwner = roleFor(me) === "owner";
  const lead = leadById(emailLeadId);
  const cur = emailTemplateByKey(emailTplKey) || EMAIL_TEMPLATES[0];
  const merged = lead ? mergeEmailTemplate(cur, lead, "") : {subject: cur.subject, body: cur.body};
  const log = (state.emailLog || []).slice().reverse();
  const banner = emailConnected === false
    ? `<div class="card email-banner"><b>Email is not connected yet.</b><br><span>The Resend key still needs to be connected — the Chrome extension block on agent.meta.ai is stopping the key from being submitted. Sends are disabled until then, and nothing here is ever recorded as sent.</span></div>`
    : emailConnected === null
    ? `<p class="notice">Checking email connection…</p>` : "";
  const tplOptions = EMAIL_TEMPLATES.map((t) => `<option value="${t.id}" ${emailTplKey === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")
    + (state.emailTemplates || []).map((t) => `<option value="${t.id}" ${emailTplKey === t.id ? "selected" : ""}>${esc(t.name)} (custom)</option>`).join("");
  return `
  ${banner}
  <div class="card"><div class="section-title" style="margin-top:0">Compose</div>
    <div class="field"><label>To — pick a lead</label>
      <div class="lead-picker-wrap">
        <input class="input" id="email-lead-input" type="text" placeholder="Search leads…" value="${esc(emailQuery)}" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="email-lead-list">
        <button type="button" class="lead-picker-clear" id="email-lead-clear" aria-label="Clear lead search" style="display:${emailQuery ? "block" : "none"}">×</button>
        <div class="lead-picker-list hidden" id="email-lead-list" role="listbox"></div>
      </div>
    </div>
    <div class="field"><label>To (email)</label><input class="input" id="email-to" type="email" placeholder="owner@business.com" value="${esc(lead && lead.email ? lead.email : "")}"></div>
    <div class="field"><label>Template</label><select class="input" id="email-template">${tplOptions}</select></div>
    <div class="field"><label>Subject</label><input class="input" id="email-subject" type="text" value="${esc(merged.subject)}"></div>
    <div class="field"><label>Body</label><textarea class="input" id="email-body" rows="10">${esc(merged.body)}</textarea></div>
    <button class="btn btn--primary" id="email-send" type="button" ${emailConnected === false ? "disabled" : ""}>Send email</button>
    <p class="notice">Sends count against the daily email cap — team 100/day, you 33/day. From roman@sixfigureblueprintsllc.com. Replace [VSL link] with the real video link before sending — it is never sent as-is.</p>
  </div>
  <div class="card"><div class="section-title" style="margin-top:0">Templates</div>
    ${EMAIL_TEMPLATES.map((t) => `<div class="kv"><span><b>${esc(t.name)}</b><br><span style="color:var(--muted);font-size:13px">${esc(t.subject)}</span></span><button class="btn" type="button" data-use-tpl="${t.id}">Use</button></div>`).join("")}
    ${(state.emailTemplates || []).map((t) => `<div class="kv"><span><b>${esc(t.name)} (custom)</b><br><span style="color:var(--muted);font-size:13px">${esc(t.subject)}</span></span><span style="display:flex;gap:6px"><button class="btn" type="button" data-use-tpl="${t.id}">Use</button>${isOwner ? `<button class="btn btn-danger" type="button" data-del-tpl="${t.id}">Delete</button>` : ""}</span></div>`).join("")}
    ${isOwner ? `<div class="field" style="margin-top:12px"><label>Save a custom template</label><input class="input" id="tpl-name" type="text" placeholder="Template name"><input class="input" id="tpl-subject" type="text" placeholder="Subject" style="margin-top:6px"><textarea class="input" id="tpl-body" rows="4" placeholder="Body — use [Name], [Business], [Link] to merge" style="margin-top:6px"></textarea><button class="btn" id="tpl-save" type="button" style="margin-top:6px">Save template</button></div>`
    : `<p class="notice">Only the owner can save or delete templates — you can use any template above.</p>`}
  </div>
  <div class="card"><div class="section-title" style="margin-top:0">Sent log</div>
    ${log.length ? log.map((e) => `<div class="kv"><span><b>${esc(e.subject)}</b> → ${esc(e.to)}${e.leadName ? " · " + esc(e.leadName) : ""}<br><span style="color:var(--muted);font-size:13px">${esc(DISPLAY_NAMES[e.by] || e.by || "")} · ${esc(e.date || "")} ${esc(e.time || "")}${e.error ? " — " + esc(e.error) : ""}${e.resendId ? " · " + esc(e.resendId) : ""}</span></span><span class="badge ${e.status === "sent" ? "green" : e.status === "failed" ? "red" : "amber"}">${esc(e.status)}</span></div>`).join("")
    : `<p class="notice">No emails yet — nothing has been sent.</p>`}
  </div>`;
}
function fillEmailFromTemplate() {
  const tpl = emailTemplateByKey(emailTplKey);
  if (!tpl) return;
  const lead = leadById(emailLeadId);
  const merged = lead ? mergeEmailTemplate(tpl, lead, "") : {subject: tpl.subject, body: tpl.body};
  const s = $("#email-subject"), b = $("#email-body");
  if (s) s.value = merged.subject;
  if (b) b.value = merged.body;
}
function bindEmail() {
  bindLeadPicker({inputId: "email-lead-input", listId: "email-lead-list", clearId: "email-lead-clear",
    getQuery: () => emailQuery, setQuery: (v) => { emailQuery = v; },
    getSelectedId: () => emailLeadId, setSelectedId: (id) => { emailLeadId = id; },
    onPick: (lead) => { const to = $("#email-to"); if (to) to.value = lead ? (lead.email || "") : ""; fillEmailFromTemplate(); }});
  const sel = $("#email-template");
  if (sel) sel.onchange = () => { emailTplKey = sel.value; fillEmailFromTemplate(); };
  document.querySelectorAll("[data-use-tpl]").forEach((b) => { b.onclick = () => { emailTplKey = b.dataset.useTpl; const s2 = $("#email-template"); if (s2) s2.value = emailTplKey; fillEmailFromTemplate(); }; });
  const send = $("#email-send");
  if (send) send.onclick = async () => {
    const lead = leadById(emailLeadId);
    if (!lead) { showToast("Pick a lead first."); return; }
    const to = $("#email-to").value.trim();
    const subject = $("#email-subject").value;
    const body = $("#email-body").value;
    if (body.indexOf("[VSL link]") !== -1) { showToast("Replace [VSL link] with the real video link before sending."); return; }
    try {
      await mutate("sendEmail", {leadId: lead.id, to, subject, body});
      showToast("Email sent to " + to + ".");
    } catch (e) {
      try { await loadState(); } catch (_) {}
      render();
      showToast("Email not sent — " + (e.message || "try again."));
    }
  };
  const save = $("#tpl-save");
  if (save) save.onclick = async () => {
    const name = $("#tpl-name").value.trim();
    const subject = $("#tpl-subject").value;
    const body = $("#tpl-body").value;
    if (!name || !subject.trim() || !body.trim()) { showToast("Fill in a template name, subject, and body."); return; }
    try { await mutate("saveEmailTemplate", {name, subject, body}); showToast("Template saved."); }
    catch (e) { showToast("Template not saved — " + (e.message || "try again.")); }
  };
  document.querySelectorAll("[data-del-tpl]").forEach((b) => { b.onclick = () => {
    const t = (state.emailTemplates || []).find((x) => x.id === b.dataset.delTpl);
    confirmAction({title: "Delete this template?", body: t ? t.name : "", confirmLabel: "Delete template",
      onConfirm: async () => { try { await mutate("deleteEmailTemplate", {id: b.dataset.delTpl, confirmed: true}); } catch (e) { showToast("Delete failed — " + (e.message || "try again.")); } }});
  }; });
}

/* ---------- ASSIGNMENTS / ANNOUNCEMENTS / TODAY ---------- */
let assignFilter = "all"; // all | mine | <username>
let assignStatusFilter = "all"; // all | todo | doing | done
let assignEditingId = null;
let todayScope = "mine"; // mine | team
function todayETStr() { return new Date().toLocaleDateString("en-CA", {timeZone: "America/New_York"}); }
function assignDueState(a) {
  if (!a.dueDate || a.status === "done") return "none";
  const t = todayETStr();
  if (a.dueDate < t) return "overdue";
  if (a.dueDate === t) return "today";
  return "future";
}
function assignDueLabel(a) {
  if (!a.dueDate) return "No due date";
  const st = assignDueState(a);
  const parts = a.dueDate.split("-");
  const label = parts.length === 3 ? new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).toLocaleDateString("en-US", {month: "short", day: "numeric"}) : a.dueDate;
  if (st === "overdue") return "Overdue · " + label;
  if (st === "today") return "Due today · " + label;
  return "Due " + label;
}
function sortAssignments(list) {
  const rank = (a) => assignDueState(a) === "overdue" ? 0 : assignDueState(a) === "today" ? 1 : a.dueDate ? 2 : 3;
  return list.slice().sort((a, b) => rank(a) - rank(b) || String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}
function canChangeAssignment(a) { return roleFor(me) === "owner" || a.assignee === me; }
function assignRowHtml(a) {
  const isOwner = roleFor(me) === "owner";
  const canChange = canChangeAssignment(a);
  const dueSt = assignDueState(a);
  const nextStatus = a.status === "todo" ? "doing" : a.status === "doing" ? "done" : "todo";
  const nextLabel = a.status === "todo" ? "Start" : a.status === "doing" ? "Mark done" : "Reopen";
  if (assignEditingId === a.id && isOwner) {
    return `<div class="card assign-row"><div class="field"><label>Title</label><input class="input" id="asg-edit-title" type="text" value="${esc(a.title)}"></div>
    <div class="field"><label>Details</label><textarea class="input" id="asg-edit-details" rows="3">${esc(a.details || "")}</textarea></div>
    <div class="field"><label>Assignee</label><select class="input" id="asg-edit-assignee">${["romanroyce", "loganwells", "braylengarrett"].map((u) => `<option value="${u}" ${a.assignee === u ? "selected" : ""}>${esc(DISPLAY_NAMES[u])}</option>`).join("")}</select></div>
    <div class="field"><label>Due date</label><input class="input" id="asg-edit-due" type="date" value="${esc(a.dueDate || "")}"></div>
    <div style="display:flex;gap:8px"><button class="btn btn--primary" type="button" data-asg-save="${a.id}">Save</button><button class="btn" type="button" data-asg-cancel>Cancel</button></div></div>`;
  }
  return `<div class="card assign-row"><div style="display:flex;gap:10px;align-items:flex-start">
    <span class="avatar" style="flex:none">${esc(INITIALS[a.assignee] || "?")}</span>
    <div style="flex:1;min-width:0"><b>${esc(a.title)}</b>
      <div style="color:var(--muted);font-size:13px">${esc(DISPLAY_NAMES[a.assignee] || a.assignee)} · <span class="${dueSt === "overdue" ? "overdue" : ""}">${esc(assignDueLabel(a))}</span>${a.status === "done" && a.completedAt ? " · Done " + esc(a.completedAt) : ""}</div>
      ${a.details ? `<div style="font-size:13px;margin-top:4px">${esc(a.details)}</div>` : ""}
    </div>
    <span class="badge ${a.status === "done" ? "green" : a.status === "doing" ? "amber" : ""}">${esc(a.status)}</span></div>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      ${canChange ? `<button class="btn" type="button" data-asg-status="${a.id}" data-next="${nextStatus}">${nextLabel}</button>` : ""}
      ${isOwner ? `<button class="btn" type="button" data-asg-edit="${a.id}">Edit</button><button class="btn btn-danger" type="button" data-asg-del="${a.id}">Delete</button>` : ""}
    </div></div>`;
}
function renderAssignments() {
  const isOwner = roleFor(me) === "owner";
  let list = state.assignments || [];
  if (assignFilter === "mine") list = list.filter((a) => a.assignee === me);
  else if (assignFilter !== "all") list = list.filter((a) => a.assignee === assignFilter);
  if (assignStatusFilter !== "all") list = list.filter((a) => a.status === assignStatusFilter);
  list = sortAssignments(list);
  return `
  ${isOwner ? `<div class="card"><div class="section-title" style="margin-top:0">New assignment</div>
    <div class="field"><label>Title</label><input class="input" id="asg-title" type="text" placeholder="What needs doing?"></div>
    <div class="field"><label>Details</label><textarea class="input" id="asg-details" rows="2" placeholder="Optional details"></textarea></div>
    <div class="field"><label>Assignee</label><select class="input" id="asg-assignee">${["romanroyce", "loganwells", "braylengarrett"].map((u) => `<option value="${u}">${esc(DISPLAY_NAMES[u])}</option>`).join("")}</select></div>
    <div class="field"><label>Due date</label><input class="input" id="asg-due" type="date"></div>
    <button class="btn btn--primary" id="asg-add" type="button">Create assignment</button></div>` : ""}
  <div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap">
    <select class="input" id="asg-filter" style="flex:1;min-width:160px">
      <option value="all" ${assignFilter === "all" ? "selected" : ""}>All assignments</option>
      <option value="mine" ${assignFilter === "mine" ? "selected" : ""}>Mine</option>
      ${["romanroyce", "loganwells", "braylengarrett"].map((u) => `<option value="${u}" ${assignFilter === u ? "selected" : ""}>${esc(DISPLAY_NAMES[u])}</option>`).join("")}
    </select>
    <select class="input" id="asg-status-filter" style="flex:1;min-width:140px">
      <option value="all" ${assignStatusFilter === "all" ? "selected" : ""}>All statuses</option>
      <option value="todo" ${assignStatusFilter === "todo" ? "selected" : ""}>To do</option>
      <option value="doing" ${assignStatusFilter === "doing" ? "selected" : ""}>Doing</option>
      <option value="done" ${assignStatusFilter === "done" ? "selected" : ""}>Done</option>
    </select></div></div>
  ${list.length ? list.map(assignRowHtml).join("") : `<div class="card"><p class="notice">No assignments yet — the owner can create the first one.</p></div>`}`;
}
function bindAssignments() {
  const add = $("#asg-add");
  if (add) add.onclick = async () => {
    const title = $("#asg-title").value.trim();
    if (!title) { showToast("Enter an assignment title."); return; }
    try { await mutate("addAssignment", {title, details: $("#asg-details").value, assignee: $("#asg-assignee").value, dueDate: $("#asg-due").value}); }
    catch (e) { showToast("Assignment not created — " + (e.message || "try again.")); }
  };
  const f = $("#asg-filter");
  if (f) f.onchange = () => { assignFilter = f.value; render(); };
  const sf = $("#asg-status-filter");
  if (sf) sf.onchange = () => { assignStatusFilter = sf.value; render(); };
  document.querySelectorAll("[data-asg-status]").forEach((b) => { b.onclick = async () => {
    try { await mutate("setAssignmentStatus", {id: b.dataset.asgStatus, status: b.dataset.next}); }
    catch (e) { showToast("Status not changed — " + (e.message || "try again.")); }
  }; });
  document.querySelectorAll("[data-asg-edit]").forEach((b) => { b.onclick = () => { assignEditingId = b.dataset.asgEdit; render(); }; });
  document.querySelectorAll("[data-asg-cancel]").forEach((b) => { b.onclick = () => { assignEditingId = null; render(); }; });
  document.querySelectorAll("[data-asg-save]").forEach((b) => { b.onclick = async () => {
    try { await mutate("updateAssignment", {id: b.dataset.asgSave, title: $("#asg-edit-title").value, details: $("#asg-edit-details").value, assignee: $("#asg-edit-assignee").value, dueDate: $("#asg-edit-due").value}); assignEditingId = null; }
    catch (e) { showToast("Assignment not saved — " + (e.message || "try again.")); }
  }; });
  document.querySelectorAll("[data-asg-del]").forEach((b) => { b.onclick = () => {
    const a = (state.assignments || []).find((x) => x.id === b.dataset.asgDel);
    confirmAction({title: "Delete this assignment?", body: a ? a.title : "", confirmLabel: "Delete assignment",
      onConfirm: async () => { try { await mutate("deleteAssignment", {id: b.dataset.asgDel, confirmed: true}); } catch (e) { showToast("Delete failed — " + (e.message || "try again.")); } }});
  }; });
}
function renderAnnouncements() {
  const isOwner = roleFor(me) === "owner";
  const list = (state.announcements || []).slice().sort((a, b) => (b.pinned === true) - (a.pinned === true) || 0);
  // pinned first, newest first within each group (array order is creation order)
  const ordered = list.filter((a) => a.pinned).reverse().concat(list.filter((a) => !a.pinned).reverse());
  return `
  ${isOwner ? `<div class="card"><div class="section-title" style="margin-top:0">Post an announcement</div>
    <div class="field"><label>Title</label><input class="input" id="ann-title" type="text" placeholder="Announcement title"></div>
    <div class="field"><label>Body</label><textarea class="input" id="ann-body" rows="4" placeholder="What should the team know?"></textarea></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:14px;margin-bottom:12px"><input type="checkbox" id="ann-pin"> Pin to the top</label>
    <button class="btn btn--primary" id="ann-post" type="button">Post announcement</button></div>` : ""}
  ${ordered.length ? ordered.map((a) => `<div class="card"><div style="display:flex;gap:8px;align-items:flex-start"><div style="flex:1"><b>${a.pinned ? "📌 " : ""}${esc(a.title)}</b>
    <div style="white-space:pre-wrap;font-size:14px;margin-top:4px">${esc(a.body)}</div>
    <div style="color:var(--muted);font-size:13px;margin-top:6px">${esc(DISPLAY_NAMES[a.author] || a.author)} · ${esc(a.createdAt || "")}</div></div></div>
    ${isOwner ? `<div style="display:flex;gap:8px;margin-top:10px"><button class="btn" type="button" data-ann-pin="${a.id}" data-pinned="${a.pinned ? "false" : "true"}">${a.pinned ? "Unpin" : "Pin"}</button><button class="btn btn-danger" type="button" data-ann-del="${a.id}">Delete</button></div>` : ""}</div>`).join("")
  : `<div class="card"><p class="notice">No announcements yet.</p></div>`}`;
}
function bindAnnouncements() {
  const post = $("#ann-post");
  if (post) post.onclick = async () => {
    const title = $("#ann-title").value.trim();
    const body = $("#ann-body").value;
    if (!title || !body.trim()) { showToast("Enter a title and a body."); return; }
    try { await mutate("addAnnouncement", {title, body, pinned: $("#ann-pin").checked}); }
    catch (e) { showToast("Announcement not posted — " + (e.message || "try again.")); }
  };
  document.querySelectorAll("[data-ann-pin]").forEach((b) => { b.onclick = async () => {
    try { await mutate("setAnnouncementPin", {id: b.dataset.annPin, pinned: b.dataset.pinned === "true"}); }
    catch (e) { showToast("Pin not changed — " + (e.message || "try again.")); }
  }; });
  document.querySelectorAll("[data-ann-del]").forEach((b) => { b.onclick = () => {
    const a = (state.announcements || []).find((x) => x.id === b.dataset.annDel);
    confirmAction({title: "Delete this announcement?", body: a ? a.title : "", confirmLabel: "Delete announcement",
      onConfirm: async () => { try { await mutate("deleteAnnouncement", {id: b.dataset.annDel, confirmed: true}); } catch (e) { showToast("Delete failed — " + (e.message || "try again.")); } }});
  }; });
}
function renderToday() {
  const pool = (state.assignments || []).filter((a) => todayScope === "mine" ? a.assignee === me : true);
  const t = todayETStr();
  const due = pool.filter((a) => a.dueDate && a.dueDate <= t); // today + overdue, any status (done counts toward progress)
  const total = due.length;
  const doneCount = due.filter((a) => a.status === "done").length;
  const open = sortAssignments(due.filter((a) => a.status !== "done"));
  const row = (a) => `<div class="card assign-row"><label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer">
    <input type="checkbox" data-today-done="${a.id}" style="margin-top:4px">
    <span style="flex:1"><b>${esc(a.title)}</b>
    <span style="color:var(--muted);font-size:13px;display:block">${todayScope === "team" ? esc(DISPLAY_NAMES[a.assignee] || a.assignee) + " · " : ""}<span class="${assignDueState(a) === "overdue" ? "overdue" : ""}">${esc(assignDueLabel(a))}</span></span>
    ${a.details ? `<span style="font-size:13px;display:block;margin-top:4px">${esc(a.details)}</span>` : ""}</span></label></div>`;
  const groups = ["romanroyce", "loganwells", "braylengarrett"].map((u) => ({u, items: open.filter((a) => a.assignee === u)})).filter((g) => g.items.length);
  return `
  <div class="card"><div class="seg-toggle" role="tablist" aria-label="Whose tasks">
    <button type="button" class="${todayScope === "mine" ? "seg-on" : ""}" data-today-scope="mine">Mine</button>
    <button type="button" class="${todayScope === "team" ? "seg-on" : ""}" data-today-scope="team">Team</button>
  </div>
  <p style="margin:10px 0 0">${doneCount} of ${total} done today</p></div>
  ${open.length ? (todayScope === "team" ? groups.map((g) => `<div class="section-title">${esc(DISPLAY_NAMES[g.u])}</div>` + g.items.map(row).join("")).join("") : open.map(row).join(""))
  : `<div class="card"><p class="notice">Nothing due today</p></div>`}`;
}
function bindToday() {
  document.querySelectorAll("[data-today-scope]").forEach((b) => { b.onclick = () => { todayScope = b.dataset.todayScope; render(); }; });
  document.querySelectorAll("[data-today-done]").forEach((c) => { c.onchange = async () => {
    if (!c.checked) return;
    try { await mutate("setAssignmentStatus", {id: c.dataset.todayDone, status: "done"}); }
    catch (e) { showToast("Task not marked done — " + (e.message || "try again.")); }
  }; });
}

/* Generic confirm modal — same overlay id/classes as the lead-delete
   safeguard (the harness expects #delete-confirm). Cancel, Escape, or the
   backdrop closes it and does nothing. */
function confirmAction(opts) {
  closeDeleteConfirm();
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.id = "delete-confirm";
  overlay.innerHTML = `<div class="card confirm-card" role="dialog" aria-label="${esc(opts.title)}">
    <div class="section-title" style="margin-top:0">${esc(opts.title)}</div>
    ${opts.body ? `<p><b>${esc(opts.body)}</b></p>` : ""}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn" id="delete-cancel" type="button">Cancel</button>
      <button class="btn btn-danger" id="delete-confirm-btn" type="button">${esc(opts.confirmLabel || "Delete")}</button>
    </div>
  </div>`;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDeleteConfirm(); });
  overlay.querySelector("#delete-cancel").onclick = () => closeDeleteConfirm();
  overlay.querySelector("#delete-confirm-btn").onclick = async (e) => {
    e.target.disabled = true;
    closeDeleteConfirm();
    try { await opts.onConfirm(); }
    catch (err2) { showToast("Failed — " + (err2.message || "try again.")); }
  };
  document.body.appendChild(overlay);
  document.addEventListener("keydown", confirmDeleteEscape);
  const cancel = overlay.querySelector("#delete-cancel");
  if (cancel) cancel.focus();
}

/* Staff account settings — read-only panel with the signed-in user's own
   details only. No admin controls of any kind. */
function openStaffSettings() {
  const old = document.getElementById("staff-settings");
  if (old) old.remove();
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.id = "staff-settings";
  const rows = [["Display name", DISPLAY_NAMES[me] || me], ["Username", "@" + me], ["Role", roleFor(me)], ["Workspace", "Six Figure Blueprints"]];
  overlay.innerHTML = `<div class="card confirm-card" role="dialog" aria-label="Your settings">
    <div class="section-title" style="margin-top:0">Settings</div>
    ${rows.map(([k, v]) => `<div class="kv staff-settings-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn btn--primary" id="staff-settings-close" type="button">Close</button>
    </div>
  </div>`;
  const close = () => { overlay.remove(); document.removeEventListener("keydown", escClose); };
  const escClose = (e) => { if (e.key === "Escape") close(); };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("#staff-settings-close").onclick = close;
  document.body.appendChild(overlay);
  document.addEventListener("keydown", escClose);
}
/* ---------- CONNECTIONS ---------- */
function renderConnections() {
  const rows = [
    ["Google Voice", "Connected", "Google Voice (213) 495-3536 stays as the manual fallback. Texting is in-app now — TEXT sends a real SMS from +1 239 349 9491 via Twilio; CALL uses Twilio when live, Google Voice until then.", "green"],
    ["Cal.com", "Connected", "7 event types verified. Booking link: " + CAL_LINK, "green"],
    ["Gmail", "Connected via Muse", "Muse connector is connected. This app does not sync Gmail itself.", "green"],
    ["Google Calendar / Meet", "Connected via Muse", "Muse connector is connected. Meet links are created through Calendar events.", "green"],
    ["Resend", "Key pending", "Domain sixfigureblueprintsllc.com is verified in Resend. sfbconnect.com is NOT verified and cannot send. The Resend key still needs to be connected (Chrome extension block on agent.meta.ai) — until then the Email tab shows \"Email is not connected yet\" and Send is disabled. Follow-up emails are queued, never claimed as sent.", "amber"],
    ["Twilio Voice", twilioReady === true ? "Connected" : twilioReady === false ? "Not set up yet" : "Checking…",
      twilioReady === true ? "In-dashboard calling is live — CALL dials through Twilio from the browser. One number, all three of you can call at once."
      : twilioReady === false ? "In-dashboard calling needs: Twilio upgrade + a number + API key and TwiML App set as worker env vars. Until then CALL opens Google Voice."
      : "Checking whether Twilio calling is configured…",
      twilioReady === true ? "green" : twilioReady === false ? "amber" : ""],
  ];
  return `
  <div class="card">${rows.map(([name, status, note, cls]) => `
    <div class="kv"><span><b>${esc(name)}</b><br><span style="color:var(--muted);font-size:13px">${esc(note)}</span></span>
    <span class="badge ${cls}">${esc(status)}</span></div>`).join("")}</div>`;
}

/* ---------- bind + init ---------- */
function bindTab() {
  if (currentTab === "dashboard") bindDashboard();
  else if (currentTab === "rip") bindRip();
  else if (currentTab === "leads") bindLeads();
  else if (currentTab === "pipeline") bindPipeline();
  else if (currentTab === "calendar") bindCalendar();
  else if (currentTab === "calllog") bindCallLog();
  else if (currentTab === "airep") bindAiRep();
  else if (currentTab === "analytics") bindAnalytics();
  else if (currentTab === "email") bindEmail();
  else if (currentTab === "assignments") bindAssignments();
  else if (currentTab === "announcements") bindAnnouncements();
  else if (currentTab === "today") bindToday();
}

/* ---------- login submit: NO <form> (2026-11-20) ----------
   ROOT CAUSE of the Enter-key 404s (found 2026-11-20, proven with live
   requests): the page is /ripmode with NO trailing slash, so the browser
   resolved the RELATIVE "app.js" / "style.css" against the site root ->
   /app.js and /style.css -> the homepage (Next.js) worker, which 404s.
   app.js NEVER loaded in a real browser, so the submit listener never
   registered and Enter natively GET-submitted the form to
   /ripmode?username=... -> the homepage 404. Shell-side checks fetched
   /ripmode/app.js directly and looked fine, which hid it. Fixed by
   (a) absolute asset URLs /ripmode/app.js?v=4 and /ripmode/style.css?v=4
   in index.html, and (b) removing the <form> entirely: with no form
   there is nothing for Enter to submit natively. Sign in is one path
   only — doLogin() — called by the button click and by an explicit Enter
   keydown on the login inputs. Never re-add a <form>, a submit listener,
   or a relative asset URL here. */
const loginBtn = $("#login-btn");
if (loginBtn) loginBtn.addEventListener("click", () => { doLogin(); });
["#login-username", "#login-passcode", "#login-confirm"].forEach((sel) => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doLogin(); }
  });
});
$("#login-username").addEventListener("input", async (e) => {
  const u = e.target.value.trim().toLowerCase();
  if (ALLOWED_USERS.includes(u)) {
    try {
      const s = await api("/auth/check", "POST", {username: u});
      $("#confirm-wrap").classList.toggle("hidden", s.hasAccount);
    } catch (_) {}
  }
});
/* Typing fix (2026-11-20): the login fields are plain inputs — no readonly,
   no disabled, no timers, nothing that clears what the user types. The old
   readonly-until-focus trick + clearAutofill() timers (300/600/2000ms) are
   what stopped Rome typing: on touch/keyboard the readonly field never
   became editable, and the timers wiped values after load. Autofill is
   discouraged only by autocomplete="off" / "new-password" on the fields.
   If Chrome autofills an email into Username, submit rejects any "@" with
   a plain message and the user can tap the field and retype — nothing wipes
   their input. Never prefill or store his email anywhere. */
["#login-passcode", "#login-confirm"].forEach((sel) => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener("input", () => {
    // digits only, max 4 — filter characters as typed, never clear the field
    const d = el.value.replace(/\D/g, "").slice(0, 4);
    if (el.value !== d) el.value = d;
  });
});

checkSession();
