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
    if (!ALLOWED_USERS.includes(u)) return err("That username is not on the team.");
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
    if (!ALLOWED_USERS.includes(u)) return err("Invalid username or passcode.", 401);
    if (!/^\d{4}$/.test(password || "")) return err("Invalid username or passcode.", 401);
    const raw = await env.RIPMODE_KV.get("users:" + u);
    if (!raw) return err("Invalid username or passcode.", 401);
    const { salt, hash } = JSON.parse(raw);
    const attempt = await hashPasscode(password, salt);
    if (attempt.hash !== hash) return err("Invalid username or passcode.", 401);
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

  if (path === "/api/state" && request.method === "GET") {
    return json(await getState(env));
  }
  if (path === "/api/state" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const s = await getState(env);
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
      s.leads = s.leads.filter((l) => l.id !== body.leadId);
      s.callLogs = s.callLogs.filter((c) => c.leadId !== body.leadId);
      s.conversations = s.conversations.filter((c) => c.leadId !== body.leadId);
    } else if (op === "setStage") {
      const l = s.leads.find((x) => x.id === body.leadId);
      if (l && ["New", "In conversation", "Proposal", "Won", "Lost"].includes(body.stage)) l.stage = body.stage;
    } else if (op === "logDisposition") {
      s.callLogs.push({ id: "call-" + crypto.randomUUID().slice(0, 8), leadId: body.leadId, outcome: String(body.outcome || ""), date, time, by: username });
      if (body.stat) s.sessionStats[body.stat] = (s.sessionStats[body.stat] || 0) + 1;
      if (body.stat && body.stat !== "dials") s.sessionStats.dials = (s.sessionStats.dials || 0) + 1;
    } else if (op === "bookMeeting") {
      const l = s.leads.find((x) => x.id === body.leadId);
      s.meetings.push({
        id: "mtg-" + crypto.randomUUID().slice(0, 8),
        leadId: body.leadId,
        date: body.date || date, time: body.time || time,
        typeName: body.typeName || "30 min meeting", by: username,
      });
      s.sessionStats.meetings = (s.sessionStats.meetings || 0) + 1;
      if (l && l.stage === "New") l.stage = "In conversation";
      s.callLogs.push({ id: "call-" + crypto.randomUUID().slice(0, 8), leadId: body.leadId, outcome: "meeting_booked", date, time, by: username });
      s.followUps.push({ id: "fu-" + crypto.randomUUID().slice(0, 8), leadId: body.leadId, kind: "email", status: "queued", note: "Meeting confirmation email — queued until Resend is wired.", date, time });
      s.followUps.push({ id: "fu-" + crypto.randomUUID().slice(0, 8), leadId: body.leadId, kind: "sms", status: "pending", note: "Meeting confirmation SMS — send via Google Voice (not sent automatically).", date, time });
    } else if (op === "addMessage") {
      let conv = s.conversations.find((c) => c.leadId === body.leadId);
      if (!conv) { conv = { leadId: body.leadId, messages: [] }; s.conversations.push(conv); }
      conv.messages.push({ id: "msg-" + crypto.randomUUID().slice(0, 8), from: body.from === "lead" ? "lead" : "me", text: String(body.text || "").slice(0, 2000), date, time });
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
    const isApi = incoming.pathname === "/ripmode/api" || incoming.pathname.startsWith("/ripmode/api/") ||
      incoming.pathname === "/api" || incoming.pathname.startsWith("/api/");
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
