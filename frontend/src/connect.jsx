import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, LoaderCircle, Plug, X } from "lucide-react";
import { API_BASE, ago, request } from "./lib.js";

const MAX_WAIT_MS = 75000; // a sleeping free Render server can take about a minute to wake
const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/* Manual "connect" check.
   The ESP32 pushes its readings to the cloud server by itself; this page reads the same
   server. So the board and this device never need to share a network. The button simply
   wakes the server if it is asleep and waits until the ESP32 is seen. */
export function useEspConnect(sensors) {
  const [phase, setPhase] = useState("idle"); // idle | checking | connected | failed
  const [serverUp, setServerUp] = useState(false);
  const [waited, setWaited] = useState(0);
  const runRef = useRef(0);

  const stop = useCallback(() => {
    runRef.current += 1;
  }, []);

  const reset = useCallback(() => setPhase("idle"), []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    const run = ++runRef.current;
    const startedAt = Date.now();
    setPhase("checking");
    setServerUp(false);
    setWaited(0);

    while (run === runRef.current && Date.now() - startedAt < MAX_WAIT_MS) {
      try {
        const status = await request("/api/device/status");
        if (run !== runRef.current) return;
        setServerUp(true);

        if (status.online) {
          setPhase("connected");
          sensors.reload();
          return;
        }
      } catch {
        // the server is still waking up: keep trying
      }

      setWaited(Math.round((Date.now() - startedAt) / 1000));
      await sleep(2000);
    }

    if (run === runRef.current) setPhase("failed");
  }, [sensors]);

  return { phase, serverUp, waited, start, stop, reset };
}

export function ConnectDrawer({ open, onClose, sensors, connect }) {
  const { phase, serverUp, waited, start, stop } = connect;

  // Opening the panel starts a check straight away.
  useEffect(() => {
    if (open && phase === "idle") start();
  }, [open, phase, start]);

  const close = () => {
    stop();
    onClose();
  };

  const online = sensors.online;

  return (
    <>
      <div className={`scrim ${open ? "show" : ""}`} onClick={close} />
      <aside className={`drawer ${open ? "open" : ""}`} aria-hidden={!open}>
        <header>
          <div>
            <span className="mono-label">ESP32</span>
            <h3>Connect your board</h3>
          </div>
          <button className="icon" onClick={close} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <p className="muted small">
          Your ESP32 sends its readings to the cloud server using its own Wi-Fi, and this page reads
          them from the same server. The board and this device <strong>do not need to be on the same
          network</strong>.
        </p>

        <ul className="connect-steps">
          <li className={serverUp || sensors.socketUp || online ? "ok" : phase === "checking" ? "busy" : "bad"}>
            {serverUp || sensors.socketUp || online ? (
              <CheckCircle2 size={18} />
            ) : phase === "checking" ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <CircleAlert size={18} />
            )}
            <span>
              Server
              <small>
                {serverUp || sensors.socketUp || online
                  ? API_BASE.replace(/^https?:\/\//, "")
                  : phase === "checking"
                    ? `Waking up… ${waited}s (the free server can take up to a minute)`
                    : "Not reachable"}
              </small>
            </span>
          </li>
          <li className={online ? "ok" : phase === "checking" ? "busy" : "bad"}>
            {online ? (
              <CheckCircle2 size={18} />
            ) : phase === "checking" ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <CircleAlert size={18} />
            )}
            <span>
              ESP32
              <small>
                {online
                  ? `Sending data · ${ago(sensors.ageMs)}`
                  : phase === "checking"
                    ? "Waiting for the board…"
                    : sensors.ageMs !== null
                      ? `Last seen ${ago(sensors.ageMs)}`
                      : "Not seen yet"}
              </small>
            </span>
          </li>
        </ul>

        {phase === "failed" && !online && (
          <div className="connect-help">
            <strong>The ESP32 has not been seen. Check:</strong>
            <ol>
              <li>The board is powered and the Serial Monitor shows sensor lines.</li>
              <li>Its Wi-Fi has internet (a phone hotspot works).</li>
              <li>
                The Serial Monitor says <code>HTTP 200</code>. If it says <code>-1</code> the board
                cannot reach the server; <code>401</code> means the device key does not match
                <code> DEVICE_KEY</code> on the server.
              </li>
            </ol>
          </div>
        )}

        <button
          className="primary"
          onClick={start}
          disabled={phase === "checking"}
          style={{ marginTop: 20 }}
        >
          {phase === "checking" ? <LoaderCircle size={16} className="spin" /> : <Plug size={16} />}
          {phase === "checking" ? "Connecting…" : online ? "Check again" : "Connect now"}
        </button>
      </aside>
    </>
  );
}
