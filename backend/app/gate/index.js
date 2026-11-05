// The gate. Installed as the FIRST middleware: nothing is served, and no other handler runs, until a request has
//   1. come from a United Kingdom address (or carries a valid owner-issued invite pass), and
//   2. carries a valid session cookie (email code / link, or Google / Facebook when configured).
// Public exceptions, by exact match only: GET /api/health, the sign-in pages and /auth/*, and /api/worker/* with a bearer token
// (the GPU worker authenticates itself; the platform must verify that token).
// Also public, anywhere: GET/HEAD of the exact PUBLIC_FILES paths (the sign-in page's fonts, hero loop, poster and
// thumbnails, and terms.html as the privacy policy), and a meta-only link card (no site content) for known link
// unfurlers asking for a page, so a pasted link shows a preview.
import crypto from "node:crypto";
import express from "express";
import { clientIp, loadBundledGeo } from "./geo.js";
import { codeMessage, mailAvailable, maskEmail, sendMail } from "./mail.js";
import { authorizeRequest, completeLogin, configuredProviders } from "./oauth.js";
import { blockedPage, cardPage, linkPage, messagePage, PUBLIC_FILES, signinPage } from "./pages.js";
import { openAuthStore } from "./store.js";

const SESSION_MS = 14 * 24 * 3600 * 1000;
const LOGIN_MS = 15 * 60 * 1000;
const PASS_MS = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const hmac = (secret, v) => crypto.createHmac("sha256", secret).update(v).digest("hex");
const equal = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const list = (v) => String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function gateConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  const secret = env.SESSION_SECRET || (production ? "" : crypto.randomBytes(32).toString("hex"));
  if (secret.length < 32) throw new Error("SESSION_SECRET (at least 32 characters) is required in production");
  const baseUrl = String(env.BASE_URL || "").replace(/\/$/, "");
  if (production && !baseUrl.startsWith("https://")) throw new Error("BASE_URL (https) is required in production");
  const geoMode = env.GEO_MODE || "uk";
  // "off" opens the site to every country (owner decision for judging); anything else is a typo, so refuse to boot
  if (production && !["uk", "off"].includes(geoMode)) throw new Error("GEO_MODE must be uk or off in production");
  return {
    production, secret, baseUrl, geoMode,
    secureCookies: production || env.COOKIE_SECURE === "1",
    owners: list(env.OWNER_EMAILS),
    allowed: list(env.ALLOWED_EMAILS), // empty = anyone may sign up
    bypassHashes: list(env.GEO_BYPASS_CODES), // sha256 hex of owner-issued invite codes; empty = no bypass exists
  };
}

function parseCookies(header) {
  const jar = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return jar;
}

function limiter() {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.at < now) hits.delete(k); }, 10 * 60 * 1000).unref();
  return (key, max, windowMs) => {
    const now = Date.now();
    const e = hits.get(key);
    if (!e || e.at < now) { hits.set(key, { n: 1, at: now + windowMs }); return false; }
    e.n += 1;
    return e.n > max;
  };
}

const wantsHtml = (req) => (req.method === "GET" || req.method === "HEAD") && String(req.headers.accept || "").includes("text/html");
const safeNext = (n) => (typeof n === "string" && /^\/(?![/\\])[^\s]*$/.test(n) && !/^\/(auth|signin|geo)\b/.test(n) ? n : "/");
// Pre-auth public files: exact, case-sensitive path match (req.path is not decoded, so no encoded variant matches).
const PUBLIC = new Set(PUBLIC_FILES);
const publicFile = (req) => (req.method === "GET" || req.method === "HEAD") && PUBLIC.has(req.path);
const UNFURLER = /\b(Slackbot(-LinkExpanding)?|Slack-ImgProxy|Discordbot|Twitterbot|facebookexternalhit|Facebot|LinkedInBot|WhatsApp|TelegramBot|SkypeUriPreview|Iframely|Embedly|redditbot|Mastodon|Bluesky)\b/i;
const unfurl = (req) => (req.method === "GET" || req.method === "HEAD") && (req.path === "/" || /^\/[\w-]+\.html$/.test(req.path)) && UNFURLER.test(String(req.headers["user-agent"] || ""));

export function installGate(app, { dataDir, env = process.env, geo, fetchImpl = fetch, mail = sendMail } = {}) {
  const cfg = gateConfig(env);
  if (!dataDir) throw new Error("installGate needs dataDir");
  const geoTable = cfg.geoMode === "off" ? null : (geo || loadBundledGeo());
  const store = openAuthStore(dataDir);
  store.purge();
  setInterval(() => store.purge(), HOUR).unref();
  // A provider is live only with its credentials AND an absolute BASE_URL: the redirect URI must match the one registered.
  const oauthCreds = /^https?:\/\//.test(cfg.baseUrl) ? configuredProviders(env) : {};
  const providers = { ...Object.fromEntries(Object.keys(oauthCreds).map((k) => [k, true])), email: mailAvailable(env) };
  const pendingStates = new Map(); // state -> expiry. Server-side and single-use, so a captured cookie + state cannot be replayed.
  const limited = limiter();
  const sidName = cfg.secureCookies ? "__Host-sid" : "sid";
  const log = (event, extra = "") => console.log(`[gate] ${event}${extra ? ` ${extra}` : ""}`);

  const originOf = (req) => cfg.baseUrl || `${req.headers["x-forwarded-proto"] === "http" ? "http" : cfg.production ? "https" : "http"}://${req.headers.host}`;
  const cookie = (name, value, maxAgeMs) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${cfg.secureCookies ? "; Secure" : ""}`;
  const clear = (name) => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cfg.secureCookies ? "; Secure" : ""}`;
  const noStore = (res) => res.setHeader("Cache-Control", "no-store");

  // Browsers always label cross-site requests. Anything cross-site or from another origin is refused.
  const sameOrigin = (req) => {
    const site = req.headers["sec-fetch-site"];
    if (site && !["same-origin", "none"].includes(site)) return false;
    const origin = req.headers.origin;
    if (origin) { try { return new URL(origin).host === new URL(originOf(req)).host; } catch { return false; } }
    return true;
  };
  const hasBrowserProof = (req) => Boolean(req.headers.origin || req.headers["sec-fetch-site"]);

  const roleFor = (email) => (cfg.owners.includes(email) ? "owner" : "user");
  const mayJoin = (email) => cfg.owners.includes(email) || !cfg.allowed.length || cfg.allowed.includes(email);

  function startSession(res, email, name, provider) {
    const user = store.upsertUser({ email, name, provider, role: roleFor(email) });
    const sid = crypto.randomBytes(32).toString("base64url");
    store.createSession(user.id, SESSION_MS, sha256(sid));
    res.append("Set-Cookie", cookie(sidName, sid, SESSION_MS));
    log("signin", `${provider} ${maskEmail(email)} role=${user.role}`);
    return user;
  }

  const passValid = (req) => {
    const raw = parseCookies(req.headers.cookie).geo_pass;
    if (!raw) return false;
    const [exp, sig] = raw.split(".");
    return Number(exp) > Date.now() && sig && equal(sig, hmac(cfg.secret, `geo|${exp}`));
  };

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Vary", "Cookie");
    if (cfg.production) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
  });

  // ── 1. geography ────────────────────────────────────────────────────────────────────────
  app.use(async (req, res, next) => {
    req.clientIp = clientIp(req, env);
    if (req.method === "GET" && req.path === "/api/health") return next();
    if (req.path.startsWith("/api/worker/") && /^Bearer\s+\S+/.test(String(req.headers.authorization || ""))) return next();
    if (publicFile(req)) return next();
    if (unfurl(req)) { noStore(res); return res.type("html").send(cardPage({ origin: originOf(req) })); }
    if (!geoTable) return next();
    if (req.clientIp && geoTable.isUk(req.clientIp)) return next();
    if (passValid(req)) return next();
    if (req.method === "POST" && req.path === "/geo/code" && cfg.bypassHashes.length) {
      return express.json({ limit: "1kb" })(req, res, () => {
        const key = `geo:${req.clientIp?.value ?? "?"}`;
        if (limited(key, 10, HOUR)) return res.status(429).json({ error: "too_many_attempts" });
        const given = sha256(String(req.body?.code || "").trim().toLowerCase());
        if (!cfg.bypassHashes.some((h) => equal(h, given))) return res.status(403).json({ error: "bad_code" });
        const exp = Date.now() + PASS_MS;
        res.append("Set-Cookie", cookie("geo_pass", `${exp}.${hmac(cfg.secret, `geo|${exp}`)}`, PASS_MS));
        log("geo-pass issued");
        return res.json({ ok: true });
      });
    }
    noStore(res);
    log("geo-block", `${req.method} ${req.path.slice(0, 40)} ip=${req.clientIp ? `v${req.clientIp.family}` : "none"}`);
    if (wantsHtml(req)) return res.status(403).type("html").send(blockedPage({ canInvite: cfg.bypassHashes.length > 0 }));
    return res.status(403).json({ error: "uk_only" });
  });

  // ── 2. sign-in surface (reachable without a session, after the geography check) ─────────────────
  const auth = express.Router();
  const json = express.json({ limit: "4kb" });
  const form = express.urlencoded({ extended: false, limit: "4kb" });
  auth.use(["/signin", "/auth", "/geo"], (req, res, next) => {
    noStore(res);
    if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return res.status(403).json({ error: "cross_site" });
    next();
  });

  auth.get("/signin", (req, res) => {
    const next = safeNext(req.query.next);
    const sid = parseCookies(req.headers.cookie)[sidName];
    if (sid && store.sessionUser(sha256(sid))) return res.redirect(302, next);
    res.type("html").send(signinPage({ next, providers, origin: originOf(req), ukOnly: cfg.geoMode === "uk" }));
  });
  auth.get("/auth/providers", (req, res) => res.json(providers));

  auth.post("/auth/start", json, async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: "bad_email" });
    if (!providers.email) return res.status(503).json({ error: "email_unavailable" });
    if (limited(`start-ip:${req.clientIp?.value ?? "?"}`, 10, HOUR) || limited(`start-mail:${email}`, 5, HOUR)) return res.status(429).json({ error: "too_many_attempts" });
    if (mayJoin(email)) {
      const code = crypto.randomInt(0, 1e8).toString().padStart(8, "0");
      const token = crypto.randomBytes(32).toString("base64url");
      store.createLogin({ email, codeHash: hmac(cfg.secret, `code|${email}|${code}`), tokenHash: hmac(cfg.secret, `token|${token}`), ttlMs: LOGIN_MS });
      const link = `${cfg.baseUrl || originOf(req)}/auth/link?token=${token}`;
      try {
        await mail({ to: email, subject: `Your sign-in code: ${code}`, ...codeMessage({ code, link }) }, env);
      } catch (error) { log("mail-error", error.message); }
    } else log("signup-refused", maskEmail(email));
    res.json({ ok: true }); // identical either way: the form never reveals who may sign in
  });

  auth.post("/auth/verify", json, (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").replace(/\D/g, "");
    if (limited(`verify-ip:${req.clientIp?.value ?? "?"}`, 30, HOUR) || limited(`verify-mail:${email}`, 15, HOUR)) return res.status(429).json({ error: "too_many_attempts" });
    const ok = code.length === 8 && store.consumeCode(email, hmac(cfg.secret, `code|${email}|${code}`));
    if (!ok) return res.status(401).json({ error: "bad_code" });
    startSession(res, email, null, "email");
    res.json({ ok: true, next: safeNext(req.body?.next) });
  });

  auth.get("/auth/link", (req, res) => res.type("html").send(linkPage({ token: String(req.query.token || ""), next: safeNext(req.query.next) })));
  auth.post("/auth/link", form, (req, res) => {
    if (limited(`link-ip:${req.clientIp?.value ?? "?"}`, 30, HOUR)) return res.status(429).type("html").send(messagePage("Too many attempts", "Try again later."));
    const email = store.consumeToken(hmac(cfg.secret, `token|${String(req.body?.token || "")}`));
    if (!email) return res.status(401).type("html").send(messagePage("Link expired", "That sign-in link was already used or has expired."));
    startSession(res, email, null, "email-link");
    res.redirect(303, safeNext(req.body?.next));
  });

  // Every refusal after the provider round trip looks the same (wrong state, provider error, unverified or missing
  // email, not invited), so the button never reveals who may sign in, just as the code form does not.
  const oauthRefused = (res) => res.status(401).type("html").send(messagePage("Sign-in not completed", "We could not sign you in with that account. Try again, or use an email code instead."));
  for (const provider of Object.keys(oauthCreds)) {
    const redirectUri = `${cfg.baseUrl}/auth/${provider}/callback`;
    auth.get(`/auth/${provider}`, (req, res) => {
      if (limited(`oauth-ip:${req.clientIp?.value ?? "?"}`, 30, HOUR)) return res.status(429).type("html").send(messagePage("Too many attempts", "Try again later."));
      const now = Date.now();
      if (pendingStates.size > 2000) for (const [s, exp] of pendingStates) if (exp < now) pendingStates.delete(s);
      if (pendingStates.size > 10000) return res.status(429).type("html").send(messagePage("Too many attempts", "Try again later."));
      const { url, state, verifier } = authorizeRequest(provider, oauthCreds[provider], redirectUri);
      pendingStates.set(state, now + LOGIN_MS);
      const tx = JSON.stringify({ state, verifier, next: safeNext(req.query.next), exp: now + LOGIN_MS });
      res.append("Set-Cookie", cookie("oauth_tx", `${Buffer.from(tx).toString("base64url")}.${hmac(cfg.secret, `tx|${tx}`)}`, LOGIN_MS));
      res.redirect(302, url);
    });
    auth.get(`/auth/${provider}/callback`, async (req, res) => {
      res.append("Set-Cookie", clear("oauth_tx"));
      if (limited(`oauth-cb-ip:${req.clientIp?.value ?? "?"}`, 30, HOUR)) return res.status(429).type("html").send(messagePage("Too many attempts", "Try again later."));
      try {
        const [b64, sig] = String(parseCookies(req.headers.cookie).oauth_tx || "").split(".");
        const raw = Buffer.from(b64 || "", "base64url").toString();
        if (!sig || !equal(sig, hmac(cfg.secret, `tx|${raw}`))) throw new Error("missing or forged state");
        const tx = JSON.parse(raw);
        if (tx.exp < Date.now() || !equal(tx.state, String(req.query.state || ""))) throw new Error("state mismatch");
        const issued = pendingStates.get(tx.state);
        pendingStates.delete(tx.state); // single use, whatever happens next
        if (!issued || issued < Date.now()) throw new Error("state already used or unknown");
        if (req.query.error) throw new Error(`provider said ${String(req.query.error).slice(0, 40)}`);
        const identity = await completeLogin(provider, oauthCreds[provider], { code: String(req.query.code || ""), verifier: tx.verifier, redirectUri }, fetchImpl);
        // The same checks the email code passes: a well-formed address, then the allow list (geography ran first).
        if (!EMAIL_RE.test(identity.email) || identity.email.length > 254) throw new Error("unusable email");
        if (!mayJoin(identity.email)) throw new Error(`not on the allow list ${maskEmail(identity.email)}`);
        startSession(res, identity.email, identity.name, provider);
        res.redirect(303, tx.next);
      } catch (error) {
        log("oauth-fail", `${provider} ${error.message}`);
        oauthRefused(res);
      }
    });
  }
  // A provider without credentials has no routes at all (404, not a sign-in redirect).
  auth.all(/^\/auth\/(google|facebook)(\/callback)?\/?$/, (req, res) => res.status(404).type("text").send("Not found."));
  app.use(auth);

  // ── 3. everything else needs a session ──────────────────────────────────────────────────
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/worker/") && /^Bearer\s+\S+/.test(String(req.headers.authorization || ""))) return next();
    if (req.method === "GET" && req.path === "/api/health") return next();
    if (publicFile(req)) return next();
    const sid = parseCookies(req.headers.cookie)[sidName];
    const user = sid ? store.sessionUser(sha256(sid)) : null;
    if (!user) {
      noStore(res);
      if (wantsHtml(req)) return res.redirect(302, `/signin?next=${encodeURIComponent(req.originalUrl.slice(0, 500))}`);
      return res.status(401).json({ error: "signin_required" });
    }
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
    req.sessionHash = sha256(sid);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && (!hasBrowserProof(req) || !sameOrigin(req))) return res.status(403).json({ error: "cross_site" });
    if (req.method === "POST" && (req.path === "/auth/logout" || req.path === "/api/logout")) {
      store.deleteSession(req.sessionHash);
      res.append("Set-Cookie", clear(sidName));
      return res.json({ ok: true });
    }
    next();
  });

  return { store, config: cfg, requireOwner: (req, res, next) => (req.user?.role === "owner" ? next() : res.status(403).json({ error: "owner_only" })) };
}
