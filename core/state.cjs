// ===============================
// core/state.cjs — централизованное состояние + планировщик
// 💾 Heartbeat бота: флаги, события, очереди задач, авто-еда/броня, анти-спам
// ===============================

'use strict';

const { EventEmitter } = require('events');

// -------------------------------
// Настройки поведения (сохраняем имена, чтобы не ломать старый код)
// -------------------------------
const SETTINGS = Object.freeze({
  AUTO_EAT_THRESHOLD: 6,       // начать есть, если еда ниже этого
  PATROL_RADIUS: 8,
  FOLLOW_RANGE: 3,
  FIND_RADIUS: 32,
  CHEST_RADIUS: 24,
  FURNACE_RADIUS: 24,
  CRAFTING_RADIUS: 24,
  DROP_LIMIT: 64,

  AUTO_PROTECT: true,          // стартовый protectMode
  PROTECT_RANGE: 16,

  COMBAT_REACTION_DELAY: 200,
  MIN_HEALTH_FOR_COMBAT: 6,    // не ввязываться в бой при меньшем HP
  AUTO_RETREAT_HP: 8           // при таком HP можно ретрит
});

// -------------------------------
// Разбор .env для запрета атак
// По умолчанию нельзя: железный голем, жители, странник, варден
// Можно расширить: ATTACK_DENY=bee,axolotl,camel
// -------------------------------
const DEFAULT_ATTACK_DENY = ['iron_golem', 'villager', 'wandering_trader', 'warden'];

function parseEnvList(key) {
  const raw = String(process.env[key] || '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

const ENV_ATTACK_DENY = new Set([
  ...DEFAULT_ATTACK_DENY,
  ...parseEnvList('ATTACK_DENY'),
  ...parseEnvList('SAFE_ATTACK_DENY') // совместим с другим именем
]);

// -------------------------------
// Мелкие утилиты
// -------------------------------
const now = () => Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function toMobKey(name = '') {
  let s = String(name).toLowerCase();
  if (!s) return s;
  if (s.includes(':')) s = s.split(':').pop();
  return s.replace(/\s+/g, '_');
}

// -------------------------------
// Класс BotState: все важные флаги и статикa
// -------------------------------
class BotState extends EventEmitter {
  constructor() {
    super();

    // Базовые флаги
    this.isFollowing = false;
    this.followTarget = null;
    this.autoMode = false;
    this.isDead = false;
    this.inCombat = false;
    this.task = 'idle';
    this.protectMode = SETTINGS.AUTO_PROTECT;
    this.busy = false;

    // meta
    this.lastUser = null;
    this.lastActivity = now();
    this.bot = null;

    // Навыки (простые счётчики; детально — через /features/ai/experience.cjs)
    this.skills = {
      mining: { level: 1, xp: 0 },
      combat: { level: 1, xp: 0 },
      building: { level: 1, xp: 0 },
      farming: { level: 1, xp: 0 },
      magic: { level: 1, xp: 0 },
      exploration: { level: 1, xp: 0 }
    };

    // Стата (совместимо с xpHelpers — mobsKilled как объект!)
    this.botStats = {
      exp: 0,
      level: 1,
      achievements: [],
      unlockedAbilities: [],
      blocksMined: 0,
      mobsKilled: {},       // имя_моба: кол-во
      cropsHarvested: 0,
      itemsCrafted: 0,
      housesBuilt: 0,
      timePlayed: 0,
      deaths: 0
    };

    // Служебные события
    this.events = {
      lastCombatEvent: null,
      lastMovement: null,
      lastInteraction: null,
      errors: []
    };

    // Антиспам/кулдауны по ключам
    this._cool = Object.create(null);

    // Запретные цели для атаки
    this.forbiddenMobs = new Set(ENV_ATTACK_DENY);
  }

  // Привязать инстанс mineflayer-бота
  setBot(botInstance) { this.bot = botInstance; }
  getBot() { return this.bot; }

  // Безопасность боя
  isSafeToFight() {
    if (!this.bot) return false;
    const hp = Number(this.bot.health ?? 20);
    return hp >= SETTINGS.MIN_HEALTH_FOR_COMBAT;
  }

  // Курок «в бою»
  setCombat(flag) {
    flag = !!flag;
    if (this.inCombat !== flag) {
      this.inCombat = flag;
      this.events.lastCombatEvent = now();
      this.emit('combat:change', flag);
    }
  }

  // Текущая задача
  setTask(name = 'idle') {
    name = String(name || 'idle');
    if (this.task !== name) {
      this.task = name;
      this.emit('task:change', name);
      this.touchActivity();
    }
  }

  setFollowing(on, target = null) {
    const was = this.isFollowing;
    this.isFollowing = !!on;
    this.followTarget = on ? (target || this.followTarget) : null;
    if (this.isFollowing !== was) this.emit('follow:change', this.isFollowing, this.followTarget);
  }

  setProtectMode(on) {
    const was = this.protectMode;
    this.protectMode = !!on;
    if (was !== this.protectMode) this.emit('protect:change', this.protectMode);
  }

  // Кулдауны
  onCooldown(key, ttlMs) {
    const t = this._cool[key] || 0;
    return (now() - t) < ttlMs;
  }
  hitCooldown(key) {
    this._cool[key] = now();
  }

  // Активность / сессия
  touchActivity() { this.lastActivity = now(); }

  updateStats() {
    // timePlayed — минуты с последнего апдейта (накопительно)
    const minutes = Math.max(0, Math.floor((now() - this.lastActivity) / 60000));
    this.botStats.timePlayed += minutes;
    this.lastActivity = now();
  }

  // Учёт убийств
  countKill(mobName = 'unknown') {
    const k = toMobKey(mobName) || 'unknown';
    this.botStats.mobsKilled[k] = (this.botStats.mobsKilled[k] || 0) + 1;
  }

  // Запрет атак по имени/энтити
  refreshForbiddenFromEnv() {
    this.forbiddenMobs = new Set([
      ...DEFAULT_ATTACK_DENY,
      ...parseEnvList('ATTACK_DENY'),
      ...parseEnvList('SAFE_ATTACK_DENY')
    ]);
  }

  isForbiddenMobName(name) {
    const k = toMobKey(name);
    if (!k) return false;
    return this.forbiddenMobs.has(k);
  }

  canAttackEntity(ent) {
    if (!ent) return false;
    // запираем НПС/мирных
    const byName = [ent.name, ent.displayName, ent.entityType].filter(Boolean);
    for (const n of byName) if (this.isForbiddenMobName(n)) return false;

    // базовая проверка здоровья и боевого статуса
    if (!this.isSafeToFight()) return false;
    return true;
  }
}

// Глобальный экземпляр
const state = new BotState();

// -------------------------------
// Менеджер интервалов (чтобы аккуратно гасить при end)
// -------------------------------
const _intervals = [];

function addInterval(fn, ms, name = 'interval') {
  const id = setInterval(() => {
    try { fn(); } catch (e) { console.warn(`[state:${name}]`, e?.message || e); }
  }, ms);
  _intervals.push({ id, name });
  return id;
}

function clearAllIntervals() {
  for (const it of _intervals) clearInterval(it.id);
  _intervals.length = 0;
}

// -------------------------------
// Планировщик задач: приоритетная очередь
// -------------------------------
const TASK_PRIORITY = Object.freeze({
  COMBAT: 100,
  EMERGENCY: 90,
  PLAYER_COMMAND: 80,
  AUTO_DEFENSE: 70,
  GATHERING: 60,
  CRAFTING: 50,
  BUILDING: 40,
  EXPLORATION: 30,
  IDLE: 10
});

const _queue = [];
let _busy = false;

function enqueue(taskFn, name = 'task', priority = TASK_PRIORITY.IDLE) {
  const task = {
    id: Math.random().toString(36).slice(2),
    name: String(name || 'task'),
    priority: Number(priority) || TASK_PRIORITY.IDLE,
    taskFn,
    t: now()
  };
  _queue.push(task);
  _queue.sort((a, b) => b.priority - a.priority || a.t - b.t);
  if (!_busy) processQueue();
  return task.id;
}

async function processQueue() {
  if (_busy || _queue.length === 0) return;
  const task = _queue.shift();
  _busy = true; state.busy = true; state.setTask(task.name);
  try {
    await task.taskFn();
  } catch (err) {
    console.warn(`❌ Task "${task.name}" failed:`, err?.message || err);
    state.events.errors.push({ at: now(), task: task.name, err: String(err?.message || err) });
  } finally {
    state.setTask('idle');
    state.busy = false; _busy = false;
    if (_queue.length) {
      const next = _queue[0];
      const delay = next.priority >= TASK_PRIORITY.COMBAT ? 50 : 150;
      setTimeout(processQueue, delay);
    }
  }
}

// -------------------------------
/** Простейшая система уровней (совместима с прежней addExp) */
// -------------------------------
function addExp(amount, reason = '') {
  const a = Math.max(0, Number(amount) || 0);
  if (a <= 0) return;
  state.botStats.exp += a;
  // ап левела
  let needed = state.botStats.level * 50;
  while (state.botStats.exp >= needed) {
    state.botStats.exp -= needed;
    state.botStats.level++;
    try { state.bot?.chat?.(`🔥 Новый уровень: ${state.botStats.level}!`); } catch {}
    needed = state.botStats.level * 50;
  }
  if (reason) {
    try { state.bot?.chat?.(`⭐ +${a} опыта за ${reason}`); } catch {}
  }
}

// -------------------------------
// Авто-еда и авто-броня (бережно и без спама)
// -------------------------------
let _eatCooldownAt = 0;
let _equipCooldownAt = 0;

addInterval(() => {
  const bot = state.getBot();
  if (!bot || !bot.entity || !bot.inventory) return;

  // === Еда (раз в ~3–5с максимум) ===
  if (bot.food < SETTINGS.AUTO_EAT_THRESHOLD && now() - _eatCooldownAt > 3500) {
    try {
      const items = bot.inventory.items() || [];
      const candidates = items.filter(i => /(cooked_|bread|apple|baked_potato|pumpkin_pie|golden_carrot)/.test(i.name));
      if (candidates.length) {
        const score = (n) => {
          if (/golden_carrot/.test(n)) return 10;
          if (/cooked_beef|cooked_porkchop|cooked_mutton|cooked_chicken|cooked_cod|cooked_salmon/.test(n)) return 8;
          if (/bread|baked_potato|pumpkin_pie|apple/.test(n)) return 5;
          return 1;
        };
        const best = candidates.sort((a, b) => (score(b.name) - score(a.name)))[0];
        bot.equip(best, 'hand').then(() => bot.consume().catch(()=>{})).catch(()=>{});
        _eatCooldownAt = now();
      }
    } catch {}
  }

  // === Броня (раз в ~7–9с максимум) ===
  if (now() - _equipCooldownAt > 7000) {
    try {
      const items = bot.inventory.items() || [];
      const slots = ['head', 'torso', 'legs', 'feet'];
      const tierRank = (name='') => {
        if (/netherite/.test(name)) return 6;
        if (/diamond/.test(name)) return 5;
        if (/iron/.test(name)) return 4;
        if (/chainmail/.test(name)) return 3;
        if (/golden/.test(name)) return 2;
        if (/leather/.test(name)) return 1;
        return 0;
      };
      const slotMatch = {
        head: /helmet/,
        torso: /chestplate/,
        legs: /leggings/,
        feet: /boots/
      };
      for (const slot of slots) {
        const best = items
          .filter(i => slotMatch[slot].test(i.name))
          .sort((a, b) => tierRank(b.name) - tierRank(a.name))[0];
        if (best) { bot.equip(best, slot).catch(()=>{}); }
      }
      _equipCooldownAt = now();
    } catch {}
  }
}, 1200, 'auto-eat-armor');

// Поддержка timePlayed (минуты, накопительно)
addInterval(() => { state.updateStats(); }, 60000, 'stats-update');

// -------------------------------
// Экспорт
// -------------------------------
module.exports = {
  SETTINGS,
  state,

  // Планировщик
  TASK_PRIORITY,
  enqueue,
  processQueue,

  // Интервалы
  addInterval,
  clearAllIntervals,

  // Опыт
  addExp
};
