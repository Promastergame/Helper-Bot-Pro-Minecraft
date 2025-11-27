'use strict';
/**
 * features/ai/agents/minerCore.cjs — v1.0 "Layered-2x2 Core"
 * Ядро многоуровневого майнинга:
 *  • Лестница 2×2 вниз (мягкие шаги с заплатками пола/жидкостей)
 *  • На каждом "этаже": тоннели влево и вправо
 *  • Повтор слоёв (stairs → left → right → stairs → ...)
 *  • Редкие развороты курса (как человек)
 *  • События: 'log' | 'hazard' | 'state' | 'progress'
 *
 * API:
 *   const core = require('./features/ai/agents/minerCore.cjs')(bot);
 *   core.ops.stepDown2x2({ticks:6})
 *   core.ops.digStairs2x2Steps(8, {ticks:6})
 *   core.ops.digTunnel({length:20, width:2, height:2, torchEvery:8})
 *   core.ops.branchPair({length:16})
 *   core.runLayered({
 *     layers: 6, stairSteps: 8, tunnelLen: 20,
 *     torchEvery: 8, reverseChance: 0.15
 *   })
 *   core.stop()
 *   core.status()
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');

let perf = null;
try { perf = require('../../ai/quantum/performance.cjs'); } catch {}

const {
  placeBlockSmart, findNearbyBlock, smoothMove, isSafeFromMob,
  sleep, safeChat
} = require('../../utils/helpers.js');

const { Movements, goals } = (()=>{ try { return require('mineflayer-pathfinder'); } catch { return {}; } })();
const { GoalNear } = goals || {};

// ──────────────────────────────────────────────────────────────────────────────
// Константы / наборы
// ──────────────────────────────────────────────────────────────────────────────
const LIQUIDS = new Set(['water','flowing_water','lava','flowing_lava','bubble_column']);
const DANGERS = new Set([...LIQUIDS, 'cave_air', 'void_air']);
const TORCH_NAMES = new Set(['torch','soul_torch']);
const FILL_BLOCKS = ['cobblestone','stone','deepslate','dirt','netherrack','andesite','diorite','granite'];
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
  'shulker','silverfish',
  'breeze','hoglin','zoglin','warden'
]);

const DEFAULTS = {
  ticksPerStep: 6,
  hostileScan: 7,
  torchEvery: 8,
  width: 2,
  height: 2,
  reverseChance: 0.12 // шанс редкого разворота на слоях
};

// ──────────────────────────────────────────────────────────────────────────────
// Мелкие утилиты
// ──────────────────────────────────────────────────────────────────────────────
const waitTicks = async (bot,t)=> perf?.yieldTicks ? await perf.yieldTicks(bot,t) : await sleep(t*50);
const rndInt = (a,b)=> { const span=(b-a+1)>>>0; const n=crypto.randomBytes(4).readUInt32LE(0)>>>0; return a + (n%span); };
const rndChoice = arr => arr[rndInt(0,arr.length-1)];

function mcData(bot){ try { return require('minecraft-data')(bot.version); } catch { return null; } }
function floored(bot){ return bot.entity.position.floored(); }
function forwardVec(bot){ const yaw=bot.entity.yaw; return {dx:Math.sin(yaw), dz:Math.cos(yaw)}; }
function rightVec(bot){ const {dx,dz}=forwardVec(bot); return {rx:dz, rz:-dx}; }
function blockAt(bot, pos){ try { return bot.blockAt(pos); } catch { return null; } }
function blockName(bot,pos){ return blockAt(bot,pos)?.name ?? null; }
function isDangerName(n){ return !!n && DANGERS.has(n); }
function isLiquidName(n){ return !!n && LIQUIDS.has(n); }
function equipMatch(bot, pred){ const it = (bot.inventory?.items?.()||[]).find(pred); if (!it) return null; return bot.equip(it,'hand').then(()=>it).catch(()=>null); }
function invItems(bot){ try { return bot.inventory?.items?.() || []; } catch { return []; } }
function emptySlots(bot){ try { return bot.inventory?.emptySlotCount?.() ?? 0; } catch { return 0; } }
const inventoryFull = (bot,reserve=1)=> emptySlots(bot) <= reserve;

const PICK_TIERS = ['netherite','diamond','iron','stone','golden','wooden'];
const isPick = n => /_pickaxe$/.test(n||'');
function bestPickItem(bot){
  const its = invItems(bot).filter(i=>isPick(i.name));
  its.sort((a,b)=> PICK_TIERS.indexOf(a.name.split('_')[0]) - PICK_TIERS.indexOf(b.name.split('_')[0]));
  return its[0] || null;
}
function itemMaxDurability(bot,item){
  try { const mc=mcData(bot); const meta = mc?.items?.[item.type]; return meta?.maxDurability || Infinity; } catch { return Infinity; }
}
function itemDurabilityLeft(bot,item){
  try { if (!item) return Infinity; const max=itemMaxDurability(bot,item); const used=item.durabilityUsed ?? 0; return Math.max(0,max-used); } catch { return Infinity; }
}
async function ensureBestPick(bot){ const it=bestPickItem(bot); if (!it) return false; try { await bot.equip(it,'hand'); return true; } catch { return false; } }

const ChatLimiter = (()=>{ let last=0,gap=1100; return { say(bot,msg){ const t=Date.now(); if(t-last>=gap){ try{bot.chat(String(msg));}catch{} last=t; } } };})();

function setMovements(bot){
  try{
    const mc = mcData(bot); if (!mc || !Movements) return;
    const m = new Movements(bot, mc);
    m.allow1by1towers=false; m.parkour=false; m.maxDropDownDistance=3; m.canOpenDoors=true;
    bot.pathfinder?.setMovements(m);
  } catch {}
}
async function lookRelative(bot, yawDelta){ try { await bot.look(bot.entity.yaw + yawDelta, 0, false); } catch {} }
async function stepForward(bot,ticks){ bot.setControlState('forward',true); await waitTicks(bot,ticks); bot.setControlState('forward',false); }

// ──────────────────────────────────────────────────────────────────────────────
// Безопасность / окружение
// ──────────────────────────────────────────────────────────────────────────────
function nearestHostile(bot,within=7){
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

async function placeAnySolid(bot,targetPos){
  // найдём любой "каменистый" блок в инвентаре и поставим его в targetPos
  const it = invItems(bot).find(i=>FILL_BLOCKS.includes(i.name));
  if (!it) return false;
  const ok = await placeBlockSmart(bot, it.name, new Vec3(targetPos.x,targetPos.y,targetPos.z), {
    requireLineOfSight:false, retries:2, returnInfo:true
  });
  return !!ok?.ok || ok===true;
}

async function placeAnyTorch(bot,targetPos){
  const it = invItems(bot).find(i=>TORCH_NAMES.has(i.name));
  if (!it) return false;
  const ok = await placeBlockSmart(bot, it.name, new Vec3(targetPos.x,targetPos.y,targetPos.z), {
    wall:false, requireLineOfSight:false, retries:2, returnInfo:true
  });
  return !!ok?.ok || ok===true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Копка: 2×2 лестница вниз (один шаг) и 2×(height) тоннели (width=2 по умолчанию)
// ──────────────────────────────────────────────────────────────────────────────
async function digStep2x2Front(bot, ahead=1, height=2){
  // копаем "фронт" шириной 2 и высотой height
  const base = floored(bot);
  const {dx,dz}=forwardVec(bot); const {rx,rz}=rightVec(bot);
  const fdx=Math.round(dx), fdz=Math.round(dz), frx=Math.round(rx), frz=Math.round(rz);
  await ensureBestPick(bot);

  for (let side=0; side<=1; side++){
    for (let h=0; h<height; h++){
      const p = base.offset(frx*side + fdx*ahead, h, frz*side + fdz*ahead);
      const n = blockName(bot,p); if (!n) continue;
      if (isDangerName(n)){
        if (isLiquidName(n)) await placeAnySolid(bot,p);
        return false;
      }
      try { const b=blockAt(bot,p); if (b && b.name!=='air' && b.name!=='bedrock') await bot.dig(b); } catch {}
      if (perf?.cd && !perf.cd?.('digFront',80)) await waitTicks(bot,1);
    }
  }
  return true;
}

async function stepDown2x2(bot,{ticks=DEFAULTS.ticksPerStep,height=2}={}){
  // делаем "ступень" вниз: выкапываем пол ниже и фронт, потом шагаем
  const base=floored(bot);
  const {dx,dz}=forwardVec(bot); const {rx,rz}=rightVec(bot);
  const fdx=Math.round(dx), fdz=Math.round(dz), frx=Math.round(rx), frz=Math.round(rz);

  // пол на следующем шаге (2 блока)
  for (let side=0; side<=1; side++){
    const hole = base.offset(frx*side + fdx*1, -1, frz*side + fdz*1);
    const n = blockName(bot,hole);
    if (isDangerName(n)){
      // жидкость/пустота → пытаемся закрыть, иначе отмена шага
      if (!(await placeAnySolid(bot, hole))) return false;
    }
    try { const b=blockAt(bot,hole); if (b && b.name!=='air' && b.name!=='bedrock') await bot.dig(b); } catch {}
  }

  // фронт (высота 2)
  const okFr = await digStep2x2Front(bot,1,height);
  if (!okFr) return false;

  // шаг вперёд (упадём на 1 блок вниз)
  await stepForward(bot, ticks);
  return true;
}

async function digTunnel(bot,{length=20,width=2,height=2,torchEvery=DEFAULTS.torchEvery,hostileScan=DEFAULTS.hostileScan,ticks=DEFAULTS.ticksPerStep, events}={}){
  let steps=0, sinceTorch=0;
  while (steps<length){
    // мобы
    const mob = nearestHostile(bot, hostileScan);
    if (mob){
      events?.emit('hazard', { type:'mob', name: mob.name, pos: mob.position });
      ChatLimiter.say(bot,'⚠️ Моб — меняю курс');
      await lookRelative(bot, Math.PI);
      await waitTicks(bot,2);
      return steps; // выходим из тоннеля
    }

    // пол под следующим шагом
    const {dx,dz}=forwardVec(bot);
    const nextFloor = blockAt(bot, floored(bot).offset(Math.round(dx), -1, Math.round(dz)));
    if (!nextFloor || isDangerName(nextFloor.name)){
      const ok = await placeAnySolid(bot, floored(bot).offset(Math.round(dx), 0, Math.round(dz)));
      if (!ok){ events?.emit('hazard', { type:'fall', pos: floored(bot) }); return steps; }
    }

    // копаем фронт шириной width и высотой height
    const base=floored(bot); const {rx,rz}=rightVec(bot); const frx=Math.round(rx), frz=Math.round(rz);
    await ensureBestPick(bot);
    let blocked=false;

    for (let side=0; side<width; side++){
      for (let h=0; h<height; h++){
        const p = base.offset(frx*side + Math.round(dx)*1, h, frz*side + Math.round(dz)*1);
        const n = blockName(bot,p); if (!n) continue;
        if (isDangerName(n)){
          if (isLiquidName(n)) await placeAnySolid(bot,p);
          blocked=true; break;
        }
        try { const b=blockAt(bot,p); if (b && b.name!=='air' && b.name!=='bedrock') await bot.dig(b); } catch {}
        if (perf?.cd && !perf.cd?.('digTunnel',80)) await waitTicks(bot,1);
      }
      if (blocked) break;
    }
    if (blocked) return steps;

    await stepForward(bot,ticks);
    steps++; sinceTorch++;

    // факелы
    if (torchEvery>0 && sinceTorch>=torchEvery){
      const floorPos = floored(bot);
      const ok = await placeAnyTorch(bot, floorPos);
      if (ok) sinceTorch=0;
    }

    // мягкий рандом курса (небольшие дрейфы)
    if (rndInt(1,10)===1) await lookRelative(bot, rndChoice([Math.PI/8,-Math.PI/8]));
  }

  return steps;
}

// ──────────────────────────────────────────────────────────────────────────────
// Высокоуровневые операции (ступени/ветвления/слои)
// ──────────────────────────────────────────────────────────────────────────────
async function digStairs2x2Steps(bot, steps=8, {ticks=DEFAULTS.ticksPerStep, minPick=24, hostileScan=DEFAULTS.hostileScan, events}={}){
  let done=0;
  while (done<steps){
    // стоп по мобу / кирке
    const best=bestPickItem(bot);
    if (!best){ ChatLimiter.say(bot,'⛏️ Нет кирки — стоп лестница'); return done; }
    if (itemDurabilityLeft(bot,best) < minPick){ ChatLimiter.say(bot,'⛏️ Кирка на исходе — стоп лестница'); return done; }
    const mob=nearestHostile(bot,hostileScan);
    if (mob){ events?.emit('hazard',{type:'mob',name:mob.name,pos:mob.position}); return done; }

    const ok=await stepDown2x2(bot,{ticks});
    if (!ok){
      // небольшой объезд
      await lookRelative(bot, rndChoice([Math.PI/2,-Math.PI/2,Math.PI]));
      await waitTicks(bot,2);
      return done;
    }
    done++;
    await waitTicks(bot, perf?1:1);
  }
  return done;
}

async function branchOnce(bot,{side='left', length=16, width=2, height=2, torchEvery=DEFAULTS.torchEvery, ticks=DEFAULTS.ticksPerStep, hostileScan=DEFAULTS.hostileScan, events}={}){
  // повернуть на бок
  await lookRelative(bot, side==='left' ? Math.PI/2 : -Math.PI/2);
  const mined = await digTunnel(bot,{length,width,height,torchEvery,ticks,hostileScan,events});
  // вернуться к магистрали и восстановить направление
  await lookRelative(bot, side==='left' ? -Math.PI/2 : Math.PI/2);
  return mined;
}

async function branchPair(bot,{length=16,width=2,height=2,torchEvery=DEFAULTS.torchEvery,ticks=DEFAULTS.ticksPerStep,hostileScan=DEFAULTS.hostileScan,events}={}){
  const left  = await branchOnce(bot,{side:'left', length,width,height,torchEvery,ticks,hostileScan,events});
  const right = await branchOnce(bot,{side:'right',length,width,height,torchEvery,ticks,hostileScan,events});
  return { left, right };
}

// ──────────────────────────────────────────────────────────────────────────────
// Главный сценарий "слоёв": (лестница → ветки → лестница → ...)
// ──────────────────────────────────────────────────────────────────────────────
module.exports = function makeMinerCore(bot){
  if (!bot || !bot.entity) throw new Error('minerCore: нужен bot');
  const ev = new EventEmitter();

  // masterAI (мягко)
  let master=null; try { master = require('../masterAI.cjs'); } catch {}

  // состояние
  const st = {
    running:false,
    HOME:null,
    stats:{ stairsSteps:0, tunnelBlocks:0, layersDone:0 },
    opt:{ ...DEFAULTS, stairSteps:8, tunnelLen:20, layers:4 }
  };

  function status(){
    return {
      running: st.running,
      HOME: st.HOME && { x:st.HOME.x, y:st.HOME.y, z:st.HOME.z },
      stats: { ...st.stats },
      opt: { ...st.opt }
    };
  }

  async function runLayered(userOpt={}){
    if (st.running) return false;
    st.running=true;

    // опции
    st.opt = {
      ...st.opt,
      ...DEFAULTS,
      ...userOpt
    };

    st.HOME = bot.entity.position.clone();
    ev.emit('state', { state:'START' });
    setMovements(bot);
    try { master?.disableGuardForWork?.(); } catch {}

    try{
      for (let L=0; L<(st.opt.layers|0) && st.running; L++){
        ev.emit('state',{state:'STAIRS', layer:L});
        const s = await digStairs2x2Steps(bot, st.opt.stairSteps, {
          ticks: st.opt.ticksPerStep, hostileScan: st.opt.hostileScan, events: ev, minPick: 28
        });
        st.stats.stairsSteps += s;

        if (!st.running) break;

        ev.emit('state',{state:'BRANCHES', layer:L});
        const pair = await branchPair(bot, {
          length: st.opt.tunnelLen, width: st.opt.width, height: st.opt.height,
          torchEvery: st.opt.torchEvery, ticks: st.opt.ticksPerStep,
          hostileScan: st.opt.hostileScan, events: ev
        });
        st.stats.tunnelBlocks += (pair.left||0) + (pair.right||0);

        st.stats.layersDone++;

        // Редкая смена курса (реализм)
        if (Math.random() < st.opt.reverseChance){
          await lookRelative(bot, Math.PI);
          ev.emit('log','reverse course (randomized)');
        }

        // Если инвентарь забит — вернуться к HOME и пауза
        if (inventoryFull(bot,1)){
          ev.emit('state',{state:'RETURN_HOME'});
          ChatLimiter.say(bot,'🎒 Полон — возвращаюсь HOME');
          try{
            if (GoalNear){
              setMovements(bot);
              await bot.pathfinder.goto(new GoalNear(Math.floor(st.HOME.x), Math.floor(st.HOME.y), Math.floor(st.HOME.z), 2));
            } else {
              await smoothMove(bot, st.HOME, 2);
            }
          }catch{}
          // останавливаемся, чтобы наружный код мог разгрузить бота
          break;
        }
      }
    } catch (e){
      ev.emit('log', 'minerCore error: '+(e?.message||e));
      ChatLimiter.say(bot,'❌ minerCore ошибка');
    } finally {
      st.running=false;
      try { bot.clearControlStates?.(); } catch {}
      try { master?.enableGuard?.(); } catch {}
      ev.emit('state', { state:'STOP' });
    }

    return true;
  }

  function stop(){
    if (!st.running) return false;
    st.running=false;
    try { bot.clearControlStates?.(); } catch {}
    ev.emit('state',{state:'STOP', reason:'manual'});
    return true;
  }

  // Публичные примитивы (чтобы /miner.cjs мог использовать точечно)
  const ops = {
    stepDown2x2: (opt)=> stepDown2x2(bot,opt),
    digStairs2x2Steps: (n,opt)=> digStairs2x2Steps(bot,n,{...opt,events:ev}),
    digTunnel: (opt)=> digTunnel(bot,{...opt,events:ev}),
    branchOnce: (opt)=> branchOnce(bot,{...opt,events:ev}),
    branchPair: (opt)=> branchPair(bot,{...opt,events:ev})
  };

  return {
    runLayered, stop, status, ops,
    on: (...a)=>ev.on(...a), off:(...a)=>ev.off(...a)
  };
};
