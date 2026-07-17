#include <WiFi.h>
#include <HTTPClient.h>

// ── WiFi ──────────────────────────────────────────────
const char* WIFI_SSID     = "MOU Clean";
const char* WIFI_PASSWORD = "rafif1212";

// ── AIS-APP Server ────────────────────────────────────
// Ganti dengan IP/hostname dan port server AIS-APP
// Contoh: "http://192.168.1.100:4000"
const char* SERVER_URL    = "http://192.168.1.21:4000";
const char* ENDPOINT      = "/api/zones/led";

// ── PIN GPIO ──────────────────────────────────────────
const int PIN_MERAH  = 32;   // Zona 1
const int PIN_KUNING = 25;   // Zona 2
const int PIN_HIJAU  = 33;   // Zona 3
const int PIN_BUZZER = 27;

// ── Timing ────────────────────────────────────────────
const unsigned long POLL_MS      = 2000;
const unsigned long BLINK_CYCLE  = 10000;  // 5s on + 5s off
const unsigned long BLINK_ON_MS  = 5000;

// ── State ─────────────────────────────────────────────
String previousLine = "";
unsigned long lastPoll = 0;

// YOLO State
int yoloStatus = 0;        // 0=idle, 1=match, 2=mismatch
int lastYoloStatus = -1;
unsigned long mismatchStart = 0;
bool lastBlinkPhase = false;

// Zone LED state (dari 3 field pertama)
int lastZ1 = 0, lastZ2 = 0, lastZ3 = 0;

// ── WiFi ──────────────────────────────────────────────
void connectWiFi() {
  Serial.print("[WiFi] Menghubungkan ke ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 40) {
    delay(500);
    Serial.print(".");
    tries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("\n[WiFi] Terhubung. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n[WiFi] Gagal. Restart...");
    ESP.restart();
  }
}

// ── LED Control ───────────────────────────────────────
void setLEDs(int merah, int kuning, int hijau) {
  digitalWrite(PIN_MERAH,  merah ? LOW : HIGH);
  digitalWrite(PIN_KUNING, kuning ? LOW : HIGH);
  digitalWrite(PIN_HIJAU,  hijau ? LOW : HIGH);

  Serial.print("[DEBUG] MERAH=");
Serial.print(digitalRead(PIN_MERAH));
Serial.print(" KUNING=");
Serial.print(digitalRead(PIN_KUNING));
Serial.print(" HIJAU=");
Serial.println(digitalRead(PIN_HIJAU));
}

void allOff() {
  digitalWrite(PIN_MERAH,  HIGH);
  digitalWrite(PIN_KUNING, HIGH);
  digitalWrite(PIN_HIJAU,  HIGH);
  digitalWrite(PIN_BUZZER, LOW);
}

void buzzerDouble() {
  for (int i = 0; i < 2; i++) {
    digitalWrite(PIN_BUZZER, HIGH);
    delay(120);
    digitalWrite(PIN_BUZZER, LOW);
    delay(120);
  }
}

void buzzerLong() {
  digitalWrite(PIN_BUZZER, HIGH);
  delay(1500);
  digitalWrite(PIN_BUZZER, LOW);
}

// ── Parse & Update ────────────────────────────────────
void updateLEDs(String line) {
  // Format: "zone1,zone2,zone3,yoloStatus"
  // Contoh: "1,0,1,0" normal, "1,0,1,1" match, "1,0,1,2" mismatch

  int i1 = line.indexOf(',');
  int i2 = line.indexOf(',', i1 + 1);
  int i3 = line.lastIndexOf(',');

  int z1 = 0, z2 = 0, z3 = 0, yolo = 0;

  if (i1 > 0) {
    z1 = line.substring(0, i1).toInt();
  }
  if (i1 > 0 && i2 > i1) {
    z2 = line.substring(i1 + 1, i2).toInt();
  }
  if (i2 > 0 && i3 > i2) {
    z3 = line.substring(i2 + 1, i3).toInt();
    yolo = line.substring(i3 + 1).toInt();
  }

  boolean lineChanged = (line != previousLine);
  previousLine = line;

  // Simpan zone state untuk mismatch blink
  lastZ1 = z1;
  lastZ2 = z2;
  lastZ3 = z3;

  // Update yoloStatus
  yoloStatus = yolo;

  // Print debug
  Serial.print("[LED] line=");
  Serial.print(line);
  Serial.print(" → Z1=");
  Serial.print(z1);
  Serial.print(" Z2=");
  Serial.print(z2);
  Serial.print(" Z3=");
  Serial.print(z3);
  Serial.print(" YOLO=");
  Serial.println(yolo);

  // Jika mismatch, setLEDs di-handle di loop() — jangan set di sini
  if (yolo == 2) {
    if (lastYoloStatus != 2) {
      // Transisi ke MISMATCH: buzzer panjang + mulai blink
      buzzerLong();
      mismatchStart = millis();
      lastBlinkPhase = false;
    }
    // Jangan set LED — loop() yang handle
  } else {
    // Normal atau MATCH: set LED sesuai zona
    setLEDs(z1, z2, z3);

    if (yolo == 1 && lastYoloStatus != 1) {
      // Transisi ke MATCH: buzzer 2x cepat
      buzzerDouble();
    }
  }

  lastYoloStatus = yolo;
}

// ── HTTP Poll ─────────────────────────────────────────
void pollLEDStatus() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    return;
  }

  HTTPClient http;
  String url = String(SERVER_URL) + ENDPOINT;

  http.begin(url);
  http.setTimeout(3000);

  int httpCode = http.GET();

  if (httpCode == HTTP_CODE_OK) {
    String payload = http.getString();

    int lineStart = payload.indexOf("\"line\":\"");
    if (lineStart > 0) {
      lineStart += 8;
      int lineEnd = payload.indexOf("\"", lineStart);
      if (lineEnd > lineStart) {
        String line = payload.substring(lineStart, lineEnd);
        updateLEDs(line);
      }
    } else {
      Serial.println("[HTTP] Field 'line' tidak ditemukan di response");
    }
  } else {
    Serial.print("[HTTP] Gagal, kode: ");
    Serial.println(httpCode);
  }

  http.end();

  pinMode(PIN_MERAH, OUTPUT);
  pinMode(PIN_KUNING, OUTPUT);
  pinMode(PIN_HIJAU, OUTPUT);
  digitalWrite(PIN_MERAH, lastZ1 ? LOW : HIGH);
  digitalWrite(PIN_KUNING, lastZ2 ? LOW : HIGH);
  digitalWrite(PIN_HIJAU, lastZ3 ? LOW : HIGH);
}

// ── SETUP ─────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(PIN_MERAH,  OUTPUT);
  pinMode(PIN_KUNING, OUTPUT);
  pinMode(PIN_HIJAU,  OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  allOff();

  Serial.println("\n=== AISNESIA — ESP32 Zone LED Controller ===");
  Serial.println("[SYS] Mode: HTTP Client (WiFi)");

  connectWiFi();

  Serial.print("[SYS] Server: ");
  Serial.print(SERVER_URL);
  Serial.println(ENDPOINT);
  Serial.println("[SYS] Siap polling...");
}

// ── LOOP ──────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // HTTP Poll
  if (now - lastPoll >= POLL_MS) {
    lastPoll = now;
    pollLEDStatus();
  }

  // Mismatch blink handler — loop terus sampai yoloStatus berubah
  if (yoloStatus == 2) {
    unsigned long elapsed = now - mismatchStart;
    bool onPhase = (elapsed % BLINK_CYCLE) < BLINK_ON_MS;

    if (onPhase != lastBlinkPhase) {
      lastBlinkPhase = onPhase;
      if (onPhase) {
        // 5 detik ON — semua LED nyala
        setLEDs(1, 1, 1);
      } else {
        // 5 detik OFF — semua LED mati
        setLEDs(0, 0, 0);
      }
      Serial.print("[BLINK] ");
      Serial.println(onPhase ? "ON" : "OFF");
    }
  }
}