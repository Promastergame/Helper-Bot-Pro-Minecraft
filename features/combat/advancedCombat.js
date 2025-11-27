
'use strict';
// ===============================
// features/combat/advancedCombat.cjs (v11-Q+)
// 🤺 ПРОДВИНУТАЯ СИСТЕМА БОЯ + КВАНТОВЫЙ ИИ + ОПЫТ
// • Умные тактики для всех мобов
// • Поддержка новых мобов: пустынный скелет, зомби-верблюд
// • Реалистичные реакции в чате при атаках
// • Ретрит+хил под щитом, укрытия, ETA стрел, анти-залипание
// • Интеграция: features/ai/quantum (опционально), features/ai/experience.cjs
// • CommonJS, без внешних зависимостей
// ===============================

const { Vec3 } = require('vec3');
const { state } = require('../../core/state.cjs');

// Quantum facade (опционально)
let Q; try { Q = require('../ai/quantum/index.cjs'); } catch { Q = null; }

// XP integration
let xp; try { xp = require('../ai/experience.cjs'); } catch { xp = null; }

/* ────────── УТИЛИТЫ ────────── */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const now = () => Date.now();
const dist3 = (a, b) => a.distanceTo ? a.distanceTo(b) : Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const rnd = (a, b) => a + (Math.random() * (b - a));
const rndInt = (a, b) => Math.floor(rnd(a, b));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

function renorm(obj) {
  let s = 0;
  const out = {};
  for (const v of Object.values(obj || {})) s += Math.max(0, Number(v) || 0);
  if (s <= 0) return { ...obj };
  for (const [k, v] of Object.entries(obj || {})) out[k] = Math.max(0, Number(v) || 0) / s;
  return out;
}

function chooseWeighted(weights) {
  const W = renorm(weights || {});
  if (Q?.collapse && Q?.sharpen) {
    const T = Q.scheduleTemperature(Date.now() % 1e9, { T0: 1.0, k: 0.004, floor: 0.5 });
    const sharp = Q.sharpen(W, Math.max(0.58, T));
    return Q.collapse(sharp);
  }
  let sum = 0;
  for (const w of Object.values(W)) sum += w;
  if (sum <= 0) return null;
  let r = Math.random() * sum;
  for (const [k, w] of Object.entries(W)) { r -= w; if (r <= 0) return k; }
  return Object.keys(W)[0] || null;
}

/* ────────── НАСТРОЙКИ ПО УМОЛЧАНИЮ ────────── */
const defaults = {
  tickMs: 110,
  replanMs: 420,
  maxPursueTimeMs: 20000,

  human: { reactionMs: [70, 210], aimJitterRad: [0.008, 0.028] },

  melee: {
    ideal: 2.6, min: 1.6, max: 3.5,
    circleStrafeMs: 340, circleRadius: 2.0,
    jumpCritChance: 0.22, jumpCritWindowMs: 210
  },

  ranged: {
    preferBow: true,
    keepMin: 7, keepMax: 12,
    arrowSpeed: 3.0, gravity: 0.05,
    preAimMs: 160, drawMs: [360, 630], cooldownMs: 240
  },

  shield: { enable: true, minHoldMs: 380, holdExtraMs: 240, vsSkeleton: true, vsCreeper: true, vsGhast: true },

  dodge: { enable: true, strafeMs: 240, jumpChance: 0.25, cooldownMs: 680 },

  hitAndRun: { burstHits: 1, retreatTo: 6.8, retreatMs: 620 },

  heal: {
    enable: true,
    hpThreshold: 8,
    eatItems: ['bread', 'cooked_beef', 'cooked_mutton', 'cooked_porkchop', 'baked_potato', 'pumpkin_pie', 'cooked_salmon', 'cooked_cod', 'golden_carrot']
  },

  cover: { use: true, maxDistance: 8, inShootWindow: true },

  integration: {
    withBrain: true, brainCombatMode: 'combat',
    withAdaptive: true,
    rngSeed: null
  },

  debug: { log: false }
}

/* ────────── ПОМОЩНИКИ ИНВЕНТАРЯ ────────── */
function firstInInv(bot, names) {
  try { return bot.inventory.items().find(i => names.includes(i.name)) || null; } catch { return null; }
}
function hasAny(bot, names) {
  try { return bot.inventory.items().some(i => names.includes(i.name)); } catch { return false; }
}
const isMelee = i => i && (i.name.endsWith('_sword') || i.name.endsWith('_axe') || i.name === 'mace');
const isBow = i => i && i.name === 'bow';
const isCrossbow = i => i && i.name === 'crossbow';
const isShield = i => i && i.name === 'shield';
const isArrow = i => i && i.name.includes('arrow');

async function equipTo(bot, item, dest = 'hand') { if (!item) return false; try { await bot.equip(item, dest); return true; } catch { return false; } }
async function tryEquipShield(bot) { const sh = firstInInv(bot, ['shield']); if (sh) await equipTo(bot, sh, 'off-hand'); }
function hasArrows(bot) { return hasAny(bot, ['arrow']); }

function bestWeapon(bot) {
  const dmg = {
    'netherite_sword': 8, 'diamond_sword': 7, 'iron_sword': 6, 'stone_sword': 5, 'golden_sword': 4, 'wooden_sword': 4,
    'netherite_axe': 10, 'diamond_axe': 9, 'iron_axe': 9, 'stone_axe': 9, 'golden_axe': 7, 'wooden_axe': 7,
    'bow': 6, 'crossbow': 7,
    'trident': 8 // 🆕 Добавлен трезубец
  };
  try {
    const items = bot.inventory.items().filter(i => dmg[i.name]);
    if (!items.length) return null;
    return items.sort((a, b) => (dmg[b.name] || 1) - (dmg[a.name] || 1))[0];
  } catch { return null; }
}

/* ────────── СОСТОЯНИЕ ЦЕЛИ ────────── */
class TargetState {
  constructor(e) {
    this.id = e.id; this.name = e.name;
    this.firstSeen = now(); this.lastSeen = now();
    this.lastPos = e.position.clone(); this.vel = new Vec3(0, 0, 0);
    this.lastAttack = 0; this.lastDodge = 0; this.lastBlock = 0;
    this.mode = 'approach'; this.lastDamageTime = 0; this.rhythmAvgMs = 0;
  }

  update(entity) {
    const t = now(); const dt = Math.max(1, t - this.lastSeen);
    const p = entity.position.clone();
    const dvx = (p.x - this.lastPos.x), dvy = (p.y - this.lastPos.y), dvz = (p.z - this.lastPos.z);
    this.vel = new Vec3(dvx / dt, dvy / dt, dvz / dt);
    this.lastPos = p; this.lastSeen = t;
  }

  noteIncomingHit() {
    const t = now();
    if (this.lastDamageTime) {
      const interval = t - this.lastDamageTime; const a = 0.35;
      this.rhythmAvgMs = this.rhythmAvgMs ? (a * interval + (1 - a) * this.rhythmAvgMs) : interval;
    }
    this.lastDamageTime = t;
  }
}

/* ────────── МЕНЕДЖЕР БОЯ ────────── */
class CombatManager {
  constructor(opts = {}) {
    this.opt = deepMerge(defaults, opts);
    this.targets = new Map();
    this._tickIv = null; this._lastReplan = 0;
    this.tactics = new Map(); this._goals = null; this._adaptive = null;
    this._prevHealth = null;
    this.fightTokens = new Map(); // id -> { token, startHp, t0 }
    this._watchdog = { lastPos: null, lastT: 0, stuckMs: 0 };
    this._lastCover = 0;

    try { if (Q && this.opt.integration.rngSeed != null) Q.configure({ rng: 'seed', seed: String(this.opt.integration.rngSeed) }); } catch {}
    this.loadDefaultTactics();
  }

  log(...args) { if (this.opt.debug.log) console.log('[combat]', ...args); }

  async _getGoals() {
    if (this._goals) return this._goals;
    const { goals } = await import('mineflayer-pathfinder');
    this._goals = goals; return goals;
  }

  _maybeLoadAdaptive() {
    if (!this.opt.integration.withAdaptive) return;
    if (this._adaptive !== null) return;
    try { this._adaptive = require('../environment/adaptive.cjs'); } catch { this._adaptive = undefined; }
  }

  attach(bot) {
    this.bot = bot; this._maybeLoadAdaptive();

    if (this.opt.integration.withBrain && bot.brain?.setMode) {
      try { bot.brain.setMode(this.opt.integration.brainCombatMode); } catch {}
    }
    if (!this._tickIv) this._tickIv = setInterval(() => this.tick(), this.opt.tickMs);

    this._prevHealth = bot.health;
    const onHealth = () => {
      if (this._prevHealth != null && bot.health < this._prevHealth) {
        const e = this._nearestHostile(bot, 6) || this._currentTargetEntity(bot);
        if (e) {
          let ts = this.targets.get(e.id); if (!ts) { ts = new TargetState(e); this.targets.set(e.id, ts); }
          ts.noteIncomingHit();
          this.log('Получен удар; ритм ≈', Math.floor(ts.rhythmAvgMs || 0));

          // 🆕 РЕАКЦИЯ В ЧАТ ПРИ ПОЛУЧЕНИИ УРОНА
          this._chatReaction(bot, e);
        }
      }
      this._prevHealth = bot.health;
    };
    bot.on('health', onHealth);

    bot.once('end', () => this.detach());
    bot.once('kicked', () => this.detach());
  }

  detach() {
    if (this._tickIv) clearInterval(this._tickIv), this._tickIv = null;
    if (this.bot && this.opt.integration.withBrain && this.bot.brain?.setMode) {
      try { this.bot.brain.setMode('idle'); } catch {}
    }
    try {
      for (const [id, rec] of this.fightTokens.entries()) {
        try { xp?.domains?.combat?.endFight?.(rec.token, { win: false, timeMs: Date.now() - rec.t0, damageTaken: Math.max(0, (rec.startHp || 20) - (this.bot?.health || 0)) }); } catch {}
      }
    } catch {}
    this.fightTokens.clear();
  }

  loadDefaultTactics() {
    // 🆕 ДОБАВЛЕНЫ НОВЫЕ МОБЫ С УМНЫМИ ТАКТИКАМИ
    this.tactics.set('zombie', { style: 'melee', keep: 2.6, circle: true, fallback: 'melee' });
    this.tactics.set('drowned', { style: 'melee', keep: 2.6, circle: true, fallback: 'melee' });
    this.tactics.set('husk', { style: 'melee', keep: 2.6, circle: true, fallback: 'melee' });
    this.tactics.set('spider', { style: 'melee', keep: 2.8, jumpy: true, fallback: 'melee' });
    this.tactics.set('cave_spider', { style: 'melee', keep: 2.8, jumpy: true, fallback: 'melee' });
    this.tactics.set('skeleton', { style: 'ranged', keep: 10, useCover: true, fallback: 'melee' });
    this.tactics.set('stray', { style: 'ranged', keep: 10, useCover: true, fallback: 'melee' });
    this.tactics.set('creeper', { style: 'hit_and_run', keep: 4.2, retreat: 7, fallback: 'melee' });
    this.tactics.set('enderman', { style: 'melee', keep: 2.8, lookAtFeet: true, fallback: 'melee' });
    this.tactics.set('witch', { style: 'ranged', keep: 11, useCover: true, fallback: 'melee' });
    
    // 🆕 НОВЫЕ МОБЫ - ПУСТЫННЫЙ СКЕЛЕТ И ЗОМБИ-ВЕРБЛЮД
    this.tactics.set('desert_skeleton', {
      style: 'ranged',
      keep: 9,
      useCover: true,
      fallback: 'melee',
      special: 'desert_shield' // Особый тип - чаще использует щит
    });
    
    this.tactics.set('camel_zombie', {
      style: 'hit_and_run',
      keep: 4.5,
      retreat: 8.0, // Большая дистанция отступления
      fallback: 'melee',
      special: 'camel_charge' // Может "заряжаться" для атаки
    });
    
    // 🆕 ДОПОЛНИТЕЛЬНЫЕ МОБЫ
    this.tactics.set('phantom', { style: 'ranged', keep: 8, useCover: false, fallback: 'melee' });
    this.tactics.set('ravager', { style: 'hit_and_run', keep: 5.0, retreat: 7.5, fallback: 'melee' });
    this.tactics.set('piglin_brute', { style: 'melee', keep: 2.7, circle: true, fallback: 'melee' });
  }

  /* ── XP ТОКЕНЫ ── */
  _beginFightToken(bot, entity) {
    try {
      if (!xp?.domains?.combat || !entity) return;
      if (this.fightTokens.has(entity.id)) return;
      const ctx = { night: ((bot.time?.timeOfDay ?? 0) >= 13000 && (bot.time?.timeOfDay ?? 0) <= 23000), y: Math.floor(bot.entity.position.y) };
      const token = xp.domains.combat.beginFight ? xp.domains.combat.beginFight(entity.name, ctx) : 'noop';
      this.fightTokens.set(entity.id, { token, startHp: bot.health || 20, t0: Date.now() });
    } catch {}
  }

  _endFightToken(bot, entityId, win) {
    try {
      const rec = this.fightTokens.get(entityId); if (!rec) return;
      this.fightTokens.delete(entityId);
      const damageTaken = Math.max(0, (rec.startHp || 20) - (bot.health || 0));
      try { xp.domains.combat.endFight(rec.token, { win: !!win, timeMs: Date.now() - rec.t0, damageTaken }); } catch {}
      try {
        if (win) bot.brain?.say?.('✅ Готово.');
        else if ((bot.health ?? 20) < 6) bot.brain?.say?.('🛡️ Отхожу, мало ХП!');
        bot.brain?.setMode?.('idle');
      } catch {}
    } catch {}
  }

  _advise(mobName, base, ctx) {
    try { return xp?.domains?.combat?.advise ? xp.domains.combat.advise(mobName, base, ctx || {}) : base; } catch { return base; }
  }

  /* 🆕 РЕАКЦИИ В ЧАТ ПРИ АТАКАХ */
  _chatReaction(bot, attacker) {
    if (!bot.brain?.say) return;

    const reactions = {
      // Реакции на игроков
      player: [
        "Эй, аккуратнее! Я не дерусь с игроками, только с мобами!",
        "Ой, больно! Давай без PvP!",
        "Я мирный бот, не бей! 🏳️"
      ],

      // Реакции на конкретных мобов
      desert_skeleton: [
        "Ты что, пустынный скелет, с ума сошел!",
        "Песчаные стрелы? Серьёзно? 😠",
        "Отстань, костяшка пустынная!"
      ],

      camel_zombie: [
        "Что за зомби-верблюд? Откуда ты взялся?",
        "Фу, верблюжий зомби! Держись подальше!",
        "Ты слишком воняешь, чтобы подходить ближе! 🐫☠️"
      ],

      creeper: [
        "Не подходи слишком близко, щас бахнет! 💥",
        "Тссс... тише, крипер!",
        "Отступаю от зеленого пуфера! 🚩"
      ],

      enderman: [
        "Не смотри на меня так, эндермен!",
        "Варп-варп? Отстань!",
        "Телепортируйся отсюда! ✨"
      ],

      // Общие реакции на мобов
      default: [
        "Ай, больно!",
        "Получил удар! Контратакую!",
        "Так, кто это тут меня бьёт?",
        "Пощады! Шучу, сейчас ответку дам! 😄"
      ]
    };

    let reactionList = reactions.default;

    if (attacker.type === 'player') {
      reactionList = reactions.player;
    } else if (reactions[attacker.name]) {
      reactionList = reactions[attacker.name];
    }

    // 30% шанс ответить в чат
    if (Math.random() < 0.3) {
      const message = reactionList[Math.floor(Math.random() * reactionList.length)];
      setTimeout(() => {
        try { bot.brain.say(message); } catch {}
      }, rndInt(500, 1500)); // Случайная задержка для реалистичности
    }
  }

  /* ────────── ОСНОВНОЕ API ────────── */
  async engageCombat(bot, entity) {
    if (!bot || !entity || !entity.isValid) return;
    if (!this.bot) this.attach(bot);
    if (!this.targets.has(entity.id)) this.targets.set(entity.id, new TargetState(entity));
    await this.equipBestWeapon(bot, entity).catch(() => {});
    try { await this.lookAtEntityCenter(bot, entity, rndInt(130, 210)); } catch {}
    this._beginFightToken(bot, entity);
    
    // 🆕 РЕАКЦИЯ НА НАЧАЛО БОЯ
    if (bot.brain?.say) {
      const startPhrases = [
        `Вступаю в бой с ${entity.name}!`,
        `Атакован ${entity.name}! В бой!`,
        `Замечен ${entity.name}! Уничтожаю!`
      ];
      setTimeout(() => {
        try { bot.brain.say(startPhrases[Math.floor(Math.random() * startPhrases.length)]); } catch {}
      }, 300);
    }
  }

  /* ────────── ОСНОВНОЙ ЦИКЛ ────────── */
  tick() {
    const bot = this.bot; if (!bot) return;
    if (!state.protectMode && !this.targets.size) return;

    const entity = this.pickTarget(bot); if (!entity) return;
    this._beginFightToken(bot, entity);

    let ts = this.targets.get(entity.id); if (!ts) { ts = new TargetState(entity); this.targets.set(entity.id, ts); }
    ts.update(entity);

    if (now() - ts.firstSeen > this.opt.maxPursueTimeMs) {
      this._endFightToken(bot, entity.id, false);
      this.targets.delete(entity.id);
      return;
    }

    // анти-залипание
    this._antiStuck(bot);

    const tac = this.tactics.get(entity.name) || { style: 'melee', keep: this.opt.melee.ideal };

    if (this.opt.heal.enable && (bot.health ?? 20) <= this.opt.heal.hpThreshold) {
      this._safeHealSequence(bot, entity).catch(() => {});
    }

    this.maybePreShield(bot, entity, ts).catch(() => {});

    // 🆕 ОСОБЫЕ ТАКТИКИ ДЛЯ НОВЫХ МОБОВ
    if (tac.special === 'desert_shield') {
      this.doDesertSkeleton(bot, entity, ts, tac);
    } else if (tac.special === 'camel_charge') {
      this.doCamelZombie(bot, entity, ts, tac);
    } else {
      switch (tac.style) {
        case 'ranged':      this.doRanged(bot, entity, ts, tac); break;
        case 'hit_and_run': this.doHitAndRun(bot, entity, ts, tac); break;
        case 'melee':
        default:            this.doMelee(bot, entity, ts, tac); break;
      }
    }
  }

  // Смарт-игнор мирных/боссов
const SMART_IGNORE = new Set([
  'cow','pig','sheep','chicken','horse','donkey','mule','llama','cat','wolf','rabbit',
  'fox','goat','camel','sniffer','bee','mooshroom','turtle','axolotl','parrot','frog',
  'villager','wandering_trader','iron_golem','snow_golem',
  'warden','ender_dragon','wither',
  'guardian','elder_guardian'
]);

pickTarget(bot) {
  let target = this._currentTargetEntity(bot);
  if (target) return target;

  const me = bot.entity.position;

  const HOSTILE = new Set([
    'zombie','drowned','husk','skeleton','stray','creeper',
    'spider','cave_spider','witch','enderman','slime','magma_cube',
    'phantom','vex','evoker','vindicator',
    'pillager','ravager','piglin_brute',
    'desert_skeleton', 'camel_zombie'
  ]);

  function _withinGuard(e){
    try {
      if (!state?.guard?.center || !state?.guard?.radius) return true;
    } catch {}
    try {
      const c = state.guard.center, r = Number(state.guard.radius)||0;
      const dx = e.position.x - c.x, dy = e.position.y - c.y, dz = e.position.z - c.z;
      return Math.hypot(dx,dy,dz) <= r + 0.5;
    } catch { return true; }
  }

  const allowSmart = !!state.smartAggro;
  const list = Object.values(bot.entities).filter(e =>
    e?.type === 'mob' &&
    (allowSmart ? !SMART_IGNORE.has(e.name) : HOSTILE.has(e.name)) &&
    _withinGuard(e)
  );
  list.sort((a,b)=> me.distanceTo(a.position) - me.distanceTo(b.position));
  return list[0] || null;
}

  
  _currentTargetEntity(bot) {
    for (const id of this.targets.keys()) {
      const e = bot.entities[id];
      if (e && e.isValid) return e; else this.targets.delete(id);
    }
    return null;
  }
  
  
_nearestHostile(bot, within = 6) {
  const me = bot.entity.position;
  const HOSTILE = new Set([
    'zombie','drowned','husk','skeleton','stray','creeper',
    'spider','cave_spider','witch','enderman','slime','magma_cube',
    'phantom','vex','evoker','vindicator',
    'pillager','ravager','piglin_brute',
    'desert_skeleton', 'camel_zombie'
  ]);
  function _withinGuard(e){
    try {
      if (!state?.guard?.center || !state?.guard?.radius) return true;
    } catch {}
    try {
      const c = state.guard.center, r = Number(state.guard.radius)||0;
      const dx = e.position.x - c.x, dy = e.position.y - c.y, dz = e.position.z - c.z;
      return Math.hypot(dx,dy,dz) <= r + 0.5;
    } catch { return true; }
  }

  const allowSmart = !!state.smartAggro;
  const cand = Object.values(bot.entities).filter(e =>
    e?.type === 'mob' &&
    (allowSmart ? !SMART_IGNORE.has(e.name) : HOSTILE.has(e.name)) &&
    _withinGuard(e) &&
    me.distanceTo(e.position) <= within
  );
  cand.sort((a,b)=> me.distanceTo(a.position) - me.distanceTo(b.position));
  return cand[0] || null;
}


  /* ────────── ПОЛИТИКА РЕШЕНИЙ (МОЭ + риск + XP) ────────── */
  _policyWeights(bot, entity, ts, tac) {
    const d = dist3(bot.entity.position, entity.position);
    const env = this.getEnvContext();

    const sinceAtk = now() - ts.lastAttack;
    const canAtk = sinceAtk > 330;
    let base = {
      attack: canAtk ? 0.64 : 0.08,
      circle: (tac.circle ? 0.22 : 0.1) + (now() - this._lastReplan > this.opt.replanMs ? 0.18 : 0),
      dodge: (this.opt.dodge.enable && this.isRangedThreat(entity)) ? 0.33 : 0.12,
      block: 0.1,
      retreat: 0.08,
      shot: 0.0,
    };

    const ideal = tac.keep || (tac.style === 'ranged' ? this.opt.ranged.keepMax : this.opt.melee.ideal);
    base.attack *= clamp(1 - Math.abs(d - ideal) / ideal, 0.4, 1.25);
    base.retreat += d < ideal * 0.6 ? 0.12 : 0;

    if (entity.name === 'creeper' && this.isCreeperPrimed(entity)) { base.block += 0.5; base.retreat += 0.35; }
    if (tac.style === 'ranged') { base.shot = 0.55; base.attack *= 0.35; }

    // 🆕 ОСОБЫЕ КОЭФФИЦИЕНТЫ ДЛЯ НОВЫХ МОБОВ
    if (entity.name === 'desert_skeleton') { 
      base.block += 0.3; // Чаще блокирует против пустынного скелета
      base.retreat += 0.15;
    }
    if (entity.name === 'camel_zombie') { 
      base.dodge += 0.2; // Чаще уворачивается от верблюда-зомби
      base.retreat += 0.25;
    }

    const hp = clamp((this.bot.health ?? 20) / 20, 0, 1);
    const risk = clamp((env.isNight ? 0.15 : 0) + (1 - hp) * 0.6 + (entity.name === 'enderman' ? 0.2 : 0), 0, 1);

    if (Q?.balanceAggressiveDefensive) {
      base = Q.balanceAggressiveDefensive(base, ['attack', 'shot'], ['dodge', 'block', 'retreat'], clamp(1 - risk, 0, 1), 0.28);
    }

    const advised = this._advise(entity.name, base, { style: tac.style, biome: env.biome, hp });

    if (!Q?.mixtureOfExperts) return renorm(advised);
    const experts = [
      { name: 'base', scores: base, weight: 0.35 },
      { name: 'risk', scores: base, weight: 0.25 + 0.30 * risk },
      { name: 'xp', scores: advised, weight: 0.40 },
    ];
    const T = Q.scheduleTemperature(Date.now() % 1e9, { T0: tac.style === 'melee' ? 0.95 : 1.05, k: 0.003, floor: 0.55 });
    const mix = Q.mixtureOfExperts(experts, T).probs || advised;
    return renorm(mix);
  }

  /* 🆕 СПЕЦИАЛЬНЫЕ ТАКТИКИ ДЛЯ НОВЫХ МОБОВ */
  async doDesertSkeleton(bot, entity, ts, tac) {
    // Пустынный скелет - чаще использует щит и укрытия
    const d = dist3(bot.entity.position, entity.position);

    await this.humanDelay();

    if (d > tac.keep + 2) {
      await this.follow(bot, entity, tac.keep).catch(() => {});
      return;
    }

    // Чаще поднимаем щит против пустынного скелета
    if (Math.random() < 0.4) {
      await this.raiseShield(bot, this.opt.shield.minHoldMs + 200);
    }

    if (d < tac.keep - 2) {
      await this.retreat(bot, entity, tac.keep).catch(() => {});
    }

    // Стрельба из лука
    const bow = firstInInv(bot, ['bow', 'crossbow']);
    const hasAr = hasArrows(bot);
    if (bow && hasAr && (now() - ts.lastAttack > 500)) {
      try { await bot.equip(bow, 'hand'); } catch {}
      const aim = this.leadAim(entity, this.opt.ranged.arrowSpeed, this.opt.ranged.gravity);
      await this.lookAtVecHuman(bot, aim, rndInt(this.opt.ranged.preAimMs - 40, this.opt.ranged.preAimMs + 70));
      
      const draw = rndInt(this.opt.ranged.drawMs[0], this.opt.ranged.drawMs[1]);
      try { bot.activateItem(); } catch {}
      await sleep(draw);
      try { bot.deactivateItem(); ts.lastAttack = now(); } catch {}
    } else {
      // Ближний бой как запасной вариант
      await this.doMelee(bot, entity, ts, tac);
    }

    // Активно ищем укрытие
    if (tac.useCover && this.opt.cover.use && (now() - this._lastCover > 3000)) {
      const ok = await this.findCover(bot, entity, this.opt.cover.maxDistance);
      if (ok) this._lastCover = now();
    }
  }

  async doCamelZombie(bot, entity, ts, tac) {
    // Зомби-верблюд - тактика "удар-отскок" с большими дистанциями
    const d = dist3(bot.entity.position, entity.position);

    await this.humanDelay();

    if (d > tac.keep + 3.0) {
      await this.follow(bot, entity, tac.keep).catch(() => {});
      return;
    }

    // Верблюд-зомби может "заряжаться" для атаки - отступаем
    if (this.isCamelCharging(entity)) {
      await this.emergencyRetreat(bot, entity, tac.retreat + 2);
      await this.raiseShield(bot, 600);
      return;
    }

    const since = now() - ts.lastAttack;
    if (since > 400 && d <= tac.keep + 1.0) {
      try {
        await this.equipBestWeapon(bot, entity);
        bot.attack(entity);
        ts.lastAttack = now();
        
        // После атаки сразу отступаем на большую дистанцию
        await this.retreat(bot, entity, tac.retreat || 8.0);
        await sleep(this.opt.hitAndRun.retreatMs + 200);
      } catch {}
    }

    // Чаще уворачиваемся от верблюда-зомби
    if (this.opt.dodge.enable && now() - ts.lastDodge > this.opt.dodge.cooldownMs) {
      ts.lastDodge = now();
      await this.dodge(bot, entity);
    }
  }

  isCamelCharging(entity) {
    // 🆕 Определяем, "заряжается" ли верблюд-зомби для атаки
    try {
      return entity.name === 'camel_zombie' &&
             entity.metadata &&
             (entity.metadata[16] > 0 || entity.velocity?.y > 0.2);
    } catch { 
      return false; 
    }
  }

  /* ────────── БЛИЖНИЙ БОЙ ────────── */
  async doMelee(bot, entity, ts, tac) {
    const d = dist3(bot.entity.position, entity.position);
    const ideal = tac.keep || this.opt.melee.ideal;
    const min = this.opt.melee.min, max = this.opt.melee.max;

    await this.humanDelay();

    if (d > max) { await this.follow(bot, entity, ideal).catch(() => {}); return; }
    if (d < min) { await this.retreat(bot, entity, ideal + 1.2).catch(() => {}); return; }

    // низкое ХП → быстрый ретрит+щит
    if (this.opt.heal.enable && (bot.health ?? 20) <= this.opt.heal.hpThreshold) {
      await this._safeHealSequence(bot, entity).catch(() => {});
    }

    const W = this._policyWeights(bot, entity, ts, tac);
    const action = chooseWeighted(W);

    if (action === 'attack' && (now() - ts.lastAttack > 330)) {
      if (Math.random() < this.opt.melee.jumpCritChance) {
        bot.setControlState('jump', true);
        await sleep(this.opt.melee.jumpCritWindowMs);
        try { bot.attack(entity); ts.lastAttack = now(); } catch {}
        bot.setControlState('jump', false);
      } else {
        try { bot.attack(entity); ts.lastAttack = now(); } catch {}
      }
    } else if (action === 'circle' && tac.circle) {
      this._lastReplan = now();
      await this.circleStrafe(bot, entity, this.opt.melee.circleRadius, this.opt.melee.circleStrafeMs);
    } else if (action === 'dodge') {
      if (this.opt.dodge.enable && now() - ts.lastDodge > this.opt.dodge.cooldownMs) { ts.lastDodge = now(); await this.dodge(bot, entity); }
    } else if (action === 'block') {
      await this.raiseShield(bot, this.opt.shield.minHoldMs + 120);
    } else if (action === 'retreat') {
      await this.retreat(bot, entity, ideal + 1.6).catch(() => {});
      if (this.isRangedThreat(entity) && (now() - this._lastCover > 2200)) {
        const ok = await this.findCover(bot, entity, this.opt.cover.maxDistance);
        if (ok) this._lastCover = now();
      }
    }

    if (entity.name === 'creeper' && this.isCreeperPrimed(entity)) {
      await this.emergencyRetreat(bot, entity, 9);
      await this.raiseShield(bot, 560);
    }
  }

  /* ────────── ДАЛЬНОБОЙНЫЙ БОЙ ────────── */
  async doRanged(bot, entity, ts, tac) {
    const bow = firstInInv(bot, ['bow']);
    const cross = firstInInv(bot, ['crossbow']);
    const hasAr = hasArrows(bot);
    const d = dist3(bot.entity.position, entity.position);

    await this.humanDelay();

    const preferBow = this.opt.ranged.preferBow && bow && hasAr;
    const preferCross = !preferBow && cross && hasAr;

    if (preferBow || preferCross) {
      try { await bot.equip(preferBow ? bow : cross, 'hand'); } catch {}

      if (d < this.opt.ranged.keepMin) { await this.retreat(bot, entity, this.opt.ranged.keepMax).catch(() => {}); }
      else if (d > this.opt.ranged.keepMax) { await this.follow(bot, entity, this.opt.ranged.keepMax).catch(() => {}); }

      const aim = this.leadAim(entity, this.opt.ranged.arrowSpeed, this.opt.ranged.gravity);
      await this.lookAtVecHuman(bot, aim, rndInt(this.opt.ranged.preAimMs - 40, this.opt.ranged.preAimMs + 70));

      const draw = rndInt(this.opt.ranged.drawMs[0], this.opt.ranged.drawMs[1]);
      try { bot.activateItem(); } catch {}
      await sleep(draw);
      try { bot.deactivateItem(); ts.lastAttack = now(); } catch {}

      if (this.opt.shield.enable && this.opt.shield.vsSkeleton && entity.name === 'skeleton') {
        await this.raiseShield(bot, this.opt.shield.minHoldMs + this.opt.shield.holdExtraMs);
      }

      if (tac.useCover && this.opt.cover.use) await this.findCover(bot, entity);
    } else {
      await this.doMelee(bot, entity, ts, { keep: this.opt.melee.ideal, circle: true });
    }
  }
  
  /* ────────── ТАКТИКА "УДАРИЛ-УБЕЖАЛ" ────────── */
  async doHitAndRun(bot, entity, ts, tac) {
    const ideal = tac.keep || 4.0;
    const d = dist3(bot.entity.position, entity.position);

    await this.humanDelay();

    if (d > ideal + 1.0) { await this.follow(bot, entity, ideal).catch(() => {}); return; }

    const since = now() - ts.lastAttack;
    if (since > 330) {
      try { bot.attack(entity); ts.lastAttack = now(); } catch {}
      await this.retreat(bot, entity, tac.retreat || this.opt.hitAndRun.retreatTo);
      await sleep(this.opt.hitAndRun.retreatMs);
    }

    if (entity.name === 'creeper' && this.isCreeperPrimed(entity)) {
      await this.emergencyRetreat(bot, entity, (tac.retreat || 8) + 2);
      await this.raiseShield(bot, 600);
    }
  }

  /* ────────── БАЗОВЫЕ ДЕЙСТВИЯ И НАВИГАЦИЯ ────────── */
  async follow(bot, entity, keepDist) {
    const goals = await this._getGoals();
    try { bot.pathfinder.setGoal(new goals.GoalFollow(entity, keepDist || 3), true); } catch {}
  }

  async retreat(bot, entity, distance) {
    const goals = await this._getGoals();
    const dx = bot.entity.position.x - entity.position.x;
    const dy = bot.entity.position.y - entity.position.y;
    const dz = bot.entity.position.z - entity.position.z;
    const len = Math.max(1e-6, Math.hypot(dx, dy, dz));
    const nx = dx / len, ny = dy / len, nz = dz / len;
    const dist = distance || 6;
    const pos = new Vec3(
      bot.entity.position.x + nx * dist,
      bot.entity.position.y + ny * dist,
      bot.entity.position.z + nz * dist
    );
    try { bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 2)); } catch {}
  }

  async emergencyRetreat(bot, entity, dist) {
    await this.retreat(bot, entity, dist || 10);
    await this.raiseShield(bot, 500);
  }

  async circleStrafe(bot, entity, r = 2, ms = 340) {
    const ang = Math.atan2(entity.position.z - bot.entity.position.z, entity.position.x - bot.entity.position.x);
    const side = Math.random() < 0.5 ? 1 : -1;
    const theta = ang + side * Math.PI / 3;
    const p = new Vec3(entity.position.x + Math.cos(theta) * r, entity.position.y, entity.position.z + Math.sin(theta) * r);
    const goals = await this._getGoals();
    try { bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1)); } catch {}
    await sleep(ms);
  }

  async dodge(bot, entity) {
    const left = Q?.randSign ? (Q.randSign() < 0) : (Math.random() < 0.5);
    bot.setControlState(left ? 'left' : 'right', true);
    if (Math.random() < this.opt.dodge.jumpChance) bot.setControlState('jump', true);
    await sleep(this.opt.dodge.strafeMs);
    bot.setControlState('left', false);
    bot.setControlState('right', false);
    bot.setControlState('jump', false);
  }

  async raiseShield(bot, holdMs) {
    if (!this.opt.shield.enable) return;
    const shield = firstInInv(bot, ['shield']);
    if (!shield) return;
    try { await bot.equip(shield, 'off-hand'); } catch {}
    try { bot.activateItem(); } catch {}
    await sleep(Math.max(this.opt.shield.minHoldMs, holdMs || 380));
    try { bot.deactivateItem(); } catch {}
  }

  async tryHeal(bot) {
    const food = firstInInv(bot, this.opt.heal.eatItems);
    if (!food) return false;
    try { await bot.equip(food, 'hand'); bot.activateItem(); await sleep(820); bot.deactivateItem(); return true; } catch { return false; }
  }

  async humanDelay() {
    const [a, b] = this.opt.human.reactionMs;
    if (Q?.humanDelay) return Q.humanDelay(rndInt(a, b));
    await sleep(rndInt(a, b));
  }

  /* ────────── ПРИЦЕЛИВАНИЕ ────────── */
  leadAim(entity, arrowSpeed, gravity) {
    const src = entity.position.clone();
    const v = this.targets.get(entity.id)?.vel || new Vec3(0, 0, 0);
    const botPos = this.bot.entity.position.clone();
    const D = dist3(botPos, src);
    const t = D / (arrowSpeed * 20);
    const lead = src.plus(new Vec3(v.x * t * 1000, v.y * t * 1000, v.z * t * 1000));
    lead.y += (gravity || 0) * D * 0.12;
    return lead;
  }

  async lookAtVec(bot, vec, ms) {
    try { await bot.lookAt(vec); } catch {}
    if (ms) await sleep(ms);
  }

  async lookAtVecHuman(bot, vec, ms) {
    const me = bot.entity.position;
    const dx = vec.x - me.x, dy = (vec.y - me.y), dz = vec.z - me.z;
    let yaw = Math.atan2(-dx, -dz);
    let pitch = Math.atan2(dy, Math.hypot(dx, dz));
    const [jA, jB] = this.opt.human.aimJitterRad;
    const jy = rnd(-jB, jB); const jp = rnd(-jB, jB);
    yaw += clamp(jy, -jB, jB); pitch += clamp(jp, -jB, jB);
    try { await bot.look(yaw, pitch, true); } catch {}
    if (ms) await sleep(ms);
  }

  async lookAtEntityCenter(bot, entity, ms = 120) {
    const eye = entity.position.offset(0, entity.height ? entity.height * 0.5 : 1.0, 0);
    await this.lookAtVecHuman(bot, eye, ms);
  }

  /* ────────── ОПРЕДЕЛЕНИЕ УГРОЗ ────────── */
  isRangedThreat(entity) {
    return entity && (
      entity.name === 'skeleton' || 
      entity.name === 'stray' ||
      entity.name === 'desert_skeleton' || // 🆕 Пустынный скелет тоже угроза
      entity.name === 'witch' || 
      entity.name === 'ghast' || 
      entity.name === 'pillager'
    );
  }

  isCreeperPrimed(entity) {
    try {
      return entity.name === 'creeper' && 
             entity.metadata && 
             entity.metadata[12] > 0;
    } catch { 
      return false; 
    }
  }

  getEnvContext() {
    const bot = this.bot; const p = bot.entity?.position || new Vec3(0, 0, 0);
    const timeOfDay = bot.time?.timeOfDay ?? 0;
    const isNight = timeOfDay >= 13000 && timeOfDay <= 23000;
    let light = 15; let biome = 'unknown';
    try { const b = bot.blockAt(p); if (b) { light = b.light ?? light; biome = (b?.biome?.name) || biome; } } catch {}
    return { isNight, light, biome, y: p.y };
  }

  async maybePreShield(bot, entity, ts) {
    if (!this.opt.shield.enable) return;
    // ETA по ритму входящих ударов
    const R = ts.rhythmAvgMs || 0;
    if (R >= 400) {
      const t = now(); const eta = (ts.lastDamageTime || 0) + R - t;
      if (eta > 0 && eta < 260 && (t - ts.lastBlock > Math.max(340, R * 0.6))) {
        ts.lastBlock = t;
        await this.raiseShield(bot, this.opt.shield.minHoldMs + this.opt.shield.holdExtraMs);
      }
    }
    // skeleton ETA → доп.блок
    if (entity.name === 'skeleton' || entity.name === 'desert_skeleton') {
      const eta = this._skeletonETA(bot, entity);
      if (eta && eta < 260) await this.raiseShield(bot, this.opt.shield.minHoldMs + 140);
    }
  }

  /* ────────── ЭКИПИРОВКА И УКРЫТИЯ ────────── */
  async equipBestWeapon(bot, entity) {
    const best = bestWeapon(bot);
    if (best) {
      try { await bot.equip(best, 'hand'); } catch {}
      if (this.opt.shield.enable && (
          entity.name === 'skeleton' || 
          entity.name === 'desert_skeleton' || // 🆕 И против пустынного скелета
          entity.name === 'ghast' || 
          entity.name === 'creeper')) {
        const sh = firstInInv(bot, ['shield']); if (sh) { try { await bot.equip(sh, 'off-hand'); } catch {} }
      }
    }
  }

  async findCover(bot, entity, maxDist = 8) {
    if (!this.opt.cover.use) return false;
    try {
      const near = bot.findBlocks({ matching: (b) => b && b.boundingBox === 'block', maxDistance: maxDist, count: 12 });
      if (!near?.length) return false;
      let best = null, bestScore = -Infinity;
      for (const p of near) {
        const score = -this.pointLineDist2D(p, bot.entity.position, entity.position) - 0.2 * dist3(bot.entity.position, p);
        if (score > bestScore) { bestScore = score; best = p; }
      }
      if (!best) return false;
      const goals = await this._getGoals();
      bot.pathfinder.setGoal(new goals.GoalNear(best.x, best.y, best.z, 1));
      return true;
    } catch { return false; }
  }

  pointLineDist2D(p, a, b) {
    const px = p.x, pz = p.z; const ax = a.x, az = a.z; const bx = b.x, bz = b.z;
    const abx = bx - ax, abz = bz - az; const apx = px - ax, apz = pz - az;
    const ab2 = abx * abx + abz * abz || 1e-6;
    let t = (apx * abx + apz * abz) / ab2; t = clamp(t, 0, 1);
    const cx = ax + abx * t, cz = az + abz * t;
    return Math.hypot(px - cx, pz - cz);
  }

  /* ────────── ПОМОЩНИКИ ────────── */
  _skeletonETA(bot, skel) {
    try {
      const d = dist3(bot.entity.position, skel.position);
      const eta = (d / 3) * 320; // эвристика
      return clamp(eta, 120, 1200);
    } catch { return null; }
  }

  async _safeHealSequence(bot, entity) {
    try {
      const goals = await this._getGoals();
      // отойти на 7–9 блоков
      const dx = bot.entity.position.x - entity.position.x; const dy = bot.entity.position.y - entity.position.y; const dz = bot.entity.position.z - entity.position.z; const len = Math.max(1e-6, Math.hypot(dx, dy, dz)); const scale = 8 + Math.random() * 2; const pos = new Vec3(bot.entity.position.x + (dx/len) * scale, bot.entity.position.y + (dy/len) * scale, bot.entity.position.z + (dz/len) * scale);
      try { bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 2)); } catch {}
      await this.raiseShield(bot, 380);
      const ok = await this.tryHeal(bot);
      if (ok) { try { bot.brain?.say?.('🍗 Перекушу и вернусь…'); } catch {} }
    } catch {}
  }

  _antiStuck(bot) {
    try {
      const p = bot.entity.position; const t = now();
      if (!this._watchdog.lastPos) { this._watchdog.lastPos = p.clone(); this._watchdog.lastT = t; return; }
      const moved = p.distanceTo(this._watchdog.lastPos);
      if (moved < 0.05) this._watchdog.stuckMs += (t - this._watchdog.lastT);
      else this._watchdog.stuckMs = Math.max(0, this._watchdog.stuckMs - 120);
      this._watchdog.lastPos = p.clone(); this._watchdog.lastT = t;

      if (this._watchdog.stuckMs > 1600) {
        try { this.bot.pathfinder.setGoal(null); } catch {}
        // маленький «рывок»
        this.bot.setControlState('jump', true);
        setTimeout(() => this.bot.setControlState('jump', false), 160);
        this._watchdog.stuckMs = 0;
      }
    } catch {}
  }
}

/* ────────── ЭКСПОРТ ────────── */
const combatManager = new CombatManager();
module.exports = { CombatManager, combatManager };
