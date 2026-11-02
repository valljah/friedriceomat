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

test('3D arm: forward kinematics reproduces the inverse-kinematics target', async () => {
  const { ARM, inverseKinematics, forwardKinematics, makePath, samplePath, fromCyl } = await import('../ui/js/kinematics.js');
  const targets = [
    { x: 0.5, y: 0.36, z: 0, p: -Math.PI / 2 },           // home above the wok
    { x: -0.3, y: 0.05, z: -0.46, p: -Math.PI / 2 + 0.2 }, // inside a bowl behind the arm
    { x: 0.62, y: 0.33, z: 0, p: -0.6 },                   // toss flick
    { x: 0.27, y: 0.1, z: 0.48, p: -0.5 },                 // over the plate
  ];
  for (const t of targets) {
    const j = inverseKinematics(t, t.p);
    assert.ok(j.reachable, `unreachable ${JSON.stringify(t)}`);
    const fk = forwardKinematics(j);
    assert.ok(Math.hypot(fk.tip.x - t.x, fk.tip.y - t.y, fk.tip.z - t.z) < 1e-9);
    assert.ok(Math.abs(fk.pitch - t.p) < 1e-9);
    assert.ok(fk.elbow.y > ARM.shoulderH - 0.05, 'elbow-up solution');
  }
  // Paths sweep around the base instead of through it.
  const path = makePath([{ yaw: 3, r: 0.55, y: 0.3, p: -1.5 }, { yaw: -3, r: 0.5, y: 0.3, p: -1.5 }]);
  for (let k = 0; k <= 10; k++) {
    const c = samplePath(path, k / 10);
    const pt = fromCyl(c);
    assert.ok(Math.hypot(pt.x, pt.z) > 0.49);
  }
  assert.ok(Math.abs(path.pts[1].yaw - path.pts[0].yaw) < Math.PI);
});

test('wok toss: every waypoint is reachable and the grasp lands on the handle', async () => {
  const k = await import('../ui/js/kinematics.js');
  const home = { yaw: 0, r: 0.5, y: 0.36, p: -Math.PI / 2 };
  const fresh = k.tossWaypoints(home, false);
  const again = k.tossWaypoints(fresh[fresh.length - 1], true);
  const release = k.releaseWaypoints(again[again.length - 1]);
  for (const pt of [...fresh, ...again, ...release]) {
    const j = k.inverseKinematics(k.fromCyl(pt), pt.p);
    assert.ok(j.reachable, `unreachable ${JSON.stringify(pt)}`);
  }
  const grasp = fresh.find((p) => p.grasp);
  const fk = k.forwardKinematics(k.inverseKinematics(k.fromCyl(grasp), grasp.p));
  // Fingers sit GRIP metres from the wrist along the tool.
  const fingers = {
    x: fk.wrist.x + k.GRIP * Math.cos(fk.pitch),
    y: fk.wrist.y + k.GRIP * Math.sin(fk.pitch),
  };
  const g = k.handleGrip();
  assert.ok(Math.hypot(fingers.x - g.r, fingers.y - g.y) < 1e-9);
  assert.equal(fresh.filter((p) => p.flick).length, 1);
  assert.equal(again.filter((p) => p.flick).length, 2);
  assert.ok(!again.some((p) => p.grasp), 'no second grasp while holding');
  assert.ok(release.some((p) => p.release));
  // The wok returns exactly to the grasp pose so it lands back on the burner.
  const last = again[again.length - 1];
  assert.deepEqual([last.r, last.y, last.p], [grasp.r, grasp.y, grasp.p]);
});

test('rigid inverse undoes a rotation + translation', async () => {
  const { mat4 } = await import('../ui/js/gl3d.js');
  const m = mat4.mul(mat4.translation(0.3, -0.2, 0.5), mat4.rotY(0.7), mat4.rotZ(-1.1), mat4.rotX(0.4));
  const id = mat4.multiply(mat4.invertRigid(m), m);
  const ident = mat4.identity();
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(id[i] - ident[i]) < 1e-6);
});
