'use strict';
// ===============================
// features/ai/xpHelpers.cjs — v10 Pro
// 🎓 Лёгкий, безопасный XP-слой для доменов (mining/crafting/smelting/combat/build)
//   • Единый враппер withDomainXP() (+ сахары withXxxXP)
//   • Гибкие советы весов: память (experience.cjs) + аккуратные эвристики
//   • «Первый успех», стрики, мягкие штрафы, умный авто-reward
//   • Плавная интеграция с leveling (много путей) и полной офлайн-памятью
//   • 100% бэк-компат со старым кодом
// ===============================

const { state } = require('../../core/state.cjs');

// ───────────────────────────────────────────────────────────────────────────────
// Подключаем optional зависимости безопасно
// ───────────────────────────────────────────────────────────────────────────────
let leveling = null;
for (const p of [
  '../quests/leveling.js',   // если есть мост
  '../leveling.js',          // features/leveling.js
  '../../leveling.js'        // корень /leveling.js
]) {
  try { leveling = require(p); break; } catch {}
}

let Experience = null;
try { Experience = require('./experience.cjs'); } catch {}

// ───────────────────────────────────────────────────────────────────────────────
// Внутренние утилиты и настройки
// ───────────────────────────────────────────────────────────────────────────────
const now   = () => Date.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sumObj = (m) => m ? Object.values(m).reduce((a, b) => a + (b || 0), 0) : 0;

const CFG = Object.freeze({
  BASE_REWARD: {
    mining:   2,
    crafting: 3,
    smelting: 3,
    combat:   5,
    building: 4
  },
  FIRST_SUCCESS_BONUS: 5,
  STREAK: {
    windowMs: 90_000,  // окно для растущего стрика
    bonus:    0.18,    // +18% за шаг стрика
    cap:      0.90     // максимум +90% (≈ x1.9)
  },
  ERROR_PENALTY: 0.35,
  // Доп. корректировки «скорости» и сложности
  SPEED_REWARD: { // быстрее — чуть выгодней
    minMs:  700,   // быстрые действия
    maxMs:  6000,  // долгие действия
    minMul: 0.85,
    maxMul: 1.18
  }
});

function ensureXpState() {
  state.__xp ||= {
    last: Object.create(null),    // per-domain: последний удачный ts
    streak: Object.create(null),  // per-domain: длина стрика
    first: Object.create(null)    // per-domain: уже был первый успех?
  };
  state.botStats ||= {};
}

function normalizeWeights(obj) {
  const out = {}; let sum = 0;
  for (const v of Object.values(obj || {})) sum += Math.max(0, v || 0);
  if (sum <= 0) return { ...(obj || {}) };
  for (const [k, v] of Object.entries(obj || {})) out[k] = Math.max(0, v || 0) / sum;
  return out;
}

function blend(a, b, k = 0.5) {
  const out = { ...(a || {}) };
  for (const [key, v] of Object.entries(b || {})) {
    const x = typeof out[key] === 'number' ? out[key] : v;
    out[key] = clamp(x * (1 - k) + v * k, 0, 1);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// Советчик весов: память (experience) + доменные soft-эвристики
// ───────────────────────────────────────────────────────────────────────────────
function domainHeuristics(name) {
  // Возвращает функцию: (targetKey, baseWeights, ctx) => weights 0..1
  return (key, base, ctx = {}) => {
    let w = { ...(base || {}) };

    // Общая осторожность: смерть/ночь/мало HP
    if (state.isDead) w.safety = clamp((w.safety ?? 0.3) + 0.15, 0.05, 0.95);
    if (ctx.night === true)    w.safety = clamp((w.safety ?? 0.3) + 0.06, 0.05, 0.95);
    if (typeof ctx.health === 'number' && ctx.health < 8)
      w.safety = clamp((w.safety ?? 0.3) + 0.15, 0.05, 0.95);

    // История игрока
    const s = state.botStats || {};
    if (name === 'mining') {
      if ((s.blocksMined || 0) > 300) w.cluster = clamp((w.cluster ?? 0.3) + 0.12, 0.05, 0.95);
      if ((s.blocksMined || 0) < 40)  w.safety  = clamp((w.safety  ?? 0.3) + 0.08, 0.05, 0.95);
    }
    if (name === 'combat') {
      const kills = typeof s.mobsKilled === 'object' ? sumObj(s.mobsKilled) : (s.mobsKilled || 0);
      if (kills > 150) w.speed = clamp((w.speed ?? 0.4) + 0.10, 0.05, 0.95);
    }
    if (name === 'building') {
      // Для стройки повышаем важность точности/безопасности
      w = blend(w, { speed: 0.45, accuracy: 0.4, safety: 0.25 }, 0.35);
    }

    // Если подключена офлайн-память — получить контекстный совет и аккуратно смешать
    if (Experience && typeof Experience.adjustWeights === 'function') {
      try {
        const advised = Experience.adjustWeights(name, key || 'default', normalizeWeights(w), ctx);
        w = normalizeWeights(blend(w, advised, 0.65)); // чуть больше доверия памяти
      } catch {}
    }

    return normalizeWeights(w);
  };
}

function getXP(/* bot */) {
  const advise = {
    mining:   domainHeuristics('mining'),
    crafting: domainHeuristics('crafting'),
    smelting: domainHeuristics('smelting'),
    combat:   domainHeuristics('combat'),
    build:    domainHeuristics('building'),
    building: domainHeuristics('building') // алиас
  };

  return {
    // Старый API (совместимость)
    adjustWeights(domain, target, base, ctx) {
      const fn = advise[domain] || ((_, b) => normalizeWeights(b || {}));
      return fn(target || 'default', base || {}, ctx || {});
    },
    // Новый удобный API
    domains: {
      mining:   { advise: advise.mining   },
      crafting: { advise: advise.crafting },
      smelting: { advise: advise.smelting },
      combat:   { advise: advise.combat   },
      build:    { advise: advise.build    },
      building: { advise: advise.building }
    }
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Подсчёт награды (умно и устойчиво к мусору)
// ───────────────────────────────────────────────────────────────────────────────
function computeReward(domain, ms, summary, hadError) {
  const base = CFG.BASE_REWARD[domain] ?? 2;
  let reward = base;

  // Если summarizer вернул конкретную награду — берём её
  if (summary && typeof summary.reward === 'number') reward = summary.reward;

  // Мягкий бонус за скорость (чем быстрее — тем немного больше)
  if (!hadError && typeof ms === 'number' && Number.isFinite(ms)) {
    const { minMs, maxMs, minMul, maxMul } = CFG.SPEED_REWARD;
    const t = clamp((ms - minMs) / Math.max(1, (maxMs - minMs)), 0, 1); // 0 → быстрый, 1 → долгий
    const mul = clamp(maxMul - (maxMul - minMul) * t, minMul, maxMul);
    reward = Math.round(reward * mul);
  }

  // «Первый успех» в домене — единоразово даём буст
  if (!hadError) {
    if (!state.__xp.first[domain]) {
      reward += CFG.FIRST_SUCCESS_BONUS;
      state.__xp.first[domain] = true;
    }
  }

  // Стрики успехов: если недавний успех — растим множитель
  if (!hadError) {
    const lastOk = state.__xp.last[domain] || 0;
    const fresh  = (now() - lastOk) <= CFG.STREAK.windowMs;
    state.__xp.streak[domain] = fresh ? (state.__xp.streak[domain] || 0) + 1 : 0;
    const bonus = clamp(state.__xp.streak[domain] * CFG.STREAK.bonus, 0, CFG.STREAK.cap);
    reward = Math.round(reward * (1 + bonus));
    state.__xp.last[domain] = now();
  } else {
    // Ошибка — мягкий штраф
    reward = Math.round(reward * CFG.ERROR_PENALTY);
  }

  return Math.max(0, reward | 0);
}

// ───────────────────────────────────────────────────────────────────────────────
// Универсальный враппер с XP и офлайн-памятью
// Поддерживает как старую сигнатуру, так и новый объектный стиль:
//   withDomainXP(bot, 'combat', 'zombie', ctx, workFn, summarizer)
//   withDomainXP(bot, { domain:'combat', label:'zombie', ctx, work:workFn, summarize:summarizer })
// summarizer(res, err, { timeMs }) → { ok?, reward?, cost?, timeMs?, weightsDelta? }
// ───────────────────────────────────────────────────────────────────────────────
async function withDomainXP(bot, domainOrOpts, label, _ctx, workFn, summarizer) {
  ensureXpState();

  // Нормализуем вход
  let domain = domainOrOpts;
  let ctx = _ctx || {};
  let work = workFn;
  let summarize = summarizer;

  if (domain && typeof domain === 'object') {
    const o = domainOrOpts || {};
    domain   = o.domain;
    label    = o.label;
    ctx      = o.ctx || {};
    work     = o.work || o.run || workFn;
    summarize= o.summarize || o.summary || summarizer;
  }

  if (typeof work !== 'function') throw new Error('withDomainXP: work function is required');
  const t0 = now();
  let res, err, sum = null;

  // Если есть Experience — откроем сессию
  const exp = Experience && Experience.domains && Experience.domains[domain];
  const token = exp && typeof exp.begin === 'function'
    ? exp.begin(label || 'default', safeCtxForExp(ctx))
    : null;

  try {
    res = await work();
  } catch (e) {
    err = e;
  }

  const ms = now() - t0;

  // Дать шансы summarizer-у
  if (typeof summarize === 'function') {
    try {
      const out = await summarize(res, err, { timeMs: ms });
      if (out && typeof out === 'object') sum = out;
      // Явный ok=false → считаем ошибкой
      if (sum && sum.ok === false && !err) err = new Error('summarizer: not ok');
    } catch {
      // summarizer необязателен
    }
  }

  // Подсчёт награды
  const reward = computeReward(domain, ms, sum, !!err);

  // Начислить опыт (если система подключена)
  try {
    if (leveling?.addExp && reward > 0) {
      const tag = String(label || '').trim();
      const reason = tag ? `${domain}/${tag}` : domain;
      leveling.addExp(reward, reason);
      state.botStats.lastReward = reward;
    }
  } catch {}

  // Закрыть сессию в офлайн-памяти
  try {
    if (exp && typeof exp.end === 'function' && token) {
      exp.end(token, {
        ok: !err,
        win: !err,                     // для combat.beginFight/endFight совместимо
        timeMs: ms,
        cost: sum?.cost,
        reward: reward,
        damageTaken: sum?.damageTaken,
        weightsDelta: sum?.weightsDelta
      });
    } else if (Experience && !token && domain && label) {
      // Простой record, если у домена нет begin/end
      Experience.record(domain, label, !err, { timeMs: ms, reward: reward, cost: sum?.cost }, safeCtxForExp(ctx));
    }
  } catch {}

  if (err) throw err;
  return res;
}

function safeCtxForExp(ctx) {
  // Защитим опыт от тяжелых объектов (бот/энтити/круговые ссылки)
  const out = {};
  for (const [k, v] of Object.entries(ctx || {})) {
    if (v == null) { out[k] = v; continue; }
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') { out[k] = v; continue; }
    if (Array.isArray(v)) { out[k] = v.filter(x => ['string','number','boolean'].includes(typeof x)); continue; }
    // игнорируем функции/объекты/крупные структуры
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// Сахары per-domain (компактные врапперы)
// ───────────────────────────────────────────────────────────────────────────────
const withMiningXP   = (bot, label, ctx, fn, sum) => withDomainXP(bot, 'mining',   label, ctx, fn, sum);
const withCraftXP    = (bot, label, ctx, fn, sum) => withDomainXP(bot, 'crafting', label, ctx, fn, sum);
const withSmeltXP    = (bot, label, ctx, fn, sum) => withDomainXP(bot, 'smelting', label, ctx, fn, sum);
const withCombatXP   = (bot, label, ctx, fn, sum) => withDomainXP(bot, 'combat',   label, ctx, fn, sum);
const withBuildXP    = (bot, label, ctx, fn, sum) => withDomainXP(bot, 'building', label, ctx, fn, sum);

// ───────────────────────────────────────────────────────────────────────────────
// Экспорт
// ───────────────────────────────────────────────────────────────────────────────
module.exports = {
  // ядро
  withDomainXP,
  // домены
  withMiningXP,
  withCraftXP,
  withSmeltXP,
  withCombatXP,
  withBuildXP,
  // советы
  getXP
};
