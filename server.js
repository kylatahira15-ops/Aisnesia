/**
 * ================================================================
 *  AISNESIA  v5.0  —  Optimized for 1500+ ships
 *  Key optimizations:
 *   • Delta broadcast — position updates only send changed fields
 *   • Batch window 150ms — burst absorber
 *   • Static data cache — ship type/name only broadcast once
 *   • Lean WS init — only position fields sent on connect
 *   • gzip compression on HTTP
 *   • Spatial grid geofence (O(1) zone lookup)
 *   • MessagePack binary encoding (faster, smaller than JSON)
 * ================================================================
 */

'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const compression = require('compression');

const SourceManager = require('./lib/source-manager');
const GeofenceManager = require('./lib/geofence-manager');
const AuthManager = require('./lib/auth-manager');
const makeAuthMW = require('./lib/auth-middleware');
const mailer = require('./lib/mailer');
const { Packr } = require('msgpackr');
const { resolveShipType, NAV_STATUS } = require('./lib/ais-decoder');
const db = require('./lib/db');
const actuator = require('./lib/actuator');

// ── CONFIG ────────────────────────────────────────
const HTTP_PORT = parseInt(process.env.PORT) || 4000;
const TIMEOUT_MS = (parseFloat(process.env.SHIP_TIMEOUT_MINUTES) || 5) * 60_000;
const MAX_TRAIL = parseInt(process.env.MAX_TRAIL) || 20;
// Batch window: collect updates for N ms before sending
// Higher = fewer WS messages; Lower = more real-time
const BATCH_MS = parseInt(process.env.BATCH_MS) || 150;
const COOKIE_MAX = 8 * 60 * 60 * 1000;

// Prefer speed over size for MessagePack
const packr = new Packr({ useRecords: false, encodeUndefinedAsNil: true });

// ── INIT SERVICES ─────────────────────────────────
db.connect();
mailer.init();
const srcMgr = new SourceManager(); srcMgr.load();
const geoMgr = new GeofenceManager(); geoMgr.load();
const authMgr = new AuthManager(); authMgr.load();
const { requireAuth, optionalAuth } = makeAuthMW(authMgr);

// ── SHIP STATE ────────────────────────────────────
const ships = new Map();   // mmsi → full ship object
// Static data cache: ship name/type/callsign etc — sent once, not on every pos update
const staticSent = new Set(); // mmsi — already had static data broadcast

const stats = { rxTotal: 0, rxDecoded: 0, startedAt: Date.now() };

// ── SHIP LEAN VIEW (position fields only) ─────────
// Used for initial snapshot and position updates
function leanShip(ship) {
  return {
    mmsi: ship.mmsi,
    lat: ship.lat,
    lon: ship.lon,
    sog: ship.sog,
    cog: ship.cog,
    heading: ship.heading,
    navStatus: ship.navStatus,
    lastSeen: ship.lastSeen,
    lastSource: ship.lastSource,
    classB: ship.classB,
    isAton: ship.isAton,
    isAircraft: ship.isAircraft,
    isLongRange: ship.isLongRange,
    altitude: ship.altitude,
    // Include name/type in lean only if static not yet sent
    name: ship.name,
    shipType: ship.shipType,
  };
}

// Full static data — sent once per ship
function staticShip(ship) {
  return {
    mmsi: ship.mmsi,
    name: ship.name,
    callsign: ship.callsign,
    imo: ship.imo,
    shipType: ship.shipType,
    destination: ship.destination,
    draught: ship.draught,
    length: ship.length,
    beam: ship.beam,
    classB: ship.classB,
  };
}

function isValidName(v) {
  if (!v || v.length < 1 || v.length > 20) return false;
  if (v.includes('@')) return false;
  if (/[\x00-\x1F\x7F]/.test(v)) return false;
  const ok = v.replace(/[A-Za-z0-9\s\/\-\.\(\)]/g, '');
  return ok.length <= v.length * 0.6;
}

function classifyCategory(typeStr, isClassB) {
  if (!typeStr) return isClassB ? 'other_B' : 'other_A';
  const t = typeStr.toLowerCase();
  if (t.includes('tanker')) return isClassB ? 'tanker_B' : 'tanker_A';
  if (t.includes('cargo')) return isClassB ? 'cargo_B' : 'cargo_A';
  if (t.includes('passenger')) return isClassB ? 'passenger_B' : 'passenger_A';
  if (t.includes('fishing')) return isClassB ? 'fishing_B' : 'fishing_A';
  if (t.includes('tug') || t.includes('pilot') || t.includes('port tender') || t.includes('sar vessel'))
    return isClassB ? 'tug_B' : 'tug_A';
  if (t.includes('sailing') || t.includes('pleasure'))
    return isClassB ? 'sailing_B' : 'sailing_A';
  if (t.includes('hsc') || t.includes('high speed') || t.includes('wing in ground'))
    return 'hsc_A';
  if (t.includes('dredging') || t.includes('towing') || t.includes('military') || t.includes('law enforcement') || t.includes('diving') || t.includes('anti-pollution'))
    return isClassB ? 'special_B' : 'special_A';
  return isClassB ? 'other_B' : 'other_A';
}

// ── SHIP UPDATE ───────────────────────────────────
function updateShip(decoded, sourceId, sourceName) {
  if (!decoded?.mmsi) return null;
  const mmsi = String(decoded.mmsi);
  const now = Date.now();
  const prev = ships.get(mmsi) ?? { mmsi, firstSeen: now, trail: [], sources: [] };
  const ship = { ...prev, lastSeen: now, lastSource: sourceName };

  if (!ship.sources.includes(sourceId))
    ship.sources = [...ship.sources, sourceId].slice(-5);

  if (['classA', 'classB', 'classBext'].includes(decoded.type)) {
    if (prev.lat && prev.lon && Math.hypot(prev.lat - decoded.lat, prev.lon - decoded.lon) > 0.0001) {
      ship.trail = [...(prev.trail || []),
      { lat: prev.lat, lon: prev.lon, ts: prev.lastSeen }].slice(-MAX_TRAIL);
    }
    ship.lat = decoded.lat;
    ship.lon = decoded.lon;
    ship.sog = decoded.sog;
    ship.cog = decoded.cog;
    ship.rot = decoded.rot;
    ship.heading = decoded.heading !== 511 ? decoded.heading : undefined;
    ship.navStatus = decoded.status ?? undefined;
    ship.classB = decoded.type === 'classB' || decoded.type === 'classBext';
  }
  if (decoded.type === 'classBext') {
    if (decoded.name) ship.name = decoded.name;
    if (decoded.shipType) ship.shipType = resolveShipType(decoded.shipType);
    if (decoded.dimBow !== undefined) {
      ship.length = (decoded.dimBow || 0) + (decoded.dimStern || 0);
      ship.beam = (decoded.dimPort || 0) + (decoded.dimStbd || 0);
    }
    staticSent.delete(mmsi);
  }
  if (decoded.type === 'baseStation') {
    ship.lat = decoded.lat;
    ship.lon = decoded.lon;
    ship.isBaseStation = true;
  }
  if (decoded.type === 'sar') {
    ship.lat = decoded.lat;
    ship.lon = decoded.lon;
    ship.sog = decoded.sog;
    ship.cog = decoded.cog;
    ship.altitude = decoded.alt;
    ship.isAircraft = true;
  }
  if (decoded.type === 'longRange') {
    ship.lat = decoded.lat;
    ship.lon = decoded.lon;
    ship.sog = decoded.sog;
    ship.cog = decoded.cog;
    ship.isLongRange = true;
  }
  if (decoded.type === 'staticA') {
    const hadStatic = !!(prev.name || prev.callsign);
    if (decoded.name) ship.name = decoded.name;
    if (decoded.callsign) ship.callsign = decoded.callsign;
    if (decoded.destination) ship.destination = decoded.destination;
    if (decoded.shipType) ship.shipType = resolveShipType(decoded.shipType);
    if (decoded.draught) ship.draught = decoded.draught;
    if (decoded.imo) ship.imo = decoded.imo;
    if (decoded.dimBow !== undefined) {
      ship.length = (decoded.dimBow || 0) + (decoded.dimStern || 0);
      ship.beam = (decoded.dimPort || 0) + (decoded.dimStbd || 0);
    }
    // Mark static as dirty — re-broadcast to clients
    if (!hadStatic) staticSent.delete(mmsi);
  }
  if (decoded.type === 'staticB0' || decoded.type === 'staticB1') {
    if (decoded.name) ship.name = decoded.name;
    if (decoded.callsign) ship.callsign = decoded.callsign;
    if (decoded.shipType) ship.shipType = resolveShipType(decoded.shipType);
    staticSent.delete(mmsi);
  }
  if (decoded.type === 'aton') {
    if (isValidName(decoded.name)) ship.name = decoded.name;
    ship.lat = decoded.lat;
    ship.lon = decoded.lon;
    ship.isAton = true;
  }
  // Static fallback — untuk AISHub & source lain yg gabung static + posisi
  if (isValidName(decoded.name) && !prev.name) ship.name = decoded.name;
  if (decoded.callsign && !prev.callsign) ship.callsign = decoded.callsign;
  if (decoded.shipType && !prev.shipType) ship.shipType = resolveShipType(decoded.shipType);
  if (decoded.destination && !prev.destination) ship.destination = decoded.destination;
  if (decoded.draught && !prev.draught) ship.draught = decoded.draught;
  if (decoded.imo && !prev.imo) ship.imo = String(decoded.imo);
  // Classification
  if (decoded.type === 'baseStation') ship.category = 'baseStation';
  else if (decoded.type === 'sar') ship.category = 'sarAircraft';
  else if (decoded.type === 'aton') ship.category = 'aton';
  else if (decoded.type === 'longRange') ship.category = 'longRange';
  else ship.category = classifyCategory(ship.shipType, decoded.type === 'classB' || decoded.type === 'classBext');
  if (!ship.lat || !ship.lon) return null;
  ships.set(mmsi, ship);
  return ship;
}

function purgeStaleShips() {
  const now = Date.now(), expired = [];
  for (const [mmsi, s] of ships) {
    if (now - s.lastSeen > TIMEOUT_MS) {
      ships.delete(mmsi);
      staticSent.delete(mmsi);
      expired.push(mmsi);
    }
  }
  if (expired.length) {
    broadcast({ type: 'remove', mmsis: expired });
    console.log(`[PURGE] ${expired.length} ships. Active: ${ships.size}`);
  }
}

// ── BATCH BROADCASTER ─────────────────────────────
// Separates position updates (frequent) from static data (rare)
let _posBatch = new Map();  // mmsi → lean position object
let _staticBatch = new Map();  // mmsi → static data object
let _batchTimer = null;

function queueShipUpdate(ship) {
  // Position update (high-frequency)
  _posBatch.set(ship.mmsi, {
    m: ship.mmsi,          // mmsi (short key)
    a: ship.lat,           // lat
    o: ship.lon,           // lon
    s: ship.sog,           // sog
    c: ship.cog,           // cog
    h: ship.heading,       // heading
    n: ship.navStatus,     // navStatus
    t: ship.lastSeen,      // timestamp
    r: ship.lastSource,    // source
    al: ship.altitude,     // altitude
    bs: ship.isBaseStation ? 1 : 0,
    ac: ship.isAircraft ? 1 : 0,
    lr: ship.isLongRange ? 1 : 0,
  });

  // Static data — only if new/updated and not yet sent this session
  if (!staticSent.has(ship.mmsi) && (ship.name || ship.callsign || ship.shipType)) {
    staticSent.add(ship.mmsi);
    db.backfillShipName(ship.mmsi, ship.name);
    const entry = { m: ship.mmsi };
    if (ship.name) entry.nm = ship.name;
    if (ship.shipType) entry.tp = ship.shipType;
    if (ship.callsign) entry.cs = ship.callsign;
    if (ship.imo) entry.im = ship.imo;
    if (ship.destination) entry.dt = ship.destination;
    if (ship.draught) entry.dr = ship.draught;
    if (ship.length) entry.ln = ship.length;
    if (ship.beam) entry.bm = ship.beam;
    if (ship.classB != null) entry.cb = ship.classB;
    if (ship.isAton != null) entry.at = ship.isAton;
    if (ship.category) entry.ct = ship.category;
    _staticBatch.set(ship.mmsi, entry);
  }

  if (_batchTimer) return;
  _batchTimer = setTimeout(flushBatch, BATCH_MS);
}

function flushBatch() {
  _batchTimer = null;

  if (_posBatch.size) {
    const positions = [..._posBatch.values()];
    _posBatch.clear();
    // Bulk position update
    broadcast({ type: 'pos', d: positions });
  }

  if (_staticBatch.size) {
    const statics = [..._staticBatch.values()];
    _staticBatch.clear();
    broadcast({ type: 'static', d: statics });
  }
}

// Pre-encode broadcast with MessagePack (faster, smaller)
function broadcast(data) {
  const msg = packr.encode(data);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN) c.send(msg, { binary: true });
  }
}

// ── SOURCE EVENTS ─────────────────────────────────
srcMgr.on('decoded', ({ sourceId, sourceName, decoded }) => {
  stats.rxTotal++;
  if (!decoded) return;
  stats.rxDecoded++;
  const ship = updateShip(decoded, sourceId, sourceName);
  if (!ship) return;
  if (['classA', 'classB', 'classBext', 'baseStation', 'sar', 'longRange'].includes(decoded.type)) geoMgr.checkShip(ship);
  queueShipUpdate(ship);
});
// srcMgr.on('decoded', ({ sourceId, sourceName, decoded }) => {
//   stats.rxTotal++;
//   if (!decoded) return;
//   stats.rxDecoded++;
//   const ship = updateShip(decoded, sourceId, sourceName);
//   if (!ship) return;

//   console.log('[DBG] msgType=', decoded.msgType, 'type=', decoded.type, 'mmsi=', ship.mmsi, ship.lat, ship.lon);  // ← ini

//   if ([1, 2, 3, 18].includes(decoded.msgType)) geoMgr.checkShip(ship);
//   queueShipUpdate(ship);
// });
srcMgr.on('sources-updated', sources => broadcast({ type: 'sources', sources }));

// ── GEOFENCE EVENTS ───────────────────────────────
geoMgr.on('enter', ({ zone, ship }) => {
  console.log(`[GEO] ENTER "${zone.name}" ← ${ship.mmsi}`);
  broadcast({ type: 'geo-event', event: 'enter', zone, ship: leanShip(ship) });
  if (ship.classB) {
    db.logZoneEvent({ event: 'enter', zone, ship, cameraConfirmed: actuator.getCameraDetected() });
  }
  actuator.onGeoEvent('enter', zone, ship);
});
geoMgr.on('exit', ({ zone, ship }) => {
  console.log(`[GEO] EXIT  "${zone.name}" ← ${ship.mmsi}`);
  broadcast({ type: 'geo-event', event: 'exit', zone, ship: leanShip(ship) });
  if (ship.classB) {
    db.logZoneEvent({ event: 'exit', zone, ship, cameraConfirmed: actuator.getCameraDetected() });     // ← tambahkan
  }
  actuator.onGeoEvent('exit', zone, ship);
});
geoMgr.on('alert', async ({ event, zone, ship }) => {
  if (mailer.isEnabled()) await mailer.sendGeofenceAlert(event, zone, ship);
});
geoMgr.on('zones-updated', zones => broadcast({ type: 'zones', zones }));

// ── EXPRESS ───────────────────────────────────────
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(compression({ level: 6 }));   // gzip level 6 (speed/ratio balance)
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal-tugas-akhir.html'));
});
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',           // cache static assets for 1 hour
  etag: true,
}));

// ── AUTH ROUTES ───────────────────────────────────
const isHttps = process.env.HTTPS === 'true';

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });
  try {
    const result = await authMgr.login(username, password);
    if (!result) return res.status(401).json({ error: 'Username atau password salah' });
    res.cookie('ais_token', result.token, {
      httpOnly: true, sameSite: isHttps ? 'none' : 'strict',
      secure: isHttps, maxAge: COOKIE_MAX,
    });
    console.log(`[AUTH] Login: ${username} (${result.user.role})`);
    res.json({ ok: true, user: result.user, token: result.token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.ais_token || (req.headers.authorization || '').replace('Bearer ', '');
  if (token) authMgr.logout(token);
  res.clearCookie('ais_token', { sameSite: isHttps ? 'none' : 'strict', secure: isHttps });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth(), (req, res) => {
  const user = authMgr.get(req.userId);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  const token = req.cookies?.ais_token || (req.headers.authorization || '').replace('Bearer ', '');
  res.json({ ...user, token });
});

app.put('/api/auth/me/password', requireAuth(), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Password lama dan baru wajib diisi' });
    const result = await authMgr.login(req.auth.username, currentPassword);
    if (!result) return res.status(401).json({ error: 'Password lama salah' });
    await authMgr.update(req.userId, { password: newPassword }, req.userId, req.auth.role);
    const token = req.cookies?.ais_token || (req.headers.authorization || '').replace('Bearer ', '');
    if (token) authMgr.logout(token);
    res.clearCookie('ais_token', { sameSite: isHttps ? 'none' : 'strict', secure: isHttps });
    res.json({ ok: true, message: 'Password berhasil diubah. Silakan login kembali.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── PUBLIC ROUTES ─────────────────────────────────
// /api/ships returns lean data only for performance
app.get('/api/ships', (_, res) => {
  res.json({ ships: [...ships.values()].map(leanShip), count: ships.size });
});
app.get('/api/ships/:mmsi', (req, res) => {
  const s = ships.get(req.params.mmsi);
  s ? res.json(s) : res.status(404).json({ error: 'Not found' });
});
app.get('/api/stats', (_, res) => res.json({
  ships: ships.size, received: stats.rxTotal, decoded: stats.rxDecoded,
  uptimeMs: Date.now() - stats.startedAt,
  sources: srcMgr.list().length, zones: geoMgr.list().length,
  emailEnabled: mailer.isEnabled(),
}));
app.get('/healthz', (_, res) => res.json({ ok: true, ships: ships.size }));

// Public config — expose safe env vars to frontend
app.get('/api/config', (_, res) => res.json({
  mapCenter: [
    parseFloat(process.env.MAP_CENTER_LAT) || -5.5,
    parseFloat(process.env.MAP_CENTER_LNG) || 113.0,
  ],
  mapZoom: parseInt(process.env.MAP_ZOOM) || 6,
  appName: process.env.APP_NAME || 'AISNESIA',
}));
app.get('/api/email/status', (_, res) => res.json({
  enabled: mailer.isEnabled(), configured: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
  host: process.env.SMTP_HOST || null,
  alertDelay: mailer.config.ALERT_DELAY_MS / 60_000,
  cooldown: mailer.config.ALERT_COOLDOWN_MS / 60_000,
}));

// ── PROTECTED ROUTES — Sources ────────────────────
const canManage = requireAuth(['admin', 'operator']);
app.get('/api/sources', requireAuth(), (_, res) => res.json(srcMgr.list()));
app.post('/api/sources', canManage, (req, res) => { try { res.status(201).json(srcMgr.add(req.body)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/sources/:id', requireAuth(), (req, res) => { const s = srcMgr.get(req.params.id); s ? res.json(s) : res.status(404).json({ error: 'Not found' }); });
app.put('/api/sources/:id', canManage, (req, res) => { try { res.json(srcMgr.update(req.params.id, req.body)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/sources/:id', canManage, (req, res) => { try { srcMgr.remove(req.params.id); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/sources/:id/toggle', canManage, (req, res) => { try { const s = srcMgr.get(req.params.id); if (!s) return res.status(404).json({ error: 'Not found' }); const wasEnabled = s.enabled; const updated = srcMgr.update(req.params.id, { enabled: !s.enabled }); if (wasEnabled) { const expired = []; for (const [mmsi, ship] of ships) { if ((ship.sources?.length === 1 && ship.sources[0] === req.params.id) || (!ship.sources?.length && ship.lastSource === updated.name)) expired.push(mmsi); } if (expired.length) { expired.forEach(m => ships.delete(m)); broadcast({ type: 'remove', mmsis: expired }); } } res.json(updated); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/serial/ports', requireAuth(), async (_, res) => res.json(await SourceManager.listSerialPorts()));

// ── PROTECTED ROUTES — Geofence ───────────────────
app.get('/api/zones', requireAuth(), (_, res) => res.json(geoMgr.list()));
app.post('/api/zones', canManage, (req, res) => { try { res.status(201).json(geoMgr.add(req.body)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/zones/:id', requireAuth(), (req, res) => { const z = geoMgr.get(req.params.id); z ? res.json(z) : res.status(404).json({ error: 'Not found' }); });
app.put('/api/zones/:id', canManage, (req, res) => { try { res.json(geoMgr.update(req.params.id, req.body)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/zones/:id', canManage, (req, res) => { try { geoMgr.remove(req.params.id); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/zones/:id/toggle', canManage, (req, res) => { try { const z = geoMgr.get(req.params.id); if (!z) return res.status(404).json({ error: 'Not found' }); res.json(geoMgr.update(req.params.id, { enabled: !z.enabled })); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/zones/:id/ships', requireAuth(), (req, res) => { const mmsis = geoMgr.getShipsInside(req.params.id); res.json({ mmsis, ships: mmsis.map(m => ships.get(m)).filter(Boolean) }); });
app.get('/api/ships/:mmsi/zones', requireAuth(), (req, res) => res.json(geoMgr.getZonesForShip(req.params.mmsi)));

// ── PROTECTED ROUTES — Users ──────────────────────
const adminOnly = requireAuth(['admin']);
app.get('/api/users', adminOnly, (_, res) => res.json(authMgr.list()));
app.post('/api/users', adminOnly, async (req, res) => { try { res.status(201).json(await authMgr.create(req.body, req.auth.role)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/users/:id', adminOnly, (req, res) => { const u = authMgr.get(req.params.id); u ? res.json(u) : res.status(404).json({ error: 'Not found' }); });
app.put('/api/users/:id', requireAuth(), async (req, res) => { try { res.json(await authMgr.update(req.params.id, req.body, req.userId, req.auth.role)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/users/:id', adminOnly, (req, res) => { try { authMgr.delete(req.params.id, req.userId, req.auth.role); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });

app.post('/api/email/test', canManage, async (req, res) => {
  const to = req.body.email || process.env.ALERT_TO;
  if (!to) return res.status(400).json({ error: 'Email tujuan tidak diisi' });
  if (!mailer.isEnabled()) return res.status(400).json({ error: 'SMTP belum dikonfigurasi' });
  const ok = await mailer.sendTest(to);
  res.json({ ok, message: ok ? 'Email terkirim' : 'Gagal mengirim email' });
});

app.get('/api/actuator', (req, res) => res.json(actuator.status));
app.get('/api/actuator/line', (req, res) =>
  res.type('text/plain').send(actuator.status.line || '0,0,0,0')
);

// ── HTTP + WS ─────────────────────────────────────
const httpServer = http.createServer(app);

// Increase WS server limits for high-throughput
const wss = new WebSocket.Server({
  server: httpServer,
  maxPayload: 64 * 1024 * 1024,  // 64 MB max message
  perMessageDeflate: {            // per-message compression
    zlibDeflateOptions: { level: 1 },  // level 1 = fast
    threshold: 256,                     // only compress >256 bytes
    concurrencyLimit: 10,
  },
});

wss.on('connection', (ws, req) => {
  console.log(`[WS] Connect: ${req.socket.remoteAddress} (${wss.clients.size})`);

  // Auth check
  const tokenParam = new URL(req.url, 'http://localhost').searchParams.get('token');
  const cookie = req.headers.cookie?.match(/ais_token=([^;]+)/)?.[1];
  const token = tokenParam || cookie;
  const auth = token ? authMgr.verify(token) : null;

  // Send lean init snapshot — position + name/type only
  // Static details (callsign, IMO etc) sent separately to reduce init size
  const initShips = [...ships.values()].map(s => ({
    m: s.mmsi, a: s.lat, o: s.lon, s: s.sog, c: s.cog, h: s.heading,
    n: s.navStatus, t: s.lastSeen, r: s.lastSource, cb: s.classB, at: s.isAton,
    nm: s.name, tp: s.shipType, al: s.altitude,
    bs: s.isBaseStation, ac: s.isAircraft, lr: s.isLongRange,
  }));

  ws.send(packr.encode({
    type: 'init',
    ships: initShips,
    sources: auth ? srcMgr.list() : [],
    zones: auth ? geoMgr.list() : [],
    auth: auth ? { username: auth.username, role: auth.role } : null,
    stats: { count: ships.size, received: stats.rxTotal, decoded: stats.rxDecoded },
  }), { binary: true });

  ws.on('close', () => console.log(`[WS] Disconnect (${wss.clients.size})`));
  ws.on('error', e => console.debug('[WS] error:', e.message));
});

// ── TIMERS ────────────────────────────────────────
setInterval(purgeStaleShips, 30_000);

// Stats every 15s — lightweight, no lists
setInterval(() => {
  broadcast({
    type: 'stats',
    count: ships.size,
    received: stats.rxTotal,
    decoded: stats.rxDecoded,
    clients: wss.clients.size,
  });
}, 15_000);

// ── BOOT ──────────────────────────────────────────
httpServer.listen(HTTP_PORT, () => {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║               AISNESIA  v5.0                  ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  HTTP    →  http://localhost:${HTTP_PORT}              ║`);
  console.log(`║  Email   →  ${mailer.isEnabled() ? 'AKTIF ✓              ' : 'Tidak dikonfigurasi  '}           ║`);
  console.log(`║  Users   →  ${String(authMgr.list().length).padEnd(4)} user(s)                      ║`);
  console.log(`║  Batch   →  ${BATCH_MS}ms window                       ║`);
  console.log('╚═══════════════════════════════════════════════╝');
  srcMgr.startAll();
});

function shutdown(sig) {
  console.log(`\n[AISNESIA] ${sig} — flushing & shutting down`);
  if (_batchTimer) { clearTimeout(_batchTimer); flushBatch(); }
  srcMgr.stopAll();
  httpServer.close(() => { console.log('[AISNESIA] Stopped'); process.exit(0); });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
