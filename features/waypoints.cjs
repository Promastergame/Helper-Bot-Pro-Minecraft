'use strict';
// ===============================
// features/waypoints.cjs — v9 Pro
// 📍 Система точек для навигации (safe, queued, dimension-aware)
// ===============================

const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const { goals, Movements } = require('mineflayer-pathfinder');
const { state, enqueue } = require('../core/state.cjs');

const DATA_DIR = path.resolve(process.cwd(), 'data');
const WAYPOINTS_FILE = path.join(DATA_DIR, 'waypoints.json');

let waypoints = {}; // { name: { x,y,z, dim, savedAt } }

// ───────────────────────── утилиты ─────────────────────────
function ensureDataDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function throttle(fn, ms = 1000) {
  let t = 0;
  return (...args) => {
    const now = Date.now();
    if (now - t >= ms) { t = now; try { fn(...args); } catch {} }
  };
}
const chat = throttle((bot, msg) => { try { bot.chat(String(msg)); } catch {} }, 900);

let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      ensureDataDir();
      fs.writeFileSync(WAYPOINTS_FILE, JSON.stringify(waypoints, null, 2));
    } catch (e) {
      console.log('⚠️ Ошибка сохранения waypoints:', e.message);
    }
  }, 250);
}

function currentDimension(bot) {
  // prismarine’s dimension name or fallback
  return (bot?.game?.dimension || bot?.game?.dimension?.toString?.()) ?? 'minecraft:overworld';
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// ───────────────────── загрузка/сохранение ─────────────────────
function loadWaypoints() {
  try {
    ensureDataDir();
    if (fs.existsSync(WAYPOINTS_FILE)) {
      const data = fs.readFileSync(WAYPOINTS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      waypoints = parsed && typeof parsed === 'object' ? parsed : {};
      console.log(`📍 Загружено ${Object.keys(waypoints).length} точек`);
    }
  } catch (e) {
    console.log('⚠️ Ошибка загрузки waypoints:', e.message);
    waypoints = {};
  }
}

// ───────────────────── CRUD ─────────────────────
function setWaypoint(bot, name, opts = {}) {
  if (!bot?.entity?.position) return false;
  const pos = bot.entity.position;
  const dim = opts.dimension || currentDimension(bot);
  waypoints[name] = {
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    z: Math.round(pos.z),
    dim,
    savedAt: Date.now()
  };
  scheduleSave();
  chat(bot, `📍 Точка "${name}" сохранена (${waypoints[name].x} ${waypoints[name].y} ${waypoints[name].z}, ${dim.split(':').pop()}).`);
  return true;
}

function deleteWaypoint(name) {
  if (waypoints[name]) {
    delete waypoints[name];
    scheduleSave();
    return true;
  }
  return false;
}

function renameWaypoint(oldName, newName) {
  if (!waypoints[oldName] || waypoints[newName]) return false;
  waypoints[newName] = waypoints[oldName];
  delete waypoints[oldName];
  scheduleSave();
  return true;
}

function listWaypoints() {
  return { ...waypoints };
}

// компактный список в чат
function listWaypointsChat(bot) {
  const keys = Object.keys(waypoints);
  if (!keys.length) { chat(bot, '📭 Нет сохранённых точек'); return; }
  const preview = keys.slice(0, 20).join(', ') + (keys.length > 20 ? ' …' : '');
  chat(bot, `📍 Точки (${keys.length}): ${preview}`);
}

// ───────────────────── поиск ─────────────────────
function nearestWaypoint(bot, { sameDimension = true, prefix = null } = {}) {
  const dim = currentDimension(bot);
  const me = bot?.entity?.position || new Vec3(0, 0, 0);
  let best = null, bestD = Infinity;

  for (const [name, p] of Object.entries(waypoints)) {
    if (sameDimension && p.dim && p.dim !== dim) continue;
    if (prefix && !name.toLowerCase().startsWith(String(prefix).toLowerCase())) continue;
    const d = dist(me, p);
    if (d < bestD) { best = { name, ...p }; bestD = d; }
  }
  return best;
}

// ───────────────────── навигация ─────────────────────
function mcDataFor(bot) {
  try { return require('minecraft-data')(bot.version); } catch { return null; }
}

function setSafeMovements(bot) {
  const mcData = mcDataFor(bot);
  if (!mcData) return;
  const m = new Movements(bot, mcData);
  m.allow1by1towers = false;
  m.maxDropDownDistance = 3;
  m.scafoldingBlocks = [];
  m.parkour = false;
  m.canOpenDoors = true;
  try { bot.pathfinder.setMovements(m); } catch {}
}

/**
 * Перейти к сохранённой точке.
 * Выполняется через очереди задач (enqueue) чтобы не конфликтовать с другими действиями.
 */
function goToWaypoint(bot, name, { range = 1, timeoutMs = 20000, silent = false } = {}) {
  return enqueue(async () => {
    const p = waypoints[name];
    if (!p) { if (!silent) chat(bot, `❌ Точка "${name}" не найдена.`); return false; }

    // проверка измерения
    const dim = currentDimension(bot);
    if (p.dim && p.dim !== dim) {
      chat(bot, `⚠️ Точка "${name}" в другом измерении (${p.dim.split(':').pop()}). Перейди вручную и повтори.`);
      return false;
    }

    setSafeMovements(bot);

    // GoalGetToBlock → точнее; если недоступно — GoalNear
    const goal = goals.GoalGetToBlock
      ? new goals.GoalGetToBlock(p.x, p.y, p.z)
      : new goals.GoalNear(p.x, p.y, p.z, Math.max(1, range));

    if (!silent) chat(bot, `🛣️ Иду к "${name}"…`);

    const run = bot.pathfinder.goto(goal);
    let timer;
    try {
      await Promise.race([
        run,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); })
      ]);
      if (!silent) chat(bot, `✅ Достиг точки "${name}".`);
      return true;
    } catch (e) {
      if (!silent) chat(bot, `⚠️ Не получилось дойти до "${name}" (${e.message || e}).`);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, `goTo:${name}`, 2); // приоритет чуть выше стандартного
}

// быстрая обёртка: идти к ближайшей
function goToNearest(bot, opts = {}) {
  const n = nearestWaypoint(bot, opts);
  if (!n) { chat(bot, '📭 Рядом нет подходящих точек.'); return Promise.resolve(false); }
  return goToWaypoint(bot, n.name, opts);
}

// ───────────────────── импорт/экспорт ─────────────────────
function exportWaypoints() {
  return JSON.stringify(waypoints, null, 2);
}
function importWaypoints(json, { overwrite = false } = {}) {
  try {
    const obj = JSON.parse(String(json || '{}'));
    if (overwrite) waypoints = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (!v || typeof v !== 'object') continue;
      const { x, y, z } = v;
      waypoints[k] = {
        x: Math.round(Number(x) || 0),
        y: Math.round(Number(y) || 0),
        z: Math.round(Number(z) || 0),
        dim: v.dim || 'minecraft:overworld',
        savedAt: v.savedAt || Date.now()
      };
    }
    scheduleSave();
    return true;
  } catch { return false; }
}

// ───────────────────── инициализация ─────────────────────
loadWaypoints();

// ───────────────────── экспорт ─────────────────────
module.exports = {
  // загрузка/сохранение
  loadWaypoints,
  exportWaypoints,
  importWaypoints,

  // CRUD
  setWaypoint,
  deleteWaypoint,
  renameWaypoint,
  listWaypoints,       // для телеги/внешних
  listWaypointsChat,   // для чата

  // навигация
  goToWaypoint,
  goToNearest,
  nearestWaypoint
};
