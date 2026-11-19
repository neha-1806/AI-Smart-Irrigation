import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  CloudRain,
  Droplets,
  FlaskConical,
  LoaderCircle,
  MapPin,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
  Thermometer,
  Waves,
  Wind,
  Cloud,
  X,
} from "lucide-react";
import {
  FlowPipe,
  PhScale,
  PumpPanel,
  SERIES,
  Sparkline,
  SoilGauge,
  Ticker,
  TrendChart,
  useTween,
} from "./components.jsx";
import { API_BASE, THRESHOLDS, ago, fmt } from "./lib.js";

/* ================= helpers ================= */

function headline(r, online) {
  if (!r) return ["Waiting for your", "field"];
  if (!online) return ["Your field has gone", "quiet"];
  if (r.raining) return ["It’s", "raining", "on the field"];
  if (r.pump) return ["Watering the", "field", "right now"];
  if (r.soilPct === null) return ["Reading the", "soil"];
  if (r.soilPct < THRESHOLDS.pumpOn) return ["The soil is", "thirsty"];
  if (r.soilPct > 75) return ["The soil is", "saturated"];
  if (r.soilPct > THRESHOLDS.pumpOff) return ["The soil is", "well watered"];
  return ["The soil is", "just right"];
}

function Count({ value, digits = 0 }) {
  const tweened = useTween(value, 700);
  return <>{tweened === null ? "—" : tweened.toFixed(digits)}</>;
}

function Card({ className = "", style, children }) {
  return (
    <article className={`card ${className}`} style={style}>
      {children}
    </article>
  );
}

function CardHead({ icon: Icon, label, aside }) {
  return (
    <header className="card-head">
      <span className="mono-label">
        {Icon && <Icon size={14} strokeWidth={1.8} />} {label}
      </span>
      {aside}
    </header>
  );
}

function Metric({ icon, label, value, digits = 0, unit, sub, spark, color, children, className, i = 0 }) {
  return (
    <Card className={`metric ${className || ""}`} style={{ "--i": i }}>
      <CardHead icon={icon} label={label} />
      <div className="metric-value">
        <span className="num">
          <Count value={value} digits={digits} />
        </span>
        {unit && <span className="unit">{unit}</span>}
      </div>
      {children}
      {spark && <Sparkline values={spark} color={color} />}
      {sub && <p className="metric-sub">{sub}</p>}
    </Card>
  );
}

function SeriesTabs({ value, onChange }) {
  return (
    <div className="tabs" role="tablist" aria-label="Chart series">
      {Object.entries(SERIES).map(([key, s]) => (
        <button
          key={key}
          role="tab"
          aria-selected={value === key}
          className={value === key ? "active" : ""}
          onClick={() => onChange(key)}
        >
          <i style={{ background: s.color }} />
          {s.label}
        </button>
      ))}
    </div>
  );
}

const tail = (history, key, n = 40) => history.slice(-n).map((p) => p[key]);

/* ================= FIELD ================= */

export function FieldPage({ s, control, advice, series, setSeries, go, onConnect }) {
  const r = s.reading;
  const [pre, em, post] = headline(r, s.online);
  const rec = advice.recommendation;

  const tickerItems = r
    ? [
        `SOIL ${fmt(r.soilPct)}%`,
        `TEMP ${fmt(r.temp, 1)}°C`,
        `HUMIDITY ${fmt(r.hum)}%`,
        `pH ${fmt(r.ph, 1)}`,
        `FLOW ${fmt(r.flow, 2)} L/MIN`,
        `TOTAL ${fmt(r.total, 2)} L`,
        `RAIN ${r.raining ? "YES" : "NO"}`,
        `LIGHT ${r.day === null ? "—" : r.day ? "DAY" : "NIGHT"}`,
        `PUMP ${r.pump ? "ON" : "OFF"}`,
        `MODE ${r.auto === null ? "—" : r.auto ? "AUTO" : "MANUAL"}`,
      ]
    : ["WAITING FOR THE ESP32", "POWER THE BOARD", "CHECK WI-FI", "POST /API/SENSOR-DATA"];

  return (
    <>
      <section className="hero">
        <div className="hero-copy rise" style={{ "--i": 0 }}>
          <div className="eyebrow">
            <span className={`pulse-dot ${s.online ? "is-live" : ""}`} />
            {s.online ? "Live from your ESP32" : r ? "ESP32 offline" : "No device yet"}
            <span className="sep" />
            <MapPin size={13} /> {advice.profile.city || "Your farm"}
          </div>
          <h1>
            {pre} <em>{em}</em>
            {post ? <> {post}</> : null}
            <span className="dot">.</span>
          </h1>
          <p className="lede">
            {r && !s.online
              ? "The ESP32 has stopped sending data. The values below are its last reading. Check its power and Wi-Fi."
              : r?.tip
              ? r.tip
              : r
                ? "Readings are arriving. Watch the soil level against the pump thresholds on the right."
                : "Power the ESP32 and make sure it is on the same Wi-Fi as this computer. Its first reading will appear here within a couple of seconds."}
          </p>
          <div className="chips">
            <span className={`chip ${r?.pump ? "on" : ""}`}>
              <i /> Pump {r ? (r.pump ? "on" : "off") : "—"}
            </span>
            <span className="chip">
              {r?.auto === null || !r ? "Mode —" : r.auto ? "Auto mode" : "Manual mode"}
            </span>
            <span className="chip">
              {r?.raining ? <CloudRain size={13} /> : r?.day === false ? <Moon size={13} /> : <Sun size={13} />}
              {r?.raining ? "Rain detected" : r?.day === false ? "Night" : r ? "Dry · daylight" : "—"}
            </span>
          </div>
        </div>

        <div className="hero-art rise" style={{ "--i": 1 }}>
          <SoilGauge pct={r?.soilPct ?? null} raining={r?.raining} pumping={r?.pump} />
        </div>
      </section>

      <Ticker items={tickerItems} />

      <section className="bento">
        <Card className="span-8 trend rise" style={{ "--i": 2 }}>
          <CardHead
            icon={Waves}
            label="Last few minutes"
            aside={<SeriesTabs value={series} onChange={setSeries} />}
          />
          <TrendChart history={s.history} seriesKey={series} />
          <p className="legend">
            <span className="band-key" /> pump running
            {series === "soil" && (
              <>
                <span className="dash-key" /> pump thresholds ({THRESHOLDS.pumpOn}% / {THRESHOLDS.pumpOff}%)
              </>
            )}
          </p>
        </Card>

        <Card className="span-4 pump-card rise" style={{ "--i": 3 }}>
          <CardHead icon={null} label="Irrigation control" />
          <PumpPanel
            reading={r}
            online={s.online}
            pending={control.pending}
            onPump={control.setPump}
            onAuto={control.setAuto}
            onReset={control.resetLiters}
          />
        </Card>

        <Metric
          i={4}
          className="span-3"
          icon={Thermometer}
          label="Temperature"
          value={r?.temp ?? null}
          digits={1}
          unit="°C"
          color="#b8704d"
          spark={tail(s.history, "temp")}
          sub="DHT11 · air"
        />
        <Metric
          i={5}
          className="span-3"
          icon={Droplets}
          label="Humidity"
          value={r?.hum ?? null}
          digits={0}
          unit="%"
          color="#4e6e73"
          spark={tail(s.history, "hum")}
          sub="DHT11 · relative"
        />
        <Metric
          i={6}
          className="span-3"
          icon={FlaskConical}
          label="Water pH"
          value={r?.ph ?? null}
          digits={1}
          unit="pH"
        >
          <PhScale ph={r?.ph ?? null} />
        </Metric>
        <Metric
          i={7}
          className="span-3 flow"
          icon={Waves}
          label="Water flow"
          value={r?.flow ?? null}
          digits={2}
          unit="L/min"
        >
          <FlowPipe flow={r?.flow ?? null} />
          <p className="metric-sub">
            <strong>{fmt(r?.total ?? null, 2)} L</strong> delivered in total
          </p>
        </Metric>

        <Card className="span-3 state-card rise" style={{ "--i": 8 }}>
          <CardHead icon={r?.raining ? CloudRain : Cloud} label="Rain sensor" />
          <div className={`state-big ${r?.raining ? "wet" : ""}`}>
            <span>{r ? (r.raining ? "Raining" : "Dry") : "—"}</span>
            <div className="drops" aria-hidden="true">
              {Array.from({ length: 9 }).map((_, k) => (
                <i key={k} style={{ "--k": k }} />
              ))}
            </div>
          </div>
          <p className="metric-sub">
            {r?.raining ? "Auto irrigation is paused" : "Auto irrigation allowed"}
          </p>
        </Card>

        <Card className="span-3 state-card rise" style={{ "--i": 9 }}>
          <CardHead icon={r?.day === false ? Moon : Sun} label="Light (LDR)" />
          <div className={`state-big ${r?.day === false ? "night" : "day"}`}>
            <span>{r ? (r.day === null ? "—" : r.day ? "Daylight" : "Night") : "—"}</span>
          </div>
          <p className="metric-sub">Digital light sensor</p>
        </Card>

        <Card className="span-6 advice-mini rise" style={{ "--i": 10 }}>
          <CardHead
            icon={ShieldCheck}
            label="Smart recommendation"
            aside={
              <button className="link" onClick={() => go("advice")}>
                Details <ArrowUpRight size={14} />
              </button>
            }
          />
          {rec ? (
            <>
              <h3 className={`reco reco-${rec.level || "ok"}`}>{rec.recommendation}</h3>
              <p className="muted">{(rec.reasons || []).slice(0, 2).join(" ")}</p>
            </>
          ) : (
            <p className="muted">
              {advice.errors.recommendation ||
                "A recommendation appears as soon as the ESP32 has reported a reading."}
            </p>
          )}
        </Card>

        <DeviceLink s={s} className="span-6" i={11} />
        <WeatherCard advice={advice} className="span-6" i={12} />
      </section>
    </>
  );
}

function DeviceLink({ s, className = "", i = 0 }) {
  const rows = [
    ["ESP32", s.online ? "online" : s.ageMs === null ? "no packet yet" : "offline", s.online ? "ok" : "bad"],
    ["Last packet", ago(s.ageMs), s.online ? "ok" : "warn"],
    ["Live socket", s.socketUp ? "connected" : "reconnecting", s.socketUp ? "ok" : "warn"],
    ["Backend", API_BASE.replace(/^https?:\/\//, ""), s.backendError ? "bad" : "ok"],
  ];
  return (
    <Card className={`device ${className} rise`} style={{ "--i": i }}>
      <CardHead label="Device link" />
      <dl className="rows">
        {rows.map(([k, v, tone]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={tone}>
              <i /> {v}
            </dd>
          </div>
        ))}
      </dl>
      {s.backendError && <p className="form-error">{s.backendError}</p>}
    </Card>
  );
}

function WeatherCard({ advice, className = "", i = 0 }) {
  const w = advice.weather;
  const raining = w?.conditionMain?.toLowerCase().includes("rain");
  const Icon = raining ? CloudRain : w?.conditionMain?.toLowerCase().includes("cloud") ? Cloud : Sun;
  return (
    <Card className={`weather ${className} rise`} style={{ "--i": i }}>
      <CardHead
        icon={Icon}
        label={`Weather · ${w?.city || advice.profile.city || "—"}`}
        aside={
          <button
            className="link"
            onClick={() => advice.loadWeather(advice.profile.city)}
            disabled={advice.loading.weather}
          >
            {advice.loading.weather ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
          </button>
        }
      />
      {w ? (
        <div className="weather-row">
          <div className="metric-value">
            <span className="num">{Math.round(Number(w.temperature))}</span>
            <span className="unit">°C</span>
          </div>
          <div className="weather-meta">
            <strong>{w.condition}</strong>
            <span>
              <Droplets size={13} /> {fmt(w.humidity)}% humidity
            </span>
            <span>
              <Wind size={13} /> {fmt(w.windSpeed, 1)} m/s wind
            </span>
          </div>
        </div>
      ) : (
        <p className="muted">{advice.errors.weather || "Weather is not available right now."}</p>
      )}
    </Card>
  );
}

/* ================= SENSORS ================= */

export function SensorsPage({ s, series, setSeries }) {
  const r = s.reading;
  const rows = r
    ? [
        ["Soil moisture", `${fmt(r.soilPct)} %`],
        ["Soil raw ADC", fmt(r.soilRaw)],
        ["pH", fmt(r.ph, 2)],
        ["pH voltage", `${fmt(r.phV, 2)} V`],
        ["Temperature", `${fmt(r.temp, 1)} °C`],
        ["Humidity", `${fmt(r.hum, 1)} %`],
        ["Rain", r.raining ? "raining" : "dry"],
        ["Light", r.day === null ? "—" : r.day ? "day" : "night"],
        ["Flow", `${fmt(r.flow, 2)} L/min`],
        ["Total water", `${fmt(r.total, 2)} L`],
        ["Pump", r.pump ? "on" : "off"],
        ["Mode", r.auto === null ? "—" : r.auto ? "auto" : "manual"],
      ]
    : [];

  return (
    <div className="page">
      <PageTitle kicker="Live sensors" title="Everything the" em="ESP32" tail="is telling us" />
      <Card className="trend rise" style={{ "--i": 1 }}>
        <CardHead
          icon={Waves}
          label="History"
          aside={<SeriesTabs value={series} onChange={setSeries} />}
        />
        <TrendChart history={s.history} seriesKey={series} />
      </Card>

      <div className="split">
        <Card className="rise" style={{ "--i": 2 }}>
          <CardHead label="Current values" aside={<span className="muted mono">{ago(s.ageMs)}</span>} />
          {r ? (
            <dl className="rows tight">
              {rows.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted">No reading yet.</p>
          )}
        </Card>

        <Card className="rise" style={{ "--i": 3 }}>
          <CardHead label="Calibration the pump relies on" />
          <dl className="rows tight">
            <div>
              <dt>Dry soil (0 %)</dt>
              <dd>raw {THRESHOLDS.dryRaw}</dd>
            </div>
            <div>
              <dt>Wet soil (100 %)</dt>
              <dd>raw {THRESHOLDS.wetRaw}</dd>
            </div>
            <div>
              <dt>Pump ON below</dt>
              <dd>{THRESHOLDS.pumpOn} %</dd>
            </div>
            <div>
              <dt>Pump OFF above</dt>
              <dd>{THRESHOLDS.pumpOff} %</dd>
            </div>
          </dl>
          <p className="muted small">
            These values live in the ESP32 firmware. If you change them there, update
            <code> THRESHOLDS </code> in <code>frontend/src/lib.js</code> and the constants at the top of
            <code> backend/server.js</code> to match.
          </p>
        </Card>
      </div>

      <Card className="rise" style={{ "--i": 4 }}>
        <CardHead label="Raw payload" aside={<span className="muted mono">last packet received by the backend</span>} />
        {s.packet ? (
          <pre className="json">{JSON.stringify(s.packet, null, 2)}</pre>
        ) : (
          <p className="muted">Nothing has been received yet.</p>
        )}
      </Card>
    </div>
  );
}

/* ================= ADVICE ================= */

export function AdvicePage({ advice, s }) {
  const rec = advice.recommendation;
  return (
    <div className="page">
      <PageTitle kicker="Advice" title="What to do" em="next" tail="" />

      <Card className={`reco-card rise reco-${rec?.level || "none"}`} style={{ "--i": 1 }}>
        <CardHead
          icon={ShieldCheck}
          label="Smart irrigation"
          aside={
            <button
              className="pill"
              onClick={advice.loadRecommendation}
              disabled={advice.loading.recommendation || !s.reading}
            >
              {advice.loading.recommendation ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              Refresh
            </button>
          }
        />
        <h2 className="reco-title">
          {rec?.recommendation ||
            (s.reading ? "Working it out…" : "Waiting for the first reading")}
        </h2>
        {!rec && (
          <p className="muted">
            {advice.errors.recommendation || "Advice combines the field sensors with the weather outside."}
          </p>
        )}
        {rec && (
          <div className="reco-cols">
            <div>
              <span className="mono-label">Why</span>
              <ol className="reasons">
                {(rec.reasons || []).map((reason, k) => (
                  <li key={k}>{reason}</li>
                ))}
              </ol>
            </div>
            <div>
              <span className="mono-label">Keep in mind</span>
              <ul className="cautions">
                {(rec.cautions || []).map((c, k) => (
                  <li key={k}>{c}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Card>

      <div className="split">
        <WeatherCard advice={advice} i={2} />
        <Card className="rise" style={{ "--i": 3 }}>
          <CardHead label="Your farm" />
          <dl className="rows tight">
            <div>
              <dt>Crop</dt>
              <dd>{advice.profile.crop || "not set"}</dd>
            </div>
            <div>
              <dt>Soil type</dt>
              <dd>{advice.profile.soilType || "not set"}</dd>
            </div>
            <div>
              <dt>Area</dt>
              <dd>{advice.profile.farmArea || "not set"}</dd>
            </div>
            <div>
              <dt>City</dt>
              <dd>{advice.profile.city}</dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}

/* ================= PROFILE DRAWER ================= */

export function ProfileDrawer({ open, onClose, advice }) {
  const [draft, setDraft] = useState(advice.profile);

  useEffect(() => {
    if (open) setDraft(advice.profile);
  }, [open, advice.profile]);

  const submit = async (event) => {
    event.preventDefault();
    if (await advice.saveProfile(draft)) onClose();
  };

  const field = (key, label, placeholder, max = 100, required = false) => (
    <label>
      <span className="mono-label">{label}</span>
      <input
        value={draft[key] || ""}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        placeholder={placeholder}
        maxLength={max}
        required={required}
      />
    </label>
  );

  return (
    <>
      <div className={`scrim ${open ? "show" : ""}`} onClick={onClose} />
      <aside className={`drawer ${open ? "open" : ""}`} aria-hidden={!open}>
        <header>
          <div>
            <span className="mono-label">Farm profile</span>
            <h3>Tell us about your field</h3>
          </div>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <form onSubmit={submit}>
          {field("crop", "Crop", "e.g. Wheat")}
          {field("soilType", "Soil type", "e.g. Loamy")}
          {field("city", "City (for weather)", "e.g. Sonipat", 100, true)}
          {field("farmArea", "Farm area", "e.g. 1 acre", 50)}
          {advice.errors.profile && <p className="form-error">{advice.errors.profile}</p>}
          <button className="primary" type="submit" disabled={advice.loading.profile}>
            {advice.loading.profile ? <LoaderCircle size={16} className="spin" /> : null}
            Save profile
          </button>
          <p className="muted small">Saved on the server, so it is still there after a restart.</p>
        </form>
      </aside>
    </>
  );
}

/* ================= shared page title ================= */

function PageTitle({ kicker, title, em, tail }) {
  return (
    <div className="page-title rise">
      <span className="mono-label">{kicker}</span>
      <h1>
        {title} <em>{em}</em> {tail}
      </h1>
    </div>
  );
}
