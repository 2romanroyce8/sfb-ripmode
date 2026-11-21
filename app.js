/* RIP MODE standalone — frontend.
   API lives in the Cloudflare router worker (same origin at /ripmode/api when
   served from sixfigureblueprints.com, workers.dev URL when on Vercel).
   In-dashboard calling is Twilio Voice (2026-11-20): CALL dials through the
   browser via the Twilio Voice JS SDK when the token endpoint answers OK.
   Until Twilio is configured on the server, CALL falls back to opening
   Google Voice and says so plainly — never a fake dial. TEXT always opens
   Google Voice (Twilio SMS is a separate step, out of scope). Nothing here
   auto-plays a script or auto-sends an SMS. */
const WORKER_API = "https://sfb-ripmode-router.2romanroyce8.workers.dev/api";
const API_BASE = location.hostname.includes("sixfigureblueprints.com")
  ? "/ripmode/api" : WORKER_API;
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
let currentTab = "rip";
let ripIndex = 0;
let calEvent = null, calTime = null;
const _calToday = new Date(); _calToday.setHours(0, 0, 0, 0);
let calMonth = {y: _calToday.getFullYear(), m: _calToday.getMonth()}; // viewed month
let calDate = new Date(_calToday); // selected day, defaults to today
let calTz = "America/New_York";
const CAL_TZ_LABELS = {"America/New_York": "Eastern", "America/Chicago": "Central", "America/Denver": "Mountain", "America/Los_Angeles": "Pacific", "America/Phoenix": "Mountain (no DST)"};
let activeConv = null;    // lead id for call-log conversation view
let phoneSearch = "";    // live filter text for the unified Call Log list inside the iPhone mockup
let micStream = null, micLevel = 0, micOn = false, muted = false;
let readyOn = false;      // READY toggle state (survives re-renders; the pill is rendered from this)

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

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
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
  updateNav();
  checkTwilio(); // fire-and-forget: decides CALL (Twilio vs Google Voice fallback)
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
    err.textContent = "Use your username, not your email — romanroyce, loganwells, or braylengarrett.";
    err.className = "error"; return;
  }
  if (!ALLOWED_USERS.includes(username)) {
    err.textContent = "That username is not on the team. Only romanroyce, loganwells and braylengarrett can sign in.";
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
    err.textContent = e.message || "Sign-in failed.";
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
function callsFor(leadId) { return (state.callLogs || []).filter((c) => c.leadId === leadId); }
function convFor(leadId) { return (state.conversations || []).find((c) => c.leadId === leadId); }
function bumpStat(key) { state.sessionStats[key] = (state.sessionStats[key] || 0) + 1; }

function openGoogleVoice(kind, lead) {
  // Google Voice has no API and no prefill URL — open the right GV screen,
  // show the number / message, and let Rome dial or send from GV itself.
  const url = kind === "text"
    ? "https://voice.google.com/u/0/messages"
    : "https://voice.google.com/u/0/calls";
  window.open(url, "_blank");
}

/* ---------- Twilio in-dashboard calling (2026-11-20) ----------
   CALL dials through the browser via the Twilio Voice JS SDK. States:
   idle -> dialing -> ringing -> connected -> idle (ended). The call object
   lives in module scope so re-renders never drop it. When the token
   endpoint says Twilio is not configured (twilioReady === false), CALL
   falls back to Google Voice and says so plainly — never a fake dial.
   TEXT always stays Google Voice. */
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
  const btn = $("#call-btn");
  if (btn) {
    const active = callState !== "idle";
    btn.textContent = active ? "END CALL" : "CALL";
    btn.classList.toggle("end", active);
  }
  const tbtn = $("#test-call-btn");
  if (tbtn) tbtn.textContent = (callState !== "idle" && isTestCall) ? "END CALL" : "CALL";
  const line = $("#call-status-line");
  if (line) { line.textContent = callStatusLine(); line.classList.toggle("hidden", !line.textContent); }
}
function setCallState(s) { callState = s; syncCallUI(); }
function startCallTimer() {
  stopCallTimer();
  callTimerId = setInterval(() => {
    if (callState !== "connected") return;
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
      : "Test call ended — " + (CALL_LABELS[m.outcome] || m.outcome) + elapsed + ". Not logged anywhere.";
    isTestCall = false; clearTestInput();
    syncCallUI();
    return;
  }
  const lead = (state && state.leads) ? state.leads[ripIndex] : null;
  if (!lead || callLogged) return;
  callLogged = true;
  lastCallNote = "Call ended — " + (CALL_LABELS[m.outcome] || m.outcome) + (errMsg ? " — " + errMsg : "") + ". Logged to the Call Log.";
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
  rip: ["RIP MODE", ""], // no subtitle under the dialer heading (removed 2026-11-20 at Rome's request; GV number still shown on CALL/TEXT + in the thread note)
  leads: ["Leads", "New leads start in the Pipeline at \"New\"."],
  pipeline: ["Client Pipeline", "5 stages. Move a card with the arrows or the stage picker."],
  calendar: ["Calendar", "Cal.com — pick an event type, a day, and a time. Booking opens your real Cal.com link: https://cal.com/roman-royce/30min"],
  calllog: ["Call Log", "Every call, mirrored as a conversation. Tap a lead to open its chat thread."],
  airep: ["AI Rep", "See every call the AI receptionist takes — and change what callers hear on the next call."],
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
  const meta = TAB_META[currentTab] || TAB_META.rip;
  const crumb = $("#crumb-title");
  if (crumb) crumb.textContent = meta[0];
}
function onNavigate(next) {
  currentTab = next;
  setMenuOpen(false);
  window.scrollTo(0, 0);
  updateNav();
  if (next === "airep") loadAiRep(); // loads status + calls + config, then re-renders
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

function render() {
  if (!state) return;
  const main = $("#main");
  const meta = TAB_META[currentTab] || TAB_META.rip;
  const sub = currentTab === "leads"
    ? `${(state.leads || []).length} leads. New leads start in the Pipeline at "New".`
    : meta[1];
  let body = "";
  if (currentTab === "rip") body = renderRip();
  else if (currentTab === "leads") body = renderLeads();
  else if (currentTab === "pipeline") body = renderPipeline();
  else if (currentTab === "calendar") body = renderCalendar();
  else if (currentTab === "calllog") body = renderCallLog();
  else if (currentTab === "airep") body = renderAiRep();
  else if (currentTab === "connections") body = renderConnections();
  main.innerHTML = `<div class="page-heading"><div><span class="eyebrow">YOUR WORKSPACE</span><h1>${esc(meta[0])}</h1>${sub ? `<p>${esc(sub)}</p>` : ""}</div></div>` + body;
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
  return `
  <div class="grid2">
    <div class="card">
      <div class="lead-line">
        <span class="badge">#${ripIndex + 1} / ${leads.length}</span>
        <div style="margin-top:10px"><b>${esc(lead.business)}</b></div>
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
      <div class="stat-boxes">
        <div class="stat-box"><div class="num">${s.dials || 0}</div><div class="lbl">Dials</div></div>
        <div class="stat-box"><div class="num">${s.connected || 0}</div><div class="lbl">Connected</div></div>
        <div class="stat-box"><div class="num">${s.noAnswer || 0}</div><div class="lbl">No Answer</div></div>
        <div class="stat-box"><div class="num">${s.voicemail || 0}</div><div class="lbl">Voicemail</div></div>
        <div class="stat-box"><div class="num">${s.meetings || 0}</div><div class="lbl">Meetings Booked</div></div>
        <div class="stat-box"><div class="num">${s.perHour || 0}</div><div class="lbl">Per Hour</div></div>
      </div>
      <div class="section-title">No Contact</div>
      <div class="dispo-row">
        <button class="btn" data-dispo="no_answer">No Answer</button>
        <button class="btn" data-dispo="voicemail">Voicemail</button>
      </div>
      <div class="section-title">Conversation</div>
      <div class="dispo-row">
        <button class="btn" data-dispo="not_interested">Not Interested</button>
        <button class="btn" data-dispo="callback">Callback</button>
        <button class="btn" data-dispo="receptionist">Receptionist</button>
        <button class="btn" data-dispo="send_vsl">Send VSL</button>
      </div>
      <div class="section-title">Result</div>
      <button class="btn btn-green" id="book-meeting-btn" style="width:100%;padding:14px;font-size:16px">MEETING BOOKED — CONFIRM + EMAIL + SMS</button>
      <p class="notice">Confirm books the meeting and queues the follow-ups. Email sends once Resend is wired. SMS opens Google Voice with a confirmation text ready for you to send — it is not sent automatically.</p>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn" id="prev-lead" ${ripIndex === 0 ? "disabled" : ""}>← Prev lead</button>
        <button class="btn" id="next-lead" ${ripIndex >= leads.length - 1 ? "disabled" : ""}>Next lead →</button>
      </div>
    </div>
    <div class="card">
      <div class="lead-line"><b>${esc(lead.business)}</b></div>
      <div class="mic-wrap">
        <span class="pill" id="call-pill"><svg class="call-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span id="call-state">${esc(callStateLabel(callState, callElapsed()))}</span></span>
        <div class="mic-bar"><div class="mic-fill" id="mic-fill" style="width:${micLevel}%"></div></div>
        <span class="pill" id="live-pill">${muted ? "MUTED" : "LIVE"}</span>
      </div>
      <div class="lead-line" style="font-size:20px;font-weight:700">${esc(lead.phone)}</div>
      <div id="call-status-line" class="${callStatusLine() ? "notice" : "hidden"}" style="margin-top:10px">${esc(callStatusLine())}</div>
      <div class="ready-row" style="margin-top:12px">
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
      <button class="big-call${callState !== "idle" ? " end" : ""}" id="call-btn">${callState !== "idle" ? "END CALL" : "CALL"}</button>
      <button class="btn" id="text-btn" style="width:100%;margin-top:8px;padding:13px">TEXT</button>
      ${isOwner ? `
      <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
        <div class="section-title">Test call — owner only</div>
        <div style="display:flex;gap:8px">
          <input class="input" id="test-number" type="tel" inputmode="tel" autocomplete="off" placeholder="Enter a number to test-call" value="${esc(testNumberDraft)}" style="flex:1;min-width:0">
          <button class="btn" id="test-call-btn">${callState !== "idle" && isTestCall ? "END CALL" : "CALL"}</button>
        </div>
        <p class="notice">Dials through Twilio from +1 239 349 9491, exactly like a lead call. The number is never saved — not to leads, the Call Log, or anywhere else.</p>
      </div>` : ""}
    </div>
  </div>`;
}

function bindRip() {
  const leads = state.leads || [];
  const lead = leads[ripIndex];
  if (!lead) return;
  const prev = $("#prev-lead"), next = $("#next-lead");
  if (prev) prev.onclick = () => { if (ripIndex > 0) { ripIndex--; render(); } };
  if (next) next.onclick = () => { if (ripIndex < leads.length - 1) { ripIndex++; render(); } };
  document.querySelectorAll("[data-dispo]").forEach((b) => {
    b.onclick = async () => {
      const d = b.dataset.dispo;
      const map = {no_answer: "noAnswer", voicemail: "voicemail", not_interested: "connected", callback: "connected", receptionist: "connected", send_vsl: "connected"};
      await mutate("logDisposition", {leadId: lead.id, outcome: d, stat: map[d] || "connected"});
    };
  });
  const bookBtn = $("#book-meeting-btn");
  if (bookBtn) bookBtn.onclick = async () => {
    const r = await mutate("bookMeeting", {leadId: lead.id});
    const m = (state.meetings || []).find((x) => x.leadId === lead.id);
    const text = `Hi, this is Roman from SFB Connect — confirming our meeting. Here is the booking link if you need it: ${CAL_LINK}`;
    showToast("Meeting booked for " + lead.business + ". Email is queued (Resend pending). SMS: Google Voice will open with this text ready to send:\n\n" + text);
    openGoogleVoice("text", lead);
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
    if (twilioReady) { await startTwilioCall(lead); return; }
    // Not known-live: re-check the server status on EVERY attempt (a false
    // is never cached — see checkTwilio). Only if it is still not ready do
    // we fall back to Google Voice.
    const ok = await checkTwilio();
    if (ok) { await startTwilioCall(lead); return; }
    // Google Voice fallback (Twilio not configured yet) — same as before:
    // log the dial, then open Google Voice. The status line says so plainly.
    await mutate("logDisposition", {leadId: lead.id, outcome: "dialed", stat: "dials", dialOnly: true});
    openGoogleVoice("call", lead);
  };
  const textBtn = $("#text-btn");
  if (textBtn) textBtn.onclick = () => openGoogleVoice("text", lead);
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
  document.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    if (confirm("Delete this lead?")) await mutate("deleteLead", {leadId: b.dataset.del});
  });
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
const CAL_TYPES = [
  {id: "15min", name: "15 min meeting", desc: "15 minutes · Video call", mins: 15},
  {id: "30min", name: "30 min meeting", desc: "30 minutes · Video call", mins: 30},
  {id: "secret", name: "Secret meeting", desc: "Private · Video call", mins: 30},
  {id: "sfb-discovery-call", name: "Six Figure Blueprints — Discovery Call", desc: "Discovery · Video call", mins: 30},
  {id: "bingled-website-strategy", name: "Bingled — Website Strategy Call", desc: "Website strategy · Video call", mins: 30},
];
const SLOT_TIMES = ["9:00 AM","9:30 AM","10:00 AM","10:30 AM","11:00 AM","11:30 AM","1:00 PM","1:30 PM","2:00 PM","2:30 PM","3:00 PM","3:30 PM","4:00 PM","4:30 PM"];
const CAL_TZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix"];
function _calSameDay(a, b) { return !!(a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()); }
function _calKey(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
function renderCalendar() {
  const type = CAL_TYPES.find((t) => t.id === calEvent) || CAL_TYPES[1];
  const meetings = state.meetings || [];
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
        ${meetings.length ? meetings.map((m) => {
          const l = leadById(m.leadId);
          return `<div class="kv"><span>${esc(l ? l.business : "Meeting")}<br><span style="color:var(--muted);font-size:12px">${esc(m.date)} · ${esc(m.time)} · ${esc(m.typeName || "")}</span></span><span class="badge green">Booked</span></div>`;
        }).join("") : `<div class="notice">No meetings booked yet.</div>`}
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
      <div class="calbook-weekdays">${["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="calbook-grid">${cells.map(({d, outside}) => {
        const past = d < _calToday;
        const sel = _calSameDay(d, calDate);
        const isToday = _calSameDay(d, _calToday);
        const nextLabel = outside && d.getDate() === 1 ? `<span class="calday-nextlabel">${esc(d.toLocaleDateString("en-US", {month: "short"}).toUpperCase())}</span>` : "";
        return `<button type="button" class="calday ${sel ? "calday--sel" : ""} ${isToday ? "calday--today" : ""} ${outside ? "calday--outside" : ""}" data-caldate="${_calKey(d)}" ${outside || past ? "disabled" : ""}>${nextLabel}<span class="calday-num">${d.getDate()}</span><span class="calday-dot"></span></button>`;
      }).join("")}</div>
      <div class="calbook-slots">
        <div class="calbook-slots-head">${esc(selLabel)}</div>
        <div class="slots">${SLOT_TIMES.map((t) => `<button type="button" class="slot ${calTime === t ? "sel" : ""}" data-caltime="${t}">${t}</button>`).join("")}</div>
      </div>
      <div class="grid2">
        <div class="field"><label>Book for lead</label>
          <select class="select" id="cal-lead">${(state.leads || []).map((l) => `<option value="${l.id}">${esc(l.business)}</option>`).join("")}</select></div>
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
  if (open) open.onclick = () => window.open(CAL_LINK, "_blank");
  const confirm = $("#cal-confirm");
  if (confirm) confirm.onclick = async () => {
    if (!calDate || !calTime) { showToast("Pick a day and a time first."); return; }
    const type = CAL_TYPES.find((t) => t.id === (calEvent || "30min")) || CAL_TYPES[1];
    const date = calDate.toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric"});
    const leadId = $("#cal-lead") ? $("#cal-lead").value : (state.leads[0] || {}).id;
    await mutate("bookMeeting", {leadId, date, time: calTime, typeName: type.name});
    showToast("Meeting booked: " + date + " at " + calTime + " (" + type.name + "). Email is queued (Resend pending) — confirm on Cal.com if you want the live invite sent.");
  };
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
function iphoneChrome(inner) {
  return `
  <div class="iphone-wrap">
    <div class="iphone" role="img" aria-label="iPhone showing the Call Log">
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
function renderCallLog() {
  const leads = state.leads || [];
  if (activeConv) {
    const lead = leadById(activeConv);
    const conv = convFor(activeConv) || {messages: []};
    const calls = callsFor(activeConv);
    return iphoneChrome(`
      <div class="iphone-thread-head">
        <button class="iphone-back" id="back-convs" type="button" aria-label="Back to all conversations">‹</button>
        <span class="im-avatar iphone-head-avatar">${esc(initialsFor(lead ? lead.business : "?"))}</span>
        <span class="iphone-head-name"><b>${esc(lead ? lead.business : "Conversation")}</b><span>${esc(lead ? lead.phone : "")} · ${calls.length} call${calls.length === 1 ? "" : "s"} logged</span></span>
      </div>
      <div class="iphone-body"><div class="chat-thread iphone-thread">
        ${calls.map((c) => `<div class="im-sys">Call — ${esc(callLabel(c.outcome))} · ${esc(c.date)} · ${esc(c.time)}</div>`).join("")}
        ${(conv.messages || []).map((m) => `${(m.date || m.time) ? `<div class="im-stamp">${esc(m.date || "")}${m.date && m.time ? " · " : ""}${esc(m.time || "")}</div>` : ""}<div class="msg ${m.from === "me" ? "out" : "in"}">${esc(m.text)}</div>`).join("") || ""}
        ${!calls.length && !(conv.messages || []).length ? `<div class="notice iphone-empty">No calls or messages yet for this lead.</div>` : ""}
      </div></div>
      <div class="chat-input iphone-input">
        <input class="input" id="chat-input" type="text" placeholder="iMessage">
        <button class="chat-send" id="chat-send" type="button" aria-label="Send">↑</button>
      </div>
      <p class="notice iphone-note">Messages you type here are saved to this lead's thread. Outbound texts go through Google Voice — use the TEXT button in RIP MODE to send them.</p>`);
  }
  const searchBar = `
    <div class="iphone-search">
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><circle cx="6.5" cy="6.5" r="5" stroke="#8e8e93" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="#8e8e93" stroke-width="1.6" stroke-linecap="round"/></svg>
      <input id="phone-search" type="text" placeholder="Search" value="${esc(phoneSearch)}" autocomplete="off" aria-label="Search conversations">
      <button type="button" class="iphone-search-clear" id="phone-search-clear" aria-label="Clear search" style="display:${phoneSearch ? "flex" : "none"}">×</button>
    </div>`;
  const rows = leads.map((l) => ({lead: l, act: latestActivityFor(l.id)}))
    .sort((a, b) => (b.act ? b.act.at : 0) - (a.act ? a.act.at : 0));
  const list = `
      <div class="conv-list">${rows.map(({lead: l, act}) => {
        const missed = act && act.kind === "call" && isMissedCall(act.call);
        const preview = !act ? "No calls or messages yet"
          : act.kind === "msg" ? act.msg.text.slice(0, 60)
          : (missed ? "↙ Missed call" : "↗ Outgoing call") + " · " + callLabel(act.call.outcome);
        const at = act ? whenShort(act.kind === "msg" ? act.msg.date : act.call.date, act.kind === "msg" ? act.msg.time : act.call.time) : "";
        const hay = [l.business, l.phone,
          ...callsFor(l.id).map((c) => callLabel(c.outcome) + " " + (isMissedCall(c) ? "missed call" : "outgoing call")),
          ...((convFor(l.id) || {messages: []}).messages || []).map((m) => m.text)].join(" ").toLowerCase();
        return `<button class="conv-item" data-openconv="${l.id}" data-search="${esc(hay)}">
          <span class="im-avatar">${esc(initialsFor(l.business))}</span>
          <span class="im-conv-main"><b>${esc(l.business)}</b><span class="im-preview${missed ? " missed" : ""}">${esc(preview)}</span></span>
          <span class="im-conv-right">${at ? `<span class="im-time">${esc(at)}</span>` : ""}${(l.stage || "New") === "New" ? `<span class="im-unread" title="New lead"></span>` : ""}</span></button>`;
      }).join("")}</div>
      <div class="notice iphone-empty iphone-noresults" style="display:none">No results. Try a different search.</div>`;
  return iphoneChrome(`
      <div class="iphone-title">Messages</div>
      ${searchBar}
      <div class="iphone-body">${list}</div>`);
}
function bindCallLog() {
  const back = $("#back-convs");
  if (back) back.onclick = () => { activeConv = null; render(); };
  document.querySelectorAll("[data-openconv]").forEach((el) => el.onclick = () => { activeConv = el.dataset.openconv; render(); });
  // iOS search: filters the unified list LIVE without a re-render, so the
  // input keeps focus while typing. Matches lead name / phone / message
  // text / call outcome (each row carries them in data-search). The query
  // survives re-renders (thread open/close) via phoneSearch.
  const search = $("#phone-search");
  const applySearch = () => {
    const q = (search ? search.value : phoneSearch).trim().toLowerCase();
    phoneSearch = search ? search.value : "";
    let shown = 0;
    document.querySelectorAll(".iphone-body .conv-item").forEach((el) => {
      const hit = !q || (el.dataset.search || "").includes(q);
      el.style.display = hit ? "" : "none";
      if (hit) shown++;
    });
    const empty = $(".iphone-noresults");
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
    await mutate("addMessage", {leadId: activeConv, text, from: "me"});
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
    "message-taken": ["Message", ""], question: ["Question", ""],
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
  </div>
  <div class="section-title">Recent calls</div>
  ${calls.length ? calls.map((c) => {
    const [label, cls] = aiRepOutcome(c);
    const open = !!aiRepExpanded[c.callSid || c.id];
    const turns = c.turns || [];
    return `<div class="card" style="margin-bottom:12px">
      <div class="kv"><span><b>${esc(c.from || "Unknown caller")}</b><br><span style="color:var(--muted);font-size:13px">${esc(aiRepWhen(c.startedAt))}${c.durationSec ? " · " + fmtElapsed(c.durationSec) : ""}${c.bookingLinkSent ? " · Booking link texted" : ""}</span></span>
      <span class="badge ${cls}">${esc(label)}</span></div>
      <p class="lead-line">${esc(c.summary || "No summary yet.")}</p>
      <button class="btn" data-airep-expand="${esc(c.callSid || c.id)}">${open ? "Hide transcript" : "Show transcript"}</button>
      ${open ? `<div style="margin-top:10px">${turns.length ? turns.map((t) => `<div class="lead-line"><b>${t.role === "user" ? "Caller" : "Receptionist"}:</b> ${esc(t.text)}</div>`).join("") : `<div class="notice">No transcript — the caller hung up before speaking.</div>`}
      ${c.sms ? `<p class="notice">Owner summary SMS: ${c.sms.ok ? "sent" : "not sent (" + esc(c.sms.error || "unknown") + ")"}</p>` : ""}</div>` : ""}
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

/* ---------- CONNECTIONS ---------- */
function renderConnections() {
  const rows = [
    ["Google Voice", "Connected", "Calling + texting from (213) 495-3536. Free. No API — TEXT opens Google Voice; CALL uses Twilio when live, Google Voice until then.", "green"],
    ["Cal.com", "Connected", "5 event types verified. Booking link: " + CAL_LINK, "green"],
    ["Gmail", "Connected via Muse", "Muse connector is connected. This app does not sync Gmail itself.", "green"],
    ["Google Calendar / Meet", "Connected via Muse", "Muse connector is connected. Meet links are created through Calendar events.", "green"],
    ["Resend", "Key pending", "Domain sixfigureblueprintsllc.com is verified in Resend. sfbconnect.com is NOT verified and cannot send. The auto-dialer key still needs to be submitted to Muse — until then, follow-up emails are queued, never claimed as sent.", "amber"],
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
  if (currentTab === "rip") bindRip();
  else if (currentTab === "leads") bindLeads();
  else if (currentTab === "pipeline") bindPipeline();
  else if (currentTab === "calendar") bindCalendar();
  else if (currentTab === "calllog") bindCallLog();
  else if (currentTab === "airep") bindAiRep();
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
      $("#login-hint").textContent = s.hasAccount
        ? "Welcome back — enter your 4-digit passcode."
        : "First time for this username — set a 4-digit passcode and it will be saved for next time.";
    } catch (_) {}
  }
});
/* Typing fix (2026-11-20): the login fields are plain inputs — no readonly,
   no disabled, no timers, nothing that clears what the user types. The old
   readonly-until-focus trick + clearAutofill() timers (300/600/2000ms) are
   what stopped Rome typing: on touch/keyboard the readonly field never
   became editable, and the timers wiped values after load. Autofill is
   discouraged only by autocomplete="off" / "new-password" on the fields and
   the visible "Username, not your email" hint. If Chrome autofills an email
   into Username, submit rejects any "@" with a plain message and the user
   can tap the field and retype — nothing wipes their input.
   Never prefill or store his email anywhere. */
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
