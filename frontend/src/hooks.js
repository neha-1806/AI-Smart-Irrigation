import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  API_BASE,
  ONLINE_WINDOW_MS,
  fromServerHistory,
  normalize,
  request,
  toPoint,
} from "./lib.js";

const HISTORY_LIMIT = 300;

function mergeHistory(a, b) {
  const byTime = new Map();
  [...a, ...b].forEach((p) => {
    if (Number.isFinite(p.t)) byTime.set(p.t, p);
  });
  return [...byTime.values()].sort((x, y) => x.t - y.t).slice(-HISTORY_LIMIT);
}

/* ------------------------------------------------------------------ */
/* Live ESP32 data: initial fetch + WebSocket (+ polling if WS is down) */
/* ------------------------------------------------------------------ */
export function useSensors() {
  const [packet, setPacket] = useState(null);
  const [lastPacketAt, setLastPacketAt] = useState(null);
  const [history, setHistory] = useState([]);
  const [socketUp, setSocketUp] = useState(false);
  const [backendError, setBackendError] = useState("");
  const [staleBackend, setStaleBackend] = useState(false);
  const [now, setNow] = useState(Date.now());
  const lastStamp = useRef(null);

  const ingest = useCallback((incoming, ageMs) => {
    if (!incoming) return;
    setPacket(incoming);
    // Age of the packet. Older backends don't send ageMs, so fall back to the
    // packet's own timestamp instead of pretending it just arrived.
    let age = Number(ageMs);
    if (!Number.isFinite(age)) {
      const stamp = Date.parse(incoming.receivedAt);
      age = Number.isFinite(stamp) ? Math.max(0, Date.now() - stamp) : 0;
    }
    setLastPacketAt(Date.now() - age);

    const reading = normalize(incoming);
    if (reading && Number.isFinite(reading.t) && lastStamp.current !== reading.t) {
      lastStamp.current = reading.t;
      setHistory((current) => mergeHistory(current, [toPoint(reading)]));
    }
  }, []);

  const loadLatest = useCallback(async () => {
    try {
      const result = await request("/api/sensor-data");
      if (result.data) ingest(result.data, result.ageMs);
      setBackendError("");
    } catch (error) {
      setBackendError(error.message);
    }
  }, [ingest]);

  useEffect(() => {
    loadLatest();
    // The pump/mode routes only exist in the current server.js. If they 404 the
    // backend process was started before the update and must be restarted.
    fetch(`${API_BASE}/api/device/status`)
      .then((response) => setStaleBackend(response.status === 404))
      .catch(() => {});
    request("/api/sensor-history?limit=200")
      .then((result) => {
        const points = (result.history || []).map(fromServerHistory);
        setHistory((current) => mergeHistory(points, current));
      })
      .catch(() => {});
  }, [loadLatest]);

  useEffect(() => {
    const socketUrl = API_BASE.replace(/^http/, "ws");
    let socket;
    let retryTimer;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(socketUrl);
      socket.onopen = () => {
        setSocketUp(true);
        setBackendError("");
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "sensor-data" && message.data) {
            ingest(message.data, message.ageMs);
          }
        } catch {
          // ignore malformed messages
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        setSocketUp(false);
        if (!stopped) retryTimer = window.setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    };
  }, [ingest]);

  // Safety net: poll while the socket is down.
  useEffect(() => {
    if (socketUp) return undefined;
    const id = window.setInterval(loadLatest, 4000);
    return () => window.clearInterval(id);
  }, [socketUp, loadLatest]);

  // 1 s clock so "online" / "3s ago" stay honest.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const reading = useMemo(() => normalize(packet), [packet]);
  const ageMs = lastPacketAt === null ? null : Math.max(0, now - lastPacketAt);
  const online = ageMs !== null && ageMs < ONLINE_WINDOW_MS;

  return {
    packet,
    reading,
    history,
    online,
    ageMs,
    socketUp,
    backendError,
    staleBackend,
    reload: loadLatest,
  };
}

/* ------------------------------------------------------------------ */
/* Dashboard -> ESP32 commands, confirmed by the next sensor packet    */
/* ------------------------------------------------------------------ */
export function useDeviceControl(reading, notify) {
  const [pending, setPending] = useState(null);
  const expectRef = useRef(null);
  const timerRef = useRef(null);

  const clear = useCallback(() => {
    window.clearTimeout(timerRef.current);
    expectRef.current = null;
    setPending(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  // When the ESP32 reports the requested state, the command is confirmed.
  useEffect(() => {
    if (pending && expectRef.current && reading && expectRef.current(reading)) {
      notify("ok", pending.doneMessage);
      clear();
    }
  }, [reading, pending, notify, clear]);

  const send = useCallback(
    async (kind, path, body, expect, doneMessage) => {
      if (pending) return;
      setPending({ kind, doneMessage });
      expectRef.current = expect;
      try {
        await request(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
        timerRef.current = window.setTimeout(() => {
          notify("error", "The ESP32 did not confirm the change. Check its power and Wi-Fi.");
          clear();
        }, 9000);
      } catch (error) {
        notify("error", error.message);
        clear();
      }
    },
    [pending, notify, clear]
  );

  return {
    pending,
    setPump: (on) =>
      send(
        "pump",
        "/api/device/pump",
        { state: on },
        (r) => r.pump === on && r.auto === false,
        on ? "Pump switched on (manual mode)." : "Pump switched off (manual mode)."
      ),
    setAuto: (auto) =>
      send(
        "mode",
        "/api/device/mode",
        { auto },
        (r) => r.auto === auto,
        auto ? "Back in automatic mode." : "Manual mode on."
      ),
    resetLiters: () =>
      send(
        "reset",
        "/api/device/reset-flow",
        null,
        (r) => r.total !== null && r.total <= 0.05,
        "Water counter reset."
      ),
  };
}

/* ------------------------------------------------------------------ */
/* Farm profile, weather, recommendation                               */
/* ------------------------------------------------------------------ */
const initialProfile = { crop: "", soilType: "", city: "Sonipat", farmArea: "" };

export function useAdvice(hasData, notify) {
  const [profile, setProfile] = useState(initialProfile);
  const [weather, setWeather] = useState(null);
  const [recommendation, setRecommendation] = useState(null);
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});

  const busy = (key, value) => setLoading((c) => ({ ...c, [key]: value }));
  const fail = (key, message) =>
    setErrors((c) => {
      const next = { ...c };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });

  const loadProfile = useCallback(async () => {
    try {
      const result = await request("/api/farm-profile");
      if (result.profile) setProfile({ ...initialProfile, ...result.profile });
    } catch (error) {
      fail("profile", error.message);
    }
  }, []);

  const loadWeather = useCallback(async (city) => {
    busy("weather", true);
    try {
      setWeather(await request(`/api/weather?city=${encodeURIComponent(city || "Sonipat")}`));
      fail("weather", "");
    } catch (error) {
      setWeather(null);
      fail("weather", error.message);
    } finally {
      busy("weather", false);
    }
  }, []);

  const city = profile.city;
  const loadRecommendation = useCallback(async () => {
    busy("recommendation", true);
    try {
      setRecommendation(
        await request(`/api/smart-recommendation?city=${encodeURIComponent(city || "Sonipat")}`)
      );
      fail("recommendation", "");
    } catch (error) {
      setRecommendation(null);
      fail("recommendation", error.message);
    } finally {
      busy("recommendation", false);
    }
  }, [city]);

  const saveProfile = useCallback(
    async (next) => {
      busy("profile", true);
      try {
        const result = await request("/api/farm-profile", {
          method: "POST",
          body: JSON.stringify(next),
        });
        setProfile({ ...initialProfile, ...(result.profile || next) });
        fail("profile", "");
        notify("ok", "Farm profile saved.");
        return true;
      } catch (error) {
        fail("profile", error.message);
        return false;
      } finally {
        busy("profile", false);
      }
    },
    [notify]
  );

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (city) loadWeather(city);
  }, [city, loadWeather]);

  // Keep the recommendation fresh once the ESP32 is reporting.
  useEffect(() => {
    if (!hasData) return undefined;
    loadRecommendation();
    const id = window.setInterval(loadRecommendation, 30000);
    return () => window.clearInterval(id);
  }, [hasData, loadRecommendation]);

  return {
    profile,
    weather,
    recommendation,
    loading,
    errors,
    saveProfile,
    loadWeather,
    loadRecommendation,
  };
}
