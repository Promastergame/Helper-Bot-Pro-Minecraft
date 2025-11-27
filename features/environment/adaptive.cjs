'use strict';
// ===============================
// features/environment/adaptive.cjs — v8 Pro
// 🌍 Адаптация под окружение (биомы, время суток, опасности, свет)
// • больше опасностей: lava/water/magma/cactus/berries/fire/campfire/powder_snow
// • бережные циклы, анти-спам, коалесинг сообщений
// • умная постановка факела (потолок/стенки/пол), cooldown + skyOnly
// • подпорка под ногами при риске падения (white-list блоков)
// • дружба с brain.reportHazard(level), мягкие отходы/strafe, yawAway
// • безопасные fallback’и при отсутствии utils/helpers.js
// ===============================

const { Vec3 } = require('vec3');

// ─── helpers (safe fallbacks) ───
let placeBlockSmart = null, findNearbyBlock = null, sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
try {
  const h = require('../utils/helpers.js');
  placeBlockSmart = h.placeBlockSmart || null;
  findNearbyBlock  = h.findNearbyBlock  || null;
  sleep = h.sleep || sleep;
} catch { /* optional */ }

// ───────────────────────────────────────────────────────────────────────────────
// Настройки по умолчанию
// ───────────────────────────────────────────────────────────────────────────────
const defaults = {
  chat: {
    enabled: true,
    minGapMs: 9000,
    biomeMsgCooldownMs: 90000,
    dayPhaseCooldownMs: 60000,
    hazardMsgCooldownMs: 12000,
    torchMsgCooldownMs: 25000
  },
  sense: {
    hazardScanMs: 850,
    contextScanMs: 3000,
    hazardRadius: 6,
    fallProbeRadius: 2,
    fallMaxDepth: 6,
    suffocationCheck: true,
    suffocationHeadOffset: 1.6
  },
  night: {
    startTick: 12000,
    placeTorch: true,
    lightCheck: true,
    minLightLevel: 8,
    skyOnly: false,
    torchNames: ['torch'],
    torchCooldownMs: 15000
  },
  avoid: {
    lava: true, water: true, cactus: true, magma: true, sweetBerry: true,
    fire: true, campfire: true, powderSnow: true,
    yawAway: true,
    stepBackMs: 260, strafeMs: 280, lockMoveMs: 650
  },
  fall: {
    enabled: true,
    buildSupport: true,
    supportWhitelist: [
      'cobblestone','stone','dirt','netherrack',
      'oak_planks','spruce_planks','birch_planks','sandstone'
    ],
    placeCooldownMs: 4000,
    chatOnSupport: true
  },
  integration: {
    withBrain: true,
    brainQuietLevelMap: { minor:1, moderate:2, severe:3 }
  },
  debug: { log: false }
};

// ───────────────────────────────────────────────────────────────────────────────
// TTLMap / LRUSet
// ───────────────────────────────────────────────────────────────────────────────
class TTLMap {
  constructor(defaultTtl=60000){ this.ttl=defaultTtl; this.map=new Map(); }
  set(k,v,ttl=this.ttl){ this.map.set(k,{v,exp:Date.now()+ttl}); }
  get(k){ const e=this.map.get(k); if(!e) return null; if(Date.now()>e.exp){ this.map.delete(k); return null; } return e.v; }
  has(k){ return this.get(k)!==null; }
  delete(k){ this.map.delete(k); }
  clear(){ this.map.clear(); }
}
class LRUSet {
  constructor(limit=8){ this.limit=limit; this.arr=[]; }
  has(v){ return this.arr.includes(v); }
  add(v){ if(this.has(v)) this.arr=this.arr.filter(x=>x!==v); this.arr.push(v); if(this.arr.length>this.limit) this.arr.shift(); }
}

// ───────────────────────────────────────────────────────────────────────────────
// Состояние и таймеры
// ───────────────────────────────────────────────────────────────────────────────
function makeState(bot,opt){
  return {
    bot,opt,timers:[],stopping:false,
    lastBiomeName:null,lastDayPhase:null,
    lastChatAt:0,lastBiomeMsgAt:0,lastDayMsgAt:0,
    lastTorchAt:0,lastTorchMsgAt:0,lastHazardMsgAt:0,
    movingLockUntil:0,
    mem:new TTLMap(60000),
    lruMsgs:new LRUSet(12)
  };
}
function addInterval(st,fn,ms){ const id=setInterval(()=>{ if(!st.stopping) fn(); },ms); st.timers.push(id); return id; }
function clearAll(st){ st.stopping=true; for(const t of st.timers){ clearInterval(t); clearTimeout(t);} st.timers.length=0; }

// ───────────────────────────────────────────────────────────────────────────────
// Безопасный чат
// ───────────────────────────────────────────────────────────────────────────────
function say(st,msg,{force=false}={}){ try{ const S=require('../../core/state.cjs'); if (S?.state?.inCombat && !force) return; }catch{}
  if(!st.opt.chat.enabled) return;
  const now=Date.now();
  if(!force && now-st.lastChatAt<st.opt.chat.minGapMs) return;
  if(st.lruMsgs.has(msg) && !force) return;
  try{ st.bot.chat(msg);}catch{}
  st.lruMsgs.add(msg);
  st.lastChatAt=now;
}

// ───────────────────────────────────────────────────────────────────────────────
// Контекст мира
// ───────────────────────────────────────────────────────────────────────────────
const isNight = (bot,startTick=12000) => {
  const t = bot.time?.timeOfDay ?? 0; return t>=startTick || t<1000;
};
function getBiomeName(bot){
  try{
    const b = bot.blockAt(bot.entity.position);
    return b?.biome?.name || null;
  }catch{ return null; }
}
function blockAt(bot,pos){ try{ return bot.blockAt(pos);}catch{ return null; } }
function lightAt(bot,pos){
  const b = blockAt(bot,pos);
  if (b && typeof b.light === 'number') return b.light; // общий свет
  return null;
}
function canSeeSky(bot,pos){
  try{
    // если есть world.raycast — используем, иначе простой хак: ищем первый непустой сверху
    if (bot.world?.raycast){
      const hit = bot.world.raycast(pos, new Vec3(0,1,0), 256);
      return !hit;
    }
    for (let y = pos.y+1; y<=255; y++){
      const b = blockAt(bot, new Vec3(pos.x,y,pos.z));
      if (b && b.name !== 'air' && b.boundingBox !== 'empty') return false;
    }
    return true;
  }catch{ return false; }
}
function hasTorchInInventory(bot,names){
  try{ return bot.inventory.items().some(i=>names.includes(i.name)); }catch{ return false; }
}

// ───────────────────────────────────────────────────────────────────────────────
// Умная постановка факела
// ───────────────────────────────────────────────────────────────────────────────
async function placeTorchIfNeeded(st){
  const { bot,opt }=st;
  const now = Date.now();
  if (!opt.night.placeTorch) return;

  const night=isNight(bot,opt.night.startTick);
  const feet=bot.entity.position.floored();
  const head=feet.offset(0, Math.floor(opt.sense.suffocationHeadOffset), 0);

  const L = lightAt(bot, head);
  const tooDark = opt.night.lightCheck ? ((L??0) < opt.night.minLightLevel) : night;
  if (!tooDark) return;
  if (now - st.lastTorchAt < opt.night.torchCooldownMs) return;
  if (!hasTorchInInventory(bot,opt.night.torchNames)) return;
  if (opt.night.skyOnly && !canSeeSky(bot, head)) return;

  // требуются utils.placeBlockSmart
  if (typeof placeBlockSmart !== 'function') return;

  // Порядок: пол → стенка → ближайшая свободная клетка рядом
  const tryPlaces = [
    feet.clone(), // на пол под ногами
    feet.offset(1,0,0), feet.offset(-1,0,0), feet.offset(0,0,1), feet.offset(0,0,-1)
  ];

  for (const p of tryPlaces){
    const ok = await placeBlockSmart(bot,'torch',p).catch(()=>false);
    if (ok){
      st.lastTorchAt = now;
      if (now - st.lastTorchMsgAt > opt.chat.torchMsgCooldownMs) {
        say(st, '🕯️ Немного света.');
        st.lastTorchMsgAt = now;
      }
      return;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Движение (мягкие манёвры)
// ───────────────────────────────────────────────────────────────────────────────
const isMoveLocked = (st)=> Date.now() < st.movingLockUntil;
const lockMove = (st,ms)=> st.movingLockUntil = Math.max(st.movingLockUntil, Date.now()+ms);

async function softBackStep(st){
  const { bot,opt }=st; if (isMoveLocked(st)) return;
  lockMove(st,opt.avoid.lockMoveMs);
  try{
    bot.setControlState('back', true);
    if (Math.random()<0.6) bot.setControlState(Math.random()<0.5 ? 'left':'right', true);
    await sleep(opt.avoid.stepBackMs);
  }finally{
    bot.setControlState('back', false);
    bot.setControlState('left', false);
    bot.setControlState('right', false);
  }
  await sleep(opt.avoid.strafeMs);
}
function yawAwayFrom(st,targetPos){
  if(!st.opt.avoid.yawAway) return;
  try{
    const bot=st.bot;
    const head=bot.entity.position.offset(0, bot.entity.height*0.9, 0);
    const dx=head.x-(targetPos?.x ?? head.x), dz=head.z-(targetPos?.z ?? head.z);
    const yaw=Math.atan2(-dx,-dz);
    bot.look(yaw, bot.entity.pitch, true);
  }catch{}
}

function haltPath(bot){
  try { bot.pathfinder?.setGoal(null); } catch {}
  try { bot.pathfinder?.stop?.(); } catch {}
  try { bot.clearControlStates?.(); } catch {}
}

// ───────────────────────────────────────────────────────────────────────────────
// Падения / подпорка
// ───────────────────────────────────────────────────────────────────────────────
function probeDropDepth(bot, fromPos, maxDepth){
  let depth=0, p=fromPos.clone();
  for (let i=1; i<=maxDepth+1; i++){
    p = p.offset(0,-1,0);
    const b = blockAt(bot,p);
    const empty = !b || b.name==='air' || b.boundingBox==='empty';
    if (empty){ depth++; continue; }
    break;
  }
  return depth;
}
function nearestDangerousDrop(st){
  if(!st.opt.fall.enabled) return null;
  const bot=st.bot, feet=bot.entity.position.floored(), r=st.opt.sense.fallProbeRadius;
  let worst=null;
  for(let dx=-r; dx<=r; dx++){
    for(let dz=-r; dz<=r; dz++){
      const c=feet.offset(dx,0,dz);
      const d=probeDropDepth(bot,c,st.opt.sense.fallMaxDepth);
      if (d>=st.opt.sense.fallMaxDepth){
        const dist = bot.entity.position.distanceTo(c);
        if(!worst || d>worst.depth || (d===worst.depth && dist<worst.dist)) worst={pos:c,depth:d,dist};
      }
    }
  }
  return worst;
}
function firstInventoryBlock(bot, whitelist){
  try{
    const it = bot.inventory.items().find(i=> whitelist.includes(i.name));
    return it?.name || null;
  }catch{ return null; }
}
async function tryBuildSupport(st, drop){
  const { bot,opt }=st; const now=Date.now();
  if(!opt.fall.buildSupport) return false;
  if(now - (st.mem.get('lastSupportAt')||0) < opt.fall.placeCooldownMs) return false;

  const name = firstInventoryBlock(bot,opt.fall.supportWhitelist);
  if(!name || typeof placeBlockSmart!=='function') return false;

  const feet = bot.entity.position.floored();
  const target = drop?.pos?.clone() || feet.clone();
  const ok = await placeBlockSmart(bot,name,target).catch(()=>false);
  if(ok){
    st.mem.set('lastSupportAt', now, opt.fall.placeCooldownMs);
    if (opt.fall.chatOnSupport && Date.now()-st.lastHazardMsgAt>st.opt.chat.hazardMsgCooldownMs){
      say(st,'🧱 Подставил блок, чтобы не упасть.');
      st.lastHazardMsgAt = Date.now();
    }
    return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────────
// Опасности
// ───────────────────────────────────────────────────────────────────────────────
function hazardSeverity(name){
  switch(name){
    case 'lava': return 'severe';
    case 'magma_block': return 'moderate';
    case 'cactus':
    case 'sweet_berry_bush':
    case 'fire':
    case 'campfire':
    case 'powder_snow': return 'minor';
    case 'water':
    case 'bubble_column': return 'minor';
    default: return 'minor';
  }
}
function hazardFriendlyMessage(h){
  if(!h) return null;
  if(h.type==='fall') return '⬇️ Вниз опасно — аккуратно!';
  if(h.type==='suffocation') return '🫁 Осторожно, можно задохнуться.';
  const m = {
    lava:'🔥 Лава рядом — отхожу.',
    water:'💧 Вода близко.',
    bubble_column:'💧 Вода близко.',
    magma_block:'♨️ Магма обжигает — не стоять.',
    cactus:'🌵 Колючки — неприятно.',
    sweet_berry_bush:'🍇 Куст царапает — осторожнее.',
    fire:'🔥 Огонь рядом.',
    campfire:'🔥 Костёр горячий.',
    powder_snow:'🥶 Порошковый снег — можно провалиться.'
  };
  return m[h.type] || '⚠️ Осторожно.';
}

function detectHazards(st){
  const { bot,opt }=st;
  const feet = bot.entity.position.floored();
  const head = feet.offset(0, Math.floor(opt.sense.suffocationHeadOffset), 0);

  let found = null;

  // 1) окружение рядом
  try{
    const matches = bot.findBlocks({
      matching:(b)=>{
        if(!b) return false; const n=b.name;
        if (opt.avoid.lava && n==='lava') return true;
        if (opt.avoid.water && (n==='water' || n==='bubble_column')) return true;
        if (opt.avoid.magma && n==='magma_block') return true;
        if (opt.avoid.cactus && n==='cactus') return true;
        if (opt.avoid.sweetBerry && n==='sweet_berry_bush') return true;
        if (opt.avoid.fire && n==='fire') return true;
        if (opt.avoid.campfire && (n==='campfire' || n==='soul_campfire')) return true;
        if (opt.avoid.powderSnow && n==='powder_snow') return true;
        return false;
      },
      maxDistance: opt.sense.hazardRadius,
      count: 16
    });
    if (matches?.length){
      let best=null, bestD=Infinity;
      for (const pos of matches){
        const d = bot.entity.position.distanceTo(pos);
        if (d<bestD){ bestD=d; best=pos; }
      }
      const b = blockAt(bot,best);
      if (b) found = { type:b.name, pos:best, dist:bestD, severity:hazardSeverity(b.name) };
    }
  }catch{}

  // 2) падение
  if (!found){
    const drop = nearestDangerousDrop(st);
    if (drop) found = { type:'fall', depth:drop.depth, pos:drop.pos, dist:drop.dist, severity:'severe' };
  }

  // 3) удушье
  if (!found && st.opt.sense.suffocationCheck){
    const hb = blockAt(bot, head);
    if (hb && hb.name!=='air' && hb.boundingBox!=='empty'){
      found = { type:'suffocation', pos:head, dist:0.3, severity:'moderate' };
    }
  }

  return found;
}

// ───────────────────────────────────────────────────────────────────────────────
// Циклы
// ───────────────────────────────────────────────────────────────────────────────
function contextLoop(st){
  const { bot,opt }=st;
  addInterval(st, ()=>{
    const biome = getBiomeName(bot);
    if (biome && biome!==st.lastBiomeName){
      st.lastBiomeName = biome;
      const now=Date.now();
      if (now - st.lastBiomeMsgAt > opt.chat.biomeMsgCooldownMs){
        if (/desert/.test(biome)) say(st,'🌵 Жарковато тут…');
        else if (/jungle/.test(biome)) say(st,'🌿 Влажные заросли.');
        else if (/snow|frozen|ice/.test(biome)) say(st,'❄️ Холодно.');
        else if (/swamp/.test(biome)) say(st,'🦟 Болотисто.');
        else if (/mushroom/.test(biome)) say(st,'🍄 Грибной биом!');
        else say(st,`📍 Биом: ${biome}`);
        st.lastBiomeMsgAt = now;
      }
    }

    const phase = isNight(bot,opt.night.startTick) ? 'night' : 'day';
    if (phase!==st.lastDayPhase){
      st.lastDayPhase = phase;
      const now=Date.now();
      if (now - st.lastDayMsgAt > opt.chat.dayPhaseCooldownMs){
        say(st, phase==='night' ? '🌙 Становится темно…' : '☀️ Добрый день!');
        st.lastDayMsgAt = now;
      }
    }

    if (opt.night.lightCheck) placeTorchIfNeeded(st).catch(()=>{});
  }, st.opt.sense.contextScanMs);
}

function hazardLoop(st){
  const { bot,opt }=st;
  addInterval(st, async ()=>{
    const h = detectHazards(st);
    if (!h) return;

    // коалесинг сообщений
    const now=Date.now();
    const key=`haz:${h.type}`;
    const last = st.mem.get(key);
    if (!last || now-last>opt.chat.hazardMsgCooldownMs){
      st.mem.set(key, now, opt.chat.hazardMsgCooldownMs);
      const msg = hazardFriendlyMessage(h);
      if (msg && now - st.lastHazardMsgAt > opt.chat.hazardMsgCooldownMs){
        say(st,msg);
        st.lastHazardMsgAt = now;
      }
    }

    // brain quiet
    if (opt.integration.withBrain && typeof bot?.brain?.reportHazard==='function'){
      const lvl = opt.integration.brainQuietLevelMap[h.severity] || 1;
      try{ bot.brain.reportHazard({ level:lvl, reason:h.type }); }catch{}
    }

    try{
      haltPath(bot);
      yawAwayFrom(st, h.pos || bot.entity.position);
      await softBackStep(st);

      if (h.type==='fall' && opt.fall.enabled){
        await tryBuildSupport(st,h);
      }
      if (h.type==='suffocation'){
        bot.setControlState('sneak', true);
        await sleep(250);
        bot.setControlState('sneak', false);
      }
    }catch{}
  }, st.opt.sense.hazardScanMs);
}

// ───────────────────────────────────────────────────────────────────────────────
// API
// ───────────────────────────────────────────────────────────────────────────────
function deepMerge(base,patch){
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k,v] of Object.entries(patch||{})){
    if (v && typeof v==='object' && !Array.isArray(v) && base?.[k] && typeof base[k]==='object'){
      out[k] = deepMerge(base[k], v);
    } else out[k] = v;
  }
  return out;
}

function startEnvironmentAwareness(bot, options={}){
  const opt = deepMerge(defaults, options);
  const st = makeState(bot,opt);

  contextLoop(st);
  hazardLoop(st);

  const stop = ()=> stopEnvironmentAwareness(st);
  bot.once('end', stop);
  bot.once('kicked', stop);

  bot.__envAdapt = st;

  return {
    say:(msg,o)=>say(st,msg,o),
    state:()=>st,
    options:()=>opt,
    stop
  };
}
function stopEnvironmentAwareness(stOrBot){
  const st = stOrBot?.bot ? stOrBot : stOrBot.__envAdapt;
  if (!st) return;
  clearAll(st);
}

module.exports = { startEnvironmentAwareness, stopEnvironmentAwareness };

