'use strict';
// ===============================
// features/utils/helpers.js — v2.1 "HelperBot ULTRA"
// 🧰 Утилиты: безопасное размещение/движение/поиск, быстрые и устойчивые
//   • placeBlockSmart с ориентациями (stairs/slab/door/torch/ladder/lever/button/sign)
//   • Опции: face/half/wall/requireLineOfSight/returnInfo/retries/offset
//   • Бережный прицел + LOS-джиттер, авто-sneak на краях, ретраи
//   • Безопасное движение: pathfinder (если есть) → мягкий фолбэк
//   • Стабильные findNearbyBlock (кэш), distance, hasItem, equipAny, countItem
//   • Троттлинг чата, дебаг-флаги, аккуратные yaw/face хелперы
// ===============================

const { Vec3 } = require('vec3');

// Опциональный анти-лаг, не обязателен
let perf = null;
try { perf = require('../ai/quantum/performance.cjs'); } catch { /* optional */ }

/* ─────────── КОНФИГ/ТЮНИНГ ─────────── */
const HelperConfig = {
  debug: false,
  chatThrottleMs: 900,
  losStrict: true,           // по умолчанию требуется прямой обзор для клика
  gotoTimeoutMs: 12000,      // таймаут gotoSafe
  softMoveMaxMs: 3500,       // fallback-движение
  findCacheTtlMs: 800,       // кэш поиска блоков
};

function setHelperOptions(overrides = {}) {
  Object.assign(HelperConfig, overrides || {});
  return { ...HelperConfig };
}
const getHelperOptions = () => ({ ...HelperConfig });

/* ─────────── БАЗОВЫЕ УТИЛИТЫ ─────────── */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const now   = () => Date.now();

function safeChat(bot, msg) {
  ChatLimiter.say(bot, msg);
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  const dx = (a.x - b.x), dy = (a.y - b.y), dz = (a.z - b.z);
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

function hasItem(bot, name, count = 1) {
  try {
    const it = (bot.inventory?.items?.() || []).find(i => String(i?.name).includes(String(name)));
    return !!it && (it.count || 0) >= count;
  } catch { return false; }
}

function countItem(bot, nameOrNames) {
  const names = Array.isArray(nameOrNames) ? nameOrNames.map(String) : [String(nameOrNames)];
  try {
    return (bot.inventory?.items?.() || [])
      .filter(i => i?.name && names.includes(i.name))
      .reduce((a, it) => a + (it.count || 0), 0);
  } catch { return 0; }
}

async function equipAny(bot, predicate, dest = 'hand') {
  try {
    const it = (bot.inventory?.items?.() || []).find(predicate);
    if (!it) return null;
    await bot.equip(it, dest);
    return it;
  } catch { return null; }
}

/* ─────────── КОНСТАНТЫ ДЛЯ РАЗМЕЩЕНИЯ ─────────── */

// Разрешаем ставить «поверх» этих блоков (они заменяемые)
const REPLACEABLE = new Set([
  'air','cave_air','void_air',
  'water','flowing_water','lava','flowing_lava','bubble_column',
  'grass','tall_grass','fern','large_fern','snow',
  'vine','seagrass','kelp','fire','dead_bush',
  'red_flower','yellow_flower','dandelion','poppy',
  'torch','wall_torch','soul_torch','soul_wall_torch',
  'cobweb'
]);

// Блоки, которые монтируются на стену
const WALL_MOUNTED = new Set([
  'torch','soul_torch','redstone_torch',
  'ladder','lever',
  'stone_button','oak_button','spruce_button','birch_button','acacia_button',
  'jungle_button','dark_oak_button','cherry_button','mangrove_button','bamboo_button',
  'crimson_button','warped_button',
  'wall_sign','oak_wall_sign','spruce_wall_sign','birch_wall_sign','acacia_wall_sign',
  'jungle_wall_sign','dark_oak_wall_sign','mangrove_wall_sign','cherry_wall_sign',
  'bamboo_wall_sign','crimson_wall_sign','warped_wall_sign'
]);

// Плохая опора (нельзя кликать или опасно)
const BAD_SUPPORT = new Set(['cactus','fire','lava','water','bubble_column','magma_block']);

// Жидкости/опасности (минимальный набор для безопасных решений)
const LIQUIDS = new Set(['water','flowing_water','lava','flowing_lava','bubble_column']);

/* ─────────── МАЛЕНЬКИЕ ХЕЛПЕРЫ ─────────── */
function isReplaceable(block) {
  return !block || REPLACEABLE.has(block.name) || block.boundingBox === 'empty';
}
function isSolid(block) {
  return block && block.name !== 'air' && block.boundingBox === 'block';
}
function isLiquid(block) {
  return !!block && LIQUIDS.has(block.name);
}

function clampVec3(p) {
  if (!p) return null;
  const v = (p instanceof Vec3) ? p : new Vec3(p.x, p.y, p.z);
  return new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z));
}

function findItem(bot, blockName) {
  try {
    if (bot?.heldItem?.name === blockName) return bot.heldItem;
    const items = bot?.inventory?.items?.() || [];
    return items.find(it => it?.name === blockName) || null;
  } catch { return null; }
}

function vecEqual(a, b) { return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z; }

/* ─────────── YAW/FACE ХЕЛПЕРЫ ─────────── */
function dirToFaceVec(face) {
  switch (String(face || '').toLowerCase()) {
    case 'north': return new Vec3( 0, 0,  1); // кликаем в северную грань соседнего (мы смотрим с юга)
    case 'south': return new Vec3( 0, 0, -1);
    case 'west':  return new Vec3( 1, 0,  0);
    case 'east':  return new Vec3(-1, 0,  0);
    default: return null;
  }
}
function yawForFace(face) {
  switch (String(face || '').toLowerCase()) {
    case 'north': return Math.PI;          // на -Z
    case 'south': return 0;                // на +Z
    case 'west':  return Math.PI / 2;      // на -X
    case 'east':  return -Math.PI / 2;     // на +X
    default: return null;
  }
}
function yawToFace(yaw) {
  // нормализуем в [0, 2π)
  const a = ((yaw % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
  if (a > 7*Math.PI/4 || a <= Math.PI/4)  return 'south';
  if (a <= 3*Math.PI/4) return 'west';
  if (a <= 5*Math.PI/4) return 'north';
  return 'east';
}
function faceFromVec3(v) {
  if (!v) return null;
  if (v.x ===  1 && v.z ===  0) return 'west';
  if (v.x === -1 && v.z ===  0) return 'east';
  if (v.z ===  1 && v.x ===  0) return 'north';
  if (v.z === -1 && v.x ===  0) return 'south';
  return null;
}
function aimPointForHalf(base, _faceVec, half) {
  const c = base.position.offset(0.5, 0.5, 0.5);
  if (!half) return c;
  const isTop = String(half).toLowerCase() === 'top';
  return c.offset(0, isTop ? 0.35 : -0.35, 0);
}

/* ─────────── ПРИЦЕЛ/LOS ─────────── */
async function lookAtSoft(bot, pos, jitterList = []) {
  try { await bot.lookAt(pos, true); } catch {}
  if (HelperConfig.losStrict && bot.canSeeBlock) {
    if (bot.canSeeBlock({ position: pos }) || bot.canSeeBlock(bot.blockAt(pos))) return true;
  }
  // перебираем джиттер-точки (небольшие смещения)
  for (const v of jitterList) {
    try { await bot.lookAt(pos.offset(v.x, v.y, v.z), true); } catch {}
    if (!HelperConfig.losStrict || !bot.canSeeBlock) return true;
    if (bot.canSeeBlock({ position: pos }) || bot.canSeeBlock(bot.blockAt(pos))) return true;
  }
  return !HelperConfig.losStrict; // если строгий LOS выключен — ок
}

function rayVisible(bot, blockOrPos) {
  if (!HelperConfig.losStrict) return true;
  try {
    if (!bot.canSeeBlock) return true; // нет API — считаем ок
    if (!blockOrPos) return false;
    if (blockOrPos.position) return !!bot.canSeeBlock(blockOrPos);
    return !!bot.canSeeBlock(bot.blockAt(clampVec3(blockOrPos)));
  } catch { return true; }
}

/* ─────────── ВЫБОР ОПОРЫ/ГРАНИ ДЛЯ РАЗМЕЩЕНИЯ ─────────── */
/**
 * Возвращает { base, faceVec, lookAtPos, yaw? } или null.
 * Учитывает:
 *  • двери (опора снизу + yaw)
 *  • настенные: факелы/лестницы/кнопки/рычаги/настенные таблички (wall=true|auto)
 *  • slab/stairs с half/top и ориентацией фасада
 *  • обычные — низ → стены → верх (с приоритетом по face)
 */
function pickSupportFaceOriented(bot, target, facePref, blockName, opts = {}) {
  const name = String(blockName);

  // Двери
  if (/_door$/.test(name)) {
    const under = bot.blockAt(target.offset(0, -1, 0), false);
    if (!isSolid(under)) return null;
    return {
      base: under,
      faceVec: new Vec3(0, 1, 0),
      lookAtPos: under.position.offset(0.5, 1.08, 0.5),
      yaw: yawForFace(opts.face) ?? bot.entity.yaw
    };
  }

  // Настенные
  const asWall = WALL_MOUNTED.has(name) || (name.endsWith('_torch') && opts.wall) || (name === 'torch' && opts.wall);
  if (asWall) {
    const dirs = [
      { off: new Vec3( 1, 0,  0), face: new Vec3(-1, 0,  0), dir:'west'  },
      { off: new Vec3(-1, 0,  0), face: new Vec3( 1, 0,  0), dir:'east'  },
      { off: new Vec3( 0, 0,  1), face: new Vec3( 0, 0, -1), dir:'north' },
      { off: new Vec3( 0, 0, -1), face: new Vec3( 0, 0,  1), dir:'south' }
    ];
    const ordered = facePref
      ? dirs.sort((a, b) => (a.dir === (opts.face||'').toLowerCase() ? -1 : 0) - (b.dir === (opts.face||'').toLowerCase() ? -1 : 0))
      : dirs;

    for (const d of ordered) {
      const wall = bot.blockAt(target.plus(d.off), false);
      if (isSolid(wall) && isReplaceable(bot.blockAt(target))) {
        return { base: wall, faceVec: d.face, lookAtPos: wall.position.offset(0.5, 0.62, 0.5) };
      }
    }
    // Fallback: пол — только для torch (некоторые wall-блоки не ставятся на пол)
    if (name.includes('torch')) {
      const base = bot.blockAt(target.offset(0, -1, 0), false);
      if (isSolid(base)) return { base, faceVec: new Vec3(0, 1, 0) };
    }
    return null;
  }

  // Факелы «в пол», если не wall
  if (name === 'torch' || name.endsWith('_torch')) {
    const base = bot.blockAt(target.offset(0, -1, 0), false);
    if (isSolid(base)) return { base, faceVec: new Vec3(0, 1, 0) };
    return null;
  }

  // Slab/Stairs
  const isSlab   = /_slab$/.test(name);
  const isStairs = /_stairs$/.test(name);

  // Ступени: кликаем с «обратной стороны» к желаемому фасу
  if (isStairs && facePref) {
    const opposite = facePref.scaled(-1);
    const base = bot.blockAt(target.plus(opposite), false);
    if (isSolid(base)) {
      return {
        base, faceVec: opposite,
        lookAtPos: aimPointForHalf(base, opposite, opts.half),
        yaw: yawForFace(opts.face) ?? bot.entity.yaw
      };
    }
  }

  // Общий проход для slab/stairs — учитываем half/top
  if (isSlab || isStairs) {
    const dirs = [
      { off: new Vec3( 0,-1, 0), face: new Vec3(0, 1, 0)  },
      { off: new Vec3( 1, 0, 0), face: new Vec3(-1,0, 0) },
      { off: new Vec3(-1, 0, 0), face: new Vec3( 1,0, 0) },
      { off: new Vec3( 0, 0, 1), face: new Vec3( 0,0,-1) },
      { off: new Vec3( 0, 0,-1), face: new Vec3( 0,0, 1) },
      { off: new Vec3( 0, 1, 0), face: new Vec3( 0,-1,0) }
    ];
    for (const d of dirs) {
      const base = bot.blockAt(target.plus(d.off), false);
      if (isSolid(base)) {
        return { base, faceVec: d.face, lookAtPos: aimPointForHalf(base, d.face, opts.half) };
      }
    }
    return null;
  }

  // Обычные: низ → стены → верх (с лёгким приоритетом в сторону face)
  const dirs = [
    { off: new Vec3( 0,-1, 0), face: new Vec3(0, 1, 0)  },
    { off: new Vec3( 1, 0, 0), face: new Vec3(-1,0, 0) },
    { off: new Vec3(-1, 0, 0), face: new Vec3( 1,0, 0) },
    { off: new Vec3( 0, 0, 1), face: new Vec3( 0,0,-1) },
    { off: new Vec3( 0, 0,-1), face: new Vec3( 0,0, 1) },
    { off: new Vec3( 0, 1, 0), face: new Vec3( 0,-1,0) }
  ];
  if (facePref) {
    dirs.sort((a, b) => (vecEqual(a.face, facePref) ? -1 : 0) - (vecEqual(b.face, facePref) ? -1 : 0));
  }
  for (const d of dirs) {
    const base = bot.blockAt(target.plus(d.off), false);
    if (isSolid(base)) {
      return { base, faceVec: d.face, lookAtPos: base.position.offset(0.5, 0.5, 0.5) };
    }
  }
  return null;
}

/* ─────────── РЕТРАИ ОБЩЕГО НАЗНАЧЕНИЯ ─────────── */
async function withRetries(fn, times = 2, delayMs = 90) {
  let lastErr = null;
  for (let i = 0; i < Math.max(1, times); i++) {
    try { return await fn(i); }
    catch (e) { lastErr = e; }
    await sleep(delayMs + Math.floor(Math.random()*40));
  }
  if (lastErr) throw lastErr;
  return null;
}

/* ─────────── УМНОЕ РАЗМЕЩЕНИЕ БЛОКА ─────────── */
/**
 * placeBlockSmart(bot, blockName, targetPos, {
 *   face?: 'north'|'south'|'west'|'east',
 *   half?: 'top'|'bottom',
 *   wall?: boolean,                       // строго на стену (для torch/ladder/…)
 *   requireLineOfSight?: boolean,         // по умолчанию true (перекрывает глобальный losStrict)
 *   returnInfo?: boolean,                 // вернуть { ok, reason, placed? }
 *   retries?: number,                     // попытки (по умолчанию 2)
 *   offset?: {x,y,z} | Vec3,              // сдвиг целевой ячейки
 * })
 */
async function placeBlockSmart(bot, blockName, targetPos, opts = {}) {
  const ret = (ok, reason = null) => (opts.returnInfo ? { ok, reason } : ok);
  const requireLOS = (opts.requireLineOfSight !== undefined) ? !!opts.requireLineOfSight : HelperConfig.losStrict;
  const retries = Math.max(1, (opts.retries|0) || 2);

  try {
    if (!bot?.entity?.position || !blockName || !targetPos) return ret(false, 'bad_args');

    const targetRaw = (opts.offset ? clampVec3(targetPos).plus(clampVec3(opts.offset)) : clampVec3(targetPos));
    const target = clampVec3(targetRaw);

    // Предмет
    const item = findItem(bot, blockName) || await equipAny(bot, it => it.name === blockName, 'hand');
    if (!item) return ret(false, 'no_item');

    // Цель должна быть заменяемой
    const there = bot.blockAt(target, false);
    if (there && !isReplaceable(there)) return ret(false, 'occupied');

    // Дверь: проверка пространства для «головы»
    if (/_door$/.test(blockName)) {
      const head = bot.blockAt(target.offset(0, 1, 0), false);
      if (head && !isReplaceable(head)) return ret(false, 'no_headroom');
    }

    const facePref = dirToFaceVec(opts.face);
    const pick = pickSupportFaceOriented(bot, target, facePref, blockName, opts);
    if (!pick) return ret(false, 'no_support');
    const { base, faceVec, lookAtPos, yaw } = pick;

    if (!base || BAD_SUPPORT.has(base?.name)) return ret(false, 'bad_support');

    // auto-sneak, если под ногами пусто (меньше рисков сорваться)
    const underFeet = bot.blockAt(bot.entity.position.offset(0, -1, 0), false);
    const needSneak = !isSolid(underFeet);

    // Несколько попыток прицелиться/поставить
    const jitterAim = [
      new Vec3(0.48, 0.62, 0.52),
      new Vec3(0.52, 0.44, 0.48),
      new Vec3(0.50, 0.70, 0.50)
    ];

    for (let attempt = 0; attempt < retries; attempt++) {
      // yaw для ориентируемых блоков (двери/ступени)
      if (yaw != null) {
        try { await bot.look(yaw, bot.entity.pitch, true); } catch {}
      }

      // «бережный» прицел
      const okAim = await lookAtSoft(bot, (lookAtPos || base.position.offset(0.5, 0.5, 0.5)), jitterAim);
      if (requireLOS && !okAim) return ret(false, 'no_los');

      try {
        await bot.equip(item, 'hand');
        if (needSneak) bot.setControlState?.('sneak', true);
        await bot.placeBlock(base, faceVec);
      } catch {
        // повтор попробуем после короткой задержки
      } finally {
        if (needSneak) bot.setControlState?.('sneak', false);
      }

      await bot.waitForTicks?.(2);
      await sleep(80);

      const placed = bot.blockAt(target, false);
      if (placed && placed.name === blockName) return ret(true, null);

      // малый дрифт взгляда между попытками
      await sleep(60 + Math.floor(Math.random() * 60));
    }

    return ret(false, 'not_placed');
  } catch {
    return ret(false, 'exception');
  }
}

/**
 * placeOrReplace — если в целевой ячейке мягкий мусор (трава/цветы/снег),
 * попытается сломать и поставить, не трогая твёрдые блоки.
 */
async function placeOrReplace(bot, blockName, targetPos, opts = {}) {
  const softReplace = new Set(['grass','tall_grass','fern','large_fern','snow','seagrass','kelp','dead_bush','red_flower','yellow_flower','dandelion','poppy','cobweb']);
  const t = clampVec3(targetPos);
  const there = bot.blockAt(t, false);
  if (there && softReplace.has(there.name)) {
    try { await bot.dig(there); } catch {}
    await sleep(80);
  }
  return placeBlockSmart(bot, blockName, t, opts);
}

/* ─────────── ПОИСК БЛОКОВ ПОБЛИЗОСТИ (с кэшем) ─────────── */
const _findCache = { key: '', when: 0, results: null };
function _mkFindKey(names, maxDistance) {
  return `${String(maxDistance||8)}:${names.slice().sort().join(',')}`;
}
function findNearbyBlock(bot, blockNames, maxDistance = 8) {
  try {
    const names = Array.isArray(blockNames) ? blockNames : [String(blockNames)];
    const key = _mkFindKey(names, maxDistance);
    const t = now();
    if (_findCache.key === key && t - _findCache.when < HelperConfig.findCacheTtlMs && _findCache.results) {
      return _findCache.results.bestBlock || null;
    }

    const positions = bot.findBlocks({
      matching: (b) => b && names.includes(b.name),
      maxDistance,
      count: 24
    });
    if (!positions?.length) {
      _findCache.key = key; _findCache.when = t; _findCache.results = { bestBlock: null };
      return null;
    }

    let best = null, bestDist = Infinity;
    for (const pos of positions) {
      const distVal = distance(bot.entity.position, pos);
      if (distVal < bestDist) { bestDist = distVal; best = pos; }
    }
    const blk = best ? bot.blockAt(best, false) : null;
    _findCache.key = key; _findCache.when = t; _findCache.results = { bestBlock: blk };
    return blk;
  } catch { return null; }
}

/* ─────────── БЕЗОПАСНОЕ ПЕРЕМЕЩЕНИЕ ─────────── */
/**
 * gotoSafe(bot, pos, radius=1, timeoutMs=config.gotoTimeoutMs)
 *  • pathfinder GoalNear если доступен
 *  • таймаут/отмена, без зависаний
 */
async function gotoSafe(bot, pos, radius = 1, timeoutMs = HelperConfig.gotoTimeoutMs) {
  const target = clampVec3(pos);
  const pf = bot?.pathfinder;
  if (!pf?.goto || !pf?.setMovements) return smoothMove(bot, target, radius);

  try {
    const { Movements, goals } = require('mineflayer-pathfinder');
    const { GoalNear } = goals || {};
    if (!Movements || !GoalNear) return smoothMove(bot, target, radius);
    const mc = (()=>{ try { return require('minecraft-data')(bot.version); } catch { return null; } })();
    const m = new Movements(bot, mc);
    m.canDig = false;
    m.allowSprinting = true;
    m.maxDropDownDistance = 3;
    pf.setMovements(m);

    let timer;
    await Promise.race([
      pf.goto(new GoalNear(target.x, target.y, target.z, Math.max(1, radius))),
      new Promise((_,rej)=>{ timer = setTimeout(()=>rej(new Error('goto-timeout')), timeoutMs); })
    ]).finally(()=>{ if (timer) clearTimeout(timer); });
  } catch {
    // фолбэк
    return smoothMove(bot, target, radius);
  }
}

/**
 * smoothMove(bot, pos, radius=1):
 *  • если нет pathfinder — мягкий фолбэк: лёгкое движение со стоп-контролем
 */
async function smoothMove(bot, pos, radius = 1) {
  if (!pos) return;
  const target = clampVec3(pos);

  const startAt = now();
  const maxMs   = HelperConfig.softMoveMaxMs;

  const step = () => {
    const p = bot.entity.position;
    const dx = target.x + 0.5 - p.x;
    const dz = target.z + 0.5 - p.z;
    const distXZ = Math.hypot(dx, dz);

    if (distXZ <= Math.max(0.6, radius)) return true; // достигли

    // небольшой поворот
    try {
      const yaw = Math.atan2(-dx, -dz);
      bot.look(yaw, bot.entity.pitch, true);
    } catch {}

    // аккуратно шагаем
    // авто-sneak при крае
    const underFeet = bot.blockAt(bot.entity.position.offset(0, -1, 0), false);
    const needSneak = !isSolid(underFeet);
    if (needSneak) bot.setControlState('sneak', true);

    bot.setControlState('forward', true);
    if (Math.random() < 0.15) bot.setControlState(Math.random() < 0.5 ? 'left' : 'right', true);

    // убираем боковые после маленькой паузы
    setTimeout(()=>{ try { bot.setControlState('left', false); bot.setControlState('right', false);} catch {} }, 200);

    return false;
  };

  try {
    while (now() - startAt < maxMs) {
      const done = step();
      if (done) break;
      if (perf?.yieldTicks) await perf.yieldTicks(bot, 1);
      else await sleep(80);
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('left', false);
    bot.setControlState('right', false);
    bot.setControlState('sneak', false);
  }
}

/* ─────────── ПРОСТАЯ БЕЗОПАСНОСТЬ ОТ МОБОВ ─────────── */
function isSafeFromMob(bot, mob, safeDist = 6) {
  return !mob || distance(bot.entity.position, mob.position) > safeDist;
}

/* ─────────── ЧАТ-ЛИМИТЕР/ЛОГ ─────────── */
const ChatLimiter = (() => {
  let last = 0;
  return {
    say(bot, msg) {
      const t = now();
      if (t - last >= HelperConfig.chatThrottleMs) {
        try {
          if (HelperConfig.debug) console.log('[helpers] chat:', String(msg));
          bot?.chat?.(String(msg));
        } catch {}
        last = t;
      }
    }
  };
})();

/* ─────────── ЭКСПОРТ ─────────── */
module.exports = {
  // конфиг
  setHelperOptions, getHelperOptions,

  // базовые
  sleep, now, distance, safeChat, hasItem, countItem, equipAny,

  // размещение
  placeBlockSmart, placeOrReplace, rayVisible,
  isReplaceable, isSolid, clampVec3, findItem,
  dirToFaceVec, aimPointForHalf, yawForFace, yawToFace, faceFromVec3,
  pickSupportFaceOriented, lookAtSoft,

  // поиск/движение/прочее
  findNearbyBlock, gotoSafe, smoothMove, isSafeFromMob, withRetries,

  // константы (на случай кастомизации)
  REPLACEABLE,
};
