#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>   // Library Manager -> "ArduinoJson" (Benoit Blanchon)
#include <DHT.h>

// WIFI_SSID, WIFI_PASSWORD and BACKEND_DEVICE_KEY live in wifi_secrets.h
// (same folder, never committed). Copy wifi_secrets.example.h to create it.
#include "wifi_secrets.h"

// ================= WIFI SETTINGS =================
const char* ssid     = WIFI_SSID;
const char* password = WIFI_PASSWORD;

// ================= BACKEND SETTINGS ==============
// Default: the hosted backend on Render. The board only needs internet access,
// it does NOT have to be on the same network as your laptop.
const char*    BACKEND_HOST       = "ai-smart-irrigation.onrender.com";
const uint16_t BACKEND_PORT       = 443;
const bool     BACKEND_USE_HTTPS  = true;
//
// To test against a backend running on your own PC instead, use:
//   BACKEND_HOST = "192.168.1.4" (your PC's IPv4), BACKEND_PORT = 3000,
//   BACKEND_USE_HTTPS = false, and keep both on the same Wi-Fi.
const unsigned long UPLOAD_INTERVAL_MS = 2000;   // send readings every 2 s

// ================= EXACT PINOUT ==================
#define SOIL_PIN   34   // Resistive Soil Moisture (AO) - ADC1
#define PH_PIN     35   // pH Sensor Module (Po / AO) - ADC1
#define LDR_PIN    32   // LDR Module (DO)
#define RAIN_PIN   27   // Rain Sensor Module (DO)
#define DHT_PIN     4   // DHT11 (DATA)
#define FLOW_PIN   18   // Water Flow Sensor YF-S201 (Yellow via 1k/2k divider)
#define RELAY_PIN  26   // BC548 Base (via 1k resistor) -> Low-Trigger Relay IN

#define DHTTYPE DHT11

// ============ FIXED CALIBRATION FLAGS ============
// BC548 + Low-Trigger Relay ke liye false zaroori hai
#define RELAY_ACTIVE_LOW false
#define LDR_DAY_LOW      true   // Day/Night ulta dikhe toh false kar dena

const int SOIL_DRY_RAW = 3800;  // Sookhi mitti / hawa mein reading
const int SOIL_WET_RAW = 1500;  // Geeli mitti / paani mein reading

// pH Calibration Offset (Saaf paani mein 7.0 se jitna kam/zyada aaye yahan adjust karein)
const float PH_OFFSET  = 0.0;

const int PUMP_ON_THRESHOLD  = 35;  // 35% se kam par Pump ON
const int PUMP_OFF_THRESHOLD = 60;  // 60% se zyada par Pump OFF

// ================= OBJECTS & VARS ================
DHT dht(DHT_PIN, DHTTYPE);
WebServer server(80);

portMUX_TYPE flowMux = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t pulseCount = 0;

int soilRaw = 0;
int soilPercent = 0;
float phVoltage = 2.50;
float phValue = 7.0;
float temperature = 0.0;
float humidity = 0.0;
bool isRaining = false;
bool isDaylight = true;
float flowRateLPM = 0.0;
float totalLiters = 0.0;

bool autoMode = true;
bool pumpState = false;
unsigned long lastUpdate = 0;

// --- backend sync state (only used by the upload code) ---
bool dhtValid = false;            // becomes true after the first good DHT11 read
uint32_t lastCmdId = 0;           // newest dashboard command already applied

// Water Flow Interrupt
void IRAM_ATTR flowISR() {
  portENTER_CRITICAL_ISR(&flowMux);
  pulseCount++;
  portEXIT_CRITICAL_ISR(&flowMux);
}

// Relay Control Function
void setPump(bool turnOn) {
  pumpState = turnOn;
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(RELAY_PIN, turnOn ? LOW : HIGH);
  } else {
    digitalWrite(RELAY_PIN, turnOn ? HIGH : LOW);
  }
}

// Smart Agronomic Advice Generator
String getSmartTip() {
  if (isRaining) {
    return "Baarish detect hui hai: Auto-irrigation paused hai taaki waterlogging na ho.";
  }
  if (phValue < 5.5) {
    return "Paani/Soil zyada Acidic hai (pH " + String(phValue, 1) + "): Agricultural lime (choona) milane ki salah di jati hai.";
  }
  if (phValue > 8.0) {
    return "Paani/Soil zyada Alkaline hai (pH " + String(phValue, 1) + "): Gypsum ya organic compost use karein.";
  }
  if (soilPercent < PUMP_ON_THRESHOLD) {
    if (isDaylight && temperature > 35.0) {
      return "Mitti sookhi hai aur garmi zyada hai; watering ON hai (shaam ko paani dena best rehta hai).";
    }
    return "Mitti sookhi hai (" + String(soilPercent) + "%): Pump ON kar diya gaya hai.";
  }
  if (soilPercent > 75) {
    return "Mitti mein kaafi nami hai: Abhi paani dene ki zaroorat nahi hai.";
  }
  return "Soil moisture aur pH (" + String(phValue, 1) + ") normal range mein hain.";
}

// ================= WEB DASHBOARD HTML =================
const char MAIN_PAGE[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Smart Irrigation Dashboard</title>
  <style>
    body { font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 16px; text-align: center; }
    h2 { color: #38bdf8; margin-bottom: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; max-width: 720px; margin: auto; }
    .card { background: #1e293b; padding: 14px; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.3); }
    .label { font-size: 13px; color: #94a3b8; }
    .val { font-size: 24px; font-weight: bold; margin-top: 6px; color: #e2e8f0; }
    .tip { max-width: 692px; margin: 14px auto; background: #1e3a5f; border-left: 4px solid #38bdf8; padding: 12px; border-radius: 8px; text-align: left; font-size: 14px; }
    .controls { max-width: 720px; margin: 16px auto; display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
    button { padding: 12px 18px; border: none; border-radius: 8px; font-size: 15px; font-weight: bold; cursor: pointer; color: #fff; }
    .btn-auto { background: #0284c7; }
    .btn-on { background: #16a34a; }
    .btn-off { background: #dc2626; }
    .btn-reset { background: #64748b; }
  </style>
</head>
<body>
  <h2>Smart Irrigation System (ESP32)</h2>
  <div class="grid">
    <div class="card"><div class="label">Soil Moisture</div><div class="val" id="soil">--%</div></div>
    <div class="card"><div class="label">Water / Soil pH</div><div class="val" id="ph">7.0</div></div>
    <div class="card"><div class="label">Temperature</div><div class="val" id="temp">-- °C</div></div>
    <div class="card"><div class="label">Humidity</div><div class="val" id="hum">--%</div></div>
    <div class="card"><div class="label">Rain Status</div><div class="val" id="rain">--</div></div>
    <div class="card"><div class="label">Light (LDR)</div><div class="val" id="light">--</div></div>
    <div class="card"><div class="label">Water Flow</div><div class="val" id="flow">0.0 L/m</div></div>
    <div class="card"><div class="label">Total Water</div><div class="val" id="total">0.00 L</div></div>
    <div class="card"><div class="label">Pump / Mode</div><div class="val" id="pump">--</div></div>
  </div>
  <div class="tip"><b>Smart Advice:</b> <span id="tip">Loading...</span></div>
  <div class="controls">
    <button class="btn-auto" onclick="cmd('/mode?auto=1')">AUTO MODE</button>
    <button class="btn-on" onclick="cmd('/pump?state=1')">MANUAL PUMP ON</button>
    <button class="btn-off" onclick="cmd('/pump?state=0')">MANUAL PUMP OFF</button>
    <button class="btn-reset" onclick="cmd('/resetflow')">RESET LITERS</button>
  </div>
  <script>
    async function refresh() {
      try {
        const res = await fetch('/data');
        const d = await res.json();
        document.getElementById('soil').innerText = d.soil + '%';
        document.getElementById('ph').innerText = d.ph.toFixed(1) + ' pH';
        document.getElementById('temp').innerText = d.temp.toFixed(1) + ' °C';
        document.getElementById('hum').innerText = d.hum.toFixed(0) + '%';
        document.getElementById('rain').innerText = d.rain ? 'RAINING' : 'DRY';
        document.getElementById('light').innerText = d.day ? 'DAY' : 'NIGHT';
        document.getElementById('flow').innerText = d.flow.toFixed(2) + ' L/m';
        document.getElementById('total').innerText = d.total.toFixed(2) + ' L';
        document.getElementById('pump').innerText = (d.pump ? 'ON' : 'OFF') + ' (' + (d.auto ? 'AUTO' : 'MAN') + ')';
        document.getElementById('tip').innerText = d.tip;
      } catch(e) {}
    }
    async function cmd(url) { await fetch(url); refresh(); }
    setInterval(refresh, 1500);
    refresh();
  </script>
</body>
</html>
)rawliteral";

// ================= WEB ROUTES =================
void handleRoot() {
  server.send(200, "text/html", MAIN_PAGE);
}

void handleData() {
  String json = "{";
  json += "\"soil\":" + String(soilPercent) + ",";
  json += "\"soilRaw\":" + String(soilRaw) + ",";
  json += "\"ph\":" + String(phValue, 2) + ",";
  json += "\"phV\":" + String(phVoltage, 2) + ",";
  json += "\"temp\":" + String(temperature, 1) + ",";
  json += "\"hum\":" + String(humidity, 1) + ",";
  json += "\"rain\":" + String(isRaining ? "true" : "false") + ",";
  json += "\"day\":" + String(isDaylight ? "true" : "false") + ",";
  json += "\"flow\":" + String(flowRateLPM, 2) + ",";
  json += "\"total\":" + String(totalLiters, 2) + ",";
  json += "\"pump\":" + String(pumpState ? "true" : "false") + ",";
  json += "\"auto\":" + String(autoMode ? "true" : "false") + ",";
  json += "\"tip\":\"" + getSmartTip() + "\"";
  json += "}";
  server.send(200, "application/json", json);
}

void handleMode() {
  if (server.hasArg("auto")) {
    autoMode = (server.arg("auto") == "1");
  }
  server.send(200, "text/plain", "OK");
}

void handlePump() {
  if (server.hasArg("state")) {
    autoMode = false;
    setPump(server.arg("state") == "1");
  }
  server.send(200, "text/plain", "OK");
}

void handleResetFlow() {
  totalLiters = 0.0;
  server.send(200, "text/plain", "OK");
}

// ================= BACKEND SYNC =================
// Applies a command from the web dashboard. Each branch does exactly what the
// ESP32's own web page does (handleMode / handlePump / handleResetFlow above).
void applyBackendCommand(const char* type, int value) {
  if (strcmp(type, "pump") == 0) {
    autoMode = false;
    setPump(value == 1);
  } else if (strcmp(type, "mode") == 0) {
    autoMode = (value == 1);
  } else if (strcmp(type, "resetFlow") == 0) {
    totalLiters = 0.0;
  }
  Serial.printf("Dashboard command applied: %s = %d\n", type, value);
}

// Connection and HTTP client are kept between uploads, so the HTTPS handshake
// happens once and later uploads take a few milliseconds.
WiFiClientSecure secureClient;
WiFiClient plainClient;
HTTPClient http;

// Result of one upload attempt.
const int UPLOAD_FAILED = -1;
const int UPLOAD_OK = 0;
const int UPLOAD_APPLIED_COMMAND = 1;

// Sends the latest readings to the backend. The reply carries any pending
// commands from the dashboard (pump on/off, auto/manual, reset litres).
// Runs in its own task (see uploadTask) so a slow network never delays the
// sensor reading and pump logic in loop().
int sendToBackend() {
  if (WiFi.status() != WL_CONNECTED) return UPLOAD_FAILED;

  String tip = getSmartTip();
  tip.replace("\\", "");
  tip.replace("\"", "'");

  String body = "{";
  body += "\"soil\":" + String(soilRaw) + ",";                    // raw ADC
  body += "\"soilPercent\":" + String(soilPercent) + ",";
  body += "\"ph\":" + String(phValue, 2) + ",";
  body += "\"phVoltage\":" + String(phVoltage, 2) + ",";
  body += "\"temperature\":" + (dhtValid ? String(temperature, 1) : String("null")) + ",";
  body += "\"humidity\":" + (dhtValid ? String(humidity, 1) : String("null")) + ",";
  body += "\"rain\":" + String(isRaining ? 1 : 0) + ",";
  body += "\"ldr\":" + String(isDaylight ? 1 : 0) + ",";           // 1 = day
  body += "\"flow\":" + String(flowRateLPM, 2) + ",";               // L/min
  body += "\"totalLiters\":" + String(totalLiters, 2) + ",";
  body += "\"pump\":" + String(pumpState ? 1 : 0) + ",";
  body += "\"autoMode\":" + String(autoMode ? 1 : 0) + ",";
  body += "\"tip\":\"" + tip + "\",";
  body += "\"lastCmdId\":" + String(lastCmdId);
  body += "}";

  // A sleeping Render service can need up to a minute to wake: that only
  // delays this task, never the pump logic.
  http.setReuse(true);
  http.setConnectTimeout(8000);
  http.setTimeout(10000);

  bool began = BACKEND_USE_HTTPS
    ? http.begin(secureClient, BACKEND_HOST, BACKEND_PORT, "/api/sensor-data", true)
    : http.begin(plainClient, BACKEND_HOST, BACKEND_PORT, "/api/sensor-data");
  if (!began) {
    Serial.println("Backend: begin() failed");
    return UPLOAD_FAILED;
  }
  http.addHeader("Content-Type", "application/json");
  if (strlen(BACKEND_DEVICE_KEY) > 0) http.addHeader("X-Device-Key", BACKEND_DEVICE_KEY);

  int code = http.POST(body);
  if (code != 200) {
    Serial.printf("Backend: upload failed (HTTP %d) -> %s://%s:%u\n",
                  code, BACKEND_USE_HTTPS ? "https" : "http", BACKEND_HOST, (unsigned)BACKEND_PORT);
    if (code < 0) Serial.println("  Cannot reach the server: check the Wi-Fi has internet. A sleeping Render service can take ~1 min to wake up.");
    if (code == 401) Serial.println("  Device key rejected: BACKEND_DEVICE_KEY must equal DEVICE_KEY on the backend.");
    http.end();
    secureClient.stop();
    plainClient.stop();
    return UPLOAD_FAILED;
  }

  String reply = http.getString();
  http.end();

  // Only the "commands" array matters to us.
  StaticJsonDocument<96> filter;
  filter["commands"][0]["id"] = true;
  filter["commands"][0]["type"] = true;
  filter["commands"][0]["value"] = true;

  StaticJsonDocument<768> doc;
  DeserializationError err = deserializeJson(doc, reply, DeserializationOption::Filter(filter));
  if (err) {
    Serial.printf("Backend: reply parse error: %s\n", err.c_str());
    return UPLOAD_OK;
  }

  bool applied = false;
  for (JsonObject cmd : doc["commands"].as<JsonArray>()) {
    uint32_t id = cmd["id"].as<uint32_t>();
    if (id <= lastCmdId) continue;           // already applied
    applyBackendCommand(cmd["type"] | "", cmd["value"] | 0);
    lastCmdId = id;
    applied = true;
  }

  return applied ? UPLOAD_APPLIED_COMMAND : UPLOAD_OK;
}

// Background task (core 0): upload every UPLOAD_INTERVAL_MS. After applying a
// dashboard command it reports the new state immediately; after a failure it
// waits a little longer before trying again.
void uploadTask(void* unused) {
  for (;;) {
    int result = sendToBackend();
    if (result == UPLOAD_APPLIED_COMMAND) continue;
    vTaskDelay(pdMS_TO_TICKS(result == UPLOAD_FAILED ? 5000 : UPLOAD_INTERVAL_MS));
  }
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  delay(500);

  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LOW ? HIGH : LOW);
  pinMode(RELAY_PIN, OUTPUT);
  setPump(false);

  pinMode(SOIL_PIN, INPUT);
  pinMode(PH_PIN, INPUT);
  pinMode(LDR_PIN, INPUT);
  pinMode(RAIN_PIN, INPUT);
  pinMode(FLOW_PIN, INPUT);

  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), flowISR, RISING);
  dht.begin();

  Serial.print("Connecting to WiFi: ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);

  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 20) {
    delay(500);
    Serial.print(".");
    tries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi Connected!");
    Serial.print("Dashboard URL -> http://");
    Serial.println(WiFi.localIP());
    Serial.printf("Backend       -> %s://%s:%u\n", BACKEND_USE_HTTPS ? "https" : "http", BACKEND_HOST, (unsigned)BACKEND_PORT);

    server.on("/", handleRoot);
    server.on("/data", handleData);
    server.on("/mode", handleMode);
    server.on("/pump", handlePump);
    server.on("/resetflow", handleResetFlow);
    server.begin();
  } else {
    Serial.println("\nWiFi not connected. Running in Offline AutoMode!");
  }

  // Cloud upload runs beside loop(): HTTPS to the backend (no certificate
  // pinning; the readings are not secret and the device key is only a gate).
  secureClient.setInsecure();
  xTaskCreatePinnedToCore(uploadTask, "upload", 16384, NULL, 1, NULL, 0);
}

// ================= MAIN LOOP =================
void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    server.handleClient();
  }

  if (millis() - lastUpdate >= 1000) {
    unsigned long elapsed = millis() - lastUpdate;
    lastUpdate = millis();

    // 1. Water Flow (YF-S201)
    uint32_t pulses = 0;
    portENTER_CRITICAL(&flowMux);
    pulses = pulseCount;
    pulseCount = 0;
    portEXIT_CRITICAL(&flowMux);

    float seconds = elapsed / 1000.0;
    flowRateLPM = (pulses / seconds) / 7.5;
    totalLiters += (pulses / 450.0);

    // 2. Resistive Soil Moisture (5-sample average)
    long soilSum = 0;
    for (int i = 0; i < 5; i++) {
      soilSum += analogRead(SOIL_PIN);
      delay(2);
    }
    soilRaw = soilSum / 5;
    int mappedSoil = map(soilRaw, SOIL_DRY_RAW, SOIL_WET_RAW, 0, 100);
    soilPercent = constrain(mappedSoil, 0, 100);

    // 3. pH Sensor (10-sample average)
    long phSum = 0;
    for (int i = 0; i < 10; i++) {
      phSum += analogRead(PH_PIN);
      delay(2);
    }
    float phRawAvg = phSum / 10.0;
    phVoltage = phRawAvg * (3.3 / 4095.0);
    float rawPh = 7.0 + ((2.50 - phVoltage) / 0.18) + PH_OFFSET;
    phValue = constrain(rawPh, 0.0, 14.0);

    // 4. Rain & LDR (Digital)
    isRaining  = (digitalRead(RAIN_PIN) == LOW);
    isDaylight = LDR_DAY_LOW ? (digitalRead(LDR_PIN) == LOW) : (digitalRead(LDR_PIN) == HIGH);

    // 5. DHT11 (Temp & Humidity)
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t)) temperature = t;
    if (!isnan(h)) humidity = h;
    if (!isnan(t) && !isnan(h)) dhtValid = true;

    // 6. AutoMode Decision Logic
    if (autoMode) {
      if (isRaining) {
        setPump(false);
      } else if (soilPercent < PUMP_ON_THRESHOLD) {
        setPump(true);
      } else if (soilPercent > PUMP_OFF_THRESHOLD) {
        setPump(false);
      }
    }

    // 7. Serial Monitor Output
    Serial.printf("Soil: %d%% (Raw:%d) | pH: %.2f (%.2fV) | Temp: %.1fC | Hum: %.0f%% | Rain: %s | Light: %s | Flow: %.2f L/m | Pump: %s [%s]\n",
                  soilPercent, soilRaw, phValue, phVoltage, temperature, humidity,
                  isRaining ? "YES" : "NO",
                  isDaylight ? "DAY" : "NIGHT",
                  flowRateLPM,
                  pumpState ? "ON" : "OFF",
                  autoMode ? "AUTO" : "MANUAL");
  }
}
// ===== END OF CODE =====
