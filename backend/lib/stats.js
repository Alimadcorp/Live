const { validate } = require("./validate");
const { db } = require("./firebase");

async function getStats(req, res) {
  let { app } = req.query;
  const t = validate(app);
  if (!t.valid) return res.status(400).send(t.error);
  app = t.id;

  const snap = await db.ref(`stats/${app}`).once("value");
  const data = snap.val() || { pings: {}, maxConcurrent: {} };

  // ─── Key helpers ───────────────────────────────────────────────────────────
  const parseKey = (k) => {
    const [d, h] = k.split("T");
    const [day, month, year] = d.split("-").map(Number);
    return new Date(year, month - 1, day, Number(h));
  };
  const makeKey = (d) =>
    `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}T${d.getHours()}`;
  const makeDayKey = (d) =>
    `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;

  // ─── Full hourly fill — for stat derivation only ───────────────────────────
  const fillHourly = (map = {}) => {
    const keys = Object.keys(map);
    if (!keys.length) return { labels: [], values: [] };
    keys.sort((a, b) => parseKey(a) - parseKey(b));
    const start = parseKey(keys[0]);
    const end = parseKey(keys.at(-1));
    const labels = [],
      values = [];
    for (let d = new Date(start); d <= end; d.setHours(d.getHours() + 1)) {
      const k = makeKey(d);
      labels.push(k);
      values.push(map[k] || 0);
    }
    return { labels, values };
  };

  // ─── Last-7-days hourly (fixed window, raw hourly — always 168 pts) ────────
  const buildLast7Hourly = (map = {}) => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const start = new Date(now.getTime() - 167 * 3600_000);
    const labels = [],
      pings = [],
      conc = [];
    for (let d = new Date(start); d <= now; d.setHours(d.getHours() + 1)) {
      const k = makeKey(d);
      labels.push(k);
      pings.push(map[k] || 0);
      conc.push(data.maxConcurrent?.[k] || 0);
    }
    return { labels, pings, conc };
  };

  // ─── Daily series with full gap-filling ───────────────────────────────────
  const buildDaily = (map = {}) => {
    if (!Object.keys(map).length)
      return { labels: [], values: [], concValues: [] };
    const dayMap = {},
      dayConc = {};
    for (const [k, v] of Object.entries(map)) {
      const dk = makeDayKey(parseKey(k));
      dayMap[dk] = (dayMap[dk] || 0) + v;
      dayConc[dk] = Math.max(dayConc[dk] || 0, data.maxConcurrent?.[k] || 0);
    }
    const parseDay = (s) => {
      const [d, m, y] = s.split("-").map(Number);
      return new Date(y, m - 1, d);
    };
    const sorted = Object.keys(dayMap).sort(
      (a, b) => parseDay(a) - parseDay(b),
    );
    const startD = parseDay(sorted[0]);
    const endD = parseDay(sorted.at(-1));
    const labels = [],
      values = [],
      concValues = [];
    for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
      const dk = makeDayKey(d);
      labels.push(dk);
      values.push(dayMap[dk] || 0);
      concValues.push(dayConc[dk] || 0);
    }
    return { labels, values, concValues };
  };

  // ─── Weekly roll-up (used when daily series > 21 days) ────────────────────
  const buildWeekly = (daily) => {
    const parseDay = (s) => {
      const [d, m, y] = s.split("-").map(Number);
      return new Date(y, m - 1, d);
    };
    const weekMap = {},
      weekConc = {};
    daily.labels.forEach((lbl, i) => {
      const d = parseDay(lbl);
      const dow = d.getDay();
      const mon = new Date(d);
      mon.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
      const wk = makeDayKey(mon);
      weekMap[wk] = (weekMap[wk] || 0) + daily.values[i];
      weekConc[wk] = Math.max(weekConc[wk] || 0, daily.concValues[i]);
    });
    const sorted = Object.keys(weekMap).sort(
      (a, b) => parseDay(a) - parseDay(b),
    );
    return {
      labels: sorted,
      values: sorted.map((k) => weekMap[k]),
      concValues: sorted.map((k) => weekConc[k]),
      isWeekly: true,
    };
  };

  // ─── Compute all series ────────────────────────────────────────────────────
  const hourlyFull = fillHourly(data.pings);
  const daily = buildDaily(data.pings);
  const last7 = buildLast7Hourly(data.pings);

  const WEEK_THRESHOLD = 21;
  const historySeries =
    daily.labels.length > WEEK_THRESHOLD
      ? buildWeekly(daily)
      : { ...daily, isWeekly: false };

  // ─── Derived stats ─────────────────────────────────────────────────────────
  const totalPings = data.totalPings || 0;
  const uniqueUsers = data.uniqueIds || 0;
  const lastPing = new Date(data.lastPing || 0);
  const allConcurrent = hourlyFull.labels.map(
    (l) => data.maxConcurrent?.[l] || 0,
  );
  const peakConcurrent = Math.max(...allConcurrent, 0);

  const avgPerDay = daily.values.length
    ? (daily.values.reduce((a, b) => a + b, 0) / daily.values.length).toFixed(1)
    : 0;
  const avgPerHour = hourlyFull.values.length
    ? (
        hourlyFull.values.reduce((a, b) => a + b, 0) / hourlyFull.values.length
      ).toFixed(2)
    : 0;

  const peakHourValue = Math.max(...hourlyFull.values, 0);
  const peakHourLabel =
    hourlyFull.labels[hourlyFull.values.indexOf(peakHourValue)] || "—";
  const peakDayValue = Math.max(...daily.values, 0);
  const peakDayLabel = daily.labels[daily.values.indexOf(peakDayValue)] || "—";

  const last7Total = daily.values.slice(-7).reduce((a, b) => a + b, 0);
  const prior7Total = daily.values.slice(-14, -7).reduce((a, b) => a + b, 0);
  const trendPct =
    prior7Total === 0
      ? last7Total > 0
        ? 100
        : 0
      : Math.round(((last7Total - prior7Total) / prior7Total) * 100);
  const trendUp = trendPct >= 0;

  const activeDays = daily.values.filter((v) => v > 0).length;
  const activeSpan = daily.labels.length
    ? `${daily.labels[0]} → ${daily.labels.at(-1)}`
    : "No data";

  // End of main API
  function base64toString(str) {
    return atob(str.replaceAll("-", "+").replaceAll("_", "/"));
  }

  const appName = base64toString(app);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${appName} · Stats</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;800&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    :root {
      --bg:      #06080d;
      --surface: #0b1019;
      --surf2:   #101827;
      --border:  #1a2438;
      --dim:     #1c2840;
      --text:    #dce8f5;
      --muted:   #506070;
      --cyan:    #38d9ff;
      --green:   #2fffa0;
      --gold:    #ffcc44;
      --red:     #ff5566;
      --purple:  #c084ff;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Syne', sans-serif;
      min-height: 100vh;
    }
    body::before {
      content: '';
      position: fixed; inset: 0;
      background-image: radial-gradient(rgba(56,217,255,0.06) 1px, transparent 1px);
      background-size: 28px 28px;
      pointer-events: none; z-index: 0;
    }

    .wrapper {
      position: relative; z-index: 1;
      max-width: 1280px; margin: 0 auto;
      padding: 2rem 1.5rem 5rem;
    }

    /* ── HEADER ── */
    .header {
      display: flex; align-items: flex-start;
      justify-content: space-between; flex-wrap: wrap; gap: 1rem;
      margin-bottom: 2.5rem; padding-bottom: 1.25rem;
      border-bottom: 1px solid var(--border);
      position: relative;
    }
    .header::after {
      content: ''; position: absolute; bottom: -1px; left: 0;
      width: 80px; height: 1px;
      background: var(--cyan); box-shadow: 0 0 12px var(--cyan);
    }
    .eyebrow {
      font-family: 'Space Mono', monospace;
      font-size: 0.6rem; color: var(--cyan);
      letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 0.35rem;
    }
    h1 {
      font-size: clamp(1.8rem, 5vw, 2.8rem);
      font-weight: 800; letter-spacing: -0.03em; color: #fff; line-height: 1.05;
    }
    .header-right {
      display: flex; flex-direction: column; align-items: flex-end; gap: 0.4rem;
    }
    .pulse-row {
      display: flex; align-items: center; gap: 0.5rem;
      font-family: 'Space Mono', monospace;
      font-size: 0.6rem; color: var(--green); letter-spacing: 0.1em;
    }
    .pulse-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--green); box-shadow: 0 0 6px var(--green);
      animation: blink 2s ease-in-out infinite;
    }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.25} }
    .span-text { font-family: 'Space Mono', monospace; font-size: 0.58rem; color: var(--muted); }

    /* ── STAT CARDS ──
       Fixed 4-column grid on desktop, 2-col on tablet, 1-col on mobile.
       min-width 0 prevents overflow / clipping. ── */
    .cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1px;
      background: var(--border);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      margin-bottom: 2rem;
    }
    @media (max-width: 900px) {
      .cards { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 480px) {
      .cards { grid-template-columns: 1fr; }
    }

    .card {
      background: var(--surface);
      /* min-width:0 prevents grid blowout and text clipping */
      min-width: 0;
      padding: 1.2rem 1.2rem 1rem;
      display: flex; flex-direction: column; gap: 0.5rem;
      position: relative; overflow: hidden;
      transition: background 0.15s;
    }
    .card::after {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
      background: transparent; transition: background 0.2s, box-shadow 0.2s;
    }
    .card:hover { background: var(--surf2); }
    .card:hover::after {
      background: var(--ca, var(--cyan));
      box-shadow: 0 0 10px var(--ca, var(--cyan));
    }
    .card-label {
      font-family: 'Space Mono', monospace;
      font-size: 0.6rem; color: var(--muted);
      letter-spacing: 0.08em; text-transform: uppercase;
      /* Prevent wrap from clipping */
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .card-value {
      font-size: clamp(1.5rem, 3vw, 2rem);
      font-weight: 800; line-height: 1;
      letter-spacing: -0.02em; color: #fff;
      /* Numbers truncate gracefully */
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* Smaller variant for long strings like dates */
    .card-value.sm {
      font-size: clamp(0.85rem, 1.8vw, 1rem);
      letter-spacing: 0; font-weight: 700;
      white-space: normal; word-break: break-word;
    }
    .card-sub {
      font-family: 'Space Mono', monospace;
      font-size: 0.56rem; color: var(--muted); margin-top: auto;
    }
    .badge {
      display: inline-flex; align-items: center; gap: 0.3rem;
      font-family: 'Space Mono', monospace; font-size: 0.6rem; font-weight: 700;
      padding: 0.2rem 0.5rem; border-radius: 4px;
      width: fit-content; margin-top: 0.15rem; white-space: nowrap;
    }
    .badge-up   { background: rgba(47,255,160,0.12); color: var(--green); }
    .badge-down { background: rgba(255,85,102,0.12); color: var(--red);   }
    .badge-flat { background: rgba(255,204,68,0.12); color: var(--gold);  }

    /* ── SECTION LABEL ── */
    .section-label {
      font-family: 'Space Mono', monospace;
      font-size: 0.58rem; letter-spacing: 0.14em;
      text-transform: uppercase; color: var(--muted);
      margin-bottom: 0.75rem;
      display: flex; align-items: center; gap: 0.75rem;
    }
    .section-label::after { content:''; flex:1; height:1px; background:var(--border); }
    .res-pill {
      font-family: 'Space Mono', monospace; font-size: 0.52rem;
      color: var(--gold); background: rgba(255,204,68,0.08);
      border: 1px solid rgba(255,204,68,0.22);
      padding: 0.15rem 0.5rem; border-radius: 20px; white-space: nowrap;
    }

    /* ── CHART GRID ── */
    .chart-grid { display: grid; grid-template-columns: 1fr; gap: 1.25rem; margin-bottom: 1.25rem; }
    @media(min-width:860px) { .chart-grid.two { grid-template-columns: 1fr 1fr; } }

    .chart-card {
      background: var(--surface);
      border: 1px solid var(--border); border-radius: 14px;
      padding: 1.4rem 1.4rem 1.1rem;
      display: flex; flex-direction: column; gap: 1rem;
    }
    .chart-top {
      display: flex; align-items: center;
      justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;
    }
    .chart-title { font-size: 0.9rem; font-weight: 700; color: #fff; }

    /* Legend */
    .legend-row { display: flex; gap: 1.2rem; flex-wrap: wrap; }
    .leg {
      display: flex; align-items: center; gap: 0.5rem;
      font-family: 'Space Mono', monospace; font-size: 0.6rem; color: var(--muted);
    }
    .leg-solid { width: 20px; height: 2.5px; border-radius: 2px; flex-shrink: 0; }
    .leg-dash {
      width: 20px; height: 2.5px; flex-shrink: 0;
      background: repeating-linear-gradient(
        90deg, var(--c) 0, var(--c) 4px, transparent 4px, transparent 7px
      );
    }

    /* ── CHART CONTAINER — explicit height, absolute canvas ── */
    .chart-wrap { position: relative; width: 100%; height: 280px; }
    .chart-wrap.tall { height: 340px; }
    @media(min-width:860px) { .chart-wrap.tall { height: 380px; } }
    .chart-wrap canvas {
      position: absolute; inset: 0;
      width: 100% !important; height: 100% !important;
    }

    /* ── FOOTER ── */
    .footer {
      margin-top: 3rem; padding-top: 1.25rem;
      border-top: 1px solid var(--border);
      display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;
    }
    .footer span { font-family: 'Space Mono', monospace; font-size: 0.58rem; color: var(--muted); }
    .footer em   { color: var(--cyan); font-style: normal; }

    /* Fade-in */
    .fade { opacity:0; transform:translateY(10px); animation: up 0.45s ease forwards; }
    @keyframes up { to { opacity:1; transform:none; } }
    .d1{animation-delay:.04s} .d2{animation-delay:.08s} .d3{animation-delay:.12s}
    .d4{animation-delay:.16s} .d5{animation-delay:.20s} .d6{animation-delay:.24s}
    .d7{animation-delay:.28s} .d8{animation-delay:.32s} .d9{animation-delay:.38s}
    .d10{animation-delay:.44s} .d11{animation-delay:.50s}
  </style>
</head>
<body>
<div class="wrapper">

  <!-- HEADER -->
  <header class="header fade d1">
    <div>
      <div class="eyebrow">// app analytics</div>
      <h1>${appName}</h1>
    </div>
    <div class="header-right">
      <span class="span-text">${activeSpan}</span>
      <span class="span-text">${activeDays} active day${activeDays !== 1 ? "s" : ""}</span>
    </div>
  </header>

  <!-- STAT CARDS — 4 columns desktop, 2 tablet, 1 mobile -->
  <div class="cards">
    <div class="card fade d1" style="--ca:var(--cyan)">
      <span class="card-label">Total Pings</span>
      <span class="card-value" style="color:var(--cyan)">${totalPings.toLocaleString()}</span>
      <span class="card-sub">all-time requests</span>
    </div>
    <div class="card fade d2" style="--ca:var(--purple)">
      <span class="card-label">Unique Users</span>
      <span class="card-value" style="color:var(--purple)">${uniqueUsers.toLocaleString()}</span>
      <span class="card-sub">distinct </span>
    </div>
    <div class="card fade d3" style="--ca:var(--green)">
      <span class="card-label">Peak Concurrent</span>
      <span class="card-value" style="color:var(--green)">${peakConcurrent.toLocaleString()}</span>
      <span class="card-sub">users at once</span>
    </div>
    <div class="card fade d4" style="--ca:var(--gold)">
      <span class="card-label">7-Day Trend</span>
      <span class="card-value">${Math.abs(trendPct)}%</span>
      <span class="badge ${trendPct === 0 ? "badge-flat" : trendUp ? "badge-up" : "badge-down"}">
        ${trendPct === 0 ? "━" : trendUp ? "▲" : "▼"} vs prior 7d
      </span>
    </div>
    <div class="card fade d5" style="--ca:var(--cyan)">
      <span class="card-label">Avg / Day</span>
      <span class="card-value">${avgPerDay}</span>
      <span class="card-sub">pings per day</span>
    </div>
    <div class="card fade d6" style="--ca:var(--cyan)">
      <span class="card-label">Avg / Hour</span>
      <span class="card-value">${avgPerHour}</span>
      <span class="card-sub">pings per hour</span>
    </div>
    <div class="card fade d7" style="--ca:var(--gold)">
      <span class="card-label">Peak Hour</span>
      <span class="card-value sm" style="color:var(--gold)">${peakHourLabel.replace("T", "@")}</span>
      <span class="card-sub">${peakHourValue.toLocaleString()} pings</span>
    </div>
    <div class="card fade d8" style="--ca:var(--gold)">
      <span class="card-label">Peak Day</span>
      <span class="card-value sm" style="color:var(--gold)">${peakDayLabel}</span>
      <span class="card-sub">${peakDayValue.toLocaleString()} pings</span>
    </div>
  </div>

  <!-- MAIN: Last 7 days hourly — always raw, always readable -->
  <div class="section-label fade d9">Last 7 Days</div>
  <div class="chart-grid fade d9">
    <div class="chart-card">
      <div class="chart-top">
        <span class="chart-title">Pings &amp; Concurrent Users</span>
      </div>
      <div class="legend-row">
        <span class="leg">
          <span class="leg-solid" style="background:var(--cyan)"></span>Pings / hr
        </span>
        <span class="leg">
          <span class="leg-dash" style="--c:var(--green)"></span>Concurrent
        </span>
      </div>
      <div class="chart-wrap tall"><canvas id="last7Chart"></canvas></div>
    </div>
  </div>

  <!-- BOTTOM ROW: Full-history line + concurrent peak line -->
  <div class="section-label fade d10">
    ${historySeries.isWeekly ? "Full Weekly History" : "Daily History"}
  </div>
  <div class="chart-grid two fade d10">

    <!-- Full history pings -->
    <div class="chart-card">
      <div class="chart-top">
        <span class="chart-title">
          ${historySeries.isWeekly ? "Pings per Week" : "Pings per Day"}
        </span>
      </div>
      <div class="legend-row">
        <span class="leg">
          <span class="leg-solid" style="background:var(--cyan)"></span>
          ${historySeries.isWeekly ? "Pings / week" : "Pings / day"}
        </span>
      </div>
      <div class="chart-wrap"><canvas id="historyChart"></canvas></div>
    </div>

    <!-- Concurrent peak full history -->
    <div class="chart-card">
      <div class="chart-top">
        <span class="chart-title">
          Peak Concurrent
        </span>
      </div>
      <div class="legend-row">
        <span class="leg">
          <span class="leg-solid" style="background:var(--purple)"></span>
          ${historySeries.isWeekly ? "Max concurrent / week" : "Max concurrent / day"}
        </span>
      </div>
      <div class="chart-wrap"><canvas id="concChart"></canvas></div>
    </div>

  </div>

  <div class="footer fade d11">
    <span>Last ping: <em>${lastPing.toLocaleString()}</em></span>
    <span>Generated: <em>${new Date().toLocaleString()}</em></span>
  </div>
</div>

<script>
// ── Server data ────────────────────────────────────────────────────────────────
const last7Labels  = ${JSON.stringify(last7.labels)};
const last7Pings   = ${JSON.stringify(last7.pings)};
const last7Conc    = ${JSON.stringify(last7.conc)};

const histLabels   = ${JSON.stringify(historySeries.labels)};
const histValues   = ${JSON.stringify(historySeries.values)};
const histConc     = ${JSON.stringify(historySeries.concValues)};

// ── Shared Chart.js config ─────────────────────────────────────────────────────
Chart.defaults.color = '#506070';
Chart.defaults.font.family = "'Space Mono', monospace";
Chart.defaults.font.size = 10;

// Bigger hit targets & crosshair-style tooltip
const TOOLTIP = {
  backgroundColor: 'rgba(10,16,28,0.96)',
  borderColor: '#1a2438',
  borderWidth: 1,
  titleColor: '#dce8f5',
  bodyColor: '#8aabb8',
  padding: 12,
  caretSize: 6,
  boxPadding: 4,
  usePointStyle: true,
};

function makeScales(maxTicksX = 12, yLabel = '') {
  return {
    x: {
      ticks: { color:'#506070', maxRotation:40, maxTicksLimit:maxTicksX, autoSkip:true, padding:6 },
      grid:  { color:'rgba(26,36,56,0.8)' },
      border:{ color:'rgba(26,36,56,0.8)' }
    },
    y: {
      beginAtZero: true,
      ticks: { color:'#506070', padding:8 },
      grid:  { color:'rgba(26,36,56,0.8)' },
      border:{ color:'rgba(26,36,56,0.8)' },
      title: yLabel ? { display:true, text:yLabel, color:'#506070', font:{size:9} } : undefined,
    }
  };
}

// Gradient helper
function makeGradient(ctx, colorTop, colorBot) {
  const g = ctx.createLinearGradient(0, 0, 0, 400);
  g.addColorStop(0, colorTop);
  g.addColorStop(1, colorBot);
  return g;
}

// ── 1. Last 7 days — hourly line chart ────────────────────────────────────────
{
  const canvas = document.getElementById('last7Chart');
  const ctx    = canvas.getContext('2d');

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: last7Labels,
      datasets: [
        {
          label: 'Pings / hr',
          data: last7Pings,
          borderColor: '#38d9ff',
          backgroundColor: ctx => makeGradient(ctx.chart.ctx, 'rgba(56,217,255,0.18)', 'rgba(56,217,255,0.0)'),
          fill: true, tension: 0.38,
          pointRadius: 0, pointHoverRadius: 6,
          pointHoverBackgroundColor: '#38d9ff',
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
          borderWidth: 2.5,
        },
        {
          label: 'Concurrent',
          data: last7Conc,
          borderColor: '#2fffa0',
          backgroundColor: 'transparent',
          fill: false, tension: 0.38,
          pointRadius: 0, pointHoverRadius: 5,
          pointHoverBackgroundColor: '#2fffa0',
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
          borderWidth: 2,
          borderDash: [6, 4],
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 600, easing: 'easeOutQuart' },
      // Larger interaction zone — easier hover
      interaction: { mode: 'index', intersect: false },
      hover: { mode: 'index', intersect: false },
      scales: makeScales(14),
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TOOLTIP,
          callbacks: {
            title: items => items[0]?.label ?? '',
            label: ctx => '  ' + ctx.dataset.label + ':  ' + ctx.formattedValue,
          }
        }
      }
    }
  });
}

// ── 2. Full history pings — line chart ────────────────────────────────────────
{
  const canvas = document.getElementById('historyChart');
  const ctx    = canvas.getContext('2d');
  const peakIdx = histValues.indexOf(Math.max(...histValues, 0));

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: histLabels,
      datasets: [{
        label: 'Pings',
        data: histValues,
        borderColor: '#38d9ff',
        backgroundColor: ctx => makeGradient(ctx.chart.ctx, 'rgba(56,217,255,0.15)', 'rgba(56,217,255,0.0)'),
        fill: true, tension: 0.3,
        pointRadius: histValues.map((_, i) => i === peakIdx ? 5 : 0),
        pointBackgroundColor: histValues.map((_, i) => i === peakIdx ? '#ffcc44' : '#38d9ff'),
        pointBorderColor: '#fff',
        pointBorderWidth: histValues.map((_, i) => i === peakIdx ? 2 : 0),
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#38d9ff',
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 500, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      hover: { mode: 'index', intersect: false },
      scales: makeScales(10),
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TOOLTIP,
          callbacks: {
            label: ctx => '  Pings: ' + ctx.formattedValue,
            afterLabel: ctx => ctx.dataIndex === peakIdx ? '  ★ peak' : '',
          }
        }
      }
    }
  });
}

// ── 3. Full history concurrent — line chart ───────────────────────────────────
{
  const canvas = document.getElementById('concChart');
  const ctx    = canvas.getContext('2d');

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: histLabels,
      datasets: [{
        label: 'Peak concurrent',
        data: histConc,
        borderColor: '#c084ff',
        backgroundColor: ctx => makeGradient(ctx.chart.ctx, 'rgba(192,132,255,0.14)', 'rgba(192,132,255,0.0)'),
        fill: true, tension: 0.3,
        pointRadius: 0, pointHoverRadius: 5,
        pointHoverBackgroundColor: '#c084ff',
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 500, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      hover: { mode: 'index', intersect: false },
      scales: makeScales(10),
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TOOLTIP,
          callbacks: { label: ctx => '  Concurrent: ' + ctx.formattedValue }
        }
      }
    }
  });
}
</script>
</body>
</html>`);
}

module.exports = { getStats };
