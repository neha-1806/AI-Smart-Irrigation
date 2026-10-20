import React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowDownRight, ArrowUpRight, Bot, CheckCircle2, ChevronDown,
  Cloud, CloudRain, Droplets, Leaf, LoaderCircle, MapPin, Menu, MessageCircle,
  Send, Settings, ShieldCheck, Sprout, Sun, Thermometer, Wifi, WifiOff,
  Wind, X, Zap
} from "lucide-react";
import "./App.css";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

const NAV_ITEMS = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "sensors", label: "Live sensors", icon: Wifi },
  { id: "recommendations", label: "Recommendations", icon: Sprout },
  { id: "assistant", label: "AI assistant", icon: Bot },
];

const initialProfile = { crop: "", soilType: "", city: "Sonipat", farmArea: "" };

function formatValue(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "—";
  return `${value}${suffix}`;
}

function prettyTime(value) {
  if (!value) return "Waiting for first reading";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently updated";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function App() {
  const [activePage, setActivePage] = useState("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sensorData, setSensorData] = useState(null);
  const [profile, setProfile] = useState(initialProfile);
  const [weather, setWeather] = useState(null);
  const [recommendation, setRecommendation] = useState(null);
  const [chatMessages, setChatMessages] = useState([
    { role: "assistant", text: "Hi! I’m your farming assistant. Ask me about irrigation, soil readings, crop care, or the current weather." }
  ]);
  const [chatInput, setChatInput] = useState("");
  const [loading, setLoading] = useState({ sensors: false, profile: false, weather: false, recommendation: false, chat: false });
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState("");

  const setBusy = (key, value) => setLoading((current) => ({ ...current, [key]: value }));
  const setError = (key, message) => setErrors((current) => {
    const next = { ...current };
    if (message) next[key] = message;
    else delete next[key];
    return next;
  });

  const request = useCallback(async (path, options = {}) => {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }, []);

  const loadSensors = useCallback(async () => {
    setBusy("sensors", true);
    try {
      const result = await request("/api/sensor-data");
      setSensorData(result.data || null);
      setError("sensors", "");
    } catch (error) {
      setError("sensors", error.message);
    } finally {
      setBusy("sensors", false);
    }
  }, [request]);

  const loadProfile = useCallback(async () => {
    setBusy("profile", true);
    try {
      const result = await request("/api/farm-profile");
      if (result.profile) setProfile({ ...initialProfile, ...result.profile });
      setError("profile", "");
    } catch (error) {
      setError("profile", error.message);
    } finally {
      setBusy("profile", false);
    }
  }, [request]);

  const loadWeather = useCallback(async (city) => {
    setBusy("weather", true);
    try {
      const result = await request(`/api/weather?city=${encodeURIComponent(city || "Sonipat")}`);
      setWeather(result);
      setError("weather", "");
    } catch (error) {
      setError("weather", error.message);
    } finally {
      setBusy("weather", false);
    }
  }, [request]);

  const loadRecommendation = useCallback(async () => {
    setBusy("recommendation", true);
    try {
      const result = await request(`/api/smart-recommendation?city=${encodeURIComponent(profile.city || "Sonipat")}`);
      setRecommendation(result);
      setError("recommendation", "");
    } catch (error) {
      setRecommendation(null);
      setError("recommendation", error.message);
    } finally {
      setBusy("recommendation", false);
    }
  }, [profile.city, request]);

  useEffect(() => {
    loadSensors();
    loadProfile();
  }, [loadSensors, loadProfile]);

  useEffect(() => {
    if (profile.city) loadWeather(profile.city);
  }, [profile.city, loadWeather]);

  useEffect(() => {
    const socketUrl = API_BASE.replace(/^http/, "ws");
    let socket;
    let retryTimer;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(socketUrl);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "sensor-data" && message.data) {
            setSensorData(message.data);
            setError("sensors", "");
          }
        } catch {
          // Ignore malformed WebSocket messages without breaking the dashboard.
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (!stopped) retryTimer = window.setTimeout(connect, 4000);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    };
  }, []);

  const sensorCards = useMemo(() => [
    { label: "Soil sensor", value: formatValue(sensorData?.soil), unit: "raw value", icon: Droplets, tone: "mint", note: "Calibrate before interpreting" },
    { label: "Temperature", value: formatValue(sensorData?.temperature, sensorData?.temperature === undefined ? "" : "°C"), unit: "air reading", icon: Thermometer, tone: "peach", note: "From latest sensor packet" },
    { label: "Humidity", value: formatValue(sensorData?.humidity, sensorData?.humidity === undefined ? "" : "%"), unit: "relative humidity", icon: Cloud, tone: "blue", note: "From latest sensor packet" },
    { label: "Water flow", value: formatValue(sensorData?.flow, sensorData?.flow === undefined ? "" : ""), unit: "raw flow reading", icon: Activity, tone: "lavender", note: "Units depend on calibration" },
  ], [sensorData]);

  async function saveProfile(event) {
    event.preventDefault();
    setBusy("profile", true);
    try {
      const result = await request("/api/farm-profile", {
        method: "POST",
        body: JSON.stringify(profile),
      });
      setProfile({ ...initialProfile, ...(result.profile || profile) });
      setNotice("Farm profile saved for this server session.");
      setError("profile", "");
      await loadWeather(profile.city);
      window.setTimeout(() => setNotice(""), 3500);
    } catch (error) {
      setError("profile", error.message);
    } finally {
      setBusy("profile", false);
    }
  }

  async function sendChat(event) {
    event.preventDefault();
    const question = chatInput.trim();
    if (!question || loading.chat) return;
    setChatMessages((current) => [...current, { role: "user", text: question }]);
    setChatInput("");
    setBusy("chat", true);
    try {
      const result = await request("/api/chat", {
        method: "POST",
        body: JSON.stringify({ question }),
      });
      setChatMessages((current) => [...current, {
        role: "assistant",
        text: result.answer || "I couldn’t generate an answer this time.",
        mode: result.mode || "unknown",
      }]);
    } catch (error) {
      setChatMessages((current) => [...current, { role: "assistant", text: `I couldn’t reach the assistant: ${error.message}` }]);
    } finally {
      setBusy("chat", false);
    }
  }

  async function refreshAll() {
    await Promise.all([loadSensors(), loadProfile()]);
    await loadWeather(profile.city);
    await loadRecommendation();
  }

  function navigate(id) {
    setActivePage(id);
    setMobileNavOpen(false);
    if (id === "recommendations") loadRecommendation();
    if (id === "sensors") loadSensors();
  }

  const currentWeatherIcon = weather?.conditionMain?.toLowerCase().includes("rain")
    ? CloudRain
    : weather?.conditionMain?.toLowerCase().includes("cloud")
      ? Cloud
      : Sun;
  const WeatherIcon = currentWeatherIcon;

  return (
    <div className="app-shell">
      {mobileNavOpen && <button className="mobile-scrim" aria-label="Close menu" onClick={() => setMobileNavOpen(false)} />}
      <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Sprout size={24} /></div>
          <div><strong>Sprout<span>IQ</span></strong><small>SMART IRRIGATION</small></div>
          <button className="icon-button mobile-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}><X size={18} /></button>
        </div>
        <div className="farm-switcher">
          <div className="farm-avatar"><Leaf size={18} /></div>
          <div className="farm-switch-text"><strong>{profile.crop || "My farm"}</strong><small>{profile.city || "Your location"}</small></div>
          <ChevronDown size={16} className="muted-icon" />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav className="main-nav" aria-label="Main navigation">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${activePage === id ? "active" : ""}`} onClick={() => navigate(id)}>
              <Icon size={18} strokeWidth={1.9} /><span>{label}</span>
              {id === "sensors" && <span className={`nav-status ${sensorData ? "online" : ""}`} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card">
            <div className="help-icon"><ShieldCheck size={18} /></div>
            <strong>Grow with confidence</strong>
            <p>Use calibrated readings and local crop guidance for important decisions.</p>
          </div>
          <div className="sidebar-foot"><span className="status-dot" /> Backend connection is checked live</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button menu-trigger" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu size={21} /></button>
            <div><div className="eyebrow">FARM OVERVIEW <span className="eyebrow-line" /></div><h1>{activePage === "overview" ? "Good to see you" : NAV_ITEMS.find((item) => item.id === activePage)?.label || "Farm settings"}</h1><p className="topbar-subtitle">Your farm, thoughtfully monitored.</p></div>
          </div>
          <div className="topbar-actions">
            <div className="connection-pill"><span className={`status-dot ${errors.sensors ? "offline" : ""}`} />{errors.sensors ? "Check connection" : "Dashboard ready"}</div>
            <button className="refresh-button" onClick={refreshAll} disabled={Object.values(loading).some(Boolean)}><Activity size={16} /> Refresh</button>
          </div>
        </header>

        {notice && <div className="notice"><CheckCircle2 size={17} />{notice}</div>}

        {activePage === "overview" && (
          <>
            <section className="welcome-strip">
              <div className="welcome-copy"><span className="welcome-tag"><Sprout size={14} /> YOUR FARM, AT A GLANCE</span><h2>Small insights. <em>Better growing.</em></h2><p>Keep an eye on the readings that help you make informed irrigation decisions.</p></div>
              <div className="welcome-art"><div className="sun-orb" /><div className="hill hill-back" /><div className="hill hill-front" /><Sprout className="welcome-plant" size={72} strokeWidth={1.1} /></div>
            </section>

            <section className="section-block">
              <div className="section-heading"><div><h2>Sensor snapshot</h2><p>Most recent readings received by your backend</p></div><button className="text-button" onClick={() => navigate("sensors")}>View all <ArrowUpRight size={15} /></button></div>
              <div className="metrics-grid">
                {sensorCards.map(({ label, value, unit, icon: Icon, tone, note }) => (
                  <article className="metric-card" key={label}>
                    <div className="metric-top"><div className={`metric-icon ${tone}`}><Icon size={20} /></div><span className="metric-menu"><span /><span /><span /></span></div>
                    <p className="metric-label">{label}</p><div className="metric-value">{value}</div><div className="metric-bottom"><span>{unit}</span><span className="metric-note">{note}</span></div>
                  </article>
                ))}
              </div>
              {!sensorData && <div className="inline-empty"><WifiOff size={17} /><span>No sensor readings received yet. Connect your device or send a test payload to the backend.</span></div>}
            </section>

            <section className="content-grid">
              <article className="panel recommendation-panel">
                <div className="panel-heading"><div className="panel-title-icon green"><Sprout size={18} /></div><div><h3>Smart recommendation</h3><p>Guidance based on available sensor and weather data</p></div></div>
                {recommendation ? (
                  <div className="recommendation-body"><span className="recommendation-label">CURRENT GUIDANCE</span><h4>{recommendation.recommendation || "Review your farm conditions"}</h4><p>{(recommendation.reasons || []).join(" ") || "Review the readings before making an irrigation decision."}</p><div className="caution-box"><ShieldCheck size={16} /><span>{(recommendation.cautions || ["Recommendations are advisory; confirm sensor calibration before acting."]).join(" ")}</span></div></div>
                ) : (
                  <div className="recommendation-empty"><div className="empty-icon"><Sprout size={22} /></div><div><strong>{errors.recommendation || "Ready to review your farm"}</strong><p>Recommendation needs a sensor reading and a working weather connection.</p></div><button className="small-primary" onClick={loadRecommendation} disabled={loading.recommendation}>{loading.recommendation ? <LoaderCircle className="spin" size={15} /> : "Try again"}</button></div>
                )}
                <div className="panel-footer"><span><ShieldCheck size={14} /> Advisory only · No automatic pump control</span><button className="text-button" onClick={() => navigate("recommendations")}>Details <ArrowUpRight size={15} /></button></div>
              </article>

              <article className="panel weather-panel">
                <div className="panel-heading"><div className="panel-title-icon blue"><WeatherIcon size={18} /></div><div><h3>Weather now</h3><p><MapPin size={12} /> {weather?.city || profile.city || "Sonipat"}</p></div></div>
                {weather ? (
                  <div className="weather-main"><div className="weather-temp">{Math.round(Number(weather.temperature))}<span>°C</span></div><div className="weather-condition">{weather.condition || "Current conditions"}</div><div className="weather-details"><div><Droplets size={15} /><span>{formatValue(weather.humidity, "%")}<small>Humidity</small></span></div><div><Wind size={15} /><span>{formatValue(weather.windSpeed)}<small>Wind speed</small></span></div></div></div>
                ) : <div className="weather-empty">{errors.weather || "Weather data is not available right now."}</div>}
                <div className="weather-footer"><span><Cloud size={14} /> Current conditions only</span><button className="text-button" onClick={() => loadWeather(profile.city)} disabled={loading.weather}>Update</button></div>
              </article>
            </section>

            <section className="section-block profile-block">
              <div className="section-heading"><div><h2>Your farm profile</h2><p>Keep these details updated for more relevant guidance</p></div><span className="section-chip"><Leaf size={13} /> PERSONALIZED</span></div>
              <form className="profile-form panel" onSubmit={saveProfile}>
                <label>Crop<input value={profile.crop} onChange={(e) => setProfile((p) => ({ ...p, crop: e.target.value }))} placeholder="e.g. Wheat" maxLength={100} /></label>
                <label>Soil type<input value={profile.soilType} onChange={(e) => setProfile((p) => ({ ...p, soilType: e.target.value }))} placeholder="e.g. Loamy" maxLength={100} /></label>
                <label>City<input value={profile.city} onChange={(e) => setProfile((p) => ({ ...p, city: e.target.value }))} placeholder="e.g. Sonipat" maxLength={100} required /></label>
                <label>Farm area<input value={profile.farmArea} onChange={(e) => setProfile((p) => ({ ...p, farmArea: e.target.value }))} placeholder="e.g. 1 acre" maxLength={50} /></label>
                <div className="profile-submit"><button className="primary-button" type="submit" disabled={loading.profile}>{loading.profile ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />} Save profile</button>{errors.profile && <span className="form-error">{errors.profile}</span>}</div>
              </form>
            </section>
          </>
        )}

        {activePage === "sensors" && (
          <section className="page-content">
            <div className="section-heading"><div><h2>Live sensor data</h2><p>Readings arrive through your backend and WebSocket connection.</p></div><button className="refresh-button" onClick={loadSensors} disabled={loading.sensors}>{loading.sensors ? <LoaderCircle size={16} className="spin" /> : <Activity size={16} />} Refresh readings</button></div>
            <div className="metrics-grid sensor-page-grid">{sensorCards.map(({ label, value, unit, icon: Icon, tone, note }) => <article className="metric-card" key={label}><div className="metric-top"><div className={`metric-icon ${tone}`}><Icon size={20} /></div><span className="live-label"><span className="status-dot" /> LIVE FEED</span></div><p className="metric-label">{label}</p><div className="metric-value">{value}</div><div className="metric-bottom"><span>{unit}</span><span className="metric-note">{note}</span></div></article>)}</div>
            <article className="panel readings-panel"><div className="panel-heading"><div className="panel-title-icon green"><Activity size={18} /></div><div><h3>Raw sensor payload</h3><p>Exact latest object received by the server</p></div></div>{sensorData ? <pre className="json-view">{JSON.stringify(sensorData, null, 2)}</pre> : <div className="empty-state"><WifiOff size={22} /><strong>No data yet</strong><p>When your hardware sends a reading, it will appear here.</p></div>}<div className="panel-footer"><span><ShieldCheck size={14} /> Raw values are not automatically calibrated</span><span>Last update: {prettyTime(sensorData?.receivedAt)}</span></div></article>
          </section>
        )}

        {activePage === "recommendations" && (
          <section className="page-content">
            <div className="section-heading"><div><h2>Crop recommendations</h2><p>Advisory guidance based on the data currently available.</p></div><button className="primary-button" onClick={loadRecommendation} disabled={loading.recommendation}>{loading.recommendation ? <LoaderCircle size={16} className="spin" /> : <Zap size={16} />} Refresh guidance</button></div>
            <article className="panel full-recommendation">
              <div className="recommendation-hero"><div className="hero-icon"><Sprout size={25} /></div><div><span className="recommendation-label">SMART IRRIGATION</span><h2>{recommendation?.recommendation || "Your guidance will appear here"}</h2><p>{recommendation ? "Review the reasoning and cautions below before making a decision." : errors.recommendation || "Send sensor readings and make sure weather data is available, then refresh guidance."}</p></div></div>
              {recommendation && <><h3>Why this recommendation?</h3><ul className="reason-list">{(recommendation.reasons || []).map((reason, i) => <li key={`${i}-${reason}`}><CheckCircle2 size={16} />{reason}</li>)}</ul><h3>Important cautions</h3><ul className="reason-list caution-list">{(recommendation.cautions || []).map((caution, i) => <li key={`${i}-${caution}`}><ShieldCheck size={16} />{caution}</li>)}</ul></>}
              <div className="advisory-banner"><ShieldCheck size={18} /><p>This system provides decision support only. Confirm soil sensor calibration, crop stage, and local agricultural guidance. It does not switch a pump.</p></div>
            </article>
          </section>
        )}

        {activePage === "assistant" && (
          <section className="page-content assistant-page">
            <div className="section-heading"><div><h2>AI farming assistant</h2><p>Ask a question about your farm, crop, soil, or irrigation.</p></div><span className="section-chip"><Bot size={14} /> CHAT ASSISTANT</span></div>
            <div className="chat-panel panel">
              <div className="chat-top"><div className="assistant-avatar"><Bot size={22} /></div><div><h3>SproutIQ Assistant</h3><p><span className="status-dot" /> Ready to help with farming questions</p></div></div>
              <div className="chat-messages">
                {chatMessages.map((message, index) => <div key={`${index}-${message.role}`} className={`chat-row ${message.role === "user" ? "user-row" : ""}`}><div className={`chat-avatar ${message.role}`}>{message.role === "assistant" ? <Bot size={16} /> : "You"}</div><div className={`chat-bubble ${message.role}`}>{message.text}{message.mode && <small className="answer-mode">Source: {message.mode === "demo" ? "offline demo" : message.mode}</small>}</div></div>)}
                {loading.chat && <div className="chat-row"><div className="chat-avatar assistant"><Bot size={16} /></div><div className="chat-bubble assistant typing"><span /><span /><span /></div></div>}
              </div>
              <div className="suggestion-chips">{["When should I irrigate?", "Explain my sensor readings", "How does soil type affect watering?"].map((suggestion) => <button key={suggestion} onClick={() => setChatInput(suggestion)}>{suggestion}</button>)}</div>
              <form className="chat-form" onSubmit={sendChat}><input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Ask your farming question..." maxLength={4000} aria-label="Your farming question" /><button className="send-button" type="submit" disabled={!chatInput.trim() || loading.chat} aria-label="Send message">{loading.chat ? <LoaderCircle size={18} className="spin" /> : <Send size={18} />}</button></form>
              <p className="chat-disclaimer">AI answers may be incomplete. Verify important crop, disease, and pesticide decisions with a qualified local expert.</p>
            </div>
          </section>
        )}

        <footer className="app-footer"><span>© {new Date().getFullYear()} SproutIQ</span><span><ShieldCheck size={13} /> Designed for informed farming decisions</span><span>Backend: {API_BASE}</span></footer>
      </main>
    </div>
  );
}

export default App;
