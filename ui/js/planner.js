// High-level recipe planner.
//
// Turns a recipe + user preferences into an ordered list of stages with
// target wok temperatures and dish targets. The RL policy is the low-level
// controller that executes this plan. This rule-based planner is a stand-in:
// swap `planRecipe` for a call to your own AI model as long as it returns the
// same plan shape.

import { CATEGORIES, INGREDIENTS, RECIPES, parseIngredients } from './recipes.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const DEFAULT_PREFS = {
  recipe: 'egg',
  customText: 'leftover rice, 2 eggs, spam, peas, garlic, soy sauce, scallion',
  crispness: 0.5, // 0 = soft and moist, 1 = dry and crispy
  smokiness: 0.5, // desired wok hei
  spice: 1,       // 0..3, scales spicy ingredients
  servings: 1,
};

export function planRecipe(prefs = DEFAULT_PREFS) {
  const recipe = RECIPES[prefs.recipe] ?? RECIPES.egg;
  const notes = [];
  let ids = recipe.ingredients.slice();

  if (prefs.recipe === 'custom') {
    ids = parseIngredients(prefs.customText ?? '');
    notes.push(`Parsed ${ids.length} ingredient(s) from the custom description.`);
  }
  if (!ids.includes('rice')) {
    ids.push('rice');
    notes.push('No rice found, so rice was added.');
  }
  if (!ids.includes('oil')) {
    ids.unshift('oil');
    notes.push('No fat found, so oil was added first.');
  }

  // Stable sort by category order keeps the recipe's order inside a category.
  const ordered = ids
    .map((id, i) => ({ id, i }))
    .sort((a, b) =>
      CATEGORIES[INGREDIENTS[a.id].category].order - CATEGORIES[INGREDIENTS[b.id].category].order || a.i - b.i)
    .map(({ id }) => id);
  if (ordered.join() !== ids.join()) notes.push('Reordered stages by category: fat, aromatics, egg, protein, firm veg, rice, veg, sauce, garnish.');

  const crisp = clamp(prefs.crispness ?? 0.5, 0, 1);
  const smoke = clamp(prefs.smokiness ?? 0.5, 0, 1);
  const servings = clamp(Math.round(prefs.servings ?? 1), 1, 4);
  const spice = clamp(prefs.spice ?? 1, 0, 3);

  const targets = {
    moisture: clamp(recipe.targets.moisture + (0.5 - crisp) * 0.12, 0.18, 0.45),
    browning: clamp(recipe.targets.browning + (crisp - 0.5) * 0.2, 0.1, 0.75),
    wokHei: clamp(recipe.targets.wokHei + (smoke - 0.5) * 0.5, 0.05, 0.95),
  };
  notes.push(`Crispness ${crisp.toFixed(2)} → moisture target ${targets.moisture.toFixed(2)}, browning target ${targets.browning.toFixed(2)}.`);
  notes.push(`Smokiness ${smoke.toFixed(2)} → wok hei target ${targets.wokHei.toFixed(2)}.`);

  const finishTemp = Math.round(230 + smoke * 25);
  const stages = ordered.map((id) => {
    const ing = INGREDIENTS[id];
    const cat = CATEGORIES[ing.category];
    let grams = ing.mass * servings;
    if (ing.spicy) grams *= spice;
    let targetTemp = cat.targetTemp;
    if (ing.category === 'rice') targetTemp = Math.round(targetTemp + smoke * 15);
    return {
      id,
      label: ing.label,
      category: ing.category,
      color: ing.color,
      grams: Math.round(grams),
      water: ing.water,
      cook: ing.cook,
      targetTemp,
    };
  }).filter((s) => s.grams > 0 || s.category === 'fat');

  const slow = stages.filter((s) => s.category === 'protein' && s.cook >= 40);
  for (const s of slow) notes.push(`${s.label} needs ~${s.cook} s above 120 °C; the policy should cook it through before adding rice.`);
  if (spice === 0 && ordered.some((id) => INGREDIENTS[id].spicy)) notes.push('Spice level 0: spicy ingredients removed.');
  if (servings > 1) notes.push(`${servings} servings: more thermal mass, the wok will recover heat more slowly.`);

  return {
    name: prefs.recipe === 'custom' ? 'Custom fried rice' : recipe.name,
    stages,
    targets,
    finishTemp,
    servings,
    notes,
  };
}
