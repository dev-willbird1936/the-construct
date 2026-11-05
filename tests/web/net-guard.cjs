// Shared fail-closed network guard for spend/mail-proof browser harnesses.
// Stdlib only. No browser, backend, network, or secret imports.
// Two halves with the same exact-origin policy:
//   Node:   createNodeGuard() wraps fetch (origin allowlist + no redirects).
//   Browser: classifyRequest()/handleRoute() gate page.route handlers.
// Trip records carry bare origins only — never query strings, paths,
// headers, or bodies.
const sanitizeOrigin = (urlString) => {
  try {
    const u = new URL(String(urlString?.url ?? urlString));
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "invalid-url";
  }
};

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

function createNodeGuard({ fetchImpl = globalThis.fetch } = {}) {
  const allowed = new Set(); // exact origins, e.g. "http://127.0.0.1:51234"
  const trips = []; // {kind: "selftest"|"unexpected", origin, at, note}
  const record = (kind, origin, note) => {
    const t = { kind, origin, at: Date.now(), note: note || null };
    trips.push(t);
    return t;
  };
  // Registration itself is fail-closed: only loopback origins, exact match.
  function allowOrigin(origin) {
    if (typeof origin !== "string" || !LOOPBACK_ORIGIN_RE.test(origin)) {
      throw new Error("NETGUARD: refusing non-loopback registration");
    }
    const canonical = new URL(origin).origin;
    allowed.add(canonical);
    return canonical;
  }
  function guardedFetch(url, init = {}) {
    const origin = sanitizeOrigin(url);
    if (origin === "invalid-url" || !allowed.has(origin)) {
      record("unexpected", origin, "node-fetch");
      throw new Error(`NETGUARD: blocked origin ${origin}`);
    }
    return fetchImpl(url, { ...init, redirect: "manual" }).then((res) => {
      const status = res ? res.status : 0;
      if (status >= 300 && status < 400) {
        record("unexpected", origin, `redirect-${status}`);
        throw new Error(`NETGUARD: redirect refused (no auto-follow) origin ${origin} status ${status}`);
      }
      return res;
    });
  }
  // Mark trips recorded since `mark` as expected self-test blocks.
  function markSelfTestSince(mark) {
    for (let i = mark; i < trips.length; i++) trips[i].kind = "selftest";
  }
  const mark = () => trips.length;
  const unexpected = () => trips.filter((t) => t.kind !== "selftest");
  function assertClean() {
    const bad = unexpected();
    if (bad.length) {
      throw new Error(`NETGUARD: ${bad.length} unexpected block(s): ${bad.map((t) => t.origin).join(",")}`);
    }
  }
  return { guardedFetch, allowOrigin, trips, mark, markSelfTestSince, unexpected, assertClean, sanitizeOrigin };
}

// Pure origin classifier shared by the browser route gate. Exact match on
// the registered app origin; everything else (other ports, hosts, helpers,
// CDNs, beacons) is "block". Service workers are blocked at context creation
// (serviceWorkers: "block"); this classifier is the request-level backstop.
function classifyRequest(urlString, appOrigin) {
  try {
    const u = new URL(String(urlString?.url ?? urlString));
    if (["http:", "https:", "blob:"].includes(u.protocol) && u.origin === appOrigin) return "allow";
    if (u.protocol === "data:" || u.href === "about:blank") return "allow";
  } catch {}
  return "block";
}

// Baseline context route. Page-scoped mocks have precedence and must call
// classifyRequest before fulfilling. Returns whether this route continued.
async function handleRoute(route, { appOrigin, onTrip, headersFor }) {
  const req = route.request();
  const href = req.url();
  if (classifyRequest(href, appOrigin) !== "allow") {
    onTrip(href);
    await route.abort("blockedbyclient");
    return false;
  }
  const headers = { ...req.headers(), ...headersFor(req) };
  await route.continue({ headers });
  return true;
}

module.exports = { sanitizeOrigin, createNodeGuard, classifyRequest, handleRoute };
