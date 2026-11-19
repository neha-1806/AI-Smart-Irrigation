import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Power,
  RotateCcw,
  X,
} from "lucide-react";
import { THRESHOLDS, fmt, relLabel } from "./lib.js";

/* ---------- tiny hooks ---------- */

// Smoothly tweens a number toward its latest value.
export function useTween(target, duration = 900) {
  const [value, setValue] = useState(target ?? 0);
  const fromRef = useRef(target ?? 0);
  const rafRef = useRef(0);

  useEffect(() => {
    if (target === null || target === undefined) return undefined;
    const from = fromRef.current;
    const start = performance.now();
    cancelAnimationFrame(rafRef.current);

    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = from + (target - from) * eased;
      fromRef.current = next;
      setValue(next);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return target === null || target === undefined ? null : value;
}

/* ---------- soil gauge: a water-level "tank" with the pump thresholds ---------- */

const G = { vbW: 480, vbH: 400, cx: 170, cy: 200, r: 168 };

function wavePath(amp, phase) {
  const pts = [];
  for (let x = 0; x <= 800; x += 10) {
    pts.push(`${x},${(amp * Math.sin((x * 2 * Math.PI) / 200 + phase)).toFixed(2)}`);
  }
  return `M${pts.join(" L")} L800,420 L0,420 Z`;
}

export function SoilGauge({ pct, raining, pumping }) {
  const tweened = useTween(pct);
  const has = pct !== null && pct !== undefined;
  const level = has ? Math.max(0, Math.min(100, tweened ?? pct)) : 0;
  const top = G.cy + G.r - (level / 100) * (G.r * 2);
  const waveA = useMemo(() => wavePath(9, 0), []);
  const waveB = useMemo(() => wavePath(6, 2.1), []);

  const marker = (value, label) => {
    const y = G.cy + G.r - (value / 100) * (G.r * 2);
    const half = Math.sqrt(Math.max(0, G.r * G.r - (y - G.cy) * (y - G.cy)));
    return (
      <g key={value}>
        <line
          x1={G.cx - half}
          x2={G.cx + half}
          y1={y}
          y2={y}
          className="gauge-threshold"
        />
        <line x1={G.cx + half} x2={G.cx + half + 18} y1={y} y2={y} className="gauge-tick" />
        <text x={G.cx + half + 26} y={y + 4} className="gauge-label">
          {label}
        </text>
      </g>
    );
  };

  const readout = (fill, clip) => (
    <g clipPath={`url(#${clip})`}>
      <text x={G.cx} y={G.cy + 40} textAnchor="middle" fill={fill} className="gauge-num">
        {has ? Math.round(level) : "—"}
        <tspan className="gauge-pct" dx="4" dy="-64">
          %
        </tspan>
      </text>
      <text x={G.cx} y={G.cy + 80} textAnchor="middle" fill={fill} className="gauge-cap">
        SOIL MOISTURE
      </text>
    </g>
  );

  return (
    <div className={`gauge ${pumping ? "is-pumping" : ""} ${raining ? "is-raining" : ""}`}>
      <svg
        viewBox={`0 0 ${G.vbW} ${G.vbH}`}
        role="img"
        aria-label={has ? `Soil moisture ${Math.round(pct)} percent` : "Soil moisture unknown"}
      >
        <defs>
          <clipPath id="gauge-clip">
            <circle cx={G.cx} cy={G.cy} r={G.r - 6} />
          </clipPath>
          {/* text above the waterline is dark, text under water is cream */}
          <clipPath id="gauge-above">
            <rect x="0" y="-60" width={G.vbW} height={top + 60} />
          </clipPath>
          <clipPath id="gauge-below">
            <rect x="0" y={top} width={G.vbW} height={G.vbH} />
          </clipPath>
          <linearGradient id="water-a" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#6b705c" stopOpacity="1" />
            <stop offset="1" stopColor="#3c3f30" stopOpacity="1" />
          </linearGradient>
          <linearGradient id="water-b" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#a5a58d" stopOpacity="0.7" />
            <stop offset="1" stopColor="#6b705c" stopOpacity="0.5" />
          </linearGradient>
        </defs>

        <circle cx={G.cx} cy={G.cy} r={G.r} className="gauge-ring" />
        <circle cx={G.cx} cy={G.cy} r={G.r - 6} className="gauge-bowl" />

        {has && (
          <g clipPath="url(#gauge-clip)">
            <g style={{ transform: `translate(-30px, ${top}px)` }}>
              <path d={waveB} fill="url(#water-b)" className="wave wave-b" />
              <path d={waveA} fill="url(#water-a)" className="wave wave-a" />
            </g>
          </g>
        )}

        {marker(THRESHOLDS.pumpOff, `OFF ABOVE ${THRESHOLDS.pumpOff}%`)}
        {marker(THRESHOLDS.pumpOn, `ON BELOW ${THRESHOLDS.pumpOn}%`)}

        {readout("#2b2d22", "gauge-above")}
        {has && readout("#ffe8d6", "gauge-below")}
      </svg>
    </div>
  );
}

/* ---------- sparkline ---------- */

export function Sparkline({ values, color = "#6b705c", height = 44 }) {
  const clean = values.filter((v) => v !== null && v !== undefined);
  if (clean.length < 2) return <div className="spark-empty" style={{ height }} />;

  const W = 160;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const pts = clean.map((v, i) => [
    (i / (clean.length - 1)) * W,
    height - 4 - ((v - min) / span) * (height - 8),
  ]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const gid = `spark-${color.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <svg className="spark" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${W},${height} L0,${height} Z`} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ---------- trend chart ---------- */

export const SERIES = {
  soil: { label: "Soil moisture", unit: "%", color: "#6b705c", domain: [0, 100], digits: 0 },
  temp: { label: "Temperature", unit: "°C", color: "#b8704d", digits: 1 },
  hum: { label: "Humidity", unit: "%", color: "#4e6e73", domain: [0, 100], digits: 0 },
  ph: { label: "pH", unit: "", color: "#9a6f7e", domain: [0, 14], digits: 2 },
  flow: { label: "Water flow", unit: "L/min", color: "#a2701d", digits: 2 },
};

const C = { w: 900, h: 300, l: 46, r: 18, t: 16, b: 30 };

export function TrendChart({ history, seriesKey }) {
  const series = SERIES[seriesKey];
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);

  const points = useMemo(
    () => history.filter((p) => p[seriesKey] !== null && p[seriesKey] !== undefined),
    [history, seriesKey]
  );

  const model = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const span = Math.max(1, t1 - t0);
    const values = points.map((p) => p[seriesKey]);
    let lo;
    let hi;
    if (series.domain) {
      [lo, hi] = series.domain;
    } else {
      lo = Math.min(...values);
      hi = Math.max(...values);
      const pad = Math.max((hi - lo) * 0.2, seriesKey === "flow" ? 0.5 : 2);
      lo = seriesKey === "flow" ? 0 : lo - pad;
      hi += pad;
    }
    const x = (t) => C.l + ((t - t0) / span) * (C.w - C.l - C.r);
    const y = (v) => C.t + (1 - (v - lo) / (hi - lo || 1)) * (C.h - C.t - C.b);
    const xy = points.map((p) => [x(p.t), y(p[seriesKey])]);
    const line = xy.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
    const base = C.h - C.b;
    const area = `${line} L${xy[xy.length - 1][0].toFixed(1)},${base} L${xy[0][0].toFixed(1)},${base} Z`;

    // pump-on bands
    const bands = [];
    let start = null;
    points.forEach((p, i) => {
      if (p.pump && start === null) start = x(p.t);
      if ((!p.pump || i === points.length - 1) && start !== null) {
        bands.push([start, x(p.t)]);
        start = null;
      }
    });

    const ticks = [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4);
    return { t0, t1, span, lo, hi, x, y, xy, line, area, bands, ticks, base };
  }, [points, series, seriesKey]);

  const onMove = (event) => {
    if (!model) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * C.w;
    let best = 0;
    let bestDist = Infinity;
    model.xy.forEach(([x], i) => {
      const d = Math.abs(x - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    setHover(best);
  };

  if (!model) {
    return (
      <div className="chart-empty">
        <span className="pulse-dot" /> Collecting readings — the chart appears after a few packets
        from the ESP32.
      </div>
    );
  }

  const hp = hover !== null ? points[hover] : null;
  const hxy = hover !== null ? model.xy[hover] : null;

  return (
    <div
      className="chart"
      ref={wrapRef}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${C.w} ${C.h}`} role="img" aria-label={`${series.label} over time`}>
        <defs>
          <linearGradient id={`area-${seriesKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={series.color} stopOpacity="0.32" />
            <stop offset="1" stopColor={series.color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {model.ticks.map((tick) => (
          <g key={tick}>
            <line x1={C.l} x2={C.w - C.r} y1={model.y(tick)} y2={model.y(tick)} className="chart-grid" />
            <text x={C.l - 10} y={model.y(tick) + 4} textAnchor="end" className="chart-axis">
              {fmt(tick, series.digits > 1 ? 1 : series.digits === 1 ? 0 : 0)}
            </text>
          </g>
        ))}

        {seriesKey === "soil" && (
          <>
            <line
              x1={C.l}
              x2={C.w - C.r}
              y1={model.y(THRESHOLDS.pumpOn)}
              y2={model.y(THRESHOLDS.pumpOn)}
              className="chart-threshold"
            />
            <line
              x1={C.l}
              x2={C.w - C.r}
              y1={model.y(THRESHOLDS.pumpOff)}
              y2={model.y(THRESHOLDS.pumpOff)}
              className="chart-threshold"
            />
          </>
        )}

        {model.bands.map(([a, b], i) => (
          <rect
            key={i}
            x={a}
            width={Math.max(2, b - a)}
            y={C.t}
            height={model.base - C.t}
            className="chart-band"
          />
        ))}

        <path d={model.area} fill={`url(#area-${seriesKey})`} />
        <path d={model.line} fill="none" stroke={series.color} strokeWidth="2.2" strokeLinejoin="round" />

        <text x={C.l} y={C.h - 6} className="chart-axis">
          {relLabel(model.t1 - model.t0)}
        </text>
        <text x={(C.l + C.w - C.r) / 2} y={C.h - 6} textAnchor="middle" className="chart-axis">
          {relLabel((model.t1 - model.t0) / 2)}
        </text>
        <text x={C.w - C.r} y={C.h - 6} textAnchor="end" className="chart-axis">
          now
        </text>

        {hxy && (
          <g>
            <line x1={hxy[0]} x2={hxy[0]} y1={C.t} y2={model.base} className="chart-cursor" />
            <circle cx={hxy[0]} cy={hxy[1]} r="5" fill={series.color} className="chart-dot" />
          </g>
        )}
        {!hxy && (
          <circle
            cx={model.xy[model.xy.length - 1][0]}
            cy={model.xy[model.xy.length - 1][1]}
            r="4.5"
            fill={series.color}
            className="chart-live"
          />
        )}
      </svg>

      {hp && hxy && (
        <div
          className="chart-tip"
          style={{
            left: `${(hxy[0] / C.w) * 100}%`,
            top: `${(hxy[1] / C.h) * 100}%`,
          }}
        >
          <strong>
            {fmt(hp[seriesKey], series.digits)}
            {series.unit && <small> {series.unit}</small>}
          </strong>
          <span>{relLabel(model.t1 - hp.t)}{hp.pump ? " · pump on" : ""}</span>
        </div>
      )}
    </div>
  );
}

/* ---------- pH scale ---------- */

export function PhScale({ ph }) {
  const has = ph !== null && ph !== undefined;
  const pos = has ? Math.max(0, Math.min(14, ph)) / 14 : 0.5;
  let zone = "no reading";
  if (has) zone = ph < 5.5 ? "acidic" : ph > 8 ? "alkaline" : ph < 6.5 || ph > 7.5 ? "slightly off" : "neutral";

  return (
    <div className="ph">
      <div className="ph-bar">
        {has && (
          <span className="ph-marker" style={{ left: `${pos * 100}%` }}>
            <i />
          </span>
        )}
      </div>
      <div className="ph-labels">
        <span>0</span>
        <span>7</span>
        <span>14</span>
      </div>
      <p className="ph-zone">{zone}</p>
    </div>
  );
}

/* ---------- flow pipe ---------- */

export function FlowPipe({ flow }) {
  const running = flow !== null && flow > 0.05;
  return (
    <svg className={`pipe ${running ? "is-flowing" : ""}`} viewBox="0 0 240 28" aria-hidden="true">
      <rect x="1" y="6" width="238" height="16" rx="8" className="pipe-body" />
      <line x1="12" y1="14" x2="228" y2="14" className="pipe-water" />
    </svg>
  );
}

/* ---------- pump & mode control ---------- */

export function PumpPanel({ reading, online, pending, onPump, onAuto, onReset }) {
  const known = reading !== null;
  const pump = known && reading.pump;
  const auto = known ? reading.auto : null;
  const locked = !online || Boolean(pending);

  return (
    <div className={`pump ${pump ? "is-on" : ""}`}>
      <div className="pump-top">
        <button
          className="power"
          onClick={() => onPump(!pump)}
          disabled={locked || !known}
          aria-pressed={pump}
          aria-label={pump ? "Switch pump off" : "Switch pump on"}
        >
          <span className="power-ring" />
          {pending?.kind === "pump" ? <LoaderCircle className="spin" size={30} /> : <Power size={30} />}
        </button>
        <div className="pump-state">
          <span className="mono-label">Pump</span>
          <strong>{pump ? "Running" : "Idle"}</strong>
          <small>
            {!online
              ? "ESP32 offline — controls locked"
              : pending?.kind === "pump"
                ? "Waiting for the ESP32 to confirm…"
                : "Tap to switch manually"}
          </small>
        </div>
      </div>

      <div className="segment" role="group" aria-label="Control mode">
        <button
          className={auto === true ? "active" : ""}
          onClick={() => auto !== true && onAuto(true)}
          disabled={locked || !known}
        >
          {pending?.kind === "mode" && auto !== true ? <LoaderCircle className="spin" size={14} /> : null}
          Auto
        </button>
        <button
          className={auto === false ? "active" : ""}
          onClick={() => auto !== false && onAuto(false)}
          disabled={locked || !known}
        >
          Manual
        </button>
      </div>

      <p className="pump-note">
        {auto === false
          ? "Manual: the pump only changes when you switch it. Go back to Auto to let the field decide."
          : `Auto: the pump starts below ${THRESHOLDS.pumpOn}% soil moisture, stops above ${THRESHOLDS.pumpOff}%, and rain pauses it.`}
      </p>

      <button className="ghost" onClick={onReset} disabled={locked || !known}>
        {pending?.kind === "reset" ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}
        Reset water counter
      </button>
    </div>
  );
}

/* ---------- ticker ---------- */

export function Ticker({ items }) {
  const row = items.join("   ✦   ");
  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker-track">
        <span>{row}   ✦   </span>
        <span>{row}   ✦   </span>
      </div>
    </div>
  );
}

/* ---------- toasts ---------- */

export function Toasts({ toasts, dismiss }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          {toast.kind === "ok" ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
          <span>{toast.text}</span>
          <button onClick={() => dismiss(toast.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
