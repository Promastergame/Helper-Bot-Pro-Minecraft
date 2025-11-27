'use strict';
/**
 * features/building/building.js — v10 Ultra
 * 🏗️ Умное строительство малых форм (дом/комната/башня) c ИИ-подсказками.
 *
 * Ключи:
 *  • Ротация плана (north/east/south/west), ориентация дверей/ступеней.
 *  • Мягкие ретраи, временные подпорки/леса (scaffolding|dirt) и уборка.
 *  • Материал-чек + подмена аналогами (любые доски/ступени и т.п.).
 *  • Безопасные движения, анти-залипание, паузы при угрозе мобов.
 *  • XP-интеграция (withBuildXP / getXP), человечные задержки (Quantum).
 *  • Dry-run (оценка) и Undo (по возможности), прогресс-колбек.
 *
 * CommonJS, совместимо с HelperBot Pro v7+.
 */

const { Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const { state } = require('../../core/state.cjs');
let addExp = ()=>{}; try { ({ addExp } = require('../leveling.js')); } catch {}

let withBuildXP = async (_b,_tag,_ctx,fn,fin)=> {
  const t=Date.now();
  try { const r=await fn(); await fin?.(r,null,{timeMs:Date.now()-t}); return r; }
  catch(e){ await fin?.(null,e,{timeMs:Date.now()-t}); throw e; }
};
let getXP       = ()=>({ domains:{} });
try { ({ withBuildXP, getXP } = require('../ai/xpHelpers.cjs')); } catch {}

/** Умная укладка блоков: проверь путь в проекте. */
let placeBlockSmart = null;
try { ({ placeBlockSmart } = require('../utils/helpers.js')); } catch { placeBlockSmart = null; }

/** Quantum (опционально) */
let Q; try { Q = require('../ai/quantum'); } catch { Q = null; }

/* ───────────────────────────── Utils ───────────────────────────── */
const sleep  = (ms)=> new Promise(r=> setTimeout(r, ms));
const clamp  = (v,a,b)=> Math.min(b, Math.max(a, v));
const qrand  = ()=> (Q?.quantumRandom?.() ?? Math.random());
const jitter = (a=60,b=160)=> Math.floor(a + qrand()*(b-a));
async function humanPause(ms){
  const T = Q?.scheduleTemperature ? Q.scheduleTemperature(Date.now()%1e9, { T0:1.0, k:0.003, floor:0.8 }) : 1;
  const span = Math.max(0, Math.floor(ms*T + (qrand()-0.5)*0.45*ms));
  if (Q?.humanDelay) return Q.humanDelay(span);
  return sleep(span);
}
const key = (p)=> `${p.x}|${p.y}|${p.z}`;

function isNight(bot){ const t = bot.time?.timeOfDay ?? 0; return t >= 13000 && t <= 23000; }
function blockAt(bot, pos){ try { return bot.blockAt(pos, false); } catch { return null; } }
function solid(bot,pos){ const b=blockAt(bot,pos); return b && b.name!=='air' && b.boundingBox!=='empty'; }
function neighbors6(pos){ return [pos.offset(1,0,0),pos.offset(-1,0,0),pos.offset(0,1,0),pos.offset(0,-1,0),pos.offset(0,0,1),pos.offset(0,0,-1)]; }

const HOSTILES = new Set([
  'zombie','drowned','husk','skeleton','stray','creeper','spider','cave_spider','witch',
  'enderman','slime','magma_cube','phantom','vex','evoker','vindicator','pillager',
  'ravager','piglin_brute','breeze','bogged','ghast','blaze','hoglin','zoglin'
]);
function dangerNearby(bot,within=8){
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

/* ───────────────────── Pathfinder / движение ───────────────────── */
const _mvCache = new WeakMap();
function mcDataFor(bot){
  try { const cacheKey = `mcd:${bot.version}`;
    if (!mcDataFor._cache) mcDataFor._cache = new Map();
    if (mcDataFor._cache.has(cacheKey)) return mcDataFor._cache.get(cacheKey);
    const mc = require('minecraft-data')(bot.version);
    mcDataFor._cache.set(cacheKey, mc);
    return mc;
  } catch { return null; }
}

function ensureMovements(bot){
  if (_mvCache.has(bot)){ bot.pathfinder.setMovements(_mvCache.get(bot)); return; }
  const mc = mcDataFor(bot); if (!mc) return;
  const m = new Movements(bot, mc);
  m.allow1by1towers = false;
  m.scafoldingBlocks = []; // не строим башни
  m.canDig = false;
  m.allowSprinting = true;
  m.maxDropDownDistance = 3;
  m.vehiclesToAvoid = []; // бережно
  _mvCache.set(bot, m);
  bot.pathfinder.setMovements(m);
}

async function gotoNear(bot, pos, r=2, timeoutMs=15000){
  try {
    let timer;
    await Promise.race([
      bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, r)),
      new Promise((_,rej)=>{ timer=setTimeout(()=>rej(new Error('goto-timeout')), timeoutMs); })
    ]);
    return true;
  } catch {
    // анти-залипание мини-рывком
    try { bot.setControlState('jump', true); await bot.waitForTicks(6); bot.setControlState('jump', false); } catch {}
    await bot.waitForTicks(6);
    return false;
  }
}

/* ───────────────────── Инвентарь / материалы ───────────────────── */
function invCount(bot, name){
  try {
    return (bot.inventory.items()||[]).filter(i=> i.name===name).reduce((s,i)=> s+(i.count||0), 0);
  } catch { return 0; }
}
function hasAny(bot, names){ try{ const set=new Set(names); return (bot.inventory.items()||[]).some(i=>set.has(i.name)); }catch{ return false; } }
function firstItem(bot, names){ const arr=Array.isArray(names)?names:[names]; try{ return (bot.inventory.items()||[]).find(i=>arr.includes(i.name)) || null; }catch{ return null; } }

const PLANKS = ['oak_planks','spruce_planks','birch_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks','bamboo_planks','pale_oak_planks'];
const STAIRS = ['oak_stairs','spruce_stairs','birch_stairs','jungle_stairs','acacia_stairs','dark_oak_stairs','mangrove_stairs','cherry_stairs','bamboo_stairs','pale_oak_stairs','stone_stairs','cobblestone_stairs','stone_brick_stairs','cobbled_deepslate_stairs'];
const DOORS  = ['oak_door','spruce_door','birch_door','jungle_door','acacia_door','dark_oak_door','mangrove_door','cherry_door','bamboo_door','pale_oak_door','iron_door'];

const ALIASES = {
  wall:  [...PLANKS, 'cobblestone', 'stone', 'stone_bricks', 'cobbled_deepslate'],
  floor: [...PLANKS, 'stone', 'stone_bricks', 'polished_andesite'],
  roof:  [...STAIRS],
  door:  [...DOORS]
};
function resolveMaterial(bot, want, fallbackList){
  if (!want) return null;
  if (invCount(bot, want) > 0) return want;
  for (const alt of (fallbackList||[])){
    if (invCount(bot, alt) > 0) return alt;
  }
  return want; // вернём желаемый (может, принесут позже)
}

function countRequired(plan){
  const req = Object.create(null);
  for (const p of plan) req[p.name] = (req[p.name]||0) + 1;
  return req;
}
function analyzeMaterials(bot, plan){
  const required = countRequired(plan);
  const have = {}, lacking = {};
  for (const [n,c] of Object.entries(required)){
    const h = invCount(bot, n); have[n]=h;
    if (h < c) lacking[n]=c-h;
  }
  return { required, have, lacking };
}

/* ─────────────────────────── План и ротация ─────────────────────────── */
const DEFAULT_MATERIALS = Object.freeze({
  floor: 'oak_planks',
  wall : 'oak_planks',
  roof : 'oak_stairs',
  door : 'oak_door'
});

/** Ротация: north=0, east=1, south=2, west=3 (по часовой) */
function rotatePos(start, local, rot=0){
  // local: {x,y,z} в локальной системе, ось Z → «вперёд»
  const { x, y, z } = local;
  let xr=x, zr=z;
  if (rot===1){ xr =  z; zr = -x; }
  else if (rot===2){ xr = -x; zr = -z; }
  else if (rot===3){ xr = -z; zr =  x; }
  return start.offset(xr, y, zr);
}
function rotateFace(face, rot=0){
  if (!face) return face;
  const { x, y, z } = face;
  let xr=x, zr=z;
  if (rot===1){ xr =  z; zr = -x; }
  else if (rot===2){ xr = -x; zr = -z; }
  else if (rot===3){ xr = -z; zr =  x; }
  return { x:xr, y, z:zr };
}

/** Базовый дом: s×s, стены h, крыша ступени */
function makeHousePlan(startPos, opt={}){
  const s = opt.size||5;
  const h = opt.height||3;
  const rot = ({north:0,east:1,south:2,west:3}[opt.facing||'north']) ?? 0;
  const mat = { ...DEFAULT_MATERIALS, ...(opt.materials||{}) };

  const P = [];
  const cx = Math.floor(s/2);

  // фундамент (y=0)
  for (let x=0;x<s;x++) for (let z=0;z<s;z++){
    P.push({ name: mat.floor, local:{x,y:0,z}, face:null });
  }

  // стены (проём двери 2 блока по высоте) на стороне Z=0
  for (let y=1;y<=h;y++){
    for (let x=0;x<s;x++) for (let z=0;z<s;z++){
      const border = (x===0||x===s-1||z===0||z===s-1);
      if (!border) continue;
      if (z===0 && x===cx && (y===1||y===2)) continue;
      let face = null;
      if (z===0) face = {x:0,y:0,z:-1};
      else if (z===s-1) face = {x:0,y:0,z:1};
      else if (x===0) face = {x:-1,y:0,z:0};
      else face = {x:1,y:0,z:0};
      P.push({ name: mat.wall, local:{x,y,z}, face });
    }
  }

  // крыша (ступени) по контуру с «козырьком»
  for (let x=-1;x<=s;x++) for (let z=-1;z<=s;z++){
    const dx = (x<0) ? -1 : (x>s-1 ? 1 : 0);
    const dz = (z<0) ? -1 : (z>s-1 ? 1 : 0);
    const face = (Math.abs(dx)+Math.abs(dz)) ? {x:dx,y:0,z:dz} : {x:0,y:0,z:1};
    P.push({ name: mat.roof, local:{x, y:h+1, z}, face });
  }

  // дверь (нижняя часть), ориентирована наружу (в сторону «вперёд»: Z-)
  P.push({ name: mat.door, local:{x:cx, y:1, z:0}, face:{x:0,y:0,z:-1} });

  // трансформация в мировые координаты
  const out = P.map(it=>{
    const pos = rotatePos(startPos.floored(), it.local, rot);
    const face= rotateFace(it.face, rot);
    return { name: it.name, pos, face };
  });

  return out;
}

/** Комната: прямоугольная оболочка */
function makeRectRoomPlan(startPos, sizeX, sizeZ, h, materials={}, facing='north'){
  const rot = ({north:0,east:1,south:2,west:3}[facing||'north']) ?? 0;
  const P = [];
  // локальный план из (0..sizeX-1, 0..sizeZ-1)
  for (let x=0;x<sizeX;x++) for (let z=0;z<sizeZ;z++)
    P.push({ name: materials.floor, local:{x,y:0,z}, face:null });

  for (let y=1;y<=h;y++)
    for (let x=0;x<sizeX;x++) for (let z=0;z<sizeZ;z++)
      if (x===0||x===sizeX-1||z===0||z===sizeZ-1){
        const dx=(x===0)?-1:(x===sizeX-1?1:0);
        const dz=(z===0)?-1:(z===sizeZ-1?1:0);
        P.push({ name: materials.wall, local:{x,y,z}, face:{x:dx,y:0,z:dz} });
      }

  for (let x=-1;x<=sizeX;x++) for (let z=-1;z<=sizeZ;z++){
    const dx=(x<0)?-1:(x>sizeX-1?1:0);
    const dz=(z<0)?-1:(z>sizeZ-1?1:0);
    P.push({ name: materials.roof, local:{x, y:h+1, z}, face:{x:dx,y:0,z:dz} });
  }

  return P.map(it=> ({ name: it.name, pos: rotatePos(startPos.floored(), it.local, rot), face: rotateFace(it.face, rot) }));
}

/** Сортировка: снизу вверх, змейкой в слое */
function orderPlanSerpentine(plan){
  const byY = new Map();
  for (const it of plan){
    const arr = byY.get(it.pos.y)||[]; arr.push(it); byY.set(it.pos.y, arr);
  }
  const ys = [...byY.keys()].sort((a,b)=> a-b);
  const out = [];
  for (const y of ys){
    const layer = byY.get(y);
    const byZ = new Map();
    for (const it of layer){
      const arr = byZ.get(it.pos.z)||[]; arr.push(it); byZ.set(it.pos.z, arr);
    }
    const zs = [...byZ.keys()].sort((a,b)=> a-b);
    let flip=false;
    for (const z of zs){
      const row = byZ.get(z).sort((a,b)=> a.pos.x-b.pos.x);
      out.push(...(flip ? row.reverse() : row));
      flip = !flip;
    }
  }
  return out;
}

/** Дедуп позиций (последний важнее: позволяет переопределять материал) */
function dedupePlan(plan){
  const m = new Map();
  for (const it of plan) m.set(key(it.pos), it);
  return [...m.values()];
}

/* ───────────────────── Ориентация / укладка ───────────────────── */
async function lookFace(bot, face){
  if (!face) return;
  try {
    const yaw = Math.atan2(-face.x, -face.z);
    bot.look(yaw, bot.entity.pitch, true);
    await bot.waitForTicks(1);
  } catch { /* ignore */ }
}

async function fallbackPlace(bot, name, pos){
  // простой фолбэк, если нет placeBlockSmart: кликаем соседний твердый блок
  try {
    const base = neighbors6(pos).find(p=> solid(bot,p));
    if (!base) throw new Error('no support neighbor');
    await bot.equip(firstItem(bot, [name]), 'hand');
    await bot.placeBlock(base, { x: pos.x - base.x, y: pos.y - base.y, z: pos.z - base.z });
    return true;
  } catch { return false; }
}

/** Быстрая безопасная подпорка (scaffolding|dirt|cobblestone) под блок */
async function ensureSupportUnder(bot, pos, supports=['scaffolding','dirt','cobblestone']){
  if (solid(bot, pos.offset(0,-1,0))) return true;
  const item = firstItem(bot, supports); if (!item) return false;
  try {
    await bot.equip(item,'hand');
    const base = blockAt(bot, pos.offset(0,-2,0)) || blockAt(bot, pos.offset(0,-1,0)) || blockAt(bot, bot.entity.position.offset(0,-1,0));
    if (!base) return false;
    await bot.placeBlock(base, {x:0,y:1,z:0});
    await humanPause(90);
    return true;
  } catch { return false; }
}

/**
 * Мягкая укладка с ретраями и ориентацией:
 * opts: { batch=16, microDelay=true, skipIfSame=true, onProgress, signal, maxRetries=2, record=true, pauseOnDanger=true }
 * возвращает: { usedBlocks, misplacements, placedKeys:Set<string>, supportsPlaced:Set<string> }
 */
async function placeBatch(bot, plan, opts={}){
  const {
    batch=16, microDelay=true, skipIfSame=true,
    onProgress=null, signal=null, maxRetries=2,
    record=true, pauseOnDanger=true
  } = opts;

  const placed = new Set();
  const supports = new Set();
  let used=0, fail=0, i=0;

  for (const it of plan){
    if (signal?.aborted) throw new Error('Build aborted');

    if (pauseOnDanger && dangerNearby(bot, 8)){
      await humanPause(350);
      if (dangerNearby(bot, 8)) { // чуть дольше подождём
        await humanPause(650);
      }
    }

    try {
      if (skipIfSame){
        const ex = blockAt(bot, it.pos);
        if (ex && ex.name===it.name){
          i++;
          if (onProgress && (i%10===0)) onProgress(i, plan.length);
          if (microDelay) await sleep(1);
          if ((i%batch)===0) await bot.waitForTicks(6);
          continue;
        }
      }

      // гарантируем опору, если строим в воздухе
      if (!solid(bot, it.pos.offset(0,-1,0))){
        const okSup = await ensureSupportUnder(bot, it.pos);
        if (okSup) supports.add(key(it.pos.offset(0,-1,0)));
      }

      await lookFace(bot, it.face);

      let ok=false, tries=0;
      const placer = placeBlockSmart
        ? async ()=> { await placeBlockSmart(bot, it.name, it.pos); }
        : async ()=> {
            const s = await fallbackPlace(bot, it.name, it.pos);
            if (!s) throw new Error('fallback place failed');
          };

      while (!ok && tries<=maxRetries){
        try {
          // добегаем до точки поближе, чтобы точнее ориентировать ступени/двери
          await gotoNear(bot, it.pos, 3);
          await placer();
          ok = true;
        } catch {
          tries++;
          if (tries<=maxRetries) await humanPause(jitter(90,180));
        }
      }
      if (ok) { used++; if (record) placed.add(key(it.pos)); } else fail++;
    } catch { fail++; }

    i++;
    if (onProgress && (i%10===0)) onProgress(i, plan.length);
    if (microDelay) await humanPause(jitter());
    if ((i%batch)===0) await bot.waitForTicks(8);
  }
  if (onProgress) onProgress(plan.length, plan.length);
  return { usedBlocks: used, misplacements: fail, placedKeys: placed, supportsPlaced: supports };
}

/* ───────────────────── Скан рисков / фундамент ───────────────────── */
function quickHazardScan(bot, plan){
  try {
    const sample = plan.slice(0, Math.min(plan.length, 64));
    let risk = 0;
    for (const it of sample){
      const b = blockAt(bot, it.pos.offset(0,-1,0));
      const n = b?.name || '';
      if (n.includes('lava'))  risk += 2;
      if (n.includes('water')) risk += 0.6;
    }
    return risk;
  } catch { return 0; }
}

/* ───────────────────── Публичные билдеры ───────────────────── */

/**
 * Построить маленький домик.
 * options:
 *  - size=5, height=3, facing='north'|'east'|'south'|'west'
 *  - materials: { floor, wall, roof, door }
 *  - onProgress(i,total), signal(AbortController.signal), dryRun=false, undo=true
 */
async function buildSmallHouse(bot, options={}){
  const startPos = bot.entity.position.floored();

  const opt = {
    size:5, height:3, facing:'north',
    materials:{ ...DEFAULT_MATERIALS },
    onProgress:null, signal:null, dryRun:false, undo:true,
    ...options
  };

  // рекомендации от XP → темп/батч
  const xp = getXP(bot);
  const base = { speed:0.55, accuracy:0.35, safety:0.10 };
  const advice = xp?.domains?.building?.advise?.('small_house', base, {
    night: isNight(bot)
  }) || base;
  const speed    = clamp(advice.speed ?? 0.55, 0.2, 0.95);
  const accuracy = clamp(advice.accuracy ?? 0.35, 0.1, 0.95);
  const batch    = Math.round(clamp(10 + speed*16 - accuracy*6, 10, 28));

  // план → дедуп → сортировка
  const rawPlan    = makeHousePlan(startPos, opt);
  const plan       = orderPlanSerpentine(dedupePlan(rawPlan));

  // подбор аналогов материалов по наличию
  const resolved = plan.map(p=>{
    let name = p.name;
    if (name === opt.materials.wall)  name = resolveMaterial(bot, name, ALIASES.wall);
    if (name === opt.materials.floor) name = resolveMaterial(bot, name, ALIASES.floor);
    if (name === opt.materials.roof)  name = resolveMaterial(bot, name, ALIASES.roof);
    if (name === opt.materials.door)  name = resolveMaterial(bot, name, ALIASES.door);
    return { ...p, name };
  });

  // материалы: сообщим, чего не хватает
  const { lacking } = analyzeMaterials(bot, resolved);
  if (Object.keys(lacking).length){
    const msg = Object.entries(lacking).map(([n,c])=> `${n}×${c}`).join(', ');
    bot.chat?.('🧱 Не хватает материалов: ' + msg);
  }

  // оценка/предпросмотр
  if (opt.dryRun){
    const req = countRequired(resolved);
    return { dryRun:true, required:req, lacking };
  }

  // фундамент риск
  const risk = quickHazardScan(bot, resolved);
  if (risk>2) bot.chat?.('⚠️ Рядом вода/лава — ставлю аккуратно.');

  return withBuildXP(
    bot,
    'small_house',
    { size:opt.size, height:opt.height, facing:opt.facing },
    async ()=>{
      ensureMovements(bot);
      await gotoNear(bot, startPos, 2);

      const res = await placeBatch(bot, resolved, {
        batch, microDelay:true, skipIfSame:true,
        onProgress: opt.onProgress, signal: opt.signal, maxRetries:2, record:true
      });

      if ((res.usedBlocks||0) > 0){
        state.botStats && (state.botStats.housesBuilt = (state.botStats.housesBuilt||0)+1);
        addExp(40 + Math.floor((res.usedBlocks||0)/10), 'строительство домика');
        bot.chat?.('🏠 Домик готов!');
      } else {
        bot.chat?.('😕 Домик построить не удалось.');
      }

      // Undo (аккуратно): если просили и почти всё наше — попробуем убрать подпорки
      if (opt.undo && res.supportsPlaced?.size){
        for (const k of res.supportsPlaced){
          const [x,y,z] = k.split('|').map(Number);
          const b = blockAt(bot, {x,y,z});
          if (!b) continue;
          try { await bot.dig(b); await humanPause(80); } catch {}
        }
      }

      return res;
    },
    async (res, err, { timeMs })=>{
      const used = res?.usedBlocks ?? 0;
      const mis  = res?.misplacements ?? 0;
      return { ok: !err && used>0, timeMs, cost: used + mis*0.5, reward: used };
    }
  );
}

/**
 * Универсальная прямоугольная комната.
 * options: { facing, onProgress, signal, dryRun=false }
 */
async function buildRectRoom(
  bot,
  sizeX=7,
  sizeZ=5,
  height=3,
  materials={ wall:'cobblestone', floor:'stone', roof:'stone_stairs' },
  options={}
){
  const startPos = bot.entity.position.floored();
  const facing = options.facing || 'north';

  // план
  const plan = orderPlanSerpentine(
    dedupePlan(
      makeRectRoomPlan(startPos, sizeX, sizeZ, height, materials, facing)
    )
  );

  // dry-run оценка
  if (options.dryRun){
    const req = countRequired(plan);
    const { lacking } = analyzeMaterials(bot, plan);
    return { dryRun:true, required:req, lacking };
  }

  return withBuildXP(
    bot,
    'rect_room',
    { sizeX, sizeZ, height, facing },
    async ()=>{
      ensureMovements(bot);
      await gotoNear(bot, startPos, 2);
      return placeBatch(bot, plan, {
        batch: 18, microDelay:true, skipIfSame:true,
        onProgress: options.onProgress, signal: options.signal, maxRetries:2, record:false
      });
    },
    async (res, err, { timeMs })=> ({
      ok: !err && (res?.usedBlocks||0)>0,
      timeMs, cost: res?.usedBlocks||0, reward: res?.usedBlocks||0
    })
  );
}

/**
 * Низкая башенка 3×3 с лестницей-ступенями по периметру (пример дополнительного билдера).
 * options: { levels=3, material='cobblestone', stair='stone_stairs', facing='north' }
 */
async function buildMiniTower(bot, options={}){
  const start = bot.entity.position.floored();
  const opt = { levels:3, material:'cobblestone', stair:'stone_stairs', facing:'north', ...options };
  const rot = ({north:0,east:1,south:2,west:3}[opt.facing||'north']) ?? 0;

  const P=[];
  // пол 3x3
  for (let x=0;x<3;x++) for (let z=0;z<3;z++)
    P.push({ name: opt.material, local:{x,y:0,z}, face:null });

  // уровни + лестничный марш по внешней стороне
  for (let l=1;l<=opt.levels;l++){
    for (let x=0;x<3;x++) for (let z=0;z<3;z++){
      if (x===0||x===2||z===0||z===2)
        P.push({ name: opt.material, local:{x,y:l,z}, face: {x:(x===0?-1:(x===2?1:0)), y:0, z:(z===0?-1:(z===2?1:0))} });
    }
    // ступенька снаружи «впереди»
    P.push({ name: opt.stair, local:{x:1,y:l, z:-1}, face:{x:0,y:0,z:-1} });
  }

  const plan = orderPlanSerpentine(
    dedupePlan(P.map(it=>({ name:it.name, pos: rotatePos(start, it.local, rot), face: rotateFace(it.face, rot) })))
  );

  return withBuildXP(
    bot,
    'mini_tower',
    { levels:opt.levels, material:opt.material },
    async ()=>{
      ensureMovements(bot);
      await gotoNear(bot, start, 2);
      return placeBatch(bot, plan, { batch: 14, microDelay:true, skipIfSame:true, maxRetries:2 });
    },
    async (res, err, { timeMs })=> ({ ok: !err && (res?.usedBlocks||0)>0, timeMs, cost: res?.usedBlocks||0, reward: res?.usedBlocks||0 })
  );
}

/* ───────────────────── Экспорт ───────────────────── */
module.exports = {
  // основные
  buildSmallHouse,
  buildRectRoom,
  buildMiniTower,
  // плановые/утилиты
  makeHousePlan,
  makeRectRoomPlan,
  analyzeMaterials,
  orderPlanSerpentine,
  dedupePlan
};
