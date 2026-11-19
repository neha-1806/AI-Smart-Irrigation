import { useCallback, useEffect, useState } from "react";
import { Bot, Gauge, Lightbulb, Plug, Radio, Settings2, Sprout } from "lucide-react";
import { useAdvice, useDeviceControl, useSensors } from "./hooks.js";
import { Toasts } from "./components.jsx";
import { AdvicePage, FieldPage, ProfileDrawer, SensorsPage } from "./pages.jsx";
import { AssistantPage, useChat } from "./chat.jsx";
import { ConnectDrawer, useEspConnect } from "./connect.jsx";
import { ago } from "./lib.js";

const NAV = [
  { id: "field", label: "Field", icon: Sprout },
  { id: "sensors", label: "Sensors", icon: Gauge },
  { id: "advice", label: "Advice", icon: Lightbulb },
  { id: "assistant", label: "Assistant", icon: Bot },
];

const pageFromHash = () => {
  const id = window.location.hash.replace("#", "");
  return NAV.some((n) => n.id === id) ? id : "field";
};

export default function App() {
  const s = useSensors();
  const [toasts, setToasts] = useState([]);

  const notify = useCallback((kind, text) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((current) => [...current.slice(-2), { id, kind, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 4500);
  }, []);
  const dismiss = (id) => setToasts((current) => current.filter((t) => t.id !== id));

  const control = useDeviceControl(s.reading, notify);
  const advice = useAdvice(Boolean(s.reading), notify);
  const chat = useChat();
  const connect = useEspConnect(s);

  const [page, setPage] = useState(pageFromHash);
  const [series, setSeries] = useState("soil");
  const [profileOpen, setProfileOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((id) => {
    window.location.hash = id;
    setPage(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const openConnect = useCallback(() => {
    connect.stop();
    connect.reset();
    setConnectOpen(true);
  }, [connect]);

  useEffect(() => {
    const soil = s.reading?.soilPct;
    document.title =
      soil !== null && soil !== undefined && s.online
        ? `${Math.round(soil)}% soil · SproutIQ`
        : "SproutIQ · Smart Irrigation";
  }, [s.reading, s.online]);

  return (
    <div className={`shell page-${page}`}>
      <header className="topbar">
        <a className="brand" href="#field" onClick={() => setPage("field")} aria-label="SproutIQ home">
          <span className="brand-mark">
            <Sprout size={18} />
          </span>
          <span className="brand-word">
            sprout<em>iq</em>
          </span>
        </a>

        <nav className="nav" aria-label="Main">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => go(id)}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="top-right">
          <div className={`live ${s.online ? "on" : ""}`} title="ESP32 connection">
            <Radio size={14} />
            <span>{s.online ? `Live · ${ago(s.ageMs)}` : s.reading ? "ESP32 offline" : "Waiting for ESP32"}</span>
          </div>
          <button className="farm-chip" onClick={openConnect} title="Connect the ESP32 manually">
            <Plug size={15} />
            <span>Connect ESP</span>
          </button>
          <button className="farm-chip" onClick={() => setProfileOpen(true)}>
            <Settings2 size={15} />
            <span>{advice.profile.crop || "My farm"}</span>
          </button>
        </div>
      </header>

      {s.staleBackend && (
        <div className="banner" role="alert">
          <strong>The backend is running an old version of server.js.</strong> Pump control, mode and
          history won't work until it is restarted or redeployed.
        </div>
      )}

      {!s.staleBackend && s.backendError && !s.reading && (
        <div className="banner info" role="status">
          <strong>Connecting to the server…</strong> The free server sleeps when idle and can take up to
          a minute to wake. This page keeps trying by itself.
        </div>
      )}

      <main className="main" key={page}>
        {page === "field" && (
          <FieldPage
            s={s}
            control={control}
            advice={advice}
            series={series}
            setSeries={setSeries}
            go={go}
            onConnect={openConnect}
          />
        )}
        {page === "sensors" && <SensorsPage s={s} series={series} setSeries={setSeries} />}
        {page === "advice" && <AdvicePage advice={advice} s={s} />}
        {page === "assistant" && (
          <AssistantPage chat={chat} reading={s.reading} online={s.online} profile={advice.profile} />
        )}
      </main>

      <footer className="footer">
        <span>
          © {new Date().getFullYear()} SproutIQ — decision support for water-wise farming
        </span>
        <span className="mono">ESP32 → cloud server → dashboard</span>
      </footer>

      <ProfileDrawer open={profileOpen} onClose={() => setProfileOpen(false)} advice={advice} />
      <ConnectDrawer
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        sensors={s}
        connect={connect}
      />
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}
