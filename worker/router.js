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
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: apiKeySid + "-" + now,
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
