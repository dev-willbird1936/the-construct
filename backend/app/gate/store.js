// Users, sessions and one-time sign-in requests in their own SQLite file (DATA_DIR/auth.db).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_CODE_ATTEMPTS = 5;

export function openAuthStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "auth.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, provider TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL, last_login INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS logins (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code_hash TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used_at INTEGER);
    CREATE INDEX IF NOT EXISTS logins_email ON logins(email, created_at);
  `);
  const q = {
    userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    insertUser: db.prepare("INSERT INTO users (id, email, name, provider, role, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    touchUser: db.prepare("UPDATE users SET last_login = ?, role = ?, name = COALESCE(?, name) WHERE id = ?"),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
    sessionUser: db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
    insertLogin: db.prepare("INSERT INTO logins (email, code_hash, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"),
    openLogin: db.prepare("SELECT * FROM logins WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1"),
    loginByToken: db.prepare("SELECT * FROM logins WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?"),
    bumpAttempts: db.prepare("UPDATE logins SET attempts = attempts + 1 WHERE id = ?"),
    useLogin: db.prepare("UPDATE logins SET used_at = ? WHERE id = ? AND used_at IS NULL"),
    purgeLogins: db.prepare("DELETE FROM logins WHERE expires_at <= ?"),
  };
  const equal = (a, b) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  return {
    /** Creates the user on first sight; refreshes role and last login every time. */
    upsertUser({ email, name = null, provider, role }) {
      const now = Date.now();
      const existing = q.userByEmail.get(email);
      if (existing) {
        q.touchUser.run(now, role, name, existing.id);
        return q.userById.get(existing.id);
      }
      const id = crypto.randomUUID();
      q.insertUser.run(id, email, name, provider, role, now, now);
      return q.userById.get(id);
    },
    createSession(userId, ttlMs, tokenHash) {
      const now = Date.now();
      q.insertSession.run(tokenHash, userId, now, now + ttlMs);
    },
    sessionUser: (tokenHash) => q.sessionUser.get(tokenHash, Date.now()) ?? null,
    deleteSession: (tokenHash) => q.deleteSession.run(tokenHash),
    createLogin({ email, codeHash, tokenHash, ttlMs }) {
      const now = Date.now();
      q.insertLogin.run(email, codeHash, tokenHash, now, now + ttlMs);
    },
    /** One-time code check. Wrong guesses count; the request dies after MAX_CODE_ATTEMPTS. */
    consumeCode(email, codeHash) {
      const row = q.openLogin.get(email, Date.now());
      if (!row) return false;
      if (row.attempts >= MAX_CODE_ATTEMPTS) return false;
      if (!equal(row.code_hash, codeHash)) {
        q.bumpAttempts.run(row.id);
        return false;
      }
      return q.useLogin.run(Date.now(), row.id).changes === 1 ? row.email : false;
    },
    consumeToken(tokenHash) {
      const row = q.loginByToken.get(tokenHash, Date.now());
      return row && q.useLogin.run(Date.now(), row.id).changes === 1 ? row.email : false;
    },
    purge() {
      const now = Date.now();
      q.purgeSessions.run(now);
      q.purgeLogins.run(now - 24 * 3600 * 1000);
    },
    close: () => db.close(),
  };
}
