"use strict";
/*
 * Chuck's Daybook — a small dashboard server for Render.
 * Reads Google Calendar and Gmail (headers only) with one read-only Google
 * authorization, and serves the dashboard at /d/<ACCESS_TOKEN>/.
 * No dependencies: Node 20+ only.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 10000;
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();
/* A value of "pending" (or "-") counts as not set yet, for dashboards that won't save an empty value. */
const env = (k) => { const v = (process.env[k] || "").trim(); return /^(pending|-|none)$/i.test(v) ? "" : v; };
const CLIENT_ID = env("GOOGLE_CLIENT_ID");
const CLIENT_SECRET = env("GOOGLE_CLIENT_SECRET");
const REFRESH_TOKEN = env("GOOGLE_REFRESH_TOKEN");
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
const CALENDAR_IDS = (process.env.CALENDAR_IDS || "primary").split(",").map((s) => s.trim()).filter(Boolean);

const MAIL_DAYS = 7;
const MAIL_MAX = 25;
const CACHE_MS = 60 * 1000;          // reuse Google answers for a minute
const ERROR_BACKOFF_MS = 15 * 1000;  // don't hammer Google after a failure
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/gmail.metadata",
];

if (!/^[A-Za-z0-9_-]{32,200}$/.test(ACCESS_TOKEN)) {
  console.error("ACCESS_TOKEN must be set: 32 or more letters, digits, '-' or '_'. See README.");
  process.exit(1);
}

const PUBLIC_DIR = path.join(__dirname, "public");
const PAGE_HTML = fs.readFileSync(path.join(PUBLIC_DIR, "dashboard.html"));
const APP_JS = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"));

/* ---------- small helpers ---------- */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",          // the access token is in the URL; never leak it
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
};
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function send(res, status, type, body, extra) {
  res.writeHead(status, Object.assign({ "Content-Type": type }, BASE_HEADERS, extra || {}));
  res.end(body);
}
function notFound(res) { send(res, 404, "text/plain; charset=utf-8", "Not found"); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function infoPage(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#F1F4F7;color:#17212C}
main{max-width:640px;margin:0 auto;padding:40px 20px}h1{font-size:1.5rem}
code,textarea{font:14px/1.4 ui-monospace,Menlo,Consolas,monospace}
textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid #D5DCE4;border-radius:6px;background:#fff}
.warn{background:#FBEFD9;color:#8F5600;padding:10px 14px;border-radius:6px}
@media (prefers-color-scheme:dark){body{background:#0F151C;color:#E6ECF2}textarea{background:#18212B;color:#E6ECF2;border-color:#2B3846}.warn{background:#3A2C12;color:#E3A94E}}
</style></head><body><main><h1>${esc(title)}</h1>${bodyHtml}</main></body></html>`;
}

/* ---------- Google access ---------- */
let access = { token: null, exp: 0 };

function gError(message, code) { const e = new Error(message); e.code = code; return e; }

async function accessToken() {
  if (!REFRESH_TOKEN) throw gError("Google isn't authorized yet.", "setup");
  if (access.token && Date.now() < access.exp - 60 * 1000) return access.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN, grant_type: "refresh_token" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = j.error === "invalid_grant" ? "reauth" : r.status >= 500 ? "upstream" : "denied";
    throw gError(j.error_description || j.error || `Token request failed (HTTP ${r.status})`, code);
  }
  access = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return access.token;
}

async function gget(url) {
  const token = await accessToken();
  let r;
  try { r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); }
  catch (e) { throw gError("Couldn't reach Google.", "upstream"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) access = { token: null, exp: 0 };
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
    throw gError(msg, r.status === 401 || r.status === 403 ? "denied" : "upstream");
  }
  return j;
}

/* Only the fields the page uses leave the server. */
function pickEvent(e) {
  const self = (e.attendees || []).find((a) => a && a.self);
  return {
    id: e.id, status: e.status, summary: e.summary, location: e.location,
    description: typeof e.description === "string" ? e.description.slice(0, 4000) : undefined,
    start: e.start, end: e.end, htmlLink: e.htmlLink, eventType: e.eventType,
    attendees: self ? [{ self: true, responseStatus: self.responseStatus }] : undefined,
  };
}

async function fetchCalendar(from, to) {
  const lists = await Promise.all(CALENDAR_IDS.map(async (id) => {
    const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events`);
    u.search = new URLSearchParams({
      timeMin: from.toISOString(), timeMax: to.toISOString(),
      singleEvents: "true", orderBy: "startTime", maxResults: "250",
    }).toString();
    const j = await gget(u);
    return (j.items || []).map(pickEvent);
  }));
  return { events: lists.flat() };
}

/* gmail.metadata scope: headers and labels only, never message bodies. */
async function fetchMail() {
  const u = new URL("https://gmail.googleapis.com/gmail/v1/users/me/threads");
  u.searchParams.append("labelIds", "INBOX");
  u.searchParams.append("labelIds", "UNREAD");
  u.searchParams.set("maxResults", String(MAIL_MAX));
  const list = await gget(u);
  const ids = (list.threads || []).map((t) => t.id);
  const threads = await Promise.all(ids.map((id) => {
    const t = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}`);
    t.searchParams.set("format", "metadata");
    t.searchParams.append("metadataHeaders", "From");
    t.searchParams.append("metadataHeaders", "Subject");
    return gget(t);
  }));
  const cutoff = Date.now() - MAIL_DAYS * 864e5;
  const header = (m, name) => {
    const h = ((m.payload && m.payload.headers) || []).find((x) => String(x.name).toLowerCase() === name);
    return h ? String(h.value) : "";
  };
  const out = [];
  for (const t of threads) {
    const msgs = (t.messages || []).slice().sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
    if (!msgs.length) continue;
    const first = msgs[0], last = msgs[msgs.length - 1];
    const date = Number(last.internalDate);
    if (!(date >= cutoff)) continue;
    out.push({
      id: t.id,
      from: header(last, "from"),
      subject: header(first, "subject"),
      date,
      count: msgs.length,
      important: msgs.some((m) => (m.labelIds || []).includes("IMPORTANT")),
      link: `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(t.id)}`,
    });
  }
  return { threads: out, more: !!list.nextPageToken && out.length === ids.length };
}

/* ---------- caching ---------- */
const cache = new Map();
const DENIED = new Set(["setup", "reauth", "denied"]);

function cached(key, fn) {
  let entry = cache.get(key);
  const now = Date.now();
  if (entry) {
    if (entry.pending) return entry.pending;
    if (entry.value && !entry.error && now - entry.at < CACHE_MS) return Promise.resolve(entry);
    if (entry.error && now - entry.errAt < ERROR_BACKOFF_MS) return Promise.resolve(entry);
  } else {
    entry = { value: null, at: null, error: null, errAt: 0, pending: null };
    cache.set(key, entry);
  }
  entry.pending = fn().then(
    (v) => { entry.value = v; entry.at = Date.now(); entry.error = null; },
    (e) => {
      entry.error = { code: e.code || "upstream", message: String(e.message || e).slice(0, 300) };
      entry.errAt = Date.now();
      if (DENIED.has(entry.error.code)) { entry.value = null; entry.at = null; }
      if (e.code !== "setup") console.warn(`[${key.split("|")[0]}] ${entry.error.code}: ${entry.error.message}`);
    }
  ).then(() => { entry.pending = null; return entry; });
  // drop stale calendar windows from earlier days
  if (cache.size > 20) for (const [k, v] of cache) if (!v.pending && Date.now() - (v.at || v.errAt) > 3600e3) cache.delete(k);
  return entry.pending;
}

function parseWindow(q) {
  const from = new Date(q.get("from") || ""), to = new Date(q.get("to") || "");
  const span = to - from, now = Date.now();
  if (isNaN(from) || isNaN(to) || span < 3600e3 || span > 16 * 864e5 || Math.abs(from - now) > 3 * 864e5) return null;
  return { from, to };
}

async function apiData(res, q) {
  const win = parseWindow(q);
  if (!win) return send(res, 400, "application/json", JSON.stringify({ error: "bad window" }));
  const [cal, mail] = await Promise.all([
    cached(`cal|${win.from.toISOString()}|${win.to.toISOString()}`, () => fetchCalendar(win.from, win.to)),
    cached("mail", fetchMail),
  ]);
  const body = {
    calendar: { events: cal.value ? cal.value.events : null, at: cal.at, error: cal.error },
    mail: { threads: mail.value ? mail.value.threads : null, more: mail.value ? mail.value.more : false, at: mail.at, error: mail.error },
  };
  send(res, 200, "application/json; charset=utf-8", JSON.stringify(body));
}

/* ---------- one-time Google authorization ---------- */
const states = new Map();

function startSetup(res) {
  if (!CLIENT_ID || !CLIENT_SECRET || !PUBLIC_URL) {
    return send(res, 500, "text/html; charset=utf-8", infoPage("Setup isn't ready",
      "<p>Set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and <code>PUBLIC_URL</code> in Render, wait for the redeploy, then open this link again.</p>"));
  }
  for (const [s, exp] of states) if (exp < Date.now()) states.delete(s);
  const state = crypto.randomBytes(24).toString("hex");
  states.set(state, Date.now() + 10 * 60 * 1000);
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: `${PUBLIC_URL}/oauth/callback`, response_type: "code",
    scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", state,
  }).toString();
  res.writeHead(302, Object.assign({ Location: u.toString() }, BASE_HEADERS));
  res.end();
}

async function finishSetup(res, q) {
  const state = q.get("state") || "";
  const exp = states.get(state);
  states.delete(state);
  if (!exp || exp < Date.now()) return notFound(res);
  if (q.get("error")) {
    return send(res, 400, "text/html; charset=utf-8", infoPage("Google didn't authorize the dashboard",
      `<p>Google answered: <code>${esc(q.get("error"))}</code>. Open the setup link again to retry.</p>`));
  }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: q.get("code") || "", client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: `${PUBLIC_URL}/oauth/callback`, grant_type: "authorization_code",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) {
    return send(res, 400, "text/html; charset=utf-8", infoPage("Authorization didn't finish",
      `<p>Google answered: <code>${esc(j.error_description || j.error || "no refresh token returned")}</code>. Open the setup link again to retry.</p>`));
  }
  const granted = String(j.scope || "").split(/\s+/);
  const missing = SCOPES.filter((s) => !granted.includes(s));
  const warn = missing.length
    ? `<p class="warn">Not granted: ${missing.map((s) => `<code>${esc(s.split("/").pop())}</code>`).join(", ")}. That part of the dashboard will stay empty. To fix it, open the setup link again and tick every box on Google's screen.</p>`
    : "";
  send(res, 200, "text/html; charset=utf-8", infoPage("Almost done",
    `${warn}<p>Copy this value into Render as the environment variable <code>GOOGLE_REFRESH_TOKEN</code>, then save. Render redeploys and the dashboard starts loading your data.</p>
<textarea rows="4" readonly>${esc(j.refresh_token)}</textarea>
<p>Treat it like a password: it lets this server read your calendar and email headers. This page isn't stored anywhere; close it when you're done.</p>`));
}

/* ---------- routing ---------- */
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "Method not allowed");
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    if (p === "/healthz") return send(res, 200, "text/plain", "ok");
    if (p === "/oauth/callback") return await finishSetup(res, url.searchParams);
    if (p === "/robots.txt") return send(res, 200, "text/plain", "User-agent: *\nDisallow: /\n");

    const m = /^\/d\/([A-Za-z0-9_-]{1,200})(\/.*)?$/.exec(p);
    if (!m || !safeEqual(m[1], ACCESS_TOKEN)) return notFound(res);
    const sub = m[2];
    if (sub === undefined) {
      res.writeHead(301, Object.assign({ Location: `/d/${m[1]}/${url.search}` }, BASE_HEADERS));
      return res.end();
    }
    if (sub === "/") return send(res, 200, "text/html; charset=utf-8", PAGE_HTML, { "Content-Security-Policy": PAGE_CSP });
    if (sub === "/app.js") return send(res, 200, "text/javascript; charset=utf-8", APP_JS);
    if (sub === "/api/data") return await apiData(res, url.searchParams);
    if (sub === "/setup") return startSetup(res);
    return notFound(res);
  } catch (e) {
    console.error("request failed:", e && e.message);
    if (!res.headersSent) send(res, 500, "text/plain", "Server error");
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Daybook listening on ${PORT}. Google ${REFRESH_TOKEN ? "authorized" : "not authorized yet"}; calendars: ${CALENDAR_IDS.join(", ")}`);
});
