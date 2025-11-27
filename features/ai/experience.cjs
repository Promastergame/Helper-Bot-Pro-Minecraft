'use strict';
// ===============================
// features/ai/experience.cjs — v2.5 (офлайн самообучение, без LLM)
// 🧠 Глобальная обучающая память для всех подсистем (combat/build/craft/eat/mining/explore/env)
// • Байес с Лапласом + EMA + дисперсия Welford
// • Экспоненциальное «забывание» старых наблюдений (half-life)
// • LRU-обрезка, троттлинг записи, атомарный save + .bak
// • Динамический exploration-ε: больше случайности на малом опыте/низком успехе
// • Совет весов adjustWeights(): агрессия/оборона + учёт EMA time/damage/cost/reward + контекст state
// • Удобные begin()/end()/record() и доменные шорткаты
// ===============================

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// ──────────────────────────────────────────────────────────────────────────────
// Конфиг
// ──────────────────────────────────────────────────────────────────────────────
const defaults = {
  dataDir: path.resolve(process.cwd(), 'data'),
  fileName: 'experience.json',
  autosaveMs: 15000,            // период проверки автосейва
  minFlushIntervalMs: 2500,     // минимум между flush()
  maxEntries: 5000,             // лимит записей в памяти (LRU)
  debug: false,

  // Байес: p = (succ + α) / (tries + k)
  bayes: { k: 2, alpha: 1 },

  // EMA для метрик
  emaAlpha: 0.25,

  // Исследование: базовая вероятность случайного сдвига
  explorationEps: 0.08,

  // «Забывание» (экспоненциальный распад)
  decay: {
    halfLifeMs: 12 * 60 * 60 * 1000,  // наполовину ослабляем вклад каждые 12ч
    enabled: true
  },

  // Retention (жёсткая зачистка очень старого)
  retentionMs: 45 * 24 * 60 * 60 * 1000 // 45 дней
};

// ──────────────────────────────────────────────────────────────────────────────
// Внутреннее состояние
// ──────────────────────────────────────────────────────────────────────────────
const _state = {
  opt: { ...defaults },
  mem: new Map(),                 // key -> Entry
  lruOrder: [],                   // ключи по последнему доступу
  meta: { version: 2, createdAt: Date.now(), lastSave: 0, totalEvents: 0 },
  inflight: new Map(),            // token -> {type,name,ctxHash,start,aux}
  recent: [],                     // последние n событий (для диагностики)
  recentMax: 128,

  dirty: false,
  lastFlush: 0,
  flushing: false,
  saveTimer: null,

  bot: null
};

function log(...args) { if (_state.opt.debug) console.log('[experience]', ...args); }
const now = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ──────────────────────────────────────────────────────────────────────────────
// Утилиты
// ──────────────────────────────────────────────────────────────────────────────
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }
function filePath() { return path.join(_state.opt.dataDir, _state.opt.fileName); }

function hashCtx(ctx) {
  if (!ctx) return '';
  try {
    const json = JSON.stringify(ctx, Object.keys(ctx).sort());
    return crypto.createHash('sha1').update(json).digest('hex').slice(0, 16);
  } catch { return ''; }
}
function makeKey(type, name, ctx) { return `${type}:${name}${ctx ? '|' + hashCtx(ctx) : ''}`; }

// EMA
function updateEMA(prev, x, a) {
  const xn = Number(x);
  if (!Number.isFinite(xn)) return prev == null ? null : prev;
  return prev == null ? xn : (a * xn + (1 - a) * prev);
}

// Welford
function welfordAdd(stat, x) {
  if (!stat || stat.n == null) stat = { n: 0, mean: 0, m2: 0 };
  stat.n += 1;
  const delta = x - stat.mean;
  stat.mean += delta / stat.n;
  const delta2 = x - stat.mean;
  stat.m2 += delta * delta2;
  return stat;
}
const welfordMerge = welfordAdd;
const variance = (s) => (s && s.n > 1 ? s.m2 / (s.n - 1) : 0);

// LRU
function touchLRU(key) {
  const idx = _state.lruOrder.indexOf(key);
  if (idx !== -1) _state.lruOrder.splice(idx, 1);
  _state.lruOrder.push(key);
}
function pruneLRU() {
  const over = _state.mem.size - _state.opt.maxEntries;
  if (over <= 0) return 0;
  let removed = 0;
  while (removed < over && _state.lruOrder.length) {
    const key = _state.lruOrder.shift();
    const e = _state.mem.get(key);
    // бонус: не удаляем очень «свежие» или часто используемые
    if (e && now() - (e.lastAt || 0) < 30 * 60 * 1000) continue;
    if (_state.mem.has(key)) { _state.mem.delete(key); removed++; }
  }
  if (removed > 0) { _state.dirty = true; log('LRU removed', removed); }
  return removed;
}

// Атомарная запись
async function atomicWriteJSON(pathname, obj) {
  const data = JSON.stringify(obj, null, 2);
  const tmp = pathname + '.tmp';
  await fsp.writeFile(tmp, data, 'utf8').catch(() => fs.writeFileSync(tmp, data));
  await fsp.rename(tmp, pathname).catch(() => fs.renameSync(tmp, pathname));
}

// ──────────────────────────────────────────────────────────────────────────────
// Загрузка/сохранение
// ──────────────────────────────────────────────────────────────────────────────
async function load(options = {}) {
  _state.opt = { ...defaults, ...(options || {}) };
  ensureDir(_state.opt.dataDir);
  const fp = filePath();
  try {
    const raw = await fsp.readFile(fp, 'utf8');
    const json = JSON.parse(raw);

    // бэкап
    const backup = fp + '.bak';
    await fsp.copyFile(fp, backup).catch(() => {});

    if (json && json.entries) {
      for (const [k, v] of Object.entries(json.entries)) {
        _state.mem.set(k, v);
        _state.lruOrder.push(k);
      }
    }
    _state.meta = json.meta || _state.meta;
    // зачистка древнего
    sweepRetention();
    log('loaded', _state.mem.size, 'entries from', fp);
  } catch (e) {
    log('no usable experience file, starting fresh at', fp);
    await saveNow();
  }
  scheduleAutosave();
}

function scheduleAutosave() {
  if (_state.saveTimer) clearInterval(_state.saveTimer);
  _state.saveTimer = setInterval(() => { if (_state.dirty) flush().catch(() => {}); }, _state.opt.autosaveMs);
}

function stopAutosave() {
  if (_state.saveTimer) clearInterval(_state.saveTimer);
  _state.saveTimer = null;
}

async function flush() {
  const t = now();
  if (t - _state.lastFlush < _state.opt.minFlushIntervalMs) return;
  if (_state.flushing) return;
  _state.flushing = true;
  try {
    const fp = filePath();
    const obj = { meta: { ..._state.meta, lastSave: t }, entries: Object.fromEntries(_state.mem) };
    await atomicWriteJSON(fp, obj);
    _state.lastFlush = t;
    _state.dirty = false;
    log('flushed', _state.mem.size, 'entries');
  } finally {
    _state.flushing = false;
  }
}
async function saveNow() { _state.dirty = true; await flush(); }

// ──────────────────────────────────────────────────────────────────────────────
// Структуры
// ──────────────────────────────────────────────────────────────────────────────
function defaultEntry() {
  return {
    tries: 0,
    success: 0,
    fail: 0,
    lastAt: 0,
    decayedAt: 0, // когда в последний раз применяли распад

    ema: { time: null, damage: null, cost: null, reward: null },
    stats: {
      time:   { n: 0, mean: 0, m2: 0 },
      damage: { n: 0, mean: 0, m2: 0 },
      cost:   { n: 0, mean: 0, m2: 0 },
      reward: { n: 0, mean: 0, m2: 0 }
    },

    // локальная память поправок весов (субъективные предпочтения)
    weights: {},

    // плоский контекст (для дебага/аналитики)
    ctx: {}
  };
}

function getOrInitEntry(type, name, ctx) {
  const key = makeKey(type, name, ctx);
  let e = _state.mem.get(key);
  if (!e) { e = defaultEntry(); if (ctx) e.ctx = { ...ctx }; _state.mem.set(key, e); }
  // применим распад, если давно не трогали
  maybeDecay(e);
  e.lastAt = now();
  touchLRU(key);
  return { key, entry: e };
}

// Экспоненциальный распад очков tries/success/fail (чтобы свежий опыт был важнее)
function maybeDecay(e) {
  if (!_state.opt.decay?.enabled) return;
  const hl = _state.opt.decay.halfLifeMs;
  if (!hl || hl <= 0) return;

  const t = now();
  const last = e.decayedAt || e.lastAt || (t - hl);
  const dt = Math.max(0, t - last);
  if (dt < hl / 4) return; // не чаще, чем раз в четверть half-life

  const factor = Math.pow(0.5, dt / hl); // 2^(-dt/hl)
  e.tries   *= factor;
  e.success *= factor;
  e.fail    *= factor;

  // для надёжности не позволяем уходить в суб-единицы слишком сильно
  if (e.tries < 0.01 && e.success < 0.01 && e.fail < 0.01) {
    e.tries = e.success = e.fail = 0;
  }

  e.decayedAt = t;
}

// Жёсткая зачистка очень старых записей
function sweepRetention() {
  const r = _state.opt.retentionMs;
  if (!r || r <= 0) return;
  const t = now();
  let removed = 0;
  for (const [k, e] of _state.mem.entries()) {
    const age = t - (e.lastAt || 0);
    if (age > r) {
      _state.mem.delete(k);
      removed++;
    }
  }
  if (removed) { log('retention removed', removed); _state.dirty = true; }
}

// ──────────────────────────────────────────────────────────────────────────────
// Публичный API: init/attach
// ──────────────────────────────────────────────────────────────────────────────
async function init(botOrOptions, maybeOptions) {
  let options = maybeOptions || botOrOptions || {};
  let bot = null;
  if (botOrOptions && botOrOptions.entity && botOrOptions.on) { bot = botOrOptions; options = maybeOptions || {}; }
  await load(options);
  if (bot) attachToBot(bot);
  return api;
}

function attachToBot(bot) {
  _state.bot = bot;
  const quit = async () => {
    try { stopAutosave(); await flush(); } catch {}
  };
  bot.once('end', quit);
  bot.once('kicked', quit);
}

// ──────────────────────────────────────────────────────────────────────────────
// Сессии
// ──────────────────────────────────────────────────────────────────────────────
let _tokenSeq = 1;

function begin(type, name, ctx = {}, aux = {}) {
  const token = `${type}:${name}#${_tokenSeq++}`;
  _state.inflight.set(token, { type, name, ctxHash: hashCtx(ctx), ctx, start: now(), aux });
  return token;
}

function end(token, success = true, details = {}) {
  const act = _state.inflight.get(token);
  if (!act) return false;
  _state.inflight.delete(token);

  const dur = Math.max(1, (details.timeMs || (now() - act.start)));
  const ctx = act.ctx;
  const { key, entry } = getOrInitEntry(act.type, act.name, ctx);

  // статистика
  entry.tries += 1;
  success ? (entry.success += 1) : (entry.fail += 1);
  _state.meta.totalEvents++;

  // EMA
  const a = _state.opt.emaAlpha;
  if (dur) entry.ema.time = updateEMA(entry.ema.time, dur, a);
  if (details.damage != null)  entry.ema.damage  = updateEMA(entry.ema.damage,  details.damage,  a);
  if (details.cost != null)    entry.ema.cost    = updateEMA(entry.ema.cost,    details.cost,    a);
  if (details.reward != null)  entry.ema.reward  = updateEMA(entry.ema.reward,  details.reward,  a);

  // Welford
  entry.stats.time   = welfordMerge(entry.stats.time,   dur);
  if (details.damage != null) entry.stats.damage = welfordMerge(entry.stats.damage, details.damage);
  if (details.cost != null)   entry.stats.cost   = welfordMerge(entry.stats.cost,   details.cost);
  if (details.reward != null) entry.stats.reward = welfordMerge(entry.stats.reward, details.reward);

  // локальные поправки весов (если передали)
  if (details.weightsDelta && typeof details.weightsDelta === 'object') {
    for (const [k, v] of Object.entries(details.weightsDelta)) {
      const cur = entry.weights[k] ?? 1.0;
      entry.weights[k] = clamp(cur + Number(v || 0), 0.05, 4.0);
    }
  }

  // недавние события (для отладки/телеметрии)
  _state.recent.push({ t: now(), key, success, dur, details });
  if (_state.recent.length > _state.recentMax) _state.recent.shift();

  pruneLRU();
  _state.dirty = true;
  return true;
}

function record(type, name, success = true, details = {}, ctx = {}) {
  const token = begin(type, name, ctx, details.aux);
  return end(token, success, details);
}

// ──────────────────────────────────────────────────────────────────────────────
/** Оценка «успеха» с Лаплас-гладкой байес-частотой и распадом */
// ──────────────────────────────────────────────────────────────────────────────
function score(type, name, ctx = {}) {
  const { entry } = getOrInitEntry(type, name, ctx);
  const { k, alpha } = _state.opt.bayes;
  const s = (entry.success + alpha) / (entry.tries + k);
  return clamp(s, 0, 1);
}

function getStats(type, name, ctx = {}) {
  const { entry } = getOrInitEntry(type, name, ctx);
  return {
    tries: entry.tries,
    success: entry.success,
    fail: entry.fail,
    ema: { ...entry.ema },
    mean: {
      time:   entry.stats.time.mean,
      damage: entry.stats.damage.mean,
      cost:   entry.stats.cost.mean,
      reward: entry.stats.reward.mean
    },
    variance: {
      time:   variance(entry.stats.time),
      damage: variance(entry.stats.damage),
      cost:   variance(entry.stats.cost),
      reward: variance(entry.stats.reward)
    },
    weights: { ...entry.weights },
    lastAt: entry.lastAt
  };
}

function getRecent(limit = 20) {
  return _state.recent.slice(-limit);
}

function reportTop({ type = null, topN = 10 } = {}) {
  const arr = [];
  for (const [k, e] of _state.mem.entries()) {
    if (type && !k.startsWith(type + ':')) continue;
    const s = (e.success + _state.opt.bayes.alpha) / (e.tries + _state.opt.bayes.k);
    arr.push({ key: k, tries: e.tries, successRate: clamp(s, 0, 1), lastAt: e.lastAt });
  }
  arr.sort((a, b) => b.successRate - a.successRate);
  return arr.slice(0, topN);
}

// ──────────────────────────────────────────────────────────────────────────────
// Рекомендации весов (умнее и контекстнее)
// adjustWeights(type,name,base,ctx) -> {weights 0..1 sum=1}
// ──────────────────────────────────────────────────────────────────────────────
function normalizeWeights(obj) {
  const out = {};
  let sum = 0;
  for (const v of Object.values(obj)) sum += Math.max(0, v || 0);
  if (sum <= 0) return { ...obj };
  for (const [k, v] of Object.entries(obj)) out[k] = Math.max(0, v || 0) / sum;
  return out;
}

// аккуратно умножаем только существующие ключи
function mulKeys(dst, keys, mul) {
  for (const k of keys) if (k in dst) dst[k] = Math.max(0.0001, dst[k] * mul);
}

function adjustWeights(type, name, baseWeights, ctx = {}) {
  const s = score(type, name, ctx); // 0..1
  const { entry } = getOrInitEntry(type, name, ctx);
  const memW = entry.weights || {};
  const W = { ...baseWeights };

  // 1) Базовый глобальный сдвиг: успех → агрессия↑, провал → защита↑
  const aggrKeys = ['attack','push','rush','melee','charge','burst','crit'];
  const defKeys  = ['dodge','block','retreat','kite','heal','keepDistance','shield'];
  const aggrMul = clamp(1 + (s - 0.5) * 0.6, 0.75, 1.35);
  const defMul  = clamp(1 - (s - 0.5) * 0.3, 0.75, 1.20);
  mulKeys(W, aggrKeys, aggrMul);
  mulKeys(W, defKeys,  defMul);

  // 2) Учёт EMA-метрик (если есть)
  //   • долгие бои → меньше «rush»/«melee», больше «keepDistance»
  //   • большой урон → больше «dodge/block/retreat»
  //   • высокая стоимость → немного обороны
  //   • хорошая награда → слегка агрессии
  const time = Number(entry.ema.time ?? 0);
  const dmg  = Number(entry.ema.damage ?? 0);
  const cost = Number(entry.ema.cost ?? 0);
  const rew  = Number(entry.ema.reward ?? 0);

  const timeMulSlow   = clamp(1 + Math.min(0.35, (time / 3000) * 0.25), 1.0, 1.35);
  const dmgMulHurt    = clamp(1 + Math.min(0.45, (dmg  / 6)    * 0.30), 1.0, 1.45);
  const costMulCare   = clamp(1 + Math.min(0.25, (cost / 4)    * 0.20), 1.0, 1.25);
  const rewMulGreed   = clamp(1 + Math.min(0.30, (rew  / 4)    * 0.20), 1.0, 1.30);

  // если бой долгий или больно — делаем упор на дистанцию/защиту
  if (time > 2200) mulKeys(W, ['keepDistance','kite','dodge','block'], timeMulSlow);
  if (dmg  > 2.0)  mulKeys(W, ['dodge','block','retreat','heal'],      dmgMulHurt);
  if (cost > 0.5)  mulKeys(W, ['block','kite','keepDistance'],         costMulCare);
  if (rew  > 1.0)  mulKeys(W, ['attack','melee','rush','push'],        rewMulGreed);

  // 3) Локальная память поправок (пользователь/самообучение)
  for (const [k, v] of Object.entries(memW)) if (k in W) W[k] = Math.max(0.0001, W[k] * clamp(v, 0.5, 2.0));

  // 4) Учёт общего состояния (если есть core/state.cjs)
  try {
    const S = require('../../core/state.cjs');
    const hp = Number(S.state?.bot?.health ?? 20);
    if (hp < 8) mulKeys(W, ['dodge','block','retreat','heal','keepDistance'], 1.20);
    if (S.state?.isDead) mulKeys(W, ['retreat','keepDistance'], 1.25);
  } catch {}

  // 5) Динамический exploration ε: меньше попыток → больше исследования; при высоком s — меньше
  const baseEps = _state.opt.explorationEps;
  const tries = entry.tries || 0;
  const eps = clamp(baseEps * (tries < 6 ? 1.8 : 1.0) * (s > 0.7 ? 0.55 : (s < 0.4 ? 1.25 : 1.0)), 0.02, 0.35);
  if (Math.random() < eps) {
    const keys = Object.keys(W);
    if (keys.length) {
      const idx = Math.floor(Math.random() * keys.length);
      W[keys[idx]] *= 1.15;
    }
  }

  return normalizeWeights(W);
}

function nudgeWeights(type, name, deltas = {}, ctx = {}) {
  const { entry } = getOrInitEntry(type, name, ctx);
  for (const [k, v] of Object.entries(deltas)) {
    const cur = entry.weights[k] ?? 1.0;
    entry.weights[k] = clamp(cur + Number(v || 0), 0.1, 4.0);
  }
  _state.dirty = true;
  return { ...entry.weights };
}

// ──────────────────────────────────────────────────────────────────────────────
// Быстрые доменные хелперы
// ──────────────────────────────────────────────────────────────────────────────
const domains = {
  combat: {
    beginFight: (mobName, ctx) => begin('combat', mobName, ctx),
    endFight:   (token, { win, timeMs, damageTaken, weightsDelta } = {}) =>
      end(token, !!win, { timeMs, damage: damageTaken, weightsDelta }),
    advise: (mobName, base, ctx) => adjustWeights('combat', mobName, base, ctx),
    nudge:  (mobName, deltas, ctx) => nudgeWeights('combat', mobName, deltas, ctx)
  },
  craft: {
    begin: (recipeId, ctx) => begin('craft', recipeId, ctx),
    end:   (t, { ok, timeMs, cost, reward } = {}) => end(t, !!ok, { timeMs, cost, reward }),
    advise: (recipeId, base, ctx) => adjustWeights('craft', recipeId, base, ctx)
  },
  build: {
    begin: (structure, ctx) => begin('build', structure, ctx),
    end:   (t, { ok, timeMs, cost } = {}) => end(t, !!ok, { timeMs, cost }),
    advise: (structure, base, ctx) => adjustWeights('build', structure, base, ctx)
  },
  eat: {
    record: (item, ok, { satiety, timeMs } = {}) => record('eat', item, !!ok, { reward: satiety, timeMs }),
    advise: (item, base, ctx) => adjustWeights('eat', item, base, ctx)
  },
  mining: {
    begin: (block, ctx) => begin('mining', block, ctx),
    end:   (t, { ok, timeMs, toolCost } = {}) => end(t, !!ok, { timeMs, cost: toolCost })
  },
  explore: {
    record: (biome, ok, { timeMs } = {}) => record('explore', biome, !!ok, { timeMs })
  },
  env: {
    record: (label, ok) => record('env', label, !!ok)
  }
};

// ──────────────────────────────────────────────────────────────────────────────
// Экспорт/импорт снимка (на случай миграций/отладки)
// ──────────────────────────────────────────────────────────────────────────────
async function exportSnapshot(filepath = null) {
  const fp = filepath || filePath().replace(/\.json$/, `.snapshot-${Date.now()}.json`);
  const obj = { meta: _state.meta, entries: Object.fromEntries(_state.mem) };
  await atomicWriteJSON(fp, obj);
  return fp;
}

async function importSnapshot(filepath) {
  const raw = await fsp.readFile(filepath, 'utf8');
  const json = JSON.parse(raw);
  if (!json || !json.entries) throw new Error('bad snapshot');
  _state.mem.clear(); _state.lruOrder.length = 0;
  for (const [k, v] of Object.entries(json.entries)) { _state.mem.set(k, v); _state.lruOrder.push(k); }
  _state.meta = json.meta || _state.meta;
  _state.dirty = true;
  await flush();
}

// ──────────────────────────────────────────────────────────────────────────────
// Экспортируемый API
// ──────────────────────────────────────────────────────────────────────────────
const api = {
  // инициализация
  init,
  attachToBot,

  // базовые операции
  begin, end, record,

  // анализ
  score, getStats, getRecent, reportTop,

  // веса
  adjustWeights, nudgeWeights,

  // сохранение/снимки
  saveNow, exportSnapshot, importSnapshot,

  // домены
  domains,

  // доступ к опциям/метаданным (read-only)
  get options() { return { ..._state.opt }; },
  get meta()    { return { ..._state.meta }; }
};

module.exports = api;
