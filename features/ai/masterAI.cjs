'use strict';
/**
 * features/ai/masterAI.cjs — v2.3 "Orchestrator+"
 * 🎛️ Высокоуровневый ИИ-оркестратор (без парсинга чата/UI).
 *
 * Что умеет:
 *  • Мягкая инициализация skills (skillBrain) и опыта (experience).
 *  • Guard (авто-PvE) поверх combat-модуля (advancedCombat.js → combat.js).
 *  • Если combat нет — надёжный fallback-PvE на pathfinder.
 *  • Управление deny-листом и радиусом сканирования.
 *  • Экспорт хелперов для внешних команд: включить/выключить охрану, приоритет работы.
 *
 * Важно:
 *  • Orchestrator НЕ парсит чат. Команды остаются в exploration/fun.js.
 *  • Для задач “руби/копай/крафти” вызывай masterAI.disableGuardForWork()
 *    перед стартом — чтобы работа не конфликтовала с боем.
 */

const path = require('path');
const { EventEmitter } = require('events');
const { state } = require('../../core/state.cjs');

// ──────────────────────────────────────────────────────────────────────────────
// Опции / состояние
// ──────────────────────────────────────────────────────────────────────────────
const DEFAULTS = {
  debug: false,
  guardIntervalMs: Number(process.env.GUARD_INTERVAL_MS || 1400),
  hostileScanRadius: Number(process.env.HOSTILE_SCAN_RADIUS || 36),
  deny: String(process.env.COMBAT_DENY_MOBS || process.env.COMBAT_DENY || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
};

const _st = {
  opt: { ...DEFAULTS },
  bot: null,
  emitter: new EventEmitter(),
  guardIv: null,
  guardBusy: false,
  pve: null,          // combat-модуль (или fallback)
  skills: null,       // features/ai/skillBrain.cjs (опционально)
  exp: null,          // features/ai/experience.cjs (опционально)
  inited: false
};

// ──────────────────────────────────────────────────────────────────────────────
// Вспомогалки
// ──────────────────────────────────────────────────────────────────────────────
const log = (...a) => { if (_st.opt.debug) try { console.log('[masterAI]', ...a); } catch {} };
const safeRequire = (p) => { try { return require(p); } catch { return null; } };
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '_').replace(/^.*:/, '');

const HOSTILE_RX = [
  /zombie/,/husk/,/drowned/,/bogged/,/zombie_villager/,
  /skeleton/,/stray/,/wither_skeleton/,
  /creeper/,/spider/,/cave_spider/,
  /enderman/,/endermite/,
  /slime/,/magma_cube/,
  /phantom/,
  /witch/,
  /ghast/,/blaze/,/guardian/,/elder_guardian/,
  /pillager/,/vindicator/,/evoker/,/illusioner/,/ravager/,/vex/,
  /piglin/,/piglin_brute/,/zombified_piglin/,
  /shulker/,/silverfish/,
  /breeze/,/hoglin/,/zoglin/,/warden/
];

const isDenied = (ent) => {
  const n = norm(ent?.name || ent?.displayName || '');
  return !!n && _st.opt.deny.includes(n);
};
const isHostile = (ent) => {
  if (!ent || ent.type !== 'mob') return false;
  const n = norm(ent.name || ent.displayName || '');
  if (!n || isDenied(ent)) return false;
  return HOSTILE_RX.some(rx => rx.test(n));
};
const nearestHostile = (bot, within) => {
  const me = bot?.entity?.position; if (!me) return null;
  const r2 = within * within;
  let best = null, bestD2 = Infinity;
  for (const ent of Object.values(bot.entities || {})) {
    if (ent?.type !== 'mob' || !ent.position) continue;
    if (!isHostile(ent)) continue;
    const dx = ent.position.x - me.x;
    const dy = ent.position.y - me.y;
    const dz = ent.position.z - me.z;
    const d2 = dx*dx + dy*dy + dz*dz;
    if (d2 < r2 && d2 < bestD2) { best = ent; bestD2 = d2; }
  }
  return best;
};

// ──────────────────────────────────────────────────────────────────────────────
/** Мягкие зависимости: skills/experience */
// ──────────────────────────────────────────────────────────────────────────────
async function initSkills(bot) {
  const mod = safeRequire(path.join(__dirname, './skillBrain.cjs'));
  if (!mod) return null;
  try { await mod.init?.(bot, { debug: false }); log('skillBrain ready'); } catch {}
  return mod;
}
async function initExperience(bot) {
  const mod = safeRequire(path.join(__dirname, './experience.cjs'));
  if (!mod) return null;
  try { await mod.init?.(bot, { debug: false }); log('experience ready'); } catch {}
  return mod;
}

// ──────────────────────────────────────────────────────────────────────────────
/** Combat-модуль или fallback-PvE */
// ──────────────────────────────────────────────────────────────────────────────
function loadCombatOrFallback() {
  const requiredApi = ['guardTick', 'followAndHit', 'attackByName'];
  const hasApi = (mod) => requiredApi.every(fn => typeof mod?.[fn] === 'function');

  // ВАЖНО: masterAI лежит в features/ai → combat в корне проекта: ../../combat/...
  let pve = safeRequire(path.join(__dirname, '../../combat/advancedCombat.js'));
  if (pve && !hasApi(pve)) {
    log('combat module: advanced lacks guard API → falling back to basic');
    pve = null;
  }
  if (!pve) {
    const basic = safeRequire(path.join(__dirname, '../../combat/combat.js'));
    if (basic && hasApi(basic)) {
      pve = basic;
      log('combat module: basic guard API loaded');
    } else if (basic) {
      log('combat module: basic found but missing guard API, ignoring');
    }
  }

  if (pve) return pve;

  // ---- Fallback-PvE (чтобы всегда было PvE) ----
  log('no combat module found → enabling fallback PvE');
  const { goals, Movements } = safeRequire('mineflayer-pathfinder') || {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const equip = async (bot, item, dest='hand') => { try { await bot.equip(item,dest); return true; } catch { return false; } };
  const invItems = (bot)=>{ try { return bot.inventory?.items() || []; } catch { return []; } };
  const isSword  = i => i && /_sword$/.test(i.name);
  const isAxe    = i => i && /_axe$/.test(i.name);
  const isMace   = i => i && i.name === 'mace';
  const isShield = i => i && i.name === 'shield';
  const bestMelee = (bot)=>{
    const tier=['netherite','diamond','iron','stone','golden','wooden'];
    const items=invItems(bot).filter(i=>isSword(i)||isAxe(i)||isMace(i));
    items.sort((a,b)=> tier.indexOf(a.name.split('_')[0]) - tier.indexOf(b.name.split('_')[0]));
    return items[0] ? items[0] : null;
  };
  const primedCreeper = e => norm(e?.name)==='creeper' && e?.metadata && e.metadata[12] > 0;

  async function followAndHit(bot, entity, steps = 24) {
    if (!bot || !entity?.position) return;
    if (_st.guardBusy) return; _st.guardBusy = true;

    try {
      state.inCombat = true;

      // Движение
      try {
        const mc = require('minecraft-data')(bot.version);
        if (Movements) {
          const mv = new Movements(bot, mc);
          mv.canDig = false; mv.allowSprinting = true;
          bot.pathfinder?.setMovements(mv);
        }
      } catch {}

      // Экип
      const melee = bestMelee(bot); if (melee) await equip(bot, melee, 'hand');
      const sh = invItems(bot).find(isShield); if (sh) await equip(bot, sh, 'off-hand');

      let lastSwing = 0;
      for (let i = 0; i < steps; i++) {
        if (!entity?.isValid || isDenied(entity) || !isHostile(entity)) break;
        const me = bot.entity?.position; if (!me) break;
        const d = me.distanceTo(entity.position);

        // Не подпускаем крипера слишком близко
        const wantDist = primedCreeper(entity) ? 3.2 : 2.8;

        // Подходим / держим дистанцию
        if (goals && d > wantDist) {
          try { bot.pathfinder.setGoal(new goals.GoalFollow(entity, wantDist - 0.3), true); } catch {}
        } else if (d < 1.5) {
          try { bot.pathfinder.setGoal(null); } catch {}
        }

        // Прицел
        try { bot.lookAt(entity.position.offset(0, entity.height ? entity.height * 0.7 : 1.2, 0), true); } catch {}

        // Блок от скелета/ведьмы/заряженного удара
        if (sh && (norm(entity.name)==='skeleton' || norm(entity.name)==='witch' || primedCreeper(entity))) {
          try { bot.activateItem(); await sleep(420); bot.deactivateItem(); } catch {}
        }

        // Удар с КД
        const now = Date.now();
        if (d <= 3.1 && now - lastSwing > 550) {
          try { await bot.attack(entity); } catch { try { bot.swingArm?.('hand'); } catch {} }
          lastSwing = now;
        }

        // Лёгкий стрейф
        if (d < 3.2 && Math.random() < 0.2) {
          const key = Math.random() < 0.5 ? 'left' : 'right';
          try { bot.setControlState(key, true); } catch {}
          await sleep(160 + (Math.random()*120|0));
          try { bot.setControlState(key, false); } catch {}
        }

        await sleep(70 + (Math.random()*60|0));
      }
    } finally {
      try { bot.pathfinder?.setGoal?.(null); } catch {}
      state.inCombat = false;
      _st.guardBusy = false;
    }
  }

  function guardTick(bot) {
    if (_st.guardBusy) return;
    const tgt = nearestHostile(bot, _st.opt.hostileScanRadius);
    if (tgt) followAndHit(bot, tgt, 24).catch(()=>{});
  }

  async function attackByName(bot, token) {
    const name = norm(token);
    if (!name) return false;
    // если рядом есть моб с таким именем — ударим, иначе просто включим guard
    const me = bot?.entity?.position; if (!me) return false;
    let target = null; let best = Infinity;
    for (const e of Object.values(bot.entities || {})) {
      if (e?.type !== 'mob' || !e?.position) continue;
      if (norm(e.name) !== name) continue;
      const d = me.distanceTo(e.position);
      if (d < best) { best = d; target = e; }
    }
    if (target) { followAndHit(bot, target, 24).catch(()=>{}); return true; }
    return false;
  }

  return { followAndHit, guardTick, attackByName };
}

// ──────────────────────────────────────────────────────────────────────────────
/** Guard-цикл — единственный источник авто-PvE */
// ──────────────────────────────────────────────────────────────────────────────
function startGuard() {
  if (_st.guardIv) return;
  const bot = _st.bot;
  const pve = _st.pve;

  const tick = async () => {
    try {
      if (!bot?.entity?.position) return;
      if (!state.protectMode) return;   // вкл/выкл задаёт fun.js
      if (_st.guardBusy) return;
      if (typeof pve?.guardTick === 'function') { pve.guardTick(bot); return; }
      const tgt = nearestHostile(bot, _st.opt.hostileScanRadius);
      if (!tgt) return;
      if (typeof pve?.followAndHit === 'function') { pve.followAndHit(bot, tgt, 24); }
    } catch {}
  };

  _st.guardIv = setInterval(tick, _st.opt.guardIntervalMs);
}
function stopGuard() {
  if (_st.guardIv) clearInterval(_st.guardIv);
  _st.guardIv = null;
}

// ──────────────────────────────────────────────────────────────────────────────
/** Публичные API: init/опции/guard-хелперы/deny-лист */
// ──────────────────────────────────────────────────────────────────────────────
async function init(botOrOptions, maybeOptions) {
  let bot = null, opt = maybeOptions || botOrOptions || {};
  if (botOrOptions && botOrOptions.on && botOrOptions.entity) { bot = botOrOptions; opt = maybeOptions || {}; }

  _st.opt = { ...DEFAULTS, ...(opt || {}) };
  if (!bot) return api; // конфиг без запуска

  if (_st.inited) return api;
  _st.inited = true;

  _st.bot = bot;
  _st.pve = loadCombatOrFallback();

  // мягкие зависимости — не валим запуск
  _st.skills = await initSkills(bot);
  _st.exp    = await initExperience(bot);

  startGuard();

  const quit = () => { try { stopGuard(); } catch {} };
  bot.once('end', quit);
  bot.once?.('kicked', quit);

  log('initialized', { guardMs: _st.opt.guardIntervalMs, radius: _st.opt.hostileScanRadius });
  return api;
}

function setOptions(overrides = {}) {
  _st.opt = { ..._st.opt, ...(overrides || {}) };
  if (_st.guardIv) { stopGuard(); startGuard(); }
  return { ..._st.opt };
}

// —— Guard-хелперы для вызова из fun.js (чтобы работа не дралась с боем)
function enableGuard()  { if (!state.protectMode) state.protectMode = true;  startGuard(); return true; }
function disableGuard() { if (state.protectMode)  state.protectMode = false; stopGuard(); return true; }

/** Приоритет работы: выключаем охрану на период задач (рубка/копка/крафт) */
function disableGuardForWork() {
  if (state.protectMode) {
    state.protectMode = false;
    stopGuard();
    log('work has priority → guard disabled');
  }
  return true;
}

// —— Deny-list
function setDenyList(list) {
  _st.opt.deny = Array.from(new Set((list || []).map(s => String(s).toLowerCase())));
  return _st.opt.deny.slice();
}
function addDeny(name) {
  const n = norm(name);
  if (!n) return false;
  if (!_st.opt.deny.includes(n)) _st.opt.deny.push(n);
  return true;
}
function removeDeny(name) {
  const n = norm(name);
  const i = _st.opt.deny.indexOf(n);
  if (i >= 0) { _st.opt.deny.splice(i, 1); return true; }
  return false;
}

function status() {
  return {
    guardRunning: !!_st.guardIv,
    deny: _st.opt.deny.slice(),
    radius: _st.opt.hostileScanRadius,
    hasSkills: !!_st.skills,
    hasExperience: !!_st.exp,
    usingFallback: !(_st.pve?.guardTick || _st.pve?.followAndHit || _st.pve?.attackByName) ? true : false
  };
}

const api = {
  init,
  setOptions,
  status,
  // guard helpers:
  enableGuard, disableGuard, disableGuardForWork,
  guardOn: enableGuard, guardOff: disableGuard,
  // для fun.js/debug:
  findNearestHostile: (within)=> nearestHostile(_st.bot, within || _st.opt.hostileScanRadius),
  // deny-list
  setDenyList, addDeny, removeDeny,
  // события на будущее
  on: (...a) => _st.emitter.on(...a),
  off: (...a) => _st.emitter.off(...a)
};

module.exports = api;
