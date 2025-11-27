'use strict';
/**
 * features/ai/agents/miner.cjs — v3.2 "Shaft-Prime Ultra"
 *
 * Режимы:
 *   - layered: 2×2 лесенка N шагов → ветка Left L → Back → ветка Right L → Back → вниз на следующий слой...
 *   - branch : 3×2 эстетика (магистраль + ответвления)
 *   - free   : 3×2 эстетика (свободные повороты)
 *
 * Плюсы:
 *   • Автоторчи: по шагам и по уровню света (если bot.world.getLight доступен)
 *   • Автокрафт факелов (стики + уголь/древуголь)
 *   • Watchdog от застреваний, анти-жидкости, возврат домой с опц. резюмом
 *   • Авто-склад (сундук у HOME), интеграция с masterAI (guard)
 */

const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createLogger } = require('../../../core/logger.cjs');
const log = createLogger('miner');

let perf = null;
try { perf = require('../../ai/quantum/performance.cjs'); } catch {}

const makeMinerCore = (()=>{ try { return require('./minerCore.cjs'); } catch { return null; } })();

const { Movements, goals } = (()=>{ try { return require('mineflayer-pathfinder'); } catch { return {}; } })();
const { GoalNear } = goals || {};

// ──────────────────────────────────────────────────────────────────────────────
// Константы / умолчания
// ──────────────────────────────────────────────────────────────────────────────
const STATE = {
  INIT: 0, PREP: 1, STAIRS: 2,
  CHOOSE_DIR: 3, DIG_STEP: 4, AVOID: 5,
  BRANCH_START: 6, BRANCH_STEP: 7,
  RETURN_HOME: 8, DEPOSIT: 9, STOPPED: 10
};

const DEFAULTS = {
  // Базовые
  mode: 'layered',            // 'layered' | 'branch' | 'free'
  radius: 40,
  targetY: 12,
  minPickDurability: 28,
  autoReturnOnFull: true,

  // Склады/депозит
  autoDeposit: true,
  chestKind: 'chest',         // 'chest' | 'trapped_chest' | 'ender_chest'
  depositEveryLayers: 3,      // для layered — выгрузка каждые N слоёв
  resumeAfterDeposit: true,

  // Факелы
  torchEvery: 8,              // шаги по счётчику
  lightThreshold: 8,          // ставить если свет < порога
  autoCraftTorches: true,

  // Движение/безопасность
  hostileScan: 7,
  stepTicks: 6,
  stuckMs: 5500,              // watchdog
  panicMs: 2500,

  // Aesthetic (3×2)
  style: 'serpentine',        // 'serpentine' | 'grid' | 'spiral' | 'ant'
  frameEvery: 12,
  branchEvery: 16,
  branchLen: 8,
  placeTorches: true,
  placeFrames: true,

  // Layered 2×2
  stairSteps: 8,              // шагов лестницы в одном слое
  tunnelLen: 20,              // длина левой/правой ветки
  layers: null,               // если null — считаем до targetY
  reverseChance: 0.12,
  width: 2, height: 2,
  ticksPerStep: 6
};

// ──────────────────────────────────────────────────────────────────────────────
// Наборы блоков/мобы
// ──────────────────────────────────────────────────────────────────────────────
const LIQUIDS = new Set(['water','flowing_water','lava','flowing_lava','bubble_column']);
const DANGERS = new Set([...LIQUIDS, 'cave_air', 'void_air']);
const TORCH_NAMES = new Set(['torch','soul_torch']);
const FILL_BLOCKS = ['cobblestone','stone','deepslate','dirt','netherrack','andesite','diorite','granite'];
const CHEST_NAMES = new Set(['chest','trapped_chest','ender_chest']);
const HOSTILES = new Set([
  'zombie','husk','drowned','bogged','zombie_villager',
  'skeleton','stray','wither_skeleton',
  'creeper','spider','cave_spider',
  'enderman','endermite',
  'slime','magma_cube',
  'phantom','witch',
  'ghast','blaze','guardian','elder_guardian',
  'pillager','vindicator','evoker','illusioner','ravager','vex',
  'piglin','piglin_brute','zombified_piglin',
  'shulker','silverfish','breeze','hoglin','zoglin','warden'
]);

// ──────────────────────────────────────────────────────────────────────────────
// Утилиты
// ──────────────────────────────────────────────────────────────────────────────
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const waitTicks = async (bot,t)=> perf?.yieldTicks ? await perf.yieldTicks(bot,t) : await sleep(t*50);

function rndInt(min, max){ const span=(max-min+1)>>>0; const buf=crypto.randomBytes(4).readUInt32LE(0)>>>0; return min + (buf % span); }
function rndChoice(arr){ return arr[rndInt(0,arr.length-1)]; }

function mcData(bot){ try { return require('minecraft-data')(bot.version); } catch { return null; } }
function floored(bot){ return bot.entity.position.floored(); }
function dist(a,b){ return a.distanceTo(b); }

function forwardVec(bot){ const yaw=bot.entity.yaw; return {dx:Math.sin(yaw), dz:Math.cos(yaw)}; }
function rightVec(bot){ const {dx,dz}=forwardVec(bot); return {rx:dz, rz:-dx}; }
function blockAt(bot, pos){ try { return bot.blockAt(pos);} catch { return null; } }
function blockName(bot, pos){ return blockAt(bot,pos)?.name ?? null; }
function isDangerName(n){ return !!n && DANGERS.has(n); }
function isLiquidName(n){ return !!n && LIQUIDS.has(n); }

function invItems(bot){ try { return bot.inventory?.items() || []; } catch { return []; } }
function emptySlots(bot){ try { return bot.inventory?.emptySlotCount?.() ?? 0; } catch { return 0; } }
function inventoryFull(bot, reserve=1){ return emptySlots(bot) <= reserve; }

const PICK_TIERS = ['netherite','diamond','iron','stone','golden','wooden'];
function isPick(name){ return /_pickaxe$/.test(name||''); }
function bestPickItem(bot){
  const its = invItems(bot).filter(i=>isPick(i.name));
  its.sort((a,b)=> PICK_TIERS.indexOf(a.name.split('_')[0]) - PICK_TIERS.indexOf(b.name.split('_')[0]));
  return its[0] || null;
}
function itemMaxDurability(bot, item){
  try { const mc = mcData(bot); if (!mc) return Infinity; const meta = mc.items[item.type]; return meta?.maxDurability || Infinity; }
  catch { return Infinity; }
}
function itemDurabilityLeft(bot, item){
  try { if (!item) return Infinity; const max = itemMaxDurability(bot,item); const used = item.durabilityUsed ?? 0; return Math.max(0, max - used); }
  catch { return Infinity; }
}
async function ensureBestPick(bot){ const best = bestPickItem(bot); if (!best) return false; try { await bot.equip(best,'hand'); return true; } catch { return false; } }

async function equipItemByName(bot, namesSet){
  const it = invItems(bot).find(i=>namesSet.has(i.name));
  if (!it) return null;
  try { await bot.equip(it,'hand'); return it; } catch { return null; }
}

async function placeSolid(bot, pos){
  const base = blockAt(bot, pos.offset(0,-1,0)) || blockAt(bot, bot.entity.position.offset(0,-1,0));
  if (!base) return false;
  const it = invItems(bot).find(i=>FILL_BLOCKS.includes(i.name));
  if (!it) return false;
  try { await bot.equip(it,'hand'); } catch { return false; }
  try { await bot.placeBlock(base,{x:0,y:1,z:0}); return true; } catch { return false; }
}

async function placeTorchFloorOrWall(bot){
  const it = await equipItemByName(bot, TORCH_NAMES); if (!it) return false;
  const base = blockAt(bot, bot.entity.position.offset(0,-1,0));
  if (base) { try { await bot.placeBlock(base,{x:0,y:1,z:0}); return true; } catch {} }
  const {dx,dz}=forwardVec(bot);
  const f=floored(bot).offset(Math.round(dx),0,Math.round(dz));
  const wall = blockAt(bot,f);
  if (wall){ try { await bot.placeBlock(wall,{x:0,y:0,z:0}); return true; } catch {} }
  return false;
}

async function craftTorchesIfNeeded(bot, want=16){
  try{
    // если уже есть — выходим
    if (invItems(bot).some(i=>TORCH_NAMES.has(i.name))) return false;
    const mc = mcData(bot); if (!mc) return false;
    const torch = mc.itemsByName['torch']; if (!torch) return false;

    // материалы
    const items = invItems(bot);
    const sticks = items.find(i=>i.name==='stick');
    const coal   = items.find(i=>i.name==='coal') || items.find(i=>i.name==='charcoal');
    if (!sticks || !coal) return false;

    const recipes = bot.recipesFor(torch.id, null, 1, null);
    if (!recipes?.length) return false;

    const craftCount = Math.min(
      Math.floor((sticks.count)/1), // на 1 факел — 1 стик + 1 уголь (рецепт даёт 4 факела, но mineflayer сам считает)
      Math.floor((coal.count)/1),
      want
    );

    if (craftCount <= 0) return false;
    await bot.craft(recipes[0], craftCount, null);
    return true;
  } catch { return false; }
}

// симметричная постановка факелов на стены (лево+право)
async function placeTorchesSymmetric(bot){
  const it = await equipItemByName(bot, TORCH_NAMES);
  if (!it) return false;
  const base = floored(bot);
  const {rx,rz} = rightVec(bot);
  const frx=Math.round(rx), frz=Math.round(rz);
  let ok=false;
  const leftWall = blockAt(bot, base.offset(-frx,0,-frz));
  if (leftWall) { try { await bot.placeBlock(leftWall,{x:0,y:0,z:0}); ok=true; } catch {} }
  const rightWall = blockAt(bot, base.offset(frx,0,frz));
  if (rightWall) { try { await bot.placeBlock(rightWall,{x:0,y:0,z:0}); ok=true; } catch {} }
  return ok;
}

function nearestHostile(bot, within=7){
  const me = bot?.entity?.position; if (!me) return null;
  let best=null,bestD2=Infinity,r2=within*within;
  for (const e of Object.values(bot.entities||{})){
    if (e?.type!=='mob' || !e.position) continue;
    if (!HOSTILES.has(e.name)) continue;
    const dx=e.position.x-me.x, dy=e.position.y-me.y, dz=e.position.z-me.z;
    const d2=dx*dx+dy*dy+dz*dz;
    if (d2<r2 && d2<bestD2){ best=e; bestD2=d2; }
  }
  return best;
}

const ChatLimiter = (()=>{ let last=0,gap=1100; return { say(bot,msg){ const t=Date.now(); if(t-last>=gap){ try{bot.chat(String(msg));}catch{} last=t; } } };})();

function setMovements(bot){
  try{
    const mc = mcData(bot); if (!mc || !Movements) return;
    const m = new Movements(bot, mc);
    m.allow1by1towers = false; m.maxDropDownDistance = 3; m.parkour = false; m.canOpenDoors = true;
    bot.pathfinder.setMovements(m);
  } catch {}
}
async function lookRelative(bot, yawDelta){ try { await bot.look(bot.entity.yaw + yawDelta, 0, false); } catch {} }
async function stepForward(bot, ticks){ bot.setControlState('forward', true); await waitTicks(bot,ticks); bot.setControlState('forward', false); }

// ──────────────────────────────────────────────────────────────────────────────
// Watchdog/безопасность
// ──────────────────────────────────────────────────────────────────────────────
function makeWatchdog(bot, ctx){
  let lastPos = bot.entity.position.clone();
  let lastMove = Date.now();

  async function nudge(){
    // небольшой поворот/стрейф/прыжок
    try { await lookRelative(bot, rndChoice([Math.PI/8, -Math.PI/8])); } catch {}
    bot.setControlState('jump', true);
    await waitTicks(bot,2);
    bot.setControlState('jump', false);
    bot.setControlState(rndChoice(['left','right']), true);
    await waitTicks(bot,4);
    bot.clearControlStates?.();
  }

  return {
    touch(){ const p = bot.entity.position; const d = p.distanceTo(lastPos); if (d > 0.12){ lastPos = p.clone(); lastMove = Date.now(); } },
    async check(){
      const dt = Date.now() - lastMove;
      if (dt > ctx.stuckMs){
        ChatLimiter.say(bot,'🛠️ Застрял — пробую выбраться');
        await nudge();
        lastMove = Date.now();
      }
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// AESTHETIC (3×2) — копка секций/рам/ступеней
// ──────────────────────────────────────────────────────────────────────────────
async function digSlice3x2(bot, ahead=1){
  const base = floored(bot);
  const { dx, dz } = forwardVec(bot);
  const { rx, rz } = rightVec(bot);
  const fdx=Math.round(dx), fdz=Math.round(dz);
  const frx=Math.round(rx), frz=Math.round(rz);

  await ensureBestPick(bot);

  for (let side=-1; side<=1; side++){
    for (let h=0; h<=1; h++){
      const p = base.offset(frx*side + fdx*ahead, h, frz*side + fdz*ahead);
      const n = blockName(bot,p); if (!n) continue;
      if (isDangerName(n)){ if (isLiquidName(n)){ await placeSolid(bot,p); } return false; }
      try { const b = blockAt(bot,p); if (b && b.name!=='air' && b.name!=='bedrock'){ await bot.dig(b); } } catch {}
      if (perf?.cd && !perf.cd?.('slice',80)) await waitTicks(bot,1);
    }
  }
  return true;
}

async function buildFrame(bot){
  const base = floored(bot);
  const { rx, rz } = rightVec(bot);
  const frx=Math.round(rx), frz=Math.round(rz);
  const it = invItems(bot).find(i=>FILL_BLOCKS.includes(i.name));
  if (!it) return false; try { await bot.equip(it,'hand'); } catch { return false; }
  const leftBase  = blockAt(bot, base.offset(-frx, -1, -frz)) || blockAt(bot, base.offset(0,-1,0));
  const rightBase = blockAt(bot, base.offset(frx, -1, frz))   || blockAt(bot, base.offset(0,-1,0));
  if (!leftBase || !rightBase) return false;
  try { await bot.placeBlock(leftBase,{x:0,y:1,z:0}); } catch {}
  try { const leftMid = blockAt(bot, base.offset(-frx, 0, -frz)); if (leftMid) await bot.placeBlock(leftMid,{x:0,y:1,z:0}); } catch {}
  try { await bot.placeBlock(rightBase,{x:0,y:1,z:0}); } catch {}
  try { const rightMid = blockAt(bot, base.offset(frx, 0, frz)); if (rightMid) await bot.placeBlock(rightMid,{x:0,y:1,z:0}); } catch {}
  try { const topBase = blockAt(bot, base.offset(0,1,0)); if (topBase) await bot.placeBlock(topBase,{x:0,y:1,z:0}); } catch {}
  return true;
}

async function digSlice3x3Down(bot, ahead=0){
  const base = floored(bot);
  const { dx, dz } = forwardVec(bot);
  const { rx, rz } = rightVec(bot);
  const fdx=Math.round(dx), fdz=Math.round(dz);
  const frx=Math.round(rx), frz=Math.round(rz);

  await ensureBestPick(bot);

  for (let ax=-1; ax<=1; ax++){
    for (let az=-1; az<=1; az++){
      const p = base.offset(frx*ax + fdx*ahead, -1, frz*ax + fdz*ahead);
      const n = blockName(bot,p); if (!n) continue;
      if (isDangerName(n)){ if (isLiquidName(n)) await placeSolid(bot,p); return false; }
      try { const b = blockAt(bot,p); if (b && b.name!=='air' && b.name!=='bedrock'){ await bot.dig(b); } } catch {}
    }
  }
  return true;
}

async function stepDownAesthetic(bot, ticks){
  const okLow = await digSlice3x3Down(bot,0); if (!okLow) return false;
  const okFr  = await digSlice3x2(bot,1);     if (!okFr)  return false;
  await stepForward(bot, ticks);
  return true;
}

async function prettyStep(bot, ctx){
  const mob = nearestHostile(bot, ctx.hostileScan);
  if (mob){ ChatLimiter.say(bot,'⚠️ Моб — меняю курс'); await lookRelative(bot, Math.PI); await waitTicks(bot,2); return false; }

  const {dx,dz}=forwardVec(bot);
  const aheadGround = blockAt(bot, floored(bot).offset(Math.round(dx), -1, Math.round(dz)));
  if (!aheadGround || aheadGround.name==='air' || isDangerName(aheadGround.name)){
    const ok = await placeSolid(bot, floored(bot).offset(Math.round(dx), 0, Math.round(dz)));
    if (!ok){ ChatLimiter.say(bot,'⚠️ Обрыв — ухожу'); return false; }
  }

  const okDig = await digSlice3x2(bot,1);
  if (!okDig){ ChatLimiter.say(bot,'⚠️ Препятствие — меняю курс'); return false; }

  await stepForward(bot, ctx.stepTicks);

  // свет / факелы
  if (ctx.placeTorches){
    let dim = false;
    try {
      const ahead = blockAt(bot, floored(bot));
      if (bot.world?.getLight && ahead) dim = bot.world.getLight(ahead) < ctx.lightThreshold;
    } catch {}
    ctx.stepsSinceTorch++;
    if (dim || ctx.stepsSinceTorch >= ctx.torchEvery){
      // скрафтить при нехватке
      if (ctx.autoCraftTorches) await craftTorchesIfNeeded(bot, 12);
      const placed = await placeTorchesSymmetric(bot) || await placeTorchFloorOrWall(bot);
      if (placed) ctx.stepsSinceTorch = 0;
    }
  }

  if (ctx.placeFrames){
    ctx.stepsSinceFrame++;
    if (ctx.stepsSinceFrame >= ctx.frameEvery){ await buildFrame(bot); ctx.stepsSinceFrame = 0; }
  }
  return true;
}

function styleController(ctx){
  const s = ctx.style;
  if (s==='serpentine'){
    let len = 10, dir=1, left=len;
    return async (bot)=>{ if (--left<=0){ await lookRelative(bot, (dir>0? Math.PI/2 : -Math.PI/2)); dir*=-1; len = 10 + rndInt(0,6); left=len; } };
  }
  if (s==='grid'){ let K = 8, left=K; return async (bot)=>{ if (--left<=0){ await lookRelative(bot, Math.PI/2); left=K; } }; }
  if (s==='spiral'){ let seg=6, left=seg, r=0; return async (bot)=>{ if (--left<=0){ await lookRelative(bot, Math.PI/2); r++; if (r%2===0) seg+=4; left=seg; } }; }
  if (s==='ant'){ return async (bot)=>{ if (rndInt(1,5)===1){ await lookRelative(bot, rndChoice([Math.PI/8, -Math.PI/8])); } }; }
  return async ()=>{};
}

// ──────────────────────────────────────────────────────────────────────────────
async function findNearbyChestBlock(bot, center, radius=4){
  const c = center.clone(); const r = Math.max(1, Math.floor(radius));
  for (let dx=-r; dx<=r; dx++) for (let dy=-1; dy<=1; dy++) for (let dz=-r; dz<=r; dz++){
    const p = c.offset(dx, dy, dz); const b = blockAt(bot, p); if (b && CHEST_NAMES.has(b.name)) return b;
  }
  return null;
}
async function placeChestAt(bot, nearPos, kind='chest'){
  if (!CHEST_NAMES.has(kind)) kind='chest';
  const it = invItems(bot).find(i=>i.name===kind); if (!it) return null;
  try { await bot.equip(it,'hand'); } catch { return null; }
  const base = blockAt(bot, nearPos.offset(0,-1,0)) || blockAt(bot, bot.entity.position.offset(0,-1,0));
  if (!base) return null;
  try { await bot.placeBlock(base,{x:0,y:1,z:0}); const chest = findNearbyChestBlock(bot, nearPos, 2); return await chest; } catch { return null; }
}
function isKeepItem(it){ if (!it?.name) return true; if (isPick(it.name)) return true; if (TORCH_NAMES.has(it.name)) return true; if (FILL_BLOCKS.includes(it.name)) return true; return false; }
async function depositToChest(bot, ctx){
  try{
    const HOME = ctx.HOME.floored ? ctx.HOME : ctx.HOME.clone();
    if (GoalNear){ try{ setMovements(bot); await bot.pathfinder.goto(new GoalNear(Math.floor(HOME.x), Math.floor(HOME.y), Math.floor(HOME.z), 2)); }catch{} }
    let chestBlock = await findNearbyChestBlock(bot, HOME, 4);
    if (!chestBlock){ chestBlock = await placeChestAt(bot, HOME, ctx.chestKind); if (!chestBlock){ ChatLimiter.say(bot,'📦 Нет сундука — пропускаю'); return false; } }
    let chest=null; try { chest = await bot.openChest(chestBlock); } catch {}
    if (!chest){ ChatLimiter.say(bot,'📦 Не могу открыть сундук'); return false; }
    for (const it of invItems(bot)){ if (isKeepItem(it)) continue; try { await chest.deposit(it.type, null, it.count); } catch {} if (perf?.cd && !perf.cd?.('deposit',80)) await waitTicks(bot,1); }
    try { chest.close(); } catch {}
    ChatLimiter.say(bot,'✅ Лут выгружен');
    return true;
  }catch{ return false; }
}

// ──────────────────────────────────────────────────────────────────────────────
// AESTHETIC основной цикл
// ──────────────────────────────────────────────────────────────────────────────
async function chooseDir(bot){
  const yaw = rndChoice([Math.PI/2,-Math.PI/2,Math.PI,0,Math.PI/4,-Math.PI/4]);
  await lookRelative(bot, yaw);
  if (perf?.cd && !perf.cd?.('look',120)) await waitTicks(bot,1);
}
async function tunnelLoop(bot, ctx){
  const styleTick = styleController(ctx);
  const wd = makeWatchdog(bot, ctx);
  ChatLimiter.say(bot, (ctx.mode==='branch' ? '🚇 Магистраль+ответвления 3×2' : '🚇 Тоннели 3×2') + ` • стиль: ${ctx.style}`);
  let stepsAlong = 0, branchSide = 1;
  while (ctx.running){
    wd.touch(); await wd.check();

    if (dist(bot.entity.position, ctx.HOME) > ctx.radius){ ChatLimiter.say(bot,'↩️ Далеко от HOME — возвращаюсь'); ctx.state=STATE.RETURN_HOME; }
    if (ctx.autoReturnOnFull && inventoryFull(bot,1)){ ChatLimiter.say(bot,'🎒 Инвентарь полон — домой'); ctx.state=STATE.RETURN_HOME; }
    const best = bestPickItem(bot);
    if (!best){ ChatLimiter.say(bot,'⛏️ Кирки нет — домой'); ctx.state=STATE.RETURN_HOME; }
    else if (itemDurabilityLeft(bot,best) < ctx.minPickDurability){ ChatLimiter.say(bot,'⛏️ Кирка низкая — домой'); ctx.state=STATE.RETURN_HOME; }

    switch (ctx.state){
      case STATE.CHOOSE_DIR: await chooseDir(bot); ctx.state = STATE.DIG_STEP; break;

      case STATE.DIG_STEP: {
        const ok = await prettyStep(bot, ctx);
        if (!ok) { ctx.state = STATE.AVOID; break; }
        await styleTick(bot);
        stepsAlong++;
        if (ctx.mode==='branch' && stepsAlong % ctx.branchEvery === 0){ ctx.state = STATE.BRANCH_START; break; }
        ctx.state = STATE.CHOOSE_DIR; break;
      }

      case STATE.BRANCH_START:
        await lookRelative(bot, branchSide>0 ? Math.PI/2 : -Math.PI/2);
        ctx.branchLeft = ctx.branchLen; ctx.state = STATE.BRANCH_STEP; break;

      case STATE.BRANCH_STEP: {
        if (ctx.branchLeft <= 0){
          await lookRelative(bot, branchSide>0 ? -Math.PI/2 : Math.PI/2);
          branchSide *= -1; ctx.state = STATE.CHOOSE_DIR; break;
        }
        const ok = await prettyStep(bot, ctx);
        if (!ok){ await lookRelative(bot, branchSide>0 ? -Math.PI/2 : Math.PI/2); branchSide *= -1; ctx.state = STATE.CHOOSE_DIR; break; }
        ctx.branchLeft--; break;
      }

      case STATE.AVOID: await lookRelative(bot, rndChoice([Math.PI/2, -Math.PI/2])); await waitTicks(bot,1); ctx.state = STATE.CHOOSE_DIR; break;

      case STATE.RETURN_HOME:
        try{ if (GoalNear){ setMovements(bot); await bot.pathfinder.goto(new GoalNear(Math.floor(ctx.HOME.x), Math.floor(ctx.HOME.y), Math.floor(ctx.HOME.z), 2)); } }catch{}
        ctx.state = ctx.autoDeposit ? STATE.DEPOSIT : STATE.STOPPED; break;

      case STATE.DEPOSIT:
        if (ctx.autoDeposit){ await depositToChest(bot, ctx); }
        ChatLimiter.say(bot,'🏠 Пауза у HOME');
        ctx.running = false; ctx.state = STATE.STOPPED;
        ctx.ev.emit('state', { state: 'STOPPED', reason: 'deposit_done' }); return;
    }
    if (perf?.cd && !perf.cd?.('loop',100)) await waitTicks(bot,1);
    await waitTicks(bot,1);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// LAYERED — fallback (если minerCore нет). 2×2 лестница + лево/право.
// ──────────────────────────────────────────────────────────────────────────────
async function digSliceWxH(bot, w=2, h=2, ahead=1){
  const base = floored(bot);
  const { dx, dz } = forwardVec(bot);
  const { rx, rz } = rightVec(bot);
  const fdx=Math.round(dx), fdz=Math.round(dz);
  const frx=Math.round(rx), frz=Math.round(rz);

  await ensureBestPick(bot);

  // боковые смещения: 0 и 1 «вправо» — даёт ровный 2-ширинный тоннель
  const sides = w===2 ? [0,1] : [-1,0,1]; // на случай w=3
  for (const s of sides){
    for (let hh=0; hh<h; hh++){
      const p = base.offset(frx*s + fdx*ahead, hh, frz*s + fdz*ahead);
      const n = blockName(bot,p); if (!n) continue;
      if (isDangerName(n)){ if (isLiquidName(n)) await placeSolid(bot,p); return false; }
      try { const b = blockAt(bot,p); if (b && b.name!=='air' && b.name!=='bedrock') await bot.dig(b); } catch {}
      if (perf?.cd && !perf.cd?.('slice2',80)) await waitTicks(bot,1);
    }
  }
  return true;
}
async function digSlice2x3Down(bot){ // для шага лестницы (подрубить пол 2×1 и фронт 2×2)
  const base = floored(bot);
  const { dx, dz } = forwardVec(bot);
  const { rx, rz } = rightVec(bot);
  const fdx=Math.round(dx), fdz=Math.round(dz);
  const frx=Math.round(rx), frz=Math.round(rz);
  await ensureBestPick(bot);

  // низ под шаг
  for (const s of [0,1]){
    const p = base.offset(frx*s, -1, frz*s);
    const n = blockName(bot,p); if (!n) continue;
    if (isDangerName(n)){ if (isLiquidName(n)) await placeSolid(bot,p); return false; }
    try { const b = blockAt(bot,p); if (b && b.name!=='air' && b.name!=='bedrock') await bot.dig(b); } catch {}
  }
  // фронт
  return await digSliceWxH(bot, 2, 2, 1);
}
async function stepDown2x2(bot, ticks){ const ok1 = await digSlice2x3Down(bot); if (!ok1) return false; await stepForward(bot, ticks); return true; }

async function maybePlaceTorch(bot, ctx){
  let dim = false;
  try {
    const b = blockAt(bot, floored(bot));
    if (bot.world?.getLight && b) dim = bot.world.getLight(b) < ctx.lightThreshold;
  } catch {}
  ctx.stepsSinceTorch++;
  if (dim || ctx.stepsSinceTorch >= ctx.torchEvery){
    if (ctx.autoCraftTorches) await craftTorchesIfNeeded(bot, 12);
    const placed = await placeTorchFloorOrWall(bot);
    if (placed) ctx.stepsSinceTorch = 0;
  }
}

async function digTunnel2x2(bot, ctx, len){
  for (let i=0; i<len && ctx.running; i++){
    const ok = await digSliceWxH(bot, 2, 2, 1);
    if (!ok) return false;
    await stepForward(bot, ctx.ticksPerStep);
    await maybePlaceTorch(bot, ctx);
    if (perf?.cd && !perf.cd?.('layered_t',100)) await waitTicks(bot,1);
  }
  return true;
}

async function doLayerFallback(bot, ctx, layerIndex){
  // спускаемся на stairSteps
  for (let i=0; i<ctx.stairSteps && ctx.running; i++){
    const best = bestPickItem(bot);
    if (!best || itemDurabilityLeft(bot,best) < ctx.minPickDurability) return false;
    if (ctx.autoReturnOnFull && inventoryFull(bot,1)) return false;
    const ok = await stepDown2x2(bot, ctx.ticksPerStep);
    if (!ok) { await lookRelative(bot, rndChoice([Math.PI/2, -Math.PI/2, Math.PI])); await waitTicks(bot,2); i--; continue; }
    if (perf?.cd && !perf.cd?.('layered_s',100)) await waitTicks(bot,1);
  }

  // ветка влево
  await lookRelative(bot, -Math.PI/2);
  await digTunnel2x2(bot, ctx, ctx.tunnelLen);
  // назад к хабу
  await lookRelative(bot, Math.PI);
  for (let i=0; i<ctx.tunnelLen && ctx.running; i++){ bot.setControlState('forward', true); await waitTicks(bot, ctx.ticksPerStep); }
  bot.setControlState('forward', false);

  // ветка вправо
  await lookRelative(bot, -Math.PI/2); // от "назад" это снова право
  await digTunnel2x2(bot, ctx, ctx.tunnelLen);
  // назад к хабу
  await lookRelative(bot, Math.PI);
  for (let i=0; i<ctx.tunnelLen && ctx.running; i++){ bot.setControlState('forward', true); await waitTicks(bot, ctx.ticksPerStep); }
  bot.setControlState('forward', false);

  // шанс развернуться перед следующей лесенкой
  if (Math.random() < ctx.reverseChance) await lookRelative(bot, Math.PI);
  return true;
}

async function layeredFallbackRunner(bot, ctx){
  // посчитать слои если нужно
  let layers = ctx.layers;
  if (!Number.isFinite(layers) || layers == null){
    const curY = Math.floor(bot.entity.position.y);
    const delta = Math.max(0, curY - ctx.targetY);
    const perLayer = Math.max(1, ctx.stairSteps|0);
    layers = Math.max(1, Math.ceil(delta / perLayer));
  }

  const wd = makeWatchdog(bot, ctx);
  ctx._layerIndex = ctx._layerIndex || 0;
  while (ctx.running && ctx._layerIndex < layers){
    wd.touch(); await wd.check();

    if (dist(bot.entity.position, ctx.HOME) > ctx.radius){ ChatLimiter.say(bot,'↩️ Далеко от HOME — возвращение'); if (!(await returnAndMaybeDeposit(bot, ctx))) break; }
    if (ctx.autoReturnOnFull && inventoryFull(bot,1)){ if (!(await returnAndMaybeDeposit(bot, ctx))) break; }

    const ok = await doLayerFallback(bot, ctx, ctx._layerIndex);
    if (!ok){ // препятствие → пробуем сменить сторону и повторить слой
      await lookRelative(bot, rndChoice([Math.PI/2, -Math.PI/2, Math.PI]));
      continue;
    }

    ctx._layerIndex++;

    // периодический депозит
    if (ctx.autoDeposit && ctx.depositEveryLayers>0 && (ctx._layerIndex % ctx.depositEveryLayers===0)){
      const savedYaw = bot.entity.yaw;
      const savedPos = bot.entity.position.clone();
      await depositToChest(bot, ctx);
      if (ctx.resumeAfterDeposit){
        // вернуться к точке слоя (приблизительно)
        try{
          if (GoalNear) { setMovements(bot); await bot.pathfinder.goto(new GoalNear(Math.floor(savedPos.x), Math.floor(savedPos.y), Math.floor(savedPos.z), 2)); }
          await bot.look(savedYaw, 0, false);
        }catch{}
      } else break;
    }
  }
  ChatLimiter.say(bot, '🏁 Layered: завершено');
  return true;
}

async function returnAndMaybeDeposit(bot, ctx){
  try{
    if (GoalNear){ setMovements(bot); await bot.pathfinder.goto(new GoalNear(Math.floor(ctx.HOME.x), Math.floor(ctx.HOME.y), Math.floor(ctx.HOME.z), 2)); }
    if (ctx.autoDeposit){ await depositToChest(bot, ctx); }
    return true;
  }catch{ return false; }
}

// ──────────────────────────────────────────────────────────────────────────────
// Экспорт агента
// ──────────────────────────────────────────────────────────────────────────────
module.exports = function makeMiner(bot){
  if (!bot || !bot.entity) throw new Error('miner: нужен bot');
  const ev = new EventEmitter();

  // masterAI (мягко)
  let master = null; try { master = require('../masterAI.cjs'); } catch {}

  let ctx = {
    running: false,
    state: STATE.INIT,
    HOME: null,
    stepsSinceTorch: 0,
    stepsSinceFrame: 0,
    ev,
    ...DEFAULTS
  };

  // core (если есть)
  let core = null;

  function status(){
    return {
      running: ctx.running,
      state: Object.keys(STATE).find(k=>STATE[k]===ctx.state),
      HOME: ctx.HOME && { x: ctx.HOME.x, y: ctx.HOME.y, z: ctx.HOME.z },
      mode: ctx.mode, style: ctx.style, radius: ctx.radius, targetY: ctx.targetY,
      torchEvery: ctx.torchEvery, lightThreshold: ctx.lightThreshold, autoCraftTorches: ctx.autoCraftTorches,
      branchEvery: ctx.branchEvery, branchLen: ctx.branchLen, frameEvery: ctx.frameEvery,
      layered: { stairSteps: ctx.stairSteps, tunnelLen: ctx.tunnelLen, layers: ctx.layers, reverseChance: ctx.reverseChance },
      autoDeposit: ctx.autoDeposit, chestKind: ctx.chestKind, depositEveryLayers: ctx.depositEveryLayers, resumeAfterDeposit: ctx.resumeAfterDeposit
    };
  }

  async function start(opts={}){
    if (ctx.running) return;
    ctx.running = true;

    for (const k of Object.keys(DEFAULTS)) if (k in (opts||{})) ctx[k] = opts[k];
    ctx.stepsSinceTorch = 0; ctx.stepsSinceFrame = 0; ctx._layerIndex = 0;
    ctx.HOME = bot.entity.position.clone(); ctx.state = STATE.PREP;

    ev.emit('state', { state: 'PREP' });
    ev.emit('log', 'miner: start');
    try { log.info('start', { opts }); } catch {}
    try { master?.disableGuardForWork?.(); } catch {}

    try{
      setMovements(bot);

      if (ctx.mode === 'layered'){
        if (makeMinerCore){
          core = makeMinerCore(bot);
          core.on('log', (m)=>ev.emit('log', m));
          core.on('state', (s)=>ev.emit('state', { source:'core', ...s }));
          core.on('hazard', (h)=>ev.emit('hazard', h));

          // слои (если не заданы — посчитаем как и в fallback)
          let layers = ctx.layers;
          if (!Number.isFinite(layers) || layers == null){
            const curY = Math.floor(bot.entity.position.y);
            const delta = Math.max(0, curY - ctx.targetY);
            const perLayer = Math.max(1, ctx.stairSteps|0);
            layers = Math.max(1, Math.ceil(delta / perLayer));
          }

          await core.runLayered({
            layers,
            stairSteps: ctx.stairSteps, tunnelLen: ctx.tunnelLen,
            torchEvery: ctx.torchEvery, lightThreshold: ctx.lightThreshold,
            reverseChance: ctx.reverseChance,
            width: ctx.width, height: ctx.height,
            ticksPerStep: ctx.ticksPerStep,
            hostileScan: ctx.hostileScan,
            autoCraftTorches: ctx.autoCraftTorches
          });

          if (ctx.autoDeposit) await depositToChest(bot, ctx);
          ChatLimiter.say(bot,'🏁 Layered(core): завершено');
        } else {
          // встроенный fallback
          await layeredFallbackRunner(bot, ctx);
        }
        ctx.running = false; ctx.state = STATE.STOPPED; return;
      }

      // AESTHETIC
      ctx.state = STATE.STAIRS; ev.emit('state',{state:'STAIRS'});
      // спуститься «аккуратно», но останемся на 3×2 эстетике
      while (Math.floor(bot.entity.position.y) > ctx.targetY && ctx.running){
        if (ctx.autoReturnOnFull && inventoryFull(bot,1)){ ctx.state = STATE.RETURN_HOME; break; }
        const best = bestPickItem(bot);
        if (!best){ ChatLimiter.say(bot,'⛏️ Нет кирки — домой'); ctx.state=STATE.RETURN_HOME; break; }
        if (itemDurabilityLeft(bot,best) < ctx.minPickDurability){ ChatLimiter.say(bot,'⛏️ Кирка на исходе — домой'); ctx.state=STATE.RETURN_HOME; break; }
        const ok = await stepDownAesthetic(bot, ctx.stepTicks);
        if (!ok){ await lookRelative(bot, rndChoice([Math.PI/2, -Math.PI/2, Math.PI])); await waitTicks(bot,2); }
        await waitTicks(bot, perf?1:2);
      }

      if (ctx.state !== STATE.RETURN_HOME){
        ctx.state = STATE.CHOOSE_DIR; ev.emit('state',{state:'TUNNEL', style: ctx.style});
        await tunnelLoop(bot, ctx);
      }
    } catch (e){
      ChatLimiter.say(bot,'❌ Ошибка майнинга');
      ev.emit('log', String(e?.message||e));
    } finally {
      try { bot.clearControlStates?.(); } catch {}
      try { master?.enableGuard?.(); } catch {}
      ev.emit('log','miner: stop');
      ctx.running = false; ctx.state = STATE.STOPPED;
    }
  }

  async function stop(){
    if (!ctx.running) return;
    ctx.running = false;
    ctx.state = STATE.STOPPED;
    try { core?.stop?.(); } catch {}
    try { bot.clearControlStates?.(); } catch {}
    try { master?.enableGuard?.(); } catch {}
    ChatLimiter.say(bot, '🛑 Шахтёр остановлен');
    ev.emit('state', { state: 'STOPPED', reason: 'manual' });
  }

  return { start, stop, status, on:(...a)=>ev.on(...a), off:(...a)=>ev.off(...a) };
};
