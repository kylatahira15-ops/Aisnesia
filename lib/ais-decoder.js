'use strict'

// ─── 6-bit armoured lookup table ──────────────────────────────────────────
const ARMOUR_VAL = new Uint8Array(128)
for (let i = 0; i < 128; i++) {
  ARMOUR_VAL[i] = i - 48
  if (ARMOUR_VAL[i] > 39) ARMOUR_VAL[i] -= 8
}

// ─── Bit helpers (Uint8Array-based, zero string concat) ──────────────────

function armourToBits(payload) {
  const totalBits = payload.length * 6
  const bits = new Uint8Array(totalBits)
  let idx = 0
  for (let i = 0; i < payload.length; i++) {
    let c = ARMOUR_VAL[payload.charCodeAt(i)]
    bits[idx++] = (c >> 5) & 1
    bits[idx++] = (c >> 4) & 1
    bits[idx++] = (c >> 3) & 1
    bits[idx++] = (c >> 2) & 1
    bits[idx++] = (c >> 1) & 1
    bits[idx++] = c & 1
  }
  return bits
}

function uint(bits, start, len) {
  let val = 0
  const end = start + len
  for (let i = start; i < end; i++) {
    val = (val << 1) | bits[i]
  }
  return val
}

function sint(bits, start, len) {
  const raw = uint(bits, start, len)
  return raw >= (1 << (len - 1)) ? raw - (1 << len) : raw
}

function str(bits, start, len) {
  let s = ''
  for (let i = 0; i < len; i += 6) {
    const c = uint(bits, start + i, 6)
    s += c < 32 ? String.fromCharCode(c + 64) : String.fromCharCode(c)
  }
  return s.replace(/@+$/, '').trim()
}

function checksumOk(sentence) {
  const m = sentence.match(/^!AIVD[MO],(\d+),(\d+),([^,]*),([^,]*),([^,]*),(\d)\*([0-9A-F]{2})$/i)
  if (!m) return false
  const body = sentence.slice(1, sentence.lastIndexOf('*'))
  let cs = 0
  for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i)
  return cs === parseInt(m[7], 16)
}

// ─── Lookup tables ───────────────────────────────────────────────────────

const NAV_STATUS = [
  'Under Way Engine', 'Anchored', 'Not Under Command', 'Restricted Manoeuv.',
  'Constrained Draft', 'Moored', 'Aground', 'Fishing', 'Under Way Sailing',
  'Reserved', 'Reserved', 'Power-driven Towing', 'Power-driven Pushing',
  'Reserved', 'AIS-SART', 'Undefined'
]

const SHIP_TYPE = [
  'Not available', 'Reserved', 'Reserved', 'Reserved', 'Reserved',
  'Reserved', 'Reserved', 'Reserved', 'Reserved', 'Reserved',
  'Reserved', 'Reserved', 'Reserved', 'Reserved', 'Reserved',
  'Reserved', 'Reserved', 'Reserved', 'Reserved', 'Reserved',
  'Wing in Ground', 'WIG Hazardous A', 'WIG Hazardous B', 'WIG Hazardous C',
  'WIG Hazardous D', 'WIG Reserved', 'WIG Reserved', 'WIG Reserved',
  'WIG Reserved', 'WIG No info',
  'Fishing', 'Towing', 'Towing Large', 'Dredging', 'Diving',
  'Military', 'Sailing', 'Pleasure Craft', 'Reserved', 'Reserved',
  'HSC', 'HSC Hazardous A', 'HSC Hazardous B', 'HSC Hazardous C',
  'HSC Hazardous D', 'HSC Reserved', 'HSC Reserved', 'HSC Reserved',
  'HSC Reserved', 'HSC No info',
  'Pilot Vessel', 'SAR Vessel', 'Tug', 'Port Tender', 'Anti-pollution',
  'Law Enforcement', 'Spare Local', 'Spare Local', 'Medical Transport',
  'Non-combatant Ship',
  'Passenger', 'Passenger Hazardous A', 'Passenger Hazardous B',
  'Passenger Hazardous C', 'Passenger Hazardous D', 'Passenger Reserved',
  'Passenger Reserved', 'Passenger Reserved', 'Passenger Reserved',
  'Passenger No info',
  'Cargo', 'Cargo Hazardous A', 'Cargo Hazardous B', 'Cargo Hazardous C',
  'Cargo Hazardous D', 'Cargo Reserved', 'Cargo Reserved', 'Cargo Reserved',
  'Cargo Reserved', 'Cargo No info',
  'Tanker', 'Tanker Hazardous A', 'Tanker Hazardous B', 'Tanker Hazardous C',
  'Tanker Hazardous D', 'Tanker Reserved', 'Tanker Reserved', 'Tanker Reserved',
  'Tanker Reserved', 'Tanker No info',
  'Other', 'Other Hazardous A', 'Other Hazardous B', 'Other Hazardous C',
  'Other Hazardous D', 'Other Reserved', 'Other Reserved', 'Other Reserved',
  'Other Reserved', 'Other No info'
]

const EPFD = [
  'Undefined', 'GPS', 'GLONASS', 'GPS+GLONASS', 'Loran-C', 'Chayka',
  'Integrated Nav System', 'Surveyed', 'Galileo'
]

// ─── Message decoders ────────────────────────────────────────────────────

function decodeMsg123(bits, mmsi, msgType) {
  return {
    type: 'classA', msgType, mmsi,
    status:      NAV_STATUS[uint(bits, 38, 4)] ?? 'Unknown',
    rot:         sint(bits, 42, 8),
    sog:         uint(bits, 50, 10) / 10,
    posAccuracy: uint(bits, 60, 1) === 1,
    lon:         sint(bits, 61, 28) / 600000,
    lat:         sint(bits, 89, 27) / 600000,
    cog:         uint(bits, 116, 12) / 10,
    heading:     uint(bits, 128, 9),
    utcSec:      uint(bits, 137, 6),
    maneuver:    uint(bits, 143, 2),
    raim:        uint(bits, 148, 1) === 1,
    ts:          new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg4(bits, mmsi) {
  return {
    type: 'baseStation', mmsi,
    year:    uint(bits, 38, 14), month: uint(bits, 52, 4),
    day:     uint(bits, 56, 5), hour: uint(bits, 61, 5),
    minute:  uint(bits, 66, 6), second: uint(bits, 72, 6),
    posAccuracy: uint(bits, 78, 1) === 1,
    lon: sint(bits, 79, 28) / 600000,
    lat: sint(bits, 107, 27) / 600000,
    epfd: EPFD[uint(bits, 134, 4)] ?? 'Unknown',
    raim: uint(bits, 148, 1) === 1,
    ts:   new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg5(bits, mmsi) {
  if (bits.length < 426) return null
  return {
    type: 'staticA', mmsi,
    aisVersion:  uint(bits, 38, 2),
    imo:         uint(bits, 40, 30).toString(),
    callsign:    str(bits, 70, 42),
    name:        str(bits, 112, 120),
    shipType:    SHIP_TYPE[uint(bits, 232, 8)] ?? 'Unknown',
    dimBow:      uint(bits, 240, 9), dimStern: uint(bits, 249, 9),
    dimPort:     uint(bits, 258, 6), dimStbd: uint(bits, 264, 6),
    epfd:        EPFD[uint(bits, 270, 4)] ?? 'Unknown',
    etaMonth:    uint(bits, 274, 4), etaDay: uint(bits, 278, 5),
    etaHour:     uint(bits, 283, 5), etaMinute: uint(bits, 288, 6),
    draught:     uint(bits, 294, 8) / 10,
    destination: str(bits, 302, 120),
    dte:         uint(bits, 422, 1),
    ts:          new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg6(bits, mmsi) {
  if (bits.length < 88) return null
  return {
    type: 'addrBinary', mmsi,
    seqNo:    uint(bits, 38, 2),
    destMmsi: uint(bits, 40, 30).toString().padStart(9, '0'),
    retransmit: uint(bits, 70, 1) === 1,
    dac: uint(bits, 72, 10), fi: uint(bits, 82, 6),
    data: bits.slice(88),
    ts:   new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg7(bits, mmsi) {
  if (bits.length < 72) return null
  const acks = []
  for (let i = 0; i + 30 <= bits.length - 40; i += 32) {
    acks.push({
      mmsi:  uint(bits, 40 + i, 30).toString().padStart(9, '0'),
      seqNo: uint(bits, 70 + i, 2)
    })
  }
  return { type: 'ack', mmsi, acks, ts: new Date().toLocaleTimeString('id-ID') }
}

function decodeMsg8(bits, mmsi) {
  if (bits.length < 56) return null
  return {
    type: 'binaryBroadcast', mmsi,
    dac: uint(bits, 40, 10), fi: uint(bits, 50, 6),
    data: bits.slice(56),
    ts:   new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg9(bits, mmsi) {
  if (bits.length < 168) return null
  const altRaw = uint(bits, 38, 12)
  return {
    type: 'sar', mmsi,
    alt: altRaw === 4095 ? null : altRaw,
    sog: uint(bits, 50, 10),
    posAccuracy: uint(bits, 60, 1) === 1,
    lon: sint(bits, 61, 28) / 600000,
    lat: sint(bits, 89, 27) / 600000,
    cog: uint(bits, 116, 12) / 10,
    utcSec: uint(bits, 128, 6),
    raim: uint(bits, 147, 1) === 1,
    ts:   new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg10(bits, mmsi) {
  if (bits.length < 72) return null
  return {
    type: 'utcInquiry', mmsi,
    destMmsi: uint(bits, 40, 30).toString().padStart(9, '0'),
    ts: new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg12(bits, mmsi) {
  if (bits.length < 72) return null
  return {
    type: 'safetyAddr', mmsi,
    seqNo:    uint(bits, 38, 2),
    destMmsi: uint(bits, 40, 30).toString().padStart(9, '0'),
    retransmit: uint(bits, 70, 1) === 1,
    text: str(bits, 72, Math.min(936, bits.length - 72)),
    ts:   new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg14(bits, mmsi) {
  if (bits.length < 40) return null
  return {
    type: 'safetyBcast', mmsi,
    text: str(bits, 40, Math.min(968, bits.length - 40)),
    ts:   new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg15(bits, mmsi) {
  if (bits.length < 88) return null
  return {
    type: 'interrogation', mmsi,
    dest1:    uint(bits, 40, 30).toString().padStart(9, '0'),
    msg1_1:   uint(bits, 70, 6),
    slotOff1: uint(bits, 76, 12),
    ts:       new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg16(bits, mmsi) {
  if (bits.length < 92) return null
  return {
    type: 'assignMode', mmsi,
    dest1:   uint(bits, 40, 30).toString().padStart(9, '0'),
    offset1: uint(bits, 70, 12),
    incr1:   uint(bits, 82, 10),
    ts:      new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg17(bits, mmsi) {
  if (bits.length < 80) return null
  return {
    type: 'dgnss', mmsi,
    lon:  sint(bits, 40, 18) / 600,
    lat:  sint(bits, 58, 17) / 600,
    data: bits.slice(80),
    ts:   new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg18(bits, mmsi) {
  if (bits.length < 168) return null
  const sog = uint(bits, 46, 10) / 10
  return {
    type: 'classB', mmsi, sog,
    posAccuracy: uint(bits, 56, 1) === 1,
    lon:  sint(bits, 57, 28) / 600000,
    lat:  sint(bits, 85, 27) / 600000,
    cog:     uint(bits, 112, 12) / 10,
    heading: uint(bits, 124, 9),
    utcSec:  uint(bits, 133, 6),
    cs:      uint(bits, 141, 1) === 1,
    display: uint(bits, 142, 1) === 1,
    dsc:     uint(bits, 143, 1) === 1,
    band:    uint(bits, 144, 1) === 1,
    msg22:   uint(bits, 145, 1) === 1,
    assigned: uint(bits, 146, 1) === 1,
    raim:    uint(bits, 147, 1) === 1,
    ts:      new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg19(bits, mmsi) {
  if (bits.length < 312) return null
  return {
    type: 'classBext', mmsi,
    sog: uint(bits, 46, 10) / 10,
    posAccuracy: uint(bits, 56, 1) === 1,
    lon:  sint(bits, 57, 28) / 600000,
    lat:  sint(bits, 85, 27) / 600000,
    cog:     uint(bits, 112, 12) / 10,
    heading: uint(bits, 124, 9),
    utcSec:  uint(bits, 133, 6),
    name: str(bits, 143, 120),
    shipType: SHIP_TYPE[uint(bits, 263, 8)] ?? 'Unknown',
    dimBow:   uint(bits, 271, 9), dimStern: uint(bits, 280, 9),
    dimPort:  uint(bits, 289, 6), dimStbd: uint(bits, 295, 6),
    epfd:     EPFD[uint(bits, 301, 4)] ?? 'Unknown',
    raim:     uint(bits, 305, 1) === 1,
    assigned: uint(bits, 306, 1) === 1,
    ts:       new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg20(bits, mmsi) {
  if (bits.length < 72) return null
  const reservations = []
  for (let i = 0; i < 4 && 40 + i * 30 + 30 <= bits.length; i++) {
    const base = 40 + i * 30
    reservations.push({
      offset:  uint(bits, base, 12),
      number:  uint(bits, base + 12, 4),
      timeout: uint(bits, base + 16, 3),
      incr:    uint(bits, base + 19, 11)
    })
  }
  return { type: 'dlm', mmsi, reservations, ts: new Date().toLocaleTimeString('id-ID') }
}

function decodeMsg21(bits, mmsi) {
  if (bits.length < 272) return null
  return {
    type: 'aton', mmsi,
    atonType: uint(bits, 38, 5),
    name: str(bits, 43, 120),
    posAccuracy: uint(bits, 163, 1) === 1,
    lon: sint(bits, 164, 28) / 600000,
    lat: sint(bits, 192, 27) / 600000,
    dimBow: uint(bits, 219, 9), dimStern: uint(bits, 228, 9),
    dimPort: uint(bits, 237, 6), dimStbd: uint(bits, 243, 6),
    epfd:  EPFD[uint(bits, 249, 4)] ?? 'Unknown',
    utcSec: uint(bits, 253, 6),
    offPos: uint(bits, 259, 1) === 1,
    raim:   uint(bits, 268, 1) === 1,
    virtual:  uint(bits, 269, 1) === 1,
    assigned: uint(bits, 270, 1) === 1,
    nameExt: bits.length > 272 ? str(bits, 272, Math.min(bits.length - 272, 84)) : '',
    ts: new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg22(bits, mmsi) {
  if (bits.length < 52) return null
  return {
    type: 'channelMgmt', mmsi,
    channel_a: uint(bits, 40, 12), channel_b: uint(bits, 52, 12),
    txrx:  uint(bits, 64, 4),
    power: uint(bits, 68, 1) === 1,
    addressed: uint(bits, 139, 1) === 1,
    band_a:    uint(bits, 140, 1) === 1,
    band_b:    uint(bits, 141, 1) === 1,
    ts: new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg23(bits, mmsi) {
  if (bits.length < 160) return null
  return {
    type: 'groupAssign', mmsi,
    ne_lon: sint(bits, 40, 18) / 600,
    ne_lat: sint(bits, 58, 17) / 600,
    sw_lon: sint(bits, 75, 18) / 600,
    sw_lat: sint(bits, 93, 17) / 600,
    stationType: uint(bits, 110, 4),
    shipType: uint(bits, 114, 8),
    txrx:     uint(bits, 144, 4),
    interval: uint(bits, 148, 4),
    quiet:    uint(bits, 152, 4),
    ts: new Date().toLocaleTimeString('id-ID')
  }
}

function decodeMsg24(bits, mmsi) {
  const part = uint(bits, 38, 2)
  if (part === 0) {
    return {
      type: 'staticB0', mmsi,
      name: str(bits, 40, 120),
      ts: new Date().toLocaleTimeString('id-ID')
    }
  }
  if (part === 1 && bits.length >= 168) {
    return {
      type: 'staticB1', mmsi,
      shipType: SHIP_TYPE[uint(bits, 40, 8)] ?? 'Unknown',
      vendorId: str(bits, 48, 18),
      model:    uint(bits, 66, 4),
      serial:   uint(bits, 70, 20),
      callsign: str(bits, 90, 42),
      dimBow:   uint(bits, 132, 9), dimStern: uint(bits, 141, 9),
      dimPort:  uint(bits, 150, 6), dimStbd: uint(bits, 156, 6),
      motherMmsi: uint(bits, 162, 30).toString().padStart(9, '0'),
      ts: new Date().toLocaleTimeString('id-ID')
    }
  }
  return null
}

function decodeMsg25(bits, mmsi) {
  if (bits.length < 68) return null
  const addressed  = uint(bits, 38, 1) === 1
  const structured = uint(bits, 39, 1) === 1
  let offset = 40
  const result = { type: 'singleSlotBin', mmsi, addressed, structured }
  if (addressed) {
    result.destMmsi = uint(bits, offset, 30).toString().padStart(9, '0')
    offset += 30
  }
  if (structured) {
    result.appId = uint(bits, offset, 16)
    offset += 16
  }
  result.data = bits.slice(offset)
  result.ts   = new Date().toLocaleTimeString('id-ID')
  return result
}

function decodeMsg26(bits, mmsi) {
  if (bits.length < 100) return null
  const addressed  = uint(bits, 38, 1) === 1
  const structured = uint(bits, 39, 1) === 1
  let offset = 40
  const result = { type: 'multiSlotBin', mmsi, addressed, structured }
  if (addressed) {
    result.destMmsi = uint(bits, offset, 30).toString().padStart(9, '0')
    offset += 30
  }
  if (structured) {
    result.appId = uint(bits, offset, 16)
    offset += 16
  }
  const dataEnd = bits.length - 20
  result.data      = bits.slice(offset, dataEnd)
  result.commState = bits.slice(dataEnd)
  result.ts        = new Date().toLocaleTimeString('id-ID')
  return result
}

function decodeMsg27(bits, mmsi) {
  if (bits.length < 95) return null
  return {
    type: 'longRange', mmsi,
    posAccuracy: uint(bits, 38, 1) === 1,
    raim:        uint(bits, 39, 1) === 1,
    status:      NAV_STATUS[uint(bits, 40, 4)] ?? 'Unknown',
    lon:         sint(bits, 44, 18) / 600,
    lat:         sint(bits, 62, 17) / 600,
    sog:         uint(bits, 79, 6),
    cog:         uint(bits, 85, 9),
    gnssPos:     uint(bits, 94, 1) === 0,
    ts:          new Date().toLocaleTimeString('id-ID')
  }
}

// ─── Master decoder ──────────────────────────────────────────────────────

function decodeAIS(bits, msgType, mmsi) {
  switch (msgType) {
    case 1: case 2: case 3: return decodeMsg123(bits, mmsi, msgType)
    case 4: case 11:        return decodeMsg4(bits, mmsi)
    case 5:                 return decodeMsg5(bits, mmsi)
    case 6:                 return decodeMsg6(bits, mmsi)
    case 7: case 13:        return decodeMsg7(bits, mmsi)
    case 8:                 return decodeMsg8(bits, mmsi)
    case 9:                 return decodeMsg9(bits, mmsi)
    case 10:                return decodeMsg10(bits, mmsi)
    case 12:                return decodeMsg12(bits, mmsi)
    case 14:                return decodeMsg14(bits, mmsi)
    case 15:                return decodeMsg15(bits, mmsi)
    case 16:                return decodeMsg16(bits, mmsi)
    case 17:                return decodeMsg17(bits, mmsi)
    case 18:                return decodeMsg18(bits, mmsi)
    case 19:                return decodeMsg19(bits, mmsi)
    case 20:                return decodeMsg20(bits, mmsi)
    case 21:                return decodeMsg21(bits, mmsi)
    case 22:                return decodeMsg22(bits, mmsi)
    case 23:                return decodeMsg23(bits, mmsi)
    case 24:                return decodeMsg24(bits, mmsi)
    case 25:                return decodeMsg25(bits, mmsi)
    case 26:                return decodeMsg26(bits, mmsi)
    case 27:                return decodeMsg27(bits, mmsi)
    default:
      return { type: 'unknown', msgType, mmsi }
  }
}

// ─── Sentence parser ─────────────────────────────────────────────────────

const _buf = {}
const _bufTs = {}
const BUF_TTL = 30000
setInterval(() => {
  const now = Date.now()
  for (const k of Object.keys(_bufTs)) {
    if (now - _bufTs[k] > BUF_TTL) { delete _buf[k]; delete _bufTs[k] }
  }
}, 10000)

function parseSentence(line) {
  line = line.trim()
  if (!line.startsWith('!AIVDM') && !line.startsWith('!AIVDO')) return null
  if (!checksumOk(line)) return null
  const parts = line.slice(1).split(',')
  if (parts.length < 6) return null

  const count  = parseInt(parts[1])
  const partno = parseInt(parts[2])
  const seqid  = parts[3]
  const payload = parts[5]

  if (count === 1) {
    const bits = armourToBits(payload)
    return decodeAIS(bits, uint(bits, 0, 6), uint(bits, 8, 30).toString().padStart(9, '0'))
  }

  const key = `${count}-${seqid}`
  if (!_buf[key]) { _buf[key] = new Array(count); _bufTs[key] = Date.now() }
  _buf[key][partno - 1] = payload
  _bufTs[key] = Date.now()

  if (_buf[key].filter(Boolean).length === count) {
    const bits = armourToBits(_buf[key].join(''))
    delete _buf[key]; delete _bufTs[key]
    return decodeAIS(bits, uint(bits, 0, 6), uint(bits, 8, 30).toString().padStart(9, '0'))
  }

  return null
}

// ─── Resolver ────────────────────────────────────────────────────────────

function resolveShipType(code) {
  if (code === undefined || code === null) return 'Unknown'
  if (typeof code === 'number') return SHIP_TYPE[code] ?? 'Unknown'
  return code || 'Unknown'
}

module.exports = { parseSentence, resolveShipType, NAV_STATUS, SHIP_TYPE }
