'use strict';
/**
 * features/ai/skillBrain.cjs — v3.0 “RPG+++”
 * 🔥 Прокачка навыков для бота (CommonJS, без чат-команд)
 *
 * НОВОЕ (в сравнении с 2.x):
 * - Бафы (временные множители XP/модификаторов) + управление ими.
 * - Ачивки (авто-выдача по условиям) + событие 'achievement'.
 * - Ежедневные квесты (автоподбор, прогресс, награды) + событие 'questComplete'.
 * - EventEmitter: события 'xp','levelUp','save','achievement','questComplete','error'.
 * - Ранги по суммарному уровню (Bronze → Mythic).
 * - Улучшенная кривая и анти-фарм; правки Rested XP.
 * - Снапшоты + экспорт диффа для отладки.
 * - Самотест: api.selfTest() проверит базовые сценарии.
 *
 * Совместимость: все функции 2.x сохранены (см. экспорт внизу).
 */

const fs   = require('fs');
const fsp  = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');

/* ────────────────────────────────────────────────────────────────────────────
 * Опциональная интеграция с локальным “опытом” (RL/оффлайн)
 * ─────────────────────────────────────────────────────────────────────────── */
let EXP = null;
try { EXP = require('./experience.cjs'); } catch { EXP = null; }

/* ────────────────────────────────────────────────────────────────────────────
 * Константы/утилиты
 * ─────────────────────────────────────────────────────────────────────────── */
const SKILL_LIST = [
  'combat','mining','woodcutting','building','crafting',
  'smelting','explore','agility','defense','utility'
];

const RANKS = [
  { name:'Bronze',  minSum:  10 },
  { name:'Silver',  minSum:  50 },
  { name:'Gold',    minSum: 120 },
  { name:'Platinum',minSum: 220 },
  { name:'Diamond', minSum: 360 },
  { name:'Mythic',  minSum: 520 }
];

function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function now(){ return Date.now(); }
function ensureDir(p){ try { fs.mkdirSync(p, { recursive:true }); } catch {} }
function deepClone(x){ return JSON.parse(JSON.stringify(x)); }

/* ────────────────────────────────────────────────────────────────────────────
 * Дефолтные настройки
 * ─────────────────────────────────────────────────────────────────────────── */
const defaults = {
  dataDir: path.resolve(process.cwd(), 'data'),
  fileName: 'skills.json',
  autosaveMs: 12000,
  minFlushMs: 2500,
  debug: false,

  // XP→Level: суммарная XP до уровня L = A*L^P + B*L (мягкая прогрессия)
  curve: { A: 38, P: 2.12, B: 22, maxLevel: 100 },

  // Линейные шкалы модификаторов
  scales: {
    combat:     { damage:0.012, attackSpeed:0.010, block:0.010 },
    mining:     { digSpeed:0.013, durabilitySave:0.004, veinBonus:0.003 },
    woodcutting:{ chopSpeed:0.013, saplingRate:0.005 },
    building:   { placeAccuracy:0.012, misRefund:0.004, reachHint:0.002 },
    crafting:   { batchYield:0.005, toolQuality:0.003 },
    smelting:   { fuelEff:0.006, speed:0.004 },
    explore:    { pathfinding:0.010, mapSense:0.003 },
    agility:    { moveSpeed:0.008, stamina:0.004, parkour:0.003 },
    defense:    { drFlat:0.004, shield:0.006 },
    utility:    { successRate:0.007 }
  },

  // Перк-пороги
  perks: {
    10:  { combat:{damage:+0.02}, mining:{digSpeed:+0.02}, building:{placeAccuracy:+0.02} },
    25:  { combat:{attackSpeed:+0.03}, smelting:{fuelEff:+0.04}, woodcutting:{chopSpeed:+0.03} },
    50:  { defense:{drFlat:+0.04}, mining:{durabilitySave:+0.03}, crafting:{batchYield:+0.04}, agility:{moveSpeed:+0.03} },
    75:  { combat:{damage:+0.05, attackSpeed:+0.03}, building:{misRefund:+0.05}, explore:{pathfinding:+0.04} },
    100: {
      combat:{damage:+0.06, attackSpeed:+0.05},
      mining:{digSpeed:+0.06}, woodcutting:{chopSpeed:+0.06},
      defense:{drFlat:+0.06}, agility:{moveSpeed:+0.05}
    }
  },

  // Rested XP
  rest: {
    enable: true,
    threshold: 300,
    bonus: 0.25,             // +25% к начислению, пока горит restXP
    rechargeMs: 10*60*1000,  // каждые 10 мин простоя → +threshold/2
  },

  // Анти-фарм (минутное окно)
  antifarm: {
    bucketMs: 60000,
    caps: {
      mining:160, woodcutting:160, combat:180, building:160,
      crafting:120, smelting:120, explore:80, agility:80,
      defense:120, utility:80
    }
  },

  // Бафы по умолчанию (пример пресетов: id -> {kind, skill?, mult, until?})
  defaultBuffs: {},

  // Квесты (пул задач). progressField — имя счётчика в ctx/history.
  quests: {
    dailyCount: 3,
    rerollOnLoad: true,
    pool: [
      { id:'mine_ore_50',     skill:'mining',     title:'Добыть 50 руды',       progressField:'mining_blocks', goal:50,   rewardXP:{ mining:120 } },
      { id:'wood_100',        skill:'woodcutting',title:'Срубить 100 брёвен',   progressField:'wood_count',    goal:100,  rewardXP:{ woodcutting:140 } },
      { id:'build_200',       skill:'building',   title:'Поставить 200 блоков', progressField:'placed_blocks', goal:200,  rewardXP:{ building:150 } },
      { id:'run_500',         skill:'agility',    title:'Пробежать 500м',       progressField:'ag_travel',     goal:500,  rewardXP:{ agility:160 } },
      { id:'smelt_64',        skill:'smelting',   title:'Переплавить 64 предм.',progressField:'smelt_made',    goal:64,   rewardXP:{ smelting:120 } },
      { id:'craft_10',        skill:'crafting',   title:'Скрафтить 10 рецептов',progressField:'craft_count',   goal:10,   rewardXP:{ crafting:120 } },
      { id:'combat_10',       skill:'combat',     title:'Выиграть 10 боёв',     progressField:'combat_win',    goal:10,   rewardXP:{ combat:160 } },
      { id:'explore_1000',    skill:'explore',    title:'Исследовать 1000м',    progressField:'explore_dist',  goal:1000, rewardXP:{ explore:160 } },
    ]
  },

  // Ачивки (условия и награды) — примеры
  achievements: {
    'first_blood': { title:'Первый бой',     when:ctx=> ctx?.combat?.wins>=1,       reward:{ combat:50 } },
    'iron_worker': { title:'Железный труд',  when:ctx=> ctx?.mining?.iron>=20,      reward:{ mining:80 } },
    'builder_1k':  { title:'Кирпич к кирпичу',when:ctx=> (ctx?.building?.placed||0)>=1000, reward:{ building:200 } },
    'speedster':   { title:'Быстрые ноги',   when:ctx=> (ctx?.agility?.travel||0)>=5000,   reward:{ agility:200 } },
    'jack_of_all': { title:'Мастер на всё',  when:ctx=> (ctx?._meta?.skillsAtLeast10||false), reward:{ utility:250 } },
  }
};

/* ────────────────────────────────────────────────────────────────────────────
 * Состояние
 * ─────────────────────────────────────────────────────────────────────────── */
const _st = {
  opt: deepClone(defaults),
  bot: null,
  emitter: new EventEmitter(),

  meta: { version:3, createdAt: now(), lastSave:0, dailySeed:0 },

  // id -> { xp, level, lastAt, restXP, perks, history[] }
  skills: new Map(),

  // анти-фарм окна
  minuteXP: new Map(), // skill -> [{t,xp}]

  // бафы: id -> { kind:'xp'|'mod', skill?:string, mult:number, until?:ms }
  buffs: new Map(),

  // квесты: { active:[{id,title,goal,progress,skill,rewardXP}], expiresAt:ms }
  quests: { active:[], expiresAt:0 },

  // ачивки: id -> { unlocked:boolean, at?:ms }
  achievements: {},

  // агрегированная “телеметрия” для условий квестов/ачивок
  ctx: {
    combat:   { wins:0, fights:0, dmgTaken:0 },
    mining:   { total:0, iron:0, gold:0, diamond:0, other:0, blocks:0 },
    woodcutting:{ total:0, saplings:0, count:0 },
    building: { placed:0, miss:0 },
    crafting: { total:0, count:0 },
    smelting: { made:0 },
    explore:  { dist:0 },
    agility:  { travel:0, jumps:0, falls:0 },
    defense:  { blocked:0, avoided:0 },
    utility:  { tasks:0, success:0 },
    _meta:    { skillsAtLeast10:false }
  },

  // служебное
  inflight: new Map(),
  saveTimer: null,
  dirty: false,
  flushing: false,
  lastFlush: 0
};

function log(...a){ if (_st.opt.debug) console.log('[skillBrain]', ...a); }

/* ────────────────────────────────────────────────────────────────────────────
 * Кривая уровней и перки
 * ─────────────────────────────────────────────────────────────────────────── */
function totalXPForLevel(L){
  const { A,P,B,maxLevel } = _st.opt.curve;
  const lvl = clamp(Math.floor(L), 1, maxLevel);
  return Math.floor(A*Math.pow(lvl,P) + B*lvl);
}
function levelFromXP(xp){
  const { maxLevel } = _st.opt.curve;
  for (let L=1; L<=maxLevel; L++){
    if (xp < totalXPForLevel(L+1)) return L;
  }
  return maxLevel;
}
function perkPackForLevel(L){
  const out = {};
  for (const thr of Object.keys(_st.opt.perks).map(Number).sort((a,b)=>a-b)){
    if (L >= thr){
      const pack = _st.opt.perks[thr];
      for (const [skill, deltas] of Object.entries(pack)){
        out[skill] ||= {};
        for (const [k,v] of Object.entries(deltas)){
          out[skill][k] = (out[skill][k] || 0) + v;
        }
      }
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Загрузка/сохранение
 * ─────────────────────────────────────────────────────────────────────────── */
function filePath(){ return path.join(_st.opt.dataDir, _st.opt.fileName); }

async function atomicWriteJSON(p, obj){
  const data = JSON.stringify(obj, null, 2);
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, data, 'utf8').catch(()=> fs.writeFileSync(tmp, data));
  await fsp.rename(tmp, p).catch(()=> fs.renameSync(tmp, p));
}

async function saveNow(){
  const obj = {
    meta: { ..._st.meta, lastSave: now() },
    skills: Object.fromEntries(_st.skills.entries()),
    buffs:  Object.fromEntries(_st.buffs.entries()),
    quests: _st.quests,
    achievements: _st.achievements,
    ctx: _st.ctx
  };
  await atomicWriteJSON(filePath(), obj);
  _st.dirty = false;
  _st.lastFlush = now();
  _st.emitter.emit('save', deepClone(obj));
}
async function flush(){
  if (_st.flushing) return;
  if (now() - _st.lastFlush < _st.opt.minFlushMs) return;
  _st.flushing = true;
  try { await saveNow(); } finally { _st.flushing = false; }
}
function scheduleAutosave(){
  if (_st.saveTimer) clearInterval(_st.saveTimer);
  _st.saveTimer = setInterval(()=>{ if (_st.dirty) flush().catch(e=>log('flush err',e)); }, _st.opt.autosaveMs);
}

async function load(options={}){
  _st.opt = { ...deepClone(defaults), ...(options||{}) };
  ensureDir(_st.opt.dataDir);
  const fp = filePath();
  try {
    const raw  = await fsp.readFile(fp, 'utf8');
    const json = JSON.parse(raw);

    _st.meta = json.meta || _st.meta;

    _st.skills.clear();
    const js = json.skills || {};
    for (const id of SKILL_LIST){
      const s = js[id] || {};
      _st.skills.set(id, {
        xp: Math.max(0, Number(s.xp||0)),
        level: clamp(Number(s.level||1), 1, _st.opt.curve.maxLevel),
        lastAt: Number(s.lastAt||0),
        restXP: Math.max(0, Number(s.restXP||0)),
        perks: s.perks || {},
        history: Array.isArray(s.history) ? s.history.slice(-60) : []
      });
    }

    // Бафы/квесты/ачивки/контекст
    _st.buffs = new Map(Object.entries(json.buffs||{}));
    _st.quests = json.quests || { active:[], expiresAt:0 };
    _st.achievements = json.achievements || {};
    _st.ctx = { ..._st.ctx, ...(json.ctx||{}) };

    log('loaded from', fp);
  } catch {
    // первый запуск
    _st.skills.clear();
    for (const id of SKILL_LIST){
      _st.skills.set(id, { xp:0, level:1, lastAt:0, restXP:0, perks:{}, history:[] });
    }
    // дефолтные бафы (если заданы)
    for (const [k,v] of Object.entries(_st.opt.defaultBuffs||{})){
      _st.buffs.set(k, v);
    }
    await saveNow();
  }
  scheduleAutosave();

  // Перегенерация дейликов (по желанию)
  if (_st.opt.quests?.rerollOnLoad) rollDailyQuestsIfNeeded();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Службы: Rested, анти-фарм, бафы
 * ─────────────────────────────────────────────────────────────────────────── */
function restTick(skill){
  if (!_st.opt.rest.enable) return;
  const rec = _st.skills.get(skill); if (!rec) return;
  const t = now();
  const idleMs = t - (rec.lastAt || 0);
  if (idleMs >= _st.opt.rest.rechargeMs){
    const inc = Math.floor(_st.opt.rest.threshold / 2);
    rec.restXP = Math.min(_st.opt.rest.threshold, (rec.restXP||0) + inc);
    rec.lastAt = t;
    _st.dirty = true;
  }
}
function antifarmAdmit(skill, baseXP){
  const bucketMs = _st.opt.antifarm.bucketMs;
  const cap = _st.opt.antifarm.caps[skill] || 99999;
  let arr = _st.minuteXP.get(skill);
  if (!arr){ arr=[]; _st.minuteXP.set(skill, arr); }

  const t = now();
  while (arr.length && (t - arr[0].t) > bucketMs) arr.shift();

  const sum = arr.reduce((s,x)=> s + x.xp, 0);
  if (sum >= cap) return 0;

  const room = cap - sum;
  const admit = Math.min(Math.max(0, Math.floor(baseXP)), room);
  if (admit > 0) arr.push({ t, xp: admit });
  return admit;
}

// Бафы
function _isBuffActive(b){ return !b?.until || b.until > now(); }
function _purgeBuffs(){
  for (const [id,b] of _st.buffs){
    if (!_isBuffActive(b)) _st.buffs.delete(id);
  }
}
function addBuff(id, buff){ // { kind:'xp'|'mod', skill?, mult, durationMs? }
  const until = buff.durationMs ? now()+buff.durationMs : buff.until;
  const entry = { kind:buff.kind, skill:buff.skill||null, mult:Number(buff.mult||1), until:until||null };
  _st.buffs.set(id, entry);
  _st.dirty = true;
  return entry;
}
function removeBuff(id){ const ok = _st.buffs.delete(id); _st.dirty = _st.dirty || ok; return ok; }
function listBuffs(){ _purgeBuffs(); return Object.fromEntries(_st.buffs.entries()); }

function _applyXPBuffs(skill, xp){
  _purgeBuffs();
  let mult = 1.0;
  for (const b of _st.buffs.values()){
    if (b.kind === 'xp' && (!b.skill || b.skill===skill)) mult *= b.mult;
  }
  return Math.max(0, Math.floor(xp * mult));
}

/* ────────────────────────────────────────────────────────────────────────────
 * XP/уровни/перки/ивенты
 * ─────────────────────────────────────────────────────────────────────────── */
function ensureSkill(id){
  if (!_st.skills.has(id)){
    _st.skills.set(id, { xp:0, level:1, lastAt:0, restXP:0, perks:{}, history:[] });
  }
  return _st.skills.get(id);
}

/**
 * addSkillXP(skillId, baseXP, ctx?) → { addedXP, effectiveXP, oldLevel, newLevel, leveledUp, grants }
 */
function addSkillXP(id, baseXP, ctx={}){
  if (!SKILL_LIST.includes(id)) return { addedXP:0, effectiveXP:0, oldLevel:null, newLevel:null, leveledUp:false, grants:null };
  const rec = ensureSkill(id);

  // Rested пополнение
  restTick(id);

  // Анти-фарм
  let x = antifarmAdmit(id, Math.max(0, Math.floor(baseXP)));
  if (x <= 0) return { addedXP:0, effectiveXP:0, oldLevel:rec.level, newLevel:rec.level, leveledUp:false, grants:null };

  // Бафы XP (после анти-фарма, до Rested)
  x = _applyXPBuffs(id, x);

  // Rested бонус (+% и сжигание restXP)
  let eff = x;
  if (_st.opt.rest.enable && rec.restXP > 0){
    const canBoost = Math.min(rec.restXP, x);
    const bonus = Math.floor(canBoost * _st.opt.rest.bonus);
    eff += bonus;
    rec.restXP = Math.max(0, rec.restXP - canBoost);
  }

  // XP → Level
  const oldXP = rec.xp;
  const oldLevel = rec.level;
  rec.xp = Math.min(totalXPForLevel(_st.opt.curve.maxLevel), oldXP + eff);
  rec.level = levelFromXP(rec.xp);
  rec.lastAt = now();

  // История
  try {
    rec.history.push({ t: rec.lastAt, got: eff, base: x, ctx: Object.keys(ctx||{}).length ? ctx : undefined });
    if (rec.history.length > 60) rec.history.shift();
  } catch {}

  // Перки (на уровне логики они “виртуальные”, расчёт в getAllModifiers)
  const leveledUp = rec.level > oldLevel;
  let grants = null;
  if (leveledUp){
    grants = perkPackForLevel(rec.level);
    _st.emitter.emit('levelUp', { skill:id, oldLevel, newLevel:rec.level, grants:deepClone(grants) });
  }

  _st.dirty = true;
  _st.emitter.emit('xp', { skill:id, added: x, effective: eff, level: rec.level });

  // Обновить агрегаты для ачивок/квестов
  try { _updateAggregatesAfterXP(id, eff, ctx); } catch (e){ _st.emitter.emit('error', { where:'_updateAggregatesAfterXP', error:String(e) }); }

  return { addedXP: x, effectiveXP: eff, oldLevel, newLevel: rec.level, leveledUp, grants };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Модификаторы (для боёв/крафта и т.д.) + синергии + бафы модификаторов
 * ─────────────────────────────────────────────────────────────────────────── */
function _skillModsBase(){
  return {
    combat:     { damageMult:1.0, attackSpeedMult:1.0, blockMult:1.0, drFlat:0.0 },
    mining:     { digSpeedMult:1.0, durabilitySave:0.0, veinBonus:0.0 },
    woodcutting:{ chopSpeedMult:1.0, saplingRate:0.0 },
    building:   { placeAccuracy:1.0, misRefund:0.0, reachHint:0.0 },
    crafting:   { batchYield:0.0, toolQuality:0.0 },
    smelting:   { fuelEff:0.0, smeltSpeed:0.0 },
    explore:    { pathfinding:1.0, mapSense:0.0 },
    agility:    { moveSpeed:1.0, stamina:0.0, parkour:0.0 },
    defense:    { drFlat:0.0, shieldMult:1.0 },
    utility:    { successRate:1.0 }
  };
}
function getAllModifiers(){
  const S = _skillModsBase();
  const sc = _st.opt.scales;

  // Линейка от уровня
  for (const [id, rec] of _st.skills){
    const L = rec.level || 1;
    switch (id){
      case 'combat':
        S.combat.damageMult      += sc.combat.damage * L;
        S.combat.attackSpeedMult += sc.combat.attackSpeed * L;
        S.combat.blockMult       += sc.combat.block * L;
        break;
      case 'mining':
        S.mining.digSpeedMult    += sc.mining.digSpeed * L;
        S.mining.durabilitySave  += sc.mining.durabilitySave * L;
        S.mining.veinBonus       += sc.mining.veinBonus * L;
        break;
      case 'woodcutting':
        S.woodcutting.chopSpeedMult += sc.woodcutting.chopSpeed * L;
        S.woodcutting.saplingRate   += sc.woodcutting.saplingRate * L;
        break;
      case 'building':
        S.building.placeAccuracy += sc.building.placeAccuracy * L;
        S.building.misRefund     += sc.building.misRefund * L;
        S.building.reachHint     += sc.building.reachHint * L;
        break;
      case 'crafting':
        S.crafting.batchYield    += sc.crafting.batchYield * L;
        S.crafting.toolQuality   += sc.crafting.toolQuality * L;
        break;
      case 'smelting':
        S.smelting.fuelEff       += sc.smelting.fuelEff * L;
        S.smelting.smeltSpeed    += sc.smelting.speed * L;
        break;
      case 'explore':
        S.explore.pathfinding    += sc.explore.pathfinding * L;
        S.explore.mapSense       += sc.explore.mapSense * L;
        break;
      case 'agility':
        S.agility.moveSpeed      += sc.agility.moveSpeed * L;
        S.agility.stamina        += sc.agility.stamina * L;
        S.agility.parkour        += sc.agility.parkour * L;
        break;
      case 'defense':
        S.defense.drFlat         += sc.defense.drFlat * L;
        S.defense.shieldMult     += sc.defense.shield * L;
        break;
      case 'utility':
        S.utility.successRate    += sc.utility.successRate * L;
        break;
    }
  }

  // Перки (по уровню каждого навыка)
  for (const [_, rec] of _st.skills){
    const P = perkPackForLevel(rec.level || 1);
    for (const [sid, pack] of Object.entries(P)){
      switch (sid){
        case 'combat':
          if (pack.damage)      S.combat.damageMult      += pack.damage;
          if (pack.attackSpeed) S.combat.attackSpeedMult += pack.attackSpeed;
          break;
        case 'mining':
          if (pack.digSpeed)       S.mining.digSpeedMult   += pack.digSpeed;
          if (pack.durabilitySave) S.mining.durabilitySave += pack.durabilitySave;
          break;
        case 'woodcutting':
          if (pack.chopSpeed) S.woodcutting.chopSpeedMult += pack.chopSpeed;
          break;
        case 'building':
          if (pack.placeAccuracy) S.building.placeAccuracy += pack.placeAccuracy;
          if (pack.misRefund)     S.building.misRefund     += pack.misRefund;
          break;
        case 'crafting':
          if (pack.batchYield)    S.crafting.batchYield    += pack.batchYield;
          break;
        case 'smelting':
          if (pack.fuelEff)       S.smelting.fuelEff       += pack.fuelEff;
          break;
        case 'explore':
          if (pack.pathfinding)   S.explore.pathfinding    += pack.pathfinding;
          break;
        case 'agility':
          if (pack.moveSpeed)     S.agility.moveSpeed      += pack.moveSpeed;
          break;
        case 'defense':
          if (pack.drFlat)        S.defense.drFlat         += pack.drFlat;
          break;
      }
    }
  }

  // Синергии
  S.combat.blockMult       += clamp((_st.skills.get('defense')?.level||1)*0.002, 0, 0.25);
  S.explore.pathfinding    += clamp((_st.skills.get('agility')?.level||1)*0.002, 0, 0.20);
  S.mining.digSpeedMult    += clamp((_st.skills.get('woodcutting')?.level||1)*0.0015, 0, 0.15);

  // Бафы модификаторов (kind:'mod')
  for (const b of _st.buffs.values()){
    if (!_isBuffActive(b) || b.kind !== 'mod') continue;
    const tgt = b.skill ? S[b.skill] : null;
    if (tgt){ for (const k of Object.keys(tgt)){ if (typeof tgt[k]==='number') tgt[k] *= b.mult; } }
    else {
      for (const o of Object.values(S)){
        for (const k of Object.keys(o)){ if (typeof o[k]==='number') o[k] *= b.mult; }
      }
    }
  }

  // Кепы
  S.combat.damageMult      = clamp(S.combat.damageMult, 1.0, 2.0);
  S.combat.attackSpeedMult = clamp(S.combat.attackSpeedMult, 1.0, 1.7);
  S.combat.blockMult       = clamp(S.combat.blockMult, 1.0, 1.6);
  S.defense.drFlat         = clamp(S.defense.drFlat, 0.0, 0.50);
  S.defense.shieldMult     = clamp(S.defense.shieldMult, 1.0, 1.7);

  S.mining.digSpeedMult    = clamp(S.mining.digSpeedMult, 1.0, 2.0);
  S.mining.durabilitySave  = clamp(S.mining.durabilitySave, 0.0, 0.50);
  S.mining.veinBonus       = clamp(S.mining.veinBonus, 0.0, 0.35);

  S.woodcutting.chopSpeedMult = clamp(S.woodcutting.chopSpeedMult, 1.0, 2.0);
  S.woodcutting.saplingRate   = clamp(S.woodcutting.saplingRate, 0.0, 0.35);

  S.building.placeAccuracy = clamp(S.building.placeAccuracy, 1.0, 1.8);
  S.building.misRefund     = clamp(S.building.misRefund, 0.0, 0.35);

  S.crafting.batchYield    = clamp(S.crafting.batchYield, 0.0, 0.35);
  S.crafting.toolQuality   = clamp(S.crafting.toolQuality, 0.0, 0.25);

  S.smelting.fuelEff       = clamp(S.smelting.fuelEff, 0.0, 0.40);
  S.smelting.smeltSpeed    = clamp(S.smelting.smeltSpeed, 0.0, 0.30);

  S.explore.pathfinding    = clamp(S.explore.pathfinding, 1.0, 1.6);

  S.agility.moveSpeed      = clamp(S.agility.moveSpeed, 1.0, 1.4);
  S.agility.stamina        = clamp(S.agility.stamina, 0.0, 0.35);
  S.agility.parkour        = clamp(S.agility.parkour, 0.0, 0.30);

  S.utility.successRate    = clamp(S.utility.successRate, 1.0, 1.5);

  return S;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Доступ к данным + ранги
 * ─────────────────────────────────────────────────────────────────────────── */
function getSkill(id){
  const rec = ensureSkill(id);
  const needNext = totalXPForLevel(rec.level+1) - rec.xp;
  return {
    id, xp: rec.xp, level: rec.level, restXP: rec.restXP || 0,
    next: Math.max(0, needNext), lastAt: rec.lastAt || 0
  };
}
function getAllSkills(){
  const out = {};
  for (const id of SKILL_LIST) out[id] = getSkill(id);
  return out;
}
function getRank(){
  const sum = Array.from(_st.skills.values()).reduce((s,r)=> s+(r.level||1), 0);
  let name = 'Unranked';
  for (const r of RANKS){ if (sum >= r.minSum) name = r.name; }
  return { name, sum };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Публичные записи событий (XP)
 * ─────────────────────────────────────────────────────────────────────────── */
function recordCombat({ win=true, timeMs=2000, damageTaken=0, mobName='mob' }={}){
  const base = Math.max(2, Math.round( 14 * (win?1.0:0.25) * (2000/(timeMs+1)) * (1.0/(1.0+damageTaken*0.15)) ));
  const result = addSkillXP('combat', base, { mobName, timeMs, dmg:damageTaken, win });
  try {
    _st.ctx.combat.fights++; if (win) _st.ctx.combat.wins++;
    _checkMilestones();
    EXP?.domains?.combat?.endFight?.('skillBrain-combat', { win, timeMs, damageTaken });
  } catch {}
  return result;
}
function recordMining({ block='stone', count=1 }={}){
  const rare = /diamond|emerald|ancient_debris|deepslate_diamond/.test(block) ? 6 :
               /gold|lapis|redstone/.test(block) ? 4 :
               /iron|copper/.test(block) ? 3 : 1;
  const base = Math.max(1, Math.round(count * (4 * rare)));
  const res = addSkillXP('mining', base, { block, count });
  _st.ctx.mining.blocks += count;
  if (/iron/.test(block))   _st.ctx.mining.iron   += count;
  else if (/gold/.test(block)) _st.ctx.mining.gold+= count;
  else if (/diamond/.test(block)) _st.ctx.mining.diamond += count;
  else _st.ctx.mining.other += count;
  return res;
}
function recordWoodcut({ count=1 }={}){
  const base = Math.max(1, Math.round(count * 5));
  const res = addSkillXP('woodcutting', base, { count });
  _st.ctx.woodcutting.count += count;
  return res;
}
function recordBuilding({ placed=1, mis=0 }={}){
  const acc = 1.0 / (1.0 + mis*0.15);
  const base = Math.max(1, Math.round(placed * 3.5 * acc));
  const res = addSkillXP('building', base, { placed, mis });
  _st.ctx.building.placed += placed;
  _st.ctx.building.miss   += mis;
  return res;
}
function recordCraft({ recipeId='item', count=1 }={}){
  const hard = /\b(netherite|diamond|anvil|enchant|beacon)\b/.test(recipeId) ? 10 :
               /\b(iron|gold|redstone|hopper|piston|observer)\b/.test(recipeId) ? 6 : 3;
  const base = Math.max(1, Math.round(count * (4 * hard)));
  const res = addSkillXP('crafting', base, { recipeId, count });
  _st.ctx.crafting.count += count;
  _st.ctx.crafting.total += base;
  return res;
}
function recordSmelting({ made=1, station='furnace' }={}){
  const mult = station === 'blast_furnace' ? 1.4 : (station === 'smoker' ? 1.3 : 1.0);
  const base = Math.max(1, Math.round(made * 4 * mult));
  const res = addSkillXP('smelting', base, { made, station });
  _st.ctx.smelting.made += made;
  return res;
}
function recordExplore({ biome='unknown', distance=50 }={}){
  const bias = /nether|end/.test(biome) ? 1.35 : (/desert|badlands/.test(biome) ? 1.15 : 1.0);
  const base = Math.max(1, Math.round((distance/100) * 8 * bias));
  const res = addSkillXP('explore', base, { biome, distance });
  _st.ctx.explore.dist += distance;
  return res;
}
function recordAgility({ traveled=30, jumps=0, falls=0 }={}){
  const base = Math.max(1, Math.round( (traveled/100)*6 + jumps*0.3 - falls*0.5 ));
  const res = addSkillXP('agility', base, { traveled, jumps, falls });
  _st.ctx.agility.travel += traveled;
  _st.ctx.agility.jumps  += jumps;
  _st.ctx.agility.falls  += falls;
  return res;
}
function recordDefense({ blocked=0, damageAvoided=0 }={}){
  const base = Math.max(1, Math.round( blocked*0.8 + damageAvoided*2.0 ));
  const res = addSkillXP('defense', base, { blocked, damageAvoided });
  _st.ctx.defense.blocked += blocked;
  _st.ctx.defense.avoided += damageAvoided;
  return res;
}
function recordUtility({ tasks=1, success=1 }={}){
  const base = Math.max(1, Math.round( tasks * (1.5 + success*0.5) ));
  const res = addSkillXP('utility', base, { tasks, success });
  _st.ctx.utility.tasks  += tasks;
  _st.ctx.utility.success+= success;
  return res;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Квесты/Ачивки
 * ─────────────────────────────────────────────────────────────────────────── */
function _todayKey(){
  const d = new Date();
  d.setHours(0,0,0,0);
  return d.getTime();
}
function rollDailyQuestsIfNeeded(){
  const tk = _todayKey();
  if (_st.quests.expiresAt && _st.quests.expiresAt > now() && _st.quests.active.length) return;
  const pool = deepClone(_st.opt.quests.pool || []);
  const out = [];
  while (out.length < (_st.opt.quests.dailyCount||3) && pool.length){
    const i = Math.floor(Math.random()*pool.length);
    const q = pool.splice(i,1)[0];
    out.push({ id:q.id, title:q.title, goal:q.goal, progress:0, skill:q.skill, rewardXP:q.rewardXP, progressField:q.progressField });
  }
  _st.quests.active = out;
  _st.quests.expiresAt = tk + 24*60*60*1000 - 1; // конец суток
  _st.dirty = true;
  return out;
}
function _updateAggregatesAfterXP(skill, eff, ctx){
  // обновляем флажок “все навыки >=10”
  _st.ctx._meta.skillsAtLeast10 = SKILL_LIST.every(s=> (_st.skills.get(s)?.level||1) >= 10);
  // прогресс квестов на основе контекста
  const active = _st.quests.active||[];
  for (const q of active){
    if (!q.progressField || !_st.quests.expiresAt || _st.quests.expiresAt < now()) continue;
    const inc = _progressDeltaFromCtx(q.progressField, ctx);
    if (inc>0 && q.progress < q.goal){
      q.progress = Math.min(q.goal, q.progress + inc);
      if (q.progress >= q.goal){
        // награда
        _grantQuestReward(q);
        _st.emitter.emit('questComplete', deepClone(q));
      }
      _st.dirty = true;
    }
  }
  // проверка ачивок
  _checkAchievements();
}
function _progressDeltaFromCtx(field, ctx){
  // соответствия: что из ctx писать в прогресс
  switch (field){
    case 'mining_blocks': return Math.max(0, ctx?.count||ctx?.blocks||0);
    case 'wood_count':    return Math.max(0, ctx?.count||0);
    case 'placed_blocks': return Math.max(0, ctx?.placed||0);
    case 'ag_travel':     return Math.max(0, ctx?.traveled||0);
    case 'smelt_made':    return Math.max(0, ctx?.made||0);
    case 'craft_count':   return Math.max(0, ctx?.count||0);
    case 'combat_win':    return ctx?.win ? 1 : 0;
    case 'explore_dist':  return Math.max(0, ctx?.distance||0);
  }
  return 0;
}
function _grantQuestReward(q){
  const rewards = q.rewardXP||{};
  for (const [skill, xp] of Object.entries(rewards)){
    addSkillXP(skill, xp, { rewardFrom:`quest:${q.id}` });
  }
}
function getQuests(){ rollDailyQuestsIfNeeded(); return deepClone(_st.quests); }
function startQuest(id){ rollDailyQuestsIfNeeded(); return _st.quests.active.find(q=>q.id===id)||null; } // Placeholder для совместимости

function _checkAchievements(){
  const defs = _st.opt.achievements||{};
  for (const [id, def] of Object.entries(defs)){
    const have = _st.achievements[id]?.unlocked;
    if (have) continue;
    let ok = false;
    try { ok = !!def.when?.(_st.ctx); } catch {}
    if (ok){
      _st.achievements[id] = { unlocked:true, at: now(), title:def.title };
      const reward = def.reward||{};
      for (const [skill, xp] of Object.entries(reward)){
        addSkillXP(skill, xp, { rewardFrom:`ach:${id}` });
      }
      _st.emitter.emit('achievement', { id, title:def.title, reward:deepClone(reward) });
      _st.dirty = true;
    }
  }
}
function grantAchievement(id){
  const defs = _st.opt.achievements||{};
  const def = defs[id]; if (!def) return false;
  if (_st.achievements[id]?.unlocked) return false;
  _st.achievements[id] = { unlocked:true, at: now(), title:def.title };
  const reward = def.reward||{};
  for (const [skill, xp] of Object.entries(reward)){
    addSkillXP(skill, xp, { rewardFrom:`ach:${id}` });
  }
  _st.emitter.emit('achievement', { id, title:def.title, reward:deepClone(reward) });
  _st.dirty = true;
  return true;
}
function getAchievements(){ return deepClone(_st.achievements); }

/* ────────────────────────────────────────────────────────────────────────────
 * Интеграция с experience.cjs (опционально)
 * ─────────────────────────────────────────────────────────────────────────── */
function adviseWeights(domain, target, baseWeights, ctx={}){
  const adj = EXP?.adjustWeights ? EXP.adjustWeights(domain, target, baseWeights, ctx) :
              EXP?.domains?.[domain]?.advise ? EXP.domains[domain].advise(target, baseWeights, ctx) :
              baseWeights;
  const L = _st.skills.get(domain==='combat' ? 'combat' :
                           domain==='build'   ? 'building' :
                           domain==='craft'   ? 'crafting' :
                           domain==='mining'  ? 'mining'   : domain)?.level || 1;
  const W = { ...adj };
  for (const k of Object.keys(W)){
    if (/attack|rush|speed|push|shot|place|dig/i.test(k)) {
      W[k] *= (1.0 + Math.min(0.20, L * 0.0015));
    }
  }
  return normalizeWeights(W);
}
function normalizeWeights(obj){
  let s = 0; for (const v of Object.values(obj||{})) s += Math.max(0, Number(v)||0);
  if (s <= 0) return { ...obj };
  const out = {};
  for (const [k,v] of Object.entries(obj||{})) out[k] = (Math.max(0, Number(v)||0))/s;
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Снапшоты и диффы
 * ─────────────────────────────────────────────────────────────────────────── */
async function exportSnapshot(fp=null){
  const file = fp || filePath().replace(/\.json$/, `.skills-snapshot-${Date.now()}.json`);
  const obj = {
    meta:_st.meta,
    skills:Object.fromEntries(_st.skills.entries()),
    buffs:Object.fromEntries(_st.buffs.entries()),
    quests:_st.quests,
    achievements:_st.achievements,
    ctx:_st.ctx
  };
  await atomicWriteJSON(file, obj);
  return file;
}
async function importSnapshot(fp){
  const raw = await fsp.readFile(fp, 'utf8');
  const json = JSON.parse(raw);
  if (!json || !json.skills) throw new Error('bad snapshot');
  _st.skills = new Map(Object.entries(json.skills));
  _st.buffs = new Map(Object.entries(json.buffs||{}));
  _st.quests = json.quests || { active:[], expiresAt:0 };
  _st.achievements = json.achievements || {};
  _st.ctx = { ..._st.ctx, ...(json.ctx||{}) };
  _st.meta = json.meta || _st.meta;
  _st.dirty = true; await flush();
}
function diffSnapshot(a, b){
  // a/b — объекты как из snapshot; вернуть краткий дифф уровней/XP
  const out = {};
  for (const id of SKILL_LIST){
    const A = a.skills?.[id]||{}, B = b.skills?.[id]||{};
    out[id] = { level:(B.level||0)-(A.level||0), xp:(B.xp||0)-(A.xp||0) };
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Инициализация/attach/detach
 * ─────────────────────────────────────────────────────────────────────────── */
async function init(botOrOptions, maybeOptions){
  let bot=null, opt = maybeOptions || botOrOptions || {};
  if (botOrOptions && botOrOptions.on && botOrOptions.entity) { bot = botOrOptions; opt = maybeOptions || {}; }
  await load(opt);
  if (bot) attachToBot(bot);
  return api;
}
function attachToBot(bot){
  _st.bot = bot;
  const quit = async ()=>{ try { if (_st.saveTimer) clearInterval(_st.saveTimer); await flush(); } catch{} };
  bot.once('end', quit);
  bot.once('kicked', quit);
}
function detach(){
  if (_st.saveTimer) clearInterval(_st.saveTimer);
  _st.saveTimer = null;
  _st.bot = null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Самотест (по желанию)
 * ─────────────────────────────────────────────────────────────────────────── */
async function selfTest(){
  const snapA = {
    skills: Object.fromEntries(Array.from(_st.skills.entries()).map(([k,v])=>[k, { level:v.level, xp:v.xp }]))
  };
  recordMining({ block:'iron_ore', count:10 });
  recordWoodcut({ count:20 });
  recordCombat({ win:true, timeMs:1500, damageTaken:1, mobName:'zombie' });
  addBuff('double-mining-5min', { kind:'xp', skill:'mining', mult:1.5, durationMs:5*60*1000 });
  recordMining({ block:'iron_ore', count:10 });
  rollDailyQuestsIfNeeded();
  const qs = getQuests();
  const snapB = {
    skills: Object.fromEntries(Array.from(_st.skills.entries()).map(([k,v])=>[k, { level:v.level, xp:v.xp }]))
  };
  return { rank:getRank(), diff: diffSnapshot(snapA, snapB), quests:qs, buffs:listBuffs() };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Экспорт API
 * ─────────────────────────────────────────────────────────────────────────── */
const api = {
  // базовое
  init, attachToBot, detach, flush,

  // данные
  getSkill, getAllSkills, getAllModifiers, getRank,

  // начисления
  addSkillXP,
  recordCombat, recordMining, recordWoodcut, recordBuilding,
  recordCraft, recordSmelting, recordExplore, recordAgility,
  recordDefense, recordUtility,

  // бафы
  addBuff, removeBuff, listBuffs,

  // квесты/ачивки
  rollDailyQuestsIfNeeded, getQuests, startQuest,
  grantAchievement, getAchievements,

  // интеграция с EXP
  adviseWeights,

  // снапшоты/диффы/самотест
  exportSnapshot, importSnapshot, diffSnapshot, selfTest,

  // события
  on: (...a)=> _st.emitter.on(...a),
  off:(...a)=> _st.emitter.off(...a)
};

module.exports = api;
