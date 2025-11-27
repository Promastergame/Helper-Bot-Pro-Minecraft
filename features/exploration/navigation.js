'use strict';
// ===============================
// features/exploration/navigation.js (v7-q)
// 🧭 Навигация/вейпоинты + Quantum-интеграция
// • Памятные точки в памяти процесса
// • Мягкие human-паузы при действиях
// • Лёгкий анти-хазард биас (лава/вода/высота)
// • Сообщение о деревне с анти-спамом
// ===============================

const { state } = require('../../core/state.cjs');              // <- исправлен путь
let Q; try { Q = require('../ai/quantum'); } catch { Q = null; } // опционально

// ──────────────────────────────────────────────────────────────
// Храним точки в памяти процесса (без файла)
// ──────────────────────────────────────────────────────────────
let waypoints = {
  'дом'   : { x: 0,   y: 64, z: 0 },
  'шахта' : { x: 100, y: 45, z: -50 },
  'ферма' : { x: -30, y: 64, z: 40 }
};

// Доп.память
state.lastVillageAnnounce = state.lastVillageAnnounce || 0;
state.homeChest = state.homeChest || null;

// ──────────────────────────────────────────────────────────────
// Внутренние утилиты
// ──────────────────────────────────────────────────────────────
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const rnd   = (a,b) => a + ( (Q?.quantumRandom?.() ?? Math.random()) * (b-a) );
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function humanPause(ms) {
  const jitter = Math.floor(rnd(-0.2*ms, 0.2*ms));
  const t = Math.max(0, ms + jitter);
  if (Q?.humanDelay) return Q.humanDelay(t);
  return sleep(t);
}

// use proper Vec3 to be compatible with mineflayer APIs
const _Vec3Factory = (() => { try { return require('vec3').Vec3; } catch { return function V3(x,y,z){ this.x=x; this.y=y; this.z=z; }; } })();
function vec3(x,y,z){ return new _Vec3Factory(x, y, z); }
function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y, dz=a.z-b.z; return Math.hypot(dx,dy,dz); }

// ──────────────────────────────────────────────────────────────
// Публичные CRUD по точкам
// ──────────────────────────────────────────────────────────────
async function loadWaypoints() {
  state.homeChest = waypoints.__homeChest || null; // восстановили из «памяти»
  return waypoints;
}
async function saveWaypoints() {
  waypoints.__homeChest = state.homeChest || null;
  return true;
}
function listPoints() { return Object.keys(waypoints).filter(k => !k.startsWith('__')); }
function delPoint(name) { delete waypoints[name]; return saveWaypoints(); }
function setPoint(name, pos) { waypoints[name] = { x: pos.x|0, y: pos.y|0, z: pos.z|0 }; return saveWaypoints(); }
function getPoint(name) { return waypoints[name] || null; }

// ──────────────────────────────────────────────────────────────
/** Быстрый анти-хазард биас: штрафуем цель, если путь идёт над лавой/высокой высотой/водой.
 *  Это НЕ полноценный A*, только «предчувствие» направления. */
function hazardBias(bot, target){
  try{
    const me = bot.entity.position;
    const d  = dist(me, target);
    let risk = 0;

    // Высота
    const drop = Math.max(0, (me.y - target.y));
    risk += clamp(drop / 6, 0, 1) * 0.35;

    // Блоки поблизости по прямой (простая выборка)
    const samples = 5;
    for (let i=1;i<=samples;i++){
      const t = i / samples;
      const px = Math.round(me.x + (target.x - me.x) * t);
      const py = Math.round(me.y + (target.y - me.y) * t);
      const pz = Math.round(me.z + (target.z - me.z) * t);
      const b  = bot.blockAt(vec3(px, py-1, pz));
      const name = b?.name || '';
      if (name.includes('lava')) risk += 0.5;
      if (name.includes('water')) risk += 0.15;
    }

    // Чем дальнее — тем чуть больше риска накапливаем
    risk += clamp(d/64, 0, 0.25);

    // Вернём штраф (0..1+)
    return clamp(risk, 0, 1.2);
  }catch{ return 0; }
}

/** Подмешиваем биас в цель (робко смещаем на безопасный вектор).
 *  Если есть Quantum.entanglementField — используем её. */
function biasTarget(bot, target){
  if (Q?.entanglementField) {
    return Q.entanglementField(bot, target);
  }
  // fallback: небольшой сдвиг «от риска»
  const me = bot.entity.position;
  const bias = hazardBias(bot, target);
  if (bias <= 0.01) return target;

  const dir = vec3(target.x - me.x, target.y - me.y, target.z - me.z);
  const L = Math.hypot(dir.x, dir.y, dir.z) || 1;
  // вбок на немного (перпендикуляр в плоскости XZ)
  const side = (Q?.randSign?.() ?? (Math.random()<0.5 ? -1 : 1));
  const ox =  side * (dir.z / L);
  const oz = -side * (dir.x / L);
  const strength = 0.8 * bias; // 0..~1
  return vec3(target.x + ox*strength, target.y, target.z + oz*strength);
}

// ──────────────────────────────────────────────────────────────
// Навигация к точке (GoalNear)
// ──────────────────────────────────────────────────────────────
async function goToPoint(bot, name, radius = 2){
  const pt = getPoint(name);
  if (!pt) { bot.brain?.say?.(`❓ Точка «${name}» не найдена`); return false; }

  const target = biasTarget(bot, pt);
  const { goals } = await import('mineflayer-pathfinder');
  try {
    bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, radius));
    bot.brain?.say?.(`🧭 Иду к «${name}» (${target.x}|${target.y}|${target.z})`);
  } catch (e) {
    bot.brain?.say?.(`⚠️ Не могу построить путь к «${name}»: ${e?.message||'ошибка'}`);
    return false;
  }

  await humanPause(180);
  return true;
}

// ──────────────────────────────────────────────────────────────
// «Микро-исследование»: сделать пару шагов в безопасную сторону,
// когда нет активной цели (можно вызывать из idler’a).
// ──────────────────────────────────────────────────────────────
async function microExploreStep(bot, step = 4){
  try{
    const me = bot.entity.position;
    const yaw = (Q?.quantumRandom?.() ?? Math.random()) * Math.PI * 2;
    const tgt = vec3(
      Math.round(me.x + Math.cos(yaw)*step),
      Math.round(me.y    ),
      Math.round(me.z + Math.sin(yaw)*step)
    );
    const biased = biasTarget(bot, tgt);

    const { goals } = await import('mineflayer-pathfinder');
    bot.pathfinder.setGoal(new goals.GoalNear(biased.x, biased.y, biased.z, 1), true);
    await humanPause(120 + step*40);
    return true;
  }catch{ return false; }
}

// ──────────────────────────────────────────────────────────────
// Деревня рядом? (villager или bell)
// ──────────────────────────────────────────────────────────────
function nearVillage(bot){
  try{
    const villager = Object.values(bot.entities).some(e => e?.name === 'villager');
    const bellId = bot.registry?.blocksByName?.bell?.id;
    const bell = bellId ? bot.findBlocks({ matching: [bellId], maxDistance: 32, count: 1 }) : [];
    return !!villager || (bell && bell.length > 0);
  }catch{ return false; }
}

// Периодический тик: оповещение о деревне
function structuresTick(bot){
  const t = Date.now();
  const cd = 30000; // 30с
  if (t - state.lastVillageAnnounce > cd && nearVillage(bot)){
    state.lastVillageAnnounce = t;
    bot.brain?.say?.('🏘️ Похоже, рядом деревня!');
  }
}

// ──────────────────────────────────────────────────────────────
// Экспорт API
// ──────────────────────────────────────────────────────────────
module.exports = {
  // CRUD
  loadWaypoints,
  saveWaypoints,
  listPoints,
  delPoint,
  setPoint,
  getPoint,

  // Навигация/исследование
  goToPoint,
  microExploreStep,

  // События окружения
  structuresTick
};
