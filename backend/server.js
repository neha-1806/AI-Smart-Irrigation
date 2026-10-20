
require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(
    cors({
        origin: [
            "http://localhost:5173",
            "http://127.0.0.1:5173"
        ]
    })
);
app.use(express.json({ limit: "1mb" }));

let latestSensorData = null;

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
            "GET /api/sensor-data",
            "POST /api/sensor-data",
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

app.post("/api/sensor-data", (req, res) => {
    if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
    ) {
        return res.status(400).json({
            error: "Send sensor data as a JSON object."
        });
    }

    latestSensorData = {
        ...req.body,
        receivedAt: new Date().toISOString()
    };

    const message = JSON.stringify({
        type: "sensor-data",
        data: latestSensorData
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });

    console.log("Sensor data received:", latestSensorData);

    res.json({
        message: "Sensor data received successfully",
        data: latestSensorData
    });
});

app.get("/api/sensor-data", (req, res) => {
    res.json({ data: latestSensorData });
});

// --------------------------------------------------
// FARM PROFILE
// --------------------------------------------------

app.get("/api/farm-profile", (req, res) => {
    res.json({ profile: farmProfile });
});

app.post("/api/farm-profile", (req, res) => {
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

    try {
        const city =
            req.query.city || farmProfile.city || "Sonipat";

        const weather = await getWeather(city);
        const soil = Number(latestSensorData.soil);
        const rainRaw = latestSensorData.rain;

        const crop = farmProfile.crop || "unspecified crop";
        const soilType =
            farmProfile.soilType || "unspecified soil";

        let recommendation = "Check soil moisture and crop needs";
        const reasons = [];

        const cautions = [
            "Soil thresholds are provisional and must be calibrated for the installed sensor.",
            "This endpoint uses current weather, not a rainfall forecast."
        ];

        if (!Number.isFinite(soil)) {
            recommendation = "Check the soil sensor";
            reasons.push(
                "The soil sensor value is missing or not numeric."
            );
        } else if (
            weather.conditionMain.toLowerCase().includes("rain") ||
            weather.conditionMain.toLowerCase().includes("drizzle")
        ) {
            recommendation = "Check soil moisture before watering";
            reasons.push(
                "Current weather reports rain or drizzle; avoid deciding from weather alone."
            );
        } else if (soil >= 3000) {
            recommendation =
                "Water may be needed; verify the soil first";
            reasons.push(
                "Raw soil ADC reading is above the provisional dry-soil threshold."
            );
        } else if (soil <= 2000) {
            recommendation =
                "Watering may not be needed right now";
            reasons.push(
                "Raw soil ADC reading is below the provisional threshold."
            );
        } else {
            recommendation = "Monitor soil moisture";
            reasons.push(
                "Raw soil ADC reading is within the provisional middle range."
            );
        }

        if (rainRaw !== undefined && rainRaw !== null) {
            reasons.push(
                `Rain sensor raw value: ${String(rainRaw)}. Interpret only after hardware calibration.`
            );
        }

        if (latestSensorData.ph !== undefined) {
            reasons.push(
                "Water pH reading is available, but it is not the same as soil pH and is not used to decide watering."
            );
        }

        res.json({
            city: weather.city,
            recommendation,
            reasons,
            farmProfile: {
                crop,
                soilType,
                farmArea: farmProfile.farmArea || "not specified"
            },
            sensorData: latestSensorData,
            weather: {
                temperature: weather.temperature,
                humidity: weather.humidity,
                condition: weather.condition,
                windSpeed: weather.windSpeed
            },
            cautions
        });
    } catch (error) {
        console.error(
            "Smart recommendation error:",
            error.message
        );

        res.status(502).json({
            error: error.message
        });
    }
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

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey || !apiKey.trim()) {
        return res.status(503).json({
            error: "Gemini API key is missing from backend/.env."
        });
    }

    try {
        const ai = new GoogleGenAI({
            apiKey: apiKey.trim()
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
Never claim that you control the irrigation pump.

Farm profile:
${JSON.stringify(farmProfile)}

Latest sensor data:
${JSON.stringify(latestSensorData)}

Question:
${question.trim()}
`;

        
const interaction = await ai.interactions.create({
  model: "gemini-3.8-flash",
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

wss.on("connection", (ws) => {
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
                data: latestSensorData
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
