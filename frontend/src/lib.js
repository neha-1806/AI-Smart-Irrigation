// Shared helpers. The numbers below mirror the ESP32 firmware and the backend
// so the dashboard speaks the same language as the hardware.

const host = typeof window !== "undefined" ? window.location.hostname || "localhost" : "localhost";

export const API_BASE = (
  import.meta.env.VITE_API_BASE_URL || `http://${host}:3000`
).replace(/\/$/, "");

export const THRESHOLDS = {
  pumpOn: 35, // pump switches ON below this soil %  (AUTO mode)
  pumpOff: 60, // pump switches OFF above this soil % (AUTO mode)
  dryRaw: 3800, // raw ADC in dry soil / air
  wetRaw: 1500, // raw ADC in wet soil / water
};

export const ONLINE_WINDOW_MS = 12000; // ESP32 posts every ~2 s

export const num = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export const flag = (value) =>
  value === true || value === 1 || value === "1" || value === "true";

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Raw packet from the backend -> one tidy object the UI reads from.
export function normalize(packet) {
  if (!packet) return null;

  const soilRaw = num(packet.soil);
  let soilPct = num(packet.soilPercent);

  if (soilPct === null && soilRaw !== null) {
    soilPct = clamp(
      Math.round(
        ((soilRaw - THRESHOLDS.dryRaw) * 100) / (THRESHOLDS.wetRaw - THRESHOLDS.dryRaw)
      ),
      0,
      100
    );
  }

  return {
    soilRaw,
    soilPct: soilPct === null ? null : clamp(soilPct, 0, 100),
    ph: num(packet.ph),
    phV: num(packet.phVoltage),
    temp: num(packet.temperature),
    hum: num(packet.humidity),
    raining: flag(packet.rain),
    day: packet.ldr === undefined || packet.ldr === null ? null : flag(packet.ldr),
    flow: num(packet.flow),
    total: num(packet.totalLiters),
    pump: flag(packet.pump),
    auto: packet.autoMode === undefined || packet.autoMode === null ? null : flag(packet.autoMode),
    tip: typeof packet.tip === "string" ? packet.tip : "",
    receivedAt: packet.receivedAt,
    t: Date.parse(packet.receivedAt),
  };
}

// One chart point (server clock, so history and live points line up).
export function toPoint(r) {
  return {
    t: r.t,
    soil: r.soilPct,
    temp: r.temp,
    hum: r.hum,
    ph: r.ph,
    flow: r.flow,
    pump: r.pump ? 1 : 0,
    rain: r.raining ? 1 : 0,
  };
}

export function fromServerHistory(p) {
  return toPoint(
    normalize({
      soil: p.soil,
      soilPercent: p.soilPercent,
      ph: p.ph,
      temperature: p.temperature,
      humidity: p.humidity,
      flow: p.flow,
      pump: p.pump,
      rain: p.rain,
      receivedAt: new Date(p.t).toISOString(),
    })
  );
}

/* ---------- session token (stored in this browser only) ---------- */

const TOKEN_KEY = "sproutiq.token";
export const UNAUTHORIZED_EVENT = "sproutiq:unauthorized";

export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
};

export const setToken = (token) => {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable: the session lasts until the page closes
  }
};

export async function request(path, options = {}) {
  const token = getToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));

  // A rejected token means the session ended (expired, password changed, account removed).
  if (response.status === 401 && token && !path.startsWith("/api/auth/login")) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }

  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export const fmt = (value, digits = 0) =>
  value === null || value === undefined || Number.isNaN(value) ? "—" : Number(value).toFixed(digits);

export function ago(ms) {
  if (ms === null || ms === undefined) return "never";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function relLabel(ms) {
  const s = Math.round(ms / 1000);
  if (s < 5) return "now";
  if (s < 90) return `−${s}s`;
  return `−${Math.round(s / 60)}m`;
}
