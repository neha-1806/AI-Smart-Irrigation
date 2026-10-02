const express = require("express");

const app = express();

app.use(express.json());

// Home route
app.get("/", (req, res) => {
    res.send("Smart Irrigation Backend is Running!");
});

// Sensor data route
app.post("/api/sensor-data", (req, res) => {
    const sensorData = req.body;

    console.log("Sensor Data Received:");
    console.log(sensorData);

    res.json({
        message: "Sensor data received successfully",
        data: sensorData
    });
});

// Start server
app.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});