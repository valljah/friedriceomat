// 3D view of the robot cell, rendered with the small WebGL renderer in
// gl3d.js. Same interface as the 2D ArmView in arm.js so main.js can use
// either: setPlan, reset, startAction, update, draw, resize, readout, caption.

import { ACTIONS } from './sim.js';
import { ARM, forwardKinematics, fromCyl, inverseKinematics, makePath, pathDistance, samplePath } from './kinematics.js';
import { Renderer, geometry, mat4, rgb } from './gl3d.js';

const DEG = Math.PI / 180;
const DOWN = -Math.PI / 2;

// Cell layout (metres, counter top at y = 0, arm base at the origin).
const WOK = { x: 0.56, z: 0, bottom: 0.085, depth: 0.09, r: 0.2 };
const STOVE_TOP = 0.07;
const BOWL_RING = 0.55;
const PLATE_YAW = -60 * DEG;
const PLATE = { x: 0.55 * Math.cos(PLATE_YAW), z: -0.55 * Math.sin(PLATE_YAW) };
const MAST = { base: [0.82, 0, -0.32], top: [0.82, 0.85, -0.32], head: [0.6, 0.82, -0.05] };
const KNOB = [0.7, 0.035, 0.235];
const HOME = { yaw: 0, r: 0.5, y: 0.36, p: DOWN };

const VIEWS = {
  overview: { target: [0.2, 0.15, 0], az: 70 * DEG, el: 28 * DEG, dist: 1.7 },
  wok: { target: [0.56, 0.12, 0], az: 60 * DEG, el: 42 * DEG, dist: 0.9 },
  top: { target: [0.15, 0, 0.05], az: 90 * DEG, el: 86 * DEG, dist: 2.3 },
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const wokSurface = (d) => WOK.bottom + WOK.depth * (d / WOK.r) ** 2;

function mixColor(a, b, t) {
  const ca = rgb(a);
  const cb = rgb(b);
  return [lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t)];
}

function riceColor(s) {
  if (s.browning > 0.6 || s.burn > 0.05) return mixColor('#d9a441', '#2a1a10', clamp01((s.browning - 0.6) * 1.5 + s.burn * 3));
  return mixColor('#f7f3e8', '#d9a441', clamp01(s.browning * 1.6));
}

export class ArmView3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = new Renderer(canvas);
    const g = this.gl;
    this.mesh = {
      box: g.mesh(geometry.box()),
      cyl: g.mesh(geometry.cylinder(1, 1, 28)),
      cylLow: g.mesh(geometry.cylinder(1, 1, 12)),
      cone: g.mesh(geometry.cylinder(0, 1, 12, false)),
      sphere: g.mesh(geometry.sphere(16, 12)),
      grain: g.mesh(geometry.sphere(6, 4)),
      torus: g.mesh(geometry.torus(0.06, 32, 6)),
      quad: g.mesh(geometry.quad()),
      wok: g.mesh(geometry.lathe(
        [...Array.from({ length: 13 }, (_, i) => [WOK.r * (i / 12), wokSurface(WOK.r * (i / 12))]), [WOK.r + 0.012, WOK.bottom + WOK.depth + 0.004]],
        48,
      )),
      bowl: g.mesh(geometry.lathe([[0, 0.002], [0.035, 0.004], [0.055, 0.02], [0.062, 0.045], [0.06, 0.05]], 32)),
    };

    this.stages = [];
    this.bowls = [];
    this.path = makePath([HOME]);
    this.c = { ...HOME };
    this.lastDist = 0;
    this.joints = inverseKinematics(fromCyl(this.c), this.c.p);
    this.action = null;
    this.carry = null;
    this.particles = [];
    this.puffs = [];
    this.plateFill = 0;
    this.shake = 0;
    this.time = 0;
    this.caption = '';
    this.lastFrame = performance.now();

    this.cam = { ...VIEWS.overview, target: [...VIEWS.overview.target] };
    this.goal = { ...VIEWS.overview, target: [...VIEWS.overview.target] };
    this.autoOrbit = false;

    this.buildOverlay();
    this.bindControls();
    this.resize();
  }

  // ------------------------------------------------------------ overlay --

  buildOverlay() {
    const wrap = this.canvas.parentElement;
    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      return n;
    };
    this.overlay = el('div', 'cell-overlay');
    this.captionEl = el('div', 'cell-caption');
    this.irEl = el('div', 'cell-label ir');
    this.labelLayer = el('div', 'cell-labels');
    const tools = el('div', 'cell-tools');
    const views = [['overview', 'Overview'], ['wok', 'Wok'], ['top', 'Top']];
    for (const [id, label] of views) {
      const b = el('button', 'small', label);
      b.type = 'button';
      b.addEventListener('click', () => this.setView(id));
      tools.append(b);
    }
    this.orbitBtn = el('button', 'small', 'Orbit');
    this.orbitBtn.type = 'button';
    this.orbitBtn.setAttribute('aria-pressed', 'false');
    this.orbitBtn.addEventListener('click', () => {
      this.autoOrbit = !this.autoOrbit;
      this.orbitBtn.setAttribute('aria-pressed', String(this.autoOrbit));
    });
    tools.append(this.orbitBtn);
    this.overlay.append(this.labelLayer, this.captionEl, this.irEl);
    wrap.append(this.overlay, tools);
  }

  setView(id) {
    const v = VIEWS[id];
    this.goal = { ...v, target: [...v.target] };
    // Take the short way round when animating the azimuth.
    while (this.goal.az - this.cam.az > Math.PI) this.goal.az -= 2 * Math.PI;
    while (this.goal.az - this.cam.az < -Math.PI) this.goal.az += 2 * Math.PI;
  }

  bindControls() {
    const cv = this.canvas;
    const pointers = new Map();
    let pinch = null;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: this.goal.dist };
      }
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        this.goal.dist = Math.min(4, Math.max(0.5, pinch.dist * (pinch.d / d)));
        return;
      }
      if (p.pan) this.pan(dx, dy);
      else {
        this.goal.az += dx * 0.008;
        this.goal.el = Math.min(88 * DEG, Math.max(4 * DEG, this.goal.el + dy * 0.006));
      }
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.goal.dist = Math.min(4, Math.max(0.5, this.goal.dist * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
    cv.addEventListener('dblclick', () => this.setView('overview'));
  }

  pan(dx, dy) {
    const { az, el } = this.goal;
    const o = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    const rl = Math.hypot(o[2], o[0]) || 1;
    const right = [o[2] / rl, 0, -o[0] / rl];
    // Camera up = right × forward, with forward = −o.
    const up = [
      -(right[1] * o[2] - right[2] * o[1]),
      -(right[2] * o[0] - right[0] * o[2]),
      -(right[0] * o[1] - right[1] * o[0]),
    ];
    const s = this.goal.dist * 0.0012;
    const t = this.goal.target;
    for (let i = 0; i < 3; i++) t[i] += -right[i] * dx * s + up[i] * dy * s;
    t[0] = Math.min(1.2, Math.max(-0.8, t[0]));
    t[1] = Math.min(0.8, Math.max(-0.1, t[1]));
    t[2] = Math.min(0.9, Math.max(-0.9, t[2]));
  }

  resize() {
    this.size = this.gl.resize();
  }

  // -------------------------------------------------------------- plan --

  setPlan(plan) {
    this.stages = plan.stages;
    const n = this.stages.length;
    const span = n > 1 ? Math.min(200, Math.max(110, (n - 1) * 22)) : 0;
    const step = n > 1 ? span / (n - 1) : 60;
    const size = Math.min(1, (BOWL_RING * Math.sin((step * DEG) / 2) * 0.85) / 0.06);
    this.bowls = this.stages.map((st, i) => {
      const yaw = (50 + (n > 1 ? (span * i) / (n - 1) : 0)) * DEG;
      return {
        yaw,
        x: BOWL_RING * Math.cos(yaw),
        z: -BOWL_RING * Math.sin(yaw),
        size,
        color: rgb(st.color),
        label: st.label,
        full: true,
      };
    });
    this.labelLayer.replaceChildren(...this.bowls.map((b) => {
      const span = document.createElement('span');
      span.className = 'cell-label';
      span.textContent = b.label;
      b.el = span;
      return span;
    }));
    this.reset();
  }

  reset() {
    this.particles = [];
    this.puffs = [];
    this.plateFill = 0;
    this.carry = null;
    this.action = null;
    this.path = makePath([{ ...this.c }, HOME]);
    this.lastDist = 0;
    for (const b of this.bowls) b.full = true;
  }

  // ----------------------------------------------------------- motion --

  startAction(a, sim) {
    const name = ACTIONS[a];
    this.action = name;
    const from = { ...this.c };
    let pts;
    if (name === 'ADD') {
      const b = this.bowls[sim.s.next];
      this.addIndex = sim.s.next;
      pts = [
        from,
        { yaw: b.yaw, r: BOWL_RING, y: 0.3, p: DOWN },
        { yaw: b.yaw, r: BOWL_RING, y: 0.02 + 0.03 * b.size, p: DOWN + 0.2, grab: true },
        { yaw: b.yaw, r: BOWL_RING - 0.03, y: 0.3, p: DOWN - 0.3 },
        { yaw: 0, r: 0.47, y: 0.32, p: DOWN - 0.3 },
        { yaw: 0, r: 0.5, y: 0.26, p: -0.45, pour: true },
        { ...HOME },
      ];
    } else if (name === 'STIR') {
      pts = [from];
      for (let k = 0; k <= 6; k++) {
        const s = k % 2 ? 1 : -1;
        pts.push({ yaw: 0.12 * s, r: WOK.x + 0.07 * s, y: 0.125, p: DOWN + 0.3 * s });
      }
      pts.push({ ...HOME });
    } else if (name === 'TOSS') {
      const scoop = { yaw: 0, r: 0.46, y: 0.13, p: DOWN - 0.5 };
      const flick = { yaw: 0, r: 0.62, y: 0.33, p: -0.6, flick: true };
      pts = [from, scoop, flick, { ...scoop }, { ...flick }, { ...HOME }];
    } else if (name === 'PLATE') {
      pts = [from];
      for (let k = 0; k < 2; k++) {
        pts.push(
          { yaw: 0, r: 0.48, y: 0.13, p: DOWN - 0.4 },
          { yaw: 0, r: 0.47, y: 0.34, p: DOWN - 0.4 },
          { yaw: PLATE_YAW, r: 0.5, y: 0.24, p: DOWN - 0.4 },
          { yaw: PLATE_YAW, r: 0.55, y: 0.1, p: -0.5, serve: true },
        );
      }
      pts.push({ yaw: PLATE_YAW / 2, r: 0.45, y: 0.34, p: DOWN });
    } else {
      // Burner changes are electronic: the arm only gives a small nod.
      pts = [from, { ...from, y: from.y + 0.015 }, { ...HOME }];
    }
    this.path = makePath(pts);
    this.lastDist = 0;
  }

  // Advances the arm along the current path; progress is 0..1 of the action.
  update(progress, sim) {
    const d = pathDistance(this.path, progress);
    const { pts, len } = this.path;
    for (let k = 1; k < pts.length; k++) {
      if (!(len[k] <= d && len[k] > this.lastDist)) continue;
      const p = pts[k];
      if (p.grab && this.bowls[this.addIndex]) {
        this.carry = this.bowls[this.addIndex].color;
        this.bowls[this.addIndex].full = false;
      }
      if (p.pour) this.carry = null;
      if (p.flick) this.flick(sim);
      if (p.serve) this.plateFill = Math.min(1, this.plateFill + 0.5);
    }
    this.lastDist = d;
    this.c = samplePath(this.path, progress);
    this.joints = inverseKinematics(fromCyl(this.c), this.c.p, ARM, this.joints.yaw);
  }

  flick(sim) {
    this.shake = 1;
    const toss = sim.cfg.tossIntensity;
    for (const p of this.particles) {
      if (Math.random() < 0.4 + 0.5 * toss) {
        p.air = true;
        p.vy = (0.7 + Math.random() * 0.8) * (0.5 + toss);
        p.vx = (Math.random() - 0.5) * 0.3 - 0.15;
        p.vz = (Math.random() - 0.5) * 0.3;
      }
    }
  }

  readout() {
    const deg = (r) => `${Math.round(r / DEG)}°`;
    const j = this.joints;
    const tip = forwardKinematics(j).tip;
    const cm = (v) => (v * 100).toFixed(0);
    return [
      ['Base', deg(j.yaw)], ['Shoulder', deg(j.q1)], ['Elbow', deg(j.q2)], ['Wrist', deg(j.q3)],
      ['Tool (cm)', `${cm(tip.x)}, ${cm(tip.y)}, ${cm(tip.z)}`],
    ];
  }

  // -------------------------------------------------------- particles --

  syncFood(sim) {
    const target = Math.min(260, Math.round(sim.s.mass / 2));
    if (this.particles.length < target) {
      const added = sim.plan.stages.filter((_, i) => sim.s.added[i]);
      const total = added.reduce((a, st) => a + st.grams, 0);
      while (added.length && this.particles.length < target) {
        let u = Math.random() * total;
        let st = added[added.length - 1];
        for (const s of added) { u -= s.grams; if (u <= 0) { st = s; break; } }
        const rho = Math.sqrt(Math.random()) * 0.78;
        const ang = Math.random() * Math.PI * 2;
        const p = {
          rho, ang, layer: Math.random(),
          rice: st.category === 'rice',
          visible: st.category !== 'fat',
          color: rgb(st.color),
          spin: Math.random() * Math.PI,
          air: true, vx: 0, vy: 0, vz: 0,
        };
        const rest = this.restPos(p);
        p.x = rest[0];
        p.y = rest[1] + 0.25;
        p.z = rest[2];
        this.particles.push(p);
      }
    }
    if (this.particles.length > target) this.particles.length = target;
  }

  restPos(p) {
    const d = p.rho * WOK.r;
    return [WOK.x + Math.cos(p.ang) * d, wokSurface(d) + 0.006 + p.layer * 0.012, WOK.z + Math.sin(p.ang) * d];
  }

  stepParticles(sim, dt) {
    this.syncFood(sim);
    const s = sim.s;
    for (const p of this.particles) {
      if (this.action === 'STIR' && Math.random() < dt * 3) {
        p.ang += (Math.random() - 0.5) * 0.6;
        p.rho = Math.min(0.78, Math.max(0, p.rho + (Math.random() - 0.5) * 0.1));
      }
      const rest = this.restPos(p);
      if (p.air) {
        p.vy -= 9.8 * dt;
        p.x += p.vx * dt + (rest[0] - p.x) * Math.min(1, dt * 3);
        p.z += p.vz * dt + (rest[2] - p.z) * Math.min(1, dt * 3);
        p.y += p.vy * dt;
        if (p.vy < 0 && p.y <= rest[1]) { p.air = false; p.y = rest[1]; }
      } else {
        const jig = s.agitation * 0.004;
        p.x = lerp(p.x, rest[0] + (Math.random() - 0.5) * jig, 0.25);
        p.y = lerp(p.y, rest[1], 0.3);
        p.z = lerp(p.z, rest[2] + (Math.random() - 0.5) * jig, 0.25);
      }
    }
    const steam = s.mass > 0 && s.T > 105 ? (s.moisture * (s.T - 100)) / 100 : 0;
    const smoke = Math.min(1, s.burn * 3 + Math.max(0, s.T - 270) / 60);
    const spawn = (isSmoke) => this.puffs.push({
      x: WOK.x + (Math.random() - 0.5) * 0.25, y: WOK.bottom + WOK.depth * 0.6, z: WOK.z + (Math.random() - 0.5) * 0.25,
      life: 1, smoke: isSmoke, seed: Math.random() * 10,
    });
    if (this.puffs.length < 80 && Math.random() < steam * dt * 20) spawn(false);
    if (this.puffs.length < 80 && Math.random() < smoke * dt * 20) spawn(true);
    for (const f of this.puffs) {
      f.y += 0.12 * dt;
      f.x += Math.sin(this.time * 1.7 + f.seed) * 0.02 * dt;
      f.life -= dt * 0.45;
    }
    this.puffs = this.puffs.filter((f) => f.life > 0);
    this.shake = Math.max(0, this.shake - dt * 3);
  }

  // ------------------------------------------------------------- draw --

  theme() {
    const css = getComputedStyle(this.canvas);
    const v = (n, fb) => css.getPropertyValue(n).trim() || fb;
    const bg = rgb(v('--panel-2', '#232321'));
    const dark = bg[0] * 0.3 + bg[1] * 0.59 + bg[2] * 0.11 < 0.5;
    return {
      bg,
      dark,
      steel: rgb(v('--steel', '#6d7480')),
      steelDark: rgb(v('--steel-dark', '#3c424c')),
      counter: rgb(v('--counter', '#24272c')),
      accent: rgb(v('--accent', '#ff7a1a')),
    };
  }

  // readout: the sensor readings to show in the scene (IR beam, camera cone).
  draw(sim, readout) {
    this.readings = readout;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.time += dt;
    this.size = this.gl.resize();
    const th = this.theme();
    const s = sim.s;

    // Camera (eased towards the goal set by drags / view buttons)
    if (this.autoOrbit) this.goal.az += dt * 0.25;
    const k = Math.min(1, dt * 8);
    for (const key of ['az', 'el', 'dist']) this.cam[key] = lerp(this.cam[key], this.goal[key], k);
    for (let i = 0; i < 3; i++) this.cam.target[i] = lerp(this.cam.target[i], this.goal.target[i], k);
    const { az, el, dist, target } = this.cam;
    const eye = [
      target[0] + dist * Math.cos(el) * Math.cos(az),
      target[1] + dist * Math.sin(el),
      target[2] + dist * Math.cos(el) * Math.sin(az),
    ];
    const view = mat4.lookAt(eye, target, [0, 1, 0]);
    const proj = mat4.perspective(40 * DEG, this.size.width / Math.max(1, this.size.height), 0.02, 20);
    this.viewProj = mat4.multiply(proj, view);
    this.view = view;

    this.stepParticles(sim, dt);

    const g = this.gl;
    const M = this.mesh;
    const T = mat4.translation;
    const S = mat4.scaling;
    const mul = mat4.mul;
    const steel = { color: th.steel, shininess: 40 };
    const steelDark = { color: th.steelDark, shininess: 20 };
    const accent = { color: th.accent, emissive: th.accent.map((c) => c * 0.25), shininess: 20 };

    // Counter
    g.draw(M.box, mul(T(0.15, -0.03, 0), S(2.6, 0.06, 1.6)), { color: th.counter });

    // Bowls on their arc
    this.bowls.forEach((b, i) => {
      const base = mul(T(b.x, 0, b.z), S(b.size));
      g.draw(M.bowl, base, { color: th.steelDark.map((c) => c * 1.3), shininess: 30 });
      if (b.full && !s.added[i]) g.draw(M.cylLow, mul(base, T(0, 0.036, 0), S(0.05, 0.01, 0.05)), { color: b.color });
      if (i === s.next && !s.plated) g.draw(M.torus, mul(base, T(0, 0.05, 0), S(0.064)), { color: th.accent, unlit: true });
    });

    // Stove, flames and knob
    g.draw(M.box, mul(T(WOK.x, STOVE_TOP / 2, WOK.z), S(0.5, STOVE_TOP, 0.45)), steelDark);
    const burner = s.burner;
    if (burner > 0.01) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const flick = 0.8 + 0.2 * Math.sin(this.time * 18 + i * 1.7);
        // Flames stay below the wok: at r = 0.1 its underside is ~3.7 cm above the stove.
        const h = (0.008 + 0.024 * burner) * flick;
        const x = WOK.x + Math.cos(a) * 0.1;
        const z = WOK.z + Math.sin(a) * 0.1;
        g.draw(M.cone, mul(T(x, STOVE_TOP + h / 2, z), S(0.014, h, 0.014)), { color: [1, 0.55, 0.15], unlit: true, opacity: 0.75 });
        g.draw(M.cone, mul(T(x, STOVE_TOP + h * 0.25, z), S(0.009, h * 0.5, 0.009)), { color: [0.3, 0.55, 1], unlit: true, opacity: 0.85 });
      }
    }
    g.draw(M.cyl, mul(T(...KNOB), mat4.rotX(Math.PI / 2), S(0.02, 0.02, 0.02)), steel);
    g.draw(M.box, mul(T(KNOB[0], KNOB[1], KNOB[2] + 0.012), mat4.rotZ(0.75 * Math.PI - burner * 1.5 * Math.PI), T(0, 0.009, 0), S(0.004, 0.018, 0.004)), accent);

    // Wok (heat-tinted), shaken on tosses
    const shake = T(Math.sin(this.time * 60) * this.shake * 0.006, this.shake * 0.01, 0);
    const heat = clamp01((s.T - 180) / 180);
    g.draw(M.wok, mul(shake, T(WOK.x, 0, WOK.z)), {
      color: mixColor('#2e3136', '#4a2a1c', heat * 0.35), emissive: [0.22 * heat, 0.05 * heat, 0.01 * heat], shininess: 30,
    });
    const rimY = WOK.bottom + WOK.depth;
    g.draw(M.cylLow, mul(shake, mat4.alignY([WOK.x + WOK.r, rimY, WOK.z], [WOK.x + WOK.r + 0.22, rimY + 0.05, WOK.z], 0.012)), steelDark);
    g.draw(M.cylLow, mul(shake, mat4.alignY([WOK.x + WOK.r + 0.12, rimY + 0.027, WOK.z], [WOK.x + WOK.r + 0.24, rimY + 0.055, WOK.z], 0.016)), { color: [0.42, 0.27, 0.16] });

    // Food in the wok
    const rice = riceColor(s);
    let visible = 0;
    for (const p of this.particles) {
      if (!p.visible) continue;
      visible++;
      const sc = p.rice ? S(0.009, 0.005, 0.005) : S(0.008);
      g.draw(M.grain, mul(shake, T(p.x, p.y, p.z), mat4.rotY(p.spin), sc), { color: p.rice ? rice : p.color, shininess: p.rice ? 0 : 10 });
    }
    if (s.mass > 0 && visible === 0) {
      g.draw(M.cylLow, mul(shake, T(WOK.x, wokSurface(0.05) + 0.002, WOK.z), S(0.1, 0.002, 0.1)), { color: [0.95, 0.79, 0.3], opacity: 0.6, shininess: 60 });
    }

    // Plate
    g.draw(M.cyl, mul(T(PLATE.x, 0.006, PLATE.z), S(0.12, 0.012, 0.12)), { color: [0.92, 0.91, 0.88], shininess: 40 });
    if (this.plateFill > 0) {
      g.draw(M.sphere, mul(T(PLATE.x, 0.012, PLATE.z), S(0.085 * this.plateFill, 0.04 * this.plateFill, 0.085 * this.plateFill)), { color: rice });
    }

    // Sensor mast: IR beam (when the thermometer is on) and camera cone
    g.draw(M.cylLow, mat4.alignY(MAST.base, MAST.top, 0.015), steelDark);
    g.draw(M.cylLow, mat4.alignY(MAST.top, [MAST.head[0], MAST.top[1], MAST.head[2]], 0.012), steelDark);
    g.draw(M.box, mul(T(...MAST.head), S(0.08, 0.05, 0.06)), steel);
    const food = [WOK.x, WOK.bottom + 0.02, WOK.z];
    if (this.readings?.temp != null) g.draw(M.cylLow, mat4.alignY(MAST.head, food, 0.0025), { color: [1, 0.2, 0.2], unlit: true, opacity: 0.55 });
    if (this.readings?.browning != null) g.draw(M.cone, mat4.alignY(food, MAST.head, 0.24), { color: [0.5, 0.7, 1], unlit: true, opacity: 0.03 });

    // Arm
    this.drawArm(th, { steel, steelDark, accent });

    // Steam and smoke billboards
    const V = this.view;
    const right = [V[0], V[4], V[8]];
    const up = [V[1], V[5], V[9]];
    const fwd = [V[2], V[6], V[10]];
    for (const f of this.puffs) {
      const sz = 0.05 + (1 - f.life) * 0.12;
      const m = new Float32Array([
        right[0] * sz, right[1] * sz, right[2] * sz, 0,
        up[0] * sz, up[1] * sz, up[2] * sz, 0,
        fwd[0], fwd[1], fwd[2], 0,
        f.x, f.y, f.z, 1,
      ]);
      g.draw(M.quad, m, f.smoke
        ? { color: [0.22, 0.22, 0.22], unlit: true, disc: true, opacity: f.life * 0.55 }
        : { color: th.dark ? [0.85, 0.88, 0.9] : [1, 1, 1], unlit: true, disc: true, opacity: f.life * 0.3 });
    }

    const lum = th.dark ? 1 : 0.9;
    g.render({
      viewProj: this.viewProj,
      camPos: eye,
      background: th.bg,
      lightDir: [0.4, 1, 0.6],
      lightColor: [0.75 * lum, 0.73 * lum, 0.68 * lum],
      sky: th.dark ? [0.33, 0.35, 0.4] : [0.42, 0.44, 0.48],
      ground: th.dark ? [0.1, 0.09, 0.08] : [0.3, 0.28, 0.26],
      pointPos: [WOK.x, STOVE_TOP + 0.01, WOK.z],
      pointColor: [1.4 * burner, 0.6 * burner, 0.15 * burner],
    });

    this.drawLabels(sim);
  }

  drawArm(th, mats) {
    const g = this.gl;
    const M = this.mesh;
    const T = mat4.translation;
    const S = mat4.scaling;
    const mul = mat4.mul;
    const { yaw, q1, q2, q3 } = this.joints;
    const { steel, steelDark, accent } = mats;

    g.draw(M.cyl, mul(T(0, 0.15, 0), S(0.085, 0.3, 0.085)), steelDark);
    g.draw(M.cyl, mul(T(0, 0.012, 0), S(0.13, 0.024, 0.13)), steelDark);
    const base = mul(T(0, 0, 0), mat4.rotY(yaw));
    g.draw(M.cyl, mul(base, T(0, 0.325, 0), S(0.1, 0.05, 0.1)), steel);
    g.draw(M.box, mul(base, T(0.095, 0.325, 0), S(0.02, 0.03, 0.03)), accent);

    const joint = (frame, r, w) => {
      g.draw(M.cyl, mul(frame, mat4.rotX(Math.PI / 2), S(r, w, r)), steelDark);
      g.draw(M.cyl, mul(frame, mat4.rotX(Math.PI / 2), S(r * 0.45, w + 0.01, r * 0.45)), accent);
    };
    const shoulder = mul(base, T(0, ARM.shoulderH, 0), mat4.rotZ(q1));
    g.draw(M.box, mul(shoulder, T(ARM.l1 / 2, 0, 0), S(ARM.l1, 0.07, 0.06)), steel);
    joint(shoulder, 0.065, 0.11);
    const elbow = mul(shoulder, T(ARM.l1, 0, 0), mat4.rotZ(q2));
    g.draw(M.box, mul(elbow, T(ARM.l2 / 2, 0, 0), S(ARM.l2, 0.055, 0.05)), steel);
    joint(elbow, 0.05, 0.09);
    const wrist = mul(elbow, T(ARM.l2, 0, 0), mat4.rotZ(q3));
    joint(wrist, 0.038, 0.075);
    // Tool: shaft along the wrist's x axis, spatula blade at the end.
    g.draw(M.cylLow, mul(wrist, T(ARM.tool / 2, 0, 0), mat4.rotZ(-Math.PI / 2), S(0.008, ARM.tool, 0.008)), { color: [0.85, 0.85, 0.82], shininess: 60 });
    g.draw(M.box, mul(wrist, T(ARM.tool - 0.02, 0, 0), S(0.06, 0.004, 0.07)), { color: [0.85, 0.85, 0.82], shininess: 60 });
    if (this.carry) g.draw(M.sphere, mul(wrist, T(ARM.tool - 0.015, 0.012, 0), S(0.028, 0.016, 0.028)), { color: this.carry });
  }

  // HTML labels anchored to 3D points.
  drawLabels(sim) {
    const project = (p) => {
      const c = mat4.transformPoint(this.viewProj, p);
      if (c[3] <= 0 || Math.abs(c[0]) > 1.2 || Math.abs(c[1]) > 1.2) return null;
      return [(c[0] * 0.5 + 0.5) * this.size.width, (0.5 - c[1] * 0.5) * this.size.height];
    };
    const place = (node, p) => {
      const xy = project(p);
      node.hidden = !xy;
      if (xy) node.style.transform = `translate(${xy[0].toFixed(1)}px, ${xy[1].toFixed(1)}px) translate(-50%, 0)`;
    };
    this.bowls.forEach((b, i) => {
      const out = 0.06 * b.size + 0.03;
      place(b.el, [b.x + Math.cos(b.yaw) * out, 0, b.z - Math.sin(b.yaw) * out]);
      b.el.classList.toggle('next', i === sim.s.next && !sim.s.plated);
      b.el.classList.toggle('done', !!sim.s.added[i]);
    });
    const r = this.readings ?? {};
    this.irEl.textContent = r.temp != null ? `IR ${r.temp.toFixed(0)} °C` : 'IR offline';
    place(this.irEl, [MAST.head[0], MAST.head[1] + 0.05, MAST.head[2]]);
    this.irEl.style.transform += ' translate(0, -100%)';
    this.captionEl.textContent = this.caption ?? '';
  }
}
