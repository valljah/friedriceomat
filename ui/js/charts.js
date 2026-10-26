// Small dependency-free canvas line chart with a hover crosshair + tooltip.
// Colours come from CSS custom properties so light/dark themes just work.

export class LineChart {
  // series: [{ key, label, color: '--series-1', dashed? }]
  // opts: { yMin, yMax, unit, format, refs: [{ value | key, label }] }
  constructor(canvas, series, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.series = series;
    this.opts = { yMin: 0, yMax: 1, unit: '', format: (v) => v.toFixed(2), maxPoints: 1500, ...opts };
    this.data = [];
    this.refs = opts.refs ?? [];
    this.hover = null;
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tooltip';
    this.tooltip.hidden = true;
    canvas.parentElement.appendChild(this.tooltip);
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.tooltip.hidden = true; this.draw(); });
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.dpr = dpr;
    this.draw();
  }

  clear() { this.data = []; this.draw(); }

  push(x, values) {
    this.data.push({ x, ...values });
    if (this.data.length > this.opts.maxPoints) {
      // Thin the history instead of dropping the start of the episode.
      this.data = this.data.filter((_, i) => i % 2 === 0 || i === this.data.length - 1);
    }
  }

  setRefs(refs) { this.refs = refs; }

  get pad() { return { l: 40, r: 12, t: 10, b: 20 }; }

  xScale() {
    const { l, r } = this.pad;
    const xs = this.data.map((d) => d.x);
    const x0 = this.opts.xMin ?? (xs.length ? xs[0] : 0);
    const x1 = Math.max(x0 + (this.opts.minSpan ?? 1), xs.length ? xs[xs.length - 1] : 1);
    return { x0, x1, f: (x) => l + ((x - x0) / (x1 - x0)) * (this.w - l - r) };
  }

  yScale() {
    const { t, b } = this.pad;
    let { yMin, yMax } = this.opts;
    if (this.opts.auto && this.data.length) {
      for (const d of this.data) for (const s of this.series) {
        const v = d[s.key];
        if (v == null) continue;
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
      }
    }
    return { yMin, yMax, f: (y) => t + (1 - (y - yMin) / (yMax - yMin || 1)) * (this.h - t - b) };
  }

  onMove(e) {
    if (!this.data.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const xs = this.xScale();
    let best = 0;
    let bestD = Infinity;
    this.data.forEach((d, i) => {
      const dd = Math.abs(xs.f(d.x) - px);
      if (dd < bestD) { bestD = dd; best = i; }
    });
    this.hover = best;
    const d = this.data[best];
    const rows = this.series
      .filter((s) => d[s.key] != null)
      .map((s) => `<div class="tt-row"><i style="background:var(${s.color})"></i>${s.label}<b>${this.opts.format(d[s.key])}${this.opts.unit}</b></div>`)
      .join('');
    this.tooltip.innerHTML = `<div class="tt-head">${this.opts.xLabel ?? 't'} = ${this.opts.xFormat ? this.opts.xFormat(d.x) : d.x.toFixed(1)}</div>${rows}`;
    this.tooltip.hidden = false;
    const left = Math.min(xs.f(d.x) + 12, this.w - this.tooltip.offsetWidth - 4);
    this.tooltip.style.left = `${Math.max(4, left)}px`;
    this.tooltip.style.top = '6px';
    this.draw();
  }

  draw() {
    const { ctx, dpr } = this;
    const css = getComputedStyle(this.canvas);
    const v = (n) => css.getPropertyValue(n).trim();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const xs = this.xScale();
    const ys = this.yScale();
    const { l, r, t, b } = this.pad;

    // Grid + axis labels
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = v('--muted');
    ctx.strokeStyle = v('--grid');
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let k = 0; k <= 4; k++) {
      const yv = ys.yMin + ((ys.yMax - ys.yMin) * k) / 4;
      const y = Math.round(ys.f(yv)) + 0.5;
      ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(this.w - r, y); ctx.stroke();
      ctx.fillText(this.opts.tick ? this.opts.tick(yv) : this.opts.format(yv), l - 6, y);
    }
    ctx.strokeStyle = v('--axis');
    ctx.beginPath(); ctx.moveTo(l, this.h - b + 0.5); ctx.lineTo(this.w - r, this.h - b + 0.5); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(this.opts.xFormat ? this.opts.xFormat(xs.x0) : `${xs.x0.toFixed(0)}`, l + 10, this.h - b + 4);
    ctx.fillText(this.opts.xFormat ? this.opts.xFormat(xs.x1) : `${xs.x1.toFixed(0)}`, this.w - r - 14, this.h - b + 4);

    // Reference lines (targets)
    ctx.setLineDash([4, 4]);
    for (const ref of this.refs) {
      const y = ys.f(ref.value);
      if (y < t || y > this.h - b) continue;
      ctx.strokeStyle = ref.color ? v(ref.color) : v('--muted');
      ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(this.w - r, y); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = v('--muted');
      ctx.textAlign = ref.side === 'left' ? 'left' : 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(ref.label, ref.side === 'left' ? l + 4 : this.w - r - 2, y - 2);
    }
    ctx.setLineDash([]);

    // Series
    for (const s of this.series) {
      ctx.strokeStyle = v(s.color);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      if (s.dashed) ctx.setLineDash([2, 3]);
      ctx.beginPath();
      let started = false;
      for (const d of this.data) {
        const val = d[s.key];
        if (val == null) { started = false; continue; }
        const x = xs.f(d.x);
        const y = ys.f(Math.min(ys.yMax, Math.max(ys.yMin, val)));
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (s.dots) {
        ctx.fillStyle = v(s.color);
        for (const d of this.data) {
          if (d[s.key] == null) continue;
          ctx.beginPath(); ctx.arc(xs.f(d.x), ys.f(d[s.key]), 2.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // Crosshair
    if (this.hover != null && this.data[this.hover]) {
      const d = this.data[this.hover];
      const x = xs.f(d.x);
      ctx.strokeStyle = v('--axis');
      ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, this.h - b); ctx.stroke();
      for (const s of this.series) {
        if (d[s.key] == null) continue;
        ctx.fillStyle = v('--panel');
        ctx.beginPath(); ctx.arc(x, ys.f(d[s.key]), 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = v(s.color);
        ctx.beginPath(); ctx.arc(x, ys.f(d[s.key]), 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}

// Diverging heatmap of the policy weights (actions × features).
export class WeightMap {
  constructor(canvas, rows, cols) {
    this.canvas = canvas;
    this.rows = rows;
    this.cols = cols;
    this.W = null;
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tooltip';
    this.tooltip.hidden = true;
    canvas.parentElement.appendChild(this.tooltip);
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerleave', () => { this.tooltip.hidden = true; });
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.dpr = dpr;
    if (this.W) this.draw(this.W);
  }

  get geom() {
    const left = 70;
    const top = 6;
    const bottom = 78;
    const cw = (this.w - left - 6) / this.cols.length;
    const ch = (this.h - top - bottom) / this.rows.length;
    return { left, top, cw, ch };
  }

  onMove(e) {
    if (!this.W) return;
    const rect = this.canvas.getBoundingClientRect();
    const { left, top, cw, ch } = this.geom;
    const c = Math.floor((e.clientX - rect.left - left) / cw);
    const r = Math.floor((e.clientY - rect.top - top) / ch);
    if (r < 0 || c < 0 || r >= this.rows.length || c >= this.cols.length) { this.tooltip.hidden = true; return; }
    this.tooltip.innerHTML = `<div class="tt-head">${this.rows[r]} ← ${this.cols[c]}</div><div class="tt-row">weight<b>${this.W[r][c].toFixed(3)}</b></div>`;
    this.tooltip.hidden = false;
    this.tooltip.style.left = `${Math.min(e.clientX - rect.left + 12, this.w - this.tooltip.offsetWidth - 4)}px`;
    this.tooltip.style.top = `${e.clientY - rect.top + 12}px`;
  }

  draw(W) {
    this.W = W;
    const ctx = this.canvas.getContext('2d');
    const css = getComputedStyle(this.canvas);
    const v = (n) => css.getPropertyValue(n).trim();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const { left, top, cw, ch } = this.geom;
    let max = 1e-6;
    for (const row of W) for (const x of row) max = Math.max(max, Math.abs(x));
    const pos = v('--div-pos');
    const neg = v('--div-neg');
    const mid = v('--div-mid');
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = v('--muted');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    this.rows.forEach((name, r) => ctx.fillText(name, left - 6, top + r * ch + ch / 2));
    W.forEach((row, r) => row.forEach((x, c) => {
      const t = Math.min(1, Math.abs(x) / max);
      ctx.fillStyle = mid;
      ctx.fillRect(left + c * cw + 1, top + r * ch + 1, cw - 2, ch - 2);
      ctx.globalAlpha = t;
      ctx.fillStyle = x >= 0 ? pos : neg;
      ctx.fillRect(left + c * cw + 1, top + r * ch + 1, cw - 2, ch - 2);
      ctx.globalAlpha = 1;
    }));
    ctx.save();
    ctx.fillStyle = v('--muted');
    ctx.textAlign = 'right';
    this.cols.forEach((name, c) => {
      ctx.save();
      ctx.translate(left + c * cw + cw / 2, top + this.rows.length * ch + 6);
      ctx.rotate(-Math.PI / 3);
      ctx.fillText(name, 0, 0);
      ctx.restore();
    });
    ctx.restore();
  }
}
