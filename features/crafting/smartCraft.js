'use strict';
// ===============================
// features/crafting/smartCraft.js — v6
// 📚 Рецепты (RU→ингредиенты) + ИИ‑планировщик:
//   • строгая проверка ресурсов с количеством и категориями (#planks/#logs)
//   • предложения, что можно/почти можно скрафтить
//   • построение упорядоченного плана крафта (подкомпоненты → итог)
//   • кэш инвентаря, быстрые проверки, дружба с crafting.js
// CommonJS, совместимо с автоКрафтом и прежними импортами
// ===============================

const { craftItem, ruToId } = require('./crafting.js');

// ————————————————————————————————————————————————————————————————————————
// Категории (используются в проверках и планах)
// ————————————————————————————————————————————————————————————————————————
const CATS = {
  '#logs': new Set(['oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log','pale_oak_log','bamboo_block']),
  '#planks': new Set(['oak_planks','spruce_planks','birch_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks','pale_oak_planks','bamboo_planks'])
};

// ————————————————————————————————————————————————————————————————————————
// Рецепты (ключ — РУССКОЕ НАЗВАНИЕ цели), значения — массив ингредиентов.
// Ингредиент может быть строкой ('oak_planks') или объектом { id, count } или
// категорией ('#planks'). Для совместимости автоКрафта — оставляем строки.
// ————————————————————————————————————————————————————————————————————————
const recipes = {
  // базовые материалы/инструменты
  'палка': ['#planks'],
  'верстак': ['#planks'],
  'сундук': ['#planks'],
  'факел': ['stick','coal'],
  'печь': ['cobblestone'],
  'лестница': ['#planks'],
  'табличка': ['#planks','stick'],
  'дверь': ['#planks'],
  'лодка': ['#planks'],

  // инструменты
  'деревянная кирка': ['#planks','stick'],
  'каменная кирка': ['cobblestone','stick'],
  'железная кирка': ['iron_ingot','stick'],
  'алмазная кирка': ['diamond','stick'],
  'золотая кирка': ['gold_ingot','stick'],

  'деревянный топор': ['#planks','stick'],
  'каменный топор': ['cobblestone','stick'],
  'железный топор': ['iron_ingot','stick'],
  'алмазный топор': ['diamond','stick'],
  'золотой топор': ['gold_ingot','stick'],

  'железная лопата': ['iron_ingot','stick'],
  'каменная лопата': ['cobblestone','stick'],
  'алмазная лопата': ['diamond','stick'],
  'деревянная лопата': ['#planks','stick'],

  'деревянная мотыга': ['#planks','stick'],
  'каменная мотыга': ['cobblestone','stick'],
  'железная мотыга': ['iron_ingot','stick'],
  'алмазная мотыга': ['diamond','stick'],

  // оружие/щит
  'деревянный меч': ['#planks','stick'],
  'каменный меч': ['cobblestone','stick'],
  'железный меч': ['iron_ingot','stick'],
  'алмазный меч': ['diamond','stick'],
  'золотой меч': ['gold_ingot','stick'],
  'лук': ['string','stick'],
  'стрела': ['flint','stick','feather'],
  'щит': ['iron_ingot','#planks'],

  // броня
  'кожаная шапка': ['leather'],
  'кожаный нагрудник': ['leather'],
  'кожаные штаны': ['leather'],
  'кожаные ботинки': ['leather'],

  'железный шлем': ['iron_ingot'],
  'железный нагрудник': ['iron_ingot'],
  'железные штаны': ['iron_ingot'],
  'железные ботинки': ['iron_ingot'],

  'алмазный шлем': ['diamond'],
  'алмазный нагрудник': ['diamond'],
  'алмазные штаны': ['diamond'],
  'алмазные ботинки': ['diamond'],

  // еда/разное
  'хлеб': ['wheat'],
  'жареная свинина': ['porkchop'],
  'жареная говядина': ['beef'],
  'жареная курица': ['chicken'],
  'печёная картошка': ['potato'],
  'тыквенный пирог': ['pumpkin','egg','sugar'],
  'торт': ['milk_bucket','egg','sugar','wheat'],
  'золотое яблоко': ['apple','gold_ingot'],
  'морковь по-деревенски': ['carrot','gold_nugget'],

  // редстоун
  'рычаг': ['cobblestone','stick'],
  'кнопка': ['#planks'],
  'плита': ['#planks'],
  'наблюдатель': ['quartz','redstone','cobblestone'],
  'поршень': ['iron_ingot','redstone','#planks','cobblestone'],
  'раздатчик': ['bow','redstone','cobblestone'],
  'повторитель': ['redstone_torch','redstone','stone'],

  // декор/сон
  'кровать': ['white_wool','#planks'],
  'ковёр': ['white_wool'],
  'цветочный горшок': ['brick'],
  'рамка': ['stick','leather'],
  'картина': ['stick','white_wool']
};

// ————————————————————————————————————————————————————————————————————————
// Инвентарь: быстрый счётчик + кэш на кадр
// ————————————————————————————————————————————————————————————————————————
let _invCache = null, _invCacheAt = 0;
function inv(bot){
  const t = Date.now();
  if (_invCache && t - _invCacheAt < 150) return _invCache;
  const map = new Map();
  try {
    for (const it of bot.inventory.items()){
      map.set(it.name, (map.get(it.name)||0) + it.count);
    }
  } catch {}
  _invCache = map; _invCacheAt = t; return map;
}

function countOf(bot, idOrCat){
  const bag = inv(bot);
  if (idOrCat.startsWith && idOrCat.startsWith('#')){
    const set = CATS[idOrCat]; if (!set) return 0;
    let s = 0; for (const n of set) s += (bag.get(n)||0); return s;
  }
  return bag.get(idOrCat)||0;
}

function normalizeIng(ing){
  if (!ing) return null;
  if (typeof ing === 'string') return { id: ing, count: 1 };
  if (typeof ing === 'object' && ing.id) return { id: ing.id, count: Math.max(1, ing.count|0) };
  return null;
}

function canCraft(bot, ingredients){
  try {
    const norm = (ingredients||[]).map(normalizeIng).filter(Boolean);
    for (const i of norm){ if (countOf(bot, i.id) < i.count) return false; }
    return true;
  } catch { return false; }
}

// ————————————————————————————————————————————————————————————————————————
// Подсказки: что можно/почти можно скрафтить (до 2 недостающих позиций)
// ————————————————————————————————————————————————————————————————————————
function suggestCraftable(bot){
  const can = [], almost = [];
  for (const [ru, ing] of Object.entries(recipes)){
    const norm = ing.map(normalizeIng);
    let miss = 0;
    for (const i of norm){ if (countOf(bot, i.id) < i.count) miss++; }
    if (miss === 0) can.push(ru); else if (miss <= 2) almost.push(ru);
  }
  if (can.length){
    const short = can.slice(0, 12).join(', ') + (can.length>12?' …':'');
    try { bot.chat('🧠 Могу сейчас скрафтить: ' + short); } catch {}
    try { bot.chat('✏️ Напиши: хелпбот скрафти <название>'); } catch {}
  } else {
    try { bot.chat('😕 Сейчас ничего не могу скрафтить — не хватает материалов.'); } catch {}
  }
  if (almost.length){
    const short = almost.slice(0, 8).join(', ') + (almost.length>8?' …':'');
    try { bot.chat('💡 Почти хватает на: ' + short); } catch {}
  }
  return can;
}

// ————————————————————————————————————————————————————————————————————————
// Построение плана крафта: массив шагов [{ ruName, amount } ...]
// Учитывает подкомпоненты, если на них есть рецепт в этом файле
// ————————————————————————————————————————————————————————————————————————
const _idToRuFromRecipes = (()=>{
  const m = new Map();
  for (const ru of Object.keys(recipes)){
    const id = ruToId(ru); if (id) m.set(id, ru);
  }
  return m;
})();

function craftableRuById(itemId){ return _idToRuFromRecipes.get(itemId) || null; }

function aggregatePush(list, ruName, amt){
  const e = list.find(x=> x.ruName===ruName); if (e) e.amount += amt; else list.push({ ruName, amount: amt });
}

function buildCraftPlan(ruName, amount=1, _stack=new Set()){
  const plan = [];
  const rec = recipes[ruName];
  if (!rec){ plan.push({ ruName, amount }); return plan; }
  if (_stack.has(ruName)) { plan.push({ ruName, amount }); return plan; }
  _stack.add(ruName);

  // разложим ингредиенты
  for (const ing of rec){
    const n = normalizeIng(ing); if (!n) continue;
    const subRu = craftableRuById(n.id);
    if (subRu){
      const subSteps = buildCraftPlan(subRu, n.count*amount, _stack);
      for (const s of subSteps) aggregatePush(plan, s.ruName, s.amount);
    } else {
      // базовый ресурс — просто учитываем (для анализа недостачи)
      aggregatePush(plan, `#RAW:${n.id}`, n.count*amount);
    }
  }
  // сам конечный предмет в самый конец
  aggregatePush(plan, ruName, amount);
  return plan;
}

// ————————————————————————————————————————————————————————————————————————
// Вспомогательное: что именно НЕ хватает для цели (с количеством)
// ————————————————————————————————————————————————————————————————————————
function missingFor(bot, ruName, amount=1){
  const rec = recipes[ruName]; if (!rec) return [];
  const miss = [];
  for (const ing of rec){
    const i = normalizeIng(ing); if (!i) continue;
    const have = countOf(bot, i.id);
    const need = i.count * amount;
    if (have < need) miss.push({ id: i.id, need: need - have });
  }
  return miss; // [{id, need}]
}

// ————————————————————————————————————————————————————————————————————————
// Автокрафт всего доступного (совместимость со старой функцией)
// ————————————————————————————————————————————————————————————————————————
async function autoCraftAvailable(bot){
  const can = suggestCraftable(bot);
  if (!can.length) return;
  for (const ru of can){
    try {
      bot.chat(`⚙️ Пробую скрафтить ${ru}...`);
      await craftItem(bot, ru);
    } catch {}
  }
  try { bot.chat('✅ Всё, что мог — скрафтил!'); } catch {}
}

module.exports = {
  recipes,
  canCraft,
  suggestCraftable,
  buildCraftPlan,
  missingFor,
  autoCraftAvailable,
  CATS
};
