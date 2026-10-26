import test from 'node:test';
import assert from 'node:assert/strict';
import { planRecipe } from '../ui/js/planner.js';
import { parseIngredients } from '../ui/js/recipes.js';
import { A, DEFAULT_REWARD, DEFAULT_SENSORS, WokSim, mulberry32, runAction } from '../ui/js/sim.js';
import { FEATURES, LinearPolicy, applyShield, featurize, pretrain, runEpisode } from '../ui/js/policy.js';

const opts = (rng) => ({ reward: DEFAULT_REWARD, sensors: DEFAULT_SENSORS, rng, shield: { enabled: true, maxTemp: 285, maxSmoke: 0.4 } });

test('planner orders stages by category and always includes oil and rice', () => {
  const plan = planRecipe({ recipe: 'custom', customText: 'soy sauce, 2 eggs, garlic, peas' });
  const ids = plan.stages.map((s) => s.id);
  assert.equal(ids[0], 'oil');
  assert.ok(ids.includes('rice'));
  assert.ok(ids.indexOf('garlic') < ids.indexOf('egg'));
  assert.ok(ids.indexOf('rice') < ids.indexOf('soy'));
});

test('crispness lowers the moisture target and raises browning', () => {
  const soft = planRecipe({ recipe: 'egg', crispness: 0 });
  const crisp = planRecipe({ recipe: 'egg', crispness: 1 });
  assert.ok(crisp.targets.moisture < soft.targets.moisture);
  assert.ok(crisp.targets.browning > soft.targets.browning);
});

test('spice level 0 removes spicy ingredients', () => {
  const plan = planRecipe({ recipe: 'kimchi', spice: 0 });
  assert.ok(!plan.stages.some((s) => s.id === 'kimchi' || s.id === 'gochujang'));
});

test('parseIngredients matches aliases', () => {
  assert.deepEqual(parseIngredients('Prawns and spring onion').sort(), ['scallion', 'shrimp']);
});

test('burner heats the empty wok and adding rice cools it', () => {
  const sim = new WokSim(planRecipe({ recipe: 'egg' }), { randomize: false }, mulberry32(1));
  for (let i = 0; i < 6; i++) runAction(sim, A.HEAT_UP, DEFAULT_REWARD);
  for (let i = 0; i < 10; i++) runAction(sim, A.STIR, DEFAULT_REWARD);
  assert.ok(sim.s.T > 200, `wok only reached ${sim.s.T}`);
  while (sim.plan.stages[sim.s.next].id !== 'rice') sim.addIngredient(sim.s.next);
  const before = sim.s.T;
  sim.addIngredient(sim.s.next);
  assert.ok(sim.s.T < before - 20);
  assert.ok(sim.s.clump > 0.3);
});

test('action mask only allows plating once everything is added', () => {
  const sim = new WokSim(planRecipe({ recipe: 'egg' }), {}, mulberry32(2));
  assert.equal(sim.actionMask()[A.PLATE], false);
  assert.equal(sim.actionMask()[A.ADD], true);
  while (sim.pending) sim.addIngredient(sim.s.next);
  assert.equal(sim.actionMask()[A.PLATE], true);
  assert.equal(sim.actionMask()[A.ADD], false);
});

test('shield turns the heat down above the limit', () => {
  const sim = new WokSim(planRecipe({ recipe: 'egg' }), {}, mulberry32(3));
  sim.s.burner = 0.9;
  const out = applyShield(A.HEAT_UP, { temp: 300, smoke: 0 }, sim, { enabled: true, maxTemp: 285, maxSmoke: 0.4 });
  assert.equal(out.a, A.HEAT_DOWN);
  assert.ok(out.reason);
});

test('expert controller cooks a decent dish', () => {
  const rng = mulberry32(4);
  const sim = new WokSim(planRecipe({ recipe: 'yangzhou' }), {}, rng);
  const res = runEpisode(sim, null, { ...opts(rng), controller: 'expert' });
  assert.ok(res.quality.completeness === 1);
  assert.ok(res.quality.score > 50, `score ${res.quality.score}`);
});

test('imitation pretraining yields a working policy, RL updates stay finite', () => {
  const rng = mulberry32(5);
  const plan = planRecipe({ recipe: 'egg' });
  const policy = new LinearPolicy();
  policy.randomize(rng, 0.01);
  pretrain(policy, () => new WokSim(plan, {}, rng), { sensors: DEFAULT_SENSORS, rng });
  let total = 0;
  for (let i = 0; i < 5; i++) {
    const res = runEpisode(new WokSim(plan, {}, rng), policy, opts(rng));
    total += res.quality.score;
    policy.reinforce(res.traj, { lr: 0.01, gamma: 0.98 });
  }
  assert.ok(total / 5 > 55, `avg score ${total / 5}`);
  assert.ok(policy.W.flat().every(Number.isFinite));
  const copy = LinearPolicy.fromJSON(JSON.parse(JSON.stringify(policy.toJSON())));
  assert.deepEqual(copy.W, policy.W);
});

test('features have the documented length and survive disabled sensors', () => {
  const sim = new WokSim(planRecipe({ recipe: 'egg' }), {}, mulberry32(6));
  const obs = sim.readSensors({ ...DEFAULT_SENSORS, thermal: false, camera: false, steam: false, voc: false, load: false });
  const f = featurize(obs, sim.plan, sim.target, sim.cfg.maxTime);
  assert.equal(f.length, FEATURES.length);
  assert.ok(f.every(Number.isFinite));
});
