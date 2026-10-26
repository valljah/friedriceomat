// Ingredient catalogue and built-in recipes.
//
// Every ingredient belongs to a category. The category decides where it goes
// in the cooking order and how hot the wok should be before it is added.
// `mass` is grams per serving, `water` is the moisture it brings into the wok,
// `cook` is the number of seconds it needs above ~120 °C to be done.

export const CATEGORIES = {
  fat:      { order: 0, targetTemp: 200, label: 'Fat' },
  aromatic: { order: 1, targetTemp: 170, label: 'Aromatic' },
  egg:      { order: 2, targetTemp: 190, label: 'Egg' },
  protein:  { order: 3, targetTemp: 230, label: 'Protein' },
  vegHard:  { order: 4, targetTemp: 220, label: 'Firm veg' },
  rice:     { order: 5, targetTemp: 240, label: 'Rice' },
  veg:      { order: 6, targetTemp: 230, label: 'Veg' },
  vegSoft:  { order: 7, targetTemp: 215, label: 'Soft veg / fruit' },
  sauce:    { order: 8, targetTemp: 240, label: 'Sauce' },
  garnish:  { order: 9, targetTemp: 200, label: 'Garnish' },
};

export const INGREDIENTS = {
  oil:        { label: 'Oil',          category: 'fat',      mass: 15,  water: 0,    cook: 0,  color: '#f2c94c', aliases: ['oil', 'lard', 'butter'] },
  garlic:     { label: 'Garlic',       category: 'aromatic', mass: 10,  water: 0.6,  cook: 8,  color: '#efe6cf', aliases: ['garlic'] },
  shallot:    { label: 'Shallot',      category: 'aromatic', mass: 15,  water: 0.8,  cook: 12, color: '#c98fa0', aliases: ['shallot', 'shallots'] },
  ginger:     { label: 'Ginger',       category: 'aromatic', mass: 8,   water: 0.8,  cook: 8,  color: '#e0b96a', aliases: ['ginger'] },
  chili:      { label: 'Chili',        category: 'aromatic', mass: 6,   water: 0.8,  cook: 6,  color: '#d33f2f', aliases: ['chili', 'chilli', 'chile', 'pepper flakes'], spicy: true },
  egg:        { label: 'Egg',          category: 'egg',      mass: 50,  water: 0.75, cook: 15, color: '#f5d547', aliases: ['egg', 'eggs'] },
  shrimp:     { label: 'Shrimp',       category: 'protein',  mass: 60,  water: 0.75, cook: 40, color: '#f29a76', aliases: ['shrimp', 'prawn', 'prawns'] },
  chicken:    { label: 'Chicken',      category: 'protein',  mass: 70,  water: 0.7,  cook: 60, color: '#e8c9a0', aliases: ['chicken'] },
  pork:       { label: 'Pork',         category: 'protein',  mass: 70,  water: 0.65, cook: 50, color: '#d79b85', aliases: ['pork', 'bacon'] },
  char_siu:   { label: 'Char siu',     category: 'protein',  mass: 50,  water: 0.5,  cook: 15, color: '#b5452f', aliases: ['char siu', 'bbq pork', 'ham', 'spam', 'lap cheong', 'sausage'] },
  beef:       { label: 'Beef',         category: 'protein',  mass: 70,  water: 0.65, cook: 35, color: '#9c4a3a', aliases: ['beef', 'steak'] },
  tofu:       { label: 'Tofu',         category: 'protein',  mass: 60,  water: 0.8,  cook: 30, color: '#f4ecd4', aliases: ['tofu'] },
  carrot:     { label: 'Carrot',       category: 'vegHard',  mass: 30,  water: 0.85, cook: 35, color: '#f08a24', aliases: ['carrot', 'carrots'] },
  onion:      { label: 'Onion',        category: 'vegHard',  mass: 40,  water: 0.85, cook: 30, color: '#d9c8e8', aliases: ['onion', 'onions'] },
  peas:       { label: 'Peas',         category: 'veg',      mass: 30,  water: 0.75, cook: 20, color: '#7cb342', aliases: ['peas', 'pea', 'edamame'] },
  corn:       { label: 'Corn',         category: 'veg',      mass: 30,  water: 0.7,  cook: 15, color: '#f4d03f', aliases: ['corn', 'sweetcorn'] },
  kimchi:     { label: 'Kimchi',       category: 'veg',      mass: 60,  water: 0.85, cook: 25, color: '#d6452f', aliases: ['kimchi'], spicy: true },
  bok_choy:   { label: 'Bok choy',     category: 'veg',      mass: 40,  water: 0.95, cook: 15, color: '#4caf50', aliases: ['bok choy', 'pak choi', 'greens', 'cabbage'] },
  pineapple:  { label: 'Pineapple',    category: 'vegSoft',  mass: 50,  water: 0.86, cook: 10, color: '#f7d046', aliases: ['pineapple'] },
  tomato:     { label: 'Tomato',       category: 'vegSoft',  mass: 40,  water: 0.94, cook: 10, color: '#e5533d', aliases: ['tomato', 'tomatoes'] },
  rice:       { label: 'Rice',         category: 'rice',     mass: 250, water: null, cook: 60, color: '#f7f3e8', aliases: ['rice'] },
  soy:        { label: 'Soy sauce',    category: 'sauce',    mass: 10,  water: 0.7,  cook: 5,  color: '#4a2c1a', aliases: ['soy', 'soy sauce'] },
  kecap:      { label: 'Kecap manis',  category: 'sauce',    mass: 15,  water: 0.3,  cook: 5,  color: '#2b1608', aliases: ['kecap', 'kecap manis', 'sweet soy'] },
  fish_sauce: { label: 'Fish sauce',   category: 'sauce',    mass: 8,   water: 0.7,  cook: 5,  color: '#a8742c', aliases: ['fish sauce', 'nam pla'] },
  gochujang:  { label: 'Gochujang',    category: 'sauce',    mass: 15,  water: 0.4,  cook: 8,  color: '#b3261e', aliases: ['gochujang', 'chili paste', 'sambal'], spicy: true },
  oyster:     { label: 'Oyster sauce', category: 'sauce',    mass: 10,  water: 0.6,  cook: 5,  color: '#5b3a24', aliases: ['oyster sauce', 'oyster'] },
  scallion:   { label: 'Scallion',     category: 'garnish',  mass: 8,   water: 0.9,  cook: 3,  color: '#5fae4e', aliases: ['scallion', 'scallions', 'spring onion', 'green onion'] },
  basil:      { label: 'Thai basil',   category: 'garnish',  mass: 5,   water: 0.9,  cook: 3,  color: '#2f8f3a', aliases: ['basil'] },
  cashew:     { label: 'Cashew',       category: 'garnish',  mass: 15,  water: 0.05, cook: 5,  color: '#e3c08d', aliases: ['cashew', 'cashews', 'peanut', 'peanuts'] },
};

// Targets describe the finished dish: grain moisture (lower = drier, more
// separate grains), browning (0 = pale, 1 = dark) and wok hei (smoky char).
export const RECIPES = {
  egg: {
    name: 'Egg fried rice',
    ingredients: ['oil', 'garlic', 'egg', 'rice', 'soy', 'scallion'],
    targets: { moisture: 0.30, browning: 0.30, wokHei: 0.45 },
  },
  yangzhou: {
    name: 'Yangzhou fried rice',
    ingredients: ['oil', 'egg', 'shrimp', 'char_siu', 'carrot', 'rice', 'peas', 'soy', 'scallion'],
    targets: { moisture: 0.30, browning: 0.28, wokHei: 0.5 },
  },
  kimchi: {
    name: 'Kimchi fried rice',
    ingredients: ['oil', 'pork', 'onion', 'rice', 'kimchi', 'gochujang', 'scallion'],
    targets: { moisture: 0.36, browning: 0.4, wokHei: 0.35 },
  },
  nasi_goreng: {
    name: 'Nasi goreng',
    ingredients: ['oil', 'shallot', 'garlic', 'chili', 'chicken', 'rice', 'kecap', 'egg'],
    targets: { moisture: 0.28, browning: 0.55, wokHei: 0.45 },
  },
  khao_pad: {
    name: 'Khao pad (Thai)',
    ingredients: ['oil', 'garlic', 'chicken', 'egg', 'onion', 'rice', 'tomato', 'fish_sauce', 'scallion'],
    targets: { moisture: 0.32, browning: 0.3, wokHei: 0.5 },
  },
  pineapple: {
    name: 'Pineapple fried rice',
    ingredients: ['oil', 'garlic', 'shrimp', 'onion', 'rice', 'pineapple', 'soy', 'cashew'],
    targets: { moisture: 0.33, browning: 0.32, wokHei: 0.4 },
  },
  custom: {
    name: 'Custom',
    ingredients: [],
    targets: { moisture: 0.31, browning: 0.35, wokHei: 0.45 },
  },
};

// Find ingredient ids mentioned in free text ("2 eggs, leftover rice, spam").
// Longest aliases match first and consume their words, so "spring onion" is a
// scallion and not also an onion.
export function parseIngredients(text) {
  let lower = ` ${text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ')} `;
  const aliases = Object.entries(INGREDIENTS)
    .flatMap(([id, ing]) => ing.aliases.map((alias) => ({ id, alias })))
    .sort((a, b) => b.alias.length - a.alias.length);
  const found = [];
  for (const { id, alias } of aliases) {
    const needle = ` ${alias} `;
    if (!lower.includes(needle)) continue;
    lower = lower.split(needle).join(' | ');
    if (!found.includes(id)) found.push(id);
  }
  // Keep the order the user wrote them in.
  const pos = (id) => Math.min(...INGREDIENTS[id].aliases.map((a) => text.toLowerCase().indexOf(a)).filter((i) => i >= 0));
  return found.sort((a, b) => pos(a) - pos(b));
}
