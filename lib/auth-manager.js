/**
 * auth-manager.js
 * User authentication — bcrypt passwords, JWT tokens, session management.
 * Users stored in data/users.json (persistent).
 * Default admin seeded from .env on first run.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const DATA_FILE   = path.join(__dirname, '..', 'data', 'users.json');
const JWT_SECRET  = process.env.JWT_SECRET  || 'ais-tracker-secret-change-me-in-production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';
const BCRYPT_ROUNDS = 10;

// In-memory blacklist for logged-out tokens (jti)
const tokenBlacklist = new Set();

// Roles: admin | operator | viewer
const ROLES = ['admin', 'operator', 'viewer'];
const ROLE_LABELS = { admin: 'Administrator', operator: 'Operator', viewer: 'Viewer' };

class AuthManager {
  constructor() {
    /** @type {Map<string, User>}  id → user */
    this.users = new Map();
  }

  // ── PERSISTENCE ────────────────────────────────
  load() {
    try {
      if (!fs.existsSync(DATA_FILE)) {
        this._seedAdmin();
        this.save();
        return;
      }
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const u of (raw || [])) this.users.set(u.id, u);

      if (this.users.size === 0) {
        this._seedAdmin();
        this.save();
      } else {
        console.log(`[AUTH] Loaded ${this.users.size} user(s)`);
      }
    } catch (e) {
      console.error('[AUTH] Load error:', e.message);
      this._seedAdmin();
      this.save();
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify([...this.users.values()], null, 2));
    } catch (e) {
      console.error('[AUTH] Save error:', e.message);
    }
  }

  _seedAdmin() {
    const username = process.env.ADMIN_USER || 'admin';
    const password = process.env.ADMIN_PASS || 'admin123';
    const hash     = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const user = {
      id       : randomUUID(),
      username,
      name     : 'Administrator',
      email    : process.env.ADMIN_EMAIL || '',
      role     : 'admin',
      hash,
      createdAt: Date.now(),
      lastLogin: null,
      active   : true,
    };
    this.users.set(user.id, user);
    console.log(`[AUTH] Default admin seeded — username: "${username}" password: "${password}"`);
    console.log('[AUTH] ⚠️  Segera ubah password default melalui menu Settings!');
  }

  // ── AUTH ───────────────────────────────────────
  /**
   * Verify username+password, return JWT on success.
   * @returns {{ token: string, user: object } | null}
   */
  async login(username, password) {
    const user = [...this.users.values()].find(u => u.username === username && u.active);
    if (!user) return null;

    const ok = await bcrypt.compare(password, user.hash);
    if (!ok) return null;

    // Update last login
    user.lastLogin = Date.now();
    this.users.set(user.id, user);
    this.save();

    const jti   = randomUUID();
    const token = jwt.sign(
      { sub: user.id, jti, role: user.role, username: user.username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    return { token, user: this._view(user) };
  }

  /**
   * Invalidate a token (logout).
   */
  logout(token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
      tokenBlacklist.add(payload.jti);
      // Auto-clean blacklist when it gets large
      if (tokenBlacklist.size > 10_000) tokenBlacklist.clear();
    } catch {}
  }

  /**
   * Verify JWT, return decoded payload or null.
   */
  verify(token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (tokenBlacklist.has(payload.jti)) return null;
      // Ensure user still exists and is active
      const user = this.users.get(payload.sub);
      if (!user || !user.active) return null;
      return payload;
    } catch {
      return null;
    }
  }

  // ── USER CRUD ──────────────────────────────────
  list() {
    return [...this.users.values()].map(u => this._view(u));
  }

  get(id) {
    const u = this.users.get(id);
    return u ? this._view(u) : null;
  }

  async create(data, actorRole = 'admin') {
    if (actorRole !== 'admin') throw new Error('Hanya admin yang bisa membuat user');
    if (!data.username?.trim()) throw new Error('Username wajib diisi');
    if (!data.password || data.password.length < 6) throw new Error('Password minimal 6 karakter');
    if (!ROLES.includes(data.role)) throw new Error('Role tidak valid');

    // Check duplicate username
    const exists = [...this.users.values()].find(u => u.username === data.username.trim());
    if (exists) throw new Error('Username sudah digunakan');

    const hash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
    const user = {
      id       : randomUUID(),
      username : data.username.trim(),
      name     : (data.name || data.username).trim(),
      email    : (data.email || '').trim(),
      role     : data.role,
      hash,
      createdAt: Date.now(),
      lastLogin: null,
      active   : true,
    };
    this.users.set(user.id, user);
    this.save();
    return this._view(user);
  }

  async update(id, data, actorId, actorRole) {
    const user = this.users.get(id);
    if (!user) throw new Error('User tidak ditemukan');

    // Non-admin can only update their own name/email/password
    const isSelf  = actorId === id;
    const isAdmin = actorRole === 'admin';
    if (!isAdmin && !isSelf) throw new Error('Akses ditolak');

    if (data.name  !== undefined) user.name  = data.name.trim();
    if (data.email !== undefined) user.email = data.email.trim();

    // Only admin can change role and active status
    if (isAdmin) {
      if (data.role   !== undefined && ROLES.includes(data.role)) user.role   = data.role;
      if (data.active !== undefined) user.active = Boolean(data.active);
    }

    if (data.password) {
      if (data.password.length < 6) throw new Error('Password minimal 6 karakter');
      user.hash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
    }

    this.users.set(id, user);
    this.save();
    return this._view(user);
  }

  delete(id, actorId, actorRole) {
    if (actorRole !== 'admin') throw new Error('Hanya admin yang bisa menghapus user');
    if (id === actorId) throw new Error('Tidak bisa menghapus akun sendiri');
    if (!this.users.has(id)) throw new Error('User tidak ditemukan');
    this.users.delete(id);
    this.save();
  }

  _view(u) {
    return {
      id       : u.id,
      username : u.username,
      name     : u.name,
      email    : u.email,
      role     : u.role,
      roleLabel: ROLE_LABELS[u.role] || u.role,
      active   : u.active,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
    };
  }

  static get ROLES() { return [...ROLES]; }
  static get ROLE_LABELS() { return { ...ROLE_LABELS }; }
}

module.exports = AuthManager;
