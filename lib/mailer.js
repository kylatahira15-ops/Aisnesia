/**
 * mailer.js
 * Email alert system untuk AIS source monitoring
 * Supports: Gmail App Password, Outlook, custom SMTP
 */

'use strict';

const nodemailer = require('nodemailer');

// ── CONFIG ────────────────────────────────────────
const SMTP_CFG = {
  host   : process.env.SMTP_HOST   || 'smtp.gmail.com',
  port   : parseInt(process.env.SMTP_PORT) || 587,
  secure : process.env.SMTP_SECURE === 'true',
  auth   : {
    user : process.env.SMTP_USER || '',
    pass : process.env.SMTP_PASS || '',
  },
};

const ALERT_FROM     = process.env.ALERT_FROM || `AIS Tracker <${SMTP_CFG.auth.user}>`;
const ALERT_TO_GLOBAL= process.env.ALERT_TO   || '';
// Delay sebelum kirim alert (menghindari false alarm saat koneksi sesaat putus)
const ALERT_DELAY_MS = (parseFloat(process.env.ALERT_DELAY_MINUTES) || 5) * 60_000;
// Cooldown antar alert agar tidak spam
const ALERT_COOLDOWN_MS = (parseFloat(process.env.ALERT_COOLDOWN_MINUTES) || 30) * 60_000;

let transporter = null;
let enabled     = false;

function init() {
  if (!SMTP_CFG.auth.user || !SMTP_CFG.auth.pass) {
    console.log('[MAIL] SMTP tidak dikonfigurasi — notifikasi email dinonaktifkan');
    return;
  }
  transporter = nodemailer.createTransport(SMTP_CFG);
  transporter.verify((err) => {
    if (err) {
      console.warn('[MAIL] SMTP verify gagal:', err.message);
      enabled = false;
    } else {
      console.log(`[MAIL] SMTP siap → ${SMTP_CFG.host}:${SMTP_CFG.port}`);
      enabled = true;
    }
  });
}

// ── PENDING ALERT TIMERS ──────────────────────────
// sourceId → { timer, sentAt }
const pending  = new Map(); // disconnect timer per source
const lastSent = new Map(); // timestamp of last sent alert per source

// ── SEND ──────────────────────────────────────────
async function send(to, subject, html) {
  if (!enabled || !transporter) return false;
  try {
    await transporter.sendMail({ from: ALERT_FROM, to, subject, html });
    console.log(`[MAIL] Sent → ${to} | ${subject}`);
    return true;
  } catch (e) {
    console.error('[MAIL] Send error:', e.message);
    return false;
  }
}

// ── SCHEDULE DISCONNECT ALERT ────────────────────
/**
 * Panggil ketika source TCP disconnect.
 * Alert dikirim setelah ALERT_DELAY_MS jika belum reconnect.
 */
function scheduleDisconnectAlert(source) {
  const id      = source.id;
  const emailTo = source.alertEmail || ALERT_TO_GLOBAL;
  if (!emailTo) return;

  // Batalkan timer sebelumnya jika ada
  cancelAlert(id);

  const timer = setTimeout(async () => {
    pending.delete(id);

    // Cek cooldown
    const last = lastSent.get(id) || 0;
    if (Date.now() - last < ALERT_COOLDOWN_MS) return;

    lastSent.set(id, Date.now());
    const downSince = source.lastDisconnected
      ? new Date(source.lastDisconnected).toLocaleString('id-ID')
      : new Date().toLocaleString('id-ID');

    await send(
      emailTo,
      `🔴 [AIS Alert] Sumber "${source.name}" TERPUTUS`,
      htmlDisconnect(source, downSince),
    );
  }, ALERT_DELAY_MS);

  pending.set(id, timer);
}

/**
 * Panggil ketika source TCP reconnect.
 * Membatalkan timer alert dan mengirim email recovery jika alert sudah pernah dikirim.
 */
async function handleReconnect(source) {
  const id      = source.id;
  const wasDown = cancelAlert(id);
  const emailTo = source.alertEmail || ALERT_TO_GLOBAL;
  if (!emailTo) return;

  // Kirim recovery hanya jika alert sudah pernah terkirim
  const last = lastSent.get(id) || 0;
  if (!wasDown && last > 0 && Date.now() - last < ALERT_COOLDOWN_MS * 4) {
    lastSent.delete(id);
    await send(
      emailTo,
      `🟢 [AIS Recovery] Sumber "${source.name}" TERHUBUNG KEMBALI`,
      htmlReconnect(source),
    );
  }
}

function cancelAlert(id) {
  if (pending.has(id)) {
    clearTimeout(pending.get(id));
    pending.delete(id);
    return true;
  }
  return false;
}

// ── TEST EMAIL ────────────────────────────────────
async function sendTest(to) {
  return send(to, '✅ [AIS Tracker] Test Email Berhasil', htmlTest());
}

// ── HTML TEMPLATES ────────────────────────────────
// ── EMAIL HTML TEMPLATES (Light Theme) ───────────────
function baseHtml(body) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,Helvetica,sans-serif;background:#f0f4f8;color:#1a2a3a;margin:0;padding:24px 12px}
  .wrap{max-width:580px;margin:0 auto}
  .brand{text-align:center;padding:20px 0 14px}
  .brand-icon{font-size:32px}
  .brand-name{font-size:13px;font-weight:700;color:#0070d8;letter-spacing:.5px;margin-top:4px}
  .card{background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08),0 0 0 1px rgba(0,0,0,.06)}
  .hdr{padding:22px 26px;display:flex;align-items:center;gap:14px}
  .hdr-icon{font-size:36px;line-height:1;flex-shrink:0}
  .hdr-title{font-size:19px;font-weight:700;line-height:1.2}
  .hdr-sub{font-size:12px;color:#6b8aaa;margin-top:4px}
  .body{padding:20px 26px}
  .section-label{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#8aa0b8;font-weight:700;margin:16px 0 8px;padding-bottom:4px;border-bottom:1px solid #e8edf2}
  .section-label:first-child{margin-top:0}
  .row{display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;border-bottom:1px solid #f0f4f8;gap:12px;font-size:13px}
  .row:last-child{border-bottom:none}
  .key{color:#6b8aaa;white-space:nowrap;flex-shrink:0}
  .val{font-weight:600;color:#1a2a3a;text-align:right;word-break:break-word}
  .badge{display:inline-block;padding:3px 11px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.3px}
  .badge-red  {background:#fff0f2;color:#d41434;border:1px solid #ffc5cc}
  .badge-green{background:#f0fff6;color:#0a7a3c;border:1px solid #b3f0cc}
  .badge-blue {background:#f0f8ff;color:#0058b0;border:1px solid #b3d6f5}
  .note{font-size:12px;color:#5a7a9a;line-height:1.65;margin-top:14px;padding:12px 14px;background:#f7fafd;border-left:3px solid #ccdcef;border-radius:0 8px 8px 0}
  .maps-btn{display:inline-block;margin-top:10px;padding:8px 18px;background:#0070d8;color:#fff;border-radius:8px;text-decoration:none;font-size:12px;font-weight:600}
  .footer{background:#f7fafd;border-top:1px solid #e8edf2;padding:14px 26px;display:flex;align-items:center;justify-content:space-between;gap:8px}
  .footer-logo{font-size:13px;font-weight:700;color:#0070d8}
  .footer-time{font-size:11px;color:#8aa0b8}
</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}

const NOW = () => new Date().toLocaleString('id-ID', {
  day:'2-digit', month:'long', year:'numeric',
  hour:'2-digit', minute:'2-digit', second:'2-digit'
});

function htmlDisconnect(source, downSince) {
  const connInfo = source.type === 'serial'
    ? `${source.port} @ ${source.baudRate} baud`
    : `${source.host}:${source.port}`;
  return baseHtml(`
  <div class="brand"><div class="brand-icon">🚢</div><div class="brand-name">AIS REALTIME TRACKER</div></div>
  <div class="card">
    <div class="hdr" style="background:linear-gradient(135deg,#fff0f2 0%,#ffe4e8 100%);border-bottom:3px solid #ff4d67">
      <div class="hdr-icon">🔴</div>
      <div>
        <div class="hdr-title" style="color:#c0001e">Sumber AIS Terputus</div>
        <div class="hdr-sub">Memerlukan perhatian segera</div>
      </div>
    </div>
    <div class="body">
      <div class="section-label">Informasi Sumber</div>
      <div class="row"><span class="key">Nama Sumber</span><span class="val">${esc(source.name)}</span></div>
      <div class="row"><span class="key">Koneksi</span><span class="val">${esc(connInfo)}</span></div>
      <div class="row"><span class="key">Tipe</span><span class="val">${source.type === 'serial' ? 'Serial / COM' : 'TCP / Network'}</span></div>
      <div class="row"><span class="key">Status</span><span class="val"><span class="badge badge-red">DISCONNECTED</span></span></div>
      <div class="row"><span class="key">Terputus Sejak</span><span class="val">${downSince}</span></div>
      <div class="row"><span class="key">Percobaan Reconnect</span><span class="val">${source.reconnectCount || 0} kali</span></div>
      <div class="row"><span class="key">Total Data Diterima</span><span class="val">${(source.rxTotal||0).toLocaleString('id-ID')} sentences</span></div>
      <div class="note">Sistem AIS <b>${esc(source.name)}</b> tidak dapat dijangkau sejak <b>${downSince}</b>. Server akan terus mencoba reconnect otomatis setiap 5 detik. Segera periksa koneksi jaringan dan pastikan perangkat AIS aktif.</div>
    </div>
    <div class="footer"><span class="footer-logo">🚢 AIS Tracker</span><span class="footer-time">${NOW()}</span></div>
  </div>`);
}

function htmlReconnect(source) {
  const connInfo = source.type === 'serial'
    ? `${source.port} @ ${source.baudRate} baud`
    : `${source.host}:${source.port}`;
  return baseHtml(`
  <div class="brand"><div class="brand-icon">🚢</div><div class="brand-name">AIS REALTIME TRACKER</div></div>
  <div class="card">
    <div class="hdr" style="background:linear-gradient(135deg,#f0fff6 0%,#d6f5e4 100%);border-bottom:3px solid #2ecc71">
      <div class="hdr-icon">🟢</div>
      <div>
        <div class="hdr-title" style="color:#0a7a3c">Sumber AIS Terhubung Kembali</div>
        <div class="hdr-sub">Koneksi pulih secara otomatis</div>
      </div>
    </div>
    <div class="body">
      <div class="section-label">Informasi Sumber</div>
      <div class="row"><span class="key">Nama Sumber</span><span class="val">${esc(source.name)}</span></div>
      <div class="row"><span class="key">Koneksi</span><span class="val">${esc(connInfo)}</span></div>
      <div class="row"><span class="key">Status</span><span class="val"><span class="badge badge-green">CONNECTED</span></span></div>
      <div class="row"><span class="key">Terhubung Kembali</span><span class="val">${NOW()}</span></div>
      <div class="note">Sumber AIS <b>${esc(source.name)}</b> telah berhasil terhubung kembali. Data kapal realtime sudah kembali diterima secara normal.</div>
    </div>
    <div class="footer"><span class="footer-logo">🚢 AIS Tracker</span><span class="footer-time">${NOW()}</span></div>
  </div>`);
}

function htmlTest() {
  return baseHtml(`
  <div class="brand"><div class="brand-icon">🚢</div><div class="brand-name">AIS REALTIME TRACKER</div></div>
  <div class="card">
    <div class="hdr" style="background:linear-gradient(135deg,#f0f8ff 0%,#dceeff 100%);border-bottom:3px solid #0070d8">
      <div class="hdr-icon">✅</div>
      <div>
        <div class="hdr-title" style="color:#0058b0">Test Email Berhasil</div>
        <div class="hdr-sub">Konfigurasi SMTP berjalan normal</div>
      </div>
    </div>
    <div class="body">
      <div class="section-label">Konfigurasi SMTP</div>
      <div class="row"><span class="key">SMTP Host</span><span class="val">${SMTP_CFG.host}:${SMTP_CFG.port}</span></div>
      <div class="row"><span class="key">Waktu Test</span><span class="val">${NOW()}</span></div>
      <div class="note">Email notifikasi AIS Tracker sudah dikonfigurasi dengan benar. Anda akan menerima alert otomatis ketika sumber TCP/Serial terputus atau kapal memasuki/meninggalkan zona geofence.</div>
    </div>
    <div class="footer"><span class="footer-logo">🚢 AIS Tracker</span><span class="footer-time">${NOW()}</span></div>
  </div>`);
}

// ── GEOFENCE ALERTS ───────────────────────────────
async function sendGeofenceAlert(event, zone, ship) {
  const emailTo = zone.alertEmail || ALERT_TO_GLOBAL;
  if (!emailTo) return false;
  const isEnter = event === 'enter';
  const icon    = isEnter ? '🚨' : '🟡';
  const action  = isEnter ? 'MEMASUKI' : 'MENINGGALKAN';
  const subject = `${icon} [AIS Geofence] Kapal ${ship.name || ship.mmsi} ${action} zona "${zone.name}"`;
  return send(emailTo, subject, htmlGeofence(event, zone, ship));
}

function htmlGeofence(event, zone, ship) {
  const isEnter   = event === 'enter';
  const icon      = isEnter ? '🚨' : '🟡';
  const action    = isEnter ? 'MEMASUKI' : 'MENINGGALKAN';
  const hdrBg     = isEnter
    ? 'linear-gradient(135deg,#fff4f0 0%,#ffe8e0 100%)'
    : 'linear-gradient(135deg,#fffef0 0%,#fff8d6 100%)';
  const hdrBorder = isEnter ? '#ff6b3d' : '#f0b429';
  const titleColor= isEnter ? '#c0380a' : '#8a6400';
  const badgeClass= isEnter ? 'badge-red' : 'badge' ; // custom below for yellow
  const badgeStyle= isEnter
    ? 'background:#fff0ec;color:#c0380a;border:1px solid #ffcab8'
    : 'background:#fffbea;color:#7a5500;border:1px solid #ffe08a';

  const shipName   = esc(ship.name || `MMSI ${ship.mmsi}`);
  const now        = NOW();
  const lat        = ship.lat?.toFixed(5) ?? '—';
  const lon        = ship.lon?.toFixed(5) ?? '—';
  const sog        = ship.sog  != null ? `${ship.sog.toFixed(1)} knot`  : '—';
  const cog        = ship.cog  != null ? `${ship.cog.toFixed(1)}°`      : '—';
  const hdg        = ship.heading != null ? `${ship.heading}°`           : '—';
  const googleMaps = ship.lat
    ? `https://maps.google.com/?q=${ship.lat},${ship.lon}`
    : null;

  return baseHtml(`
  <div class="brand"><div class="brand-icon">🚢</div><div class="brand-name">AIS REALTIME TRACKER — GEOFENCE ALERT</div></div>
  <div class="card">
    <div class="hdr" style="background:${hdrBg};border-bottom:3px solid ${hdrBorder}">
      <div class="hdr-icon">${icon}</div>
      <div>
        <div class="hdr-title" style="color:${titleColor}">Kapal ${action} Zona Geofence</div>
        <div class="hdr-sub">${now}</div>
      </div>
    </div>
    <div class="body">
      <p style="font-size:14px;color:#1a2a3a;line-height:1.6;margin-bottom:4px">
        Kapal <strong>${shipName}</strong> terdeteksi <strong>${action.toLowerCase()}</strong>
        zona geofence <strong>${esc(zone.name)}</strong>.
      </p>

      <div class="section-label">Informasi Kapal</div>
      <div class="row"><span class="key">Nama Kapal</span><span class="val">${shipName}</span></div>
      <div class="row"><span class="key">MMSI</span><span class="val">${ship.mmsi}</span></div>
      ${ship.imo ? `<div class="row"><span class="key">IMO</span><span class="val">${ship.imo}</span></div>` : ''}
      ${ship.callsign ? `<div class="row"><span class="key">Call Sign</span><span class="val">${esc(ship.callsign)}</span></div>` : ''}
      ${ship.shipType ? `<div class="row"><span class="key">Jenis Kapal</span><span class="val">${esc(ship.shipType)}</span></div>` : ''}
      <div class="row"><span class="key">Kecepatan</span><span class="val">${sog}</span></div>
      <div class="row"><span class="key">COG / Heading</span><span class="val">${cog} / ${hdg}</span></div>
      ${ship.navStatus ? `<div class="row"><span class="key">Status Navigasi</span><span class="val">${esc(ship.navStatus)}</span></div>` : ''}
      ${ship.destination ? `<div class="row"><span class="key">Tujuan</span><span class="val">${esc(ship.destination)}</span></div>` : ''}
      <div class="row"><span class="key">Koordinat</span><span class="val">${lat}, ${lon}</span></div>
      ${googleMaps ? `<div style="margin-top:10px"><a href="${googleMaps}" class="maps-btn">📍 Lihat Posisi di Google Maps →</a></div>` : ''}

      <div class="section-label">Zona Geofence</div>
      <div class="row"><span class="key">Nama Zona</span><span class="val">${esc(zone.name)}</span></div>
      ${zone.description ? `<div class="row"><span class="key">Keterangan</span><span class="val">${esc(zone.description)}</span></div>` : ''}
      <div class="row"><span class="key">Event</span><span class="val"><span class="badge" style="${badgeStyle};padding:3px 11px;border-radius:20px;font-size:11px;font-weight:700">${action}</span></span></div>
      <div class="row"><span class="key">Waktu Deteksi</span><span class="val">${now}</span></div>
    </div>
    <div class="footer"><span class="footer-logo">🚢 AIS Tracker</span><span class="footer-time">${now}</span></div>
  </div>`);
}

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

module.exports = {
  init,
  sendTest,
  scheduleDisconnectAlert,
  handleReconnect,
  cancelAlert,
  sendGeofenceAlert,
  isEnabled: () => enabled,
  config: { ALERT_DELAY_MS, ALERT_COOLDOWN_MS },
};
