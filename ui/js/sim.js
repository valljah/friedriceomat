// Wok + robot kitchen simulator.
//
// A deliberately simple physical model: burner heats the wok, food mass soaks
// up heat, water evaporates above 100 °C, dry food browns above 140 °C and
// burns above ~255 °C unless it is moving. The arm can stir, toss, add the
// next ingredient or plate. The same model is used for live visualisation and
// for headless RL training.

export const ACTIONS = ['HEAT_UP', 'HEAT_DOWN', 'STIR', 'TOSS', 'ADD', 'PLATE'];
export const A = Object.fromEntries(ACTIONS.map((name, i) => [name, i]));
export const ACTION_LABELS = {
  HEAT_UP: 'Heat +', HEAT_DOWN: 'Heat −', STIR: 'Stir', TOSS: 'Toss', ADD: 'Add next', PLATE: 'Plate',
};

export const DEFAULT_ENV = {
  burnerPower: 1.0,    // stove strength multiplier
  maxBurner: 1.0,      // burner limit (0..1)
  riceMoisture: 0.55,  // 0.45 = dry day-old rice, 0.7 = fresh rice
  ambient: 25,
  armSpeed: 1.0,
  tossIntensity: 0.6,
  stirVigor: 0.7,
  maxTime: 420,        // seconds before the dish is force-plated
  randomize: true,     // domain randomisation per episode
};

export const DEFAULT_SENSORS = {
  thermal: true,  // IR thermometer -> wok temperature
  camera: true,   // RGB camera -> browning, clumping, mixing
  steam: true,    // humidity sensor -> grain moisture
  voc: true,      // gas sensor -> smoke / burning
  load: true,     // load cell -> food mass
  noise: 1.0,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng) {
  const u = Math.max(rng(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export class WokSim {
  constructor(plan, env = DEFAULT_ENV, rng = Math.random) {
    this.plan = plan;
    this.cfg = { ...DEFAULT_ENV, ...env };
    this.rng = rng;
    this.reset();
  }

  reset() {
    const { cfg, rng } = this;
    const jitter = (v, amt) => (cfg.randomize ? v * (1 + (rng() * 2 - 1) * amt) : v);
    this.episode = {
      burnerPower: jitter(cfg.burnerPower, 0.15),
      riceMoisture: clamp(jitter(cfg.riceMoisture, 0.12), 0.35, 0.8),
      ambient: cfg.ambient,
    };
    this.s = {
      t: 0,
      T: this.episode.ambient,
      burner: 0,
      mass: 0,
      moisture: 0,
      browning: 0,
      burn: 0,
      mix: 1,
      clump: 0,
      wokHei: 0,
      agitation: 0,
      next: 0,
      cooked: this.plan.stages.map(() => 0),
      added: this.plan.stages.map(() => false),
      lastAdded: -1,
      spills: 0,
      overheat: 0,
      plated: false,
      plateFill: 0,
    };
    return this.s;
  }

  get pending() { return this.plan.stages.length - this.s.next; }
  get done() { return this.s.plated; }
  get target() {
    const st = this.plan.stages[this.s.next];
    return st ? st.targetTemp : this.plan.finishTemp;
  }

  actionMask() {
    const pending = this.pending > 0;
    return ACTIONS.map((name) => {
      if (name === 'ADD') return pending;
      if (name === 'PLATE') return !pending;
      if (name === 'HEAT_UP') return this.s.burner < this.cfg.maxBurner - 1e-6;
      if (name === 'HEAT_DOWN') return this.s.burner > 1e-6;
      return true;
    });
  }

  actionDuration(a) {
    const speed = this.cfg.armSpeed;
    switch (ACTIONS[a]) {
      case 'HEAT_UP':
      case 'HEAT_DOWN': return 0.6;
      case 'STIR': return 1.6 / Math.sqrt(speed);
      case 'TOSS': return 1.4 / Math.sqrt(speed);
      case 'ADD': return 3.2 / speed;
      case 'PLATE': return 4.5 / speed;
      default: return 0.5;
    }
  }

  // Instant effects when an action starts.
  startAction(a) {
    const s = this.s;
    const step = 0.15;
    if (ACTIONS[a] === 'HEAT_UP') s.burner = clamp(s.burner + step, 0, this.cfg.maxBurner);
    if (ACTIONS[a] === 'HEAT_DOWN') s.burner = clamp(s.burner - step, 0, this.cfg.maxBurner);
  }

  // Effects at the end of an action (the ingredient lands in the wok when the
  // arm pours, the dish is done once it is on the plate).
  finishAction(a) {
    const s = this.s;
    if (ACTIONS[a] === 'ADD' && this.pending > 0) this.addIngredient(s.next);
    if (ACTIONS[a] === 'PLATE') { s.plated = true; s.plateFill = 1; }
  }

  addIngredient(i) {
    const s = this.s;
    const st = this.plan.stages[i];
    const water = st.category === 'rice' ? this.episode.riceMoisture : st.water;
    const prev = s.mass;
    s.mass += st.grams;
    s.moisture = (s.moisture * prev + water * st.grams) / Math.max(s.mass, 1);
    s.browning = (s.browning * prev) / Math.max(s.mass, 1);
    s.mix = prev > 0 ? (s.mix * prev) / s.mass : 1;
    if (st.category === 'rice') s.clump = Math.max(s.clump, 0.55 + (0.7 - this.episode.riceMoisture) * 0.8);
    // Cold food pulls heat out of the wok.
    s.T -= (s.T - this.episode.ambient) * (st.grams / (s.mass + 120)) * 0.6;
    s.added[i] = true;
    s.lastAdded = i;
    s.next = i + 1;
  }

  // Advance physics by dt seconds while `a` (or null) is being executed.
  physics(dt, a) {
    const s = this.s;
    const name = a == null ? null : ACTIONS[a];
    const vigor = this.cfg.stirVigor;
    const toss = this.cfg.tossIntensity;
    s.t += dt;

    if (name === 'STIR') s.agitation = Math.max(s.agitation, 0.4 + 0.5 * vigor);
    else if (name === 'TOSS') s.agitation = Math.max(s.agitation, 0.6 + 0.4 * toss);
    else s.agitation *= Math.exp(-dt / 1.5);

    const thermalMass = 1 + s.mass / 120;
    const heatIn = s.burner * this.episode.burnerPower * 30;
    const loss = 0.08 * (s.T - this.episode.ambient);
    let evapCool = 0;
    if (s.mass > 0 && s.T > 100 && s.moisture > 0) {
      const ev = 0.0045 * ((s.T - 100) / 100) * (0.5 + s.agitation) * s.moisture * dt;
      s.moisture = Math.max(0, s.moisture - ev);
      evapCool = ev * 900;
    }
    const tossCool = name === 'TOSS' ? 2.5 * toss : 0;
    s.T += ((heatIn - loss) / thermalMass - tossCool) * dt - evapCool / thermalMass;
    s.T = Math.max(this.episode.ambient, s.T);

    if (s.mass > 0) {
      if (s.T > 140) {
        const contact = 1.2 - 0.4 * s.agitation;
        s.browning = clamp01(s.browning + 0.009 * ((s.T - 140) / 100) * Math.pow(1 - s.moisture, 1.5) * contact * dt);
      }
      if (s.T > 255) {
        const b = 0.012 * ((s.T - 255) / 50) * (1.3 - s.agitation) * dt;
        s.burn = clamp01(s.burn + b);
      }
      if (name === 'STIR') {
        s.mix = clamp01(s.mix + 0.07 * vigor * (1 - s.mix) * dt);
        s.clump = Math.max(0, s.clump - 0.06 * vigor * dt);
      }
      if (name === 'TOSS') {
        s.mix = clamp01(s.mix + 0.16 * toss * (1 - s.mix) * dt);
        s.clump = Math.max(0, s.clump - 0.09 * toss * dt);
        if (s.T > 205) s.wokHei = clamp01(s.wokHei + 0.09 * ((s.T - 205) / 60) * toss * dt);
      }
    }
    if (s.T > 290) s.overheat += dt;

    for (let i = 0; i < s.added.length; i++) {
      if (s.added[i] && s.T > 120) s.cooked[i] += dt * clamp((s.T - 120) / 100, 0, 1.5);
    }
  }

  // Random spill chance at the end of a toss: aggressive tosses at high arm
  // speed throw rice out of the wok.
  maybeSpill(a) {
    if (ACTIONS[a] !== 'TOSS' || this.s.mass <= 0) return false;
    const p = 0.025 * Math.pow(this.cfg.tossIntensity, 2) * Math.pow(this.cfg.armSpeed, 2);
    if (this.rng() < p) {
      this.s.spills += 1;
      this.s.mass *= 0.96;
      return true;
    }
    return false;
  }

  lastCooked() {
    const s = this.s;
    if (s.lastAdded < 0) return 1;
    const st = this.plan.stages[s.lastAdded];
    return st.cook > 0 ? s.cooked[s.lastAdded] / st.cook : 1;
  }

  // Noisy sensor readings. Disabled sensors return null.
  readSensors(sensors = DEFAULT_SENSORS) {
    const s = this.s;
    const n = sensors.noise;
    const g = () => gaussian(this.rng) * n;
    return {
      temp: sensors.thermal ? s.T + g() * 5 : null,
      moisture: sensors.steam && s.mass > 0 ? clamp01(s.moisture + g() * 0.025) : null,
      browning: sensors.camera ? clamp01(s.browning + g() * 0.025) : null,
      clump: sensors.camera ? clamp01(s.clump + g() * 0.03) : null,
      mix: sensors.camera ? clamp01(s.mix + g() * 0.03) : null,
      smoke: sensors.voc ? clamp01(s.burn * 2 + Math.max(0, s.T - 270) / 100 + Math.abs(g()) * 0.01) : null,
      mass: sensors.load ? Math.max(0, s.mass + g() * 4) : null,
      // The robot knows what it added and when, so it tracks doneness itself.
      lastCooked: clamp(this.lastCooked() + g() * 0.05, 0, 2),
      burner: s.burner,
      pending: this.pending,
      t: s.t,
    };
  }
}

// Score the dish 0..100 plus component breakdown (each 0..1).
export function assessDish(sim) {
  const { s, plan } = sim;
  const tg = plan.targets;
  const riceIdx = plan.stages.findIndex((st) => st.category === 'rice');
  const hasRice = riceIdx >= 0 && s.added[riceIdx];
  const texture = hasRice ? clamp01(1 - Math.abs(s.moisture - tg.moisture) / 0.2) * (1 - 0.6 * clamp01(s.clump)) : 0;
  const color = hasRice ? clamp01(1 - Math.abs(s.browning - tg.browning) / 0.3) : 0;
  const wokHei = clamp01(s.wokHei / tg.wokHei);
  let doneness = 0;
  let raw = false;
  plan.stages.forEach((st, i) => {
    const f = st.cook > 0 ? clamp01(s.cooked[i] / st.cook) : 1;
    doneness += s.added[i] ? f : 0;
    if (st.category === 'protein' && s.added[i] && f < 0.8) raw = true;
  });
  doneness /= Math.max(1, plan.stages.length);
  if (raw) doneness *= 0.5;
  const mix = clamp01(s.mix);
  const completeness = s.added.filter(Boolean).length / Math.max(1, s.added.length);
  const burnt = clamp01(s.burn * 2);
  const base = 0.25 * texture + 0.2 * color + 0.15 * wokHei + 0.2 * doneness + 0.2 * mix;
  const score = clamp(100 * base * completeness * (1 - 0.8 * burnt) - 3 * s.spills, 0, 100);
  return { score, texture, color, wokHei, doneness, mix, completeness, burnt, raw, time: s.t };
}

export const DEFAULT_REWARD = { taste: 1, texture: 1, wokHei: 1, safety: 1, speed: 0.5 };

// Weighted dish quality in 0..1 according to the user's reward weights.
export function weightedQuality(q, w) {
  const sum = w.taste + w.texture + w.wokHei;
  if (sum <= 0) return 0;
  const v = (w.taste * (0.5 * q.doneness + 0.5 * q.mix)
    + w.texture * (0.6 * q.texture + 0.4 * q.color)
    + w.wokHei * q.wokHei) / sum;
  return v * q.completeness * (1 - 0.8 * q.burnt);
}

// Runs one action to completion (headless), returns the reward.
export function runAction(sim, a, w, dt = 0.1) {
  const before = { q: weightedQuality(assessDish(sim), w), burn: sim.s.burn, overheat: sim.s.overheat };
  sim.startAction(a);
  const dur = sim.actionDuration(a);
  for (let t = 0; t < dur - 1e-9; t += dt) sim.physics(Math.min(dt, dur - t), a);
  sim.finishAction(a);
  const spilled = sim.maybeSpill(a);
  return actionReward(sim, before, w, dur, spilled);
}

export function snapshotForReward(sim, w) {
  return { q: weightedQuality(assessDish(sim), w), burn: sim.s.burn, overheat: sim.s.overheat };
}

export function actionReward(sim, before, w, dur, spilled) {
  const q = assessDish(sim);
  const wq = weightedQuality(q, w);
  let r = 4 * (wq - before.q);
  r -= w.safety * (20 * (sim.s.burn - before.burn) + 0.1 * (sim.s.overheat - before.overheat) + (spilled ? 0.5 : 0));
  r -= w.speed * 0.01 * dur;
  if (sim.s.plated) r += 10 * wq;
  else if (sim.s.t >= sim.cfg.maxTime) r -= 2;
  return r;
}
