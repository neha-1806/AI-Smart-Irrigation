// --------------------------------------------------
// NEON (Postgres) STORAGE
// --------------------------------------------------
// Keeps sensor history and the farm profile across restarts and redeploys
// (Render's free disk is wiped on every deploy). Set DATABASE_URL to your Neon
// connection string. Without it the backend still works, in memory only.
//
// Tables are created automatically:
//   sensor_readings(id, recorded_at, data jsonb)   one row per stored packet
//   farm_profile(id = 1, data jsonb)               the single farm profile

const { Pool } = require("pg");

let pool = null;

function connectionString() {
    const raw = (process.env.DATABASE_URL || "").trim();
    if (!raw) return "";

    try {
        // Neon copy-paste strings carry options node-postgres does not use.
        const url = new URL(raw);
        url.searchParams.delete("channel_binding");
        return url.toString();
    } catch {
        return raw;
    }
}

function enabled() {
    return pool !== null;
}

async function init() {
    const url = connectionString();

    if (!url) {
        console.log("Database: DATABASE_URL not set, history is kept in memory only.");
        return false;
    }

    try {
        pool = new Pool({
            connectionString: url,
            max: 3,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 15000,
            ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false }
        });

        // An idle connection dropped by Neon must not crash the server.
        pool.on("error", (error) => console.error("Database pool error:", error.message));

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sensor_readings (
                id          BIGSERIAL PRIMARY KEY,
                recorded_at TIMESTAMPTZ NOT NULL,
                data        JSONB NOT NULL
            )
        `);
        await pool.query(
            "CREATE INDEX IF NOT EXISTS sensor_readings_recorded_at_idx ON sensor_readings (recorded_at)"
        );
        await pool.query(`
            CREATE TABLE IF NOT EXISTS farm_profile (
                id   INTEGER PRIMARY KEY,
                data JSONB NOT NULL
            )
        `);

        console.log("Database: connected to Neon, history and farm profile are saved.");
        return true;
    } catch (error) {
        console.error("Database unavailable, continuing in memory only:", error.message);
        pool = null;
        return false;
    }
}

async function saveReading(data, atMs) {
    if (!pool) return;

    try {
        await pool.query(
            "INSERT INTO sensor_readings (recorded_at, data) VALUES ($1, $2)",
            [new Date(atMs), JSON.stringify(data)]
        );
    } catch (error) {
        console.error("Database: could not save reading:", error.message);
    }
}

// Newest `limit` readings, oldest first: [{ t: ms, data }]
async function loadRecent(limit) {
    if (!pool) return [];

    try {
        const result = await pool.query(
            "SELECT recorded_at, data FROM sensor_readings ORDER BY recorded_at DESC LIMIT $1",
            [limit]
        );

        return result.rows
            .map((row) => ({ t: new Date(row.recorded_at).getTime(), data: row.data }))
            .reverse();
    } catch (error) {
        console.error("Database: could not load history:", error.message);
        return [];
    }
}

async function loadFarmProfile() {
    if (!pool) return null;

    try {
        const result = await pool.query("SELECT data FROM farm_profile WHERE id = 1");
        return result.rows[0]?.data || null;
    } catch (error) {
        console.error("Database: could not load farm profile:", error.message);
        return null;
    }
}

async function saveFarmProfile(profile) {
    if (!pool) return;

    try {
        await pool.query(
            `INSERT INTO farm_profile (id, data) VALUES (1, $1)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
            [JSON.stringify(profile)]
        );
    } catch (error) {
        console.error("Database: could not save farm profile:", error.message);
    }
}

// Keeps the table small (Neon's free tier is limited).
async function prune(days = 14) {
    if (!pool) return;

    try {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        await pool.query("DELETE FROM sensor_readings WHERE recorded_at < $1", [cutoff]);
    } catch (error) {
        console.error("Database: could not prune old readings:", error.message);
    }
}

module.exports = { init, enabled, saveReading, loadRecent, loadFarmProfile, saveFarmProfile, prune };
