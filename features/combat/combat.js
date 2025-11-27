'use strict';
// ============================================================================
// features/combat/combat.js — v11 "smart-pve-only"
// 🤺 Базовый PvE-модуль (Mineflayer) БЕЗ PvP
// - Только против мобов (PvP жёстко запрещён)
// - Учёт .env-чёрного списка мобов (по умолчанию: iron_golem, villager, wandering_trader, warden)
// - Human-like микродвижения, блок щитом, уклоны, стрельба, «разумные» паузы
// - Интеграция с опытами: features/ai/experience.cjs + xpHelpers (мягкие веса)
// - Безопасные проверки здоровья/ретрит
// - API: initCombat, equipBest, followAndHit, guardTick, attackByName
//
// .env (необязательно):
//   OWNER_NICKS="Promaster_Game,AnotherNick"
//   COMBAT_DENY_MOBS="iron_golem,villager,wandering_trader,warden"
//   COMBAT_DEBUG="false"
//   CHAT_PREFIX="!"
//
// Требования: pathfinder-плагин уже загружен в core/bot.cjs
// ============================================================================

const { state, SETTINGS } = require('../../core/state.cjs');
const { createLogger } = require('../../core/logger.cjs');
const log = createLogger('combat');

// XP-хелпер (опционально)
let getXP = null;
try { ({ getXP } = require('../ai/xpHelpers.cjs')); } catch {}

// Quantum-хелперы (опционально)
let Q = null;
try { Q = require('../ai/quantum'); } catch {}

const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

// ──────────────────────────────────────────────────────────────────────────────
// ENV / Конфиг
// ──────────────────────────────────────────────────────────────────────────────
const OWNER_NICKS = String(process.env.OWNER_NICKS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const DEFAULT_DENY = [
  'iron_golem', 'villager', 'wandering_trader', 'warden'
];

const ENV_DENY = String(process.env.COMBAT_DENY_MOBS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const FORBIDDEN = new Set([...DEFAULT_DENY, ...ENV_DENY]);

const COMBAT_DEBUG = String(process.env.COMBAT_DEBUG || 'false').toLowerCase() === 'true';
const COMBAT_CHATTER_CHANCE = Math.max(0, Math.min(1, parseFloat(process.env.COMBAT_CHATTER_CHANCE ?? '0.5')));
const COMBAT_CHATTER_COOLDOWN_MS = Math.max(0, parseInt(process.env.COMBAT_CHATTER_COOLDOWN_MS ?? '3200', 10));
let lastCombatChatterAt = 0;
const PVP_HARD_DISABLED = true;

// ──────────────────────────────────────────────────────────────────────────────
// Утилиты
// ──────────────────────────────────────────────────────────────────────────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => Date.now();
const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function dlog(...args) { if (COMBAT_DEBUG) try { log.debug(args.map(String).join(' ')); } catch {} }

function normName(n) {
  return String(n || '').toLowerCase().replace(/\s+/g, '_').replace(/^.*:/, '');
}
function isOwner(username = '') {
  const u = String(username).trim().toLowerCase();
  return OWNER_NICKS.some(n => n.toLowerCase() === u);
}
function dist(bot, e) {
  try { return bot.entity.position.distanceTo(e.position); } catch { return 9e9; }
}
function isNight(bot) {
  const t = bot.time?.timeOfDay ?? 0;
  return t >= 13000 && t <= 23000;
}
function biomeName(bot) {
  try { return bot.blockAt(bot.entity.position)?.biome?.name || null; } catch { return null; }
}

function isForbiddenMob(entity) {
  if (!entity || entity.type !== 'mob') return true;
  const name = normName(entity.name);
  return FORBIDDEN.has(name);
}

// ──────────────────────────────────────────────────────────────────────────────
// Фразы
// ──────────────────────────────────────────────────────────────────────────────
const PHRASES = {
  hitByOwner: ['Эй, я же за тебя!', 'Свой по мне стреляет?', 'Дружественный огонь ощущаю.'],
  hitByPlayer: ['Полегче, союзник!', 'Мне бы врагов бить, а не тебя.', 'Это точно было нужно?'],
  hitByMob: ['{mob} попал по мне!', 'Меня кусает {mob}.', 'Ловлю удар от {mob}.'],
  deathByOwner: ['Своими же меня и положили.', 'Ладно, теперь понятно, кто враг.', 'Записал: погиб от союзника.'],
  deathByPlayer: ['Меня выпилил игрок.', 'Похоже, кто-то меня не любит.', 'Игрок снял меня.'],
  deathByMob: ['{mob} оказался сильнее.', 'Поймал фатал от {mob}.', 'Запинал меня {mob}.'],
  startFight: ['Включаю боевой режим.', 'Работаю по цели.', 'Поехали шуметь.'],
  winFight: ['Готово. Дальше?', 'Цель обнулена.', 'Минус один.'],
  lowHP: ['Мне бы лечиться.', 'ХП просело, прикрой меня.', 'Нужно отдышаться.'],
  noHostiles: ['Чисто, врагов нет.', 'Сканер пустой.', 'Никого опасного.'],
  pvpBlocked: ['PvP отключено. Пропускаю.', 'В мирном режиме не дерусь.', 'Не могу бить игроков.'],
  cantSeeMob: ['Не вижу такую цель.', 'Нет подходящих мобов.', 'Не могу найти указанного моба.']
};

function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
function mobPhrase(t, mob = 'моб') { return String(t).replace(/\{mob\}/g, normName(mob).replace(/_/g, ' ')); }

// ──────────────────────────────────────────────────────────────────────────────
// Чат-очередь + human паузы
// ──────────────────────────────────────────────────────────────────────────────
const CHAT_GAP_MS = 160;
function makeChatQueue(bot) {
  const q = []; let busy = false;
  async function pump() {
    if (busy) return; busy = true;
    while (q.length) {
      const msg = q.shift();
      try { bot.chat(String(msg)); } catch {}
      await sleep(CHAT_GAP_MS);
    }
    busy = false;
  }
  return {
    say(text) { String(text).split('\n').forEach(l => q.push(l)); pump(); },
    sayOnce(text) { q.push(String(text)); pump(); }
  };
}
async function humanSay(queue, text, { minMs = 420, maxMs = 1000, chance = COMBAT_CHATTER_CHANCE } = {}) {
  if (!text) return;
  const now = Date.now();
  if (now - lastCombatChatterAt < COMBAT_CHATTER_COOLDOWN_MS) return;
  if (Math.random() > chance) return;
  await sleep(rndInt(minMs, maxMs));
  queue.sayOnce(text);
  lastCombatChatterAt = Date.now();
}

// ──────────────────────────────────────────────────────────────────────────────
/** Детекция враждебных мобов поблизости */
// ──────────────────────────────────────────────────────────────────────────────
const HOSTILES = new Set([
  'zombie','zombie_villager','husk','drowned','skeleton','stray','wither_skeleton',
  'spider','cave_spider','creeper','enderman','witch','vex','evoker','vindicator','pillager','ravager','illusioner',
  'slime','magma_cube','phantom','guardian','elder_guardian','ghast','blaze',
  'piglin','piglin_brute','zombified_piglin','hoglin','zoglin','silverfish','endermite','shulker','bogged','breeze'
]);

function nearestHostile(bot, within = 36) {
  const me = bot.entity?.position; if (!me) return null;
  let best = null, bestD = Infinity;
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e.type !== 'mob' || !e.position) continue;
    const name = normName(e.name);
    if (!HOSTILES.has(name)) continue;
    if (isForbiddenMob(e)) continue; // перестраховка
    const d = me.distanceTo(e.position);
    if (d < bestD && d <= within) { best = e; bestD = d; }
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────────────
// Инвентарь / экип
// ──────────────────────────────────────────────────────────────────────────────
function invItems(bot){ try { return bot.inventory?.items() || []; } catch { return []; } }

const TIER = ['netherite','diamond','iron','stone','golden','wooden'];
function isSword(i){ return i && i.name.endsWith('_sword'); }
function isAxe(i){ return i && i.name.endsWith('_axe'); }
function isMace(i){ return i && i.name === 'mace'; }
function isMelee(i){ return isSword(i) || isAxe(i) || isMace(i); }
function isBow(i){ return i && i.name === 'bow'; }
function isCrossbow(i){ return i && i.name === 'crossbow'; }
function isShield(i){ return i && i.name === 'shield'; }
function isArrow(i){ return i && i.name.includes('arrow'); }

function meleeRank(i){
  const base = TIER.indexOf(i?.name?.split('_')[0] || '');
  return base === -1 ? 0 : (10 - base); // чем выше материал, тем больше ранг
}

function bestMelee(bot) {
  return invItems(bot)
    .filter(isMelee)
    .sort((a,b)=> meleeRank(b) - meleeRank(a))[0] || null;
}
function hasArrows(bot){ return invItems(bot).some(isArrow); }

async function equipTo(bot, item, dest='hand'){ if (!item) return false; try { await bot.equip(item, dest); return true; } catch { return false; } }
async function equipBest(bot) {
  const melee = bestMelee(bot);
  const bow = invItems(bot).find(isBow);
  const xbow = invItems(bot).find(isCrossbow);
  // приоритет: меч/топор -> арбалет -> лук
  if (melee) return equipTo(bot, melee, 'hand');
  if (xbow)  return equipTo(bot, xbow, 'hand');
  if (bow)   return equipTo(bot, bow, 'hand');
  return false;
}
async function tryEquipShield(bot){ const sh = invItems(bot).find(isShield); if (sh) return equipTo(bot, sh, 'off-hand'); return false; }

// ──────────────────────────────────────────────────────────────────────────────
// Human-движение, визирование, щит
// ──────────────────────────────────────────────────────────────────────────────
const HUMAN = { reactionMs: [80, 250], aimJitterRad: 0.02 };
async function humanDelay(){ const [a,b]=HUMAN.reactionMs; if (Q?.humanDelay) return Q.humanDelay(rndInt(a,b)); await sleep(rndInt(a,b)); }

async function lookAtEntityHuman(bot, entity, holdMs = 0) {
  try {
    const me = bot.entity.position, tgt = entity.position;
    const aimY = entity.height ? entity.height * 0.7 : 1.2;
    const dx = tgt.x - me.x, dy = (tgt.y + aimY) - me.y, dz = tgt.z - me.z;
    let yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
    const j = HUMAN.aimJitterRad; yaw += rnd(-j, j); pitch += rnd(-j, j);
    await bot.look(yaw, pitch, true);
    if (holdMs) await sleep(holdMs);
  } catch {}
}
async function raiseShield(bot, ms = 420){
  try { await tryEquipShield(bot); bot.activateItem(); await sleep(ms); bot.deactivateItem(); } catch {}
}
async function strafe(bot, ms = 240){
  const l = Math.random() < 0.5;
  bot.setControlState(l?'left':'right', true);
  if (Math.random() < 0.25) bot.setControlState('jump', true);
  await sleep(ms);
  bot.setControlState('left', false); bot.setControlState('right', false); bot.setControlState('jump', false);
}

// ──────────────────────────────────────────────────────────────────────────────
// Выбор режима/действия
// ──────────────────────────────────────────────────────────────────────────────
function renorm(obj){ let s=0; const out={}; for(const v of Object.values(obj||{})) s += Math.max(0, +v||0); if(s<=0) return {...obj}; for(const[k,v] of Object.entries(obj||{})) out[k]=Math.max(0,+v||0)/s; return out; }
function chooseWeighted(Win){
  const W = renorm(Win||{});
  if (Q?.collapse && Q?.sharpen){
    const T = Q.scheduleTemperature(Date.now()%1e9, { T0: 1.0, k: 0.004, floor: 0.55 });
    const sharp = Q.sharpen(W, Math.max(0.55, T));
    return Q.collapse(sharp);
  }
  let sum = 0; for (const w of Object.values(W)) sum += w;
  if (sum <= 0) return null;
  let r = Math.random()*sum;
  for (const [k,w] of Object.entries(W)){ r -= w; if (r <= 0) return k; }
  return Object.keys(W)[0] || null;
}

function decideMode(bot, entity, ctx){
  const d = dist(bot, entity);
  const bow  = invItems(bot).find(isBow);
  const xbow = invItems(bot).find(isCrossbow);
  const arrows = hasArrows(bot);

  let wM=0.6, wB=0.22, wX=0.18;
  if (d < 3) wM += 0.25;
  if (d > 7) { wB += 0.25; wX += 0.25; wM -= 0.2; }
  if (!arrows) { wB = 0; wX = 0; }
  if (!bow)  wB = 0;
  if (!xbow) wX = 0;
  if (ctx.night) { wB += 0.05; wX += 0.05; }
  return chooseWeighted({ melee:wM, 'ranged-bow':wB, 'ranged-crossbow':wX }) || 'melee';
}

function decideAction(base, xp, mobName, ctx){
  let W = { ...base };
  try { W = xp?.domains?.combat?.advise(mobName, W, ctx) || W; } catch {}
  if (Q?.balanceAggressiveDefensive){
    W = Q.balanceAggressiveDefensive(W, ['attack'], ['dodge','block','circle'], 0.5, 0.25);
  }
  return chooseWeighted(W);
}

// ──────────────────────────────────────────────────────────────────────────────
// Стрельба
// ──────────────────────────────────────────────────────────────────────────────
function hasLongRange(bot){ return invItems(bot).some(i => isBow(i)||isCrossbow(i)); }
async function shootBow(bot, e){
  if (!hasArrows(bot)) return false;
  await lookAtEntityHuman(bot, e, rndInt(120, 200));
  try { bot.activateItem(); } catch {}
  await sleep(rndInt(360, 630));
  try { bot.deactivateItem(); } catch {}
  return true;
}
async function shootCrossbow(bot, e){
  if (!hasArrows(bot)) return false;
  await lookAtEntityHuman(bot, e, rndInt(100, 180));
  try { bot.activateItem(); } catch {}
  await sleep(rndInt(650, 900));
  try { bot.deactivateItem(); } catch {}
  await humanDelay();
  await lookAtEntityHuman(bot, e, rndInt(60, 140));
  try { bot.activateItem(); } catch {}
  await sleep(40);
  try { bot.deactivateItem(); } catch {}
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Состояние боя
// ──────────────────────────────────────────────────────────────────────────────
const _botState = new WeakMap();
function ensureInit(bot){
  if (_botState.has(bot)) return _botState.get(bot);
  const st = {
    running: false,
    prevHealth: bot.health,
    rhythm: new Map(),     // per-mob ударный ритм
    lastSwitch: 0,
    mode: 'melee',
    cachedBiome: null,
    biomeAt: 0,
    lastAttacker: null
  };
  _botState.set(bot, st);

  bot.on('health', () => {
    if (st.prevHealth != null && bot.health < st.prevHealth) {
      const near = nearestHostile(bot, 8) || nearestHostile(bot, 12);
      if (near) {
        const rec = st.rhythm.get(near.id) || { last: 0, avg: 0 };
        const t = now();
        if (rec.last) {
          const dt = t - rec.last;
          const a = 0.35;
          rec.avg = rec.avg ? (a*dt + (1-a)*rec.avg) : dt;
        }
        rec.last = t; st.rhythm.set(near.id, rec);
        st.lastAttacker = near;
      }
    }
    st.prevHealth = bot.health;
  });

  bot.on('entityHurt', (entity) => {
    try {
      if (!entity || entity.id !== bot.entity?.id) return;
      let attacker = null, best = Infinity;
      for (const e of Object.values(bot.entities)) {
        if (!e || e.id === bot.entity.id) continue;
        if (e.type !== 'player' && e.type !== 'mob') continue;
        const d = dist(bot, e);
        if (d < best && d <= 6.0) { attacker = e; best = d; }
      }
      if (attacker) st.lastAttacker = attacker;
    } catch {}
  });

  // Реплики при смерти
  bot.on('death', async () => {
    const say = makeChatQueue(bot);
    const a = st.lastAttacker; st.lastAttacker = null;
    if (a && a.type === 'player') {
      await humanSay(say, isOwner(a.username) ? pick(PHRASES.deathByOwner) : pick(PHRASES.deathByPlayer),
        { minMs: 380, maxMs: 850 });
    } else if (a && a.type === 'mob') {
      await humanSay(say, mobPhrase(pick(PHRASES.deathByMob), a.name), { minMs: 420, maxMs: 900 });
    } else {
      await humanSay(say, 'Бывает. Перезапущусь и продолжим.', { minMs: 420, maxMs: 900 });
    }
  });

  return st;
}

// ──────────────────────────────────────────────────────────────────────────────
// Основной бой
// ──────────────────────────────────────────────────────────────────────────────
function isRangedThreat(e){ return e && (normName(e.name)==='skeleton' || normName(e.name)==='witch' || normName(e.name)==='ghast'); }
function isCreeperPrimed(e){ try { return normName(e.name)==='creeper' && e.metadata && e.metadata[12] > 0; } catch { return false; } }

async function followAndHit(bot, entity, attempts = 24){
  const st = ensureInit(bot);
  if (st.running) return;
  if (!entity || entity.type !== 'mob' || isForbiddenMob(entity)) return;

  const say = makeChatQueue(bot);

  // безопасность по ХП
  const hpMin = SETTINGS?.MIN_HEALTH_FOR_COMBAT ?? 6;
  if ((bot.health ?? 20) < hpMin) { await humanSay(say, pick(PHRASES.lowHP), { minMs: 350, maxMs: 820 }); return; }

  st.running = true;
  if (Math.random() < 0.25) await humanSay(say, pick(PHRASES.startFight), { minMs: 300, maxMs: 780 });

  const xp = typeof getXP === 'function' ? getXP(bot) : null;
  const biome = (st.cachedBiome && now() - st.biomeAt < 60000) ? st.cachedBiome : (st.cachedBiome = biomeName(bot), st.biomeAt = now(), st.cachedBiome);
  const ctx = { night: isNight(bot), biome };

  let token=null;
  try { token = xp?.domains?.combat?.beginFight?.(entity?.name || 'mob', ctx); } catch {}

  const hp0 = bot.health ?? 20;
  const t0 = now();

  try {
    // движения
    const mc = require('minecraft-data')(bot.version);
    const mv = new Movements(bot, mc);
    mv.canDig = false; mv.allowSprinting = true;
    bot.pathfinder.setMovements(mv);

    for (let i=0; i<attempts; i++){
      if (!entity?.isValid) break;
      await humanDelay();
      await lookAtEntityHuman(bot, entity, rndInt(40, 120));

      const d = dist(bot, entity);

      if (d > 3.6) bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2.8), true);
      else if (d < 1.55) { try { bot.pathfinder.setGoal(null); } catch {} await strafe(bot, 200); }

      // режим
      const mode = decideMode(bot, entity, ctx);
      st.mode = mode;

      // экип
      const melee = bestMelee(bot);
      const bow   = invItems(bot).find(isBow);
      const xbow  = invItems(bot).find(isCrossbow);
      if (mode==='melee' && melee) await equipTo(bot, melee);
      else if (mode==='ranged-bow' && bow) await equipTo(bot, bow);
      else if (mode==='ranged-crossbow' && xbow) await equipTo(bot, xbow);

      const canAttack = (mode==='melee' ? d < 3.0 : d >= 4.0);

      // базовые веса микродействий
      let base = { attack: canAttack?0.66:0.12, dodge:0.16, block:0.12, circle:0.18 };
      if (isRangedThreat(entity)) base.dodge += 0.12;
      if (normName(entity.name)==='creeper' && isCreeperPrimed(entity)) { base.block += 0.45; base.dodge += 0.2; }

      // предсказание ритма ударов
      const rec = st.rhythm.get(entity.id);
      if (rec?.avg) {
        const eta = (rec.last || 0) + rec.avg - now();
        if (eta > 0 && eta < 260) base.block += 0.20;
      }

      // риск с учётом ХП
      if (Q?.mixtureOfExperts) {
        const hp = clamp((bot.health ?? 20)/20, 0, 1);
        const risk = clamp((ctx.night?0.15:0) + (1-hp)*0.6 + (normName(entity.name)==='enderman'?0.2:0), 0, 1);
        const advised = (()=>{ try { return xp?.domains?.combat?.advise(entity.name, base, ctx) || base; } catch { return base; } })();
        const experts = [
          { name:'base',   scores: base,   weight: 0.35 },
          { name:'xp',     scores: advised,weight: 0.40 },
          { name:'riskAdj',scores: Q.balanceAggressiveDefensive ? Q.balanceAggressiveDefensive(base, ['attack'], ['dodge','block','circle'], clamp(1-risk,0,1), 0.3) : base, weight: 0.25 }
        ];
        const T = Q.scheduleTemperature(Date.now()%1e9, { T0: mode==='melee'?0.95:1.05, k:0.003, floor:0.55 });
        base = Q.mixtureOfExperts(experts, T).probs || base;
      }

      const act = decideAction(base, xp, entity.name, ctx);

      // низкое ХП → под щитом + уход
      const retreatHp = SETTINGS?.AUTO_RETREAT_HP ?? 8;
      if ((bot.health ?? 20) <= retreatHp && Math.random()<0.35) {
        await raiseShield(bot, 420);
        await strafe(bot, 320);
      }

      // исполнение
      if (act==='attack' && canAttack) {
        if (mode==='melee') { try { bot.attack(entity); } catch {} }
        else if (mode==='ranged-bow') { await shootBow(bot, entity); }
        else if (mode==='ranged-crossbow') { await shootCrossbow(bot, entity); }
      } else if (act==='block') { await raiseShield(bot, 480); }
      else if (act==='dodge' || act==='circle') { await strafe(bot, 240); }

      if (normName(entity.name)==='creeper' && isCreeperPrimed(entity)) { await strafe(bot, 300); await raiseShield(bot, 550); }

      await sleep(140);
    }
  } catch (e) {
    dlog('error', e?.message || e);
  } finally {
    const timeMs = now() - t0;
    const damage = Math.max(0, (hp0 ?? 20) - (bot.health ?? 20));
    const win = !entity || !entity.isValid;
    const delta = damage > 6 ? { block:+0.06, dodge:+0.05, attack:-0.04 } : { attack:+0.04 };
    try { xp?.domains?.combat?.endFight?.(token, { win, timeMs, damageTaken: damage, weightsDelta: delta }); } catch {}
    st.running = false;

    if (win && Math.random()<0.5) await humanSay(makeChatQueue(bot), pick(PHRASES.winFight), { minMs:320, maxMs:740 });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Guard Tick — автозащита
// ──────────────────────────────────────────────────────────────────────────────
function guardTick(bot){
  if (!state.protectMode) return;
  if (state.inCombat) return;
  const hostile = nearestHostile(bot, SETTINGS?.PROTECT_RANGE || 16);
  if (!hostile) return;
  followAndHit(bot, hostile).catch(()=>{});
}

// ──────────────────────────────────────────────────────────────────────────────
// Реакции на урон и жёсткая блокировка PvP
// ──────────────────────────────────────────────────────────────────────────────
function wireReactions(bot){
  const say = makeChatQueue(bot);
  const st = ensureInit(bot);

  bot.on('entityHurt', async (entity) => {
    try {
      if (!entity || entity.id !== bot.entity?.id) return;

      let attacker=null, best=Infinity;
      for (const e of Object.values(bot.entities)) {
        if (!e || e.id === bot.entity.id) continue;
        if (e.type !== 'player' && e.type !== 'mob') continue;
        const d = dist(bot, e);
        if (d < best && d <= 6.0) { attacker = e; best = d; }
      }
      st.lastAttacker = attacker || st.lastAttacker;

      if (attacker && attacker.type === 'player') {
        await humanSay(say, isOwner(attacker.username) ? pick(PHRASES.hitByOwner) : pick(PHRASES.hitByPlayer),
          { minMs:520, maxMs:1100, chance:0.95 });
        return;
      }
      if (attacker && attacker.type === 'mob') {
        await humanSay(say, mobPhrase(pick(PHRASES.hitByMob), attacker.name), { minMs:420, maxMs:950, chance:0.98 });
        return;
      }
      if (Math.random() < 0.25) await humanSay(say, 'Хм, кто-то задел, но не вижу.', { minMs:600, maxMs:1100, chance:0.6 });
    } catch {}
  });

  // если кто-то попытается «заставить» ударить игрока — отвечаем
  bot.on('chat:tryAttackPlayer', async (username) => {
    await humanSay(say, pick(PHRASES.pvpBlocked), { minMs:360, maxMs:820 });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Внешний API (с защитой от PvP)
// ──────────────────────────────────────────────────────────────────────────────
async function attackByName(bot, targetToken){
  const say = makeChatQueue(bot);
  if (!targetToken) return false;

  // игрок? → блок
  const isPlayer = Object.keys(bot.players || {}).some(p => p && p.toLowerCase() === String(targetToken).toLowerCase());
  if (isPlayer || PVP_HARD_DISABLED) {
    try { bot.emit('chat:tryAttackPlayer', targetToken); } catch {}
    await humanSay(say, pick(PHRASES.pvpBlocked), { minMs:380, maxMs:850 });
    return false;
  }

  const me = bot.entity?.position;
  if (!me) { await humanSay(say, 'Я не готов к атаке.', { minMs:320, maxMs:680 }); return false; }

  const targetName = normName(targetToken);
  const cand = Object.values(bot.entities)
    .filter(e => e?.type === 'mob' && normName(e.name) === targetName && !isForbiddenMob(e))
    .sort((a, b) => me.distanceTo(a.position) - me.distanceTo(b.position))[0];

  if (!cand) { await humanSay(say, pick(PHRASES.cantSeeMob), { minMs:350, maxMs:800 }); return false; }

  await humanSay(say, `⚔️ Цель: ${normName(cand.name)}`, { minMs:350, maxMs:800 });
  await followAndHit(bot, cand, 24);
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Инициализация
// ──────────────────────────────────────────────────────────────────────────────
function initCombat(bot){
  ensureInit(bot);
  wireReactions(bot);
  // guardTick дергай из твоего цикла/physicsTick или setInterval с учётом state.protectMode
}

module.exports = {
  initCombat,
  equipBest,
  followAndHit,
  guardTick,
  attackByName
};

