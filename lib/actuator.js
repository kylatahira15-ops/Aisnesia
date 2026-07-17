"use strict";

const YOLO_DETECTIONS_URL =
  process.env.YOLO_DETECTIONS_URL || "http://localhost:5000/api/detections";

const TICK_MS = 1000;

class Actuator {
  constructor() {
    this.geoMgr = null;
    this.getShipNameFn = null;
    this.yoloDetections = [];
    this.line = "0,0,0,0";
  }

  init(geoMgr, getShipNameFn) {
    this.geoMgr = geoMgr;
    this.getShipNameFn = getShipNameFn;
    setInterval(() => this._pollYolo(), 2000);
    setInterval(() => this._tick(), TICK_MS);
    console.log("[ACT] Actuator aktif (poll YOLO + geofence zoneType)");
  }

  async _pollYolo() {
    try {
      const res = await fetch(YOLO_DETECTIONS_URL, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        const data = await res.json();
        this.yoloDetections = data.detections || [];
      } else {
        this.yoloDetections = [];
      }
    } catch (_) {
      this.yoloDetections = [];
    }
  }

  _tick() {
    this._updateLine();
  }

  _updateLine() {
    let z1 = 0, z2 = 0, z3 = 0;
    let yoloStatus = 0;
    const zones = this.geoMgr ? this.geoMgr.list() : [];

    for (const zone of zones) {
      if (zone.enabled === false) continue;
      if (!zone.zoneType) continue;

      const mmsis = this.geoMgr.getShipsInside(zone.id);
      if (!mmsis || mmsis.length === 0) continue;

      if (zone.zoneType === "zona1") z1 = 1;
      else if (zone.zoneType === "zona2") z2 = 1;
      else if (zone.zoneType === "zona3") {
        z3 = 1;
        if (this.yoloDetections.length > 0 && this.getShipNameFn) {
          let matched = false;
          for (const mmsi of mmsis) {
            const shipName = this.getShipNameFn(mmsi);
            if (!shipName) continue;
            matched = this.yoloDetections.some(
              (d) => d.name && d.name.toLowerCase() === shipName.toLowerCase()
            );
            if (matched) break;
          }
          yoloStatus = matched ? 1 : 2;
        }
      }
    }

    this.line = `${z1},${z2},${z3},${yoloStatus}`;
  }

  onGeoEvent() {
    this._updateLine();
  }

  getLine() {
    return this.line;
  }
}

module.exports = new Actuator();
