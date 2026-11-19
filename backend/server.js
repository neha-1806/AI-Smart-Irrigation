
require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { GoogleGenAI } = require("@google/genai");
const {
    createAuthRouter,
    requireAuth,
    requireRole,
    verifyToken
} = require("./auth");

const app = express();
const server = http.createServer(app);

// Only signed-in users may open the live-data socket. Browsers cannot set
// headers on a WebSocket, so the token travels as ?token=...
const wss = new WebSocket.Server({
    server,
    verifyClient: ({ req }, done) => {
        const token = new URL(req.url, "http://localhost").searchParams.get("token");
        const user = verifyToken(token);

        if (!user) return done(false, 401, "Unauthorized");

        req.authUser = user.userId;
        done(true);
    }
});

app.use(
    cors({
        origin: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            // Deployed dashboard (Vercel). Add more with CORS_ORIGINS=a,b in the environment.
            "https://ai-smart-irrigation-snowy.vercel.app",
            ...String(process.env.CORS_ORIGINS || "")
                .split(",")
                .map((origin) => origin.trim().replace(/\/$/, ""))
                .filter(Boolean),
            // Dashboard opened from another device on the same Wi-Fi
            // (e.g. http://192.168.1.4:5173 on a phone).
            /^http:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):5173$/
        ]
    })
);
app.use(express.json({ limit: "1mb" }));

// --------------------------------------------------
// ACCESS CONTROL
// --------------------------------------------------
// Everything under /api needs a signed-in user, except:
//   - the ESP32 posting its readings (the firmware has no login), and
//   - the sign-in / sign-up calls themselves.
// Role rules (admin vs viewer) are applied on the individual routes.

const PUBLIC_API = new Set([
    "POST /api/sensor-data",
    "GET /api/auth/status",
    "POST /api/auth/login",
    "POST /api/auth/register"
]);

app.use("/api", (req, res, next) => {
    const route = `${req.method} ${req.baseUrl}${req.path}`.replace(/\/+$/, "");

    if (PUBLIC_API.has(route)) return next();

    requireAuth(req, res, next);
});

app.use(
    "/api/auth",
    createAuthRouter({
        // A deleted user's open live-data sockets are closed immediately.
        onUserRemoved: (userId) => {
            wss.clients.forEach((client) => {
                if (client.authUser === userId) client.close(4401, "Account removed");
            });
        }
    })
);

const adminOnly = requireRole("admin");

let latestSensorData = null;
let lastSensorAt = 0; // Date.now() of the last ESP32 packet

// Keeps the most recent readings so the dashboard can draw trends.
const SENSOR_HISTORY_LIMIT = 300;
let sensorHistory = [];

// --------------------------------------------------
// ESP32 DEVICE SYNC
// --------------------------------------------------
// The ESP32 POSTs its readings every couple of seconds. The backend
// answers each POST with any pending dashboard commands (pump on/off,
// auto/manual mode, reset litres). The ESP32 applies them exactly like
// its own local web page does and reports back the highest command id it
// handled (lastCmdId), which lets the backend drop them from the queue.

const DEVICE_ONLINE_MS = 15000;   // no packet for this long => device offline
const COMMAND_TTL_MS = 60000;     // un-acknowledged commands expire
const COMMAND_QUEUE_LIMIT = 10;

let commandQueue = [];
// Start from the clock (seconds) so ids keep increasing across backend
// restarts; the ESP32 ignores ids at or below the last one it applied.
let nextCommandId = Math.floor(Date.now() / 1000);

// Same thresholds / calibration as the ESP32 firmware.
const SOIL_DRY_RAW = 3800;
const SOIL_WET_RAW = 1500;
const PUMP_ON_THRESHOLD = 35;
const PUMP_OFF_THRESHOLD = 60;

function isDeviceOnline() {
    return lastSensorAt > 0 && Date.now() - lastSensorAt < DEVICE_ONLINE_MS;
}

function pruneCommands() {
    const now = Date.now();
    commandQueue = commandQueue.filter(
        (command) => now - command.createdAt < COMMAND_TTL_MS
    );
}

function enqueueCommand(type, value) {
    pruneCommands();

    const command = {
        id: nextCommandId++,
        type,
        value,
        createdAt: Date.now()
    };

    commandQueue.push(command);

    if (commandQueue.length > COMMAND_QUEUE_LIMIT) {
        commandQueue = commandQueue.slice(-COMMAND_QUEUE_LIMIT);
    }

    return command;
}

function toBoolean(value) {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true") return true;
    if (value === 0 || value === "0" || value === "false") return false;
    return null;
}

function truthyFlag(value) {
    return value === true || value === 1 || value === "1" || value === "true";
}

function soilPercentFrom(data) {
    if (!data) return null;

    const percent = Number(data.soilPercent);
    if (data.soilPercent !== undefined && data.soilPercent !== null && Number.isFinite(percent)) {
        return Math.min(100, Math.max(0, percent));
    }

    const raw = Number(data.soil);
    if (data.soil === undefined || data.soil === null || !Number.isFinite(raw)) {
        return null;
    }

    const mapped =
        ((raw - SOIL_DRY_RAW) * 100) / (SOIL_WET_RAW - SOIL_DRY_RAW);

    return Math.min(100, Math.max(0, Math.round(mapped)));
}

function broadcast(payload) {
    const message = JSON.stringify(payload);

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

let farmProfile = {
    crop: "",
    soilType: "",
    city: "Sonipat",
    farmArea: ""
};

// --------------------------------------------------
// BASIC BACKEND STATUS
// --------------------------------------------------

app.get("/", (req, res) => {
    res.json({
        message: "Smart Irrigation Backend is running",
        aiProvider: "Gemini",
        endpoints: [
            "POST /api/auth/register | /api/auth/login | GET /api/auth/me",
            "GET /api/sensor-data   (sign-in required; so is everything below except the ESP32 post)",
            "POST /api/sensor-data   (ESP32 -> backend, replies with pending commands)",
            "GET /api/sensor-history",
            "GET /api/device/status",
            "POST /api/device/pump   { state: true|false }",
            "POST /api/device/mode   { auto: true|false }",
            "POST /api/device/reset-flow",
            "GET /api/weather?city=Sonipat",
            "GET /api/smart-recommendation?city=Sonipat",
            "GET /api/farm-profile",
            "POST /api/farm-profile",
            "POST /api/chat"
        ]
    });
});

// --------------------------------------------------
// SENSOR DATA
// --------------------------------------------------

// The ESP32 cannot sign in, so on a public server it proves itself with a shared
// key (header X-Device-Key). Set DEVICE_KEY in the environment to require it;
// when it is not set (local use) any device on the network may post.
function requireDeviceKey(req, res, next) {
    const expected = process.env.DEVICE_KEY;

    if (!expected) return next();

    const given = Buffer.from(String(req.get("x-device-key") || ""));
    const wanted = Buffer.from(expected);

    if (given.length === wanted.length && require("crypto").timingSafeEqual(given, wanted)) {
        return next();
    }

    res.status(401).json({ error: "Wrong or missing device key." });
}

app.post("/api/sensor-data", requireDeviceKey, (req, res) => {
    if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
    ) {
        return res.status(400).json({
            error: "Send sensor data as a JSON object."
        });
    }

    // lastCmdId is device bookkeeping, not a sensor reading.
    const { lastCmdId, ...reading } = req.body;

    if (typeof reading.tip === "string") {
        reading.tip = reading.tip.slice(0, 300);
    }

    lastSensorAt = Date.now();
    latestSensorData = {
        ...reading,
        receivedAt: new Date(lastSensorAt).toISOString()
    };

    // Drop commands the ESP32 has already applied (and expired ones).
    const acked = Number(lastCmdId);
    if (Number.isFinite(acked)) {
        commandQueue = commandQueue.filter((command) => command.id > acked);
    }
    pruneCommands();

    const historyPoint = { t: lastSensorAt };
    for (const key of [
        "soil", "soilPercent", "ph", "temperature", "humidity", "flow", "totalLiters"
    ]) {
        const value = Number(latestSensorData[key]);
        if (latestSensorData[key] !== null && latestSensorData[key] !== undefined && Number.isFinite(value)) {
            historyPoint[key] = value;
        }
    }
    historyPoint.pump = truthyFlag(latestSensorData.pump) ? 1 : 0;
    historyPoint.rain = truthyFlag(latestSensorData.rain) ? 1 : 0;

    sensorHistory.push(historyPoint);
    if (sensorHistory.length > SENSOR_HISTORY_LIMIT) {
        sensorHistory = sensorHistory.slice(-SENSOR_HISTORY_LIMIT);
    }

    broadcast({
        type: "sensor-data",
        data: latestSensorData,
        online: true
    });

    console.log(
        `Sensor data received: soil=${latestSensorData.soil} (${latestSensorData.soilPercent}%) ` +
        `pump=${latestSensorData.pump} auto=${latestSensorData.autoMode} ` +
        `pendingCommands=${commandQueue.length}`
    );

    // Small reply: the ESP32 only needs the pending commands.
    res.json({
        message: "Sensor data received successfully",
        receivedAt: latestSensorData.receivedAt,
        commands: commandQueue.map(({ id, type, value }) => ({ id, type, value }))
    });
});

app.get("/api/sensor-data", (req, res) => {
    res.json({
        data: latestSensorData,
        online: isDeviceOnline(),
        ageMs: lastSensorAt ? Date.now() - lastSensorAt : null
    });
});

app.get("/api/sensor-history", (req, res) => {
    const limit = Math.min(
        SENSOR_HISTORY_LIMIT,
        Math.max(1, Number(req.query.limit) || 120)
    );

    res.json({ history: sensorHistory.slice(-limit) });
});

// --------------------------------------------------
// DEVICE CONTROL (dashboard -> ESP32)
// --------------------------------------------------

function rejectIfOffline(res) {
    if (isDeviceOnline()) return false;

    res.status(503).json({
        error:
            "The ESP32 is offline, so the command was not sent. Check its power and Wi-Fi."
    });

    return true;
}

app.get("/api/device/status", (req, res) => {
    pruneCommands();

    res.json({
        online: isDeviceOnline(),
        lastSeen: lastSensorAt ? new Date(lastSensorAt).toISOString() : null,
        ageMs: lastSensorAt ? Date.now() - lastSensorAt : null,
        pendingCommands: commandQueue.length
    });
});

// Manual pump switch. Like the ESP32's own /pump page this also leaves AUTO mode.
app.post("/api/device/pump", adminOnly, (req, res) => {
    const state = toBoolean(req.body?.state);

    if (state === null) {
        return res.status(400).json({
            error: "Send { \"state\": true } or { \"state\": false }."
        });
    }

    if (rejectIfOffline(res)) return;

    const command = enqueueCommand("pump", state ? 1 : 0);
    console.log(`Dashboard command #${command.id}: pump ${state ? "ON" : "OFF"} (manual)`);

    res.json({ message: "Pump command queued for the ESP32.", command });
});

app.post("/api/device/mode", adminOnly, (req, res) => {
    const auto = toBoolean(req.body?.auto);

    if (auto === null) {
        return res.status(400).json({
            error: "Send { \"auto\": true } or { \"auto\": false }."
        });
    }

    if (rejectIfOffline(res)) return;

    const command = enqueueCommand("mode", auto ? 1 : 0);
    console.log(`Dashboard command #${command.id}: ${auto ? "AUTO" : "MANUAL"} mode`);

    res.json({ message: "Mode command queued for the ESP32.", command });
});

app.post("/api/device/reset-flow", adminOnly, (req, res) => {
    if (rejectIfOffline(res)) return;

    const command = enqueueCommand("resetFlow", 1);
    console.log(`Dashboard command #${command.id}: reset litres`);

    res.json({ message: "Reset command queued for the ESP32.", command });
});

// --------------------------------------------------
// FARM PROFILE
// --------------------------------------------------

app.get("/api/farm-profile", (req, res) => {
    res.json({ profile: farmProfile });
});

app.post("/api/farm-profile", adminOnly, (req, res) => {
    const { crop, soilType, city, farmArea } = req.body || {};

    farmProfile = {
        crop:
            typeof crop === "string"
                ? crop.trim().slice(0, 100)
                : farmProfile.crop,

        soilType:
            typeof soilType === "string"
                ? soilType.trim().slice(0, 100)
                : farmProfile.soilType,

        city:
            typeof city === "string" && city.trim()
                ? city.trim().slice(0, 100)
                : farmProfile.city,

        farmArea:
            typeof farmArea === "string"
                ? farmArea.trim().slice(0, 50)
                : farmProfile.farmArea
    };

    res.json({
        message: "Farm profile saved for this server session.",
        profile: farmProfile
    });
});

// --------------------------------------------------
// CURRENT WEATHER API
// --------------------------------------------------

async function getWeather(city) {
    const apiKey = process.env.OPENWEATHER_API_KEY;

    if (!apiKey) {
        throw new Error(
            "Weather API key is missing in backend/.env."
        );
    }

    const url = new URL(
        "https://api.openweathermap.org/data/2.5/weather"
    );

    url.searchParams.set("q", city);
    url.searchParams.set("appid", apiKey);
    url.searchParams.set("units", "metric");

    const response = await fetch(url);
    const weather = await response.json();

    if (!response.ok) {
        throw new Error(
            weather.message || "Weather request failed."
        );
    }

    return {
        city: weather.name,
        temperature: weather.main.temp,
        feelsLike: weather.main.feels_like,
        humidity: weather.main.humidity,
        condition:
            weather.weather?.[0]?.description || "unknown",
        conditionMain:
            weather.weather?.[0]?.main || "unknown",
        windSpeed: weather.wind.speed
    };
}

app.get("/api/weather", async (req, res) => {
    try {
        const weather = await getWeather(
            req.query.city || farmProfile.city || "Sonipat"
        );

        res.json(weather);
    } catch (error) {
        console.error("Weather API error:", error.message);

        res.status(502).json({
            error: error.message
        });
    }
});

// --------------------------------------------------
// SMART IRRIGATION RECOMMENDATION
// --------------------------------------------------

app.get("/api/smart-recommendation", async (req, res) => {
    if (!latestSensorData) {
        return res.status(400).json({
            error: "No sensor data available. Send sensor data first."
        });
    }

    const city = req.query.city || farmProfile.city || "Sonipat";

    // Weather is extra context only: the recommendation must still work
    // from the ESP32 readings when the weather service is unreachable.
    let weather = null;
    let weatherError = null;

    try {
        weather = await getWeather(city);
    } catch (error) {
        weatherError = error.message;
        console.error("Weather unavailable for recommendation:", error.message);
    }

    const online = isDeviceOnline();
    const soilPct = soilPercentFrom(latestSensorData);
    const raining = truthyFlag(latestSensorData.rain);
    const pumpOn = truthyFlag(latestSensorData.pump);
    const autoMode = truthyFlag(latestSensorData.autoMode);
    const ph = Number(latestSensorData.ph);
    const hasPh =
        latestSensorData.ph !== undefined &&
        latestSensorData.ph !== null &&
        Number.isFinite(ph);

    const crop = farmProfile.crop || "unspecified crop";
    const soilType = farmProfile.soilType || "unspecified soil";

    const weatherSaysRain = weather
        ? /rain|drizzle|thunderstorm/i.test(weather.conditionMain)
        : false;

    let recommendation;
    let level; // "water" | "hold" | "ok" | "check"
    const reasons = [];

    const cautions = [
        "Soil percentage is mapped from the ESP32's dry/wet calibration (raw 3800 = 0%, raw 1500 = 100%); recalibrate if the sensor or soil changes.",
        "Weather is the current condition only, not a rainfall forecast."
    ];

    if (!online) {
        cautions.unshift(
            "The ESP32 has not reported recently, so these readings may be out of date."
        );
    }

    if (weatherError) {
        cautions.push(`Weather data unavailable (${weatherError}).`);
    }

    if (soilPct === null) {
        recommendation = "Check the soil sensor";
        level = "check";
        reasons.push("The soil sensor value is missing or not numeric.");
    } else if (raining) {
        recommendation = "Rain detected: keep the pump off";
        level = "hold";
        reasons.push(
            "The rain sensor is wet, so automatic irrigation is paused to avoid waterlogging."
        );
    } else if (soilPct < PUMP_ON_THRESHOLD) {
        recommendation = pumpOn
            ? "Soil is dry: irrigation is running"
            : "Soil is dry: irrigation needed";
        level = "water";
        reasons.push(
            `Soil moisture is ${soilPct}%, below the ${PUMP_ON_THRESHOLD}% pump-on threshold.`
        );
    } else if (soilPct > PUMP_OFF_THRESHOLD) {
        recommendation = "Soil is moist: no watering needed";
        level = "ok";
        reasons.push(
            `Soil moisture is ${soilPct}%, above the ${PUMP_OFF_THRESHOLD}% pump-off threshold.`
        );
    } else {
        recommendation = "Soil moisture is in range: keep monitoring";
        level = "ok";
        reasons.push(
            `Soil moisture is ${soilPct}%, between the ${PUMP_ON_THRESHOLD}% and ${PUMP_OFF_THRESHOLD}% thresholds.`
        );
    }

    if (weatherSaysRain && !raining) {
        reasons.push(
            "The weather service reports rain nearby; the field rain sensor is still dry."
        );
        if (level === "water") {
            recommendation += " (rain reported nearby)";
        }
    }

    if (weather && weather.temperature > 35 && level === "water") {
        reasons.push(
            "It is hot (above 35 °C); watering in the evening reduces evaporation."
        );
    }

    reasons.push(
        `Pump is ${pumpOn ? "ON" : "OFF"} in ${autoMode ? "AUTO" : "MANUAL"} mode.`
    );

    if (hasPh) {
        let phNote = `Water pH reads ${ph.toFixed(1)}.`;

        if (ph < 5.5) phNote += " That is acidic; agricultural lime may help the soil.";
        else if (ph > 8.0) phNote += " That is alkaline; gypsum or organic compost may help.";
        else phNote += " That is in the normal range.";

        reasons.push(phNote);
        cautions.push(
            "pH is measured in water or a soil slurry, not directly in the field soil."
        );
    }

    if (typeof latestSensorData.tip === "string" && latestSensorData.tip.trim()) {
        reasons.push(`ESP32 tip: ${latestSensorData.tip.trim()}`);
    }

    res.json({
        city: weather?.city || city,
        recommendation,
        level,
        soilPercent: soilPct,
        reasons,
        farmProfile: {
            crop,
            soilType,
            farmArea: farmProfile.farmArea || "not specified"
        },
        sensorData: latestSensorData,
        weather: weather
            ? {
                  temperature: weather.temperature,
                  humidity: weather.humidity,
                  condition: weather.condition,
                  windSpeed: weather.windSpeed
              }
            : null,
        cautions
    });
});

// --------------------------------------------------
// GEMINI AI CHATBOT
// --------------------------------------------------

app.post("/api/chat", async (req, res) => {
    const question = req.body?.question;

    if (
        typeof question !== "string" ||
        !question.trim()
    ) {
        return res.status(400).json({
            error: "Please provide a question."
        });
    }

    if (question.length > 4000) {
        return res.status(400).json({
            error: "Question is too long (maximum 4000 characters)."
        });
    }

    // Optional earlier turns so follow-up questions keep their context.
    const conversation = Array.isArray(req.body?.history)
        ? req.body.history
              .slice(-10)
              .filter(
                  (turn) =>
                      turn &&
                      (turn.role === "user" || turn.role === "assistant") &&
                      typeof turn.text === "string" &&
                      turn.text.trim()
              )
              .map(
                  (turn) =>
                      `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text.trim().slice(0, 1500)}`
              )
              .join("\n")
        : "";

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey || !apiKey.trim()) {
        return res.status(503).json({
            error: "Gemini API key is missing from backend/.env."
        });
    }

    try {
        // "gemini-flash-lite-latest" and the Interactions API are only
        // served on the v1beta API version.
        const ai = new GoogleGenAI({
            apiKey: apiKey.trim(),
            apiVersion: "v1beta"
        });

        const prompt = `
You are the AI assistant for an AI Smart Irrigation system.

Help users with crops, plants, soil, irrigation, water
management and common plant health concerns.

Give practical, clear answers in the user's language.
Use the farm profile, sensor data and weather context
when they are available.

Never invent sensor readings, weather forecasts,
plant diagnoses or local regulations.
Explain uncertainty when necessary.
Recommend a local agricultural expert for serious crop
disease or pesticide decisions.
You cannot switch the pump yourself. If the user wants to change it,
tell them to use the pump and mode controls on the dashboard.
The sensor data below comes from the farm's ESP32: "soil" is the raw
ADC value, "soilPercent" is moisture (the pump turns on below 35%
and off above 60% in AUTO mode), "rain" 1 means rain is detected,
"ldr" 1 means daylight, "flow" is litres per minute, "pump" 1 means
the pump is running and "autoMode" 1 means automatic control.
Device online: ${isDeviceOnline() ? "yes" : "no (the readings may be stale)"}

Farm profile:
${JSON.stringify(farmProfile)}

Latest sensor data:
${JSON.stringify(latestSensorData)}

${conversation ? `Conversation so far:\n${conversation}\n` : ""}
Latest question:
${question.trim()}
`;

        
const interaction = await ai.interactions.create({
  model: "gemini-flash-lite-latest",
  input: prompt,
});

const answer = interaction.output_text;


        if (!answer || !answer.trim()) {
            throw new Error("Gemini returned an empty response.");
        }

        console.log("Gemini chat response generated successfully.");

        return res.json({
            answer: answer.trim(),
            mode: "ai",
            provider: "gemini"
        });
    } catch (error) {
        console.error("Gemini chat error:", error.message);

        return res.status(502).json({
            error:
                "Gemini could not generate a response. Check the backend terminal for details."
        });
    }
});

// --------------------------------------------------
// WEBSOCKET
// --------------------------------------------------

wss.on("connection", (ws, req) => {
    ws.authUser = req.authUser;

    ws.send(
        JSON.stringify({
            type: "connection",
            message: "Connected to Smart Irrigation WebSocket Server"
        })
    );

    if (latestSensorData) {
        ws.send(
            JSON.stringify({
                type: "sensor-data",
                data: latestSensorData,
                online: isDeviceOnline(),
                ageMs: Date.now() - lastSensorAt
            })
        );
    }

    console.log("WebSocket client connected");

    ws.on("close", () => {
        console.log("WebSocket client disconnected");
    });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const port = Number(process.env.PORT) || 3000;

server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    console.log(`WebSocket running on ws://localhost:${port}`);
    console.log("AI provider: Gemini");
});
