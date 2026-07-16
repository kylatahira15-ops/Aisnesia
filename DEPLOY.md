# 🚀 Panduan Deploy — AIS Tracker + Caddy HTTPS

## Arsitektur

```
Internet (HTTPS/WSS)
       │
    Caddy :443          ← SSL termination otomatis (Let's Encrypt)
       │                ← Meneruskan header X-Forwarded-Proto: https
       │ http + ws
    Node.js :3000       ← Aplikasi AIS Tracker
       │
    vps2.osi.my.id:6000 ← Sumber data AIS (TCP)
```

---

## Langkah Deploy

### 1. Upload file ke server

```bash
scp ais-tracker-v5.tar.gz user@server_ip:~/
ssh user@server_ip
tar -xzf ais-tracker-v5.tar.gz
cd ais-app
npm install --production
```

### 2. Konfigurasi .env

```bash
cp .env.example .env
nano .env
```

Edit minimal ini:

```env
PORT=3000
NODE_ENV=production

# Ganti JWT_SECRET dengan string acak panjang!
JWT_SECRET=isi-dengan-string-acak-minimal-32-karakter

# Admin default
ADMIN_USER=admin
ADMIN_PASS=ganti-password-ini

# Sumber AIS
AIS_HOST=vps2.osi.my.id
AIS_PORT=6000
```

### 3. Install & konfigurasi Caddy

```bash
# Install Caddy (jika belum ada)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# Buat direktori log
sudo mkdir -p /var/log/caddy
sudo chown caddy:caddy /var/log/caddy

# Copy Caddyfile
sudo cp ~/ais-app/Caddyfile /etc/caddy/Caddyfile

# Restart Caddy
sudo systemctl reload caddy
```

### 4. Jalankan aplikasi dengan PM2

```bash
# Install PM2 jika belum ada
npm install -g pm2

cd ~/ais-app
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # ikuti instruksinya agar auto-start saat boot
```

### 5. Verifikasi

```bash
# Cek Node.js berjalan
pm2 status

# Cek Caddy berjalan
sudo systemctl status caddy

# Test health check
curl http://localhost:3000/healthz
curl https://map.osi.my.id/healthz

# Cek log
pm2 logs ais-tracker
sudo tail -f /var/log/caddy/ais-tracker.log
```

---

## Troubleshooting

### WebSocket tidak tersambung di HTTPS

**Gejala:** `WebSocket connection to 'ws://...' failed` di console browser

**Penyebab:** Browser memblokir `ws://` (tidak terenkripsi) saat halaman dibuka via `https://`

**Sudah diperbaiki:** Aplikasi sekarang otomatis pakai `wss://` saat diakses via HTTPS:
```javascript
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';
const WS_URL   = `${WS_PROTO}://${location.host}`;
```

Caddy **otomatis** meneruskan WebSocket tanpa konfigurasi tambahan.

---

### Cookie login tidak tersimpan

**Gejala:** Login berhasil tapi langsung logout / sumber tidak muncul

**Penyebab:** Cookie `SameSite=strict` tidak bisa dikirim di beberapa konfigurasi HTTPS

**Sudah diperbaiki:** Server otomatis set `SameSite=None; Secure` saat mendeteksi HTTPS via header `X-Forwarded-Proto`.

Pastikan Caddyfile mengirim header ini:
```
header_up X-Forwarded-Proto {scheme}
```

---

### Caddy tidak mau start (port 80/443 sudah terpakai)

```bash
# Cek proses yang pakai port 80/443
sudo ss -tlnp | grep -E ':80|:443'

# Stop nginx/apache jika ada
sudo systemctl stop nginx
sudo systemctl disable nginx
```

---

### Test WebSocket manual

Buka browser console di `https://map.osi.my.id` dan ketik:

```javascript
// Harus wss:// — bukan ws://
const ws = new WebSocket('wss://map.osi.my.id');
ws.onopen = () => console.log('✓ WebSocket terhubung!');
ws.onerror = e => console.error('✗ Error:', e);
```

---

### Cek sertifikat TLS

```bash
# Lihat sertifikat yang dikelola Caddy
sudo caddy list-certificates

# Test koneksi TLS
curl -v https://map.osi.my.id/healthz 2>&1 | grep -E "SSL|TLS|certificate|Connected"
```

---

## Konfigurasi Caddy Lengkap (referensi)

```caddy
map.osi.my.id {
    reverse_proxy localhost:3000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Real-IP        {remote_host}
        header_up X-Forwarded-For  {remote_host}
        header_up Host             {host}
    }
    header {
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        -Server
    }
}
```

> **Catatan:** Caddy tidak perlu konfigurasi khusus untuk WebSocket.  
> `reverse_proxy` secara otomatis meneruskan header `Upgrade: websocket` dan `Connection: Upgrade`.

---

## Ringkasan Perubahan dari v5 (untuk HTTPS/Caddy)

| Komponen | Perubahan |
|---|---|
| `public/index.html` | WS URL otomatis `wss://` saat HTTPS |
| `server.js` | `app.set('trust proxy', 1)` — percayai header Caddy |
| `server.js` | Cookie `secure: true` + `SameSite: none` otomatis saat HTTPS |
| `Caddyfile` | Konfigurasi lengkap dengan WebSocket, security headers |
| `DEPLOY.md` | Panduan ini |
