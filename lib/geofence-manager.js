/**
 * geofence-manager.js
 * Manages geofence zones: polygon storage, ship entry/exit detection,
 * cooldown tracking to prevent email spam.
 *
 * Algorithm: Ray-casting point-in-polygon (handles concave polygons).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');

const DATA_FILE = path.join(__dirname, '..', 'data', 'geofences.json');

// Per ship+zone: how many ms must pass before re-alerting
const REENTER_COOLDOWN_MS = (parseFloat(process.env.GEO_REENTER_MINUTES) || 30) * 60_000;

// Color palette for zones
const ZONE_COLORS = [
  '#ff1744', '#ff9100', '#ffd740', '#00e676',
  '#00c8ff', '#b39ddb', '#ff6eb0', '#80d8ff',
];

class GeofenceManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, Zone>} */
    this.zones = new Map();
    /**
     * Tracks which ships are CURRENTLY inside each zone.
     * zoneId → Set<mmsi>
     */
    this.insideMap = new Map();
    /**
     * Last alert time per ship+zone pair (anti-spam cooldown).
     * `${zoneId}:${mmsi}` → timestamp
     */
    this.lastAlert = new Map();
  }

  // ── PERSISTENCE ───────────────────────────────────
  load() {
    try {
      if (!fs.existsSync(DATA_FILE)) { this.save(); return; }
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const z of (raw || [])) {
        this.zones.set(z.id, z);
        this.insideMap.set(z.id, new Set());
      }
      console.log(`[GEO] Loaded ${this.zones.size} geofence(s)`);
    } catch (e) {
      console.error('[GEO] Load error:', e.message);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify([...this.zones.values()], null, 2));
    } catch (e) {
      console.error('[GEO] Save error:', e.message);
    }
  }

  // ── CRUD ──────────────────────────────────────────
  list() {
    return [...this.zones.values()].map(z => this._view(z));
  }

  get(id) {
    const z = this.zones.get(id);
    return z ? this._view(z) : null;
  }

  /**
   * @param {Object} data
   * @param {string} data.name
   * @param {Array<[number,number]>} data.polygon  [[lat,lng], ...]
   * @param {boolean} [data.enabled]
   * @param {boolean} [data.alertOnEnter]
   * @param {boolean} [data.alertOnExit]
   * @param {string}  [data.alertEmail]
   * @param {string}  [data.color]
   * @param {string}  [data.description]
   */
  add(data) {
    if (!data.name?.trim()) throw new Error('Nama zona wajib diisi');
    this._validatePolygon(data.polygon);

    const colorIdx = this.zones.size % ZONE_COLORS.length;
    const zone = {
      id: randomUUID(),
      name: data.name.trim(),
      description: (data.description || '').trim(),
      polygon: data.polygon,          // [[lat,lng],...]
      color: data.color || ZONE_COLORS[colorIdx],
      enabled: data.enabled !== false,
      alertOnEnter: data.alertOnEnter !== false,
      alertOnExit: data.alertOnExit === true,
      alertEmail: (data.alertEmail || '').trim(),
      createdAt: Date.now(),
      shipCount: 0,                     // live count, not persisted
    };
    this.zones.set(zone.id, zone);
    this.insideMap.set(zone.id, new Set());
    this.save();
    this.emit('zones-updated', this.list());
    return this._view(zone);
  }

  update(id, data) {
    const z = this.zones.get(id);
    if (!z) throw new Error('Zona tidak ditemukan');

    if (data.name !== undefined) z.name = data.name.trim();
    if (data.description !== undefined) z.description = data.description.trim();
    if (data.polygon !== undefined) { this._validatePolygon(data.polygon); z.polygon = data.polygon; }
    if (data.color !== undefined) z.color = data.color;
    if (data.enabled !== undefined) z.enabled = Boolean(data.enabled);
    if (data.alertOnEnter !== undefined) z.alertOnEnter = Boolean(data.alertOnEnter);
    if (data.alertOnExit !== undefined) z.alertOnExit = Boolean(data.alertOnExit);
    if (data.alertEmail !== undefined) z.alertEmail = data.alertEmail.trim();

    this.zones.set(id, z);
    this.save();
    this.emit('zones-updated', this.list());
    return this._view(z);
  }

  remove(id) {
    if (!this.zones.has(id)) throw new Error('Zona tidak ditemukan');
    this.zones.delete(id);
    this.insideMap.delete(id);
    // Clean alert cooldowns for this zone
    for (const k of this.lastAlert.keys()) {
      if (k.startsWith(id + ':')) this.lastAlert.delete(k);
    }
    this.save();
    this.emit('zones-updated', this.list());
  }

  // ── SHIP POSITION CHECK ───────────────────────────
  /**
   * Called on every ship position update.
   * Only checks geofences if position changed meaningfully (>0.001°≈100m).
   */
  checkShip(ship) {
    if (!ship?.lat || !ship?.lon) return;
    const mmsi = String(ship.mmsi);

    // Skip tiny movements — no polygon can detect <100m changes efficiently
    const prev = this._lastPos?.get(mmsi);
    if (prev && Math.abs(prev[0] - ship.lat) < 0.000005 && Math.abs(prev[1] - ship.lon) < 0.000005) return;
    if (!this._lastPos) this._lastPos = new Map();
    this._lastPos.set(mmsi, [ship.lat, ship.lon]);

    for (const [zoneId, zone] of this.zones) {
      if (!zone.enabled) continue;

      const inside = this.insideMap.get(zoneId) ?? new Set();
      const wasInside = inside.has(mmsi);
      const isInside = this._pointInPolygon(ship.lat, ship.lon, zone.polygon);

      if (isInside && !wasInside) {
        // ENTER
        inside.add(mmsi);
        zone.shipCount = inside.size;
        this.emit('enter', { zone: this._view(zone), ship, zoneId });
        this._tryAlert('enter', zone, ship);
      } else if (!isInside && wasInside) {
        // EXIT
        inside.delete(mmsi);
        zone.shipCount = inside.size;
        this.emit('exit', { zone: this._view(zone), ship, zoneId });
        this._tryAlert('exit', zone, ship);
      }

      this.insideMap.set(zoneId, inside);
    }
  }

  /** Returns list of MMSIs currently inside a zone */
  getShipsInside(zoneId) {
    return [...(this.insideMap.get(zoneId) ?? new Set())];
  }

  /** Returns list of zone IDs the ship is currently inside */
  getZonesForShip(mmsi) {
    const result = [];
    for (const [zoneId, inside] of this.insideMap) {
      if (inside.has(String(mmsi))) result.push(zoneId);
    }
    return result;
  }

  // ── ALERT COOLDOWN ────────────────────────────────
  _tryAlert(event, zone, ship) {
    const emailNeeded =
      (event === 'enter' && zone.alertOnEnter) ||
      (event === 'exit' && zone.alertOnExit);
    if (!emailNeeded) return;

    const key = `${zone.id}:${ship.mmsi}:${event}`;
    const lastTime = this.lastAlert.get(key) || 0;
    if (Date.now() - lastTime < REENTER_COOLDOWN_MS) return; // cooldown

    this.lastAlert.set(key, Date.now());
    this.emit('alert', { event, zone, ship });
  }

  // ── GEOMETRY ──────────────────────────────────────
  /**
   * Ray-casting algorithm — O(n) where n = polygon vertices.
   * Works for concave polygons, handles edge cases.
   * @param {number} lat
   * @param {number} lon
   * @param {Array<[number,number]>} polygon  [[lat,lng],...]
   */
  _pointInPolygon(lat, lon, polygon) {
    if (!polygon || polygon.length < 3) return false;
    let inside = false;
    const n = polygon.length;
    let j = n - 1;
    for (let i = 0; i < n; i++) {
      const [yi, xi] = polygon[i];
      const [yj, xj] = polygon[j];
      const intersect =
        ((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
      j = i;
    }
    return inside;
  }

  _validatePolygon(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) {
      throw new Error('Polygon harus memiliki minimal 3 titik');
    }
    for (const pt of polygon) {
      if (!Array.isArray(pt) || pt.length < 2 ||
        typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
        throw new Error('Format polygon tidak valid. Gunakan [[lat,lng],...]');
      }
    }
  }

  _view(z) {
    return {
      id: z.id,
      name: z.name,
      description: z.description,
      polygon: z.polygon,
      color: z.color,
      enabled: z.enabled,
      alertOnEnter: z.alertOnEnter,
      alertOnExit: z.alertOnExit,
      alertEmail: z.alertEmail,
      createdAt: z.createdAt,
      shipCount: (this.insideMap.get(z.id)?.size) ?? 0,
      shipsInside: this.getShipsInside(z.id),
    };
  }

  static get COLORS() { return ZONE_COLORS; }
}

module.exports = GeofenceManager;
