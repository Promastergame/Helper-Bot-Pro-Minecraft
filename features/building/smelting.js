'use strict';
/**
 * features/building/smelting.js — v11 HyperIQ
 * 🔥 Переплавка, готовка и авто-уголь с «мозгом»:
 *   • Параллельно до 3 станций: furnace / smoker / blast_furnace (автоплейс)
 *   • ИИ-расписание батчей: группировка по предметам, баланс по прогрессу
 *   • Умная политика топлива: «минимальный перелив» (1–3 юнита), фильтры ценностей
 *   • Авто-уголь (charcoal): превращаем логи в уголь, не «съедая» последние доски
 *   • Безопасность: мягкие ретраи UI, пауза при угрозах, уважение AbortSignal
 *   • Отчёты: детализация выхода по именам, XP-хуки (withCraftXP) + addExp
 * CommonJS
 */

const { Vec3 } = require('vec3');
let addExp = ()=>{}; try { ({ addExp } = require('../leveling.js')); } catch {}

/* ───────────────────── Optional XP / Quantum ───────────────────── */
let withCraftXP = async (_b,_tag,_ctx,fn,fin)=> {
  const t=Date.now();
  try { const r=await fn(); await fin?.(r,null,{timeMs:Date.now()-t}); return r; }
  catch(e){ await fin?.(null,e,{timeMs:Date.now()-t}); throw e; }
};
try { ({ withCraftXP } = require('../ai/xpHelpers.cjs')); } catch {}
let Q; try { Q = require('../ai/quantum'); } catch { Q = null; }

/* ───────────────────── Timing helpers ───────────────────── */
const sleep  = (ms)=> new Promise(r=> setTimeout(r, ms));
const qrand  = ()=> (Q?.quantumRandom?.() ?? Math.random());
const jitter = (a=70,b=170)=> Math.floor(a + qrand()*(b-a));
async function humanPause(ms){
  const T = Q?.scheduleTemperature ? Q.scheduleTemperature(Date.now()%1e9, { T0:1.0, k:0.003, floor:0.85 }) : 1;
  const span = Math.max(0, Math.floor(ms*T + (qrand()-0.5)*0.4*ms));
  if (Q?.humanDelay) return Q.humanDelay(span);
  return sleep(span);
}

/* ───────────────────── Catalogs / Policies ───────────────────── */
// сырьё к выплавке
const ORES_RAW = new Set([
  'raw_iron','raw_copper','raw_gold',
  'iron_ore','deepslate_iron_ore',
  'gold_ore','deepslate_gold_ore',
  'copper_ore','deepslate_copper_ore',
  'ancient_debris'
]);
const STONE_LIKE = new Set(['cobblestone','sand','clay','clay_ball','netherrack','red_sand','terracotta']);

// еда (сырая)
const RAW_FOODS = new Set([
  'beef','porkchop','mutton','chicken','rabbit',
  'cod','salmon','potato','kelp'
]);

// готовая еда (для авто-повара)
const READY_FOOD_RE = /^(cooked_|baked_|bread|pumpkin_pie|golden_carrot|stew|soup|dried_kelp)/;

// типы станций
const STATION_TYPES = ['smoker','blast_furnace','furnace'];

// ёмкость топлива: сколько предметов переплавит 1 юнит
const FUEL_CAPACITY = Object.freeze({
  lava_bucket: 100,
  blaze_rod : 12,
  coal      : 8,
  charcoal  : 8,

  // древесина/производные
  oak_log:1, spruce_log:1, birch_log:1, jungle_log:1, acacia_log:1, dark_oak_log:1,
  mangrove_log:1, cherry_log:1, bamboo_block:1, pale_oak_log:1,
  oak_planks:1, spruce_planks:1, birch_planks:1, jungle_planks:1, acacia_planks:1,
  dark_oak_planks:1, mangrove_planks:1, cherry_planks:1, bamboo_planks:1, pale_oak_planks:1,
  stick:0.5,

  // деревянные инструменты/деревяшки
  wooden_pickaxe:1, wooden_axe:1, wooden_sword:1, wooden_shovel:1, wooden_hoe:1,
  oak_door:1, spruce_door:1, birch_door:1, jungle_door:1, acacia_door:1, dark_oak_door:1,
  mangrove_door:1, cherry_door:1, bamboo_door:1, pale_oak_door:1,
  oak_fence:1, spruce_fence:1, birch_fence:1, jungle_fence:1, acacia_fence:1, dark_oak_fence:1,
  mangrove_fence:1, cherry_fence:1, bamboo_fence:1, pale_oak_fence:1
});

// базовый порядок топлива
const FUELS_ORDER_BASE = [
  'lava_bucket','blaze_rod','coal','charcoal',
  'oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log','bamboo_block','pale_oak_log',
  'oak_planks','spruce_planks','birch_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks','bamboo_planks','pale_oak_planks',
  'stick',
  'wooden_pickaxe','wooden_axe','wooden_sword','wooden_shovel','wooden_hoe',
  'oak_door','spruce_door','birch_door','jungle_door','acacia_door','dark_oak_door','mangrove_door','cherry_door','bamboo_door','pale_oak_door',
  'oak_fence','spruce_fence','birch_fence','jungle_fence','acacia_fence','dark_oak_fence','mangrove_fence','cherry_fence','bamboo_fence','pale_oak_fence'
];

// угрозы, чтобы «притормозить»
const HOSTILES = new Set([
  'zombie','drowned','husk','skeleton','stray','creeper','spider','cave_spider','witch',
  'enderman','slime','magma_cube','phantom','vex','evoker','vindicator','pillager',
  'ravager','piglin_brute','breeze','bogged','ghast','blaze','hoglin','zoglin','guardian'
]);

/* ───────────────────── Inventory / Env ───────────────────── */
function items(bot){ try { return bot.inventory.items(); } catch { return []; } }
function count(bot, name){ return items(bot).filter(i=>i.name===name).reduce((s,i)=>s+(i.count||0),0); }
function hasAny(bot, setOrRegex){
  const inv = items(bot);
  if (setOrRegex instanceof Set) return inv.some(i=> setOrRegex.has(i.name));
  if (setOrRegex instanceof RegExp) return inv.some(i=> setOrRegex.test(i.name));
  return false;
}
function sumCounts(arr){ return arr.reduce((s,it)=> s+(it?.count||0), 0); }
function stackifyByName(stacks){
  const m = new Map(); // name -> total
  for (const it of stacks){ m.set(it.name, (m.get(it.name)||0) + (it.count||0)); }
  return m;
}

function findNearbyBlock(bot, names, radius=6){
  try {
    const poses = bot.findBlocks({ matching:(b)=> b&&names.includes(b.name), maxDistance:radius, count:3 });
    if (!poses?.length) return null;
    poses.sort((a,b)=> bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
    return bot.blockAt(poses[0]);
  } catch { return null; }
}
function dangerNearby(bot, within=8){
  try {
    const me=bot.entity?.position; if (!me) return false;
    for (const e of Object.values(bot.entities||{})){
      if (!e||e.type!=='mob'||!e.position) continue;
      if (!HOSTILES.has(e.name)) continue;
      if (me.distanceTo(e.position) <= within) return true;
    }
  } catch {}
  return false;
}

async function tryPlaceAbove(bot, itemName){
  const it = items(bot).find(i=> i.name===itemName);
  if (!it) return false;
  const base = bot.blockAt(bot.entity.position.offset(0,-1,0));
  if (!base) return false;
  try {
    await bot.equip(it, 'hand');
    await bot.placeBlock(base, new Vec3(0,1,0));
    return true;
  } catch { return false; }
}

/* ───────────────────── Stations Pool ───────────────────── */
async function ensureStations(bot, type, { radius=6, want=1, allowCraft=true } = {}){
  const list = [];
  // 1) ищем готовые блоки
  try {
    const poses = bot.findBlocks({ matching:(b)=> b && (b.name===type || (type!=='furnace' && b.name==='furnace')), maxDistance:radius, count:want });
    for (const p of poses||[]) { list.push(bot.blockAt(p)); if (list.length>=want) break; }
  } catch {}

  // 2) автоплейс (если не хватило)
  while (list.length < want){
    const ok = await tryPlaceAbove(bot, type) || (type!=='furnace' && await tryPlaceAbove(bot, 'furnace'));
    if (!ok) break;
    const placed = findNearbyBlock(bot, [type,'furnace'], 4);
    if (placed) list.push(placed);
  }

  // 3) автокрафт обычной печи, если вообще пусто и есть камень
  if (!list.length && allowCraft && count(bot,'cobblestone')>=8){
    try {
      const { craftSimple } = require('../crafting/crafting.js');
      await craftSimple(bot,'furnace',1);
      if (await tryPlaceAbove(bot,'furnace')){
        const placed = findNearbyBlock(bot, ['furnace'], 5);
        if (placed) list.push(placed);
      }
    } catch {}
  }

  return list;
}

async function openUI(bot, block, { retries=2 } = {}){
  const name = block?.name || '';
  for (let a=0; a<=retries; a++){
    try {
      if (name==='smoker' && bot.openSmoker)              return await bot.openSmoker(block);
      if (name==='blast_furnace' && bot.openBlastFurnace) return await bot.openBlastFurnace(block);
      return await bot.openFurnace(block); // универсальный фолбэк
    } catch (e) {
      if (a===retries) {
        if (name!=='furnace') { try { return await bot.openFurnace(block); } catch { throw e; } }
        throw e;
      }
      await humanPause(120 + jitter());
    }
  }
}

/* ───────────────────── Fuel Policy ───────────────────── */
function buildFuelOrder(policy){
  // Базовый порядок можно переставить с учётом «бережливости»
  const ord = FUELS_ORDER_BASE.slice();
  if (policy?.preserveCoal) {
    // сдвигаем «coal» ниже, чтобы сначала тратить charcoal/древесину
    const i = ord.indexOf('coal');
    if (i>=0) { ord.splice(i,1); ord.push('coal'); }
  }
  if (policy?.avoidTools) {
    for (const n of [...ord]) if (n.startsWith('wooden_')) {
      const i = ord.indexOf(n); if (i>=0) ord.splice(i,1);
    }
  }
  if (policy?.avoidDoorsFences) {
    for (const n of [...ord]) if (n.endsWith('_door') || n.endsWith('_fence')) {
      const i = ord.indexOf(n); if (i>=0) ord.splice(i,1);
    }
  }
  return ord;
}

function listFuelUnits(bot, order){
  const inv = items(bot);
  const rank = new Map(order.map((n,i)=> [n,i]));
  const units = [];
  for (const it of inv){
    const cap = FUEL_CAPACITY[it.name];
    if (!cap) continue;
    const ord = rank.get(it.name);
    if (ord===undefined) continue;
    const c = it.count||1;
    for (let k=0;k<c;k++) units.push({ item:it, name:it.name, cap, ord });
  }
  // Приоритет: ёмкость ↓, затем порядок ↑
  units.sort((a,b)=> (b.cap-a.cap) || (a.ord-b.ord));
  return units;
}

// минимальный перелив под itemsLeft (1..3 юнита)
function planFuelBundle(itemsLeft, units){
  const N = Math.min(units.length, 30);
  let best = null;
  const consider = (idxs)=>{
    const sumCap = idxs.reduce((s,i)=> s+units[i].cap, 0);
    const deficit = itemsLeft - sumCap;
    const overshoot = sumCap>=itemsLeft ? (sumCap-itemsLeft) : (Math.abs(deficit)+1000); // штраф недобора
    const rec = { idxs, sumCap, overshoot };
    if (!best) { best=rec; return; }
    if (overshoot<best.overshoot) best=rec;
    else if (overshoot===best.overshoot){
      if (idxs.length<best.idxs.length) best=rec;
      else if (idxs.length===best.idxs.length && sumCap>best.sumCap) best=rec;
    }
  };
  for (let i=0;i<N;i++) consider([i]);
  for (let i=0;i<N;i++) for (let j=i+1;j<N;j++) consider([i,j]);
  for (let i=0;i<N;i++) for (let j=i+1;j<N;j++) for (let k=j+1;k<N;k++) consider([i,j,k]);
  return best ? best.idxs.map(i=>units[i]) : [];
}

async function takeEmptyFuelBucketIfAny(ui){
  try {
    const fu = ui.fuelItem?.();
    if (fu && fu.name==='bucket' && fu.count>0) {
      try { await ui.takeFuel(); } catch {}
    }
  } catch {}
}

async function topUpFuel(bot, ui, itemsRemainingTotal, policy){
  try {
    await takeEmptyFuelBucketIfAny(ui);
    if (ui.fuelItem?.()) return; // уже есть топливо/горит

    const order = buildFuelOrder(policy);
    const units = listFuelUnits(bot, order);
    if (!units.length) return;

    const bundle = planFuelBundle(Math.max(1, itemsRemainingTotal), units);
    if (!bundle.length) return;

    for (const u of bundle){
      if (ui.fuelItem?.()) break;
      try { await ui.putFuel(u.item); } catch {}
      await sleep(35);
      await takeEmptyFuelBucketIfAny(ui);
    }
  } catch {}
}

/* ───────────────────── Smelt helpers ───────────────────── */
function waitForSmelt(ui, { timeoutMs=20000, signal } = {}){
  return new Promise((resolve,reject)=>{
    const t0 = Date.now();
    let timer=null;
    const step = ()=>{
      if (signal?.aborted) { if (timer) clearTimeout(timer); return reject(new Error('Smelt aborted')); }
      try {
        const out = ui.outputItem?.();
        if (out && out.count>0) return resolve(true);
      } catch {}
      if (Date.now()-t0 > timeoutMs) return resolve(false);
      timer = setTimeout(step, 300);
    };
    step();
  });
}

async function drainOutputs(ui, maxLoops=16, tally){
  let pulled=0;
  for (let i=0;i<maxLoops;i++){
    const out = ui.outputItem?.(); if (!out) break;
    const name = out.name;
    try { await ui.takeOutput(); pulled += out.count||1; } catch { break; }
    if (tally) tally.set(name, (tally.get(name)||0) + (out.count||1));
    await sleep(40);
  }
  return pulled;
}

function pickInputs(bot, mode){
  const inv = items(bot);
  const pick =
    mode==='food' ? (i)=> RAW_FOODS.has(i.name) :
    mode==='ores' ? (i)=> ORES_RAW.has(i.name) || STONE_LIKE.has(i.name) :
    (i)=> RAW_FOODS.has(i.name) || ORES_RAW.has(i.name) || STONE_LIKE.has(i.name);
  return inv.filter(pick);
}
function chooseStationType(mode, inputs){
  if (mode==='food') return 'smoker';
  if (mode==='ores') return 'blast_furnace';
  const names = inputs.map(i=>i.name);
  const foodLike = names.filter(n=> RAW_FOODS.has(n)).length;
  const oreLike  = names.filter(n=> ORES_RAW.has(n)).length;
  if (foodLike && foodLike>=oreLike) return 'smoker';
  if (oreLike  && oreLike> foodLike)  return 'blast_furnace';
  return 'furnace';
}

/* ───────────────────── Charcoal maker (optional) ───────────────────── */
const LOG_NAMES = [
  'oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log',
  'mangrove_log','cherry_log','bamboo_block','pale_oak_log'
];
function hasLogs(bot){ return LOG_NAMES.some(n=> count(bot,n)>0); }
function takeAnyLogItem(bot){
  const inv = items(bot);
  return inv.find(i=> LOG_NAMES.includes(i.name)) || null;
}

/**
 * Делает немного charcoal, если топлива нет, но есть логи.
 * Бережём последние 4 доски/2 лога (чтоб не лишиться крафта/факелов).
 */
async function tryProduceCharcoal(bot, ui, { minOut=4, preserveLogs=2, policy } = {}){
  try {
    // топливо вообще отсутствует?
    const order = buildFuelOrder(policy);
    const fuels = listFuelUnits(bot, order);
    const hasTrueFuel = fuels.some(f=> f.name==='coal' || f.name==='charcoal' || f.name==='blaze_rod' || f.name==='lava_bucket');
    const logCount = LOG_NAMES.reduce((s,n)=> s+count(bot,n), 0);

    if (hasTrueFuel) return false;
    if (logCount <= preserveLogs) return false;

    // кладём 1–2 лога в input, ещё 1–2 в топливо
    const inItem = takeAnyLogItem(bot); if (!inItem) return false;
    try { await ui.putInput(inItem); } catch { return false; }

    // Если топлива нет — положим ещё лог в топливо
    if (!ui.fuelItem?.()) {
      const fuelLog = takeAnyLogItem(bot);
      if (fuelLog) { try { await ui.putFuel(fuelLog); } catch {} }
    }

    const ok = await waitForSmelt(ui, { timeoutMs: 12000 });
    if (!ok) return false;

    // дреним выход
    const tall = new Map();
    const pulled = await drainOutputs(ui, 8, tall);
    // если получили charcoal — отлично
    return pulled>0 && [...tall.keys()].includes('charcoal');
  } catch { return false; }
}

/* ───────────────────── Scheduler (multi-station) ───────────────────── */
class Station {
  constructor(block){ this.block = block; this.ui = null; this.busy = false; this.last = 0; }
  async open(bot){ if (this.ui) return this.ui; this.ui = await openUI(bot, this.block, { retries:2 }); return this.ui; }
  async close(){ try { await this.ui?.close?.(); } catch {} this.ui=null; }
}

/* ───────────────────── Public API: smeltAll ───────────────────── */
/**
 * Переплавить/приготовить всё подходящее.
 * @param {'auto'|'ores'|'food'} mode
 * @param {{
 *   concurrency?: 1|2|3,
 *   radius?: number,
 *   timeoutMs?: number,
 *   pauseOnDanger?: boolean,
 *   fuelPolicy?: { preserveCoal?: boolean, avoidTools?: boolean, avoidDoorsFences?: boolean },
 *   autoCharcoal?: boolean,
 *   onProgress?: (made:number,total:number,details:Record<string,number>)=>void,
 *   signal?: AbortSignal
 * }} opts
 * @returns {{ ok:boolean, timeMs:number, made:number, details:Record<string,number> }}
 */
const _smeltBusy = new WeakSet();
async function smeltAll(bot, mode='auto', opts={}){
  if (_smeltBusy.has(bot)) {
    try { bot.chat('⏳ Переплавка уже идёт.'); } catch {}
    return { ok:false, timeMs:0, made:0, details:{} };
  }
  _smeltBusy.add(bot);

  const startedAt = Date.now();
  const options = {
    concurrency: 2,
    radius: 7,
    timeoutMs: 22000,
    pauseOnDanger: true,
    autoCharcoal: true,
    fuelPolicy: { preserveCoal: false, avoidTools: true, avoidDoorsFences: true },
    onProgress: null,
    signal: null,
    ...opts
  };
  const progressThrottleMs = 300;
  let lastProgressAt = 0;
  const progress = (made,total,map)=>{
    const t=Date.now(); if (t-lastProgressAt<progressThrottleMs) return;
    lastProgressAt=t; try { options.onProgress?.(made,total, Object.fromEntries(map||[])); } catch {}
  };

  const res = await withCraftXP(
    bot,
    'smelt_all',
    { mode, conc: options.concurrency },
    async ()=>{

      // безопасность
      if (options.pauseOnDanger && dangerNearby(bot,8)) await humanPause(420);

      const inputsRaw = pickInputs(bot, mode);
      if (!inputsRaw.length){
        try { bot.chat('ℹ️ Нечего переплавлять/готовить.'); } catch {}
        return { ok:true, timeMs:0, made:0, details:{} };
      }

      const totalPlanned = sumCounts(inputsRaw);
      let plannedLeft  = totalPlanned;

      // выбираем тип станции и готовим пул
      const stationType = chooseStationType(mode, inputsRaw);
      const blocks = await ensureStations(bot, stationType, { radius: options.radius, want: options.concurrency, allowCraft: true });
      if (!blocks.length){
        try { bot.chat('❗ Нет подходящих печей и не удалось поставить.'); } catch {}
        return { ok:false, timeMs:0, made:0, details:{} };
      }
      const stations = blocks.slice(0, options.concurrency).map(b=> new Station(b));

      // открываем UIs (по очереди)
      for (const st of stations){
        try { await st.open(bot); await humanPause(80+jitter()); } catch {}
      }

      // Авто-charcoal (однократно) — если топлива «по нулям» и есть логи
      if (options.autoCharcoal && hasLogs(bot)){
        for (const st of stations){
          if (options.signal?.aborted) break;
          try {
            await takeEmptyFuelBucketIfAny(st.ui);
            if (!st.ui.fuelItem?.()) {
              const done = await tryProduceCharcoal(bot, st.ui, { policy: options.fuelPolicy });
              if (done) { try { bot.chat('🪵 Подготовил немного угля.'); } catch {} break; }
            }
          } catch {}
        }
      }

      // группируем по названиям и делаем очередь батчей
      const grouped = stackifyByName(inputsRaw);
      const names = [...grouped.keys()];
      // очередь: массив объектов { name, remain }
      const queue = names.map(n=> ({ name:n, remain: grouped.get(n) || 0 }));

      const tally = new Map();
      let made=0;

      // основной цикл, пока есть предметы и UI живы
      while (queue.some(q=> q.remain>0)) {
        if (options.signal?.aborted) throw new Error('Smelt aborted');

        // назначаем задания свободным станциям
        for (const st of stations){
          if (options.signal?.aborted) break;
          if (st.busy) continue;

          // выбираем следующий тип с наибольшим остатком
          const job = queue.sort((a,b)=> (b.remain - a.remain))[0];
          if (!job || job.remain<=0) break;

          st.busy = true;
          (async ()=>{
            try {
              // освободим выход
              if (st.ui.outputItem?.()) await drainOutputs(st.ui, 12, tally);

              // если в инпуте чужой предмет — дождёмся и вытащим
              const cur = st.ui.inputItem?.();
              if (cur && cur.name!==job.name){
                await waitForSmelt(st.ui, { timeoutMs: 2000, signal: options.signal });
                if (st.ui.outputItem?.()) await drainOutputs(st.ui, 12, tally);
                try { if (st.ui.inputItem?.()) await st.ui.takeInput(); } catch {}
              }

              // положим вход (сколько есть)
              const stack = items(bot).find(i=> i.name===job.name);
              if (stack) {
                try { await st.ui.putInput(stack); } catch {
                  try {
                    if (st.ui.outputItem?.()) await drainOutputs(st.ui, 12, tally);
                    await st.ui.putInput(stack);
                  } catch {}
                }
              }

              // топливо
              await topUpFuel(bot, st.ui, plannedLeft, options.fuelPolicy);

              // ждём порцию
              const ok = await waitForSmelt(st.ui, { timeoutMs: options.timeoutMs, signal: options.signal });
              if (ok){
                const pulled = await drainOutputs(st.ui, 14, tally);
                made += pulled;
                plannedLeft = Math.max(0, plannedLeft - pulled);
                job.remain   = Math.max(0, job.remain   - pulled);
                progress(made, totalPlanned, tally);
              }

              // хвост
              if (st.ui.inputItem?.()) {
                await humanPause(200 + jitter());
                const pulled2 = await drainOutputs(st.ui, 10, tally);
                if (pulled2>0){
                  made += pulled2;
                  plannedLeft = Math.max(0, plannedLeft - pulled2);
                  job.remain   = Math.max(0, job.remain   - pulled2);
                  progress(made, totalPlanned, tally);
                }
              }
            } catch {}
            finally { st.busy = false; st.last = Date.now(); }
          })().catch(()=> { st.busy=false; });
        }

        // break condition: если все станции свободны и ничего не меняется — выходим
        await humanPause(120 + jitter());
        const allIdle = stations.every(s=> !s.busy);
        if (allIdle && queue.every(q=> q.remain<=0)) break;

        if (options.pauseOnDanger && dangerNearby(bot,8)) await humanPause(420);
      }

      // финальный дрен
      for (const st of stations){
        try { if (st.ui?.outputItem?.()) { const pulled = await drainOutputs(st.ui, 16, tally); made += pulled; } } catch {}
      }

      // закрыть UI
      for (const st of stations){ try { await st.close(); } catch {} }

      // отчёт
      if (made>0){
        const noun = stationType==='smoker' ? 'готовку' :
                     stationType==='blast_furnace' ? 'переплавку (ускоренную)' : 'переплавку';
        try { bot.chat(`🔥 Завершил ${noun}: ${made} шт. ✔️`); } catch {}
        addExp(10 + Math.min(made,64), 'переплавка/готовка');
      } else {
        try { bot.chat('ℹ️ Ничего не вышло.'); } catch {}
      }

      return { ok: made>0, timeMs: Date.now()-startedAt, made, details:Object.fromEntries(tally) };
    },
    async (res, err, { timeMs }) => {
      const made = res?.made || 0;
      return { ok: !err && made>0, timeMs, cost:0, reward:made };
    }
  ).finally(()=> _smeltBusy.delete(bot));

  return res;
}

/* ───────────────────── Auto Cook ───────────────────── */
let autoCookTimer = null;
/**
 * Автоготовка при голоде.
 * @param {import('mineflayer').Bot} bot
 * @param {boolean} enable
 * @param {{ foodThreshold?: number, periodMs?: number, mode?: 'food'|'auto' }} param2
 */
function autoCookToggle(bot, enable, { foodThreshold=6, periodMs=12000, mode='food' } = {}){
  if (enable){
    if (autoCookTimer) return false;
    autoCookTimer = setInterval(async ()=>{
      try {
        if (!bot?.entity?.isValid) return;
        const hungry = (bot.food ?? 20) <= foodThreshold;
        const hasFood = hasAny(bot, READY_FOOD_RE);
        if (hungry && !hasFood){
          try { bot.chat('🍖 Мало еды — готовлю...'); } catch {}
          try { await smeltAll(bot, mode, { timeoutMs:24000, pauseOnDanger:true }); } catch {}
          // быстрый хлеб, если есть пшеница (3 wheat → 1 bread)
          const w = count(bot,'wheat'); const batches = Math.floor(w/3);
          if (batches>0){
            try {
              const { craftSimple } = require('../crafting/crafting.js');
              await craftSimple(bot,'bread',batches);
              try { bot.chat(`🍞 Скрафтил хлеб: ${batches} шт.`); } catch {}
            } catch {}
          }
        }
      } catch {}
    }, periodMs);
    return true;
  } else {
    if (autoCookTimer){ clearInterval(autoCookTimer); autoCookTimer=null; return true; }
    return false;
  }
}

/* ───────────────────── Export ───────────────────── */
module.exports = {
  smeltAll,           // smeltAll(bot, mode='auto', { concurrency, radius, timeoutMs, pauseOnDanger, fuelPolicy, autoCharcoal, onProgress, signal })
  autoCookToggle
};
