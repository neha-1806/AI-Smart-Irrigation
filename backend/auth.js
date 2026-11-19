// --------------------------------------------------
// AUTHENTICATION + AUTHORIZATION (user id / password)
// --------------------------------------------------
// - Passwords are stored as scrypt hashes (never in plain text).
// - Sessions are signed tokens (HMAC-SHA256, 7 days) sent as
//   "Authorization: Bearer <token>". No extra dependencies.
// - Two roles:
//     admin  -> everything: pump / mode / reset, farm profile, user management
//     viewer -> read-only dashboard + advice + assistant
// - The first account created becomes the admin.
// - Users live in backend/data/users.json (git-ignored).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");

const DATA_DIR = process.env.AUTH_DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SECRET_FILE = path.join(DATA_DIR, ".auth-secret");

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROLES = ["admin", "viewer"];
const USER_ID_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;

const MAX_FAILED_LOGINS = 5;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 5 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- secret ----------

function loadSecret() {
    if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.trim().length >= 16) {
        return process.env.AUTH_SECRET.trim();
    }

    try {
        const stored = fs.readFileSync(SECRET_FILE, "utf8").trim();
        if (stored.length >= 32) return stored;
    } catch {
        // first run: create one below
    }

    const generated = crypto.randomBytes(48).toString("hex");
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    return generated;
}

const SECRET = loadSecret();

// ---------- user store ----------

let users = new Map(); // key: lower-case user id

function loadUsers() {
    try {
        const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
        users = new Map(
            (Array.isArray(parsed.users) ? parsed.users : []).map((user) => [
                user.userId.toLowerCase(),
                user
            ])
        );
    } catch (error) {
        if (error.code !== "ENOENT") {
            console.error("Could not read users.json, starting empty:", error.message);
        }
        users = new Map();
    }
}

function saveUsers() {
    const temp = `${USERS_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ users: [...users.values()] }, null, 2));
    fs.renameSync(temp, USERS_FILE);
}

loadUsers();

const publicUser = (user) => ({
    userId: user.userId,
    role: user.role,
    createdAt: user.createdAt
});

// ---------- passwords ----------

function scrypt(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (error, key) =>
            error ? reject(error) : resolve(key)
        );
    });
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt);
    return { salt: salt.toString("hex"), hash: key.toString("hex") };
}

async function checkPassword(user, password) {
    // Unknown users still do the same amount of work (no timing hint).
    const salt = Buffer.from(user ? user.salt : "00".repeat(16), "hex");
    const expected = Buffer.from(user ? user.hash : "00".repeat(64), "hex");
    const actual = await scrypt(password, salt);
    return Boolean(user) && crypto.timingSafeEqual(actual, expected);
}

// ---------- tokens ----------

const b64 = (value) => Buffer.from(value).toString("base64url");
const mac = (body) => crypto.createHmac("sha256", SECRET).update(body).digest("base64url");

function signToken(user) {
    const body = b64(
        JSON.stringify({
            sub: user.userId.toLowerCase(),
            v: user.tokenVersion || 0,
            exp: Date.now() + TOKEN_TTL_MS
        })
    );
    return `${body}.${mac(body)}`;
}

// Returns the user for a valid token, otherwise null.
function verifyToken(token) {
    if (typeof token !== "string") return null;

    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra !== undefined) return null;

    const expected = Buffer.from(mac(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        return null;
    }

    let claims;
    try {
        claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
        return null;
    }

    if (!claims || typeof claims.exp !== "number" || claims.exp < Date.now()) return null;

    // The role is always read from the store, so role changes, password
    // changes and deletions take effect immediately.
    const user = users.get(String(claims.sub));
    if (!user || (user.tokenVersion || 0) !== claims.v) return null;

    return user;
}

function tokenFromRequest(req) {
    const header = req.get("authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : null;
}

// ---------- login throttling ----------

const failures = new Map(); // "ip|user" -> { count, first, lockedUntil }

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of failures) {
        if (entry.lockedUntil < now && now - entry.first > FAIL_WINDOW_MS) failures.delete(key);
    }
}, 60 * 1000).unref();

const failureKey = (req, userId) => `${req.ip}|${String(userId).toLowerCase()}`;

function lockedFor(key) {
    const entry = failures.get(key);
    return entry && entry.lockedUntil > Date.now()
        ? Math.ceil((entry.lockedUntil - Date.now()) / 1000)
        : 0;
}

function recordFailure(key) {
    const now = Date.now();
    let entry = failures.get(key);

    if (!entry || now - entry.first > FAIL_WINDOW_MS) {
        entry = { count: 0, first: now, lockedUntil: 0 };
    }

    entry.count += 1;
    if (entry.count >= MAX_FAILED_LOGINS) entry.lockedUntil = now + LOCK_MS;
    failures.set(key, entry);
}

// ---------- validation ----------

function validateCredentials(userId, password) {
    if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId.trim())) {
        return "User ID must be 3-32 characters: letters, numbers, dot, dash or underscore.";
    }

    if (typeof password !== "string" || password.length < PASSWORD_MIN) {
        return `Password must be at least ${PASSWORD_MIN} characters.`;
    }

    if (password.length > PASSWORD_MAX) {
        return `Password must be at most ${PASSWORD_MAX} characters.`;
    }

    return null;
}

const adminCount = () => [...users.values()].filter((user) => user.role === "admin").length;

// ---------- middleware ----------

// Sets req.user or answers 401.
function requireAuth(req, res, next) {
    const user = verifyToken(tokenFromRequest(req));

    if (!user) {
        return res.status(401).json({
            error: "Please sign in to continue.",
            code: "unauthenticated"
        });
    }

    req.user = user;
    next();
}

// Use after requireAuth. Answers 403 when the role is not allowed.
function requireRole(...allowed) {
    return (req, res, next) => {
        if (req.user && allowed.includes(req.user.role)) return next();

        res.status(403).json({
            error: "Your account is view-only. Ask an admin for access.",
            code: "forbidden"
        });
    };
}

// ---------- routes ----------

function createAuthRouter({ onUserRemoved = () => {} } = {}) {
    const router = express.Router();
    const allowSignup = String(process.env.ALLOW_SIGNUP || "true").toLowerCase() !== "false";

    // Public: lets the login page know what to show.
    router.get("/status", (req, res) => {
        res.json({
            hasUsers: users.size > 0,
            allowSignup: allowSignup || users.size === 0
        });
    });

    router.post("/register", async (req, res) => {
        try {
            const { userId, password } = req.body || {};
            const problem = validateCredentials(userId, password);
            if (problem) return res.status(400).json({ error: problem });

            const cleanId = userId.trim();

            if (users.size > 0 && !allowSignup) {
                return res.status(403).json({
                    error: "Sign-up is closed. Ask an admin to create your account."
                });
            }

            if (users.has(cleanId.toLowerCase())) {
                return res.status(409).json({ error: "That user ID is already taken." });
            }

            const { salt, hash } = await hashPassword(password);

            // Re-check after the async hash so two simultaneous sign-ups
            // cannot both become the first admin or reuse an id.
            if (users.has(cleanId.toLowerCase())) {
                return res.status(409).json({ error: "That user ID is already taken." });
            }

            const user = {
                userId: cleanId,
                role: users.size === 0 ? "admin" : "viewer",
                salt,
                hash,
                tokenVersion: 0,
                createdAt: new Date().toISOString()
            };

            users.set(cleanId.toLowerCase(), user);
            saveUsers();

            console.log(`User registered: ${user.userId} (${user.role})`);
            res.status(201).json({ token: signToken(user), user: publicUser(user) });
        } catch (error) {
            console.error("Register error:", error.message);
            res.status(500).json({ error: "Could not create the account." });
        }
    });

    router.post("/login", async (req, res) => {
        try {
            const { userId, password } = req.body || {};

            if (typeof userId !== "string" || typeof password !== "string" || !userId || !password) {
                return res.status(400).json({ error: "Enter your user ID and password." });
            }

            const key = failureKey(req, userId);
            const waitSeconds = lockedFor(key);

            if (waitSeconds > 0) {
                return res.status(429).json({
                    error: `Too many failed attempts. Try again in ${Math.ceil(waitSeconds / 60)} min.`
                });
            }

            const user = users.get(userId.trim().toLowerCase()) || null;
            const ok = await checkPassword(user, password.slice(0, PASSWORD_MAX));

            if (!ok) {
                recordFailure(key);
                return res.status(401).json({ error: "Wrong user ID or password." });
            }

            failures.delete(key);
            console.log(`User signed in: ${user.userId}`);
            res.json({ token: signToken(user), user: publicUser(user) });
        } catch (error) {
            console.error("Login error:", error.message);
            res.status(500).json({ error: "Could not sign in." });
        }
    });

    router.get("/me", requireAuth, (req, res) => {
        res.json({ user: publicUser(req.user) });
    });

    // Change own password. Signs out every other session.
    router.post("/password", requireAuth, async (req, res) => {
        try {
            const { current, next } = req.body || {};

            if (typeof current !== "string" || !(await checkPassword(req.user, current))) {
                return res.status(401).json({ error: "Your current password is wrong." });
            }

            const problem = validateCredentials(req.user.userId, next);
            if (problem) return res.status(400).json({ error: problem });

            const { salt, hash } = await hashPassword(next);
            req.user.salt = salt;
            req.user.hash = hash;
            req.user.tokenVersion = (req.user.tokenVersion || 0) + 1;
            saveUsers();

            res.json({ message: "Password changed.", token: signToken(req.user) });
        } catch (error) {
            console.error("Password change error:", error.message);
            res.status(500).json({ error: "Could not change the password." });
        }
    });

    // ----- admin only -----

    router.get("/users", requireAuth, requireRole("admin"), (req, res) => {
        res.json({
            users: [...users.values()]
                .map(publicUser)
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        });
    });

    router.patch("/users/:userId", requireAuth, requireRole("admin"), (req, res) => {
        const target = users.get(String(req.params.userId).toLowerCase());
        const role = req.body?.role;

        if (!target) return res.status(404).json({ error: "User not found." });

        if (!ROLES.includes(role)) {
            return res.status(400).json({ error: `Role must be one of: ${ROLES.join(", ")}.` });
        }

        if (target.role === "admin" && role !== "admin" && adminCount() <= 1) {
            return res.status(400).json({ error: "There must always be at least one admin." });
        }

        target.role = role;
        saveUsers();
        console.log(`${req.user.userId} set ${target.userId} to ${role}`);
        res.json({ user: publicUser(target) });
    });

    router.delete("/users/:userId", requireAuth, requireRole("admin"), (req, res) => {
        const key = String(req.params.userId).toLowerCase();
        const target = users.get(key);

        if (!target) return res.status(404).json({ error: "User not found." });

        if (target === req.user) {
            return res.status(400).json({ error: "You cannot delete your own account." });
        }

        if (target.role === "admin" && adminCount() <= 1) {
            return res.status(400).json({ error: "There must always be at least one admin." });
        }

        users.delete(key);
        saveUsers();
        onUserRemoved(target.userId);
        console.log(`${req.user.userId} deleted ${target.userId}`);
        res.json({ message: "User deleted." });
    });

    return router;
}

module.exports = { createAuthRouter, requireAuth, requireRole, verifyToken, tokenFromRequest };
