/**
 * source-manager.js  v2
 * Manages multiple AIS data sources:
 *   - TCP  : raw NMEA over TCP socket
 *   - Serial: NMEA over RS-232/USB serial port (COM port / /dev/tty*)
 *
 * Both share the same NMEA parser and emit identical events.
 */

'use strict';

const net        = require('net');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');
const { randomUUID }   = require('crypto');
const { EventEmitter } = require('events');
const { parseSentence } = require('./ais-decoder');
const mailer     = require('./mailer');

// ── AISHub field mappings ────────────────────────────
const AISHUB_NAVSTAT = {
  0:'Under Way (Engine)',1:'At Anchor',2:'Not Under Command',
  3:'Restricted Manoeuvrability',4:'Constrained by Draught',
  5:'Moored',6:'Aground',7:'Engaged in Fishing',
  8:'Under Way (Sailing)',15:'Undefined',
};
const AISHUB_SHIP_TYPE = {
  20:'Wing in Ground',21:'WIG Hazardous A',22:'WIG Hazardous B',23:'WIG Hazardous C',24:'WIG Hazardous D',
  30:'Fishing',31:'Towing',32:'Towing (Large)',33:'Dredging',34:'Diving',35:'Military',36:'Sailing',
  37:'Pleasure Craft',40:'High Speed Craft',41:'HSC Hazardous A',42:'HSC Hazardous B',43:'HSC Hazardous C',
  44:'HSC Hazardous D',50:'Pilot',51:'SAR',52:'Tug',53:'Port Tender',54:'Anti-pollution',
  55:'Law Enforcement',58:'Medical',59:'Resolution',60:'Passenger',61:'Passenger Hazardous A',
  62:'Passenger Hazardous B',63:'Passenger Hazardous C',64:'Passenger Hazardous D',
  70:'Cargo',71:'Cargo Hazardous A',72:'Cargo Hazardous B',73:'Cargo Hazardous C',74:'Cargo Hazardous D',
  80:'Tanker',81:'Tanker Hazardous A',82:'Tanker Hazardous B',83:'Tanker Hazardous C',84:'Tanker Hazardous D',
  90:'Other',
};

// ── Lazy-load serialport (optional — may not be installed) ──────
let SerialPort, ReadlineParser;
try {
  ({ SerialPort } = require('serialport'));
  ({ ReadlineParser } = require('@serialport/parser-readline'));
} catch (e) {
  console.warn('[SRC] serialport not available:', e.message);
}

const DATA_FILE          = path.join(__dirname, '..', 'data', 'sources.json');
const TCP_RECONNECT_MS   = 5_000;
const TCP_TIMEOUT_MS     = 90_000;
const SERIAL_RECONNECT_MS= 8_000;
const AISHUB_POLL_MS     = 70_000;  // 70 detik — sesuai rate limit AISHub

// Default serial settings for AIS receivers
const SERIAL_DEFAULTS = {
  baudRate : 38400,
  dataBits : 8,
  stopBits : 1,
  parity   : 'none',
};

class SourceManager extends EventEmitter {
  constructor() {
    super();
    this.sources      = new Map(); // id → source config
    this.conns        = new Map(); // id → connection context
    this.reconnTimers = new Map(); // id → timer
  }

  // ── PERSISTENCE ──────────────────────────────────
  load() {
    try {
      if (!fs.existsSync(DATA_FILE)) {
        this._seedDefault(); this.save(); return;
      }
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const s of (raw || [])) this.sources.set(s.id, s);

      if (this.sources.size === 0) {
        this._seedDefault(); this.save();
      } else {
        console.log(`[SRC] Loaded ${this.sources.size} sumber`);
      }
    } catch (e) {
      console.error('[SRC] Load error:', e.message);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify([...this.sources.values()], null, 2));
    } catch (e) {
      console.error('[SRC] Save error:', e.message);
    }
  }

  _seedDefault() {
    if (!process.env.AIS_HOST) return;
    const def = this._makeTCPSource({
      name : process.env.AIS_NAME || 'Main Feed',
      host : process.env.AIS_HOST,
      port : parseInt(process.env.AIS_PORT) || 6000,
    });
    this.sources.set(def.id, def);
    console.log('[SRC] Seeded default source:', def.name);
  }

  // ── FACTORY HELPERS ───────────────────────────────
  _makeTCPSource(data) {
    return {
      id              : randomUUID(),
      type            : 'tcp',
      name            : (data.name || 'TCP Feed').trim(),
      host            : (data.host || '').trim(),
      port            : parseInt(data.port) || 6000,
      enabled         : data.enabled !== false,
      alertEnabled    : Boolean(data.alertEnabled),
      alertEmail      : (data.alertEmail || '').trim(),
      createdAt       : Date.now(),
      status          : 'disconnected',
      reconnectCount  : 0,
      rxTotal         : 0,
      rxDecoded       : 0,
      lastConnected   : null,
      lastDisconnected: null,
    };
  }

  _makeSerialSource(data) {
    return {
      id              : randomUUID(),
      type            : 'serial',
      name            : (data.name || 'Serial Feed').trim(),
      // Serial-specific
      port            : (data.port || '').trim(),   // e.g. COM3 or /dev/ttyUSB0
      baudRate        : parseInt(data.baudRate)   || SERIAL_DEFAULTS.baudRate,
      dataBits        : parseInt(data.dataBits)   || SERIAL_DEFAULTS.dataBits,
      stopBits        : parseFloat(data.stopBits) || SERIAL_DEFAULTS.stopBits,
      parity          : data.parity || SERIAL_DEFAULTS.parity,
      // Common
      enabled         : data.enabled !== false,
      alertEnabled    : Boolean(data.alertEnabled),
      alertEmail      : (data.alertEmail || '').trim(),
      createdAt       : Date.now(),
      status          : 'disconnected',
      reconnectCount  : 0,
      rxTotal         : 0,
      rxDecoded       : 0,
      lastConnected   : null,
      lastDisconnected: null,
    };
  }

  _makeAISHubSource(data) {
    return {
      id              : randomUUID(),
      type            : 'aishub',
      name            : (data.name || 'AISHub Feed').trim(),
      username        : (data.username || '').trim(),
      latMin          : parseFloat(data.latMin) || -11,
      latMax          : parseFloat(data.latMax) ||   6,
      lonMin          : parseFloat(data.lonMin) ||  95,
      lonMax          : parseFloat(data.lonMax) || 141,
      intervalSec     : Math.max(70, parseInt(data.intervalSec) || 70), // min 70 detik
      enabled         : data.enabled !== false,
      alertEnabled    : Boolean(data.alertEnabled),
      alertEmail      : (data.alertEmail || '').trim(),
      createdAt       : Date.now(),
      status          : 'disconnected',
      reconnectCount  : 0,
      rxTotal         : 0,
      rxDecoded       : 0,
      lastConnected   : null,
      lastDisconnected: null,
      lastPoll        : null,
    };
  }

  // ── CRUD ─────────────────────────────────────────
  list() {
    return [...this.sources.values()].map(s => this._view(s));
  }

  get(id) {
    const s = this.sources.get(id);
    return s ? this._view(s) : null;
  }

  add(data) {
    const type = data.type === 'serial' ? 'serial'
               : data.type === 'aishub' ? 'aishub'
               : 'tcp';

    if (type === 'tcp') {
      if (!data.host?.trim()) throw new Error('Host wajib diisi');
      const src = this._makeTCPSource(data);
      this.sources.set(src.id, src);
      this.save();
      if (src.enabled) this._connect(src.id);
      this._broadcast();
      return this._view(src);
    }

    if (type === 'aishub') {
      if (!data.username?.trim()) throw new Error('Username AISHub wajib diisi');
      const src = this._makeAISHubSource(data);
      this.sources.set(src.id, src);
      this.save();
      if (src.enabled) this._connect(src.id);
      this._broadcast();
      return this._view(src);
    }

    // Serial
    if (!SerialPort) throw new Error('Modul serialport tidak terinstall di server');
    if (!data.port?.trim()) throw new Error('Port serial wajib diisi (contoh: COM3 atau /dev/ttyUSB0)');
    const src = this._makeSerialSource(data);
    this.sources.set(src.id, src);
    this.save();
    if (src.enabled) this._connect(src.id);
    this._broadcast();
    return this._view(src);
  }

  update(id, data) {
    const s = this.sources.get(id);
    if (!s) throw new Error('Sumber tidak ditemukan');
    const wasEnabled = s.enabled;

    if (data.name     !== undefined) s.name     = data.name.trim();
    if (data.enabled  !== undefined) s.enabled  = Boolean(data.enabled);
    if (data.alertEnabled !== undefined) s.alertEnabled = Boolean(data.alertEnabled);
    if (data.alertEmail   !== undefined) s.alertEmail   = data.alertEmail.trim();

    if (s.type === 'tcp') {
      if (data.host !== undefined) s.host = data.host.trim();
      if (data.port !== undefined && typeof data.port === 'number') s.port = data.port;
      else if (data.tcpPort !== undefined) s.port = parseInt(data.tcpPort);
    }

    if (s.type === 'serial') {
      if (data.port     !== undefined) s.port     = data.port.trim();
      if (data.baudRate !== undefined) s.baudRate = parseInt(data.baudRate);
      if (data.dataBits !== undefined) s.dataBits = parseInt(data.dataBits);
      if (data.stopBits !== undefined) s.stopBits = parseFloat(data.stopBits);
      if (data.parity   !== undefined) s.parity   = data.parity;
    }

    if (s.type === 'aishub') {
      if (data.username    !== undefined) s.username    = data.username.trim();
      if (data.latMin      !== undefined) s.latMin      = parseFloat(data.latMin);
      if (data.latMax      !== undefined) s.latMax      = parseFloat(data.latMax);
      if (data.lonMin      !== undefined) s.lonMin      = parseFloat(data.lonMin);
      if (data.lonMax      !== undefined) s.lonMax      = parseFloat(data.lonMax);
      if (data.intervalSec !== undefined) s.intervalSec = Math.max(70, parseInt(data.intervalSec));
    }

    this.sources.set(id, s);
    this.save();

    const connChanged = s.type === 'tcp'
      ? (data.host !== undefined || data.tcpPort !== undefined)
      : s.type === 'aishub'
      ? (data.username !== undefined || data.latMin !== undefined || data.latMax !== undefined || data.lonMin !== undefined || data.lonMax !== undefined || data.intervalSec !== undefined)
      : (data.port !== undefined || data.baudRate !== undefined);

    if ((connChanged || (!wasEnabled && s.enabled)) && s.enabled) {
      this._disconnect(id);
      this._connect(id);
    } else if (!s.enabled && wasEnabled) {
      this._disconnect(id);
      s.status = 'disabled';
    }

    this._broadcast();
    return this._view(s);
  }

  remove(id) {
    if (!this.sources.has(id)) throw new Error('Sumber tidak ditemukan');
    this._disconnect(id);
    mailer.cancelAlert(id);
    this.sources.delete(id);
    this.save();
    this._broadcast();
  }

  // ── START / STOP ──────────────────────────────────
  startAll() {
    for (const [id, s] of this.sources) {
      if (s.enabled) this._connect(id);
    }
  }

  stopAll() {
    for (const id of this.reconnTimers.keys()) clearTimeout(this.reconnTimers.get(id));
    this.reconnTimers.clear();
    for (const id of [...this.conns.keys()]) this._disconnect(id);
    // Bersihkan semua AISHub schedulers
    if (this._aishubSchedulers) {
      for (const sched of this._aishubSchedulers.values()) {
        if (sched.timer) clearTimeout(sched.timer);
        sched.running = false;
      }
      this._aishubSchedulers.clear();
    }
  }

  // ── CONNECT DISPATCHER ────────────────────────────
  _connect(id) {
    const s = this.sources.get(id);
    if (!s || !s.enabled) return;
    this._disconnect(id); // clean slate

    if (s.type === 'serial') {
      this._connectSerial(id, s);
    } else if (s.type === 'aishub') {
      this._connectAISHub(id, s);
    } else {
      this._connectTCP(id, s);
    }
  }

  // ── TCP CONNECTION ────────────────────────────────
  _connectTCP(id, s) {
    console.log(`[SRC:${s.name}] TCP → ${s.host}:${s.port}`);
    this._setStatus(id, 'connecting');

    const socket = new net.Socket();
    const ctx = { type: 'tcp', socket, lineBuffer: '' };
    this.conns.set(id, ctx);

    socket.connect(s.port, s.host, () => {
      console.log(`[SRC:${s.name}] TCP connected`);
      this._onConnected(id);
    });

    socket.on('data', chunk => this._onData(id, chunk.toString('ascii')));
    socket.on('error', err => {
      console.error(`[SRC:${s.name}] TCP error: ${err.message}`);
      this._onDisconnected(id);
    });
    socket.on('close', () => {
      console.warn(`[SRC:${s.name}] TCP closed`);
      this._onDisconnected(id);
    });
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.on('timeout', () => { console.warn(`[SRC:${s.name}] TCP timeout`); socket.destroy(); });
  }

  // ── SERIAL CONNECTION ─────────────────────────────
  _connectSerial(id, s) {
    if (!SerialPort) {
      console.error(`[SRC:${s.name}] serialport module tidak tersedia`);
      this._setStatus(id, 'error');
      return;
    }

    console.log(`[SRC:${s.name}] Serial → ${s.port} @ ${s.baudRate} baud`);
    this._setStatus(id, 'connecting');

    let sp;
    try {
      sp = new SerialPort({
        path    : s.port,
        baudRate: s.baudRate,
        dataBits: s.dataBits,
        stopBits: s.stopBits,
        parity  : s.parity,
        autoOpen: false,
      });
    } catch (e) {
      console.error(`[SRC:${s.name}] Serial init error: ${e.message}`);
      this._onDisconnected(id);
      return;
    }

    // Use readline parser — NMEA sentences end with \r\n or \n
    const parser = sp.pipe(new ReadlineParser({ delimiter: '\n', encoding: 'ascii' }));

    const ctx = { type: 'serial', sp, parser };
    this.conns.set(id, ctx);

    sp.open(err => {
      if (err) {
        console.error(`[SRC:${s.name}] Serial open error: ${err.message}`);
        this._onDisconnected(id);
        return;
      }
      console.log(`[SRC:${s.name}] Serial opened: ${s.port}`);
      this._onConnected(id);
    });

    parser.on('data', line => {
      const src = this.sources.get(id);
      if (!src) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      src.rxTotal++;
      this.sources.set(id, src);
      this._parseLine(id, trimmed);
    });

    sp.on('error', err => {
      console.error(`[SRC:${s.name}] Serial error: ${err.message}`);
      this._onDisconnected(id);
    });

    sp.on('close', () => {
      console.warn(`[SRC:${s.name}] Serial closed`);
      this._onDisconnected(id);
    });
  }

  // ── AISHUB ALTERNATING SCHEDULER ─────────────────
  // Satu scheduler per username — gilir request antar wilayah
  // Jarak antar request selalu SAFE_GAP_MS (tidak terlimit)

  // ══════════════════════════════════════════════════
  //  AISHUB ALTERNATING SCHEDULER — v2
  //  Fix: error poll TIDAK memanggil _onDisconnected
  //  sehingga tidak ada reconnect loop
  // ══════════════════════════════════════════════════

  _connectAISHub(id, s) {
    // Langsung set connecting — scheduler yang tentukan connected/error
    this._setStatus(id, 'connecting');
    this._aishubRegister(id, s);
  }

  _aishubRegister(id, s) {
    if (!this._aishubSchedulers) this._aishubSchedulers = new Map();
    const username = s.username;

    if (!this._aishubSchedulers.has(username)) {
      this._aishubSchedulers.set(username, {
        username,
        queue  : [],
        running: false,
        timer  : null,
        _idx   : 0,
      });
      console.log(`[AISHub] Scheduler baru: ${username}`);
    }

    const sched = this._aishubSchedulers.get(username);
    if (!sched.queue.includes(id)) {
      sched.queue.push(id);
      console.log(`[AISHub] "${s.name}" masuk antrian (total: ${sched.queue.length} wilayah)`);
    }

    if (!sched.running) this._aishubSchedulerRun(username);
  }

  _aishubUnregister(id) {
    if (!this._aishubSchedulers) return;
    for (const [username, sched] of this._aishubSchedulers) {
      const idx = sched.queue.indexOf(id);
      if (idx < 0) continue;
      sched.queue.splice(idx, 1);
      // Sesuaikan index agar tidak skip wilayah
      if (sched._idx > idx) sched._idx--;
      sched._idx = sched.queue.length ? sched._idx % sched.queue.length : 0;
      console.log(`[AISHub] "${this.sources.get(id)?.name}" keluar antrian (sisa: ${sched.queue.length})`);
      if (sched.queue.length === 0) {
        if (sched.timer) { clearTimeout(sched.timer); sched.timer = null; }
        sched.running = false;
        this._aishubSchedulers.delete(username);
        console.log(`[AISHub] Scheduler "${username}" dihentikan`);
      }
      break;
    }
  }

  _aishubSchedulerRun(username) {
    const sched = this._aishubSchedulers?.get(username);
    if (!sched || sched.running) return;
    sched.running = true;

    const tick = async () => {
      if (!sched.queue.length) { sched.running = false; return; }

      // Round-robin — ambil giliran berikutnya
      sched._idx = sched._idx % sched.queue.length;
      const id   = sched.queue[sched._idx];
      sched._idx++;

      const src = this.sources.get(id);

      // Wilayah dinonaktifkan → lewati tapi tetap jaga gap 70s
      if (!src || !src.enabled) {
        this._setStatus(id, 'disabled');
        sched.timer = setTimeout(tick, 70_000);
        return;
      }

      // Hitung gap: intervalSec ÷ jumlah wilayah, minimal 70s
      const n      = sched.queue.length;
      const avgSec = sched.queue.reduce((sum, qid) => {
        return sum + (this.sources.get(qid)?.intervalSec || 70);
      }, 0) / n;
      const gapSec = Math.max(70, Math.round(avgSec));

      console.log(`[AISHub|${username}] → "${src.name}" (${sched._idx}/${n}) gap:${gapSec}s efektif:${gapSec*n}s`);

      // Poll — error tidak memanggil _onDisconnected agar tidak ada reconnect loop
      await this._aishubPoll(id, src);

      // Jadwalkan tick berikutnya dengan gap aman
      if (sched.queue.length > 0 && sched.running) {
        sched.timer = setTimeout(tick, gapSec * 1000);
      } else {
        sched.running = false;
      }
    };

    // Mulai segera
    tick();
  }

  async _aishubPoll(id, src) {
    const url = `https://data.aishub.net/ws.php`
      + `?username=${encodeURIComponent(src.username)}`
      + `&format=1&output=json&compress=0`
      + `&latmin=${src.latMin}&latmax=${src.latMax}`
      + `&lonmin=${src.lonMin}&lonmax=${src.lonMax}`;

    let s = this.sources.get(id);
    if (!s) return;

    try {
      const data = await this._fetchJSON(url);

      // AISHub error response
      if (!Array.isArray(data)) throw new Error('Response bukan array');
      if (data[0]?.ERROR === true || (typeof data[0]?.ERROR === 'string' && data[0]?.ERROR !== 'false')) {
        throw new Error(`AISHub error: ${JSON.stringify(data[0])}`);
      }

      const meta  = data[0] || {};
      const ships = Array.isArray(data[1]) ? data[1] : [];

      // Re-fetch setelah await (mungkin sudah berubah)
      s = this.sources.get(id);
      if (!s) return;

      // Set connected hanya jika sebelumnya bukan connected
      // TANPA memanggil mailer/alert agar tidak spam
      if (s.status !== 'connected') {
        s.status        = 'connected';
        s.lastConnected = Date.now();
        this.sources.set(id, s);
        this.save();
        this._broadcast();
        console.log(`[AISHub] "${s.name}" → connected`);
      }

      s.rxTotal  += ships.length;
      s.lastPoll  = Date.now();
      this.sources.set(id, s);

      let decoded = 0;
      for (const ship of ships) {
        const mapped = this._mapAISHubShip(ship);
        if (mapped) {
          decoded++;
          this.emit('decoded', { sourceId: id, sourceName: s.name, decoded: mapped });
        }
      }
      s.rxDecoded += decoded;
      this.sources.set(id, s);

      const n = this._aishubSchedulers?.get(src.username)?.queue?.length || 1;
      console.log(`[AISHub] "${s.name}" ✓ ${ships.length} kapal | records area: ${meta.RECORDS ?? '?'} | wilayah: ${n}`);

    } catch (e) {
      // ── PENTING: JANGAN panggil _onDisconnected ──
      // Cukup set status 'error', scheduler tetap jalan giliran berikutnya
      s = this.sources.get(id);
      if (s && s.status !== 'error') {
        s.status = 'error';
        this.sources.set(id, s);
        this._broadcast();
      }
      console.error(`[AISHub] "${src.name}" poll gagal: ${e.message}`);
    }
  }

  // HTTP GET helper — returns parsed JSON
  _fetchJSON(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 30_000 }, res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  // Map AISHub human-readable JSON → decoded object (same shape as NMEA decoded)
  _mapAISHubShip(ship) {
    if (!ship.MMSI || !ship.LATITUDE || !ship.LONGITUDE) return null;
    return {
      type      : 'classA',
      mmsi      : String(ship.MMSI),
      lat       : ship.LATITUDE,
      lon       : ship.LONGITUDE,
      sog       : ship.SOG === 102.3 ? null : ship.SOG,
      cog       : ship.COG === 360   ? null : ship.COG,
      heading   : ship.HEADING === 511 ? undefined : ship.HEADING,
      rot       : ship.ROT,
      status    : AISHUB_NAVSTAT[ship.NAVSTAT] ?? 'Undefined',
      name      : (ship.NAME?.trim() || '').replace(/@+$/g,'').trim() || null,
      callsign  : ship.CALLSIGN?.trim() || null,
      imo       : ship.IMO > 0 ? String(ship.IMO) : null,
      shipType  : AISHUB_SHIP_TYPE[ship.TYPE] || null,
      destination: ship.DEST?.trim() || null,
      draught   : ship.DRAUGHT > 0 ? ship.DRAUGHT : null,
      dimBow    : ship.A, dimStern: ship.B,
      dimPort   : ship.C, dimStbd: ship.D,
      ts        : new Date().toLocaleTimeString('id-ID'),
      _aishubTime: ship.TIME,
    };
  }

  // ── AISHUB CONNECTION LIFECYCLE ───────────────────
  // Override reconnect delay for aishub (no reconnect — poll handles it)

  // ── CONNECTED / DISCONNECTED ─────────────────────
  _onConnected(id) {
    const s = this.sources.get(id);
    if (!s) return;
    s.status         = 'connected';
    s.lastConnected  = Date.now();
    this.sources.set(id, s);
    this.save();
    this._broadcast();
    mailer.handleReconnect(s);
  }

  _onDisconnected(id) {
    const s = this.sources.get(id);
    if (!s) return;
    const wasConnected = s.status === 'connected';
    s.status          = 'disconnected';
    s.lastDisconnected = Date.now();
    if (wasConnected) s.reconnectCount = (s.reconnectCount || 0) + 1;
    this.sources.set(id, s);
    this.save();
    this._broadcast();

    if (s.alertEnabled && wasConnected) mailer.scheduleDisconnectAlert(s);

    // Schedule reconnect (not for aishub — poll interval handles reconnect)
    if (s.enabled && s.type !== 'aishub') {
      const delay = s.type === 'serial' ? SERIAL_RECONNECT_MS : TCP_RECONNECT_MS;
      if (this.reconnTimers.has(id)) clearTimeout(this.reconnTimers.get(id));
      this.reconnTimers.set(id, setTimeout(() => {
        this.reconnTimers.delete(id);
        if (this.sources.get(id)?.enabled) this._connect(id);
      }, delay));
    }
  }

  _disconnect(id) {
    if (this.reconnTimers.has(id)) { clearTimeout(this.reconnTimers.get(id)); this.reconnTimers.delete(id); }
    const ctx = this.conns.get(id);
    if (ctx) {
      try {
        if (ctx.type === 'tcp')    ctx.socket.destroy();
        if (ctx.type === 'serial') ctx.sp.isOpen && ctx.sp.close();
        if (ctx.type === 'aishub') this._aishubUnregister(id);
      } catch {}
      this.conns.delete(id);
    }
  }

  _setStatus(id, status) {
    const s = this.sources.get(id);
    if (!s) return;
    s.status = status;
    this.sources.set(id, s);
    this._broadcast();
  }

  // ── DATA PROCESSING ───────────────────────────────
  _onData(id, text) {
    const s = this.sources.get(id);
    const ctx = this.conns.get(id);
    if (!s || !ctx) return;

    ctx.lineBuffer += text;
    const lines = ctx.lineBuffer.split('\n');
    ctx.lineBuffer  = lines.pop();

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      s.rxTotal++;
      this._parseLine(id, line);
    }
    this.sources.set(id, s);
  }

  _parseLine(id, line) {
    let nmea = null;
    if (line.startsWith('!AIVDM') || line.startsWith('!AIVDO')) {
      nmea = line;
    } else {
      const m = line.match(/(!AIVD[MO],[^\r\n*]+\*[0-9A-Fa-f]{2})/);
      if (m) nmea = m[1];
    }
    if (!nmea) return;

    const decoded = parseSentence(nmea);
    if (decoded) {
      const s = this.sources.get(id);
      if (s) { s.rxDecoded++; this.sources.set(id, s); }
      this.emit('decoded', { sourceId: id, sourceName: this.sources.get(id)?.name || id, decoded });
    }
  }

  // ── SERIAL PORT LISTING ───────────────────────────
  static async listSerialPorts() {
    if (!SerialPort) return { available: false, error: 'serialport module tidak tersedia', ports: [] };
    try {
      const ports = await SerialPort.list();
      return {
        available: true,
        ports: ports.map(p => ({
          path        : p.path,
          manufacturer: p.manufacturer || null,
          serialNumber: p.serialNumber || null,
          vendorId    : p.vendorId || null,
          productId   : p.productId || null,
          pnpId       : p.pnpId || null,
        })),
      };
    } catch (e) {
      return { available: true, error: e.message, ports: [] };
    }
  }

  // ── BROADCAST ─────────────────────────────────────
  _broadcast() {
    this.emit('sources-updated', this.list());
  }

  _view(s) {
    const base = {
      id              : s.id,
      type            : s.type,
      name            : s.name,
      enabled         : s.enabled,
      alertEnabled    : s.alertEnabled,
      alertEmail      : s.alertEmail,
      status          : s.status,
      reconnectCount  : s.reconnectCount,
      rxTotal         : s.rxTotal,
      rxDecoded       : s.rxDecoded,
      lastConnected   : s.lastConnected,
      lastDisconnected: s.lastDisconnected,
      createdAt       : s.createdAt,
    };
    if (s.type === 'tcp') {
      base.host = s.host;
      base.tcpPort = s.port;
    }
    if (s.type === 'serial') {
      base.port     = s.port;
      base.baudRate = s.baudRate;
      base.dataBits = s.dataBits;
      base.stopBits = s.stopBits;
      base.parity   = s.parity;
    }
    if (s.type === 'aishub') {
      base.username    = s.username;
      base.latMin      = s.latMin;
      base.latMax      = s.latMax;
      base.lonMin      = s.lonMin;
      base.lonMax      = s.lonMax;
      base.intervalSec = s.intervalSec || 70;
      base.lastPoll    = s.lastPoll;
      // Interval efektif: 70s × jumlah wilayah dengan username sama
      const sched = this._aishubSchedulers?.get(s.username);
      const wCount2 = sched ? sched.queue.length : 1;
      const avgSec2 = sched ? sched.queue.reduce((sum,qid)=>{
        const qs=this.sources.get(qid); return sum+((qs?.intervalSec||70));
      },0)/wCount2 : (s.intervalSec||70);
      const gapSec2 = Math.max(70, Math.round(avgSec2));
      base.effectiveIntervalSec = gapSec2 * wCount2;
      base.gapSec = gapSec2;
      base.wilayahCount = wCount2;
    }
    return base;
  }

  static get SERIAL_DEFAULTS() { return { ...SERIAL_DEFAULTS }; }
}

module.exports = SourceManager;
