"use strict";

let SerialPort;
try {
  ({ SerialPort } = require("serialport"));
} catch (e) {
  console.warn("[ACT] Modul serialport tidak tersedia:", e.message);
}
 
// ── KONFIG ─────────────────────────────────────────────────
const ACTUATOR_PORT = process.env.ACTUATOR_PORT || "";
const ACTUATOR_BAUD = parseInt(process.env.ACTUATOR_BAUD) || 115200;
const YOLO_STATUS_URL =
  process.env.YOLO_STATUS_URL || "http://localhost:5000/api/status";
 
// Zona sandar dicari lewat NAMA, bukan luas polygon.
// DOCK_ZONE_ID (kalau diisi) menang di atas nama.
const DOCK_ZONE_ID = process.env.DOCK_ZONE_ID || "";
const DOCK_ZONE_NAME = (process.env.DOCK_ZONE_NAME || "zona 2").toLowerCase();
 
// true  (default) → SALAH hanya saat AIS benar-benar kosong di semua zona
// false           → kapal di zona luar + deteksi kamera juga dianggap SALAH
const STRICT_MISMATCH = process.env.STRICT_MISMATCH !== "false";
 
const TICK_MS = 1000; // hitung ulang tiap 1 detik
const HEARTBEAT_MS = 3000; // kirim ulang ke serial walau tidak berubah
 
// ── STATE ──────────────────────────────────────────────────
let geoMgr = null;
let broadcast = () => {};
let port = null;
 
const status = {
  state: "idle", // idle | green | yellow | red | error
  line: "0,0,0,0", // outer,zone2,sync,err  ← dibaca /api/actuator/line
  cameraDetected: false,
  cameraOnline: false, // server YOLO bisa dihubungi?
  cameraRunning: false, // thread kamera hidup?
  cameraError: null, // pesan error dari app.py
  modelLoaded: false,
  inDock: false,
  inOuter: false,
  mismatch: false,
  dockZoneId: null,
};
 
let lastLineSent = "";
let lastSentAt = 0;
let warnedNoDockZone = false;
 
// ── PILIH ZONA SANDAR ──────────────────────────────────────
function pickDockZoneId(zones) {
  if (DOCK_ZONE_ID) return DOCK_ZONE_ID;
  if (!zones.length) return null;
 
  // 1. cocok persis: "zona 2"
  let z = zones.find(
    (x) => (x.name || "").trim().toLowerCase() === DOCK_ZONE_NAME,
  );
 
  // 2. cocok sebagian: "Zona 2 Dermaga Barat" tetap kena
  if (!z) {
    z = zones.find((x) => (x.name || "").toLowerCase().includes(DOCK_ZONE_NAME));
  }
 
  if (!z) {
    if (!warnedNoDockZone) {
      warnedNoDockZone = true;
      console.warn(
        `[ACT] Zona sandar "${DOCK_ZONE_NAME}" tidak ditemukan. Zona yang ada: ` +
          (zones.map((x) => x.name).join(", ") || "(kosong)"),
      );
    }
    return null;
  }
 
  warnedNoDockZone = false;
  return z.id;
}
 
// ── SERIAL (mode kabel USB — idle kalau pakai WiFi) ─────────
function openSerial() {
  if (!SerialPort || !ACTUATOR_PORT) {
    console.warn(
      "[ACT] Serial kabel nonaktif (ACTUATOR_PORT kosong). Mode WiFi/broadcast saja.",
    );
    return;
  }
  try {
    port = new SerialPort(
      { path: ACTUATOR_PORT, baudRate: ACTUATOR_BAUD },
      (err) => {
        if (err) {
          console.error(`[ACT] Gagal buka ${ACTUATOR_PORT}: ${err.message}`);
          port = null;
          setTimeout(openSerial, 5000);
        } else {
          console.log(
            `[ACT] Arduino terhubung di ${ACTUATOR_PORT} @ ${ACTUATOR_BAUD}`,
          );
        }
      },
    );
    port.on("data", (buf) => {
      const s = buf.toString().trim();
      if (s) console.log(`[ACT<-Arduino] ${s}`);
    });
    port.on("error", (err) =>
      console.error(`[ACT] Serial error: ${err.message}`),
    );
    port.on("close", () => {
      console.warn("[ACT] Serial tertutup, reconnect...");
      port = null;
      setTimeout(openSerial, 5000);
    });
  } catch (e) {
    console.error(`[ACT] Serial init error: ${e.message}`);
    setTimeout(openSerial, 5000);
  }
}
 
function writeToArduino(line) {
  if (port && port.writable) port.write(line + "\n");
}
 
// ── POLL KAMERA YOLO ───────────────────────────────────────
async function pollCamera() {
  try {
    const res = await fetch(YOLO_STATUS_URL, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const j = await res.json();
      status.cameraOnline = true;
      status.cameraRunning = !!j.running;
      status.cameraError = j.error || null;
      status.modelLoaded = !!j.model_loaded;
 
      // PENTING: app.py tidak me-reset 'detected' saat kamera berhenti,
      // jadi nilainya bisa basi. Abaikan deteksi kalau kamera tidak running.
      status.cameraDetected = !!j.detected && !!j.running;
      return;
    }
  } catch (_) {
    /* server YOLO mati / tidak bisa dihubungi */
  }
 
  // Fail-safe: kamera tidak terjangkau → anggap tidak ada deteksi.
  // Merah tidak akan pernah menyala, SALAH tidak akan pernah aktif.
  status.cameraOnline = false;
  status.cameraRunning = false;
  status.cameraDetected = false;
}
 
// ── HITUNG STATE & KIRIM ───────────────────────────────────
function computeAndSend() {
  let inDock = false;
  let inOuter = false;
  const dockShips = [];
  const outerShips = [];
  let dockZoneId = null;
 
  if (geoMgr) {
    const zones = geoMgr
      .list()
      .filter(
        (z) =>
          z.enabled !== false &&
          Array.isArray(z.polygon) &&
          z.polygon.length >= 3,
      );
 
    dockZoneId = pickDockZoneId(zones);
 
    for (const z of zones) {
      const inside = geoMgr.getShipsInside(z.id);
      if (!inside.length) continue;
      if (z.id === dockZoneId) {
        inDock = true;
        dockShips.push(...inside);
      } else {
        inOuter = true;
        outerShips.push(...inside);
      }
    }
  }
 
  // SALAH: kamera lihat kapal, tapi AIS tidak punya kapal untuk dikaitkan.
  // Artinya kapal tanpa AIS / AIS mati / tak teridentifikasi.
  const mismatch = STRICT_MISMATCH
    ? status.cameraDetected && !inDock && !inOuter
    : status.cameraDetected && !inDock;
 
  let state = "idle";
  if (status.cameraDetected && inDock) state = "red";
  else if (mismatch) state = "error";
  else if (inDock) state = "yellow";
  else if (inOuter) state = "green";
 
  status.state = state;
  status.mismatch = mismatch;
  status.inDock = inDock;
  status.inOuter = inOuter;
  status.dockZoneId = dockZoneId;
 
  const outer = state === "green" ? 1 : 0;
  const zone2 = state === "yellow" || state === "red" ? 1 : 0;
  const sync = state === "red" ? 1 : 0;
  const err = state === "error" ? 1 : 0;
  const line = `${outer},${zone2},${sync},${err}`;
  status.line = line;
 
  const now = Date.now();
  if (line !== lastLineSent || now - lastSentAt > HEARTBEAT_MS) {
    writeToArduino(line);
    lastLineSent = line;
    lastSentAt = now;
  }
 
  broadcast({
    type: "actuator",
    state,
    mismatch,
    cameraDetected: status.cameraDetected,
    cameraOnline: status.cameraOnline,
    cameraRunning: status.cameraRunning,
    cameraError: status.cameraError,
    inDock,
    inOuter,
    dockShips: [...new Set(dockShips)],
    outerShips: [...new Set(outerShips)],
    ts: now,
  });
}
 
// ── LOOP ───────────────────────────────────────────────────
async function tick() {
  await pollCamera();
  computeAndSend();
}
 
function init({ geoMgr: gm, broadcast: bc }) {
  geoMgr = gm;
  broadcast = bc || broadcast;
  openSerial();
  setInterval(tick, TICK_MS);
 
  const zonaInfo = DOCK_ZONE_ID
    ? `ID "${DOCK_ZONE_ID}" (override)`
    : `nama "${DOCK_ZONE_NAME}"`;
  console.log(
    `[ACT] Actuator aktif. Zona sandar: ${zonaInfo}. ` +
      `Mismatch: ${STRICT_MISMATCH ? "strict" : "longgar"}. ` +
      `Poll kamera: ${YOLO_STATUS_URL}`,
  );
}
 
// Dipanggil server.js saat ada event enter/exit → hitung ulang seketika
function onGeoEvent() {
  computeAndSend();
}
 
function getCameraDetected() {
  return status.cameraDetected;
}
 
module.exports = { init, onGeoEvent, getCameraDetected, status };
