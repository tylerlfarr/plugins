/**
 * Invite-only pilot auth — individual identities for audit history.
 * Roles: owner (settings/spend/reconcile/seed) · operator (daily workbook workflow)
 *
 * Sessions: opaque token in HttpOnly cookie, SHA-256 hashed at rest.
 * Passwords: Node crypto.scrypt (no extra dependency).
 */

import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';

export const COOKIE_NAME = 'permit_ledger_session';
export const ROLES = Object.freeze({ OWNER: 'owner', OPERATOR: 'operator' });

const SESSION_DAYS = 14;

export function ensureAuthTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'operator',
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator',
      token_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      used_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function scryptHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function scryptVerify(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const next = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(next, 'hex'));
  } catch {
    return false;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function authEnabled() {
  // Deploy/pilot: PILOT_AUTH=1. Local Try Live / tests default off unless set.
  if (process.env.PILOT_AUTH === '0') return false;
  if (process.env.PILOT_AUTH === '1') return true;
  return Boolean(process.env.SESSION_SECRET && process.env.NODE_ENV === 'production');
}

export function bootstrapOwnerFromEnv() {
  ensureAuthTables();
  const email = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD || '';
  if (!email || !password) return null;
  const existing = db.prepare(`SELECT * FROM users WHERE lower(email) = ?`).get(email);
  if (existing) return existing;
  if (db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c > 0) return null;
  const info = db
    .prepare(
      `INSERT INTO users(email, display_name, role, password_hash)
       VALUES (?, ?, 'owner', ?)`
    )
    .run(email, process.env.OWNER_DISPLAY_NAME || 'Owner', scryptHash(password));
  setSetting('business_name', process.env.BUSINESS_NAME || 'Single-business pilot');
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function createInvite({ email, role = ROLES.OPERATOR, createdBy = null, days = 7 } = {}) {
  ensureAuthTables();
  if (![ROLES.OWNER, ROLES.OPERATOR].includes(role)) throw new Error('Invalid role');
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare(
    `INSERT INTO invites(email, role, token_hash, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(String(email || '').toLowerCase(), role, hashToken(token), createdBy, expires);
  return { token, email: String(email || '').toLowerCase(), role, expires_at: expires };
}

export function acceptInvite({ token, password, displayName = '' }) {
  ensureAuthTables();
  const inv = db
    .prepare(
      `SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`
    )
    .get(hashToken(token));
  if (!inv) throw new Error('Invalid or expired invite');
  if (!password || String(password).length < 10) throw new Error('Password must be at least 10 characters');
  const email = inv.email;
  let user = db.prepare(`SELECT * FROM users WHERE lower(email) = ?`).get(email);
  if (!user) {
    const info = db
      .prepare(
        `INSERT INTO users(email, display_name, role, password_hash) VALUES (?, ?, ?, ?)`
      )
      .run(email, displayName || email.split('@')[0], inv.role, scryptHash(password));
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  } else {
    db.prepare(`UPDATE users SET password_hash = ?, role = ?, active = 1 WHERE id = ?`).run(
      scryptHash(password),
      inv.role,
      user.id
    );
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }
  db.prepare(`UPDATE invites SET used_at = datetime('now') WHERE id = ?`).run(inv.id);
  return user;
}

export function login(email, password) {
  ensureAuthTables();
  const user = db
    .prepare(`SELECT * FROM users WHERE lower(email) = ? AND active = 1`)
    .get(String(email || '').toLowerCase());
  if (!user || !scryptVerify(password, user.password_hash)) {
    throw new Error('Invalid email or password');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare(`INSERT INTO sessions(user_id, token_hash, expires_at) VALUES (?, ?, ?)`).run(
    user.id,
    hashToken(token),
    expires
  );
  return { user: publicUser(user), token, expires_at: expires };
}

export function logout(token) {
  if (!token) return;
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
}

export function userFromToken(token) {
  if (!token) return null;
  ensureAuthTables();
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.active = 1`
    )
    .get(hashToken(token));
  return row || null;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
  };
}

function parseCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function cookieOptions({ secure = false } = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(secure),
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  };
}

export function serializeCookie(token, { secure = false } = {}) {
  const opts = cookieOptions({ secure });
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    'HttpOnly',
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie({ secure = false } = {}) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=lax'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function attachAuth(req, res, next) {
  const header = req.headers.cookie || '';
  const token = parseCookie(header, COOKIE_NAME);
  req.authToken = token;
  req.user = userFromToken(token);
  // Individual identity for audit — never a globally editable demo.user when logged in
  if (req.user) {
    req.actor = req.user.email;
  } else {
    req.actor = authEnabled() ? null : getSetting('current_user', 'local.dev');
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!authEnabled()) return next();
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

export function requireOwner(req, res, next) {
  if (!authEnabled()) return next();
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role !== ROLES.OWNER) {
    return res.status(403).json({ error: 'Owner role required' });
  }
  next();
}

/** CSRF-ish protection for state-changing requests when auth is on: require same-origin or X-Requested-With */
export function protectStateChange(req, res, next) {
  if (!authEnabled()) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const xhr = req.headers['x-requested-with'];
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (xhr === 'PermitLedger') return next();
  if (origin && host) {
    try {
      const o = new URL(origin);
      if (o.host === host) return next();
    } catch {
      /* fall through */
    }
  }
  // Same-site cookie navigations without Origin (e.g. some form posts) — allow if Referer matches host
  const referer = req.headers.referer;
  if (referer && host) {
    try {
      if (new URL(referer).host === host) return next();
    } catch {
      /* fall through */
    }
  }
  // JSON API clients must send X-Requested-With
  if (req.headers['content-type']?.includes('application/json') && !xhr) {
    return res.status(403).json({ error: 'Missing X-Requested-With for state-changing request' });
  }
  next();
}

export function authStatus() {
  ensureAuthTables();
  return {
    enabled: authEnabled(),
    userCount: db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c,
    businessName: getSetting('business_name', ''),
    ownerBootstrapConfigured: Boolean(process.env.OWNER_EMAIL),
  };
}
