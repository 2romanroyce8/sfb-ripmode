// sfb-ripmode-router — Cloudflare Worker.
// 1) Proxies sixfigureblueprints.com/ripmode* to the Vercel app (BillMe pattern).
// 2) Serves the app's API at /ripmode/api/* with shared state in KV (ripmode-data).
// Passcodes are stored ONLY as salted PBKDF2-SHA256 hashes (100,000 iterations — the Cloudflare Workers PBKDF2 cap).
// Login is username + exactly 4 digits. The JSON field is still named
// "password" on the wire; its value is the 4-digit passcode.
// Google Voice has NO API: TEXT still opens Google Voice, and CALL falls
// back to Google Voice until Twilio is live. In-dashboard calling is
// Twilio Voice: this worker NEVER dials itself — it only mints short-lived
// Voice access tokens (POST /api/voice/token) from env vars, and the
// browser's Twilio Voice SDK places the call. No Twilio secret value may
// ever appear in this file, in the repo, or in any response — only the
// env var NAMES (TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID,
// TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID), set in the Cloudflare
// dashboard (Worker -> Settings -> Variables).
// The personal forwarding number must NEVER appear in this file or any response.

const UPSTREAM = "https://sfb-ripmode.vercel.app";
const ALLOWED_USERS = ["romanroyce", "loganwells", "braylengarrett"];
const SESSION_DAYS = 30;

const enc = new TextEncoder();
const dec = new TextDecoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}
const err = (message, status = 400) => json({ error: message }, status);

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}
// ---- Twilio Voice access tokens (in-dashboard calling) ----
// A Twilio Access Token is a JWT: header.payload signed with HMAC-SHA256
// using the API Key SECRET. Only the API Key SID signs (iss) and the
// Account SID is the subject (sub); the grant lets the browser place
// outbound calls through the TwiML App named by TWIML_APP_SID.
// Tokens live 1 hour; the client fetches a fresh one per call.
function b64url(bytes) {
  let s = b64(bytes);
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function mintVoiceToken(env, username) {
  const accountSid = env.TWILIO_ACCOUNT_SID || "";
  const apiKeySid = env.TWILIO_API_KEY_SID || "";
  const apiKeySecret = env.TWILIO_API_KEY_SECRET || "";
  const twimlAppSid = env.TWILIO_TWIML_APP_SID || "";
  if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) return null;
  const now = Math.floor(Date.now() / 1000);
  // Random suffix: two tokens minted in the same second (e.g. a retry right
  // after a failed dial re-mints immediately) must not be byte-identical.
  const rand = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: apiKeySid + "-" + now + "-" + rand,
    iss: apiKeySid,
    sub: accountSid,
    exp: now + 3600,
    grants: {
      identity: username,
      voice: { outgoing: { application_sid: twimlAppSid }, incoming: { allow: true } },
    },
  };
  const part = b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(apiKeySecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(part));
  return part + "." + b64url(sig);
}

async function hashPasscode(passcode, saltB64) {
  const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(passcode), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key, 256
  );
  return { salt: b64(salt), hash: b64(bits) };
}

function seedState() {
  return {
    leads: [
      { id: "lead-jax", business: "Jax Roofing", niche: "Roofing", city: "Jacksonville", phone: "(904) 621-6005", owner: "", email: "", stage: "New" },
      { id: "lead-performance", business: "Performance Roofing", niche: "Roofing", city: "Oviedo", phone: "(407) 210-1503", owner: "", email: "info@performanceroofingusa.com", stage: "New" },
    ],
    callLogs: [],
    conversations: [],
    // Pinned team group chat (2026-11-21): ONE shared thread for the three
    // team accounts. Starts EMPTY — never seeded with fake messages.
    // Messages carry by (username) + text + date/time; the client maps
    // the username to a display name. Only the three team accounts can
    // read/write (every /api/state call is session-checked).
    teamChat: { messages: [] },
    assignments: [],
    announcements: [],
    emailTemplates: [],
    emailLog: [],
    meetings: [],
    followUps: [],
    sessionStats: { dials: 0, connected: 0, noAnswer: 0, voicemail: 0, meetings: 0, perHour: 0 },
    scripts: [
      {
        title: "Roofer pitch",
        body: "Hi, this is Roman from SFB Connect — we build AI receptionists for roofers that answer every call, book jobs, and follow up automatically. Got 60 seconds for me to show you what that looks like for your company?",
        vm: "Hi, this is Roman from SFB Connect — we help roofers answer every call with AI and book more jobs. Call me back at (213) 495-3536.",
      },
    ],
    campaigns: [{ id: "camp-roofer-pilot", name: "Roofer Pilot", status: "active" }],
  };
}
async function getState(env) {
  const raw = await env.RIPMODE_KV.get("state");
  if (raw) return JSON.parse(raw);
  const s = seedState();
  await env.RIPMODE_KV.put("state", JSON.stringify(s));
  return s;
}
async function saveState(env, s) {
  await env.RIPMODE_KV.put("state", JSON.stringify(s));
}

async function requireSession(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const h = await sha256Hex(m[1]);
  const raw = await env.RIPMODE_KV.get("sessions:" + h);
  if (!raw) return null;
  const s = JSON.parse(raw);
  if (Date.now() > s.exp) { await env.RIPMODE_KV.delete("sessions:" + h); return null; }
  return s.username;
}
async function newSession(env, username) {
  const token = crypto.randomUUID() + "-" + hex(crypto.getRandomValues(new Uint8Array(16)));
  const h = await sha256Hex(token);
  await env.RIPMODE_KV.put("sessions:" + h, JSON.stringify({
    username,
    exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  }));
  return token;
}

// ---- BillMe sync (inlined from ~/workspace/billme-sync/worker/billme-sync.js) ----
// POST /api/billme/sync — server-to-server, shared secret BILLME_SYNC_SECRET.
// Helpers json/err/enc/hex/sha256Hex are NOT duplicated here: router.js
// already defines them (json() also carries the CORS headers).
const MAX_BILLME_EVENTS = 500;





// Compare the presented secret against the stored one by comparing SHA-256
// digests (no timing leak on the raw value, and the raw secret never leaves
// the comparison).
async function checkSyncSecret(env, request) {
  const secret = env.BILLME_SYNC_SECRET || "";
  if (!secret) return false;
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  const [a, b] = await Promise.all([sha256Hex(m[1]), sha256Hex(secret)]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normEmail(e) {
  return String(e || "").trim().toLowerCase();
}
function normName(n) {
  return String(n || "").trim().toLowerCase();
}

// Find the lead this invoice belongs to: email first, then business name.
// Returns null when there is no identifier to match on.
function findLead(state, email, business) {
  const e = normEmail(email);
  const b = normName(business);
  if (e) {
    const byEmail = (state.leads || []).find((l) => normEmail(l.email) === e);
    if (byEmail) return byEmail;
  }
  if (b) {
    const byName = (state.leads || []).find((l) => normName(l.business) === b);
    if (byName) return byName;
  }
  return null;
}

function money(amountCents, currency) {
  const n = (amountCents || 0) / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: (currency || "usd").toUpperCase(),
    }).format(n);
  } catch (_) {
    return "$" + n.toFixed(2);
  }
}

// The upsert itself — pure over the state object so the harness can test it
// without a worker. Returns {createdLead, stage, duplicate, matched}.
function applyBillmeSync(state, body) {
  const stripeEventId = String(body.stripeEventId || "");
  const email = normEmail(body.email);
  const business = String(body.business || "").trim().slice(0, 120);
  const status = body.status === "paid" ? "paid" : (body.status === "sent" ? "sent" : "open");
  const amountCents = Number(body.amountCents) || 0;
  const currency = String(body.currency || "usd").toLowerCase();
  const invoiceNumber = String(body.invoiceNumber || body.invoiceId || "").slice(0, 60);
  const invoiceId = String(body.invoiceId || "").slice(0, 60);
  const paidAt = String(body.paidAt || "");
  const paymentIntentId = String(body.paymentIntentId || "").slice(0, 60);

  if (!state.billmeEvents) state.billmeEvents = {};
  if (stripeEventId && state.billmeEvents[stripeEventId]) {
    return { createdLead: false, stage: null, duplicate: true, matched: true };
  }

  let lead = findLead(state, email, business);
  let createdLead = false;
  if (!lead) {
    if (!email && !business) return { createdLead: false, stage: null, duplicate: false, matched: false };
    lead = {
      id: "lead-" + crypto.randomUUID().slice(0, 8),
      business: business || email,
      niche: "",
      city: "",
      phone: String(body.phone || "").slice(0, 40),
      owner: String(body.owner || "").slice(0, 80),
      email,
      stage: "New",
      source: "billme",
    };
    state.leads.push(lead);
    createdLead = true;
  }

  // Fill in contact facts the sync knows that the lead is missing.
  if (email && !lead.email) lead.email = email;
  if (business && (!lead.business || lead.business === lead.email)) lead.business = business;
  if (body.phone && !lead.phone) lead.phone = String(body.phone).slice(0, 40);
  if (body.owner && !lead.owner) lead.owner = String(body.owner).slice(0, 80);
  if (!lead.source) lead.source = "billme";

  const invoice = {
    id: invoiceId,
    number: invoiceNumber,
    status,
    amountCents,
    currency,
    paidAt: status === "paid" ? paidAt : "",
    paymentIntentId: status === "paid" ? paymentIntentId : "",
    stripeEventId,
  };
  lead.invoice = invoice;
  if (!Array.isArray(lead.invoiceHistory)) lead.invoiceHistory = [];
  // One history entry per distinct invoice + status (replays collapse).
  const histKey = invoiceId + "|" + status;
  if (!lead.invoiceHistory.some((h) => (h.id || "") + "|" + (h.status || "") === histKey)) {
    lead.invoiceHistory.push({ ...invoice, at: new Date().toISOString() });
  }
  if (!Array.isArray(lead.billmeEventIds)) lead.billmeEventIds = [];
  if (stripeEventId) lead.billmeEventIds.push(stripeEventId);

  // Stage rule: a paid invoice is Won (payment truth). A sent/open invoice
  // moves a New lead to Proposal — the deal is live, not yet paid.
  if (status === "paid") lead.stage = "Won";
  else if (lead.stage === "New") lead.stage = "Proposal";

  if (stripeEventId) {
    state.billmeEvents[stripeEventId] = { invoiceId, at: new Date().toISOString() };
    const keys = Object.keys(state.billmeEvents);
    if (keys.length > MAX_BILLME_EVENTS) {
      for (const k of keys.slice(0, keys.length - MAX_BILLME_EVENTS)) delete state.billmeEvents[k];
    }
  }
  return { createdLead, stage: lead.stage, duplicate: false, matched: true };
}

// Route handler: POST /api/billme/sync.
// getState/saveState are injected (the router's own functions in production,
// a mock KV in the harness). Returns a Response.
async function handleBillmeSync(request, env, getState, saveState) {
  if (!(await checkSyncSecret(env, request))) {
    return err("Invalid sync secret.", 401);
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return err("No invoice data was sent.");
  }
  const state = await getState(env);
  if (!Array.isArray(state.leads)) state.leads = [];
  const result = applyBillmeSync(state, body);
  if (result.matched && !result.duplicate) await saveState(env, state);
  return json({
    ok: true,
    matched: result.matched,
    duplicate: result.duplicate,
    createdLead: result.createdLead,
    stage: result.stage,
    invoice: result.matched && !result.duplicate
      ? { number: String(body.invoiceNumber || body.invoiceId || ""), status: body.status }
      : undefined,
  });
}

// UI helpers the dashboard uses to render invoice state on a Pipeline card.
function invoiceLine(lead) {
  const inv = lead && lead.invoice;
  if (!inv) return "";
  const label = inv.status === "paid" ? "Paid" : (inv.status === "sent" ? "Sent" : "Open");
  const when = inv.status === "paid" && inv.paidAt
    ? " · " + new Date(inv.paidAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "";
  return "Invoice " + (inv.number || inv.id || "") + " · " + label + " " + money(inv.amountCents, inv.currency) + when;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  let path = url.pathname;
  if (path.startsWith("/ripmode")) path = path.slice("/ripmode".length);
  else if (path.startsWith("/salesteam")) path = path.slice("/salesteam".length);
  if (request.method === "OPTIONS") return json({ ok: true });

  // ---- auth ----
  if (path === "/api/auth/check" && request.method === "POST") {
    const { username } = await request.json().catch(() => ({}));
    const u = String(username || "").toLowerCase();
    if (!ALLOWED_USERS.includes(u)) return json({ allowed: false, hasAccount: false });
    const raw = await env.RIPMODE_KV.get("users:" + u);
    return json({ allowed: true, hasAccount: !!raw });
  }
  if (path === "/api/auth/signup" && request.method === "POST") {
    const { username, password } = await request.json().catch(() => ({}));
    const u = String(username || "").toLowerCase();
    if (!ALLOWED_USERS.includes(u)) return err("Wrong username or password", 401);
    if (!/^\d{4}$/.test(password || "")) return err("Enter a 4-digit passcode.");
    if (await env.RIPMODE_KV.get("users:" + u)) return err("That username already has an account — sign in instead.");
    const { salt, hash } = await hashPasscode(password);
    await env.RIPMODE_KV.put("users:" + u, JSON.stringify({ salt, hash }));
    const token = await newSession(env, u);
    return json({ token, username: u });
  }
  if (path === "/api/auth/login" && request.method === "POST") {
    const { username, password } = await request.json().catch(() => ({}));
    const u = String(username || "").toLowerCase();
    if (!ALLOWED_USERS.includes(u)) return err("Wrong username or password", 401);
    if (!/^\d{4}$/.test(password || "")) return err("Wrong username or password", 401);
    const raw = await env.RIPMODE_KV.get("users:" + u);
    if (!raw) return err("Wrong username or password", 401);
    const { salt, hash } = JSON.parse(raw);
    const attempt = await hashPasscode(password, salt);
    if (attempt.hash !== hash) return err("Wrong username or password", 401);
    const token = await newSession(env, u);
    return json({ token, username: u });
  }
  if (path === "/api/auth/status" && request.method === "POST") {
    const username = await requireSession(env, request);
    if (!username) return err("Not signed in.", 401);
    return json({ username });
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    const auth = request.headers.get("Authorization") || "";
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (m) await env.RIPMODE_KV.delete("sessions:" + await sha256Hex(m[1]));
    return json({ ok: true });
  }

  // ---- BillMe sync (server-to-server; shared secret, no user session) ----
  // Stripe (via the sfb-billme-bridge worker) posts invoice events here.
  // The shared secret is held as a SECRET env var BILLME_SYNC_SECRET on
  // this worker — it is never in code, never in a client bundle, never in
  // any response. See ~/workspace/billme-sync/README.md.
  if (path === "/api/billme/sync" && request.method === "POST") {
    return handleBillmeSync(request, env, getState, saveState);
  }

  // ---- state (session required) ----
  const username = await requireSession(env, request);
  if (!username) return err("Not signed in.", 401);

  // ---- Twilio Voice (session required) ----
  // GET /api/voice/status — is in-dashboard calling configured? No token
  // is minted here, so the client can check cheaply on load.
  if (path === "/api/voice/status" && request.method === "GET") {
    const configured = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET && env.TWILIO_TWIML_APP_SID);
    return json({ configured });
  }
  // POST /api/voice/token — mint a 1-hour Voice access token for this user.
  // 503 (not 500) when Twilio is not configured yet: the client falls back
  // to Google Voice and says so plainly. Never a fake dial.
  if (path === "/api/voice/token" && request.method === "POST") {
    const token = await mintVoiceToken(env, username);
    if (!token) return err("Calling not set up yet — Twilio is not configured on the server.", 503);
    return json({ token });
  }
  // GET /api/email/status — is Resend wired? Never returns the key.
  if (path === "/api/email/status" && request.method === "GET") {
    return json({ ok: true, connected: !!env.RESEND_API_KEY });
  }

  // ---- AI receptionist (session required; config saves are owner-only) ----
  // The dashboard's AI Rep tab talks to the sfb-receptionist worker through
  // these proxy endpoints. The receptionist WORKER_KEY is held as a SECRET
  // env var (RECEPTIONIST_KEY) on THIS worker — it is never sent to the
  // browser, never in a URL the user can see, and never in any response.
  // The proxy adds it server-side only.
  const RECEPTIONIST_BASE = "https://sfb-receptionist.2romanroyce8.workers.dev";
  const AIREP_NUMBER = "+12393499491";
  const AIREP_ENGINE = "ConversationRelay + Workers AI (Llama 3.3 70B)";
  const AIREP_COST_PER_MIN = 0.0785;
  const OUTBOUND_COST_PER_MIN = 0.018; // Twilio outbound $0.014 + browser leg $0.004 — estimate only
  async function receptionistFetch(rpath, method, rbody) {
    const key = env.RECEPTIONIST_KEY || "";
    if (!key) return { ok: false, status: 503, data: { error: "AI receptionist is not connected yet — the dashboard key is missing." } };
    const sep = rpath.includes("?") ? "&" : "?";
    try {
      const res = await fetch(RECEPTIONIST_BASE + rpath + sep + "key=" + encodeURIComponent(key), {
        method: method || "GET",
        headers: { "Content-Type": "application/json" },
        body: rbody ? JSON.stringify(rbody) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 502, data: { error: "AI receptionist is not reachable right now." } };
    }
  }
  if (path === "/api/airep/status" && request.method === "GET") {
    const [callsRes, cfgRes] = await Promise.all([
      receptionistFetch("/calls"), receptionistFetch("/api/config"),
    ]);
    if (!callsRes.ok) return err(callsRes.data.error || "AI receptionist is not reachable right now.", callsRes.status === 503 ? 503 : 502);
    const calls = callsRes.data.calls || [];
    const todayET = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
    const callsToday = calls.filter((c) => {
      try { return new Date(c.startedAt).toLocaleDateString("en-US", { timeZone: "America/New_York" }) === todayET; }
      catch (_) { return false; }
    }).length;
    return json({
      ok: true, live: true, number: AIREP_NUMBER, engine: AIREP_ENGINE,
      costPerMin: AIREP_COST_PER_MIN, callsToday, callsTotal: calls.length,
      businessName: (cfgRes.ok && cfgRes.data.config && cfgRes.data.config.businessName) || "Six Figure Blueprints",
    });
  }
  if (path === "/api/airep/calls" && request.method === "GET") {
    const r = await receptionistFetch("/calls");
    if (!r.ok) return err(r.data.error || "AI receptionist is not reachable right now.", r.status === 503 ? 503 : 502);
    return json({ ok: true, calls: r.data.calls || [], count: r.data.count || 0 });
  }
  if (path === "/api/airep/config" && request.method === "GET") {
    const r = await receptionistFetch("/api/config");
    if (!r.ok) return err(r.data.error || "AI receptionist is not reachable right now.", r.status === 503 ? 503 : 502);
    return json({ ok: true, config: r.data.config || {}, isCustom: !!r.data.isCustom });
  }
  if (path === "/api/airep/config" && request.method === "POST") {
    if (username !== "romanroyce") return err("Only the owner can change the AI receptionist.", 403);
    const patch = await request.json().catch(() => null);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return err("No settings were sent.");
    const r = await receptionistFetch("/api/config", "POST", patch);
    if (!r.ok) return err(r.data.error || "Could not save the receptionist settings.", r.status);
    return json({ ok: true, config: r.data.config || {}, isCustom: true });
  }

  // ---- Daily caps (2026-11-21) ----
  // Team caps + per-person caps, both enforced HERE — the worker is the
  // authority, so a rep cannot bypass a cap from the browser console.
  // Counters reset at midnight America/New_York because the ET date is
  // the KV key — no cron. Team: caps:YYYY-MM-DD. Per user:
  // caps:YYYY-MM-DD:<username> (username from requireSession, never
  // from the browser). Limits: caps:limits.
  // A dial / talk minute / email is refused when EITHER the user's own
  // cap OR the team cap is hit, and the refusal names which one.
  // Texts are sent by the receptionist worker as the system (no user
  // attribution), so this worker only READS the team text count via the
  // proxy below — it never invents per-person text numbers.
  const CAPS_DEFAULTS = {
    team: { dials: 500, talkMin: 150, sms: 100, emails: 100, maxCallSec: 225 },
    users: {
      romanroyce: { dials: 167, talkMin: 50, sms: 33, emails: 33 },
      loganwells: { dials: 167, talkMin: 50, sms: 33, emails: 33 },
      braylengarrett: { dials: 167, talkMin: 50, sms: 33, emails: 33 },
    },
  };
  const CAPS_BOUNDS = { dials: [0, 5000], talkMin: [0, 1440], sms: [0, 1000], emails: [0, 1000], maxCallSec: [60, 3600] };
  const etDateStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  function capsMergeLimits(stored) {
    const out = JSON.parse(JSON.stringify(CAPS_DEFAULTS));
    if (!stored || typeof stored !== "object") return out;
    // Old flat shape ({dials, talkMin, ...} at top level) merges into team.
    const teamSrc = stored.team && typeof stored.team === "object" ? stored.team : stored;
    for (const k of ["dials", "talkMin", "sms", "emails", "maxCallSec"]) {
      if (Number.isInteger(teamSrc[k])) out.team[k] = teamSrc[k];
    }
    if (stored.users && typeof stored.users === "object") {
      for (const u of ALLOWED_USERS) {
        const us = stored.users[u];
        if (!us || typeof us !== "object") continue;
        for (const k of ["dials", "talkMin", "sms", "emails"]) {
          if (Number.isInteger(us[k])) out.users[u][k] = us[k];
        }
      }
    }
    return out;
  }
  async function getCapsLimits(env) {
    const raw = await env.RIPMODE_KV.get("caps:limits");
    if (!raw) return capsMergeLimits(null);
    let stored = null;
    try { stored = JSON.parse(raw); } catch (_) { stored = null; }
    return capsMergeLimits(stored);
  }
  function capsBlank() { return { dials: 0, talkSec: 0, emails: 0 }; }
  async function getCapsCounters(env, date, user) {
    const key = "caps:" + date + (user ? ":" + user : "");
    const raw = await env.RIPMODE_KV.get(key);
    if (!raw) return capsBlank();
    let c;
    try { c = JSON.parse(raw); } catch (_) { return capsBlank(); }
    return {
      dials: Math.max(0, Number(c.dials) || 0),
      talkSec: Math.max(0, Number(c.talkSec) || 0),
      emails: Math.max(0, Number(c.emails) || 0),
    };
  }
  async function saveCapsCounters(env, date, user, c) {
    await env.RIPMODE_KV.put("caps:" + date + (user ? ":" + user : ""), JSON.stringify(c));
  }
  // SMS count lives on the receptionist worker (it sends the texts).
  // Defensive: the sibling agent is adding GET /api/caps there — until
  // it is live, return null with a note and NEVER fail the whole response.
  async function capsSmsFromReceptionist() {
    const r = await receptionistFetch("/api/caps");
    if (r.ok && r.data && typeof r.data === "object") {
      const d = r.data;
      const n = d.used && typeof d.used.sms === "number" ? d.used.sms
        : typeof d.sms === "number" ? d.sms
        : typeof d.used === "number" ? d.used
        : typeof d.count === "number" ? d.count : null;
      if (typeof n === "number") return { sms: n, note: "" };
    }
    return { sms: null, note: "Text count is not available yet — the receptionist cap endpoint is not live." };
  }
  async function capsReceptionistToday() {
    const r = await receptionistFetch("/calls");
    if (!r.ok) return { minutes: null, costEst: null };
    const calls = r.data.calls || [];
    const todayET = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
    let sec = 0;
    for (const c of calls) {
      try {
        if (new Date(c.startedAt).toLocaleDateString("en-US", { timeZone: "America/New_York" }) === todayET) sec += Number(c.durationSec) || 0;
      } catch (_) {}
    }
    const minutes = Math.round((sec / 60) * 10) / 10;
    return { minutes, costEst: Math.round(minutes * AIREP_COST_PER_MIN * 100) / 100 };
  }
  function capsTalkMsg(who, usedSec, limitMin) {
    const usedMin = Math.floor(usedSec / 60);
    return who === "team"
      ? "Team daily talk limit reached — " + usedMin + "/" + limitMin + " minutes. Resets midnight ET."
      : "Your daily talk limit reached — " + usedMin + "/" + limitMin + " minutes. Resets midnight ET.";
  }

  if (path === "/api/caps" && request.method === "GET") {
    const limits = await getCapsLimits(env);
    const date = etDateStr();
    const [team, mine, smsRes, recep, userCounters] = await Promise.all([
      getCapsCounters(env, date),
      getCapsCounters(env, date, username),
      capsSmsFromReceptionist(),
      capsReceptionistToday(),
      Promise.all(ALLOWED_USERS.map((u) => getCapsCounters(env, date, u))),
    ]);
    const teamUsed = { dials: team.dials, talkSec: team.talkSec, sms: smsRes.sms, emails: team.emails };
    const mineUsed = { dials: mine.dials, talkSec: mine.talkSec, sms: null, emails: mine.emails };
    const users = {};
    ALLOWED_USERS.forEach((u, i) => {
      const c = userCounters[i] || { dials: 0, talkSec: 0, emails: 0 };
      users[u] = { dials: c.dials, talkSec: c.talkSec, sms: null, emails: c.emails };
    });
    return json({
      ok: true,
      date,
      limits,
      myLimits: limits.users[username] || limits.users.romanroyce,
      used: teamUsed, // team totals (back-compat with the first caps shape)
      team: teamUsed,
      mine: mineUsed,
      users,
      smsNote: smsRes.note,
      receptionistMinutes: recep.minutes,
      receptionistCostEst: recep.costEst,
      // Cost estimates, labelled as estimates — never presented as bills.
      outboundTalkCostEst: Math.round(((team.talkSec / 60) * OUTBOUND_COST_PER_MIN) * 100) / 100,
    });
  }
  // Check-and-reserve one dial, team + per-user. Called by the client
  // BEFORE ensureTwilioDevice in startTwilioCallTo, for BOTH lead calls
  // and owner test calls (a test call costs the same). KV has no
  // transaction, so the check + two puts are sequential — as atomic as
  // KV allows. A retry after a stale-token failure must NOT reserve
  // twice: the client only calls this on the first attempt.
  if (path === "/api/caps/dial" && request.method === "POST") {
    const limits = await getCapsLimits(env);
    const date = etDateStr();
    const team = await getCapsCounters(env, date);
    const mine = await getCapsCounters(env, date, username);
    const tLim = limits.team;
    const uLim = limits.users[username] || limits.users.romanroyce;
    if (team.dials >= tLim.dials) return err("Team daily limit reached — " + team.dials + "/" + tLim.dials + " dials. Resets midnight ET.", 403);
    if (mine.dials >= uLim.dials) return err("Your daily limit reached — " + mine.dials + "/" + uLim.dials + " dials. Resets midnight ET.", 403);
    if (team.talkSec >= tLim.talkMin * 60) return err(capsTalkMsg("team", team.talkSec, tLim.talkMin), 403);
    if (mine.talkSec >= uLim.talkMin * 60) return err(capsTalkMsg("mine", mine.talkSec, uLim.talkMin), 403);
    team.dials += 1;
    mine.dials += 1;
    await saveCapsCounters(env, date, null, team);
    await saveCapsCounters(env, date, username, mine);
    return json({
      ok: true, allowed: true,
      remaining: {
        team: { dials: tLim.dials - team.dials, talkMin: Math.max(0, tLim.talkMin - Math.floor(team.talkSec / 60)) },
        mine: { dials: uLim.dials - mine.dials, talkMin: Math.max(0, uLim.talkMin - Math.floor(mine.talkSec / 60)) },
      },
    });
  }
  // Add connected seconds to BOTH team and user talk. Only time after
  // the 'accept' event counts — the client only sends seconds measured
  // from accept, and ringing seconds are never sent. Clamped 0..3600.
  if (path === "/api/caps/call-end" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    let sec = Number(body && body.connectedSec);
    if (!Number.isFinite(sec)) sec = 0;
    sec = Math.max(0, Math.min(3600, Math.round(sec)));
    const date = etDateStr();
    const team = await getCapsCounters(env, date);
    const mine = await getCapsCounters(env, date, username);
    if (sec > 0) {
      team.talkSec += sec;
      mine.talkSec += sec;
      await saveCapsCounters(env, date, null, team);
      await saveCapsCounters(env, date, username, mine);
    }
    return json({ ok: true, addedSec: sec, teamTalkSec: team.talkSec, myTalkSec: mine.talkSec });
  }
  // Email counter + the server-side check the future Resend path will
  // call. No email path is live yet (Resend wiring is still blocked),
  // so nothing calls "record" today — the counter and the check exist
  // so the future path cannot send past the cap. Both layers bind.
  if (path === "/api/caps/email" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const action = body && body.action;
    const limits = await getCapsLimits(env);
    const date = etDateStr();
    const team = await getCapsCounters(env, date);
    const mine = await getCapsCounters(env, date, username);
    const tLim = limits.team;
    const uLim = limits.users[username] || limits.users.romanroyce;
    const blockedReason = () => {
      if (team.emails >= tLim.emails) return "Team daily limit reached — " + team.emails + "/" + tLim.emails + " emails. Resets midnight ET.";
      if (mine.emails >= uLim.emails) return "Your daily limit reached — " + mine.emails + "/" + uLim.emails + " emails. Resets midnight ET.";
      return "";
    };
    if (action === "check") {
      const reason = blockedReason();
      return json({
        ok: true, allowed: !reason, reason,
        remaining: { team: Math.max(0, tLim.emails - team.emails), mine: Math.max(0, uLim.emails - mine.emails) },
      });
    }
    if (action === "record") {
      let count = Number(body.count);
      if (!Number.isFinite(count)) count = 1;
      count = Math.max(1, Math.min(100, Math.round(count)));
      const reason = blockedReason();
      if (reason) return err(reason, 403);
      team.emails += count;
      mine.emails += count;
      await saveCapsCounters(env, date, null, team);
      await saveCapsCounters(env, date, username, mine);
      return json({ ok: true, count, teamEmails: team.emails, myEmails: mine.emails });
    }
    return err("Unknown action — use check or record.");
  }
  // Owner-only limit changes. Patch shape: { team: {...}, users: { <user>: {...} } }
  // — a flat { dials, talkMin, sms, emails, maxCallSec } patch is also
  // accepted and means the team limits. maxCallSec is team-wide only.
  // Takes effect immediately (the next GET /api/caps serves it). The
  // team sms value is forwarded to the receptionist best-effort: if its
  // endpoint is not live yet, the local save still succeeds and the
  // response says so as a warning, not a failure.
  if (path === "/api/caps/limits" && request.method === "POST") {
    if (username !== "romanroyce") return err("Only the owner can change the daily limits.", 403);
    const patch = await request.json().catch(() => null);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return err("No limits were sent.");
    const limits = await getCapsLimits(env);
    const validate = (src, allowedKeys) => {
      for (const k of Object.keys(src || {})) {
        if (!allowedKeys.includes(k)) return "Unknown limit: " + k + ".";
        const [lo, hi] = CAPS_BOUNDS[k];
        if (!Number.isInteger(src[k]) || src[k] < lo || src[k] > hi) {
          return k + " must be a whole number from " + lo + " to " + hi + ".";
        }
      }
      return "";
    };
    const teamPatch = (patch.team && typeof patch.team === "object")
      ? patch.team
      : Object.fromEntries(Object.entries(patch).filter(([k]) => k !== "users"));
    const teamErr = validate(teamPatch, ["dials", "talkMin", "sms", "emails", "maxCallSec"]);
    if (teamErr) return err(teamErr);
    if (patch.users && typeof patch.users === "object") {
      for (const u of Object.keys(patch.users)) {
        if (!ALLOWED_USERS.includes(u)) return err("Unknown user in limits patch: " + u + ".");
        if (!patch.users[u] || typeof patch.users[u] !== "object") return err("Limits for " + u + " must be an object.");
        const e = validate(patch.users[u], ["dials", "talkMin", "sms", "emails"]);
        if (e) return err(u + ": " + e);
      }
    }
    Object.assign(limits.team, teamPatch);
    if (patch.users) {
      for (const u of Object.keys(patch.users)) Object.assign(limits.users[u], patch.users[u]);
    }
    await env.RIPMODE_KV.put("caps:limits", JSON.stringify(limits));
    let receptionistSmsSync = false;
    try {
      const r = await receptionistFetch("/api/caps", "POST", { sms: limits.team.sms });
      receptionistSmsSync = !!r.ok;
    } catch (_) { receptionistSmsSync = false; }
    return json({ ok: true, limits, receptionistSmsSync });
  }

  if (path === "/api/state" && request.method === "GET") {
    return json(await getState(env));
  }
  if (path === "/api/state" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const s = await getState(env);
    // Defensive init (2026-11-21): states saved before the new keys
    // existed get them as empty arrays instead of crashing on .push.
    if (!Array.isArray(s.assignments)) s.assignments = [];
    if (!Array.isArray(s.announcements)) s.announcements = [];
    if (!Array.isArray(s.emailTemplates)) s.emailTemplates = [];
    if (!Array.isArray(s.emailLog)) s.emailLog = [];
    if (!s.teamChat || !Array.isArray(s.teamChat.messages)) s.teamChat = { messages: [] };
    const now = new Date();
    const date = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const op = body.op;

    if (op === "addLead") {
      s.leads.push({
        id: "lead-" + crypto.randomUUID().slice(0, 8),
        business: String(body.business || "").slice(0, 120),
        phone: String(body.phone || "").slice(0, 40),
        niche: String(body.niche || "").slice(0, 80),
        owner: String(body.owner || "").slice(0, 80),
        email: String(body.email || "").slice(0, 120),
        city: String(body.city || "").slice(0, 80),
        stage: "New",
      });
    } else if (op === "deleteLead") {
      // Delete safeguard (2026-11-21): deleting a lead must be confirmed
      // AND must never delete history. Rome deleted Jax + Performance
      // himself thinking they were fake, and the old delete wiped their
      // callLogs/conversations too — 3 real Dialed calls were lost for
      // good. So: (1) the server refuses any delete without
      // confirmed:true — a stray click or console call cannot delete
      // silently; (2) ONLY the lead record is removed. callLogs,
      // conversations, meetings, followUps and sessionStats are untouched,
      // and the Call Log / Analytics render orphaned entries by the
      // business name stored on the entry itself (see logDisposition /
      // addMessage below).
      if (body.confirmed !== true) return err("Delete not confirmed — send confirmed:true to delete a lead.", 400);
      s.leads = s.leads.filter((l) => l.id !== body.leadId);
    } else if (op === "setStage") {
      const l = s.leads.find((x) => x.id === body.leadId);
      if (l && ["New", "In conversation", "Proposal", "Won", "Lost"].includes(body.stage)) l.stage = body.stage;
    } else if (op === "logDisposition") {
      // The business name is stored on the entry itself (delete safeguard,
      // 2026-11-21): if the lead is later deleted, its history stays
      // readable in the Call Log / Analytics instead of going blank.
      const l0 = s.leads.find((x) => x.id === body.leadId);
      s.callLogs.push({ id: "call-" + crypto.randomUUID().slice(0, 8), leadId: body.leadId, leadName: l0 ? l0.business : "", outcome: String(body.outcome || ""), date, time, by: username });
      if (body.stat) s.sessionStats[body.stat] = (s.sessionStats[body.stat] || 0) + 1;
      if (body.stat && body.stat !== "dials") s.sessionStats.dials = (s.sessionStats.dials || 0) + 1;
    } else if (op === "bookMeeting") {
      const l = s.leads.find((x) => x.id === body.leadId);
      s.meetings.push({
        id: "mtg-" + crypto.randomUUID().slice(0, 8),
        leadId: body.leadId, leadName: l ? l.business : "",
        date: body.date || date, time: body.time || time,
        typeName: body.typeName || "30 min meeting", by: username,
      });
      s.sessionStats.meetings = (s.sessionStats.meetings || 0) + 1;
      if (l && l.stage === "New") l.stage = "In conversation";
      s.callLogs.push({ id: "call-" + crypto.randomUUID().slice(0, 8), leadId: body.leadId, leadName: l ? l.business : "", outcome: "meeting_booked", date, time, by: username });
      s.followUps.push({ id: "fu-" + crypto.randomUUID().slice(0, 8), leadId: body.leadId, kind: "email", status: "queued", note: "Meeting confirmation email — queued until Resend is wired.", date, time });
      s.followUps.push({ id: "fu-" + crypto.randomUUID().slice(0, 8), leadId: body.leadId, kind: "sms", status: "pending", note: "Meeting confirmation SMS — send via Google Voice (not sent automatically).", date, time });
    } else if (op === "addMessage") {
      // leadName stored on the conversation (delete safeguard, 2026-11-21)
      // so a deleted lead's thread stays readable; backfilled for older
      // conversations that were created before this field existed.
      const lMsg = s.leads.find((x) => x.id === body.leadId);
      let conv = s.conversations.find((c) => c.leadId === body.leadId);
      if (!conv) { conv = { leadId: body.leadId, leadName: lMsg ? lMsg.business : "", messages: [] }; s.conversations.push(conv); }
      if (!conv.leadName && lMsg) conv.leadName = lMsg.business;
      conv.messages.push({ id: "msg-" + crypto.randomUUID().slice(0, 8), from: body.from === "lead" ? "lead" : "me", text: String(body.text || "").slice(0, 2000), date, time });
    } else if (op === "sendTeamMessage") {
      // Pinned "SFB SALES TEAM" group chat (2026-11-21): one shared thread
      // in state.teamChat. Session-checked (only the three team accounts
      // reach this op at all). Empty text is refused; messages are capped
      // at 2000 chars like lead messages. No seeding, no fake history.
      const text = String(body.text || "").trim().slice(0, 2000);
      if (!text) return err("Type a message first.");
      if (!s.teamChat || !Array.isArray(s.teamChat.messages)) s.teamChat = { messages: [] };
      s.teamChat.messages.push({ id: "tm-" + crypto.randomUUID().slice(0, 8), by: username, text, date, time });
    } else if (op === "addAssignment") {
      if (username !== "romanroyce") return err("Only the owner can create assignments.", 403);
      const title = String(body.title || "").trim().slice(0, 120);
      if (!title) return err("Enter an assignment title.", 400);
      const assignee = String(body.assignee || "");
      if (!ALLOWED_USERS.includes(assignee)) return err("Assignee must be a team member.", 400);
      const dueDate = String(body.dueDate || "");
      if (dueDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return err("Due date must be YYYY-MM-DD.", 400);
      s.assignments.push({ id: "asg-" + crypto.randomUUID().slice(0, 8), title, details: String(body.details || "").slice(0, 500), assignee, assignedBy: username, dueDate: dueDate || "", status: "todo", createdAt: date + " " + time, completedAt: null });
    } else if (op === "updateAssignment") {
      if (username !== "romanroyce") return err("Only the owner can edit assignments.", 403);
      const a = s.assignments.find((x) => x.id === body.id);
      if (!a) return err("Assignment not found.", 400);
      if (body.title !== undefined) {
        const title = String(body.title || "").trim().slice(0, 120);
        if (!title) return err("Enter an assignment title.", 400);
        a.title = title;
      }
      if (body.details !== undefined) a.details = String(body.details || "").slice(0, 500);
      if (body.assignee !== undefined) {
        const assignee = String(body.assignee || "");
        if (!ALLOWED_USERS.includes(assignee)) return err("Assignee must be a team member.", 400);
        a.assignee = assignee;
      }
      if (body.dueDate !== undefined) {
        const dueDate = String(body.dueDate || "");
        if (dueDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return err("Due date must be YYYY-MM-DD.", 400);
        a.dueDate = dueDate || "";
      }
    } else if (op === "setAssignmentStatus") {
      const a = s.assignments.find((x) => x.id === body.id);
      if (!a) return err("Assignment not found.", 400);
      if (username !== "romanroyce" && username !== a.assignee) return err("Only the owner or the assignee can change this assignment.", 403);
      if (!["todo", "doing", "done"].includes(body.status)) return err("Status must be todo, doing, or done.", 400);
      a.status = body.status;
      a.completedAt = body.status === "done" ? date + " " + time : null;
    } else if (op === "deleteAssignment") {
      if (username !== "romanroyce") return err("Only the owner can delete assignments.", 403);
      if (body.confirmed !== true) return err("Delete not confirmed — send confirmed:true.", 400);
      s.assignments = s.assignments.filter((x) => x.id !== body.id);
    } else if (op === "addAnnouncement") {
      if (username !== "romanroyce") return err("Only the owner can post announcements.", 403);
      const title = String(body.title || "").trim();
      if (!title) return err("Enter an announcement title.", 400);
      if (title.length > 120) return err("Title must be 120 characters or fewer.", 400);
      const annBody = String(body.body || "").trim();
      if (!annBody) return err("Enter an announcement body.", 400);
      if (annBody.length > 2000) return err("Announcement must be 2000 characters or fewer.", 400);
      s.announcements.push({ id: "ann-" + crypto.randomUUID().slice(0, 8), title, body: annBody, author: username, pinned: body.pinned === true, createdAt: date + " " + time });
    } else if (op === "setAnnouncementPin") {
      if (username !== "romanroyce") return err("Only the owner can pin announcements.", 403);
      const a = s.announcements.find((x) => x.id === body.id);
      if (!a) return err("Announcement not found.", 400);
      a.pinned = body.pinned === true;
    } else if (op === "deleteAnnouncement") {
      if (username !== "romanroyce") return err("Only the owner can delete announcements.", 403);
      if (body.confirmed !== true) return err("Delete not confirmed — send confirmed:true.", 400);
      s.announcements = s.announcements.filter((x) => x.id !== body.id);
    } else if (op === "saveEmailTemplate") {
      if (username !== "romanroyce") return err("Only the owner can save email templates.", 403);
      const name = String(body.name || "").trim();
      if (!name) return err("Enter a template name.", 400);
      if (name.length > 80) return err("Template name must be 80 characters or fewer.", 400);
      const subject = String(body.subject || "").trim();
      if (!subject) return err("Enter an email subject.", 400);
      if (subject.length > 200) return err("Subject must be 200 characters or fewer.", 400);
      const tplBody = String(body.body || "").trim();
      if (!tplBody) return err("Enter an email body.", 400);
      if (tplBody.length > 5000) return err("Email body must be 5000 characters or fewer.", 400);
      s.emailTemplates.push({ id: "tpl-" + crypto.randomUUID().slice(0, 8), name, subject, body: tplBody, createdBy: username, createdAt: date + " " + time });
    } else if (op === "updateEmailTemplate") {
      if (username !== "romanroyce") return err("Only the owner can edit email templates.", 403);
      const t = s.emailTemplates.find((x) => x.id === body.id);
      if (!t) return err("Email template not found.", 400);
      if (body.name !== undefined) {
        const name = String(body.name || "").trim();
        if (!name) return err("Enter a template name.", 400);
        if (name.length > 80) return err("Template name must be 80 characters or fewer.", 400);
        t.name = name;
      }
      if (body.subject !== undefined) {
        const subject = String(body.subject || "").trim();
        if (!subject) return err("Enter an email subject.", 400);
        if (subject.length > 200) return err("Subject must be 200 characters or fewer.", 400);
        t.subject = subject;
      }
      if (body.body !== undefined) {
        const tplBody = String(body.body || "").trim();
        if (!tplBody) return err("Enter an email body.", 400);
        if (tplBody.length > 5000) return err("Email body must be 5000 characters or fewer.", 400);
        t.body = tplBody;
      }
    } else if (op === "deleteEmailTemplate") {
      if (username !== "romanroyce") return err("Only the owner can delete email templates.", 403);
      if (body.confirmed !== true) return err("Delete not confirmed — send confirmed:true.", 400);
      s.emailTemplates = s.emailTemplates.filter((x) => x.id !== body.id);
    } else if (op === "sendEmail") {
      // (a) Validate lead + fields before touching caps or Resend.
      const lead = (s.leads || []).find((x) => x.id === body.leadId);
      if (!lead) return err("Lead not found.", 400);
      const to = String(body.to || "").trim();
      if (!/^\S+@\S+\.\S+$/.test(to)) return err("Enter a valid email address.", 400);
      const emailSubject = String(body.subject || "");
      if (!emailSubject.trim() || emailSubject.length > 200) return err("Enter a subject of 200 characters or fewer.", 400);
      const emailBody = String(body.body || "");
      if (!emailBody.trim() || emailBody.length > 10000) return err("Enter a body of 10000 characters or fewer.", 400);
      const logBase = { id: "eml-" + crypto.randomUUID().slice(0, 8), leadId: body.leadId, leadName: lead.business, to, subject: emailSubject, by: username, date, time };
      // (b) Caps — same reason strings as POST /api/caps/email.
      // NOTE: caps keys use the ET YYYY-MM-DD date (etDateStr), not the
      // display date ("Nov 21, 2026") used in state records.
      const capsDate = etDateStr();
      const limits = await getCapsLimits(env);
      const team = await getCapsCounters(env, capsDate);
      const mine = await getCapsCounters(env, capsDate, username);
      const tLim = limits.team;
      const uLim = limits.users[username] || limits.users.romanroyce;
      let blockedReason = "";
      if (team.emails >= tLim.emails) blockedReason = "Team daily limit reached — " + team.emails + "/" + tLim.emails + " emails. Resets midnight ET.";
      else if (mine.emails >= uLim.emails) blockedReason = "Your daily limit reached — " + mine.emails + "/" + uLim.emails + " emails. Resets midnight ET.";
      if (blockedReason) {
        s.emailLog.push({ ...logBase, status: "blocked", error: blockedReason });
        await saveState(env, s);
        return err(blockedReason, 403);
      }
      // (c) Resend not wired — log + 503, never attempt a fetch.
      if (!env.RESEND_API_KEY) {
        const msg = "Email is not connected yet — the Resend key still needs to be connected.";
        s.emailLog.push({ ...logBase, status: "blocked", error: msg });
        await saveState(env, s);
        return err(msg, 503);
      }
      // (d) Send via Resend. globalThis.fetch so the harness can stub it.
      const escHtml = (t) => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      let res = null;
      let resData = null;
      let netErr = "";
      try {
        res = await globalThis.fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "Roman Royce <roman@sixfigureblueprintsllc.com>", to: [to], subject: emailSubject, text: emailBody, html: escHtml(emailBody).replace(/\n/g, "<br>") }),
        });
        resData = await res.json().catch(() => null);
      } catch (e) {
        netErr = (e && e.message) || "Network error";
      }
      // (e) 2xx: count the email, log sent, mark queued email follow-ups.
      if (res && res.ok) {
        const resendId = (resData && resData.id) ? String(resData.id) : "";
        team.emails += 1;
        mine.emails += 1;
        await saveCapsCounters(env, capsDate, null, team);
        await saveCapsCounters(env, capsDate, username, mine);
        s.emailLog.push({ ...logBase, status: "sent", resendId });
        for (const fu of (s.followUps || [])) {
          if (fu.leadId === body.leadId && fu.kind === "email" && fu.status === "queued") fu.status = "sent";
        }
      } else {
        // (f) Non-2xx or network error: log failed, 502, caps untouched.
        let errorText = "";
        if (res && resData && resData.error && resData.error.message) errorText = String(resData.error.message);
        else if (res && resData && resData.message) errorText = String(resData.message);
        else if (res) errorText = "Resend error (HTTP " + res.status + ")";
        else errorText = netErr || "Network error";
        errorText = errorText.slice(0, 300);
        s.emailLog.push({ ...logBase, status: "failed", error: errorText });
        await saveState(env, s);
        return err("Email failed — " + errorText, 502);
      }
    } else {
      return err("Unknown operation.");
    }
    await saveState(env, s);
    return json(s);
  }
  return err("Not found.", 404);
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    // Prefix-aware (2026-11-21): the app lives at /ripmode AND /salesteam.
    // NO redirect — /salesteam routes do not exist on the zone yet, so a
    // redirect would 404. Both prefixes serve identically.
    const p = incoming.pathname;
    const isApi = p === "/ripmode/api" || p.startsWith("/ripmode/api/") ||
      p === "/salesteam/api" || p.startsWith("/salesteam/api/") ||
      p === "/api" || p.startsWith("/api/");
    if (isApi) return handleApi(request, env);

    // Proxy everything else to the Vercel app (same pattern as sfb-billme-router).
    const upstream = new URL(incoming.pathname + incoming.search, UPSTREAM);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", "https");
    const response = await fetch(new Request(upstream, request), { headers, redirect: "manual" });
    const location = response.headers.get("location");
    if (!location || !location.startsWith(upstream.origin + "/")) return response;
    const forwarded = new Response(response.body, response);
    forwarded.headers.set("location", incoming.origin + location.slice(upstream.origin.length));
    return forwarded;
  },
};
