'use strict';

/**
 * levelingBridge.js — v2 UltraSafe
 * 🌉 Умный мост для системы прокачки
 *
 * • Ищет leveling.js / .cjs / ./ai/leveling*
 * • Кэширует результат
 * • Красивые логи
 * • Проверка структуры модуля
 * • Не падает жёстко — выдаёт заглушки
 */

// Кеш, чтобы не грузить по 100 раз
if (global.__LEVELING_CACHE) {
  module.exports = global.__LEVELING_CACHE;
  return;
}

const pathsToTry = [
  '../leveling.js',
  '../leveling.cjs',
  '../ai/leveling.js',
  '../ai/leveling.cjs'
];

let mod = null;
for (const p of pathsToTry) {
  try {
    mod = require(p);
    console.log(`[LevelingBridge] ✅ Загружен: ${p}`);
    break;
  } catch { /* тихо */ }
}

if (!mod) {
  console.log('⚠️ [LevelingBridge] leveling.js не найден! Включаю аварийные функции XP.');

  mod = {
    addExp: (...args) => {
      console.log('⚠️ addExp (stub):', args);
    },
    getLevel: () => 1,
    getXP: () => 0
  };
}

// Проверяем ключевые функции. Если кривой модуль — подстрахуемся
if (typeof mod.addExp !== 'function') {
  console.log('⚠️ [LevelingBridge] addExp отсутствует, создаю stub');
  mod.addExp = (...args) => console.log('⚠️ addExp (stub):', args);
}
if (typeof mod.getLevel !== 'function') {
  mod.getLevel = () => 1;
}
if (typeof mod.getXP !== 'function') {
  mod.getXP = () => 0;
}

// Кешируем
global.__LEVELING_CACHE = mod;
module.exports = mod;
