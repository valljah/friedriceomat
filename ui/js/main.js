import { RECIPES } from './recipes.js';
import { DEFAULT_PREFS, planRecipe } from './planner.js';
import {
  ACTIONS, ACTION_LABELS, A, DEFAULT_ENV, DEFAULT_REWARD, DEFAULT_SENSORS,
  WokSim, assessDish, actionReward, snapshotForReward, weightedQuality,
} from './sim.js';
import { FEATURES, LinearPolicy, applyShield, featurize, pretrain, runEpisode } from './policy.js';
import { ArmView } from './arm.js';
import { LineChart, WeightMap } from './charts.js';
import { RobotBridge } from './bridge.js';

// ---------------------------------------------------------------- config --

const DEFAULTS = {
  prefs: { ...DEFAULT_PREFS },
  agent: { mode: 'auto', temperature: 0.6, epsilon: 0, lr: 0.01, gamma: 0.98, online: true },
  reward: { ...DEFAULT_REWARD },
  env: { ...DEFAULT_ENV },
  sensors: { ...DEFAULT_SENSORS },
  shield: { enabled: true, maxTemp: 285, maxSmoke: 0.4 },
  link: { url: 'ws://localhost:8765', useRobotSensors: false },
};

const CONFIG_KEY = 'friedriceomat.config.v1';
const POLICY_KEY = 'friedriceomat.policy.v1';
const THEME_KEY = 'friedriceomat.theme';

const clone = (o) => JSON.parse(JSON.stringify(o));
function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
function mergeConfig(saved) {
  const cfg = clone(DEFAULTS);
  for (const group of Object.keys(cfg)) {
    if (saved?.[group] && typeof saved[group] === 'object') {
      for (const k of Object.keys(cfg[group])) if (k in saved[group]) cfg[group][k] = saved[group][k];
    }
  }
  return cfg;
}

let cfg = mergeConfig(loadJSON(CONFIG_KEY));

const pct = (v) => `${Math.round(v * 100)}%`;
const fx = (n) => (v) => Number(v).toFixed(n);

const SCHEMA = [
  {
    title: 'Recipe & AI planner', open: true, items: [
      { path: 'prefs.recipe', label: 'Recipe', type: 'select', options: Object.entries(RECIPES).map(([id, r]) => [id, r.name]) },
      { path: 'prefs.customText', label: 'Custom ingredients', type: 'textarea', help: 'Free text. The planner picks out known ingredients and orders them.', showIf: (c) => c.prefs.recipe === 'custom' },
      { path: 'prefs.crispness', label: 'Crispness', type: 'range', min: 0, max: 1, step: 0.05, fmt: fx(2), help: 'Higher = drier, more browned grains.' },
      { path: 'prefs.smokiness', label: 'Smokiness (wok hei)', type: 'range', min: 0, max: 1, step: 0.05, fmt: fx(2), help: 'Raises the finishing temperature and the wok hei target.' },
      { path: 'prefs.spice', label: 'Spice level', type: 'range', min: 0, max: 3, step: 0.5, fmt: fx(1), help: 'Scales chili, kimchi, gochujang. 0 removes them.' },
      { path: 'prefs.servings', label: 'Servings', type: 'range', min: 1, max: 4, step: 1, fmt: fx(0), help: 'More food = more thermal mass.' },
    ],
  },
  {
    title: 'RL policy', open: true, items: [
      { path: 'agent.mode', label: 'Control mode', type: 'select', options: [['auto', 'Autonomous (policy acts)'], ['manual', 'Manual (you act, policy suggests)']] },
      { path: 'agent.temperature', label: 'Softmax temperature', type: 'range', min: 0.05, max: 2, step: 0.05, fmt: fx(2), help: 'Low = decisive, high = varied behaviour.' },
      { path: 'agent.epsilon', label: 'Exploration ε', type: 'range', min: 0, max: 0.5, step: 0.01, fmt: fx(2), help: 'Chance of a random valid action.' },
      { path: 'agent.lr', label: 'Learning rate', type: 'range', min: 0.001, max: 0.05, step: 0.001, fmt: fx(3) },
      { path: 'agent.gamma', label: 'Discount γ', type: 'range', min: 0.8, max: 0.999, step: 0.001, fmt: fx(3) },
      { path: 'agent.online', label: 'Learn from live dishes', type: 'check', help: 'Update the policy (and imitate your manual actions) after each plated dish.' },
    ],
  },
  {
    title: 'Reward shaping', open: false, items: [
      { path: 'reward.taste', label: 'Taste (doneness + seasoning)', type: 'range', min: 0, max: 3, step: 0.1, fmt: fx(1) },
      { path: 'reward.texture', label: 'Texture & colour', type: 'range', min: 0, max: 3, step: 0.1, fmt: fx(1) },
      { path: 'reward.wokHei', label: 'Wok hei', type: 'range', min: 0, max: 3, step: 0.1, fmt: fx(1) },
      { path: 'reward.safety', label: 'Safety (burn, spills, overheat)', type: 'range', min: 0, max: 3, step: 0.1, fmt: fx(1) },
      { path: 'reward.speed', label: 'Speed', type: 'range', min: 0, max: 3, step: 0.1, fmt: fx(1), help: 'Cost per second of cooking.' },
    ],
  },
  {
    title: 'Robot arm', open: false, items: [
      { path: 'env.armSpeed', label: 'Arm speed', type: 'range', min: 0.5, max: 2, step: 0.1, fmt: (v) => `${Number(v).toFixed(1)}×`, help: 'Faster moves, but tosses spill more.' },
      { path: 'env.tossIntensity', label: 'Toss intensity', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, help: 'More wok hei and mixing, more spill risk.' },
      { path: 'env.stirVigor', label: 'Stir vigour', type: 'range', min: 0.2, max: 1, step: 0.05, fmt: pct },
    ],
  },
  {
    title: 'Stove & ingredients', open: false, items: [
      { path: 'env.burnerPower', label: 'Burner strength', type: 'range', min: 0.6, max: 1.4, step: 0.05, fmt: (v) => `${Number(v).toFixed(2)}×` },
      { path: 'env.maxBurner', label: 'Burner limit', type: 'range', min: 0.3, max: 1, step: 0.05, fmt: pct },
      { path: 'env.riceMoisture', label: 'Rice moisture', type: 'range', min: 0.4, max: 0.75, step: 0.01, fmt: fx(2), help: '0.45 dry day-old rice … 0.70 freshly cooked.' },
      { path: 'env.maxTime', label: 'Time limit', type: 'range', min: 120, max: 600, step: 30, fmt: (v) => `${v} s` },
      { path: 'env.randomize', label: 'Domain randomisation', type: 'check', help: 'Vary burner and rice per dish so the policy must rely on its sensors.' },
    ],
  },
  {
    title: 'Sensors', open: false, items: [
      { path: 'sensors.thermal', label: 'IR thermometer (wok temp)', type: 'check' },
      { path: 'sensors.camera', label: 'Camera (browning, clumps, mixing)', type: 'check' },
      { path: 'sensors.steam', label: 'Steam sensor (moisture)', type: 'check' },
      { path: 'sensors.voc', label: 'Gas sensor (smoke)', type: 'check' },
      { path: 'sensors.load', label: 'Load cell (mass)', type: 'check' },
      { path: 'sensors.noise', label: 'Sensor noise', type: 'range', min: 0, max: 3, step: 0.1, fmt: (v) => `${Number(v).toFixed(1)}×` },
    ],
  },
  {
    title: 'Safety shield', open: false, items: [
      { path: 'shield.enabled', label: 'Shield enabled', type: 'check', help: 'Overrides the policy when the wok gets dangerous.' },
      { path: 'shield.maxTemp', label: 'Max wok temperature', type: 'range', min: 230, max: 340, step: 5, fmt: (v) => `${v} °C` },
      { path: 'shield.maxSmoke', label: 'Max smoke', type: 'range', min: 0.1, max: 1, step: 0.05, fmt: fx(2) },
    ],
  },
  {
    title: 'Robot link', open: false, items: [
      { path: 'link.url', label: 'WebSocket URL', type: 'text', help: 'Commands go out as JSON, telemetry comes back. See README.' },
      { type: 'buttons', buttons: [['Connect', () => bridge.connect(cfg.link.url)], ['Disconnect', () => bridge.disconnect()]] },
      { path: 'link.useRobotSensors', label: 'Policy reads robot sensors', type: 'check' },
    ],
  },
];

const getPath = (path) => path.split('.').reduce((o, k) => o[k], cfg);
function setPath(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], cfg)[last] = value;
}

// ------------------------------------------------------------------ DOM --

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) node.append(c);
  return node;
};

const controlEls = [];
function renderControls() {
  const root = $('controls');
  root.replaceChildren();
  controlEls.length = 0;
  for (const section of SCHEMA) {
    const det = el('details', { open: section.open });
    det.append(el('summary', {}, section.title));
    for (const item of section.items) {
      const wrap = el('div', { class: `ctl ${item.type}` });
      if (item.type === 'buttons') {
        const row = el('div', { class: 'ctl-row' });
        for (const [label, fn] of item.buttons) row.append(el('button', { type: 'button', class: 'small', onclick: fn }, label));
        wrap.append(row);
      } else if (item.type === 'check') {
        const input = el('input', { type: 'checkbox', id: `c-${item.path}` });
        input.checked = !!getPath(item.path);
        input.addEventListener('change', () => onControl(item, input.checked));
        wrap.append(el('label', { for: `c-${item.path}` }, input, item.label));
      } else {
        const id = `c-${item.path}`;
        const out = el('output', { for: id });
        const top = el('div', { class: 'ctl-top' }, el('label', { for: id }, item.label), out);
        let input;
        if (item.type === 'select') {
          input = el('select', { id });
          for (const [v, label] of item.options) input.append(el('option', { value: v }, label));
          input.value = getPath(item.path);
          input.addEventListener('change', () => onControl(item, input.value));
        } else if (item.type === 'textarea' || item.type === 'text') {
          input = item.type === 'textarea' ? el('textarea', { id }) : el('input', { id, type: 'text' });
          input.value = getPath(item.path);
          input.addEventListener('input', () => onControl(item, input.value));
        } else {
          input = el('input', { id, type: 'range', min: item.min, max: item.max, step: item.step });
          input.value = getPath(item.path);
          out.textContent = item.fmt(getPath(item.path));
          input.addEventListener('input', () => {
            const v = Number(input.value);
            out.textContent = item.fmt(v);
            onControl(item, v);
          });
        }
        wrap.append(top, input);
      }
      if (item.help) wrap.append(el('div', { class: 'ctl-help' }, item.help));
      controlEls.push({ item, wrap });
      det.append(wrap);
    }
    root.append(det);
  }
  refreshVisibility();
}

function refreshVisibility() {
  for (const { item, wrap } of controlEls) wrap.hidden = item.showIf ? !item.showIf(cfg) : false;
  $('manualBar').hidden = cfg.agent.mode !== 'manual';
  $('controlMode').textContent = cfg.agent.mode === 'manual' ? 'manual' : 'autonomous';
}

function onControl(item, value) {
  setPath(item.path, value);
  saveJSON(CONFIG_KEY, cfg);
  const group = item.path.split('.')[0];
  if (group === 'prefs') replan();
  if (group === 'env') {
    sim.cfg = { ...sim.cfg, ...cfg.env };
    sim.s.burner = Math.min(sim.s.burner, sim.cfg.maxBurner);
  }
  if (group === 'shield') updateChartRefs();
  if (item.path === 'agent.mode') {
    manualQueue.length = 0;
    log(`Control mode: ${value === 'manual' ? 'manual' : 'autonomous'}`);
  }
  refreshVisibility();
}

// ------------------------------------------------------------ state --

let plan = planRecipe(cfg.prefs);
let pendingPlan = null;
let sim = new WokSim(plan, cfg.env);
let policyFromStorage = false;
let policy = initPolicy();
const arm = new ArmView($('armCanvas'));
const bridge = new RobotBridge();

let running = false;
let stepping = false;
let training = false;
let stopTraining = false;
let current = null;
let traj = [];
let demos = [];
let epReturn = 0;
let episodeNo = 1;
let lastSample = -1;
let lastDecision = null;
let nextEpisodeTimer = null;
const manualQueue = [];
const curve = [];

function initPolicy() {
  const saved = loadJSON(POLICY_KEY);
  if (saved) {
    try {
      const p = LinearPolicy.fromJSON(saved);
      policyFromStorage = true;
      return p;
    } catch { /* fall through to pretraining */ }
  }
  const p = new LinearPolicy();
  p.randomize(Math.random, 0.01);
  pretrain(p, () => new WokSim(plan, cfg.env), { sensors: cfg.sensors });
  return p;
}

// ------------------------------------------------------------ charts --

function legend(id, items) {
  $(id).replaceChildren(...items.map(([label, color, dashed]) =>
    el('span', {}, el('i', { class: dashed ? 'dash' : '', style: dashed ? '' : `background:var(${color})` }), label)));
}

const tempChart = new LineChart($('chTemp'), [
  { key: 'T', label: 'Wok (true)', color: '--series-1' },
  { key: 'ir', label: 'IR sensor', color: '--series-3' },
  { key: 'target', label: 'Stage target', color: '--series-2', dashed: true },
], { yMin: 0, yMax: 350, unit: ' °C', format: fx(0), xFormat: (x) => `${x.toFixed(0)} s`, minSpan: 30 });
legend('legTemp', [['Wok', '--series-1'], ['IR sensor', '--series-3'], ['Target', '--series-2']]);

const grainChart = new LineChart($('chGrain'), [
  { key: 'moisture', label: 'Moisture', color: '--series-1' },
  { key: 'browning', label: 'Browning', color: '--series-2' },
  { key: 'mix', label: 'Mixing', color: '--series-3' },
], { yMin: 0, yMax: 1, format: fx(2), xFormat: (x) => `${x.toFixed(0)} s`, minSpan: 30 });
legend('legGrain', [['Moisture', '--series-1'], ['Browning', '--series-2'], ['Mixing', '--series-3']]);

const rewardChart = new LineChart($('chReward'), [
  { key: 'ret', label: 'Return so far', color: '--series-1' },
  { key: 'q', label: 'Weighted quality ×10', color: '--series-2' },
], { yMin: -2, yMax: 10, auto: true, format: fx(2), xFormat: (x) => `${x.toFixed(0)} s`, minSpan: 30 });
legend('legReward', [['Return', '--series-1'], ['Quality ×10', '--series-2']]);

const curveChart = new LineChart($('chCurve'), [
  { key: 'score', label: 'Dish score', color: '--series-1' },
  { key: 'avg', label: 'Moving avg (20)', color: '--series-2' },
  { key: 'live', label: 'Live dish', color: '--series-3', dots: true },
], { yMin: 0, yMax: 100, format: fx(1), xLabel: 'episode', xFormat: (x) => `#${x}`, minSpan: 10, maxPoints: 5000 });
legend('legCurve', [['Training dish score', '--series-1'], ['Moving average', '--series-2'], ['Live dish', '--series-3']]);

const weightMap = new WeightMap($('weights'), ACTIONS.map((a) => ACTION_LABELS[a]), FEATURES);

function updateChartRefs() {
  tempChart.setRefs(cfg.shield.enabled ? [{ value: cfg.shield.maxTemp, label: 'shield limit', color: '--critical' }] : []);
  grainChart.setRefs([
    { value: plan.targets.moisture, label: 'moisture target', color: '--series-1', side: 'left' },
    { value: plan.targets.browning, label: 'browning target', color: '--series-2' },
  ]);
}

window.addEventListener('resize', () => {
  arm.resize();
  for (const c of [tempChart, grainChart, rewardChart, curveChart, weightMap]) c.resize();
});

// --------------------------------------------------------------- log --

function log(msg, cls = '') {
  const li = el('li', { class: cls }, el('time', {}, `${sim.s.t.toFixed(1)}s`), el('span', {}, msg));
  const list = $('log');
  list.prepend(li);
  while (list.children.length > 200) list.lastChild.remove();
}

// ---------------------------------------------------------- planning --

function replan() {
  const next = planRecipe(cfg.prefs);
  if (sim.s.t === 0 && !current) applyPlan(next);
  else {
    pendingPlan = next;
    $('planNotes').replaceChildren(el('li', { class: 'pending-note' }, 'Preference changes apply to the next dish.'), ...next.notes.map((n) => el('li', {}, n)));
  }
}

function applyPlan(p) {
  plan = p;
  pendingPlan = null;
  sim = new WokSim(plan, cfg.env);
  arm.setPlan(plan);
  $('dishName').textContent = `${plan.name} · ${plan.stages.length} stages`;
  $('planNotes').replaceChildren(...plan.notes.map((n) => el('li', {}, n)));
  updateChartRefs();
  bridge.send({ type: 'plan', plan });
}

// ------------------------------------------------------------ control --

function observe() {
  const obs = sim.readSensors(cfg.sensors);
  const robot = cfg.link.useRobotSensors ? bridge.fresh() : null;
  if (robot) for (const [k, v] of Object.entries(robot)) if (typeof v === 'number' && k in obs) obs[k] = v;
  return obs;
}

function decide() {
  const obs = observe();
  const mask = sim.actionMask();
  const f = featurize(obs, plan, sim.target, sim.cfg.maxTime);
  const probs = policy.probs(f, mask, cfg.agent.temperature);
  let a;
  let onPolicy = true;
  let explored = false;
  if (cfg.agent.mode === 'manual') {
    lastDecision = { probs, mask, a: null, obs, f };
    renderDecision();
    while (manualQueue.length && !mask[manualQueue[0]]) {
      log(`${ACTION_LABELS[ACTIONS[manualQueue.shift()]]} is not possible right now`, 'warn');
    }
    if (!manualQueue.length) return null;
    a = manualQueue.shift();
    onPolicy = false;
    demos.push({ f, mask, a });
  } else {
    const r = policy.act(f, mask, { temperature: cfg.agent.temperature, epsilon: cfg.agent.epsilon });
    a = r.a;
    explored = r.explored;
  }
  const proposed = a;
  const shield = applyShield(a, obs, sim, cfg.shield);
  if (shield.a !== a) {
    onPolicy = false;
    a = shield.a;
    log(`Shield: ${ACTION_LABELS[ACTIONS[proposed]]} → ${ACTION_LABELS[ACTIONS[a]]} (${shield.reason})`, 'warn');
  }
  const before = snapshotForReward(sim, cfg.reward);
  arm.startAction(a, sim);
  sim.startAction(a);
  const dur = sim.actionDuration(a);
  lastDecision = { probs, mask, a, proposed, obs, f, value: policy.value(f), shield: shield.reason, explored };
  renderDecision();
  animatePipeline();
  arm.caption = `${ACTION_LABELS[ACTIONS[a]]}${a === A.ADD ? ` ${plan.stages[sim.s.next].label.toLowerCase()}` : ''}${explored ? ' (exploring)' : ''}`;
  $('actionNow').textContent = arm.caption;
  bridge.send({
    type: 'command', action: ACTIONS[a], durationSec: dur, burner: sim.s.burner,
    stage: plan.stages[sim.s.next]?.id ?? null,
    params: { armSpeed: cfg.env.armSpeed, tossIntensity: cfg.env.tossIntensity, stirVigor: cfg.env.stirVigor },
  });
  return { a, dur, elapsed: 0, before, f, mask, onPolicy };
}

function finishCurrent() {
  const { a, before, dur, f, mask, onPolicy } = current;
  const adding = a === A.ADD ? plan.stages[sim.s.next] : null;
  sim.finishAction(a);
  const spilled = sim.maybeSpill(a);
  const r = actionReward(sim, before, cfg.reward, dur, spilled);
  traj.push({ f, mask, a, r, onPolicy, temperature: cfg.agent.temperature });
  epReturn += r;
  if (adding) log(`Added ${adding.label} (${adding.grams} g) at ${sim.s.T.toFixed(0)} °C, target ${adding.targetTemp} °C`);
  if (spilled) log('Spill! Toss was too aggressive.', 'bad');
  current = null;
  if (stepping) { stepping = false; setRunning(false); }
  if (sim.done || sim.s.t >= sim.cfg.maxTime) endEpisode();
}

// Advance the simulation by at most `maxDt` seconds; returns time used.
function tick(maxDt) {
  if (!current) {
    current = decide();
    if (!current) {
      const d = Math.min(maxDt, 0.1);
      sim.physics(d, null);
      arm.update(1, sim, d);
      if (sim.s.t >= sim.cfg.maxTime) endEpisode();
      return d;
    }
  }
  const d = Math.max(1e-6, Math.min(maxDt, 0.1, current.dur - current.elapsed));
  sim.physics(d, current.a);
  current.elapsed += d;
  arm.update(current.elapsed / current.dur, sim, d);
  if (current.elapsed >= current.dur - 1e-9) finishCurrent();
  return d;
}

function sample() {
  if (sim.s.t - lastSample < 0.5) return;
  lastSample = sim.s.t;
  const obs = lastDecision?.obs;
  const q = weightedQuality(assessDish(sim), cfg.reward);
  tempChart.push(sim.s.t, { T: sim.s.T, ir: obs?.temp ?? null, target: sim.target });
  if (sim.s.mass > 0) grainChart.push(sim.s.t, { moisture: sim.s.moisture, browning: sim.s.browning, mix: sim.s.mix });
  rewardChart.push(sim.s.t, { ret: epReturn, q: q * 10 });
}

function endEpisode() {
  if (!sim.s.plated) {
    sim.s.plated = true;
    log('Time limit reached, dish force-plated.', 'bad');
  }
  current = null;
  const q = assessDish(sim);
  renderDish(q, true);
  const learnable = traj.some((x) => x.onPolicy);
  if (cfg.agent.online && learnable) policy.reinforce(traj, { lr: cfg.agent.lr, gamma: cfg.agent.gamma });
  if (cfg.agent.online && demos.length) {
    for (let k = 0; k < 10; k++) policy.imitate(demos, 0.05);
    log(`Imitated ${demos.length} manual actions.`, 'good');
  }
  if (cfg.agent.online) {
    saveJSON(POLICY_KEY, policy.toJSON());
    weightMap.draw(policy.W);
  }
  curve.push({ x: curve.length + 1, live: q.score });
  redrawCurve();
  log(`Plated ${plan.name}: score ${q.score.toFixed(1)}, return ${epReturn.toFixed(2)}${q.raw ? ', protein undercooked' : ''}`, q.score >= 70 ? 'good' : q.score < 45 ? 'bad' : '');
  setStatus('plated');
  if (running && $('autoNext').checked) {
    nextEpisodeTimer = setTimeout(() => { nextEpisodeTimer = null; newEpisode(true); }, 1500);
  } else setRunning(false);
}

function newEpisode(count) {
  clearTimeout(nextEpisodeTimer);
  nextEpisodeTimer = null;
  if (pendingPlan) applyPlan(pendingPlan);
  else {
    sim.cfg = { ...sim.cfg, ...cfg.env };
    sim.reset();
    arm.reset();
  }
  if (count) episodeNo += 1;
  current = null;
  traj = [];
  demos = [];
  epReturn = 0;
  lastSample = -1;
  manualQueue.length = 0;
  for (const c of [tempChart, grainChart, rewardChart]) c.clear();
  $('dishScore').textContent = '—';
  arm.caption = '';
  setStatus(running ? 'cooking' : 'idle');
  log(`Dish #${episodeNo}: ${plan.name} (rice moisture ${sim.episode.riceMoisture.toFixed(2)}, burner ${sim.episode.burnerPower.toFixed(2)}×)`);
}

// ------------------------------------------------------------- render --

function setStatus(state) {
  const pill = $('statusPill');
  pill.className = `pill ${state}`;
  pill.textContent = { idle: 'Idle', cooking: 'Cooking', plated: 'Plated', training: 'Training', paused: 'Paused' }[state] ?? state;
}

function setRunning(on) {
  running = on;
  $('btnRun').textContent = on ? 'Pause' : 'Start';
  if (sim.done) return;
  setStatus(on ? 'cooking' : sim.s.t > 0 ? 'paused' : 'idle');
}

function renderDecision() {
  const d = lastDecision;
  if (!d) return;
  const box = $('probs');
  box.replaceChildren(...ACTIONS.map((name, i) => {
    const row = el('div', { class: `prob${i === d.a ? ' chosen' : ''}${d.mask[i] ? '' : ' masked'}` },
      el('span', {}, ACTION_LABELS[name]),
      el('div', { class: 'bar' }, el('span', { style: `width:${(d.probs[i] * 100).toFixed(1)}%` })),
      el('b', {}, `${(d.probs[i] * 100).toFixed(0)}%`));
    return row;
  }));
  const H = -d.probs.reduce((acc, p) => acc + (p > 0 ? p * Math.log(p) : 0), 0);
  $('valueEst').textContent = d.value != null ? d.value.toFixed(2) : policy.value(d.f).toFixed(2);
  $('entropy').textContent = `${H.toFixed(2)} nats`;
  $('shieldNote').textContent = d.shield ? `Shield override: ${d.shield}` : '';
  if (cfg.agent.mode === 'manual') {
    const best = d.probs.indexOf(Math.max(...d.probs));
    $('manualButtons').querySelectorAll('button').forEach((b, i) => {
      b.disabled = !d.mask[i];
      b.classList.toggle('primary', i === best);
      b.title = i === best ? 'Policy suggestion' : '';
    });
  }
}

const PIPE = ['Sensors', 'State encoder', 'Planner', 'Policy π(a|s)', 'Safety shield', 'Arm controller'];
function renderPipeline() {
  $('pipeline').replaceChildren(...PIPE.map((name) => el('li', {}, el('div', { class: 'p-name' }, name), el('div', { class: 'p-val' }, '—'))));
}

function animatePipeline() {
  const d = lastDecision;
  const nodes = [...$('pipeline').children];
  const active = Object.entries(cfg.sensors).filter(([k, v]) => k !== 'noise' && v).length;
  const st = plan.stages[sim.s.next];
  const vals = [
    `${active}/5 online${cfg.link.useRobotSensors && bridge.fresh() ? ' · robot' : ''}`,
    `${FEATURES.length} features`,
    st ? `next: ${st.label} @ ${st.targetTemp} °C` : `finish @ ${plan.finishTemp} °C`,
    `${ACTION_LABELS[ACTIONS[d.proposed ?? d.a]]} ${(d.probs[d.proposed ?? d.a] * 100).toFixed(0)}%${d.explored ? ' (ε)' : ''}`,
    d.shield ? `override → ${ACTION_LABELS[ACTIONS[d.a]]}` : 'pass',
    `${ACTION_LABELS[ACTIONS[d.a]]} · ${sim.actionDuration(d.a).toFixed(1)} s`,
  ];
  nodes.forEach((n, i) => {
    n.lastChild.textContent = vals[i];
    n.classList.toggle('warn', i === 4 && !!d.shield);
    n.classList.remove('lit');
    setTimeout(() => n.classList.add('lit'), i * 70);
    setTimeout(() => n.classList.remove('lit'), i * 70 + 420);
  });
}

let latestObs = null;
function renderSensors() {
  const o = observe();
  latestObs = o;
  const tg = plan.targets;
  const totalMass = plan.stages.reduce((a, s) => a + s.grams, 0);
  const rows = [
    ['IR thermometer', o.temp, (v) => `${v.toFixed(0)} °C`, (v) => v / 350, sim.target / 350],
    ['Steam → moisture', o.moisture, fx(2), (v) => v, sim.pending ? null : tg.moisture],
    ['Camera → browning', o.browning, fx(2), (v) => v, sim.pending ? null : tg.browning],
    ['Camera → clumping', o.clump, fx(2), (v) => v, null],
    ['Camera → mixing', o.mix, fx(2), (v) => v, null],
    ['Gas → smoke', o.smoke, fx(2), (v) => Math.min(1, v), cfg.shield.enabled ? cfg.shield.maxSmoke : null],
    ['Load cell', o.mass, (v) => `${v.toFixed(0)} g`, (v) => v / totalMass, null],
    ['Burner', o.burner, pct, (v) => v, cfg.env.maxBurner],
  ];
  const list = $('sensors');
  if (list.children.length !== rows.length) {
    list.replaceChildren(...rows.map(() => el('li', {}, el('span', { class: 's-name' }), el('span', { class: 's-val' }), el('div', { class: 's-bar' }, el('span'), el('em')))));
  }
  rows.forEach(([name, v, fmt, norm, marker], i) => {
    const li = list.children[i];
    li.classList.toggle('off', v == null);
    li.children[0].textContent = name;
    const empty = v == null && name !== 'IR thermometer' && sim.s.mass === 0 && sensorOn(name);
    li.children[1].textContent = v == null ? (empty ? 'no food' : 'offline') : fmt(v);
    const bar = li.children[2];
    bar.firstChild.style.width = v == null ? '0' : `${Math.max(0, Math.min(1, norm(v))) * 100}%`;
    bar.lastChild.hidden = marker == null;
    if (marker != null) bar.lastChild.style.left = `${Math.min(99, marker * 100)}%`;
  });
  const robot = bridge.fresh();
  $('sensorSource').textContent = cfg.link.useRobotSensors && robot ? 'robot' : bridge.connected ? 'sim · robot linked' : 'simulated';
}

function sensorOn(name) {
  const s = cfg.sensors;
  if (name.startsWith('Steam')) return s.steam;
  if (name.startsWith('Camera')) return s.camera;
  if (name.startsWith('Gas')) return s.voc;
  if (name.startsWith('Load')) return s.load;
  return true;
}

function renderPlan() {
  const list = $('plan');
  if (list.children.length !== plan.stages.length || list.dataset.plan !== plan.name + plan.stages.length) {
    list.dataset.plan = plan.name + plan.stages.length;
    list.replaceChildren(...plan.stages.map((st) => el('li', {},
      el('span', { class: 'dot', style: `background:${st.color}` }),
      el('span', { class: 'label' }, `${st.label} · ${st.grams} g`),
      el('span', { class: 'meta' }, `${st.targetTemp} °C`),
      el('span', { class: 'cook', title: 'cooked' }, el('span')))));
  }
  plan.stages.forEach((st, i) => {
    const li = list.children[i];
    li.className = sim.s.added[i] ? 'done' : i === sim.s.next ? 'next' : '';
    const f = st.cook > 0 ? Math.min(1, sim.s.cooked[i] / st.cook) : (sim.s.added[i] ? 1 : 0);
    li.lastChild.firstChild.style.width = `${f * 100}%`;
  });
}

function renderDish(q, final) {
  $('dishScore').textContent = `${q.score.toFixed(0)}${final ? '' : '*'}`;
  $('dishScore').title = final ? 'Final score' : 'Live estimate';
  const rows = [
    ['Texture', q.texture], ['Colour', q.color], ['Wok hei', q.wokHei], ['Doneness', q.doneness],
    ['Mixing', q.mix], ['Completeness', q.completeness],
  ];
  const flags = [];
  if (q.raw) flags.push('Protein undercooked');
  if (q.burnt > 0.05) flags.push(`Burnt ${pct(q.burnt)}`);
  if (sim.s.spills) flags.push(`${sim.s.spills} spill(s)`);
  $('dish').replaceChildren(
    ...rows.map(([name, v]) => el('div', { class: 'row' }, el('span', {}, name), el('div', { class: 'bar' }, el('span', { style: `width:${v * 100}%` })), el('b', {}, pct(v)))),
    ...flags.map((f) => el('div', { class: 'flag' }, `⚠ ${f}`)),
  );
}

function renderJoints() {
  const deg = (r) => `${(r * 180 / Math.PI).toFixed(0)}°`;
  const j = arm.joints;
  $('joints').innerHTML = `<span>Shoulder <b>${deg(j.q1)}</b></span><span>Elbow <b>${deg(j.q2)}</b></span><span>Wrist <b>${deg(j.q3)}</b></span>`
    + `<span>Tool <b>${arm.tip.x.toFixed(0)}, ${arm.tip.y.toFixed(0)}</b></span><span>Agitation <b>${pct(sim.s.agitation)}</b></span>`
    + `<span>Wok hei <b>${pct(sim.s.wokHei)}</b></span>`;
}

function redrawCurve() {
  curveChart.data = curve.map((p, i) => {
    const win = curve.slice(Math.max(0, i - 19), i + 1).filter((x) => x.score != null);
    return { ...p, avg: p.score != null && win.length ? win.reduce((a, b) => a + b.score, 0) / win.length : null };
  });
  curveChart.draw();
}

let uiClock = 0;
function renderUI(dt) {
  uiClock += dt;
  $('simTime').textContent = `${sim.s.t.toFixed(1)} s`;
  $('episodeNo').textContent = episodeNo;
  $('episodeReturn').textContent = epReturn.toFixed(2);
  if (uiClock < 0.1) return;
  uiClock = 0;
  renderSensors();
  renderPlan();
  renderJoints();
  if (!sim.done) renderDish(assessDish(sim), false);
  for (const c of [tempChart, grainChart, rewardChart]) c.draw();
}

// --------------------------------------------------------------- loop --

let lastFrame = performance.now();
function frame(now) {
  const dtReal = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (running && !sim.done && !training) {
    let budget = dtReal * Number($('speed').value);
    let guard = 0;
    while (budget > 1e-6 && running && !sim.done && guard++ < 500) {
      budget -= tick(budget);
      sample();
    }
  } else {
    arm.update(current ? current.elapsed / current.dur : 1, sim, dtReal);
  }
  arm.draw(sim, latestObs ?? observe());
  renderUI(dtReal);
  requestAnimationFrame(frame);
}

// ----------------------------------------------------------- training --

async function train(n) {
  training = true;
  stopTraining = false;
  const wasRunning = running;
  setRunning(false);
  setStatus('training');
  $('btnTrain').textContent = 'Stop';
  const trainPlan = pendingPlan ?? plan;
  const start = curve.length;
  log(`Training ${n} episodes on ${trainPlan.name}…`);
  let done = 0;
  const scores = [];
  while (done < n && !stopTraining) {
    const batch = Math.min(5, n - done);
    for (let k = 0; k < batch; k++) {
      const tsim = new WokSim(trainPlan, cfg.env);
      const res = runEpisode(tsim, policy, {
        reward: cfg.reward, sensors: cfg.sensors, shield: cfg.shield,
        temperature: cfg.agent.temperature, epsilon: cfg.agent.epsilon,
      });
      policy.reinforce(res.traj, { lr: cfg.agent.lr, gamma: cfg.agent.gamma });
      curve.push({ x: curve.length + 1, score: res.quality.score });
      scores.push(res.quality.score);
    }
    done += batch;
    $('trainProgress').style.width = `${(done / n) * 100}%`;
    redrawCurve();
    weightMap.draw(policy.W);
    await new Promise((r) => setTimeout(r, 0));
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const k = Math.min(10, Math.floor(scores.length / 2) || 1);
  $('trainSummary').textContent = `Episodes ${start + 1}–${curve.length}: first ${k} avg ${avg(scores.slice(0, k)).toFixed(1)}, last ${k} avg ${avg(scores.slice(-k)).toFixed(1)}. Total policy updates: ${policy.updates}.`;
  log(`Training finished (${done} episodes), last ${k} avg score ${avg(scores.slice(-k)).toFixed(1)}`, 'good');
  saveJSON(POLICY_KEY, policy.toJSON());
  training = false;
  $('btnTrain').textContent = 'Train';
  setTimeout(() => { $('trainProgress').style.width = '0'; }, 800);
  setStatus(sim.done ? 'plated' : 'idle');
  if (wasRunning) setRunning(true);
}

// ------------------------------------------------------------- wiring --

$('btnRun').addEventListener('click', () => {
  if (training) return;
  if (sim.done) newEpisode(true);
  setRunning(!running);
});
$('btnStep').addEventListener('click', () => {
  if (training) return;
  if (sim.done) newEpisode(true);
  if (cfg.agent.mode === 'manual' && !manualQueue.length) {
    log('Manual mode: pick an action first.', 'warn');
    return;
  }
  stepping = true;
  setRunning(true);
});
$('btnReset').addEventListener('click', () => {
  setRunning(false);
  newEpisode(false);
});
$('btnClearLog').addEventListener('click', () => $('log').replaceChildren());
$('btnDefaults').addEventListener('click', () => {
  cfg = clone(DEFAULTS);
  saveJSON(CONFIG_KEY, cfg);
  renderControls();
  replan();
  updateChartRefs();
  log('Restored default settings.');
});
$('btnTrain').addEventListener('click', () => {
  if (training) { stopTraining = true; return; }
  train(Math.max(1, Math.min(2000, Number($('trainN').value) || 100)));
});
$('btnPretrain').addEventListener('click', () => {
  if (training) return;
  const p = new LinearPolicy();
  p.randomize(Math.random, 0.01);
  const trainPlan = pendingPlan ?? plan;
  const n = pretrain(p, () => new WokSim(trainPlan, cfg.env), { sensors: cfg.sensors });
  policy = p;
  saveJSON(POLICY_KEY, policy.toJSON());
  weightMap.draw(policy.W);
  log(`Imitation pretraining on ${n} expert decisions.`, 'good');
});
$('btnRandom').addEventListener('click', () => {
  if (training) return;
  policy.randomize(Math.random, 0.1);
  saveJSON(POLICY_KEY, policy.toJSON());
  weightMap.draw(policy.W);
  log('Policy weights randomised: the robot starts learning from scratch.', 'warn');
});
$('btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ policy: policy.toJSON(), config: cfg }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'friedriceomat-policy.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('importPolicy').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    policy = LinearPolicy.fromJSON(obj.policy ?? obj);
    if (obj.config) {
      cfg = mergeConfig(obj.config);
      saveJSON(CONFIG_KEY, cfg);
      renderControls();
      replan();
    }
    saveJSON(POLICY_KEY, policy.toJSON());
    weightMap.draw(policy.W);
    log(`Imported policy from ${file.name}.`, 'good');
  } catch (err) {
    log(`Import failed: ${err.message}`, 'bad');
  }
  e.target.value = '';
});
$('btnTheme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, root.dataset.theme); } catch { /* ignore */ }
  weightMap.draw(policy.W);
  redrawCurve();
});

bridge.addEventListener('status', (e) => {
  const { state, message } = e.detail;
  log(`Robot link: ${state}${message ? ` (${message})` : ''}`, state === 'open' ? 'good' : state === 'error' ? 'bad' : '');
  if (state === 'open') bridge.send({ type: 'plan', plan });
});
bridge.addEventListener('message', (e) => {
  if (e.detail.type === 'log') log(`Robot: ${e.detail.message}`);
});

$('manualButtons').replaceChildren(...ACTIONS.map((name, i) => el('button', {
  type: 'button',
  onclick: () => {
    manualQueue.push(i);
    if (!running && !training) {
      if (sim.done) newEpisode(true);
      stepping = true;
      setRunning(true);
    }
  },
}, ACTION_LABELS[name])));

// --------------------------------------------------------------- boot --

try {
  const theme = localStorage.getItem(THEME_KEY);
  if (theme) document.documentElement.dataset.theme = theme;
} catch { /* ignore */ }
renderControls();
renderPipeline();
applyPlan(plan);
weightMap.draw(policy.W);
redrawCurve();
log(policyFromStorage ? `Loaded saved policy (${policy.updates} updates).` : 'Policy pretrained by imitation of the expert controller.');
log(`Dish #${episodeNo}: ${plan.name}. Press Start.`);
lastDecision = (() => {
  const obs = observe();
  const mask = sim.actionMask();
  const f = featurize(obs, plan, sim.target, sim.cfg.maxTime);
  return { probs: policy.probs(f, mask, cfg.agent.temperature), mask, a: null, obs, f };
})();
renderDecision();
requestAnimationFrame(frame);
