'use strict';
// ===============================
// features/crafting/crafting.js — v9.0
// 🛠️ Смарт-крафт (Mineflayer)
//  • ru→id, синонимы, кеш рецептов
//  • автоподготовка: брёвна→доски, доски→палка, *_ingot → smelting
//  • НОВОЕ: автокрафт/автоустановка верстака (если рядом нет)
//  • НОВОЕ: автокрафт факелов: бревно→уголь(древ.) через печь → факел
//  • НОВОЕ: автопоиск/крафт печи (если нужно для угля)
//  • безопасный craftSafe с ретраями и таймаутами
//  • «человечные» паузы (Quantum если есть), дружелюбные сообщения
// ===============================

const { addExp } = require('../leveling.js');
const { state }  = require('../../core/state.cjs');

let Q = null;
try { Q = require('../ai/quantum'); } catch { Q = null; }
let xpApi = null;
try { xpApi = require('../ai/xpHelpers.cjs'); } catch { xpApi = null; }

const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const between = (a,b)=> a + (Q?.quantumRandom?.() ?? Math.random()) * (b - a);
const humanDelay = async (ms)=> { try { if (Q?.humanDelay) return await Q.humanDelay(ms); } catch {} await sleep(ms); };
const jitter = ()=> between(80, 250);
function say(bot, msg){ try { bot.chat(msg); } catch {} }
function items(bot){ try { return bot.inventory.items(); } catch { return []; } }
function countItem(bot, name){ return items(bot).filter(i=> i.name===name).reduce((s,i)=>s+i.count,0); }
function hasItem(bot, name, n=1){ return countItem(bot, name) >= n; }
function findAny(bot, names){ try { return items(bot).find(i=> names.includes(i.name)) || null; } catch { return null; } }

const RU_MAP = {
  'деревянная кирка':'wooden_pickaxe','каменная кирка':'stone_pickaxe','железная кирка':'iron_pickaxe','алмазная кирка':'diamond_pickaxe','золотая кирка':'golden_pickaxe','незеритовая кирка':'netherite_pickaxe',
  'деревянный топор':'wooden_axe','каменный топор':'stone_axe','железный топор':'iron_axe','алмазный топор':'diamond_axe','золотой топор':'golden_axe','незеритовый топор':'netherite_axe',
  'деревянная лопата':'wooden_shovel','каменная лопата':'stone_shovel','железная лопата':'iron_shovel','алмазная лопата':'diamond_shovel','золотая лопата':'golden_shovel','незеритовая лопата':'netherite_shovel',
  'деревянная мотыга':'wooden_hoe','каменная мотыга':'stone_hoe','железная мотыга':'iron_hoe','алмазная мотыга':'diamond_hoe','золотая мотыга':'golden_hoe','незеритовая мотыга':'netherite_hoe',
  'деревянный меч':'wooden_sword','каменный меч':'stone_sword','железный меч':'iron_sword','алмазный меч':'diamond_sword','золотой меч':'golden_sword','незеритовый меч':'netherite_sword',
  'лук':'bow','стрела':'arrow','арбалет':'crossbow','щит':'shield',
  'кожаная шапка':'leather_helmet','кожаный нагрудник':'leather_chestplate','кожаные штаны':'leather_leggings','кожаные ботинки':'leather_boots',
  'железный шлем':'iron_helmet','железный нагрудник':'iron_chestplate','железные штаны':'iron_leggings','железные ботинки':'iron_boots',
  'алмазный шлем':'diamond_helmet','алмазный нагрудник':'diamond_chestplate','алмазные штаны':'diamond_leggings','алмазные ботинки':'diamond_boots',
  'золотой шлем':'golden_helmet','золотой нагрудник':'golden_chestplate','золотые штаны':'golden_leggings','золотые ботинки':'golden_boots',
  'незеритовый шлем':'netherite_helmet','незеритовый нагрудник':'netherite_chestplate','незеритовые штаны':'netherite_leggings','незеритовые ботинки':'netherite_boots',
  'хлеб':'bread','яблоко':'apple','золотое яблоко':'golden_apple','жареная свинина':'cooked_porkchop','жареная говядина':'cooked_beef','жареная курица':'cooked_chicken','тушёная кролятина':'cooked_rabbit','картошка':'potato','печёная картошка':'baked_potato','морковь':'carrot','золотая морковь':'golden_carrot','тыквенный пирог':'pumpkin_pie','торт':'cake',
  'верстак':'crafting_table','печь':'furnace','сундук':'chest','факел':'torch','палка':'stick','доски':'oak_planks','табличка':'oak_sign','лодка':'oak_boat','лестница':'ladder','карта':'map','компас':'compass','часы':'clock'
};
const RU_SYNONYMS = [
  [/^дубовы(е|е\s+доски)$|^доски(\s+дуба)?$/,'oak_planks'],
  [/^бревн[оа]$/,'oak_log'],
  [/^палк[аи]$/,'stick'],
  [/^верстак(.*)?$/,'crafting_table'],
  [/^кирка\s+каменн(ая|ую)$/,'stone_pickaxe'],
];
function ruToId(s){
  const raw = String(s||'').toLowerCase().trim();
  if (RU_MAP[raw]) return RU_MAP[raw];
  for (const [re,id] of RU_SYNONYMS) if (re.test(raw)) return id;
  return null;
}
function getItemList(){
  return [
    '⚒️ Инструменты: кирки/топоры/лопаты/мотыги (дерево→незерит)',
    '⚔️ Оружие: мечи, лук/арбалет, стрелы, щит',
    '🛡️ Броня: кожа, железо, золото, алмаз, незерит',
    '🍖 Еда: хлеб, мясо, рыба, картофель, пироги, торт',
    '🔧 Разное: верстак, печь, сундук, факелы, лодка, компас, часы'
  ].join('\n');
}

// группы
const LOGS   = ['oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log','pale_oak_log','bamboo_block'];
const PLANKS = ['oak_planks','spruce_planks','birch_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks','pale_oak_planks','bamboo_planks'];
const LOG_TO_PLANK = {
  oak_log:'oak_planks', spruce_log:'spruce_planks', birch_log:'birch_planks', jungle_log:'jungle_planks',
  acacia_log:'acacia_planks', dark_oak_log:'dark_oak_planks', mangrove_log:'mangrove_planks',
  cherry_log:'cherry_planks', pale_oak_log:'pale_oak_planks', bamboo_block:'bamboo_planks'
};

// ──────────────────────────────────────────────────────────────────────────────
// Поиск/создание рабочего контекста (верстак/печь) + установка блоков
// ──────────────────────────────────────────────────────────────────────────────
function findBlockNear(bot, name, radius=8){
  try {
    const poses = bot.findBlocks({ matching: (b)=> b && b.name===name, maxDistance: radius, count: 1 });
    return poses?.length ? bot.blockAt(poses[0]) : null;
  } catch { return null; }
}
async function placeBlockNearby(bot, itemName){
  // Пытаемся поставить блок на верхнюю грань ближайшего твёрдого блока вокруг ног
  const base = bot.entity?.position?.offset(0, -1, 0);
  if (!base) throw new Error('Нет позиции для установки.');
  const dirs = [
    [0,0], [1,0], [-1,0], [0,1], [0,-1],
    [2,0], [-2,0], [0,2], [0,-2]
  ];
  const handItem = items(bot).find(i=> i.name===itemName);
  if (!handItem) throw new Error(`Нет предмета для установки: ${itemName}`);
  try { await bot.equip(handItem, 'hand'); } catch {}
  for (const [dx,dz] of dirs){
    const under = bot.blockAt(base.offset(dx,0,dz));
    const above = bot.blockAt(base.offset(dx,1,dz));
    if (!under || under.name==='air') continue;
    if (above && above.name!=='air') continue;
    try { await bot.placeBlock(under, { x:0, y:1, z:0 }); await humanDelay(between(140,300)); return true; } catch {}
  }
  return false;
}

async function ensureCraftingTableReady(bot, { autoPlace=true } = {}){
  let table = findBlockNear(bot, 'crafting_table', 8);
  if (table) return table;
  // если рядом нет — попробуем скрафтить и поставить
  if (!hasItem(bot, 'crafting_table')){
    // нужны доски×4
    if (!PLANKS.some(n=> hasItem(bot, n, 4))){
      const log = findAny(bot, LOGS);
      if (!log){
        try { const { chopWood } = require('../mining/mining.js'); await chopWood(bot, 6); } catch {}
      }
      const got = findAny(bot, LOGS);
      if (got){
        const pl = LOG_TO_PLANK[got.name] || 'oak_planks';
        await craftSimple(bot, pl, 1); // 4 доски
      }
    }
    await craftSimple(bot, 'crafting_table', 1);
  }
  if (!autoPlace) return null;
  const placed = await placeBlockNearby(bot, 'crafting_table');
  if (!placed) throw new Error('Не удалось установить верстак рядом');
  await humanDelay(between(140,280));
  table = findBlockNear(bot, 'crafting_table', 8);
  return table;
}

async function ensureFurnaceReady(bot, { autoPlace=true } = {}){
  let furnace = findBlockNear(bot, 'furnace', 8);
  if (furnace) return furnace;
  if (!hasItem(bot, 'furnace')){
    // нужен булыжник×8 (или камень) — попробуем добыть/найти
    const need = 8;
    const haveCobble = countItem(bot, 'cobblestone');
    if (haveCobble < need){
      try { const { collectBlocksByNames } = require('../mining/mining.js'); await collectBlocksByNames(bot, ['stone','deepslate'], 16); } catch {}
    }
    if (countItem(bot, 'cobblestone') >= need){
      await craftSimple(bot, 'furnace', 1);
    } else {
      throw new Error('Нужен булыжник для печи (8 шт)');
    }
  }
  if (!autoPlace) return null;
  const placed = await placeBlockNearby(bot, 'furnace');
  if (!placed) throw new Error('Не удалось установить печь рядом');
  await humanDelay(between(140,280));
  furnace = findBlockNear(bot, 'furnace', 8);
  return furnace;
}

// ──────────────────────────────────────────────────────────────────────────────
// Контекст крафта (2×2/верстак)
// ──────────────────────────────────────────────────────────────────────────────
async function ensureCraftContext(bot, itemId){
  try {
    const invRecipes = bot.recipesFor(itemId, null, 1, null);
    if (invRecipes && invRecipes.length) return { window: null, table: null, useTable: false };
  } catch {}
  // если нужен стол — обеспечим наличие/установку
  const table = await ensureCraftingTableReady(bot, { autoPlace:true });
  const win = await bot.openCraftingTable(table);
  await humanDelay(between(120, 260));
  return { window: win, table, useTable: true };
}

// ──────────────────────────────────────────────────────────────────────────────
// Рецепты, ресурсы, недостача
// ──────────────────────────────────────────────────────────────────────────────
const _recipeCache = new Map(); // `${itemId}|${table?1:0}` → Recipe[]
function getRecipeList(bot, itemId, useTable){
  const key = `${itemId}|${useTable?1:0}`;
  if (_recipeCache.has(key)) return _recipeCache.get(key);
  let list = [];
  try { list = bot.recipesFor(itemId, null, 1, useTable ? true : null) || []; } catch {}
  _recipeCache.set(key, list);
  return list;
}
function ingName(bot, ing){
  const id = (typeof ing?.id === 'number') ? ing.id : null;
  if (id !== null) return bot.registry.items[id]?.name || String(ing.id);
  if (typeof ing === 'string') return ing;
  if (typeof ing?.id === 'string') return ing.id;
  return 'unknown';
}
function hasResourcesFor(bot, recipe){
  try {
    const inv = new Map();
    for (const it of items(bot)) inv.set(it.name, (inv.get(it.name)||0) + it.count);
    for (const ing of recipe.ingredients){
      const name = ingName(bot, ing);
      const need = ing.count || 1;
      if ((inv.get(name)||0) < need) return false;
    }
    return true;
  } catch { return true; }
}
function computeMissingFor(bot, recipe, times=1){
  const lack = new Map();
  try {
    for (const ing of recipe.ingredients){
      const name = ingName(bot, ing);
      const need = (ing.count||1) * times;
      const have = countItem(bot, name);
      if (have < need) lack.set(name, (lack.get(name)||0) + (need-have));
    }
  } catch {}
  return lack;
}

// ──────────────────────────────────────────────────────────────────────────────
// Подготовка субкомпонентов (+ факелы/уголь/печь)
// ──────────────────────────────────────────────────────────────────────────────
async function ensureSubcomponent(bot, needName, approxCount=1){
  // доски из любого лога
  if (PLANKS.includes(needName)){
    if (PLANKS.some(n=> hasItem(bot,n))) return true;
    let log = findAny(bot, LOGS);
    if (!log){
      try { const { chopWood } = require('../mining/mining.js'); await chopWood(bot, 6); } catch {}
      log = findAny(bot, LOGS);
    }
    if (log){
      const planksId = LOG_TO_PLANK[log.name] || 'oak_planks';
      try { await craftSimple(bot, planksId, Math.max(1, Math.ceil(approxCount/4))); } catch {}
      return true;
    }
    return false;
  }
  // палки из досок
  if (needName === 'stick'){
    if (!hasItem(bot, 'stick', approxCount)){
      if (!PLANKS.some(n=> hasItem(bot,n))) await ensureSubcomponent(bot, 'oak_planks', 2);
      try { await craftSimple(bot, 'stick', Math.max(1, Math.ceil(approxCount/4))); } catch {}
    }
    return true;
  }
  // *_ingot → переплавка
  if (/_ingot$/.test(needName)){
    try { const { smeltAll } = require('../building/smelting.js'); await smeltAll(bot); } catch {}
    return true;
  }
  return false;
}

// Спец-подготовка для факелов: добыть/сжечь бревно в уголь (charcoal)
async function ensureTorchSupplies(bot, want=4){
  const haveCoal = countItem(bot, 'coal') + countItem(bot, 'charcoal');
  const needCoal = Math.max(0, Math.ceil(want/4) - haveCoal); // 1 уголь → 4 факела
  // палки
  const needSticks = Math.max(0, want - countItem(bot, 'torch') - countItem(bot, 'stick'));
  if (needSticks > 0) await ensureSubcomponent(bot, 'stick', needSticks);

  if (needCoal <= 0) return true;

  // есть ли брёвна для пережига?
  if (!LOGS.some(n=> hasItem(bot, n))) {
    try { const { chopWood } = require('../mining/mining.js'); await chopWood(bot, 6); } catch {}
  }
  if (!LOGS.some(n=> hasItem(bot, n))) return false;

  // обеспечим печь рядом (крафт/установка при необходимости)
  let furnace;
  try { furnace = await ensureFurnaceReady(bot, { autoPlace:true }); } catch (e) { say(bot, '⚠️ Нужна печь рядом для угля'); return false; }

  // отдаём в общую переплавку — она сама сожжёт брёвна в уголь, если настроена
  try { const { smeltAll } = require('../building/smelting.js'); await smeltAll(bot); } catch {}
  return (countItem(bot, 'coal') + countItem(bot, 'charcoal')) > haveCoal;
}

// ──────────────────────────────────────────────────────────────────────────────
// Безопасный крафт (ретраи/таймаут)
// ──────────────────────────────────────────────────────────────────────────────
async function craftSafe(bot, recipe, times = 1, window = null, { tries=2, stepTimeoutMs=6000 } = {}){
  for (let t = 0; t < times; t++){
    let ok = false;
    for (let a = 0; a < tries && !ok; a++){
      try {
        const p = bot.craft(recipe, 1, window || null);
        ok = await Promise.race([ p.then(()=>true), sleep(stepTimeoutMs).then(()=>false) ]);
      } catch { ok = false; }
      if (!ok) await humanDelay(between(140, 300));
    }
    if (!ok) throw new Error('craft-timeout');
    await humanDelay(between(140, 300));
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Ядро: craftSimple
// ──────────────────────────────────────────────────────────────────────────────
async function craftSimple(bot, itemName, amount = 1){
  const itemId = bot.registry.itemsByName[itemName]?.id;
  if (!itemId) throw new Error(`Неизвестный предмет: ${itemName}`);

  const wrapper = xpApi?.withCraftXP || (async (_b,_tag,_ctx,fn,_fin)=> fn());
  const adjust  = xpApi?.getXP?.(bot)?.adjustWeights || ((_domain,_key,base)=>base);

  const ctx = { item: itemName, amount };
  const base = { speed:0.50, economy:0.30, reliability:0.20 };
  const W = adjust('craft', itemName, base, ctx);

  return wrapper(
    bot, itemName, ctx,
    async () => {
      await humanDelay(jitter());

      // спец-подготовка: факелы (сами сделаем уголь/палку/печь)
      if (itemName === 'torch') {
        await ensureTorchSupplies(bot, amount*4).catch(()=>{});
      }

      // решаем 2×2 или стол (если стол нужен — обеспечим его)
      let needTable = true;
      try {
        const inv = bot.recipesFor(itemId, null, 1, null);
        needTable = !(inv && inv.length);
      } catch { needTable = true; }

      const recipes = getRecipeList(bot, itemId, needTable);
      if (!recipes.length) throw new Error(`Нет рецепта для ${itemName}`);

      // под тот, что «по карману» прямо сейчас
      let recipe = recipes.find(r => hasResourcesFor(bot, r)) || recipes[0];

      // подготовим недостающее
      let missing = computeMissingFor(bot, recipe, amount);
      if (missing.size){
        for (const [need, cnt] of missing.entries()){
          await ensureSubcomponent(bot, need, cnt).catch(()=>{});
          await humanDelay(between(50, 110));
        }
        missing = computeMissingFor(bot, recipe, amount);
        if (missing.size){
          const msg = Array.from(missing.entries()).map(([n,c])=>`${n}×${c}`).join(', ');
          throw new Error('Не хватает ресурсов: ' + msg);
        }
      }

      // откроем стол — только если реально нужен (и поставим, если нет рядом)
      let win = null, tableBlock = null;
      try {
        if (needTable){
          const ctx2 = await ensureCraftContext(bot, itemId);
          win = ctx2.window; tableBlock = ctx2.table;
        }

        // поштучно, с ретраями
        for (let i = 0; i < amount; i++){
          await craftSafe(bot, recipe, 1, win, {
            tries: (W.reliability >= 0.5 ? 2 : 3),
            stepTimeoutMs: 6000 + Math.floor((1 - W.speed) * 2500)
          });
          state.botStats.itemsCrafted = (state.botStats.itemsCrafted||0) + 1;
          await humanDelay(between(120, 320));
        }
      } finally {
        if (win) { try { win.close(); } catch {} }
      }

      addExp(Math.max(3, Math.round(amount*4*(0.6 + (W.reliability||0)))), `крафт ${itemName}`);
      return { made: amount, usedTable: !!tableBlock };
    },
    async (res, err, { timeMs }) => ({
      ok: !err && (res?.made||0) > 0,
      timeMs, cost: 0, reward: res?.made||0
    })
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Внешние: craftItem(ru), craftList, suggestCraftable
// ──────────────────────────────────────────────────────────────────────────────
async function craftItem(bot, russianName, amount = 1){
  const id = ruToId(russianName);
  if (!id){
    say(bot, `❌ Не знаю предмет "${russianName}"`);
    say(bot, '📝 Напиши: хелпбот предметы');
    return false;
  }
  try {
    await craftSimple(bot, id, amount);
    say(bot, `🛠️ Скрафтил: ${russianName}${amount>1?` ×${amount}`:''}`);
    return true;
  } catch (e){
    say(bot, `❌ Не могу скрафтить ${russianName}: ${e.message}`);
    return false;
  }
}

async function craftList(bot, list){
  for (const ru of list){
    const ok = await craftItem(bot, ru);
    if (!ok){ say(bot, `⛔ Остановлено: не удалось скрафтить ${ru}`); return; }
    await humanDelay(between(280, 520));
  }
  say(bot, '✅ Все предметы успешно скрафчены!');
}

function canCraft(bot, ingredients){
  try {
    for (const it of ingredients){
      const has = items(bot).find(i=> i.name.includes(it));
      if (!has || has.count<=0) return false;
    }
    return true;
  } catch { return false; }
}

function suggestCraftable(bot, catalog){
  const out = [];
  for (const [ruName, ing] of Object.entries(catalog || {})){
    if (canCraft(bot, ing)) out.push(ruName);
  }
  if (!out.length){ say(bot, '😕 Сейчас ничего не могу скрафтить — не хватает материалов.'); return []; }
  const list = out.slice(0, 14).join(', ');
  say(bot, '🧠 Могу сейчас скрафтить: ' + list + (out.length>14?' …':''));
  say(bot, '✏️ Напиши: хелпбот крафт <название>');
  return out;
}

module.exports = {
  craftSimple,
  craftItem,
  craftList,
  ensureCraftContext,
  // справка/утилиты
  ruToId,
  getItemList,
  suggestCraftable,
  canCraft,
  computeMissingFor,
  hasResourcesFor,
};
