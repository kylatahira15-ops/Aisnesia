'use strict';

const mongoose = require('mongoose');

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aisnesia';

async function connect() {
  try {
    mongoose.set('strictQuery', true);
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    const safe = MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
    console.log(`[DB] MongoDB terhubung → ${safe}`);
  } catch (e) {
    console.error(`[DB] Gagal konek MongoDB: ${e.message}`);
    console.error('[DB] Server tetap jalan, tapi event zona TIDAK tersimpan.');
  }
}

function isReady() {
  return mongoose.connection.readyState === 1;
}

const zoneEventSchema = new mongoose.Schema(
  {
    mmsi:            { type: String, index: true },
    shipName:        { type: String, default: '' },
    zoneId:          { type: String, index: true },
    zoneName:        { type: String, default: '' },
    status:          { type: String, enum: ['masuk', 'keluar'], required: true },
    cameraConfirmed: { type: Boolean, default: false },
    lat:             { type: Number, default: null },
    lon:             { type: Number, default: null },
    sog:             { type: Number, default: null },
    cog:             { type: Number, default: null },
    timestamp:       { type: Date, default: Date.now, index: true },
  },
  { collection: 'zone_events', versionKey: false }
);
zoneEventSchema.index({ mmsi: 1, zoneId: 1, timestamp: -1 });
const ZoneEvent = mongoose.model('ZoneEvent', zoneEventSchema);

const sessionSchema = new mongoose.Schema(
  {
    mmsi:        { type: String, index: true },
    shipName:    { type: String, default: '' },
    zoneId:      { type: String, index: true },
    zoneName:    { type: String, default: '' },
    enterAt:     { type: Date, default: Date.now },
    exitAt:      { type: Date, default: null },
    durationSec: { type: Number, default: null },
    open:        { type: Boolean, default: true },
  },
  { collection: 'berthing_sessions', versionKey: false }
);
const BerthingSession = mongoose.model('BerthingSession', sessionSchema);

async function logZoneEvent({ event, zone, ship, cameraConfirmed = false }) {
  if (!isReady()) return;

  const status   = event === 'enter' ? 'masuk' : 'keluar';
  const shipName = ship.name || `MMSI ${ship.mmsi}`;
  const mmsi     = String(ship.mmsi);

  try {
    await ZoneEvent.create({
      mmsi,
      shipName,
      zoneId: zone.id,
      zoneName: zone.name,
      status,
      cameraConfirmed,
      lat: ship.lat ?? null,
      lon: ship.lon ?? null,
      sog: ship.sog ?? null,
      cog: ship.cog ?? null,
      timestamp: new Date(),
    });

    if (event === 'enter') {
      await BerthingSession.updateMany(
        { mmsi, zoneId: zone.id, open: true },
        { $set: { open: false } }
      );
      await BerthingSession.create({
        mmsi,
        shipName,
        zoneId: zone.id,
        zoneName: zone.name,
        enterAt: new Date(),
        open: true,
      });
    } else {
      const session = await BerthingSession.findOne({
        mmsi,
        zoneId: zone.id,
        open: true,
      }).sort({ enterAt: -1 });

      if (session) {
        const exitAt = new Date();
        session.exitAt = exitAt;
        session.durationSec = Math.round((exitAt - session.enterAt) / 1000);
        session.open = false;
        await session.save();
      }
    }

    console.log(`[DB] Tersimpan: ${shipName} ${status.toUpperCase()} "${zone.name}"`);
  } catch (e) {
    console.error(`[DB] Gagal menyimpan event: ${e.message}`);
  }
}

async function backfillShipName(mmsi, name) {
  if (!isReady()) return;
  if (!name) return;

  const clean = String(name).trim();
  if (!clean || /^MMSI\s/i.test(clean)) return;
  mmsi = String(mmsi);

  const filter = {
    mmsi,
    $or: [
      { shipName: '' },
      { shipName: null },
      { shipName: { $exists: false } },
      { shipName: { $regex: /^MMSI\s/i } },
    ],
  };

  try {
    const r1 = await ZoneEvent.updateMany(filter, { $set: { shipName: clean } });
    const r2 = await BerthingSession.updateMany(filter, { $set: { shipName: clean } });
    const n = (r1.modifiedCount || 0) + (r2.modifiedCount || 0);
    if (n) console.log(`[DB] Backfill nama "${clean}" (MMSI ${mmsi}) → ${n} dokumen`);
  } catch (e) {
    console.error(`[DB] Gagal backfill nama: ${e.message}`);
  }
}

module.exports = {
  connect,
  isReady,
  logZoneEvent,
  backfillShipName,
  ZoneEvent,
  BerthingSession,
};