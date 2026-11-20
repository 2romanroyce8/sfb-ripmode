/* RIP MODE standalone — frontend.
   API lives in the Cloudflare router worker (same origin at /ripmode/api when
   served from sixfigureblueprints.com, workers.dev URL when on Vercel).
   Google Voice has NO API: CALL/TEXT open Google Voice with the lead's
   number shown — nothing here auto-dials, auto-plays a script, auto-drops
   a voicemail, or auto-sends an SMS. */
const WORKER_API = "https://sfb-ripmode-router.2romanroyce8.workers.dev/api";
const API_BASE = location.hostname.includes("sixfigureblueprints.com")
  ? "/ripmode/api" : WORKER_API;
const GV_NUMBER = "(213) 495-3536";
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
let calEvent = null, calDay = null, calTime = null;
let activeConv = null;    // lead id for call-log conversation view
let micStream = null, micLevel = 0, micOn = false, muted = false;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtPhone = (p) => p || "";
const todayStr = () => new Date().toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"});
const nowTime = () => new Date().toLocaleTimeString("en-US", {hour:"numeric", minute:"2-digit"});

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

/* ---------- shell: template nav / topbar / account menu ---------- */
const TAB_META = {
  rip: ["RIP MODE", "Dialer — calling from Google Voice (213) 495-3536. Google Voice has no API, so Call opens Google Voice with this lead's number ready — you talk, then log the outcome here."],
  leads: ["Leads", "New leads start in the Pipeline at \"New\"."],
  pipeline: ["Client Pipeline", "5 stages. Move a card with the arrows or the stage picker."],
  calendar: ["Calendar", "Cal.com — pick an event type, a day, and a time. Booking opens your real Cal.com link: https://cal.com/roman-royce/30min"],
  calllog: ["Call Log", "Every call, mirrored as a conversation. Tap a lead to open its chat thread."],
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
  else if (currentTab === "connections") body = renderConnections();
  main.innerHTML = `<div class="page-heading"><div><span class="eyebrow">YOUR WORKSPACE</span><h1>${esc(meta[0])}</h1><p>${esc(sub)}</p></div></div>` + body;
  bindTab();
}

/* ---------- RIP MODE ---------- */
function renderRip() {
  const leads = state.leads || [];
  const lead = leads[ripIndex] || null;
  if (!lead) return `<div class="notice">No leads yet. Add one in the Leads tab.</div>`;
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
        <span class="pill" id="mic-pill">${micOn ? "Mic live" : "Mic off"}</span>
        <div class="mic-bar"><div class="mic-fill" id="mic-fill" style="width:${micLevel}%"></div></div>
        <span class="pill">${muted ? "MUTED" : "LIVE"}</span>
      </div>
      <div class="lead-line" style="font-size:20px;font-weight:700">${esc(lead.phone)}</div>
      <div class="ready-row" style="margin-top:12px">
        <button class="btn btn--primary" id="ready-btn" style="flex:1;padding:12px">READY</button>
        <span class="pill on" id="ready-state">Not ready</span>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="mute-btn" style="flex:1">MUTE</button>
        <button class="btn" id="keypad-btn" style="flex:1">KEYPAD</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn" id="script-btn" style="flex:1">SCRIPT</button>
        <button class="btn" id="dropvm-btn" style="flex:1">DROP VM</button>
      </div>
      <div id="script-box" class="hidden" style="margin-top:10px">
        <div class="field"><label>${esc(script.title)}</label>
        <textarea class="input" readonly rows="5">${esc(script.body)}</textarea></div>
        <p class="notice">Google Voice cannot auto-play a script or auto-drop a voicemail — read it yourself on the call, or record the voicemail in Google Voice.</p>
      </div>
      <div id="keypad-box" class="hidden" style="margin-top:10px">
        <div class="slots">${["1","2","3","4","5","6","7","8","9","*","0","#"].map((k) => `<button class="slot" data-key="${k}">${k}</button>`).join("")}</div>
      </div>
      <button class="big-call" id="call-btn">CALL</button>
      <button class="btn" id="text-btn" style="width:100%;margin-top:8px;padding:13px">TEXT</button>
      <p class="notice">Call opens Google Voice (calls page) — dial ${esc(lead.phone)} from ${esc(GV_NUMBER)}. Text opens Google Voice messages — send from ${esc(GV_NUMBER)}.</p>
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
    const rs = $("#ready-state");
    const on = rs.textContent !== "Ready";
    rs.textContent = on ? "Ready" : "Not ready";
    if (on) await startMic(); else stopMic();
  };
  const muteBtn = $("#mute-btn");
  if (muteBtn) muteBtn.onclick = () => { muted = !muted; muteBtn.textContent = muted ? "UNMUTE" : "MUTE"; render(); };
  const keypadBtn = $("#keypad-btn");
  if (keypadBtn) keypadBtn.onclick = () => $("#keypad-box").classList.toggle("hidden");
  const scriptBtn = $("#script-btn");
  if (scriptBtn) scriptBtn.onclick = () => $("#script-box").classList.toggle("hidden");
  const dropVm = $("#dropvm-btn");
  if (dropVm) dropVm.onclick = () => {
    const s = (state.scripts && state.scripts[0]) || {};
    showToast("Google Voice cannot auto-drop a voicemail. Open Google Voice, call " + lead.phone + ", and record this if it goes to voicemail:\n\n" + (s.vm || "Hi, this is Roman from SFB Connect — we help roofers answer every call with AI and book more jobs. Call me back at " + GV_NUMBER + "."));
    openGoogleVoice("call", lead);
  };
  const callBtn = $("#call-btn");
  if (callBtn) callBtn.onclick = async () => {
    await mutate("logDisposition", {leadId: lead.id, outcome: "dialed", stat: "dials", dialOnly: true});
    openGoogleVoice("call", lead);
  };
  const textBtn = $("#text-btn");
  if (textBtn) textBtn.onclick = () => openGoogleVoice("text", lead);
}

let micRAF = null;
async function startMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({audio: true});
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(micStream);
    const an = ctx.createAnalyser(); an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    micOn = true;
    const pill = $("#mic-pill"); if (pill) pill.textContent = "Mic live";
    const tick = () => {
      if (!micOn) return;
      an.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      micLevel = Math.min(100, Math.round(avg * 1.6));
      const fill = $("#mic-fill"); if (fill) fill.style.width = micLevel + "%";
      micRAF = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    micOn = false;
    const pill = $("#mic-pill"); if (pill) pill.textContent = "Mic blocked — allow microphone access in the browser";
    showToast("Microphone is not available in this browser — check the site's microphone permission. The mic bar will stay at zero.");
  }
}
function stopMic() {
  micOn = false; micLevel = 0;
  if (micRAF) cancelAnimationFrame(micRAF);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  const fill = $("#mic-fill"); if (fill) fill.style.width = "0%";
  const pill = $("#mic-pill"); if (pill) pill.textContent = "Mic off";
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

/* ---------- CALENDAR (Cal.com mirror) ---------- */
const CAL_TYPES = [
  {id: "15min", name: "15 min meeting", desc: "15 minutes · Video call", mins: 15},
  {id: "30min", name: "30 min meeting", desc: "30 minutes · Video call", mins: 30},
  {id: "secret", name: "Secret meeting", desc: "Private · Video call", mins: 30},
  {id: "sfb-discovery-call", name: "Six Figure Blueprints — Discovery Call", desc: "Discovery · Video call", mins: 30},
  {id: "bingled-website-strategy", name: "Bingled — Website Strategy Call", desc: "Website strategy · Video call", mins: 30},
];
const SLOT_TIMES = ["9:00 AM","9:30 AM","10:00 AM","10:30 AM","11:00 AM","11:30 AM","1:00 PM","1:30 PM","2:00 PM","2:30 PM","3:00 PM","3:30 PM","4:00 PM","4:30 PM"];
function nextDays(n) {
  const out = [];
  const d = new Date();
  while (out.length < n) { d.setDate(d.getDate() + 1); out.push(new Date(d)); }
  return out;
}
function renderCalendar() {
  const days = nextDays(14);
  const meetings = state.meetings || [];
  return `
  <div class="cal-layout">
    <div>
      <div class="section-title" style="margin-top:0">Event types</div>
      ${CAL_TYPES.map((t) => `<div class="event-type ${calEvent === t.id ? "sel" : ""}" data-caltype="${t.id}">
        <b>${esc(t.name)}</b><span>${esc(t.desc)}</span></div>`).join("")}
      <div class="card" style="margin-top:16px">
        <div class="section-title" style="margin-top:0">Booked meetings</div>
        ${meetings.length ? meetings.map((m) => {
          const l = leadById(m.leadId);
          return `<div class="kv"><span>${esc(l ? l.business : "Meeting")}<br><span style="color:var(--muted);font-size:12px">${esc(m.date)} · ${esc(m.time)} · ${esc(m.typeName || "")}</span></span><span class="badge green">Booked</span></div>`;
        }).join("") : `<div class="notice">No meetings booked yet.</div>`}
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">${esc((CAL_TYPES.find((t) => t.id === calEvent) || CAL_TYPES[1]).name)}</h3>
      <p class="notice">Times are Eastern. Pick a day, then a time, then confirm — or book directly on Cal.com.</p>
      <div class="days">${days.map((d, i) => `<button class="day ${calDay === i ? "sel" : ""}" data-calday="${i}">
        <span>${d.toLocaleDateString("en-US", {weekday: "short"})}</span><b>${d.getDate()}</b>
        <span>${d.toLocaleDateString("en-US", {month: "short"})}</span></button>`).join("")}</div>
      <div class="slots">${SLOT_TIMES.map((t) => `<button class="slot ${calTime === t ? "sel" : ""}" data-caltime="${t}">${t}</button>`).join("")}</div>
      <div class="grid2">
        <div class="field"><label>Book for lead</label>
          <select class="select" id="cal-lead">${(state.leads || []).map((l) => `<option value="${l.id}">${esc(l.business)}</option>`).join("")}</select></div>
        <div class="field"><label>Your name</label><input class="input" id="cal-name" type="text" value="Roman Royce"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn--primary" id="cal-confirm">Confirm booking</button>
        <button class="btn" id="cal-open">Book on Cal.com ↗</button>
      </div>
      <p class="notice">Confirm saves the meeting here and in the call log. The live Cal.com booking itself happens on cal.com — this app does not hold a Cal.com API key.</p>
    </div>
  </div>`;
}
function bindCalendar() {
  document.querySelectorAll("[data-caltype]").forEach((el) => el.onclick = () => { calEvent = el.dataset.caltype; render(); });
  document.querySelectorAll("[data-calday]").forEach((el) => el.onclick = () => { calDay = Number(el.dataset.calday); render(); });
  document.querySelectorAll("[data-caltime]").forEach((el) => el.onclick = () => { calTime = el.dataset.caltime; render(); });
  const open = $("#cal-open");
  if (open) open.onclick = () => window.open(CAL_LINK, "_blank");
  const confirm = $("#cal-confirm");
  if (confirm) confirm.onclick = async () => {
    if (calDay === null || !calTime) { showToast("Pick a day and a time first."); return; }
    const type = CAL_TYPES.find((t) => t.id === (calEvent || "30min")) || CAL_TYPES[1];
    const day = nextDays(14)[calDay];
    const date = day.toLocaleDateString("en-US", {weekday: "long", month: "long", day: "numeric"});
    const leadId = $("#cal-lead") ? $("#cal-lead").value : (state.leads[0] || {}).id;
    await mutate("bookMeeting", {leadId, date, time: calTime, typeName: type.name});
    showToast("Meeting booked: " + date + " at " + calTime + " (" + type.name + "). Email is queued (Resend pending) — confirm on Cal.com if you want the live invite sent.");
  };
}

/* ---------- CALL LOG + CONVERSATIONS ---------- */
function renderCallLog() {
  const logs = [...(state.callLogs || [])].reverse();
  const leads = state.leads || [];
  if (activeConv) {
    const lead = leadById(activeConv);
    const conv = convFor(activeConv) || {messages: []};
    const calls = callsFor(activeConv);
    return `
    <button class="btn" id="back-convs">← All conversations</button>
    <h2 style="margin-top:14px">${esc(lead ? lead.business : "Conversation")}</h2>
    <p class="sub">${esc(lead ? lead.phone : "")} · ${calls.length} call${calls.length === 1 ? "" : "s"} logged</p>
    <div class="card"><div class="chat-thread">
      ${calls.map((c) => `<div class="msg in">Call — ${esc(c.outcome)}<div class="mmeta">${esc(c.date)} · ${esc(c.time)}</div></div>`).join("")}
      ${(conv.messages || []).map((m) => `<div class="msg ${m.from === "me" ? "out" : "in"}">${esc(m.text)}<div class="mmeta">${esc(m.from === "me" ? "You" : "Lead")} · ${esc(m.date || "")} ${esc(m.time || "")}</div></div>`).join("") || ""}
      ${!calls.length && !(conv.messages || []).length ? `<div class="notice">No calls or messages yet for this lead.</div>` : ""}
    </div>
    <div class="chat-input">
      <input class="input" id="chat-input" type="text" placeholder="Type a message or note for this lead…">
      <button class="btn btn--primary" id="chat-send">Send</button>
    </div>
    <p class="notice">Messages you type here are saved to this lead's thread. Outbound texts go through Google Voice — use the TEXT button in RIP MODE to send them.</p>
    </div>`;
  }
  return `
  <div class="grid2">
    <div>
      <div class="section-title" style="margin-top:0">Calls</div>
      <div class="card">${logs.length ? `<div class="table-wrap"><table><thead><tr><th>Lead</th><th>Outcome</th><th>When</th></tr></thead><tbody>
        ${logs.map((c) => { const l = leadById(c.leadId); return `<tr class="rowlink" data-openconv="${c.leadId}">
          <td><b>${esc(l ? l.business : "—")}</b></td><td>${esc(c.outcome)}</td><td>${esc(c.date)} ${esc(c.time)}</td></tr>`; }).join("")}
      </tbody></table></div>` : `<div class="notice">No calls logged yet. Dial in RIP MODE and log the outcome.</div>`}</div>
    </div>
    <div>
      <div class="section-title" style="margin-top:0">Conversations</div>
      <div class="conv-list">${leads.map((l) => {
        const conv = convFor(l.id);
        const lastMsg = (conv && conv.messages && conv.messages[conv.messages.length - 1]) || null;
        const n = callsFor(l.id).length;
        return `<button class="conv-item" data-openconv="${l.id}">
          <span><b>${esc(l.business)}</b><br><span style="font-size:13px;color:var(--muted)">${lastMsg ? esc(lastMsg.text.slice(0, 60)) : (n ? n + " call" + (n === 1 ? "" : "s") + " logged" : "No calls or messages yet")}</span></span>
          <span class="badge">${esc(l.stage || "New")}</span></button>`;
      }).join("")}</div>
    </div>
  </div>`;
}
function bindCallLog() {
  const back = $("#back-convs");
  if (back) back.onclick = () => { activeConv = null; render(); };
  document.querySelectorAll("[data-openconv]").forEach((el) => el.onclick = () => { activeConv = el.dataset.openconv; render(); });
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

/* ---------- CONNECTIONS ---------- */
function renderConnections() {
  const rows = [
    ["Google Voice", "Connected", "Calling + texting from (213) 495-3536. Free. No API — calls and texts open in Google Voice.", "green"],
    ["Cal.com", "Connected", "5 event types verified. Booking link: " + CAL_LINK, "green"],
    ["Gmail", "Connected via Muse", "Muse connector is connected. This app does not sync Gmail itself.", "green"],
    ["Google Calendar / Meet", "Connected via Muse", "Muse connector is connected. Meet links are created through Calendar events.", "green"],
    ["Resend", "Key pending", "Domain sixfigureblueprintsllc.com is verified in Resend. sfbconnect.com is NOT verified and cannot send. The auto-dialer key still needs to be submitted to Muse — until then, follow-up emails are queued, never claimed as sent.", "amber"],
    ["Twilio", "Not needed", "Dropped. Google Voice handles calling and texting for free — no Twilio upgrade, no Twilio number.", ""],
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
}

/* The Sign In button is a submit button inside #login-form, so the form's
   submit is the single entry point (Enter key included) — no separate
   click/keydown handlers, which would double-fire doLogin. This listener's
   preventDefault() is the ONLY thing stopping a native navigation: the form
   carries no inline onsubmit/action in index.html, deliberately. An inline
   onsubmit handler returning false swallows the submit event before this
   listener runs, so Enter silently did nothing at all (seen live 2026-11-20)
   — never re-add it. A native GET submit to /ripmode?username=... 404s at the
   Cloudflare route level (query-string URLs never reach this worker), so if
   this file ever fails to load, Enter will 404 instead of silently dying —
   that failure is loud, which is the point. */
const loginForm = $("#login-form");
if (loginForm) loginForm.addEventListener("submit", (e) => { e.preventDefault(); doLogin(); });
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
