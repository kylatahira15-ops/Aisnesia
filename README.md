# 🚢 AIS Realtime Tracker v3

Aplikasi pelacak kapal AIS (Automatic Identification System) **fullstack** berbasis Node.js.  
Mendukung **multi-sumber TCP**, **ENC nautical chart**, **email alert otomatis**, dan **WebSocket realtime**.

---

## ✨ Fitur Lengkap

| Kategori | Fitur |
|---|---|
| 🗺️ **Peta** | ENC/Nautical (Esri Ocean), Satellite, OSM, Dark — bisa ganti live |
| ⚓ **Overlay** | OpenSeaMap Seamarks, GEBCO Bathymetry, Ocean Reference |
| 📡 **Multi-Source** | Tambah/edit/hapus sumber TCP AIS tanpa restart |
| 🔌 **Auto-Reconnect** | Reconnect otomatis tiap 5 detik jika koneksi putus |
| ⏱️ **Auto-Remove** | Kapal dihapus setelah 5 menit tidak ada data baru |
| 🛣️ **Ship Trail** | Jejak pergerakan kapal di peta (bisa toggle) |
| 🧭 **Detail Panel** | Kompas animasi, SOG, COG, countdown timeout, info lengkap |
| 📧 **Email Alert** | Notifikasi jika sumber TCP terputus (dengan cooldown anti-spam) |
| 🔍 **Filter & Search** | Filter per jenis kapal, sort by waktu/nama/kecepatan |
| 📥 **Export CSV** | Download semua kapal aktif ke file CSV |
| 📊 **Live Stats** | RX count, decoded, clients, per-source stats |
| 🐳 **Docker Ready** | Deploy dengan satu perintah |
| 🔄 **PM2 Ready** | `ecosystem.config.js` siap pakai untuk production |

---

## 🏗️ Arsitektur

```
┌─────────────────────────────────────────────┐
│          AIS TCP Sources (multiple)          │
│  vps2.osi.my.id:6000  |  192.168.1.x:10110  │
└────────────────┬────────────────────────────┘
                 │ raw NMEA-0183
         ┌───────▼────────┐
         │ Source Manager │  ← CRUD, reconnect, email alert
         │  (EventEmitter) │
         └───────┬────────┘
                 │ decoded ship objects
         ┌───────▼────────┐
         │  Ship State    │  ← Map<MMSI, ship>, trail, purge
         └───────┬────────┘
                 │ JSON over WebSocket
    ┌────────────▼──────────────────────┐
    │        Express + WebSocket         │
    │  REST API  |  Static files         │
    └────────────┬──────────────────────┘
                 │
         ┌───────▼──────┐
         │   Browser    │  Leaflet ENC + Ship Markers
         └──────────────┘
```

---

## 🚀 Instalasi & Menjalankan

### Prasyarat
- Node.js v18+ ([nodejs.org](https://nodejs.org))
- npm (ikut bersama Node.js)

### Langkah

```bash
# 1. Extract
tar -xzf ais-tracker.tar.gz
cd ais-app

# 2. Install dependencies
npm install

# 3. Konfigurasi
cp .env.example .env
# Edit .env sesuai kebutuhan (minimal tidak perlu diubah untuk tes)

# 4. Jalankan
npm start

# 5. Buka browser
# http://localhost:3000
```

> **Windows CMD** (bukan PowerShell):
> ```cmd
> cd ais-app
> npm install
> npm start
> ```

---

## 🐳 Docker

```bash
# Docker Compose (cara termudah)
docker-compose up -d

# Lihat log
docker-compose logs -f ais-tracker

# Stop
docker-compose down
```

---

## 🔄 PM2 (Production)

```bash
npm install -g pm2

# Start
pm2 start ecosystem.config.js

# Auto-start saat boot
pm2 save
pm2 startup

# Monitor
pm2 monit

# Log
pm2 logs ais-tracker
```

---

## ⚙️ Konfigurasi (.env)

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port HTTP server |
| `AIS_HOST` | `vps2.osi.my.id` | Host sumber AIS default |
| `AIS_PORT` | `6000` | Port TCP AIS default |
| `AIS_NAME` | `Main Feed` | Nama sumber AIS default |
| `SHIP_TIMEOUT_MINUTES` | `5` | Menit sebelum kapal dihapus |
| `MAX_TRAIL` | `20` | Titik trail per kapal |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |
| `SMTP_HOST` | `smtp.gmail.com` | Server SMTP |
| `SMTP_PORT` | `587` | Port SMTP |
| `SMTP_USER` | — | Email pengirim |
| `SMTP_PASS` | — | Password / App Password |
| `ALERT_TO` | — | Email penerima alert default |
| `ALERT_DELAY_MINUTES` | `5` | Delay sebelum kirim alert |
| `ALERT_COOLDOWN_MINUTES` | `30` | Cooldown antar alert |

---

## 📧 Setup Email Alert (Gmail)

1. Aktifkan **2-Factor Authentication** di akun Google
2. Buka: https://myaccount.google.com/apppasswords
3. Buat App Password (pilih "Mail" → "Other")
4. Salin 16-digit password ke `.env`:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=emailanda@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
ALERT_TO=admin@rsudpare.id
```

5. Restart server → test via tombol **"Kirim Email Test"** di modal Sumber TCP

---

## 📡 Menambah Sumber TCP

1. Klik tombol **"Sumber TCP"** di topbar
2. Klik **"+ Tambah"**
3. Isi Nama, Host/IP, Port
4. Aktifkan **Alert Email** jika ingin notifikasi
5. Klik **Simpan** → koneksi langsung dibuat

Contoh sumber yang bisa ditambahkan:
- Feed lokal: `192.168.1.100:10110`
- VHF receiver + kabel serial: `localhost:4002`
- AIS aggregator: `ais.example.com:9999`

---

## 🌐 API Reference

### Ships

| Method | Endpoint | Keterangan |
|---|---|---|
| `GET` | `/api/ships` | Semua kapal aktif |
| `GET` | `/api/ships/:mmsi` | Detail kapal by MMSI |

### Sources

| Method | Endpoint | Keterangan |
|---|---|---|
| `GET` | `/api/sources` | Daftar semua sumber |
| `POST` | `/api/sources` | Tambah sumber baru |
| `GET` | `/api/sources/:id` | Detail sumber |
| `PUT` | `/api/sources/:id` | Update sumber |
| `DELETE` | `/api/sources/:id` | Hapus sumber |
| `POST` | `/api/sources/:id/toggle` | Toggle enable/disable |

#### Body POST/PUT sumber:
```json
{
  "name": "Feed Utama",
  "host": "vps2.osi.my.id",
  "port": 6000,
  "enabled": true,
  "alertEnabled": true,
  "alertEmail": "admin@rsudpare.id"
}
```

### Email & Stats

| Method | Endpoint | Keterangan |
|---|---|---|
| `GET` | `/api/stats` | Statistik server |
| `GET` | `/api/email/status` | Status konfigurasi SMTP |
| `POST` | `/api/email/test` | Kirim email test `{"email":"..."}` |
| `GET` | `/healthz` | Health check (Docker/proxy) |

### WebSocket Events (Server → Client)

| Type | Payload | Keterangan |
|---|---|---|
| `init` | `{ships[], sources[], stats}` | Snapshot saat koneksi |
| `update` | `{ship}` | Posisi/data kapal baru |
| `remove` | `{mmsis[]}` | Kapal dihapus (timeout) |
| `sources` | `[source...]` | Update daftar sumber |
| `stats` | `{count, received, ...}` | Statistik tiap 5 detik |

---

## 📁 Struktur File

```
ais-app/
├── server.js               ← Entry point — HTTP + WebSocket + REST
├── lib/
│   ├── ais-decoder.js      ← AIS NMEA-0183 decoder (pure, no deps)
│   ├── source-manager.js   ← Multi-TCP manager (CRUD, reconnect, events)
│   └── mailer.js           ← Email alert (nodemailer, HTML templates)
├── public/
│   └── index.html          ← Frontend SPA (Leaflet, ENC, modal)
├── data/
│   └── sources.json        ← Persistent source list (auto-generated)
├── logs/                   ← Log files (PM2)
├── package.json
├── .env                    ← Konfigurasi lokal (jangan di-commit!)
├── .env.example            ← Template konfigurasi
├── ecosystem.config.js     ← PM2 config
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## 🗺️ AIS Message Types

| Type | Nama | Keterangan |
|---|---|---|
| 1, 2, 3 | Class A Position | Posisi + kecepatan + arah |
| 5 | Class A Static | Nama, IMO, callsign, tujuan |
| 18 | Class B Position | Posisi kapal kecil/yatch |
| 21 | Aid-to-Navigation | Buoy, mercusuar |
| 24 | Class B Static | Nama + tipe kapal kecil |

---

## 🔧 Troubleshooting

**`npm` tidak bisa dijalankan di PowerShell:**
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```
Atau gunakan **Command Prompt (CMD)** biasa.

**Email tidak terkirim:**
- Pastikan Gmail menggunakan **App Password** (bukan password akun)
- Cek `SMTP_PORT=587` dan `SMTP_SECURE=false` untuk Gmail
- Test via endpoint: `POST /api/email/test {"email":"..."}`

**Kapal tidak muncul:**
- Cek status sumber di modal "Sumber TCP"
- Pastikan firewall mengizinkan koneksi ke host:port sumber AIS
- Cek log: `npm start` atau `pm2 logs ais-tracker`

---

*AIS Realtime Tracker v3 — RSUD Pare IT Infrastructure*
#   A I S N E S I A  
 #   A I S N E S I A  
 