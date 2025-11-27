'use strict';

// features/exploration/woodcutter.cjs — extracted woodcutting logic

const { Vec3 } = require('vec3');
const { state } = require('../../core/state.cjs');
const { createLogger } = require('../../core/logger.cjs');
const log = createLogger('woodcutter');

const SMART_CHOP = String(process.env.SMART_CHOP || 'true').toLowerCase() !== 'false';

// Wood ids and RU->EN mapping used by commands
const WOOD_LOGS = new Set([
  'oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log',
  'mangrove_log','cherry_log','pale_oak_log','bamboo_block'
]);

const RU2EN_WOOD = {
  'дуб':'oak_log','тёмный дуб':'dark_oak_log','темный дуб':'dark_oak_log',
  'ель':'spruce_log','хвойный':'spruce_log',
  'берёза':'birch_log','береза':'birch_log',
  'джунгли':'jungle_log','акация':'acacia_log',
  'мангровое':'mangrove_log','мангровое дерево':'mangrove_log','мангрова':'mangrove_log',
  'вишня':'cherry_log','сакура':'cherry_log',
  'бамбук':'bamboo_block','бледный дуб':'pale_oak_log'
};

// helpers
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const sample = (arr)=>arr[(Math.random()*arr.length)|0];

function selfPos(bot){ return bot?.entity?.position || bot?.players?.[bot.username||'']?.entity?.position || null; }
function distSq(a,b){ if(!a||!b) return Infinity; const dx=(a.x??a[0]??0)-(b.x??b[0]??0), dy=(a.y??a[1]??0)-(b.y??b[1]??0), dz=(a.z??a[2]??0)-(b.z??b[2]??0); return dx*dx+dy*dy+dz*dz; }

function makeChatQueue(bot){
  const GAP=160; const q=[]; let busy=false;
  async function pump(){ if(busy) return; busy=true; while(q.length){ const msg=q.shift(); try{ if(!state.inCombat) bot.chat(String(msg)); }catch{} await sleep(GAP + Math.floor(Math.random()*140)); } busy=false; }
  return { sayOnce:(t)=>{ if(t){ q.push(String(t)); pump(); } } };
}

function createTaskController(bot){
  bot.__funTask = bot.__funTask || { cancel:false, name:'idle' };
  return {
    begin(name, stopPrev=true){ if(stopPrev) this.stop(); bot.__funTask.cancel=false; bot.__funTask.name=name||'task'; state.task=bot.__funTask.name; },
    stop(){ bot.__funTask.cancel=true; bot.__funTask.name='idle'; state.task='idle'; try{ bot.pathfinder?.setGoal?.(null); }catch{} try{ bot.clearControlStates?.(); }catch{} },
    isCanceled(){ return !!bot.__funTask.cancel; }
  };
}

async function equipBestAxe(bot){
  const tier=['netherite','diamond','iron','stone','golden','wooden'];
  const inv=bot.inventory?.items()||[];
  let best=null,bestRank=999;
  for(const it of inv){ if(!/_axe$/.test(it.name)) continue; const r=tier.indexOf(it.name.split('_')[0]); if(r!==-1 && r<bestRank){ best=it; bestRank=r; } }
  if(best){ try{ await bot.equip(best,'hand'); }catch{} }
}

function pickNearestLogBlock(bot, radius, allowSet){
  try{
    const found=bot.findBlocks({
      matching:(b)=>!!b && (
        (allowSet ? allowSet.has(b.name) : WOOD_LOGS.has(b.name)) ||
        (/(_log|_stem)$/.test(b?.name) && !/mushroom/.test(b.name))
      ),
      maxDistance:radius,
      count:24
    });
    if(!found||!found.length) return null;
    const me=selfPos(bot)||bot.entity?.position||new Vec3(0,0,0);
    let best=null,bestD2=Infinity; for(const pos of found){ const d2=distSq(me,pos); if(d2<bestD2){ bestD2=d2; best=pos; } }
    return best ? bot.blockAt(best) : null;
  }catch{ return null; }
}

function findTrunkBase(bot,pos){ if(!pos) return null; let p=pos.clone(); for(let i=0;i<32;i++){ const below=bot.blockAt(p.offset(0,-1,0)); if(!below || !(WOOD_LOGS.has(below.name) || /(_log|_stem)$/.test(below.name))) return p; p=p.offset(0,-1,0);} return p; }
function walkable(bot,p){ const floor=bot.blockAt(p); const head=bot.blockAt(p.offset(0,1,0)); return floor && floor.boundingBox==='block' && (!head || head.name==='air'); }

async function smartChop(bot, qty=8, radius=28, only){
  const say=makeChatQueue(bot);
  const task=createTaskController(bot);
  try{ const mc=require('minecraft-data')(bot.version); const { Movements } = require('mineflayer-pathfinder'); const mv=new Movements(bot,mc); mv.allowSprinting=true; mv.canDig=true; bot.pathfinder.setMovements(mv); }catch{}
  await equipBestAxe(bot);
  let cut=0,attempts=0;
  while((qty===Infinity || cut<qty) && attempts<(qty===Infinity?9e6:qty*6)){
    if(task.isCanceled()) break; attempts++;
    const trunkBlock=pickNearestLogBlock(bot, radius, only);
    if(!trunkBlock){ if(cut===0) makeChatQueue(bot).sayOnce('я рядом деревьев не вижу'); break; }
    const basePos=trunkBlock && findTrunkBase(bot, trunkBlock.position); if(!basePos){ await sleep(120); continue; }
    const cand=[new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)].map(v=>basePos.plus(v));
    const stand=cand.find(p=>walkable(bot,p)) || cand[0];
    try{ const { goals } = require('mineflayer-pathfinder'); await bot.pathfinder.goto(new goals.GoalNear(stand.x, stand.y, stand.z, 1)); }catch{}
    for(let h=0; h<3 && (qty===Infinity || cut<qty); h++){
      if(task.isCanceled()) break; const pos=basePos.offset(0,h,0); const block=bot.blockAt(pos);
      if(!block || (!WOOD_LOGS.has(block.name) && !/(_log|_stem)$/.test(block.name))) break;
      try{ await bot.lookAt(pos.offset(0,0.6,0), true); }catch{}
      try{ await bot.dig(block,true); cut++; }catch{ break; }
      await sleep(120);
    }
    await sleep(250);
  }
  if(cut) makeChatQueue(bot).sayOnce(`я срублено: ${cut}`);
  return cut;
}

async function collectChopFallback(bot, amount, radius=50, only){
  const say=makeChatQueue(bot); const task=createTaskController(bot);
  const found=bot.findBlocks({ matching:(b)=>!!b && ((only?only.has(b.name):WOOD_LOGS.has(b.name)) || (/(_log|_stem)$/.test(b.name) && !/mushroom/.test(b.name))), maxDistance:radius, count:Math.max(8, (amount===Infinity?64:amount)*4) });
  if(!found||!found.length){ say.sayOnce('я рядом не вижу подходящих стволов'); return 0; }
  let done=0; for(const pos of found){ if(task.isCanceled()) break; if(amount!==Infinity && done>=amount) break; const block=bot.blockAt(pos); if(!block) continue; try{ await bot.collectBlock.collect(block); done++; }catch{} }
  if(done) say.sayOnce(`fallback: срублено ${done}`);
  return done;
}

async function chopTrees(bot, amount, opts={}){
  const say=makeChatQueue(bot); const task=createTaskController(bot);
  const infinite=opts.infinite===true; const species=opts.species ? new Set([opts.species]) : null;
  const want=infinite ? Infinity : Math.max(1, Math.min(64, Number(amount)||1));
  task.begin(infinite ? 'chop:?' : `chop:${want}`);
  if(SMART_CHOP){
    say.sayOnce(`я рублю ${opts.species ? '['+opts.species+'] ' : ''}${infinite ? 'до конца' : `x${want}`} (умная рубка)`);
    const got=await smartChop(bot, want, 28, species).catch(()=>0);
    if(infinite || got>=want) return true;
    const rest=want-(got||0);
    if(rest>0 && bot.collectBlock?.collect){ await collectChopFallback(bot, rest, 50, species).catch(()=>{}); }
    return true;
  } else {
    say.sayOnce(`я рублю ${infinite ? 'до конца' : `x${want}`}`);
    await collectChopFallback(bot, want, 50, species).catch(()=>{});
    return true;
  }
}

// Logging wrappers
const _chopTrees = chopTrees;
chopTrees = async function(bot, amount, opts={}){
  try { log.info('chopTrees:start', { amount, opts }); } catch {}
  const res = await _chopTrees(bot, amount, opts);
  try { log.info('chopTrees:end', { ok: !!res }); } catch {}
  return res;
};

module.exports = { chopTrees, RU2EN_WOOD };
