'use strict';

// ===============================
// core/utils.cjs
// 🔧 Общие утилиты для HelperBot
// ===============================

// Случайное целое
function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Сон (асинхронный)
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Лёгкий "джиттер" — небольшое случайное колебание времени
function jitter(ms, pct = 0.25) {
  const delta = ms * pct;
  return ms + (Math.random() * delta * 2 - delta);
}

// Время (часы:минуты:секунды)
function ts() {
  const d = new Date();
  return d.toTimeString().split(' ')[0];
}

// Короткое предупреждение в консоль (без огромных стэков)
function warnShort(label, err) {
  try {
    const msg = err?.message || String(err);
    console.warn(`[${ts()}] ⚠️ ${label}: ${msg}`);
  } catch (e) {
    console.warn(`[${ts()}] ⚠️ ${label}:`, err);
  }
}

// 🔁 Повтор функции с экспоненциальным backoff
async function retryAsync(fn, {
  retries = 3,
  base = 400,
  cap = 5000,
  label = 'retry'
} = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries) {
        warnShort(`${label} (exceeded retries)`, err);
        throw err;
      }
      const wait = Math.min(base * Math.pow(2, attempt - 1), cap);
      warnShort(`${label} attempt ${attempt} failed`, err);
      await sleep(jitter(wait));
    }
  }
}

module.exports = {
  randInt,
  sleep,
  jitter,
  ts,
  warnShort,
  retryAsync
};
