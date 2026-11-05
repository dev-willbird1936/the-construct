// Google and Facebook (Meta) sign-in, authorization-code flow. Dormant until the client ids/secrets exist in the
// environment: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET and FB_APP_ID/FB_APP_SECRET, plus BASE_URL. The redirect URI to
// register with each provider is  <BASE_URL>/auth/<provider>/callback .
// Both providers use PKCE (S256) on top of the signed, single-use state the gate keeps.
// Not exercised against the live providers (no credentials exist yet); unit tests cover state, PKCE and parsing with a fake fetch.
import crypto from "node:crypto";

const b64url = (buf) => buf.toString("base64url");
const FB_GRAPH = "v25.0";
const TIMEOUT_MS = 10000;

export function configuredProviders(env = process.env) {
  const list = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) list.google = { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
  if (env.FB_APP_ID && env.FB_APP_SECRET) list.facebook = { id: env.FB_APP_ID, secret: env.FB_APP_SECRET };
  return list;
}

export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash("sha256").update(verifier).digest()) };
}

/** URL to send the browser to, plus the secrets that must come back with the callback. */
export function authorizeRequest(provider, creds, redirectUri) {
  const state = b64url(crypto.randomBytes(24));
  const { verifier, challenge } = pkcePair();
  const params = new URLSearchParams({ client_id: creds.id, redirect_uri: redirectUri, response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256" });
  let base;
  if (provider === "google") {
    base = "https://accounts.google.com/o/oauth2/v2/auth";
    params.set("scope", "openid email profile");
    params.set("prompt", "select_account");
  } else {
    base = `https://www.facebook.com/${FB_GRAPH}/dialog/oauth`;
    params.set("scope", "email,public_profile");
  }
  return { url: `${base}?${params}`, state, verifier };
}

const getJson = async (fetchImpl, url, init = {}) => {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return res.json();
};

/** Exchanges the callback code for a verified identity: { email, name }. Throws on any problem. */
export async function completeLogin(provider, creds, { code, verifier, redirectUri }, fetchImpl = fetch) {
  if (!code) throw new Error("no authorization code");
  if (provider === "google") {
    const token = await getJson(fetchImpl, "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: creds.id, client_secret: creds.secret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
    });
    if (!token.access_token) throw new Error("Google did not return an access token");
    const info = await getJson(fetchImpl, "https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!info.email || info.email_verified !== true) throw new Error("Google account has no verified email");
    return { email: String(info.email).toLowerCase(), name: info.name ?? null };
  }
  const q = new URLSearchParams({ client_id: creds.id, client_secret: creds.secret, redirect_uri: redirectUri, code, code_verifier: verifier });
  const token = await getJson(fetchImpl, `https://graph.facebook.com/${FB_GRAPH}/oauth/access_token?${q}`);
  if (!token.access_token) throw new Error("Facebook did not return an access token");
  const proof = crypto.createHmac("sha256", creds.secret).update(token.access_token).digest("hex");
  const me = new URLSearchParams({ fields: "id,name,email", access_token: token.access_token, appsecret_proof: proof });
  const info = await getJson(fetchImpl, `https://graph.facebook.com/${FB_GRAPH}/me?${me}`);
  if (!info.email) throw new Error("Facebook did not share an email address");
  return { email: String(info.email).toLowerCase(), name: info.name ?? null };
}
