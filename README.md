# friedriceomat

Control-room UI for a fried rice robot: a robot arm cooks in a wok. An AI
planner breaks the recipe into stages, and a reinforcement-learning policy
picks the arm's next move from its sensor readings.

The UI includes a kitchen simulator, so you can see how the system behaves,
change it, and train it without hardware. A WebSocket bridge lets the same UI
drive a real robot.

## Run

```bash
npm start        # http://localhost:8080 (PORT=... to change)
npm test         # simulator / planner / policy unit tests
```

There are no dependencies. Node 18 or newer is enough.

## What you see

| Area | What it shows |
|---|---|
| **Robot cell** | Animated side view: ingredient bowls, a 3-joint arm with a spatula (2-link inverse kinematics), the wok, burner flame, steam/smoke, the plate, and the IR/camera sensor mast. Joint angles are shown live. |
| **Control loop** | One decision per arm motion: Sensors → State encoder → Planner → Policy π(a\|s) → Safety shield → Arm controller. It lights up on every decision and shows the value passed along at each step. |
| **Charts** | Wok temperature (true, IR reading, stage target, shield limit); grain moisture, browning and mixing against the planner's targets; return and weighted quality. Hover any chart for exact values. |
| **Sensors** | Live readings, with markers for the targets. A disabled sensor shows "offline", and the policy then acts blind on a fallback value. |
| **Policy decision** | Action probabilities (actions that aren't possible right now are greyed out), the value estimate, entropy, and shield overrides. |
| **Plan** | The planner's stages with target temperatures and progress bars showing how cooked each stage is, plus the planner's reasoning. |
| **Dish quality** | Live and final score: texture, colour, wok hei, doneness, mixing, completeness. Flags raw protein, burning and spills. |
| **Training** | Train N episodes headless, rerun imitation pretraining, or reset to random weights. Shows the learning curve and a heatmap of the policy weights (hover for values). Export and import policy JSON. |

## Behaviour controls

- **Recipe & AI planner**: egg, Yangzhou, kimchi, nasi goreng, khao pad and
  pineapple fried rice. There is also **Custom**, where you describe the
  ingredients in free text. You can set crispness, smokiness (wok hei), spice
  level and servings.
- **RL policy**: autonomous or manual mode (in manual mode you choose each
  action, the policy's suggestion is highlighted, and your choices become
  demonstrations). You can also set softmax temperature, ε-exploration,
  learning rate, discount γ, and online learning from live dishes.
- **Reward shaping**: weights for taste, texture/colour, wok hei, safety and
  speed. Training changes what the robot optimises for.
- **Robot arm**: speed, toss intensity, stir vigour. Faster, harder tosses
  give more wok hei but risk spills.
- **Stove & ingredients**: burner strength and limit, rice moisture (day-old
  vs. fresh), time limit, and domain randomisation.
- **Sensors**: turn each sensor on or off, and set the noise level.
- **Safety shield**: maximum wok temperature and maximum smoke. When the
  shield overrides an action, that step is left out of the policy update.

Settings, the theme and the learned policy are kept in `localStorage`.

## How the control works

```
sensors ──► features (18) ──► linear softmax policy ──► safety shield ──► arm motion
                 ▲                      ▲
   planner: stage order, target temps,  │ REINFORCE with a learned baseline,
   dish targets (moisture/browning/     │ pretrained by imitating a hand-written
   wok hei) from recipe + preferences   │ expert controller
```

- `ui/js/planner.js` is the high-level planner. It is rule-based. To use your
  own AI model, replace `planRecipe(prefs)` with a call to that model and
  return the same plan shape (`stages[]` with `targetTemp`, `cook`, `grams`,
  plus `targets` and `finishTemp`).
- `ui/js/policy.js` holds the feature encoder, the expert, the linear policy,
  REINFORCE, behaviour cloning and the shield.
- `ui/js/sim.js` is the wok physics: heating, evaporation, browning, burning,
  clumping, mixing, wok hei, spills. It also produces the noisy sensor
  readings and the dish score and reward.
- `ui/js/arm.js` draws the arm and computes its kinematics. `ui/js/charts.js`
  draws the charts. `ui/js/main.js` wires the UI together.

## Connecting the real robot

Under **Robot link**, enter a WebSocket URL and connect. The UI sends JSON:

```json
{ "type": "plan", "plan": { "name": "...", "stages": [...], "targets": {...} } }
{ "type": "command", "action": "TOSS", "durationSec": 1.4, "burner": 0.6,
  "stage": "rice", "params": { "armSpeed": 1, "tossIntensity": 0.6, "stirVigor": 0.7 } }
```

The robot can send back:

```json
{ "type": "telemetry", "sensors": { "temp": 231, "moisture": 0.34, "browning": 0.22,
  "clump": 0.1, "mix": 0.9, "smoke": 0.02, "mass": 380 } }
{ "type": "log", "message": "gripper ok" }
```

With **Policy reads robot sensors** on, telemetry from the last 2 s replaces
the simulated readings the policy acts on. The simulator keeps running the
animation and the charts.
