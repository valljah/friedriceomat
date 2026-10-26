// Side-view renderer of the kitchen cell: ingredient bowls, a 3-joint arm
// with a spatula, the wok on its burner and the plate. Arm motion is driven by
// waypoints per action and solved with 2-link inverse kinematics.

import { ACTIONS } from './sim.js';

const W = 1000;
const H = 470;
const COUNTER = 392;
const SHOULDER = { x: 470, y: 250 };
const L1 = 225;
const L2 = 195;
const TOOL = 58;
const WOK = { x: 690, y: 345, r: 92 };
const PLATE = { x: 905, y: 380 };
const HOME = { x: WOK.x, y: 215, a: Math.PI / 2 };

const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function mixColor(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (p, s) => (p >> s) & 255;
  const c = (s) => Math.round(lerp(ch(pa, s), ch(pb, s), t));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}

export class ArmView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stages = [];
    this.path = [HOME];
    this.pathLen = [0];
    this.tip = { ...HOME };
    this.joints = { q1: 0, q2: 0, q3: 0 };
    this.action = null;
    this.carry = null;
    this.particles = [];
    this.puffs = [];
    this.plateFill = 0;
    this.shake = 0;
    this.time = 0;
    this.lastProgress = 0;
    this.flicks = [];
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.width * (H / W) * dpr));
    this.scale = this.canvas.width / W;
  }

  setPlan(plan) {
    this.stages = plan.stages;
    const n = this.stages.length;
    const left = 70;
    const right = 370;
    this.bowls = this.stages.map((st, i) => ({
      x: n === 1 ? (left + right) / 2 : lerp(left, right, i / (n - 1)),
      y: COUNTER - 6,
      color: st.color,
      label: st.label,
      full: true,
    }));
    this.reset();
  }

  reset() {
    this.particles = [];
    this.puffs = [];
    this.plateFill = 0;
    this.carry = null;
    this.action = null;
    this.setPath([this.tip, HOME]);
    for (const b of this.bowls ?? []) b.full = true;
  }

  setPath(points) {
    this.path = points;
    this.pathLen = [0];
    for (let i = 1; i < points.length; i++) {
      const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) + 20;
      this.pathLen.push(this.pathLen[i - 1] + d);
    }
  }

  // Called when the controller starts an action.
  startAction(a, sim) {
    const name = ACTIONS[a];
    this.action = name;
    this.lastProgress = 0;
    this.flicks = [];
    const from = { ...this.tip };
    const down = Math.PI / 2;
    if (name === 'ADD') {
      const bowl = this.bowls[sim.s.next];
      this.addIndex = sim.s.next;
      this.setPath([
        from,
        { x: bowl.x, y: 230, a: down },
        { x: bowl.x, y: COUNTER - 22, a: down + 0.2 },
        { x: bowl.x, y: 220, a: down - 0.3, grab: true },
        { x: WOK.x - 20, y: 220, a: down - 0.3 },
        { x: WOK.x - 10, y: 250, a: down + 1.2, pour: true },
        { ...HOME },
      ]);
    } else if (name === 'STIR') {
      const pts = [from];
      for (let k = 0; k <= 6; k++) pts.push({ x: WOK.x + (k % 2 ? 55 : -55), y: WOK.y - 22 + (k % 2 ? 6 : -4), a: down + (k % 2 ? 0.35 : -0.35) });
      pts.push({ ...HOME });
      this.setPath(pts);
    } else if (name === 'TOSS') {
      this.setPath([
        from,
        { x: WOK.x - 60, y: WOK.y - 20, a: down - 0.5 },
        { x: WOK.x + 30, y: WOK.y - 110, a: down - 1.1, flick: true },
        { x: WOK.x - 60, y: WOK.y - 20, a: down - 0.5 },
        { x: WOK.x + 30, y: WOK.y - 110, a: down - 1.1, flick: true },
        { ...HOME },
      ]);
    } else if (name === 'PLATE') {
      const pts = [from];
      for (let k = 0; k < 2; k++) {
        pts.push({ x: WOK.x - 40, y: WOK.y - 25, a: down - 0.4 });
        pts.push({ x: WOK.x, y: 230, a: down - 0.4 });
        pts.push({ x: PLATE.x - 10, y: PLATE.y - 70, a: down - 0.4 });
        pts.push({ x: PLATE.x, y: PLATE.y - 50, a: down + 1.1, serve: true });
      }
      pts.push({ x: PLATE.x - 60, y: 220, a: down });
      this.setPath(pts);
    } else {
      // Burner changes are electronic: the arm just hovers.
      this.setPath([from, { x: from.x, y: from.y - 6, a: from.a }, { ...HOME }]);
    }
  }

  // progress: 0..1 of the current action.
  update(progress, sim, dt) {
    this.time += dt;
    const total = this.pathLen[this.pathLen.length - 1] || 1;
    const d = ease(clamp01(progress)) * total;
    let i = 1;
    while (i < this.pathLen.length - 1 && this.pathLen[i] < d) i++;
    const a = this.path[i - 1];
    const b = this.path[i] ?? a;
    const seg = this.pathLen[i] - this.pathLen[i - 1] || 1;
    const t = ease(clamp01((d - this.pathLen[i - 1]) / seg));
    this.tip = { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), a: lerp(a.a, b.a, t) };

    // Discrete events along the path.
    for (let k = 0; k < this.path.length; k++) {
      const reached = this.pathLen[k] <= d && this.pathLen[k] > ease(clamp01(this.lastProgress)) * total;
      if (!reached) continue;
      const p = this.path[k];
      if (p.grab && this.bowls[this.addIndex]) {
        this.carry = this.bowls[this.addIndex].color;
        this.bowls[this.addIndex].full = false;
      }
      if (p.pour) this.carry = null;
      if (p.flick) this.flick(sim);
      if (p.serve) this.plateFill = Math.min(1, this.plateFill + 0.5);
    }
    this.lastProgress = progress;

    this.solveIK();
    this.updateParticles(sim, dt);
  }

  solveIK() {
    const { x, y, a } = this.tip;
    const wx = x - Math.cos(a) * TOOL;
    const wy = y - Math.sin(a) * TOOL;
    const dx = wx - SHOULDER.x;
    const dy = wy - SHOULDER.y;
    const dist = Math.min(Math.hypot(dx, dy), L1 + L2 - 1);
    const base = Math.atan2(dy, dx);
    const cosE = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist);
    const off = Math.acos(Math.max(-1, Math.min(1, cosE)));
    // Pick the elbow-up solution (elbow above the line shoulder → wrist).
    const q1 = dx >= 0 ? base - off : base + off;
    const ex = SHOULDER.x + Math.cos(q1) * L1;
    const ey = SHOULDER.y + Math.sin(q1) * L1;
    const q2abs = Math.atan2(wy - ey, wx - ex);
    this.elbow = { x: ex, y: ey };
    this.wrist = { x: ex + Math.cos(q2abs) * L2, y: ey + Math.sin(q2abs) * L2 };
    this.joints = { q1: -q1, q2: -(q2abs - q1), q3: -(a - q2abs) };
  }

  syncFood(sim) {
    // Keep one particle per ~2 g of food, coloured by ingredient.
    const target = Math.min(260, Math.round(sim.s.mass / 2));
    while (this.particles.length < target) {
      const added = sim.plan.stages.filter((_, i) => sim.s.added[i]);
      const weights = added.map((st) => st.grams);
      let u = Math.random() * weights.reduce((a, b) => a + b, 0);
      let st = added[0];
      for (let k = 0; k < added.length; k++) { u -= weights[k]; if (u <= 0) { st = added[k]; break; } }
      if (!st) break;
      const hx = (Math.random() * 2 - 1) * 0.85;
      this.particles.push({
        hx, hy: Math.random(),
        x: WOK.x + hx * WOK.r * 0.8, y: WOK.y - 60, vx: 0, vy: 0, air: true,
        base: st.category === 'fat' ? null : st.color, rice: st.category === 'rice',
        size: st.category === 'rice' ? 2.2 : 3.2,
      });
    }
    if (this.particles.length > target) this.particles.length = target;
  }

  flick(sim) {
    this.shake = 1;
    const toss = sim.cfg.tossIntensity;
    for (const p of this.particles) {
      if (Math.random() < 0.4 + 0.5 * toss) {
        p.air = true;
        p.vx = (Math.random() * 2 - 1) * 60 - 40;
        p.vy = -(160 + Math.random() * 220) * (0.5 + toss);
      }
    }
  }

  updateParticles(sim, dt) {
    this.syncFood(sim);
    const s = sim.s;
    const ag = s.agitation;
    for (const p of this.particles) {
      const restX = WOK.x + p.hx * WOK.r * 0.78 * Math.sqrt(1 - p.hy * 0.5);
      const restY = this.wokSurface(restX) - p.hy * 14 - 2;
      if (p.air) {
        p.vy += 900 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx += (restX - p.x) * 2 * dt;
        if (p.vy > 0 && p.y >= restY) { p.air = false; p.y = restY; }
      } else {
        const jig = ag * 3;
        p.x = lerp(p.x, restX + (Math.random() - 0.5) * jig, 0.2);
        p.y = lerp(p.y, restY + (Math.random() - 0.5) * jig, 0.3);
        if (this.action === 'STIR' && Math.random() < 0.05) p.hx = Math.max(-0.85, Math.min(0.85, p.hx + (Math.random() - 0.5) * 0.3));
      }
    }
    // Steam (moisture leaving) and smoke (burning).
    const steam = s.mass > 0 && s.T > 105 ? s.moisture * (s.T - 100) / 100 : 0;
    const smoke = Math.min(1, s.burn * 3 + Math.max(0, s.T - 270) / 60);
    if (Math.random() < steam * dt * 25) this.puffs.push({ x: WOK.x + (Math.random() - 0.5) * 120, y: WOK.y - 30, life: 1, smoke: false });
    if (Math.random() < smoke * dt * 25) this.puffs.push({ x: WOK.x + (Math.random() - 0.5) * 100, y: WOK.y - 30, life: 1, smoke: true });
    for (const f of this.puffs) { f.y -= 50 * dt; f.x += Math.sin(this.time * 2 + f.y * 0.05) * 10 * dt; f.life -= dt * 0.6; }
    this.puffs = this.puffs.filter((f) => f.life > 0);
    this.shake = Math.max(0, this.shake - dt * 3);
  }

  wokSurface(x) {
    const u = (x - WOK.x) / WOK.r;
    return WOK.y + Math.sqrt(Math.max(0, 1 - u * u)) * WOK.r * 0.42;
  }

  draw(sim, readout) {
    const { ctx, scale } = this;
    const css = getComputedStyle(this.canvas);
    const col = (name, fb) => css.getPropertyValue(name).trim() || fb;
    const ink = col('--ink', '#e8e6e1');
    const muted = col('--muted', '#8b8f98');
    const steel = col('--steel', '#6d7480');
    const steelDark = col('--steel-dark', '#3c424c');
    const counter = col('--counter', '#2a2f37');
    const accent = col('--accent', '#ff7a1a');
    const s = sim.s;

    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Counter
    ctx.fillStyle = counter;
    ctx.fillRect(0, COUNTER, W, H - COUNTER);
    ctx.fillStyle = steelDark;
    ctx.fillRect(0, COUNTER, W, 4);

    // Bowls
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    (this.bowls ?? []).forEach((b, i) => {
      const next = i === s.next && !s.plated;
      ctx.fillStyle = steelDark;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y - 10, 22, 14, 0, 0, Math.PI);
      ctx.fill();
      if (b.full && !s.added[i]) {
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.ellipse(b.x, b.y - 11, 18, 5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = next ? accent : steel;
      ctx.lineWidth = next ? 2 : 1;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y - 11, 22, 6, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = s.added[i] ? muted : ink;
      ctx.save();
      ctx.translate(b.x, COUNTER + (this.bowls.length > 5 && i % 2 ? 32 : 16));
      ctx.fillText(b.label, 0, 0);
      ctx.restore();
    });

    // Stove + flame
    ctx.fillStyle = steelDark;
    ctx.fillRect(WOK.x - 95, COUNTER - 22, 190, 22);
    const flame = s.burner;
    if (flame > 0.01) {
      for (let k = -4; k <= 4; k++) {
        const fx = WOK.x + k * 16;
        const h = (10 + 34 * flame) * (0.75 + 0.25 * Math.sin(this.time * 18 + k * 1.7));
        const g = ctx.createLinearGradient(fx, COUNTER - 22, fx, COUNTER - 22 - h);
        g.addColorStop(0, 'rgba(70,140,255,0.95)');
        g.addColorStop(0.5, 'rgba(255,140,40,0.85)');
        g.addColorStop(1, 'rgba(255,200,60,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(fx - 6, COUNTER - 22);
        ctx.quadraticCurveTo(fx, COUNTER - 22 - h * 1.2, fx + 6, COUNTER - 22);
        ctx.fill();
      }
    }
    // Burner knob
    ctx.save();
    ctx.translate(WOK.x + 120, COUNTER - 11);
    ctx.fillStyle = steel;
    ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
    ctx.rotate(-Math.PI * 0.75 + flame * Math.PI * 1.5);
    ctx.strokeStyle = accent; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -9); ctx.stroke();
    ctx.restore();

    // Wok
    const shakeX = Math.sin(this.time * 60) * this.shake * 5;
    ctx.save();
    ctx.translate(shakeX, -this.shake * 6);
    const heat = Math.min(1, Math.max(0, (s.T - 100) / 220));
    ctx.fillStyle = mixColor('#3a3d42', '#7a2b12', heat * 0.7);
    ctx.beginPath();
    ctx.moveTo(WOK.x - WOK.r, WOK.y);
    ctx.quadraticCurveTo(WOK.x, WOK.y + WOK.r * 0.95, WOK.x + WOK.r, WOK.y);
    ctx.lineTo(WOK.x + WOK.r - 4, WOK.y - 3);
    ctx.quadraticCurveTo(WOK.x, WOK.y + WOK.r * 0.86, WOK.x - WOK.r + 4, WOK.y - 3);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = steelDark; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(WOK.x - WOK.r, WOK.y - 2); ctx.lineTo(WOK.x - WOK.r - 55, WOK.y - 22); ctx.stroke();
    ctx.restore();

    // Food
    const riceColor = (() => {
      const golden = mixColor('#f7f3e8', '#d9a441', clamp01(s.browning * 1.6));
      return s.browning > 0.6 || s.burn > 0.05 ? mixColor('#d9a441', '#2a1a10', clamp01((s.browning - 0.6) * 1.5 + s.burn * 3)) : golden;
    })();
    for (const p of this.particles) {
      if (!p.base && !p.rice) continue;
      ctx.fillStyle = p.rice ? riceColor : p.base;
      ctx.beginPath();
      ctx.ellipse(p.x + shakeX, p.y, p.size * 1.3, p.size, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (s.mass > 0 && this.particles.every((p) => !p.base && !p.rice)) {
      // Just oil: a glossy film.
      ctx.fillStyle = 'rgba(242,201,76,0.5)';
      ctx.beginPath(); ctx.ellipse(WOK.x, WOK.y + 30, 50, 5, 0, 0, Math.PI * 2); ctx.fill();
    }

    // Steam / smoke
    for (const f of this.puffs) {
      ctx.fillStyle = f.smoke ? `rgba(60,60,60,${f.life * 0.5})` : `rgba(230,235,240,${f.life * 0.25})`;
      ctx.beginPath(); ctx.arc(f.x, f.y, 8 + (1 - f.life) * 18, 0, Math.PI * 2); ctx.fill();
    }

    // Plate
    ctx.fillStyle = '#e9e7e2';
    ctx.beginPath(); ctx.ellipse(PLATE.x, PLATE.y, 62, 11, 0, 0, Math.PI * 2); ctx.fill();
    if (this.plateFill > 0) {
      ctx.fillStyle = riceColor;
      ctx.beginPath(); ctx.ellipse(PLATE.x, PLATE.y - 4, 44 * this.plateFill, 16 * this.plateFill, 0, Math.PI, 0); ctx.fill();
    }

    // Sensor head (camera + IR) on a mast above the wok.
    const mast = { x: WOK.x + 150, y: 70 };
    ctx.strokeStyle = steelDark; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(mast.x + 40, COUNTER); ctx.lineTo(mast.x + 40, mast.y); ctx.lineTo(mast.x, mast.y); ctx.stroke();
    ctx.fillStyle = steel;
    ctx.fillRect(mast.x - 22, mast.y - 10, 30, 20);
    if (readout.temp != null) {
      ctx.strokeStyle = 'rgba(255,60,60,0.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(mast.x - 20, mast.y + 8); ctx.lineTo(WOK.x + 10, WOK.y + 20); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (readout.browning != null) {
      ctx.fillStyle = 'rgba(120,180,255,0.07)';
      ctx.beginPath(); ctx.moveTo(mast.x - 20, mast.y + 5); ctx.lineTo(WOK.x - 110, WOK.y + 10); ctx.lineTo(WOK.x + 100, WOK.y + 10); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = ink; ctx.font = '600 12px ui-monospace, monospace'; ctx.textAlign = 'left';
    ctx.fillText(readout.temp != null ? `${readout.temp.toFixed(0)} °C` : 'IR offline', mast.x - 22, mast.y - 18);

    // Arm
    this.drawArm(ctx, { ink, steel, steelDark, accent });

    // Action caption
    ctx.textAlign = 'left';
    ctx.fillStyle = muted;
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.fillText(this.caption ?? '', 16, 26);
  }

  drawArm(ctx, c) {
    const sh = SHOULDER;
    // Pedestal
    ctx.fillStyle = c.steelDark;
    ctx.fillRect(sh.x - 26, sh.y, 52, COUNTER - sh.y);
    ctx.fillRect(sh.x - 44, COUNTER - 12, 88, 12);
    const link = (a, b, w) => {
      ctx.strokeStyle = c.steel; ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    };
    link(sh, this.elbow, 22);
    link(this.elbow, this.wrist, 16);
    // Spatula
    ctx.strokeStyle = c.ink; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(this.wrist.x, this.wrist.y); ctx.lineTo(this.tip.x, this.tip.y); ctx.stroke();
    ctx.save();
    ctx.translate(this.tip.x, this.tip.y);
    ctx.rotate(this.tip.a - Math.PI / 2);
    ctx.fillStyle = c.ink;
    ctx.fillRect(-13, -2, 26, 5);
    if (this.carry) {
      ctx.fillStyle = this.carry;
      ctx.beginPath(); ctx.ellipse(0, -6, 11, 5, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    for (const j of [sh, this.elbow, this.wrist]) {
      ctx.fillStyle = c.steelDark; ctx.beginPath(); ctx.arc(j.x, j.y, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = c.accent; ctx.beginPath(); ctx.arc(j.x, j.y, 4, 0, Math.PI * 2); ctx.fill();
    }
  }
}
