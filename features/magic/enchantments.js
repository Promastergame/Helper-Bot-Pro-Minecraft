'use strict';
// ===============================
// features/magic/enchantments.js — v7.0
// ✨ Зачарования и наковальня без модов (ваниль), с ИИ-советами и проверками
//   • ИИ-план на основе стиля игры (добыча/бой/смешанный) + состояние бота
//   • Учёт уже применённых «виртуальных» зачарований и апгрейд существующих уровней
//   • Совместимость/конфликты, экономия, XP (опционально), аккуратные сообщения
//   • Кэш ближайших блоков, троттлинг чата, асинхронная блокировка задач
//   • Мягкая интеграция с pathfinder (если доступен), безопасные фоллбеки
//   • Полезные утилиты для UI: доступные чары, рецепты, сводки, лог
//   • Обратная совместимость с v6.5: те же экспорты + новые
// ===============================

const { state } = require('../../core/state.cjs');
const { Vec3 } = require('vec3');

// ───────────────────────────────────────────────────────────────────────────────
// Конфигурация
// ───────────────────────────────────────────────────────────────────────────────
const CFG = {
  SEARCH_RADIUS: 10,             // радиус поиска стола/наковальни
  SEARCH_RADIUS_FALLBACK: 16,    // расширение радиуса при первом промахе
  CHAT_COOLDOWN_MS: 600,         // троттлинг чата
  STEP_DELAY_MS: 160,            // задержка между шагами «применения»
  LAPIS_MIN: 3,                  // желаемый минимум лазурита для стола
  ANVIL_USE_COST: 20,            // дефолтная «служебная» цена некоторых действий
  ENABLE_XP: true,               // если есть state.xp — учитывать
  PATH_TO_WORKSTATIONS: true,    // пытаться подойти к столу/наковальне (если есть pathfinder)
};

// ───────────────────────────────────────────────────────────────────────────────
// Утилиты и инфраструктура (кэш, троттлинг, блокировки)
// ───────────────────────────────────────────────────────────────────────────────
const sleep = (ms)=> new Promise(r=> setTimeout(r, ms));
const clamp = (v,a,b)=> Math.max(a, Math.min(b, v));
function items(bot){ try { return bot.inventory.items(); } catch { return []; } }
function count(bot, name){ return items(bot).filter(i=> i.name===name).reduce((s,it)=> s + (it.count||0), 0); }
function has(bot, name, n=1){ return count(bot, name) >= n; }

const ChatThrottle = (()=> {
  let last = 0;
  return function safeChat(bot, msg){
    const now = Date.now();
    if (now - last >= CFG.CHAT_COOLDOWN_MS){
      try { bot.chat(msg); } catch {}
      last = now;
    }
  };
})();
const safeChat = ChatThrottle;

function dist(a, b){ try { return a.position.distanceTo ? a.position.distanceTo(b.position) : a.distanceTo(b); } catch { return Infinity; } }

// Простая асинхронная блокировка по ключу (например, 'autoEnchant')
const _locks = new Map();
async function withLock(key, fn){
  while (_locks.get(key)) await _locks.get(key);
  let resolve; const p = new Promise(r=> (resolve=r)); _locks.set(key, p);
  try { return await fn(); }
  finally { _locks.delete(key); resolve(); }
}

// Кэш ближайших блоков: по имени → (pos,time)
const _blockCache = new Map();
function cacheKey(worldName, name){ return `${worldName||'world'}::${name}`; }
function getCachedBlock(bot, names){
  try {
    const w = bot?.world?.name || 'world';
    let best = null, bestD = Infinity, chosenKey = null;
    for (const n of names){
      const k = cacheKey(w, n);
      const hit = _blockCache.get(k);
      if (hit?.pos){
        const d = bot.entity?.position ? bot.entity.position.distanceTo(hit.pos) : Infinity;
        if (d < bestD){ bestD = d; best = hit; chosenKey = k; }
      }
    }
    // 30 секунд протухания
    if (best && Date.now() - best.time < 30_000) return { pos: best.pos, key: chosenKey };
  } catch {}
  return null;
}
function putCachedBlock(bot, name, block){
  try {
    if (!block) return;
    const w = bot?.world?.name || 'world';
    _blockCache.set(cacheKey(w, name), { pos: block.position.clone ? block.position.clone() : block.position, time: Date.now() });
  } catch {}
}

// Универсальный поиск блока(ов)
function nearestBlock(bot, names, maxDistance = CFG.SEARCH_RADIUS){
  try {
    if (!Array.isArray(names)) names = [names];
    // кэш
    const cached = getCachedBlock(bot, names);
    if (cached){
      const blk = bot.blockAt(cached.pos);
      if (blk && names.includes(blk.name)) return blk;
    }
    const poses = bot.findBlocks({ matching: b=> names.includes(b.name), maxDistance, count: 1 });
    let blk = poses?.length ? bot.blockAt(poses[0]) : null;
    if (!blk && maxDistance < CFG.SEARCH_RADIUS_FALLBACK){
      const poses2 = bot.findBlocks({ matching: b=> names.includes(b.name), maxDistance: CFG.SEARCH_RADIUS_FALLBACK, count: 1 });
      blk = poses2?.length ? bot.blockAt(poses2[0]) : null;
    }
    if (blk) putCachedBlock(bot, blk.name, blk);
    return blk;
  } catch { return null; }
}

// Плавный «подойти к блоку», если установлен pathfinder
async function goNear(bot, block, range = 2){
  if (!CFG.PATH_TO_WORKSTATIONS) return;
  try {
    if (!bot?.pathfinder || !block?.position || !bot.entity?.position) return;
    const cur = bot.entity.position;
    if (cur.distanceTo(block.position) <= range+0.5) return;
    const goals = require('mineflayer-pathfinder').goals;
    const { Movements, pathfinder: Pathfinder } = require('mineflayer-pathfinder');
    if (!bot.pathfinder.isMoving()){
      bot.loadPlugin(Pathfinder);
      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      bot.pathfinder.setMovements(defaultMove);
    }
    bot.pathfinder.setGoal(new goals.GoalNear(block.position.x, block.position.y, block.position.z, range), true);
    // ждать немного, но не вечно
    const start = Date.now();
    while (Date.now() - start < 6000){
      await sleep(150);
      if (bot.entity.position.distanceTo(block.position) <= range+0.5) return;
    }
  } catch {}
}

// ───────────────────────────────────────────────────────────────────────────────
// Словарь зачарований и конфликты
// ───────────────────────────────────────────────────────────────────────────────
/** @typedef {{name:string,type:string,max:number,cost:number[],conflicts?:string[],rare?:boolean}} EnchDef */

const ENCH = /** @type {Record<string, EnchDef>} */ ({
  // weapon
  sharpness:         { name:'Острота',             type:'weapon',     max:5, cost:[1,2,3,4,5], conflicts:['smite','bane_of_arthropods'] },
  smite:             { name:'Небесная кара',       type:'weapon',     max:5, cost:[2,3,4,5,6], conflicts:['sharpness','bane_of_arthropods'] },
  bane_of_arthropods:{ name:'Казнь членистоногих', type:'weapon',     max:5, cost:[2,3,4,5,6], conflicts:['sharpness','smite'] },
  knockback:         { name:'Отдача',              type:'weapon',     max:2, cost:[2,5] },
  fire_aspect:       { name:'Огненный аспект',     type:'weapon',     max:2, cost:[4,8] },
  looting:           { name:'Добыча',              type:'weapon',     max:3, cost:[4,7,10] },

  // tools
  efficiency:        { name:'Эффективность',       type:'tool',       max:5, cost:[1,2,3,4,5] },
  unbreaking:        { name:'Прочность',           type:'tool_armor', max:3, cost:[2,4,6] },
  fortune:           { name:'Удача',               type:'tool',       max:3, cost:[4,8,12], conflicts:['silk_touch'] },
  silk_touch:        { name:'Шёлковое касание',    type:'tool',       max:1, cost:[8], conflicts:['fortune'] },

  // armor
  protection:        { name:'Защита',              type:'armor',      max:4, cost:[1,2,3,4], conflicts:['projectile_protection','blast_protection','fire_protection'] },
  fire_protection:   { name:'Огнеупорность',       type:'armor',      max:4, cost:[2,4,6,8], conflicts:['protection','projectile_protection','blast_protection'] },
  projectile_protection:{name:'Защита от стрел',   type:'armor',      max:4, cost:[2,4,6,8], conflicts:['protection','blast_protection','fire_protection'] },
  blast_protection:  { name:'Взрывоустойчивость',  type:'armor',      max:4, cost:[2,4,6,8], conflicts:['protection','projectile_protection','fire_protection'] },
  feather_falling:   { name:'Невесомость',         type:'boots',      max:4, cost:[2,4,6,8] },
  depth_strider:     { name:'Подводник',           type:'boots',      max:3, cost:[4,8,12] },
  respiration:       { name:'Подводное дыхание',   type:'helmet',     max:3, cost:[4,8,12] },
  aqua_affinity:     { name:'Родство с водой',     type:'helmet',     max:1, cost:[4] },
  thorns:            { name:'Шипы',                type:'armor',      max:3, cost:[6,10,14] },

  // доп. «редкие» (не навязываем планом, но поддерживаем в ручном режиме)
  frost_walker:      { name:'Ледоход',             type:'boots',      max:2, cost:[8,12], rare:true, conflicts:[] },
  soul_speed:        { name:'Скорость души',       type:'boots',      max:3, cost:[8,12,16], rare:true },
  mending:           { name:'Починка',             type:'tool_armor', max:1, cost:[18], rare:true }, // предполагаем книгу
});

const COMPAT = {
  weapon: ['sword','axe'],
  tool: ['pickaxe','axe','shovel','hoe'],
  tool_armor: ['pickaxe','axe','shovel','hoe','helmet','chestplate','leggings','boots','sword'],
  armor: ['helmet','chestplate','leggings','boots'],
  boots: ['boots'],
  helmet: ['helmet']
};

function isEnchantCompatible(itemType, ench){
  const list = COMPAT[ench.type] || [];
  return list.some(t=> itemType.includes(t));
}
function conflictsWith(plan, key){
  const c = ENCH[key]?.conflicts || [];
  return plan.some(p=> c.includes(p.key));
}

// ───────────────────────────────────────────────────────────────────────────────
// ИИ-оценка стиля и план (с учётом текущего состояния «вирт. чар»)
// ───────────────────────────────────────────────────────────────────────────────
function totalMobs(map){ if (!map) return 0; return Object.values(map).reduce((a,b)=> a+(b||0), 0); }
function styleFromStats(){
  const s = state.botStats || {};
  const mobs = totalMobs(s.mobsKilled);
  const mined = s.blocksMined||0;
  if (mobs > mined*0.5) return 'combat';
  if (mined > mobs*1.5) return 'mining';
  return 'balanced';
}

// Аккуратный мердж плана с учётом уже применённых уровней
function mergeWithExisting(itemType, basePlan){
  const applied = (state.botStats?.virtualEnchantMap?.[itemType]) || {}; // {key: lvl}
  const out = [];
  for (const step of basePlan){
    const e = ENCH[step.key]; if (!e) continue;
    const current = applied[step.key] || 0;
    const target = Math.max(current, clamp(step.lvl, 1, e.max));
    if (target <= current) continue; // уже есть или выше
    // проверить конфликты с тем, что уже «на предмете»
    const takenKeys = new Set(Object.keys(applied));
    const conflicts = e.conflicts||[];
    if (conflicts.some(k=> takenKeys.has(k))) continue;
    out.push({ key: step.key, from: current, lvl: target });
  }
  // убрать конфликты внутри самого нового плана
  const final = [];
  for (const st of out){ if (!conflictsWith(final, st.key)) final.push(st); }
  return final;
}

function aiSuggestFor(itemType){
  const style = styleFromStats();
  const plan = [];
  const push = (key, lvl)=> plan.push({ key, lvl });

  if (itemType.includes('pickaxe')){
    if (style!=='combat') push('efficiency', 5);
    push('unbreaking', 3);
    if (style==='mining' || style==='balanced') push('fortune', 3); else push('silk_touch', 1);
    if (style==='mining') push('mending', 1);
  } else if (itemType.includes('sword')){
    push('unbreaking', 3);
    push('sharpness', 5);
    push('looting', 3);
    push('fire_aspect', 2);
  } else if (itemType.includes('axe')){
    push('unbreaking', 3);
    push('efficiency', 5);
    push('sharpness', Math.min(5, 4));
  } else if (itemType.includes('helmet')){
    push('protection', 4);
    push('respiration', 3);
    push('aqua_affinity', 1);
    push('unbreaking', 3);
  } else if (itemType.includes('chestplate') || itemType.includes('leggings')){
    push('protection', 4); push('unbreaking', 3); push('thorns', 3);
  } else if (itemType.includes('boots')){
    push('protection', 4); push('feather_falling', 4); push('depth_strider', 3); push('unbreaking', 3);
  } else {
    push('unbreaking', 2);
  }

  // совместимость с предметом + автомердж с учётом уже наложенного
  const filtered = plan.filter(p=> ENCH[p.key] && isEnchantCompatible(itemType, ENCH[p.key]));
  const merged = mergeWithExisting(itemType, filtered);
  return { style, plan: merged };
}

// ───────────────────────────────────────────────────────────────────────────────
// Экономика/XP (опционально, безопасно по умолчанию)
// ───────────────────────────────────────────────────────────────────────────────
function coins(){ state.economy ||= { coins: 0 }; return state.economy.coins||0; }
function addCoins(n){ state.economy ||= { coins: 0 }; state.economy.coins = Math.max(0, (state.economy.coins||0) + (n||0)); }
function spendCoins(n){ state.economy ||= { coins: 0 }; state.economy.coins = Math.max(0, (state.economy.coins||0) - n); }

// Пример формулы цены: базовая стоимость *10 + «премия» за апгрейд
function levelCost(key, lvl, from=0){
  const e = ENCH[key]; if (!e) return 0;
  const base = e.cost[Math.min(lvl-1, e.cost.length-1)]||1;
  const upgradePremium = Math.max(0, lvl - Math.max(1, from)) * 4; // премия за рост
  return base*10 + upgradePremium;
}

// XP (если включено и есть state.xp)
function getXp(){ if (!CFG.ENABLE_XP) return 0; const xp = state.xp||0; return xp|0; }
function spendXp(n){ if (!CFG.ENABLE_XP) return; state.xp = Math.max(0, (state.xp||0) - (n|0)); }

// ───────────────────────────────────────────────────────────────────────────────
// Поиск столов/наковален и обеспечение лазурита
// ───────────────────────────────────────────────────────────────────────────────
function findEnchantingTable(bot){ return nearestBlock(bot, ['enchanting_table'], CFG.SEARCH_RADIUS); }
function findAnvil(bot){ return nearestBlock(bot, ['anvil','chipped_anvil','damaged_anvil'], CFG.SEARCH_RADIUS); }

async function ensureLapisIfNeeded(bot){
  if (has(bot,'lapis_lazuli', CFG.LAPIS_MIN)) return true;
  try {
    const mining = require('../mining/mining.js');
    safeChat(bot, '🔵 Нужен лазурит — ищу руду...');
    await mining.collectBlocksByNames(bot, ['lapis_ore','deepslate_lapis_ore'], 6);
    return has(bot,'lapis_lazuli', 1);
  } catch { return false; }
}

// ───────────────────────────────────────────────────────────────────────────────
// «Виртуальные» чары: карта применённых уровней + журнал
// ───────────────────────────────────────────────────────────────────────────────
function _virtMap(){ state.botStats ||= {}; state.botStats.virtualEnchantMap ||= {}; return state.botStats.virtualEnchantMap; }
function _log(){ state.botStats ||= {}; state.botStats.enchantsLog ||= []; return state.botStats.enchantsLog; }

function getItemEnchantments(itemType){
  const map = _virtMap()[itemType] || {};
  return { ...map };
}
function rememberEnchant(itemType, key, lvl){
  const vm = _virtMap(); vm[itemType] ||= {};
  vm[itemType][key] = Math.max(vm[itemType][key]||0, lvl);
  _log().push({ at: Date.now(), item: itemType, key, lvl });
}
function forgetEnchant(itemType, key){
  const vm = _virtMap(); if (!vm[itemType]) return;
  delete vm[itemType][key];
}

// ───────────────────────────────────────────────────────────────────────────────
// Публичный класс
// ───────────────────────────────────────────────────────────────────────────────
class EnchantmentSystem {
  constructor(opts={}){ this.cfg = Object.assign({}, CFG, opts||{}); }

  // Короткая справка по предмету + ИИ-план (с учётом текущих «вирт. чар»)
  suggest(itemType){ return aiSuggestFor(itemType); }

  // Высокоуровневый «авто-зачар»: выполним план по шагам (монеты + XP)
  async autoEnchant(bot, itemType, overrides={}){
    return withLock('autoEnchant', async ()=>{
      const { plan, style } = aiSuggestFor(itemType);
      const table = findEnchantingTable(bot);
      const anvil = findAnvil(bot);
      if (!table && !anvil){ safeChat(bot, '🔎 Рядом нет стола зачарований и наковальни. Поставь где-нибудь ближе.'); }

      // мягко подходим поближе
      if (table) await goNear(bot, table, 2);
      else if (anvil) await goNear(bot, anvil, 2);

      const report = []; let applied = 0; let spent = 0; let spentXp = 0;
      await ensureLapisIfNeeded(bot);

      for (const step of plan){
        const key = step.key; const e = ENCH[key]; if (!e) { continue; }
        if (!isEnchantCompatible(itemType, e)){ report.push(`⛔ ${e.name} не подходит для ${itemType}`); continue; }

        // откуда мы апгрейдимся?
        const current = getItemEnchantments(itemType)[key] || step.from || 0;
        const want = clamp(step.lvl, Math.max(1,current||1), e.max);

        // финальная цена и XP (пример: 1 уровень XP за каждые 12 монет)
        const cost = levelCost(key, want, current);
        const xpNeed = Math.floor(cost/12);

        if (coins() < cost){ report.push(`💰 Нужно ${cost} монет на ${e.name} ${want}, есть ${coins()}. Пропускаю.`); continue; }
        if (CFG.ENABLE_XP && getXp() < xpNeed){ report.push(`🧪 XP мало (${getXp()}/${xpNeed}) на ${e.name} ${want}. Пропускаю.`); continue; }

        if (table || anvil){
          spendCoins(cost); spent += cost;
          if (CFG.ENABLE_XP){ spendXp(xpNeed); spentXp += xpNeed; }
          rememberEnchant(itemType, key, want); applied++;
          report.push(`✨ ${e.name} ${current?`${current}→`:''}${want} → ${itemType} (−${cost} монет${xpNeed?`, −${xpNeed} XP`:''})`);
          await sleep(this.cfg.STEP_DELAY_MS);
        } else {
          report.push(`ℹ️ Нет стола/наковальни рядом — запомнил план: ${e.name} ${want}`);
        }
      }

      // Запись «последнего» действия
      state.botStats ||= {};
      state.botStats.lastEnchant = { item: itemType, plan, style, applied, spent, spentXp, time: Date.now() };

      const summaryParts = [
        `🧠 План: ${style}`,
        `✅ Применено: ${applied}`,
        spent ? `💰 Потрачено: ${spent}` : null,
        spentXp ? `🧪 XP: ${spentXp}` : null
      ].filter(Boolean);
      if (report.length) safeChat(bot, summaryParts.join(' • ') + '\n' + report.join('\n'));

      return { style, applied, spent, spentXp, steps: report };
    });
  }

  // Ручной шаг: применить одно зачарование (если совместимо и хватает ресурсов)
  async enchantItem(bot, itemType, enchantKey, level){
    return withLock('enchantItem', async ()=>{
      const e = ENCH[enchantKey]; if (!e) throw new Error(`Неизвестное зачарование: ${enchantKey}`);
      const cur = getItemEnchantments(itemType)[enchantKey] || 0;
      const lvl = clamp(level, Math.max(1, cur||1), e.max);
      if (!isEnchantCompatible(itemType, e)) throw new Error(`${e.name} несовместимо с ${itemType}`);

      // Проверка конфликтов с уже «запомненными» чарами на этом предмете
      const taken = new Set(Object.keys(getItemEnchantments(itemType)));
      const conflicts = e.conflicts||[]; if (conflicts.some(x=> taken.has(x))) throw new Error(`${e.name} конфликтует с уже выбранным: ${conflicts.join(', ')}`);

      const table = findEnchantingTable(bot); const anvil = findAnvil(bot);
      if (!table && !anvil) throw new Error('Нет стола/наковальни рядом');

      if (table) await goNear(bot, table, 2); else if (anvil) await goNear(bot, anvil, 2);

      const cost = levelCost(enchantKey, lvl, cur);
      const xpNeed = Math.floor(cost/12);
      if (coins() < cost) throw new Error(`Недостаточно монет: нужно ${cost}, есть ${coins()}`);
      if (CFG.ENABLE_XP && getXp() < xpNeed) throw new Error(`Недостаточно XP: нужно ${xpNeed}, есть ${getXp()}`);

      spendCoins(cost); if (CFG.ENABLE_XP) spendXp(xpNeed);
      rememberEnchant(itemType, enchantKey, lvl);
      safeChat(bot, `✨ ${e.name} ${cur?`${cur}→`:''}${lvl} → ${itemType} (−${cost} монет${xpNeed?`, −${xpNeed} XP`:''})`);
      await sleep(150);

      state.botStats ||= {};
      state.botStats.lastEnchant = { item: itemType, enchant: enchantKey, from: cur, level: lvl, cost, xp: xpNeed, time: Date.now() };
      return { success: true, item: itemType, enchant: enchantKey, from: cur, level: lvl, cost, xp: xpNeed };
    });
  }

  // Список подходящих зачарований для UI/подсказок (+ базовая цена)
  getAvailableEnchants(itemType){
    return Object.entries(ENCH)
      .filter(([k,e])=> isEnchantCompatible(itemType, e))
      .map(([k,e])=> ({
        key: k, name: e.name, maxLevel: e.max, conflicts: e.conflicts||[],
        rare: !!e.rare, baseCost: (e.cost?.[0]||1)*10
      }));
  }

  // Кратко по рецептам наковальни (модель ремонта/переноса)
  getAnvilRecipes(){
    return [
      { key:'repair_iron',    name:'Ремонт железного',   materials:['iron_ingot'],     cost:30, repairAmount:25 },
      { key:'repair_diamond', name:'Ремонт алмазного',   materials:['diamond'],        cost:50, repairAmount:50 },
      { key:'combine_book',   name:'Книга → предмет',    materials:['enchanted_book'], cost:CFG.ANVIL_USE_COST, note:'Перенос чара с книги (модель)' },
      { key:'disenchant',     name:'Снять зачарование',  materials:['grindstone?'],    cost:10,  note:'Сброс «вирт.» зачарования' },
    ];
  }

  // Использование наковальни/точила: модель ремонта/переноса/снятия (без NBT)
  async useAnvil(bot, recipeKey, targetItemName){
    const rec = this.getAnvilRecipes().find(r=> r.key===recipeKey);
    if (!rec) throw new Error('Неизвестный рецепт');
    const anvil = findAnvil(bot); if (!anvil) throw new Error('Рядом нет наковальни');
    if (coins() < rec.cost) throw new Error(`Нужно ${rec.cost} монет, есть ${coins()}`);

    // Материалы есть?
    const have = (rec.materials||[]).every(m=> m.endsWith('?') || has(bot, m));
    if (!have) throw new Error(`Нет материалов: ${rec.materials.filter(m=>!m.endsWith('?')).join(', ')}`);

    await goNear(bot, anvil, 2);
    spendCoins(rec.cost);
    safeChat(bot, `⚒️ ${rec.name} → ${targetItemName} (−${rec.cost} монет)`);
    await sleep(120);

    // спец: снятие чар (виртуально)
    if (recipeKey === 'disenchant'){
      // снимаем все «виртуальные» с предмета (или можно сделать key-специфично)
      const applied = Object.keys(getItemEnchantments(targetItemName));
      for (const k of applied) forgetEnchant(targetItemName, k);
    }

    state.botStats ||= {};
    state.botStats.lastAnvil = { recipe: recipeKey, item: targetItemName, cost: rec.cost, time: Date.now() };
    return { success:true, recipe: recipeKey, item: targetItemName, cost: rec.cost };
  }

  // Сервис: сводка по предмету
  getItemSummary(itemType){
    const ench = getItemEnchantments(itemType);
    const arr = Object.entries(ench).map(([k,l])=> `${ENCH[k]?.name||k} ${l}`);
    return { item: itemType, appliedCount: arr.length, list: arr };
  }

  // Доступ к логу и «кошельку»
  getLog(limit=50){ const l = _log(); return l.slice(Math.max(0, l.length-limit)); }
  getCoins(){ return coins(); }
  addCoins(n){ addCoins(n); return coins(); }
  getXp(){ return getXp(); }
}

// ───────────────────────────────────────────────────────────────────────────────
// Экземпляр по умолчанию + экспорты
// ───────────────────────────────────────────────────────────────────────────────
const enchantmentSystem = new EnchantmentSystem();

module.exports = {
  EnchantmentSystem,
  enchantmentSystem,
  ENCH,
  aiSuggestFor,
  isEnchantCompatible,

  // Доп. полезные экспорты
  findEnchantingTable,
  findAnvil,
  getItemEnchantments,
};
