import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

// Explicit allowlist for the repo-root web app. Everything else 404s.
// Served:  / (+ index.html), root *.{html,js,mjs,css,svg,webp,png,json},
//          /assets/*, /vendor/*, /specimens/* (from DATA_DIR).
// Never:   backend/, .planning/, .pi/, tests/, eval/, node_modules,
//          dotfiles, *.{md,log,db}, path traversal.

const ROOT_FILE = /^\/[^/.][^/]*\.(html|js|mjs|css|svg|webp|png|json)$/;
const BLOCKED_EXT = /\.(md|log|db|sqlite|sqlite-wal|sqlite-shm)$/i;

function blocked(p) {
  if (typeof p !== "string" || !p.startsWith("/")) return true;
  let decoded = p;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    return true;
  }
  if (decoded.includes("\0") || decoded.includes("..")) return true;
  const segs = decoded.split("/").filter(Boolean);
  if (segs.some((s) => s.startsWith("."))) return true; // dotfiles/dotdirs
  if (BLOCKED_EXT.test(decoded)) return true;
  const top = segs[0];
  if (top === undefined) return false; // "/"
  if (["backend", ".planning", ".pi", "tests", "eval", "node_modules", "compare", ".playwright-mcp", "data", "data-test"].includes(top)) return true;
  if (top === "assets" || top === "vendor" || top === "specimens") return false;
  if (segs.length === 1 && ROOT_FILE.test(decoded)) return false;
  return true;
}

export function installStatic(app, { siteRoot, specimensDir }) {
  app.use((req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) return next();
    if (req.path.startsWith("/api/")) return next();
    if (blocked(req.path)) return res.status(404).end();
    next();
  });
  app.use(
    "/specimens",
    express.static(specimensDir, { dotfiles: "deny", index: false, maxAge: "1d", fallthrough: true })
  );
  app.use(
    express.static(siteRoot, {
      dotfiles: "deny",
      index: "index.html",
      maxAge: "1h",
      // pages and scripts are revalidated on every load (cheap 304s), so an edit never hides behind a cached copy
      setHeaders: (res, file) => { if (/\.(?:js|mjs|css|html)$/i.test(file)) res.setHeader("Cache-Control", "no-cache"); },
      fallthrough: true,
    })
  );
  // Anything that passed the guard but matched no file.
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    if (!["GET", "HEAD"].includes(req.method)) return next();
    res.status(404).end();
  });
}

export const __test = { blocked };
export const siteRootFor = (hereUrl) => path.resolve(path.dirname(fileURLToPath(hereUrl)), "..", "..");
