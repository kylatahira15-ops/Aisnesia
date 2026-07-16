"use strict";

let SerialPort;
try {
  ({ SerialPort } = require('serialport'));
} catch (e) {
  console.warn('[ACT] Modul serialport tidak tersedia:', e.message);
}

const mqttClient = require('./mqtt-client');
 

const ESP32_PORT        = process.env.ESP32_PORT || process.env.ACTUATOR_PORT || '';
const ESP32_BAUD        = parseInt(process.env.ESP32_BAUD || process.env.ACTUATOR_BAUD) || 115200;
const CAMERA_STATUS_URL = process.env.CAMERA_STATUS_URL || process.env.YOLO_STATUS_URL || 'http://localhost:5001/api/status';
const DOCK_ZONE_NAME    = (process.env.DOCK_ZONE_NAME || 'zona 2').trim().toLowerCase();
const TICK_MS           = 1000;   
const HEARTBEAT_MS      = 3000;   
 

let geoMgr    = null;
let broadcast = () => {};
let port      = null;
 
const STATE_CODE = { idle: 0, green: 1, yellow: 2, red: 3 };
 
const status = {
  state: 'idle',
  code: 0,
  cameraDetected: false,
  cameraOnline: false,
  inDock: false,
  inOuter: false,
  dockCount: 0,
  outerCount: 0,
  dockZoneId: null,
};
 
let lastLineSent = '';
let lastSentAt   = 0;
 

function pickDockZoneId(zones) {
  
  let match = zones.find(z => (z.name || '').trim().toLowerCase() === DOCK_ZONE_NAME);
  
  if (!match) {
    match = zones.find(z => (z.name || '').toLowerCase().includes(DOCK_ZONE_NAME));
  }
  return match ? match.id : null;
}
 

function openSerial() {
  if (!SerialPort || !ESP32_PORT) {
    console.warn('[ACT] Serial kabel nonaktif (ESP32_PORT kosong). Mode WiFi/broadcast saja.');
    return;
  }
  try {
    port = new SerialPort({ path: ESP32_PORT, baudRate: ESP32_BAUD }, (err) => {
      if (err) {
        console.error(`[ACT] Gagal buka ${ESP32_PORT}: ${err.message}`);
        port = null;
        setTimeout(openSerial, 5000);
      } else {
        console.log(`[ACT] ESP32 terhubung di ${ESP32_PORT} @ ${ESP32_BAUD}`);
      }
    });
    port.on('data', (buf) => {
      const s = buf.toString().trim();
      if (s) console.log(`[ACT<-ESP32] ${s}`);
    });
    port.on('error', (err) => console.error(`[ACT] Serial error: ${err.message}`));
    port.on('close', () => {
      console.warn('[ACT] Serial tertutup, reconnect...');
      port = null;
      setTimeout(openSerial, 5000);
    });
  } catch (e) {
    console.error(`[ACT] Serial init error: ${e.message}`);
    setTimeout(openSerial, 5000);
  }
}
 
function writeToESP32(line) {
  if (port && port.writable) port.write(line + '\n');
}
 

async function pollCamera() {
  try {
    const res = await fetch(CAMERA_STATUS_URL, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const j = await res.json();
      status.cameraDetected = !!j.detected;   
      status.cameraOnline = true;
      return;
    }
  } catch (_) {
    /* server YOLO mati / tidak terjangkau */
  }
  status.cameraOnline = false;
  status.cameraDetected = false;
}
 

function lineFor(state) {
  const outer = state === 'green' ? 1 : 0;
  const zone2 = (state === 'yellow' || state === 'red') ? 1 : 0;
  const sync  = state === 'red' ? 1 : 0;
  return `${outer},${zone2},${sync}`;
}
 

function computeAndSend() {
  let inDock = false, inOuter = false;
  const dockShips = [], outerShips = [];
  let dockZoneId = null;
 
  if (geoMgr) {
    const zones = geoMgr.list().filter(z =>
      z.enabled !== false && Array.isArray(z.polygon) && z.polygon.length >= 3
    );
    dockZoneId = pickDockZoneId(zones);
 
    for (const z of zones) {
      const inside = geoMgr.getShipsInside(z.id);
      if (!inside.length) continue;
      if (z.id === dockZoneId) { inDock = true;  dockShips.push(...inside); }
      else                     { inOuter = true; outerShips.push(...inside); }
    }
  }
 
  
  let state = 'idle';
  if (inDock && status.cameraDetected) state = 'red';    
  else if (inDock)                     state = 'yellow'; 
  else if (inOuter)                    state = 'green';  
 
  status.state      = state;
  status.code       = STATE_CODE[state];
  status.inDock     = inDock;
  status.inOuter    = inOuter;
  status.dockCount  = new Set(dockShips).size;
  status.outerCount = new Set(outerShips).size;
  status.dockZoneId = dockZoneId;
 
  const line = lineFor(state);
  const now  = Date.now();
  if (line !== lastLineSent || now - lastSentAt > HEARTBEAT_MS) {
    writeToESP32(line);
    mqttClient.publishLine(line);
    mqttClient.publishState({
      state: status.state,
      code: status.code,
      cameraDetected: status.cameraDetected,
      cameraOnline: status.cameraOnline,
      inDock: status.inDock,
      inOuter: status.inOuter,
      dockCount: status.dockCount,
      outerCount: status.outerCount,
      ts: now,
    });
    lastLineSent = line;
    lastSentAt = now;
  }
 
  broadcast({
    type: 'actuator',
    state,
    code: status.code,
    cameraDetected: status.cameraDetected,
    cameraOnline: status.cameraOnline,
    inDock,
    inOuter,
    dockShips: [...new Set(dockShips)],
    outerShips: [...new Set(outerShips)],
    ts: now,
  });
}
 
async function tick() {
  await pollCamera();
  computeAndSend();
}
 

function init({ geoMgr: gm, broadcast: bc }) {
  geoMgr = gm;
  broadcast = bc || broadcast;
  openSerial();
  setInterval(tick, TICK_MS);
  console.log(`[ACT] Actuator aktif. Zona dock (nama) = "${DOCK_ZONE_NAME}". Poll kamera: ${CAMERA_STATUS_URL}`);
}
 
function onGeoEvent() {
  
  computeAndSend();
}
 
function getCameraDetected() { return status.cameraDetected; }
function getLine()           { return lineFor(status.state); }
function getStatus()         { return { ...status, line: getLine() }; }
 
module.exports = { init, onGeoEvent, getCameraDetected, getLine, getStatus, status };
