/**
 * auth-middleware.js
 * Express middleware for JWT authentication.
 * Token accepted from:
 *   - Cookie:  ais_token=<jwt>
 *   - Header:  Authorization: Bearer <jwt>
 */

'use strict';

/**
 * Build middleware using an AuthManager instance.
 * @param {import('./auth-manager')} authMgr
 */
function makeAuthMiddleware(authMgr) {

  /**
   * requireAuth(roles?)
   * Middleware factory. Pass role array to restrict, e.g. requireAuth(['admin']).
   * If no roles passed, any authenticated user is allowed.
   */
  function requireAuth(roles = null) {
    return (req, res, next) => {
      const token = _extractToken(req);
      if (!token) {
        return res.status(401).json({ error: 'Login diperlukan', code: 'UNAUTHORIZED' });
      }

      const payload = authMgr.verify(token);
      if (!payload) {
        return res.status(401).json({ error: 'Sesi tidak valid atau kedaluwarsa', code: 'INVALID_TOKEN' });
      }

      if (roles && !roles.includes(payload.role)) {
        return res.status(403).json({ error: 'Akses ditolak — hak akses tidak cukup', code: 'FORBIDDEN' });
      }

      req.auth   = payload;   // { sub, jti, role, username, iat, exp }
      req.userId = payload.sub;
      next();
    };
  }

  /**
   * optionalAuth — sets req.auth if token present but doesn't block.
   */
  function optionalAuth(req, _res, next) {
    const token = _extractToken(req);
    if (token) {
      const payload = authMgr.verify(token);
      if (payload) { req.auth = payload; req.userId = payload.sub; }
    }
    next();
  }

  function _extractToken(req) {
    // 1. Cookie
    const cookie = req.cookies?.ais_token;
    if (cookie) return cookie;
    // 2. Authorization header
    const hdr = req.headers.authorization || '';
    if (hdr.startsWith('Bearer ')) return hdr.slice(7);
    // 3. Query param (for EventSource / WebSocket handshake)
    if (req.query?.token) return req.query.token;
    return null;
  }

  return { requireAuth, optionalAuth };
}

module.exports = makeAuthMiddleware;
