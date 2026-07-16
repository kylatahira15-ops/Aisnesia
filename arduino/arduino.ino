#include <WiFi.h>
#include <PubSubClient.h>

// ── WiFi ──────────────────────────────────────────────
const char* WIFI_SSID     = "Milik Alfarezzz";
const char* WIFI_PASSWORD = "alfarezzganteng";

// ── MQTT ──────────────────────────────────────────────
const char* MQTT_SERVER   = "192.168.1.122";
const int   MQTT_PORT     = 1883;
const char* MQTT_TOPIC    = "ais/actuator/line";

// ── PIN GPIO ──────────────────────────────────────────
const int PIN_MERAH  = 25;
const int PIN_KUNING = 32;
const int PIN_HIJAU  = 33;
const int PIN_BUZZER = 27;

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

unsigned long lastReconnect = 0;

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

// ── MQTT ──────────────────────────────────────────────
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  char buf[32];
  unsigned int len = length < sizeof(buf) - 1 ? length : sizeof(buf) - 1;
  memcpy(buf, payload, len);
  buf[len] = '\0';

  String msg = String(buf);
  msg.trim();

  Serial.print("[MQTT] ");
  Serial.print(topic);
  Serial.print(": ");
  Serial.println(msg);

  // Format: "outer,zone2,sync"
  int outer = msg.substring(0, 1).toInt();
  int zone2 = msg.substring(2, 3).toInt();
  int sync  = msg.substring(4, 5).toInt();

  if (sync == 1) {
    setState(3);
  } else if (zone2 == 1) {
    setState(2);
  } else if (outer == 1) {
    setState(1);
  } else {
    setState(0);
  }
}

void connectMQTT() {
  while (!mqtt.connected()) {
    Serial.print("[MQTT] Menghubungkan... ");
    String clientId = "ESP32_AC";
    if (mqtt.connect(clientId.c_str())) {
      Serial.println("OK");
      mqtt.subscribe(MQTT_TOPIC);
      Serial.print("[MQTT] Subscribe: ");
      Serial.println(MQTT_TOPIC);
    } else {
      Serial.print("Gagal (rc=");
      Serial.print(mqtt.state());
      Serial.println("). Coba lagi 3s...");
      delay(3000);
    }
  }
}

// ── STATE ─────────────────────────────────────────────
// state: 0=idle, 1=green, 2=yellow, 3=red
int currentState = -1;

void allOff() {
  digitalWrite(PIN_MERAH,  LOW);
  digitalWrite(PIN_KUNING, LOW);
  digitalWrite(PIN_HIJAU,  LOW);
  digitalWrite(PIN_BUZZER, LOW);
}

void setState(int state) {
  if (state == currentState) return;
  currentState = state;

  allOff();

  switch (state) {
    case 0:
      Serial.println("[STATE] idle — semua off");
      break;
    case 1:
      Serial.println("[STATE] green — kapal di zona luar");
      digitalWrite(PIN_HIJAU, HIGH);
      digitalWrite(PIN_BUZZER, HIGH);
      delay(200);
      digitalWrite(PIN_BUZZER, LOW);
      break;
    case 2:
      Serial.println("[STATE] yellow — kapal di zona sandar");
      digitalWrite(PIN_KUNING, HIGH);
      digitalWrite(PIN_BUZZER, HIGH);
      delay(500);
      digitalWrite(PIN_BUZZER, LOW);
      break;
    case 3:
      Serial.println("[STATE] red — kapal sandar + kamera konfirmasi");
      digitalWrite(PIN_MERAH, HIGH);
      digitalWrite(PIN_BUZZER, HIGH);
      break;
  }
}

// ── SETUP ─────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(PIN_MERAH,  OUTPUT);
  pinMode(PIN_KUNING, OUTPUT);
  pinMode(PIN_HIJAU,  OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);

  digitalWrite(PIN_MERAH,  LOW);
  digitalWrite(PIN_KUNING, LOW);
  digitalWrite(PIN_HIJAU,  LOW);
  digitalWrite(PIN_BUZZER, LOW);

  Serial.println("\n=== AISNESIA — ESP32 Actuator ===");

  connectWiFi();
  mqtt.setServer(MQTT_SERVER, MQTT_PORT);
  mqtt.setCallback(mqttCallback);

  Serial.println("[SYS] Siap menerima MQTT...");
}

// ── LOOP ──────────────────────────────────────────────
void loop() {
  if (!mqtt.connected()) {
    connectMQTT();
  }
  mqtt.loop();
}
