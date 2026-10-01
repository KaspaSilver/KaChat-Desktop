// PortfolioAreaChart and PortfolioSparkline, drawn as SVG at the container's real pixel size (so
// text is never stretched): a catmull-rom area with the accent gradient, the line, about four
// grid lines each way with hour or month-day labels along the bottom and values down the leading
// side, and the iOS touch model - one finger (or the mouse) scrubs to the nearest point, two
// fingers (or a mouse drag) select a range shaded green or red. Lifting clears both.

const ACCENT = "#70c7ba";
const GREEN = "#30d158";
const RED = "#ff453a";
let gradientSeq = 0;

/** Catmull-rom through the points as cubic Béziers (Swift Charts .catmullRom). */
function smoothPath(xy) {
  if (!xy.length) return "";
  let d = `M${xy[0][0].toFixed(2)},${xy[0][1].toFixed(2)}`;
  for (let i = 0; i < xy.length - 1; i += 1) {
    const p0 = xy[i - 1] || xy[i];
    const p1 = xy[i];
    const p2 = xy[i + 1];
    const p3 = xy[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(2)},${c1[1].toFixed(2)} ${c2[0].toFixed(2)},${c2[1].toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

/** "Nice" ticks inside [lo, hi], about `count` of them. */
function niceTicks(lo, hi, count = 4) {
  const span = hi - lo;
  if (!(span > 0)) return { ticks: [lo], step: 1 };
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  const step = (residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1) * magnitude;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return { ticks, step };
}

function yLabel(value, step, precise) {
  if (precise) return value === 0 ? "0" : value.toLocaleString(undefined, { minimumSignificantDigits: 3, maximumSignificantDigits: 3 });
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step) + 1e-9)));
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Calendar-aligned time ticks, about four (Swift Charts .automatic(desiredCount: 4)). */
function timeTicks(t0, t1) {
  const span = t1 - t0;
  const steps = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 91 * DAY, 182 * DAY, 365 * DAY];
  const step = steps.find((s) => span / s <= 4.5) || 365 * DAY;
  const ticks = [];
  if (step < DAY) {
    const start = new Date(t0); start.setMinutes(0, 0, 0);
    let t = start.getTime();
    while (t < t0) t += HOUR;
    while (t <= t1) { if (new Date(t).getHours() % (step / HOUR) === 0) ticks.push(t); t += HOUR; }
  } else if (step < 30 * DAY) {
    const start = new Date(t0); start.setHours(0, 0, 0, 0);
    let t = start.getTime();
    if (t < t0) t += DAY;
    const days = step / DAY;
    if (days === 7) { while (new Date(t).getDay() !== 0) t += DAY; }
    for (; t <= t1; t += step) ticks.push(t);
  } else {
    const months = Math.round(step / (30 * DAY));
    const d = new Date(t0); d.setDate(1); d.setHours(0, 0, 0, 0);
    if (d.getTime() < t0) d.setMonth(d.getMonth() + 1);
    while (d.getMonth() % months !== 0) d.setMonth(d.getMonth() + 1);
    for (; d.getTime() <= t1; d.setMonth(d.getMonth() + months)) ticks.push(d.getTime());
  }
  return ticks;
}

/**
 * Draws the chart into `host` and wires the touch model. Returns { destroy }.
 *   points: [[ms, value]] (at least 2)
 *   opts: { hideValues, preciseAxis, onScrub(point|null), onRange({start,end}|null) }
 */
export function mountAreaChart(host, points, opts = {}) {
  if (!host) return { destroy() {} };
  let selected = null;
  let range = null;
  let geometry = null;
  const gid = `pf-grad-${++gradientSeq}`;

  const draw = () => {
    const width = Math.max(120, Math.round(host.clientWidth || 328));
    const height = Math.round(host.clientHeight || 240);
    const values = points.map((p) => p[1]);
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const span = maxV - minV > 0 ? maxV - minV : Math.max(Math.abs(maxV), 1);
    const lower = minV - span * 0.1;
    const upper = maxV + span * 0.1;
    const t0 = points[0][0];
    const t1 = points[points.length - 1][0];
    const { ticks: yTicks, step } = niceTicks(lower, upper, 4);
    const labels = yTicks.map((v) => yLabel(v, step, opts.preciseAxis));
    // Leading axis: the plot starts after the widest label.
    const labelWidth = opts.hideValues ? 0 : Math.ceil(Math.max(...labels.map((l) => l.length)) * 6.2) + 6;
    const plot = { x: labelWidth, y: 6, w: width - labelWidth - 2, h: height - 6 - 22 };
    const xFor = (t) => plot.x + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * plot.w);
    const yFor = (v) => plot.y + (1 - (v - lower) / (upper - lower)) * plot.h;
    geometry = { plot, xFor, yFor, t0, t1, lower, upper };
    const xy = points.map(([t, v]) => [xFor(t), yFor(v)]);
    const line = smoothPath(xy);
    const bottom = plot.y + plot.h;
    const area = `${line}L${xy[xy.length - 1][0].toFixed(2)},${bottom}L${xy[0][0].toFixed(2)},${bottom}Z`;
    const intraday = t1 - t0 <= 2 * DAY;
    const xTicks = timeTicks(t0, t1);
    const xLabelText = (t) => (intraday
      ? new Date(t).toLocaleTimeString(undefined, { hour: "numeric" })
      : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }));

    let overlay = "";
    if (range) {
      const up = range.end[1] - range.start[1] >= 0;
      const color = up ? GREEN : RED;
      const xa = xFor(range.start[0]);
      const xb = xFor(range.end[0]);
      overlay = `
        <rect x="${xa}" y="${plot.y}" width="${Math.max(1, xb - xa)}" height="${plot.h}" fill="${color}" fill-opacity=".10"/>
        ${[range.start, range.end].map((p) => `
          <line x1="${xFor(p[0])}" x2="${xFor(p[0])}" y1="${plot.y}" y2="${bottom}" stroke="${color}" stroke-opacity=".6" stroke-width="1"/>
          <circle cx="${xFor(p[0])}" cy="${yFor(p[1])}" r="6" fill="${color}"/>`).join("")}`;
    } else if (selected) {
      overlay = `
        <line x1="${xFor(selected[0])}" x2="${xFor(selected[0])}" y1="${plot.y}" y2="${bottom}" stroke="rgba(235,235,245,.35)" stroke-width="1"/>
        <circle cx="${xFor(selected[0])}" cy="${yFor(selected[1])}" r="6" fill="${ACCENT}"/>`;
    }

    host.innerHTML = `
      <svg class="pf-chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
        <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${ACCENT}" stop-opacity=".28"/><stop offset="1" stop-color="${ACCENT}" stop-opacity=".03"/>
        </linearGradient></defs>
        ${yTicks.map((v) => `<line class="pf-grid" x1="${plot.x}" x2="${plot.x + plot.w}" y1="${yFor(v).toFixed(1)}" y2="${yFor(v).toFixed(1)}"/>`).join("")}
        ${xTicks.map((t) => `<line class="pf-grid" x1="${xFor(t).toFixed(1)}" x2="${xFor(t).toFixed(1)}" y1="${plot.y}" y2="${bottom}"/>`).join("")}
        ${opts.hideValues ? "" : yTicks.map((v, i) => `<text class="pf-axis" x="${plot.x - 4}" y="${(yFor(v) + 3.5).toFixed(1)}" text-anchor="end">${labels[i]}</text>`).join("")}
        ${xTicks.map((t) => {
          // A label that would run off the right edge hangs left of its grid line instead.
          const text = xLabelText(t);
          const overflow = xFor(t) + 2 + text.length * 6 > width;
          return `<text class="pf-axis" x="${(xFor(t) + (overflow ? -2 : 2)).toFixed(1)}" y="${bottom + 15}" text-anchor="${overflow ? "end" : "start"}">${text}</text>`;
        }).join("")}
        <path d="${area}" fill="url(#${gid})"/>
        <path d="${line}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        ${overlay}
      </svg>`;
  };

  // --- the touch model -------------------------------------------------------------------------
  const nearest = (clientX, clamp) => {
    if (!geometry) return null;
    const rect = host.getBoundingClientRect();
    let x = clientX - rect.left - geometry.plot.x;
    if (clamp) x = Math.min(Math.max(x, 0), geometry.plot.w);
    else if (x < 0 || x > geometry.plot.w) return null;
    const t = geometry.t0 + (x / geometry.plot.w) * (geometry.t1 - geometry.t0);
    let best = points[0];
    for (const p of points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    return best;
  };
  const setSelected = (point) => {
    if (point === selected) return;
    selected = point;
    draw();
    opts.onScrub?.(point);
  };
  const setRange = (next) => {
    const same = next && range && next.start === range.start && next.end === range.end;
    if (same || (!next && !range)) return;
    range = next;
    draw();
    opts.onRange?.(next);
  };
  const pairRange = (a, b) => {
    const p = nearest(a, true);
    const q = nearest(b, true);
    if (!p || !q) return null;
    return p[0] <= q[0] ? { start: p, end: q } : { start: q, end: p };
  };

  const pointers = new Map();
  let mouseDown = null; // clientX where a mouse drag began
  const onDown = (event) => {
    if (event.pointerType === "mouse") {
      if (event.button !== 0) return;
      mouseDown = event.clientX;
      // The drag may end outside the chart: listen on the window until the button comes up.
      const move = (e) => onMove(e);
      const up = (e) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); onUp(e); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    pointers.set(event.pointerId, event.clientX);
    try { host.setPointerCapture(event.pointerId); } catch { /* not a live pointer */ }
    if (pointers.size === 1) setSelected(nearest(event.clientX, false));
    else if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      if (selected) { selected = null; opts.onScrub?.(null); }
      setRange(pairRange(a, b));
    }
  };
  const onMove = (event) => {
    if (event.pointerType === "mouse") {
      // A held button drags out a range (two fingers on iOS); hovering scrubs (one finger).
      if (mouseDown != null && Math.abs(event.clientX - mouseDown) > 3) {
        if (selected) { selected = null; opts.onScrub?.(null); }
        setRange(pairRange(mouseDown, event.clientX));
      } else if (mouseDown == null) setSelected(nearest(event.clientX, false));
      return;
    }
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, event.clientX);
    if (pointers.size === 1 && !range) setSelected(nearest(event.clientX, false));
    else if (pointers.size >= 2) { const [a, b] = [...pointers.values()]; setRange(pairRange(a, b)); }
  };
  const onUp = (event) => {
    if (event.pointerType === "mouse") {
      mouseDown = null;
      setRange(null);
      setSelected(nearest(event.clientX, false));
      return;
    }
    pointers.delete(event.pointerId);
    // The range stays while one finger is still down; everything clears when all lift.
    if (pointers.size === 0) { setRange(null); setSelected(null); }
  };
  const onLeave = (event) => {
    if (event.pointerType !== "mouse" || mouseDown != null) return;
    setSelected(null);
  };

  host.addEventListener("pointerdown", onDown);
  host.addEventListener("pointermove", (event) => { if (!(event.pointerType === "mouse" && mouseDown != null)) onMove(event); });
  host.addEventListener("pointerup", (event) => { if (event.pointerType !== "mouse") onUp(event); });
  host.addEventListener("pointercancel", onUp);
  host.addEventListener("pointerleave", onLeave);
  const resize = new ResizeObserver(() => draw());
  resize.observe(host);
  draw();
  return { destroy() { resize.disconnect(); } };
}

/** PortfolioSparkline: a 1.6 pt accent line, no axes. */
export function sparklineSvg(points, width = 96, height = 34) {
  if (!points || points.length < 2) return "";
  const values = points.map((p) => p[1]);
  const min = Math.min(...values);
  const span = Math.max(Math.max(...values) - min, Number.MIN_VALUE);
  const d = points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * width).toFixed(1)},${(height * (1 - (p[1] - min) / span)).toFixed(1)}`).join("");
  return `<svg class="pf-spark" width="${width}" height="${height}" viewBox="-1 -1 ${width + 2} ${height + 2}" aria-hidden="true"><path d="${d}" fill="none" stroke="${ACCENT}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
