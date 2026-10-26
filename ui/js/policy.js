// RL controller: a linear softmax policy over the sensor features, a linear
// value baseline, behaviour-cloning pretraining from a hand-written expert and
// REINFORCE-with-baseline fine-tuning.

import { A, ACTIONS, runAction, assessDish } from './sim.js';

export const FEATURES = [
  'bias', 'temp', 'temp − target', 'burner', 'moisture', 'moist − target',
  'browning', 'brown − target', 'clumping', 'unmixed', 'smoke', 'pending',
  'last cooked', 'time', 'overheat', 'too cold', 'too hot', 'ready to add',
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);

// Fallbacks used when a sensor is disabled: the policy has to act blind.
const FALLBACK = { temp: 180, moisture: 0.4, browning: 0.2, clump: 0.3, mix: 0.7, smoke: 0 };

export function featurize(obs, plan, target, maxTime) {
  const v = (k) => (obs[k] == null ? FALLBACK[k] : obs[k]);
  const temp = v('temp');
  const pending = obs.pending > 0 ? 1 : 0;
  // Grain targets only matter once everything is in the wok.
  const finishing = 1 - pending;
  return [
    1,
    temp / 300,
    (temp - target) / 100,
    obs.burner,
    v('moisture'),
    finishing * (v('moisture') - plan.targets.moisture) * 4,
    v('browning'),
    finishing * (v('browning') - plan.targets.browning) * 4,
    v('clump'),
    1 - v('mix'),
    v('smoke'),
    pending,
    clamp(obs.lastCooked, 0, 1.5),
    obs.t / maxTime,
    Math.max(0, (temp - 265) / 40),
    // Soft threshold features let a linear policy express "wait until the
    // wok is hot and the last ingredient is cooked, then add the next one".
    clamp01((target - 15 - temp) / 10),
    clamp01((temp - target - 25) / 10),
    pending * clamp01((obs.lastCooked - 0.9) * 10) * clamp01((temp - target + 25) / 10),
  ];
}

// Hand-written controller used to pretrain the network (imitation learning)
// and as a reference. It acts on the same noisy observations.
export function expertAction(obs, sim) {
  const mask = sim.actionMask();
  const ok = (name) => mask[A[name]];
  const temp = obs.temp ?? 180;
  const target = sim.target;
  const tg = sim.plan.targets;
  if (temp > 268 && ok('HEAT_DOWN')) return A.HEAT_DOWN;
  if (temp < target - 15 && ok('HEAT_UP')) return A.HEAT_UP;
  if (temp > target + 25 && ok('HEAT_DOWN')) return A.HEAT_DOWN;
  if (obs.pending > 0) {
    if (obs.lastCooked >= 1 && temp >= target - 20) return A.ADD;
    return (obs.clump ?? 0) > 0.3 ? A.TOSS : A.STIR;
  }
  const moist = obs.moisture ?? tg.moisture;
  const brown = obs.browning ?? tg.browning;
  if ((obs.clump ?? 0) > 0.15 || (obs.mix ?? 1) < 0.85) return A.TOSS;
  if (moist > tg.moisture + 0.03 || brown < tg.browning - 0.04) return A.TOSS;
  return A.PLATE;
}

export class LinearPolicy {
  constructor(nF = FEATURES.length, nA = ACTIONS.length) {
    this.nF = nF;
    this.nA = nA;
    this.W = Array.from({ length: nA }, () => new Array(nF).fill(0));
    this.v = new Array(nF).fill(0);
    this.updates = 0;
  }

  randomize(rng = Math.random, scale = 0.1) {
    for (const row of this.W) for (let j = 0; j < row.length; j++) row[j] = (rng() * 2 - 1) * scale;
    this.v.fill(0);
    this.updates = 0;
  }

  logits(f) {
    return this.W.map((row) => row.reduce((acc, w, j) => acc + w * f[j], 0));
  }

  probs(f, mask, temperature = 1) {
    const z = this.logits(f).map((l, i) => (mask[i] ? l / Math.max(temperature, 1e-3) : -Infinity));
    const m = Math.max(...z);
    const e = z.map((x) => (x === -Infinity ? 0 : Math.exp(x - m)));
    const sum = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / sum);
  }

  value(f) {
    return this.v.reduce((acc, w, j) => acc + w * f[j], 0);
  }

  act(f, mask, { temperature = 1, epsilon = 0, greedy = false, rng = Math.random } = {}) {
    const p = this.probs(f, mask, temperature);
    if (rng() < epsilon) {
      const valid = mask.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
      return { a: valid[Math.floor(rng() * valid.length)], p, explored: true };
    }
    if (greedy) return { a: p.indexOf(Math.max(...p)), p, explored: false };
    let u = rng();
    for (let i = 0; i < p.length; i++) {
      u -= p[i];
      if (u <= 0 && p[i] > 0) return { a: i, p, explored: false };
    }
    return { a: p.lastIndexOf(Math.max(...p)), p, explored: false };
  }

  // Cross-entropy step towards demonstrated actions.
  imitate(samples, lr = 0.1) {
    for (const { f, mask, a } of samples) {
      const p = this.probs(f, mask);
      for (let i = 0; i < this.nA; i++) {
        if (!mask[i]) continue;
        const g = (i === a ? 1 : 0) - p[i];
        for (let j = 0; j < this.nF; j++) this.W[i][j] += lr * g * f[j];
      }
    }
    this.updates += 1;
  }

  // REINFORCE with a learned linear baseline.
  reinforce(traj, { lr = 0.01, gamma = 0.98, lrValue = 0.02 } = {}) {
    const steps = traj.filter((x) => x.onPolicy);
    if (!steps.length) return 0;
    const returns = new Array(traj.length);
    let g = 0;
    for (let t = traj.length - 1; t >= 0; t--) {
      g = traj[t].r + gamma * g;
      returns[t] = g;
    }
    const adv = traj.map((x, t) => returns[t] - this.value(x.f));
    const onAdv = adv.filter((_, t) => traj[t].onPolicy);
    const mean = onAdv.reduce((a, b) => a + b, 0) / onAdv.length;
    const std = Math.sqrt(onAdv.reduce((a, b) => a + (b - mean) ** 2, 0) / onAdv.length) || 1;
    traj.forEach((x, t) => {
      const err = returns[t] - this.value(x.f);
      for (let j = 0; j < this.nF; j++) this.v[j] += lrValue * clamp(err, -5, 5) * x.f[j];
      if (!x.onPolicy) return;
      const A_t = clamp((adv[t] - mean) / std, -3, 3);
      const p = this.probs(x.f, x.mask, x.temperature ?? 1);
      for (let i = 0; i < this.nA; i++) {
        if (!x.mask[i]) continue;
        const gi = (i === x.a ? 1 : 0) - p[i];
        for (let j = 0; j < this.nF; j++) this.W[i][j] += lr * A_t * gi * x.f[j];
      }
    });
    this.updates += 1;
    return returns[0];
  }

  toJSON() {
    return { features: FEATURES, actions: ACTIONS, W: this.W, v: this.v, updates: this.updates };
  }

  static fromJSON(obj) {
    const p = new LinearPolicy();
    if (!Array.isArray(obj?.W) || obj.W.length !== p.nA || obj.W.some((r) => r.length !== p.nF)) {
      throw new Error('Policy file does not match the feature/action layout.');
    }
    p.W = obj.W.map((r) => r.map(Number));
    if (Array.isArray(obj.v) && obj.v.length === p.nF) p.v = obj.v.map(Number);
    p.updates = obj.updates ?? 0;
    return p;
  }
}

// Shield: overrides an action that would push the wok into a dangerous state.
export function applyShield(a, obs, sim, shield) {
  if (!shield?.enabled) return { a, reason: null };
  const mask = sim.actionMask();
  const hot = obs.temp != null && obs.temp > shield.maxTemp;
  const smoky = obs.smoke != null && obs.smoke > shield.maxSmoke;
  if ((hot || smoky) && a !== A.HEAT_DOWN && mask[A.HEAT_DOWN]) {
    return { a: A.HEAT_DOWN, reason: hot ? `temp ${obs.temp.toFixed(0)} °C > ${shield.maxTemp} °C` : `smoke ${obs.smoke.toFixed(2)} > ${shield.maxSmoke}` };
  }
  if (hot && a === A.HEAT_UP) return { a: A.STIR, reason: 'blocked heat-up above limit' };
  return { a, reason: null };
}

// Runs a full headless episode. `controller` is 'policy' or 'expert'.
export function runEpisode(sim, policy, opts) {
  const { reward, sensors, shield, temperature = 1, epsilon = 0, greedy = false, controller = 'policy', rng = Math.random, mixExpert = 0 } = opts;
  sim.reset();
  const traj = [];
  let total = 0;
  while (!sim.done && sim.s.t < sim.cfg.maxTime) {
    const obs = sim.readSensors(sensors);
    const mask = sim.actionMask();
    const f = featurize(obs, sim.plan, sim.target, sim.cfg.maxTime);
    let a;
    let onPolicy = true;
    if (controller === 'expert' || rng() < mixExpert) {
      a = expertAction(obs, sim);
      onPolicy = false;
    } else {
      a = policy.act(f, mask, { temperature, epsilon, greedy, rng }).a;
    }
    const shielded = applyShield(a, obs, sim, shield);
    if (shielded.a !== a) onPolicy = false;
    a = shielded.a;
    const r = runAction(sim, a, reward);
    total += r;
    traj.push({ f, mask, a, r, onPolicy, temperature });
  }
  if (!sim.done) {
    // Timed out: force plating so the dish can be scored.
    sim.s.plated = true;
  }
  return { traj, total, quality: assessDish(sim) };
}

// Behaviour cloning from the expert, with a little DAgger-style mixing so the
// policy also sees states reached by its own mistakes.
export function pretrain(policy, makeSim, { episodes = 24, epochs = 30, lr = 0.05, sensors, rng = Math.random } = {}) {
  const data = [];
  for (let e = 0; e < episodes; e++) {
    const sim = makeSim();
    sim.reset();
    const useSelf = e >= episodes / 2;
    while (!sim.done && sim.s.t < sim.cfg.maxTime) {
      const obs = sim.readSensors(sensors);
      const mask = sim.actionMask();
      const f = featurize(obs, sim.plan, sim.target, sim.cfg.maxTime);
      const expert = expertAction(obs, sim);
      data.push({ f, mask, a: expert });
      const a = useSelf && rng() < 0.5 ? policy.act(f, mask, { rng }).a : expert;
      runAction(sim, a, { taste: 1, texture: 1, wokHei: 1, safety: 1, speed: 0 });
    }
    if (e === episodes / 2 - 1 || e === episodes - 1) {
      for (let k = 0; k < epochs; k++) policy.imitate(shuffle(data, rng), lr);
    }
  }
  return data.length;
}

function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
