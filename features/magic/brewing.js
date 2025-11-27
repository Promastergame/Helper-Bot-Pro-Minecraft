'use strict';
// ===============================
// features/magic/brewing.js — v8.0
// ⚗️ Зельеварение с ИИ-планом, модификаторами (II/долгое/взрывное/туманное),
//     батч-варкой (несколько циклов), реюзом окна, автоподготовкой воды/ингров,
//     кэшем стойки, мягким pathfinding и устойчивыми ретраями
// Совместимо с HelperBot Pro v6+ (обратная совместимость API сохранена)
// ===============================

const { Vec3 } = require('vec3');
const { addExp } = require('../leveling.js');
const { findNearbyBlock, sleep, safeChat } = require('../utils/helpers.js');
const { state } = require('../../core/state.cjs');

// ───────────────────────────────────────────────────────────────────────────────
// Ленивая загрузка необязательных модулей
// ───────────────────────────────────────────────────────────────────────────────
let _crafting = null;        // ../crafting/crafting.js  (craftSimple)
let _mining = null;          // ../mining/mining.js      (collectBlocksByNames)
let _smelting = null;        // ../building/smelting.js  (smeltAll)

async function lazyCraft(){ if (!_crafting) { try { _crafting = require('../crafting/crafting.js'); } catch {} } return _crafting; }
async function lazyMining(){ if (!_mining)   { try { _mining   = require('../mining/mining.js'); }   catch {} } return _mining; }
async function lazySmelt(){  if (!_smelting) { try { _smelting = require('../building/smelting.js'); } catch {} } return _smelting; }

// ───────────────────────────────────────────────────────────────────────────────
// Конфиг
// ───────────────────────────────────────────────────────────────────────────────
const CFG = {
  STAND_SEARCH: 10,          // радиус поиска стойки
  STAND_RETRY: 16,           // расширенный радиус
  BREW_TIME_MS: 20000,       // базовое время шага (fallback)
  BREW_POLL_MS: 350,         // опрос окна на прогресс
  BREW_MAX_OVERRUN_MS: 8000, // доп.таймаут если сервер лагает
  WATER_SCAN: 8,             // поиск воды
  CHAT_COOLDOWN_MS: 600,     // троттлинг чата (реализован в helpers.safeChat)
  AUTO_CRAFT: true,
  AUTO_SMELT: true,
  PATHFIND_TO_STAND: true,
  BATCH_DEFAULT: 1,          // циклов варки по умолчанию (если не задано)
  KEEP_WINDOW: true,         // реюз окна между шагами
};

// ───────────────────────────────────────────────────────────────────────────────
// Рецепты базовых зелий (без модификаторов):
// awkward = основа (nether_wart)
// ───────────────────────────────────────────────────────────────────────────────
const BASE_RECIPES = {
  'зелье силы':            ['awkward', 'blaze_powder'],
  'зелье скорости':        ['awkward', 'sugar'],
  'зелье огнестойкости':   ['awkward', 'magma_cream'],
  'зелье водного дыхания': ['awkward', 'pufferfish'],
  'зелье ночного зрения':  ['awkward', 'golden_carrot'],
  'зелье лечения':         ['awkward', 'ghast_tear'],
  'зелье слабости':        ['fermented_spider_eye'], // без awkward
  'зелье регенерации':     ['awkward', 'ghast_tear'],
  'зелье невидимости':     ['awkward', 'golden_carrot', 'fermented_spider_eye'],
};

// Возможные модификаторы и их ингредиенты
const MODS = {
  strong:   'glowstone_dust',  // II
  long:     'redstone',        // длительное
  splash:   'gunpowder',       // взрывное
  lingering:'dragon_breath',   // туманное (нужно splash перед этим)
};

// ───────────────────────────────────────────────────────────────────────────────
// Вспомогалки инвентаря
// ───────────────────────────────────────────────────────────────────────────────
const isWaterBottle = i => i?.name === 'potion' && i?.nbt?.value?.Potion?.value === 'water';
const isAwkward     = i => i?.name === 'potion' && i?.nbt?.value?.Potion?.value === 'awkward';

function items(bot){ try { return bot.inventory.items() || []; } catch { return []; } }
function count(bot, name){ return items(bot).filter(i => i.name === name).reduce((s,i)=>s+(i.count||0), 0); }
function has(bot, name, n=1){ return count(bot, name) >= n; }
function any(bot, pred){ return !!items(bot).find(pred); }
function getItem(bot, name){ return items(bot).find(i=> i.name === name) || null; }

// ───────────────────────────────────────────────────────────────────────────────
// Блокировки для эксклюзивных операций
// ───────────────────────────────────────────────────────────────────────────────
const _locks = new Map();
async function withLock(key, fn){
  while (_locks.get(key)) await _locks.get(key);
  let r; const p = new Promise(res=> r=res); _locks.set(key, p);
  try { return await fn(); } finally { _locks.delete(key); r?.(); }
}

// ───────────────────────────────────────────────────────────────────────────────
// Pathfinding (мягкий)
// ───────────────────────────────────────────────────────────────────────────────
async function goNear(bot, block, r=2){
  if (!CFG.PATHFIND_TO_STAND) return;
  try {
    if (!bot?.pathfinder || !block?.position || !bot.entity?.position) return;
    const cur = bot.entity.position;
    if (cur.distanceTo(block.position) <= r+0.5) return;
    const { goals, Movements, pathfinder: Pathfinder } = require('mineflayer-pathfinder');
    if (!bot.pathfinder.isMoving()) {
      bot.loadPlugin(Pathfinder);
      const mcData = require('minecraft-data')(bot.version);
      const mv = new Movements(bot, mcData);
      bot.pathfinder.setMovements(mv);
    }
    bot.pathfinder.setGoal(new goals.GoalNear(block.position.x, block.position.y, block.position.z, r), true);
    const start = Date.now();
    while (Date.now() - start < 6000){
      await sleep(150);
      if (bot.entity.position.distanceTo(block.position) <= r+0.5) return;
    }
  } catch {}
}

// ───────────────────────────────────────────────────────────────────────────────
// Кэш стойки
// ───────────────────────────────────────────────────────────────────────────────
const _standCache = new Map();
const cacheKey = (bot)=> String(bot?.world?.name || 'world');
function cacheStand(bot, block){ try{ _standCache.set(cacheKey(bot), { pos:block.position, t:Date.now() }); }catch{} }
function cachedStand(bot){
  try{
    const hit = _standCache.get(cacheKey(bot));
    if (hit && Date.now()-hit.t < 45_000){
      const b = bot.blockAt(hit.pos);
      if (b && b.name === 'brewing_stand') return b;
    }
  }catch{}
  return null;
}
function findBrewingStand(bot){
  const cached = cachedStand(bot);
  if (cached) return cached;
  let stand = findNearbyBlock(bot, ['brewing_stand'], CFG.STAND_SEARCH);
  if (!stand) stand = findNearbyBlock(bot, ['brewing_stand'], CFG.STAND_RETRY);
  if (stand) cacheStand(bot, stand);
  return stand;
}

async function ensureStandNearbyOrPlace(bot){
  let stand = findBrewingStand(bot);
  if (stand) return stand;

  const item = getItem(bot, 'brewing_stand');
  if (!item) { safeChat(bot, '❗ У меня нет зельеварки.'); return null; }

  const base = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  try {
    await bot.equip(item, 'hand');
    await bot.placeBlock(base, new Vec3(0,1,0));
    await sleep(300);
    stand = findBrewingStand(bot);
    if (stand) return stand;
  } catch (e){ console.log('⚠️ Не удалось поставить зельеварку:', e.message); }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Подготовка воды/бутылок/топлива/ингредиентов
// ───────────────────────────────────────────────────────────────────────────────
async function ensureWaterBottles(bot, need = 3){
  const haveWater = items(bot).filter(isWaterBottle).length;
  if (haveWater >= need) return true;

  // пустые бутылки → автосоздание
  let empties = items(bot).filter(i => i.name === 'glass_bottle').reduce((s,i)=>s+i.count,0);
  if (empties < (need - haveWater)) {
    if (CFG.AUTO_SMELT && (!has(bot,'glass',3))) {
      const sm = await lazySmelt();
      if (sm && has(bot,'sand',3)) {
        safeChat(bot, '🔥 Переплавляю песок в стекло для бутылок...');
        try { await sm.smeltAll(bot); } catch {}
      }
    }
    if (CFG.AUTO_CRAFT && has(bot,'glass',3)) {
      const cr = await lazyCraft();
      if (cr?.craftSimple){
        try {
          safeChat(bot, '🧪 Крафчу стеклянные бутылки...');
          await cr.craftSimple(bot, 'glass_bottle', 3);
        } catch {}
      }
    }
    empties = items(bot).filter(i => i.name === 'glass_bottle').reduce((s,i)=>s+i.count,0);
    if (!empties && haveWater < need) return false;
  }

  // наполнение: обязательно экипируем бутылки
  const waterBlock = findNearbyBlock(bot, ['water'], CFG.WATER_SCAN);
  if (!waterBlock) { safeChat(bot, '❌ Воды рядом нет.'); return false; }
  const bottle = getItem(bot, 'glass_bottle');
  if (!bottle) return false;

  safeChat(bot, '💧 Наполняю бутылки водой...');
  try { await bot.lookAt(waterBlock.position.offset(0.5, 0.8, 0.5)); } catch {}
  const toFill = Math.min(need - haveWater, bottle.count);
  for (let i=0; i<toFill; i++){
    try { await bot.equip(bottle, 'hand'); } catch {}
    try { bot.activateItem(); } catch {}
    await sleep(350);
  }
  return items(bot).some(isWaterBottle);
}

async function ensureFuel(win, bot){
  // слот 4 — топливо (blaze_powder)
  if (win.slots[4]) return true;

  // если есть blaze_rod — скрафтим blaze_powder
  if (!has(bot, 'blaze_powder', 1) && CFG.AUTO_CRAFT && has(bot,'blaze_rod',1)) {
    const cr = await lazyCraft();
    if (cr?.craftSimple) {
      try { await cr.craftSimple(bot, 'blaze_powder', 1); } catch {}
    }
  }

  const fuel = items(bot).find(i => i.name === 'blaze_powder');
  if (!fuel) { safeChat(bot, '⚠️ Нет blaze_powder для топлива.'); return false; }

  try { await bot.moveSlotItem(fuel.slot, 4); safeChat(bot,'🔥 Добавил топливо.'); } catch {}
  return !!win.slots[4];
}

async function putBottles(win, bot){
  // слоты 0..2 — бутылки; кладём water potions
  const bottles = items(bot).filter(isWaterBottle).slice(0,3);
  if (!bottles.length) throw new Error('Нет бутылок с водой');
  for (let i=0; i<bottles.length; i++){
    try { if (!win.slots[i]) await bot.moveSlotItem(bottles[i].slot, i); } catch {}
  }
}

async function autoCraftIngredient(bot, name){
  const cr = await lazyCraft();
  if (!(cr?.craftSimple)) return;

  try {
    if (name === 'sugar' && has(bot,'sugar_cane',1)) {
      await cr.craftSimple(bot, 'sugar', Math.min(3, count(bot,'sugar_cane')));
    } else if (name === 'fermented_spider_eye' && has(bot,'spider_eye',1) && has(bot,'brown_mushroom',1) && (has(bot,'sugar',1) || has(bot,'sugar_cane',1))) {
      if (!has(bot,'sugar',1) && has(bot,'sugar_cane',1)) await cr.craftSimple(bot, 'sugar', 1);
      await cr.craftSimple(bot, 'fermented_spider_eye', 1);
    } else if (name === 'golden_carrot' && has(bot,'carrot',1) && (has(bot,'gold_nugget',8) || has(bot,'gold_ingot',1))) {
      if (!has(bot,'gold_nugget',8) && has(bot,'gold_ingot',1)) await cr.craftSimple(bot, 'gold_nugget', 1); // 1 слиток = 9 самородков
      await cr.craftSimple(bot, 'golden_carrot', 1);
    } else if (name === 'magma_cream' && has(bot,'slime_ball',1) && (has(bot,'blaze_powder',1) || has(bot,'blaze_rod',1))) {
      if (!has(bot,'blaze_powder',1) && has(bot,'blaze_rod',1)) await cr.craftSimple(bot, 'blaze_powder',1);
      await cr.craftSimple(bot, 'magma_cream', 1);
    }
  } catch {}
}

async function ensureIngredient(bot, name){
  if (has(bot, name)) return true;
  if (CFG.AUTO_CRAFT) await autoCraftIngredient(bot, name);
  if (!has(bot, name) && name === 'glowstone_dust'){
    const mining = await lazyMining();
    if (mining) { try { await mining.collectBlocksByNames(bot, ['glowstone'], 4); } catch {} }
  }
  return has(bot, name);
}

async function putIngredient(win, bot, name){
  if (win.slots[3]?.name === name) return;
  if (!(await ensureIngredient(bot, name))) throw new Error(`Нет ингредиента: ${name}`);
  const it = getItem(bot, name);
  await bot.moveSlotItem(it.slot, 3);
}

// ───────────────────────────────────────────────────────────────────────────────
// Работа с окном стойки (реюз) + ожидание готовности
// ───────────────────────────────────────────────────────────────────────────────
async function openStandWindow(bot, stand){
  const win = await bot.openBlock(stand);
  return win;
}

async function waitBrewFinish(win, expectChange = true){
  // Попытка определить окончание: ингредиент исчез, бутылки изменили NBT,
  // иначе — fallback по таймеру c запасом.
  const start = Date.now();
  const initial = win.slots.slice(0,5).map(s=> s && JSON.stringify(s.nbt?.value?.Potion?.value||s.name||null));
  while (Date.now() - start < (CFG.BREW_TIME_MS + CFG.BREW_MAX_OVERRUN_MS)){
    await sleep(CFG.BREW_POLL_MS);
    const now = win.slots.slice(0,5).map(s=> s && JSON.stringify(s.nbt?.value?.Potion?.value||s.name||null));
    if (!expectChange) break;
    // если слот ингридиента (3) опустел или состав бутылок (0..2) поменялся — готово
    const ingCleared = !win.slots[3];
    const bottlesChanged = now[0] !== initial[0] || now[1] !== initial[1] || now[2] !== initial[2];
    if (ingCleared || bottlesChanged) return true;
  }
  // не дождались, но считаем готовым (сервер мог лагать, mineflayer не прислал обновление)
  return true;
}

// ───────────────────────────────────────────────────────────────────────────────
// Нормализация имён и построение плана (база + модификаторы)
// ───────────────────────────────────────────────────────────────────────────────
function normalizeName(s=''){
  const t = s.toLowerCase().trim()
    .replace(/\s+/g,' ')
    .replace(/ii\b|2\b/g,' ii')
    .replace(/долг(ое|ая|ий)|продолж(ительное)?/g,' long')
    .replace(/взрывн(ое|ая|ый)|splash/g,' splash')
    .replace(/туманн(ое|ая|ый)|оседающее|lingering/g,' lingering');
  return t;
}

function parsePotionName(raw){
  const t = normalizeName(raw);
  // выделяем моды
  const mods = {
    strong: /\b(ii|2)\b/.test(t),
    long: /\blong\b/.test(t),
    splash: /\bsplash\b/.test(t),
    lingering: /\blingering\b/.test(t)
  };
  // убираем пометки модов для поиска базы
  const baseKey = t.replace(/\b(ii|2|long|splash|lingering)\b/g,'').trim();
  // подгоняем некоторые синонимы
  const synonyms = {
    'сила': 'зелье силы',
    'скорость': 'зелье скорости',
    'огнестойка': 'зелье огнестойкости',
    'дыхание': 'зелье водного дыхания',
    'невидимость': 'зелье невидимости',
    'регенерация': 'зелье регенерации',
    'лечение': 'зелье лечения',
    'ночное зрение': 'зелье ночного зрения',
    'слабость': 'зелье слабости',
  };
  const baseName = BASE_RECIPES[baseKey] ? baseKey : (synonyms[baseKey] || baseKey);
  return { baseName, mods };
}

function buildRecipe(baseName, mods){
  const steps = BASE_RECIPES[baseName];
  if (!steps) return null;

  // запрещённая комбинация: strong и long вместе
  if (mods.strong && mods.long) mods.long = false;

  // сборка: база → (optional strong/long) → (optional splash) → (optional lingering)
  const seq = [...steps];
  if (mods.strong)   seq.push(MODS.strong);
  if (mods.long)     seq.push(MODS.long);
  if (mods.splash)   seq.push(MODS.splash);
  if (mods.lingering){
    if (!mods.splash) seq.push(MODS.splash); // сначала splash
    seq.push(MODS.lingering);
  }
  return seq;
}

// ───────────────────────────────────────────────────────────────────────────────
// Низкоуровневые операции: один шаг / последовательность шагов
// ───────────────────────────────────────────────────────────────────────────────
async function brewStepIntoOpen(bot, win, ingredient){
  await ensureFuel(win, bot);
  await putBottles(win, bot);
  await putIngredient(win, bot, ingredient);
  safeChat(bot, `🧪 Варю (${ingredient})...`);
  await waitBrewFinish(win, true);
}

async function brewSequence(bot, stand, sequence){
  const win = await openStandWindow(bot, stand);
  try {
    for (const ing of sequence){
      const real = ing === 'awkward' ? 'nether_wart' : ing;
      await brewStepIntoOpen(bot, win, real);
      await sleep(150); // маленькая пауза между шагами
    }
  } finally {
    try { win.close(); } catch {}
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// ИИ-советы по стилю
// ───────────────────────────────────────────────────────────────────────────────
function totalMobs(m){ if (!m) return 0; return Object.values(m).reduce((a,b)=>a+(b||0),0); }
function styleFromStats(){
  const s = state.botStats || {};
  const mobs = totalMobs(s.mobsKilled);
  const mined = s.blocksMined||0;
  if (mobs > mined*0.6) return 'combat';
  if (mined > mobs*1.4) return 'mining';
  return 'balanced';
}
function suggestPotions(bot, limit=4){
  const style = styleFromStats();
  const poolCombat   = ['зелье силы','зелье лечения','зелье регенерации','зелье скорости','зелье невидимости'];
  const poolMining   = ['зелье огнестойкости','зелье ночного зрения','зелье скорости','зелье водного дыхания'];
  const poolBalanced = ['зелье силы','зелье огнестойкости','зелье ночного зрения','зелье скорости'];

  const pool = style==='combat' ? poolCombat : style==='mining' ? poolMining : poolBalanced;

  const hasBase = (name)=>{
    const steps = BASE_RECIPES[name];
    if (steps?.includes('awkward') && !has(bot,'nether_wart',1)) return false;
    return true;
  };
  const res = pool.filter(hasBase).slice(0, limit);
  return { style, list: res };
}

// ───────────────────────────────────────────────────────────────────────────────
// Основные API
// ───────────────────────────────────────────────────────────────────────────────
async function brewPotion(bot, russianName, options={}){
  // обратная совместимость: раньше принимали только строку
  const qty = Math.max(1, options.count || options.qty || CFG.BATCH_DEFAULT);
  const parsed = parsePotionName(russianName);
  const seq = buildRecipe(parsed.baseName, parsed.mods);
  if (!seq) { safeChat(bot, '❌ Не знаю такое зелье. Напиши: "хелпбот зелья"'); return false; }

  return withLock('brew', async ()=>{
    // вода
    if (!(await ensureWaterBottles(bot))) {
      safeChat(bot, '❗ Нужны бутылки с водой (glass_bottle + вода).');
      return false;
    }
    // awkward требует nether_wart
    if (seq.includes('awkward') && !has(bot,'nether_wart',1)) {
      safeChat(bot, '❗ Нет nether_wart для основы (awkward). Нужен адский нарост.');
      return false;
    }

    const stand = await ensureStandNearbyOrPlace(bot);
    if (!stand) { safeChat(bot, '❌ Нет зельеварки рядом.'); return false; }
    await goNear(bot, stand, 2);

    let made = 0;
    for (let c=0; c<qty; c++){
      try {
        await brewSequence(bot, stand, seq);
        made++;
        addExp(15, 'алхимию');
        await sleep(200);
      } catch (e) {
        safeChat(bot, `❌ Ошибка алхимии: ${e.message}`);
        break;
      }
    }
    if (made>0) safeChat(bot, `✅ Сварил ${parsed.baseName}${qty>1?` ×${made}`:''}${parsed.mods.strong?' II':''}${parsed.mods.long?' (долгое)':''}${parsed.mods.splash?' [взрывное]':''}${parsed.mods.lingering?' {туманное}':''}!`);
    return made>0;
  });
}

// Очередь: имена (рус) или объекты { name, count }
// Пример: autoBrew(bot, ['зелье силы ii', {name:'зелье скорости', count:2}])
async function autoBrew(bot, list){
  return withLock('brew', async ()=>{
    if (!Array.isArray(list) || !list.length){
      const sug = suggestPotions(bot, 3);
      safeChat(bot, `🧠 Советую сварить: ${sug.list.join(', ')} (стиль: ${sug.style})`);
      return { done:0, total:0, errors:[] };
    }
    let done=0; const errs=[];
    for (const entry of list){
      const name = typeof entry==='string' ? entry : entry?.name;
      const count = typeof entry==='object' ? (entry.count||1) : 1;
      const ok = await brewPotion(bot, name, { count });
      if (ok) done++; else errs.push(name);
      await sleep(220); // крошечная пауза
    }
    safeChat(bot, `📦 Зелья: готово ${done}/${list.length}${errs.length?`. Пропущено: ${errs.join(', ')}`:''}`);
    return { done, total:list.length, errors:errs };
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// UI-утилиты
// ───────────────────────────────────────────────────────────────────────────────
function getPotionList(){
  const list = Object.keys(BASE_RECIPES).map(n => `- ${n}`).join('\n');
  return `📜 Зелья, которые я умею варить (модификаторы поддерживаются: II, долгое, взрывное, туманное):\n${list}`;
}

// Полезные вспомогательные экспорты (не ломающие совместимость)
function planPotion(name){
  const p = parsePotionName(name);
  const seq = buildRecipe(p.baseName, p.mods);
  return { base: p.baseName, mods: p.mods, sequence: seq||[] };
}
const getRecipe = (r)=> BASE_RECIPES[r] || null;
const parsePotion = parsePotionName;

// ───────────────────────────────────────────────────────────────────────────────
// Экспорт
// ───────────────────────────────────────────────────────────────────────────────
module.exports = {
  brewPotion,
  autoBrew,
  suggestPotions,
  getPotionList,

  // доп.экспорты
  planPotion,
  getRecipe,
  parsePotion,
};
