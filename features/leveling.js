'use strict';
// ===============================
// features/leveling.js — v8 Pro
// ⚙️ Прокачка с кривой XP, анти-спамом и хук-событиями
// ===============================

const { state } = require('../core/state.cjs');

// ── Кривая опыта (можно тюнить без правок логики)
const XP_CURVE = {
  base: 20,     // базовый множитель
  grow: 1.25,   // насколько усложняется каждый следующий уровень
  min: 12,      // нижний барьер
  max: 250      // верхний барьер на шаге
};
function neededXP(level = 1) {
  // округляем и ограничиваем
  const raw = Math.round(XP_CURVE.base * Math.pow(XP_CURVE.grow, Math.max(0, level - 1)));
  return Math.max(XP_CURVE.min, Math.min(XP_CURVE.max, raw));
}

// ── Анти-спам чата
const chatLimiter = (() => {
  let last = 0;
  const GAP = 1000;
  return (msg) => {
    const t = Date.now();
    if (t - last >= GAP) {
      try { state.getBot()?.chat(msg); } catch {}
      last = t;
    }
  };
})();

// ── Анти-фарм: ограничим частоту XP по одному типу события
const _cooldowns = new Map(); // key -> ts
function passCooldown(key, ms) {
  const now = Date.now();
  const last = _cooldowns.get(key) || 0;
  if (now - last < ms) return false;
  _cooldowns.set(key, now);
  return true;
}

// ── Инициализация статистики
function ensureStats() {
  state.botStats ??= {
    level: 1,
    exp: 0,
    blocksMined: 0,
    mobsKilled: {},       // { zombie: 3, skeleton: 1, ... }
    cropsHarvested: 0,
    itemsCrafted: 0,
    housesBuilt: 0,
    unlockedAbilities: []
  };
  state.botStats.unlockedAbilities ??= [];
  state.botStats.mobsKilled ??= {};
  return state.botStats;
}

// ── Сводка
function showStats() {
  const stats = ensureStats();
  const next = neededXP(stats.level);
  const pct = Math.min(100, Math.round((stats.exp / next) * 100));
  const totalKills = Object.values(stats.mobsKilled).reduce((a, b) => a + b, 0);
  const abilities = stats.unlockedAbilities.length
    ? `📜 ${stats.unlockedAbilities.join(', ')}`
    : '—';

  return (
    `📊 Статистика HelperBot:\n` +
    `🎯 Уровень: ${stats.level}\n` +
    `⭐ Опыт: ${stats.exp}/${next} (${pct}%)\n` +
    `⛏️ Блоков добыто: ${stats.blocksMined}\n` +
    `💀 Мобов убито: ${totalKills}\n` +
    `🌾 Урожая собрано: ${stats.cropsHarvested}\n` +
    `🛠️ Предметов создано: ${stats.itemsCrafted}\n` +
    `🏠 Домов построено: ${stats.housesBuilt}\n` +
    `🔓 Способностей: ${stats.unlockedAbilities.length}\n` +
    `${abilities}`
  );
}

// ── Способности (простая матрица разблокировок)
const ABILITY_UNLOCKS = {
  2: ['быстрый сбор',  'Собираю ресурсы быстрее'],
  3: ['авто-атака',    'Сам нападаю на врагов рядом'],
  5: ['режим тени',    'Двигаюсь тихо и незаметно'],
  6: ['режим ярости',  'Бью сильнее и быстрее']
};

function unlockAbility(name, message = '') {
  const stats = ensureStats();
  if (!stats.unlockedAbilities.includes(name)) {
    stats.unlockedAbilities.push(name);
    chatLimiter(`🔓 Новая способность: ${name}${message ? ` — ${message}` : ''}`);
    try { state.emit('abilityUnlocked', { name, message }); } catch {}
  }
}

// ── Повышение уровня
function checkLevelUp() {
  const stats = ensureStats();
  const bot = state.getBot();
  let leveled = false;

  while (stats.exp >= neededXP(stats.level)) {
    stats.exp -= neededXP(stats.level);
    stats.level++;
    leveled = true;
    chatLimiter(`🎉 Новый уровень: ${stats.level}!`);
    try { state.emit('levelUp', { level: stats.level }); } catch {}

    const unlock = ABILITY_UNLOCKS[stats.level];
    if (unlock) unlockAbility(unlock[0], unlock[1]);
  }

  if (leveled) bot?.chat?.(`🔥 Достиг уровня ${stats.level}!`);
}

// ── Добавление опыта (с прокси на core/state если кто-то зовёт напрямую)
function addExp(amount, reason = '') {
  const stats = ensureStats();
  if (!Number.isFinite(amount) || amount <= 0) return;

  stats.exp += amount;
  if (reason && passCooldown('xp-msg', 1200)) chatLimiter(`⭐ +${amount} опыта за ${reason}`);
  try { state.emit('xp', { amount, reason }); } catch {}

  checkLevelUp();
}

// ── Авто-награды за события (умные дефолты с лимитом)
const XP_EVENTS = {
  block_mined: 1,          // базовая руда/блок
  ore_mined: 3,            // полезная руда
  item_crafted: 2,
  mob_killed: 4,
  house_built: 8,
  crop_harvested: 1
};

// Хелперы для удобной интеграции из модулей:

function onBlockMined(blockName) {
  const stats = ensureStats();
  stats.blocksMined++;
  const useful = /ore|debris|diamond|emerald|redstone|lapis|gold|iron|copper/i.test(blockName);
  const xp = useful ? XP_EVENTS.ore_mined : XP_EVENTS.block_mined;

  // ограничим фарм спама: не чаще чем раз в 400мс учитываем добычу
  if (!passCooldown('mine', 400)) return;
  addExp(xp, useful ? `добычу ${blockName}` : 'добычу блоков');
  try { state.emit('stat:blockMined', { block: blockName, total: stats.blocksMined }); } catch {}
}

function onMobKilled(mobName) {
  const stats = ensureStats();
  stats.mobsKilled[mobName] = (stats.mobsKilled[mobName] || 0) + 1;

  if (!passCooldown('kill', 600)) return;
  addExp(XP_EVENTS.mob_killed, `победу над ${mobName}`);
  try { state.emit('stat:mobKilled', { mob: mobName, total: stats.mobsKilled[mobName] }); } catch {}
}

function onItemCrafted(itemName, count = 1) {
  const stats = ensureStats();
  stats.itemsCrafted += count|0;

  // батч-XP: 1–3 за серию, но не чаще 700мс
  if (!passCooldown('craft', 700)) return;
  const xp = Math.min(3, Math.max(1, Math.round(count / 2)));
  addExp(xp, `крафт ${itemName}${count>1?` ×${count}`:''}`);
  try { state.emit('stat:itemCrafted', { item: itemName, count, total: stats.itemsCrafted }); } catch {}
}

function onHouseBuilt(size = 'small') {
  const stats = ensureStats();
  stats.housesBuilt++;

  const mult = size === 'large' ? 2 : size === 'medium' ? 1.5 : 1;
  addExp(Math.round(XP_EVENTS.house_built * mult), `строительство дома (${size})`);
  try { state.emit('stat:houseBuilt', { size, total: stats.housesBuilt }); } catch {}
}

function onCropsHarvested(count = 1) {
  const stats = ensureStats();
  stats.cropsHarvested += count|0;

  if (!passCooldown('harvest', 500)) return;
  const xp = Math.min(4, 1 + Math.floor((count|0) / 8));
  addExp(xp, `сбор урожая ×${count|0}`);
  try { state.emit('stat:crops', { count, total: stats.cropsHarvested }); } catch {}
}

// ── Сброс
function resetStats() {
  state.botStats = {
    level: 1,
    exp: 0,
    blocksMined: 0,
    mobsKilled: {},
    cropsHarvested: 0,
    itemsCrafted: 0,
    housesBuilt: 0,
    unlockedAbilities: []
  };
  chatLimiter('🔄 Статистика сброшена!');
  try { state.emit('stats:reset'); } catch {}
}

// ── Экспорт
module.exports = {
  // базовое API
  showStats,
  addExp,
  unlockAbility,
  resetStats,
  // хелперы событий
  onBlockMined,
  onMobKilled,
  onItemCrafted,
  onHouseBuilt,
  onCropsHarvested,
  // утилиты и настройки кривой (если нужно тюнить из вне)
  neededXP,
  XP_CURVE
};
