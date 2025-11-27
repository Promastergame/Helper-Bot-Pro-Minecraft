'use strict';
// ===============================
// features/economy/inventory.js — v7.6
// 🌾 Ферма / 💼 Инвентарь / 📦 Склад в одном модуле
//  • Авто-сбор урожая с пересадкой (wheat/carrots/potatoes/beetroots)
//  • Умный дроп ("всё", категории, тиры, "кроме …", id:...)
//  • Склад: поиск ближайшего сундука/бочки, deposit/withdraw по фильтрам
//  • Утилиты: авто-еда, компактация стаков
// CommonJS
// ===============================

const { Vec3 } = require('vec3');
const { state } = require('../../core/state.cjs');
const { createLogger } = require('../../core/logger.cjs');
const log = createLogger('farmer');

// xp/brain — опционально
let xp;  try { xp  = require('../ai/experience.cjs'); } catch { xp = null; }
let Q;   try { Q   = require('../ai/quantum'); }      catch { Q  = null;  }

// ──────────────────────────────────────────────────────────────────────────────
// Общие утилиты
// ──────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
const now = () => Date.now();
const norm = (s='') => String(s).toLowerCase().replaceAll('ё','е').trim();
const rand = (a,b)=> a + (Math.random()*(b-a));

// безопасные инвент. операции
const invItems = (bot) => { try { return bot.inventory.items(); } catch { return []; } };
const invCount = (bot, id) => invItems(bot).filter(i=>i.name===id).reduce((s,i)=>s+(i.count||0),0);
const hasAny = (bot, pred) => invItems(bot).some(pred);

// ──────────────────────────────────────────────────────────────────────────────
// 💼 ДРОП ПРЕДМЕТОВ (расширенный)
// ──────────────────────────────────────────────────────────────────────────────

const TOOL_SUFFIXES  = ['_pickaxe', '_axe', '_shovel', '_hoe', '_sword'];
const ARMOR_SUFFIXES = ['_helmet', '_chestplate', '_leggings', '_boots'];
const WEAPON_EXTRA   = ['bow','crossbow','trident','shield'];

const TIER_PREFIX = {
  'деревянные': 'wooden_',
  'каменные':   'stone_',
  'железные':   'iron_',
  'золотые':    'golden_',
  'алмазные':   'diamond_',
  'незеритовые':'netherite_'
};

// защищаем особенно ценные
const SAFE_ITEMS = new Set([
  'diamond','emerald','netherite_ingot','netherite_scrap','ancient_debris',
  'totem_of_undying','elytra','nether_star','dragon_head','enchanted_golden_apple',
  'enchanted_book'
]);

// еда / руды / мусор
const FOOD_KEYS = [
  'beef','pork','chicken','mutton','rabbit','salmon','cod','fish',
  'bread','apple','carrot','potato','beetroot','pumpkin_pie','cookie',
  'melon','chorus_fruit','golden_carrot','golden_apple'
];
const JUNK_IDS = [
  'rotten_flesh','string','spider_eye','bone','gunpowder',
  'flint','dirt','coarse_dirt','podzol','gravel',
  'granite','diorite','andesite','netherrack'
];

// опциональный словарь ru->id (если есть крафтер)
let ruToId = null;
try {
  const crafting = require('../crafting/crafting.js');
  ruToId = crafting?.ruToId ?? null;
} catch { /* ignore */ }

const isOreId   = (id)=> id.includes('ore');
const isFoodId  = (id)=> FOOD_KEYS.some(k=> id.includes(k));
const isToolId  = (id)=> TOOL_SUFFIXES.some(s=> id.endsWith(s));
const isArmorId = (id)=> ARMOR_SUFFIXES.some(s=> id.endsWith(s));
const isWeaponId= (id)=> id.endsWith('_sword') || WEAPON_EXTRA.includes(id);
const hasTier   = (id,p)=> id.startsWith(p);

async function tossItemStack(bot, st) {
  try { await bot.tossStack(st); return true; }
  catch { bot.chat(`⚠️ Не удалось выкинуть ${st?.name||'неизвестно'}.`); return false; }
}

function extractExceptRaw(q) {
  const m = q.match(/\bкроме\s+(.+)$/);
  return m ? norm(m[1]) : null;
}
function buildExclude(exceptRaw) {
  const excludeIds = new Set();
  let excludePredicate = null;
  if (!exceptRaw) return { excludeIds, excludePredicate };

  const mId = exceptRaw.match(/^id:([a-z0-9_]+)$/);
  if (mId) { excludeIds.add(mId[1]); return { excludeIds, excludePredicate }; }

  if (ruToId) {
    const asId = ruToId(exceptRaw);
    if (asId) { excludeIds.add(asId); return { excludeIds, excludePredicate }; }
  }

  if (/(еда|пища)/.test(exceptRaw)) excludePredicate = (id)=> isFoodId(id);
  else if (/(руды|руда)/.test(exceptRaw)) excludePredicate = (id)=> isOreId(id);
  else if (/инструм/.test(exceptRaw)) excludePredicate = (id)=> isToolId(id);
  else if (/(броня|шлем|нагруд|понож|ботин)/.test(exceptRaw)) excludePredicate = (id)=> isArmorId(id);
  else if (/оруж/.test(exceptRaw)) excludePredicate = (id)=> isWeaponId(id);

  return { excludeIds, excludePredicate };
}

function pickItems(items, predicate, isExcluded, countLimit) {
  const out = [];
  for (const it of items) {
    const id = it?.name || '';
    if (!id || SAFE_ITEMS.has(id)) continue;
    if (isExcluded(id)) continue;
    if (!predicate(id)) continue;
    out.push(it);
    if (countLimit && out.length >= countLimit) break;
  }
  return out;
}

function reportDrop(bot, label, results) {
  const total = results.length;
  if (!total) return bot.chat(`😅 Нечего выкидывать (${label}).`);
  const ok = results.filter(Boolean).length;
  const fail = total - ok;
  bot.chat(`🗑️ Выкинул ${ok} (${label})${fail ? `, ошибок: ${fail}` : ''}.`);
}

/**
 * dropSomething(bot, query, countLimitStacks?)
 *  Примеры:
 *   • "всё", "мусор", "руды", "еда"
 *   • "все алмазные инструменты"
 *   • "мечи", "кирки", "броня"
 *   • "id:iron_ore"
 *   • "мечи, кроме еды"
 */
async function dropSomething(bot, query, countLimitArg) {
  const qRaw = String(query||''); const q = norm(qRaw);
  if (!bot?.inventory) return bot.chat('❌ Ошибка: инвентарь не найден.');
  const all = invItems(bot);
  const countLimit = (typeof countLimitArg==='number' && countLimitArg>0) ? Math.min(640,countLimitArg) : null;

  const exceptRaw = extractExceptRaw(q);
  const { excludeIds, excludePredicate } = buildExclude(exceptRaw);
  const isExcluded = (id)=> excludeIds.has(id) || (excludePredicate ? excludePredicate(id) : false);

  // 1) Полная чистка (кроме SAFE + исключений)
  if (/^(все|всё|все предметы|очисти( инвентарь)?|мусор|хлам)$/.test(q)) {
    const chosen = pickItems(all, ()=>true, isExcluded, countLimit);
    const done = [];
    for (const st of chosen) done.push(await tossItemStack(bot, st));
    return reportDrop(bot, 'предметы (кроме ценных)', done);
  }

  // 2) id:...
  const mId = q.match(/\bid:([a-z0-9_]+)\b/);
  if (mId) {
    const id = mId[1];
    const chosen = pickItems(all, (x)=> x===id, isExcluded, countLimit);
    const done = [];
    for (const st of chosen) done.push(await tossItemStack(bot, st));
    return reportDrop(bot, `id:${id}`, done);
  }

  // 3) точный ru->id
  if (ruToId) {
    const id = ruToId(q);
    if (id) {
      const chosen = pickItems(all, (x)=> x===id, isExcluded, countLimit);
      const done = [];
      for (const st of chosen) done.push(await tossItemStack(bot, st));
      return reportDrop(bot, q, done);
    }
  }

  // 4) Тир+инструменты
  const mTierTools = q.match(/^все\s+(деревянные|каменные|железные|золотые|алмазные|незеритовые)\s+инструменты$/);
  if (mTierTools) {
    const pref = TIER_PREFIX[mTierTools[1]];
    const chosen = pickItems(all, (id)=> isToolId(id) && hasTier(id,pref), isExcluded, countLimit);
    const done = [];
    for (const st of chosen) done.push(await tossItemStack(bot, st));
    return reportDrop(bot, `все ${mTierTools[1]} инструменты`, done);
  }

  // 5) Категории
  const cat = [
    { re:/инструм/,   pred:(id)=> isToolId(id),  label:'инструменты' },
    { re:/оруж/,      pred:(id)=> isWeaponId(id),label:'оружие' },
    { re:/(броня|шлем|нагруд|понож|ботин)/, pred:(id)=> isArmorId(id), label:'броня' },
    { re:/\b(руды|руда)\b/, pred:(id)=> isOreId(id), label:'руды' },
    { re:/\b(еда|пища)\b/,  pred:(id)=> isFoodId(id), label:'еда' },
    { re:/\b(мусор|хлам)\b/,pred:(id)=> (new Set(JUNK_IDS)).has(id), label:'мусор/хлам' }
  ];
  for (const c of cat) {
    if (c.re.test(q)) {
      const chosen = pickItems(all, c.pred, isExcluded, countLimit);
      const done = []; for (const st of chosen) done.push(await tossItemStack(bot, st));
      return reportDrop(bot, c.label, done);
    }
  }

  // 6) Конкретные группы RU (мечи/кирки/броня-части/лук…)
  const groups = [
    { stems:['кирк'],   pred:(id)=> id.endsWith('_pickaxe'), label:'кирки' },
    { stems:['топор'],  pred:(id)=> id.endsWith('_axe'),     label:'топоры' },
    { stems:['лопат'],  pred:(id)=> id.endsWith('_shovel'),  label:'лопаты' },
    { stems:['мотыг'],  pred:(id)=> id.endsWith('_hoe'),     label:'мотыги' },
    { stems:['меч'],    pred:(id)=> id.endsWith('_sword'),   label:'мечи' },

    { stems:['шлем'],   pred:(id)=> id.endsWith('_helmet'),    label:'шлемы' },
    { stems:['нагруд','грудн'], pred:(id)=> id.endsWith('_chestplate'), label:'нагрудники' },
    { stems:['понож','леггинс','штаны'], pred:(id)=> id.endsWith('_leggings'), label:'поножи' },
    { stems:['ботин','сапог'], pred:(id)=> id.endsWith('_boots'), label:'ботинки' },

    { stems:['лук'], pred:(id)=> id==='bow', label:'луки' },
    { stems:['арбал'], pred:(id)=> id==='crossbow', label:'арбалеты' },
    { stems:['трезуб'], pred:(id)=> id==='trident', label:'трезубцы' },
    { stems:['щит'], pred:(id)=> id==='shield', label:'щиты' },
  ];
  for (const g of groups) {
    if (g.stems.some(s=> q.includes(s))) {
      const chosen = pickItems(all, g.pred, isExcluded, countLimit);
      const done = []; for (const st of chosen) done.push(await tossItemStack(bot, st));
      return reportDrop(bot, g.label, done);
    }
  }

  // 7) Свободный тир «все <ТИР> <что>»
  const mTierLoose = q.match(/все\s+(деревянные|каменные|железные|золотые|алмазные|незеритовые)\s+(\S+)/);
  if (mTierLoose) {
    const pref = TIER_PREFIX[mTierLoose[1]]; const tail = mTierLoose[2];
    const pred = (id)=>
      hasTier(id,pref) && (
        /инструм/.test(tail) ? isToolId(id) :
        /меч/.test(tail)     ? id.endsWith('_sword') :
        /брон/.test(tail)    ? isArmorId(id) : false
      );
    const chosen = pickItems(all, pred, isExcluded, countLimit);
    const done = []; for (const st of chosen) done.push(await tossItemStack(bot, st));
    return reportDrop(bot, `все ${mTierLoose[1]} ${tail}`, done);
  }

  // 8) «Гранит», «угольная руда» (ядро до запятой)
  if (ruToId) {
    const core = q.split(',')[0].trim();
    const fuzzyId = ruToId(core);
    if (fuzzyId) {
      const chosen = pickItems(all, (id)=> id===fuzzyId, isExcluded, countLimit);
      const done = []; for (const st of chosen) done.push(await tossItemStack(bot, st));
      return reportDrop(bot, core, done);
    }
  }

  bot.chat('❌ Не понял, что выкинуть. Примеры: "всё", "кирки", "руды", "все алмазные инструменты", "id:iron_ore", "мечи, кроме еды".');
}

// ──────────────────────────────────────────────────────────────────────────────
// 🌾 ФЕРМА (скан → сбор → пересадка)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * описание культур: имя блока, семена/саженец
 */
const CROP = {
  wheat:      { block: 'wheat',      seed: 'wheat_seeds' },
  carrots:    { block: 'carrots',    seed: 'carrot' },
  potatoes:   { block: 'potatoes',   seed: 'potato' },
  beetroots:  { block: 'beetroots',  seed: 'beetroot_seeds' },
  // nether_wart можно добавить при необходимости
};

function blockAge(block) {
  try {
    // современные версии
    const props = block.getProperties?.();
    if (props && typeof props.age === 'number') return props.age;
    // fallback (старые)
    if (typeof block.metadata === 'number') return block.metadata;
  } catch {}
  return null;
}
function isMature(block) {
  if (!block?.name) return false;
  const age = blockAge(block);
  if (age == null) return false;
  // пшеница/картофель/морковь/свёкла — зрелость age=7 (beetroot = 3 в старых, но в новых тоже 3/7; примем >= 7 || >=3 по имени)
  if (block.name === 'beetroots') return age >= 3;
  return age >= 7;
}

function nearestBlocks(bot, names, radius=8, count=64) {
  try {
    const positions = bot.findBlocks({
      matching: (b)=> b && names.includes(b.name),
      maxDistance: radius,
      count
    });
    return positions.map(p => bot.blockAt(p)).filter(Boolean);
  } catch { return []; }
}

/**
 * autoFarm(bot, { radius, replant, crops, onProgress, signal })
 */
async function autoFarm(bot, options={}) {
  const opt = {
    radius: 8,
    replant: true,
    crops: ['wheat','carrots','potatoes','beetroots'],
    onProgress: null,
    signal: null
  };
  Object.assign(opt, options||{});
  try { log.info('autoFarm:start', { options: opt }); } catch {}

  const cropBlocks = opt.crops
    .map(c => CROP[c]?.block).filter(Boolean);

  if (!cropBlocks.length) {
    bot.chat('🌾 Нет указанных культур.');
    return { ok:false, harvested:0, replanted:0 };
  }

  // ищем зрелые
  const all = nearestBlocks(bot, cropBlocks, opt.radius, 128);
  const targets = all.filter(isMature);
  if (!targets.length) {
    bot.chat('🌾 Созревших грядок рядом нет.');
    try { log.info('autoFarm:end', { harvested: 0, replanted: 0 }); } catch {}\n    return { ok:true, harvested:0, replanted:0 };
  }

  let harvested=0, replanted=0;
  const { goals } = await import('mineflayer-pathfinder');
  const GoalNear = goals.GoalNear;

  const startToken = (xp?.domains?.farm?.beginRun)
    ? xp.domains.farm.beginRun({ n: targets.length, night: (bot.time?.timeOfDay??0) >= 13000 })
    : null;

  for (const b of targets) {
    if (opt.signal?.aborted) throw new Error('Farm aborted');

    // подойти рядом
    try {
      await bot.pathfinder.goto(new GoalNear(b.position.x, b.position.y, b.position.z, 1));
    } catch { /* ok */ }

    // собрать
    try { await bot.dig(b, true); harvested++; }
    catch { continue; }

    // пересадка
    if (opt.replant) {
      const cropEntry = Object.values(CROP).find(e => e.block === b.name);
      if (cropEntry) {
        const seed = cropEntry.seed;
        if (invCount(bot, seed) > 0) {
          const base = bot.blockAt(b.position.offset(0,-1,0));
          if (base && base.name.includes('farmland')) {
            try {
              const it = invItems(bot).find(i=>i.name===seed);
              if (it) {
                await bot.equip(it, 'hand');
                // клик по грядке снизу ↑
                await bot.placeBlock(base, new Vec3(0,1,0));
                replanted++;
                await sleep(80);
              }
            } catch { /* planting failed — ignore */ }
          }
        }
      }
    }

    if (typeof opt.onProgress==='function') {
      try { opt.onProgress(harvested, targets.length); } catch {}
    }
    await sleep(Q?.humanDelay ? rand(60,140) : rand(80,180));
  }

  try { xp?.domains?.farm?.endRun?.(startToken, { harvested, replanted }); } catch {}

  bot.chat(`🌾 Готово: собрал ${harvested}${opt.replant?`, пересадил ${replanted}`:''}.`);
  return { ok:true, harvested, replanted };
}

// Logging wrapper for autoFarm
const _autoFarm = autoFarm;
autoFarm = async function(bot, options={}){
  try { log.info('autoFarm:call', { options }); } catch {}
  const res = await _autoFarm(bot, options);
  try { log.info('autoFarm:done', res); } catch {}
  return res;
}

// ──────────────────────────────────────────────────────────────────────────────
// 📦 СКЛАД (сундук/бочка рядом)
// ──────────────────────────────────────────────────────────────────────────────

const CHEST_NAMES = ['chest','trapped_chest','barrel'];

function findNearestChest(bot, radius=6) {
  try {
    const poses = bot.findBlocks({
      matching: (b)=> b && CHEST_NAMES.includes(b.name),
      maxDistance: radius,
      count: 1
    });
    return poses?.length ? bot.blockAt(poses[0]) : null;
  } catch { return null; }
}

/**
 * storeToChest(bot, { include, exclude, keepHotbar })
 *   include: (item) => boolean  ИЛИ массив id
 *   exclude: (item) => boolean  ИЛИ массив id
 */
async function storeToChest(bot, opts={}) {
  const options = { radius: 6, include:null, exclude:null, keepHotbar:true, announce:true, ...opts };
  const chestBlock = findNearestChest(bot, options.radius);
  if (!chestBlock) { bot.chat('📦 Рядом сундук/бочка не найдены.'); return { ok:false, moved:0 }; }

  let ui;
  try { ui = await bot.openChest(chestBlock); }
  catch { bot.chat('📦 Не удалось открыть сундук/бочку.'); return { ok:false, moved:0 }; }

  // нормализуем include/exclude
  const asSetOrFn = (v) => {
    if (!v) return null;
    if (Array.isArray(v)) { const S=new Set(v); return (it)=> S.has(it.name); }
    if (typeof v==='function') return v;
    return null;
  };
  const include = asSetOrFn(options.include);
  const exclude = asSetOrFn(options.exclude);

  let moved = 0;
  try {
    for (const it of invItems(bot)) {
      if (!it) continue;
      if (options.keepHotbar && it.slot >= 36 && it.slot <= 44) continue;
      if (SAFE_ITEMS.has(it.name)) continue;
      if (exclude && exclude(it)) continue;
      if (include && !include(it)) continue;

      try {
        await ui.deposit(it.type, null, it.count);
        moved += it.count || 0;
        await sleep(30);
      } catch { /* skip */ }
    }
  } finally { try { ui.close(); } catch {} }

  if (options.announce) bot.chat(`📦 Сложил ${moved} предметов.`);
  return { ok: moved>0, moved };
}

/**
 * withdrawFromChest(bot, { want, maxPerId })
 *   want: массив id ИЛИ (item)=>boolean
 */
async function withdrawFromChest(bot, opts={}) {
  const options = { radius: 6, want:null, maxPerId:64, announce:true, ...opts };
  const chestBlock = findNearestChest(bot, options.radius);
  if (!chestBlock) { bot.chat('📦 Рядом сундук/бочка не найдены.'); return { ok:false, taken:0 }; }

  let ui;
  try { ui = await bot.openChest(chestBlock); }
  catch { bot.chat('📦 Не удалось открыть сундук/бочку.'); return { ok:false, taken:0 }; }

  const wantFn = (()=>{
    if (!options.want) return ()=>true;
    if (Array.isArray(options.want)) { const S=new Set(options.want); return (i)=> S.has(i.name); }
    if (typeof options.want==='function') return options.want;
    return ()=>false;
  })();

  let taken = 0;
  const perId = new Map();

  try {
    for (const st of ui.containerItems() || []) {
      if (!st?.name) continue;
      if (!wantFn(st)) continue;

      const cap = options.maxPerId || 64;
      const got = perId.get(st.name) || 0;
      const need = Math.max(0, cap - got);
      if (need <= 0) continue;

      const takeN = Math.min(need, st.count || 0);
      if (takeN <= 0) continue;

      try {
        await ui.withdraw(st.type, null, takeN);
        perId.set(st.name, got + takeN);
        taken += takeN;
        await sleep(30);
      } catch { /* skip */ }
    }
  } finally { try { ui.close(); } catch {} }

  if (options.announce) bot.chat(`📦 Забрал ${taken} предметов.`);
  return { ok: taken>0, taken };
}

// ──────────────────────────────────────────────────────────────────────────────
// 🥪 УТИЛИТЫ: авто-еда, компактация
// ──────────────────────────────────────────────────────────────────────────────

async function ensureFood(bot, { minFood=10, prefer=['bread','cooked_beef','cooked_porkchop','golden_carrot'] } = {}) {
  const food = bot.food ?? 20;
  if (food >= minFood) return false;

  // если есть готовая еда — съесть
  for (const id of prefer) {
    const it = invItems(bot).find(i=> i.name===id);
    if (it) {
      try { await bot.equip(it,'hand'); bot.activateItem(); await sleep(800); bot.deactivateItem(); bot.chat('🍗 Перекусил.'); return true; }
      catch { /* ignore */ }
    }
  }
  // если нет — попробуем автоготовку (если включена)
  try {
    const { smeltAll } = require('../building/smelting.js');
    await smeltAll(bot, 'food', { timeoutMs: 22000 });
  } catch { /* ignore */ }
  return false;
}

async function compactStacks(bot) {
  // Mineflayer сам стакает при перемещениях; можно «пробросить» через инвентарь
  try {
    await bot.waitForTicks(1); // no-op placeholder
    return true;
  } catch { return false; }
}

// ──────────────────────────────────────────────────────────────────────────────
// Экспорт
// ──────────────────────────────────────────────────────────────────────────────
module.exports = {
  // 💼 Инвентарь
  dropSomething,

  // 🌾 Ферма
  autoFarm,

  // 📦 Склад
  storeToChest,
  withdrawFromChest,
  findNearestChest,

  // 🥪 Утилиты
  ensureFood,
  compactStacks,
};

