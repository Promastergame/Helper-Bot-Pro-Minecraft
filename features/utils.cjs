'use strict';

// ===============================
// core/utils.cjs — v3 Hybrid
// 💡 Умный, но компактный набор утилит
// ===============================

// 🎲 Случайные и базовые
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const jitter  = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3)); // ±15%
const clamp   = (x, a, b) => Math.max(a, Math.min(b, x));
const backoff = (n, base=5000, cap=30000) => Math.min(base * 2 ** n, cap);
const ts      = () => new Date().toISOString().split('T')[1].replace('Z', '');
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));

// ⚠️ Укороченный вывод ошибок
function warnShort(label, err) {
  try {
    const msg = err?.stack ? err.stack.split('\n')[1] : (err?.message || err);
    console.warn(`[${ts()}] ⚠️ ${label}: ${msg}`);
  } catch {
    console.warn(`[${ts()}] ⚠️ ${label}:`, err);
  }
}

// 🔁 Повтор с экспоненциальной задержкой, джиттером и логом
async function retryAsync(fn, {
  retries = 3,       // кол-во повторов
  base = 800,        // базовая задержка (мс)
  cap = 8000,        // верхний предел задержки (мс)
  factor = 2,        // коэффициент роста задержки
  jitterPct = 0.2,   // процент джиттера ±20%
  label = 'retry',   // тег для логов
  silent = false     // не логировать
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;

      // расчёт задержки
      const baseDelay = Math.min(cap, base * (factor ** attempt));
      const jitter = baseDelay * (1 - jitterPct + Math.random() * 2 * jitterPct);
      const delay = Math.round(jitter);

      if (!silent) {
        try {
          console.warn(`[${ts()}] ⟳ ${label} attempt ${attempt + 1}/${retries + 1}: ${e.message || e}`);
        } catch {}
      }

      await sleep(delay);
    }
  }
  throw lastErr;
}

// 🧭 Формат времени и байтов
function formatMs(ms) {
  if (ms < 1000) return `${ms}мс`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}с`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}м`;
  return `${(ms / 3600000).toFixed(1)}ч`;
}

function formatBytes(bytes) {
  const u = ['B','KB','MB','GB','TB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// 🧩 Утилиты контроля частоты
function debounce(fn, delay = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function throttle(fn, delay = 1000) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= delay) {
      last = now;
      fn(...args);
    }
  };
}

// ===============================
// 🧠 Экспорт
// ===============================
module.exports = {
  randInt, sleep, jitter, backoff, ts,
  warnShort, retryAsync, clamp,
  formatMs, formatBytes,
  debounce, throttle
};
