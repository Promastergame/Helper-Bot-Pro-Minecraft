'use strict';

// ===============================
// features/exploration/fun.js — v11 RU++ SAFE (без прокида !mine)
// • Много русских команд/синонимов (рубка/добыча/охрана/следуй/подойди…)
// • «копай/добудь/собери дерево|древесину|брёвна [N|до стоп]» → умная рубка
// • Безопасный локальный майнер для мягких блоков (песок/гравий/земля/глина и пр.)
// • Жёсткий бан камней и всех руд (вкл. deep* ore, кварц, древние обломки)
// • Никакого bot.emit('message','!mine ...') — тяжелые задачи не прокидываем в ядро
// • Аккуратная «стоп» останавливает текущую задачу/движение
// ===============================

const { Vec3 } = require('vec3');
const { state } = require('../../core/state.cjs');
// Woodcutter module: move all chopping logic out of fun.js
const { chopTrees, RU2EN_WOOD } = require('./woodcutter.cjs');

// ──────────────────────────────────────────────────────────────────────────────
// Конфиг
// ──────────────────────────────────────────────────────────────────────────────
const RAW_CHAT_PREFIX = typeof process.env.CHAT_PREFIX === 'string' ? process.env.CHAT_PREFIX : '!';
const CHAT_PREFIX = RAW_CHAT_PREFIX.trim();
const HAS_CHAT_PREFIX = CHAT_PREFIX.length > 0;
const CHAT_PREFIX_LOWER = CHAT_PREFIX.toLowerCase();
const CHAT_REQUIRE_MENTION = String(process.env.CHAT_REQUIRE_MENTION ?? 'true') !== 'false';
const CHAT_RESP_CHANCE = Math.max(0, Math.min(1, parseFloat(process.env.CHAT_RESP_CHANCE ?? '0.65')));
const CHAT_RESP_COOLDOWN_MS = Math.max(500, parseInt(process.env.CHAT_RESP_COOLDOWN_MS ?? '4500', 10));

const FUN_DEBUG  = String(process.env.FUN_DEBUG  || 'false').toLowerCase() === 'true';
const SMART_CHOP = String(process.env.SMART_CHOP || 'true').toLowerCase() !== 'false'; // по умолчанию вкл
const dlog = (...a) => { if (FUN_DEBUG) try { console.log('[fun]', ...a); } catch {} };

// Радиус ПвЕ
const SCAN_RADIUS = Number(process.env.HOSTILE_SCAN_RADIUS || 36);
const DEFAULT_DENY = String(process.env.COMBAT_DENY || 'iron_golem,villager,wandering_trader,warden')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DENY_SET = new Set(DEFAULT_DENY);

// ──────────────────────────────────────────────────────────────────────────────
// Локаль / словари
// ──────────────────────────────────────────────────────────────────────────────
const RU_MOB = {
  phantom:'фантом', zombie:'зомби', skeleton:'скелет', creeper:'крипер', spider:'паук',
  witch:'ведьма', enderman:'эндермен', blaze:'ифрит', ghast:'гаст', guardian:'страж',
  drowned:'утопленник', husk:'кожник', stray:'блуждающий_скелет', vex:'векс', evoker:'вызыватель',
  vindicator:'разбойник', ravager:'разоритель', slime:'слизь', magma_cube:'магмовый_куб',
  piglin:'пиглин', piglin_brute:'брутальный_пиглин', zombified_piglin:'зомбифицированный_пиглин',
  shulker:'шалкер', endermite:'эндермит', silverfish:'чешуйница', bogged:'болотный_скелет',
  breeze:'бриз'
};
const EN_MOB = (() => {
  const out = {};
  for (const [en, ru] of Object.entries(RU_MOB)) out[ru] = en;
  out['скелет']='skeleton'; out['зомби']='zombie'; out['паук']='spider'; out['крипер']='creeper';
  out['ведьма']='witch'; out['эндермен']='enderman'; out['ифрит']='blaze'; out['гаст']='ghast'; out['страж']='guardian';
  return out;
})();

// Руды (рус → id)
const RU2EN_ORE = {
  'уголь':'coal_ore','угольная руда':'coal_ore',
  'железо':'iron_ore','железная руда':'iron_ore',
  'золото':'gold_ore','золотая руда':'gold_ore',
  'медь':'copper_ore','медная руда':'copper_ore',
  'алмаз':'diamond_ore','алмазы':'diamond_ore','алмазная руда':'diamond_ore',
  'лазурит':'lapis_ore',
  'редстоун':'redstone_ore','красная пыль':'redstone_ore',
  'изумруд':'emerald_ore','эмеральд':'emerald_ore',
  'кварц':'nether_quartz_ore','кварцевая руда':'nether_quartz_ore',
  'древние обломки':'ancient_debris','обломки древние':'ancient_debris'
};

// Блоки (рус → id)
const RU2EN_BLOCK = {
  'песок':'sand','красный песок':'red_sand','гравий':'gravel',
  'земля':'dirt','трава':'grass_block','глина':'clay',
  'земляная тропа':'dirt_path','песчаник':'sandstone',
  // камни ниже определяются анти-фильтром
  'камень':'stone','булыжник':'cobblestone','гладкий камень':'smooth_stone',
  'глубинный сланец':'deepslate','чернит':'blackstone','базальт':'basalt','адский камень':'netherrack',
  'андезит':'andesite','диорит':'diorite','гранит':'granite','обсидиан':'obsidian'
};

const WOOD_LOGS = new Set([
  'oak_log','spruce_log','birch_log','jungle_log','acacia_log','dark_oak_log',
  'mangrove_log','cherry_log','pale_oak_log','bamboo_block'
]);

// moved to woodcutter.cjs; keep old name to avoid breaking older code if referenced elsewhere
const RU2EN_WOOD_OLD = {
  'дуб':'oak_log','тёмный дуб':'dark_oak_log','темный дуб':'dark_oak_log',
  'ель':'spruce_log','сосна':'spruce_log',
  'берёза':'birch_log','береза':'birch_log',
  'джунгли':'jungle_log','акация':'acacia_log',
  'мангровое':'mangrove_log','мангровое дерево':'mangrove_log','мангровый':'mangrove_log',
  'вишня':'cherry_log','черри':'cherry_log',
  'бамбук':'bamboo_block','бледный дуб':'pale_oak_log'
};

// ──────────────────────────────────────────────────────────────────────────────
// Анти-камни/руды
// ──────────────────────────────────────────────────────────────────────────────
const STONES_SET = new Set([
  'stone','cobblestone','smooth_stone',
  'deepslate','blackstone','basalt','netherrack',
  'andesite','diorite','granite'
]);
function baseNameEn(s){ let x=String(s||'').toLowerCase(); if(!x) return x; if(x.includes(':')) x=x.split(':').pop(); return x.replace(/\s+/g,'_'); }
function isStoneOrOre(idRaw){
  const id = baseNameEn(idRaw||'');
  if (!id) return false;
  if (STONES_SET.has(id)) return true;
  if (id==='nether_quartz_ore' || id==='ancient_debris' || id==='gilded_blackstone') return true;
  if (/_ore$/.test(id)) return true;
  if (/^deepslate_.*_ore$/.test(id)) return true;
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Хелперы
// ──────────────────────────────────────────────────────────────────────────────
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const sample = (arr)=>arr[(Math.random()*arr.length)|0];
const normalize = (t='')=>String(t).replace(/\s+/g,' ').trim();

function extractCommand(rawMsg, botname){
  if(!rawMsg) return null;
  const original=String(rawMsg).trim(); if(!original) return null;
  const lower=original.toLowerCase();
  if(HAS_CHAT_PREFIX && lower.startsWith(CHAT_PREFIX_LOWER)) return original.slice(CHAT_PREFIX.length).trim();
  if(botname && lower.startsWith(botname+' ')) return original.split(/\s+/).slice(1).join(' ');
  if(!CHAT_REQUIRE_MENTION) return original;
  return null;
}

// чат-очередь
const CHAT_GAP_MS=160;
function makeChatQueue(bot){
  const q=[]; let busy=false;
  const lastByKey = new Map();

  async function pump(){
    if(busy) return; busy=true;
    while(q.length){
      const msg=q.shift();
      try{ if(!state.inCombat) bot.chat(String(msg)); }catch{}
      await sleep(CHAT_GAP_MS + Math.floor(Math.random()*140));
    }
    busy=false;
  }

  const push = (text) => { if(text){ q.push(String(text)); pump(); } };

  return {
    say:(text)=>{ String(text??'').split('\n').forEach(push); },
    sayOnce:(text)=> push(text),
    maybe:(key, text, { chance = CHAT_RESP_CHANCE, cooldown = CHAT_RESP_COOLDOWN_MS } = {}) => {
      if(!text) return;
      if(Math.random() > chance) return;
      const now = Date.now();
      const last = lastByKey.get(key) || 0;
      if(now - last < cooldown) return;
      push(text);
      lastByKey.set(key, now);
    }
  };
}

// позиция/расстояние
function selfPos(bot){ return bot?.entity?.position || bot?.players?.[bot.username||'']?.entity?.position || null; }
function distSq(a,b){ if(!a||!b) return Infinity; const dx=(a.x??a[0]??0)-(b.x??b[0]??0), dy=(a.y??a[1]??0)-(b.y??b[1]??0), dz=(a.z??a[2]??0)-(b.z??b[2]??0); return dx*dx+dy*dy+dz*dz; }
function normName(s){ const x=baseNameEn(s); return RU_MOB[x]||x; }

// ──────────────────────────────────────────────────────────────────────────────
// Управление задачами
// ──────────────────────────────────────────────────────────────────────────────
function createTaskController(bot){
  bot.__funTask = bot.__funTask || { cancel:false, name:'idle' };
  return {
    begin(name, stopPrev=true){ if(stopPrev) this.stop(); bot.__funTask.cancel=false; bot.__funTask.name=name||'task'; state.task=bot.__funTask.name; },
    stop(){ bot.__funTask.cancel=true; bot.__funTask.name='idle'; state.task='idle'; try{ bot.pathfinder?.setGoal?.(null); }catch{} try{ bot.clearControlStates?.(); }catch{} },
    isCanceled(){ return !!bot.__funTask.cancel; },
    name(){ return bot.__funTask.name; }
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// ПвЕ
// ──────────────────────────────────────────────────────────────────────────────
const HOSTILE_RX = [
  /zombie/,/husk/,/drowned/,/bogged/,/zombie_villager/,
  /skeleton/,/stray/,/wither_skeleton/,
  /creeper/,/spider/,/cave_spider/,
  /enderman/,/endermite/,
  /slime/,/magma_cube/,
  /phantom/,/witch/,
  /ghast/,/blaze/,/guardian/,/elder_guardian/,
  /pillager/,/vindicator/,/evoker/,/illusioner/,/ravager/,/vex/,
  /piglin/,/piglin_brute/,/zombified_piglin/,
  /shulker/,/silverfish/,
  /breeze/,/hoglin/,/zoglin/,/warden/,
  /зомби|скелет|крипер|паук|фантом|ведьм|страж|разбойник|вызыватель|разоритель|векс|гаст|блейз/i
];
function isDenied(ent){ const n=normName(ent?.name||ent?.displayName||''); return n && DENY_SET.has(n); }
function isHostile(ent){
  if(!ent || ent.type!=='mob') return false;
  const n=baseNameEn(ent.name||ent.displayName||''); if(!n) return false;
  if(isDenied(ent)) return false;
  return HOSTILE_RX.some(rx=>rx.test(n) || rx.test(normName(n)));
}
function nearestHostile(bot, within=SCAN_RADIUS, filterFn=null){
  const me=selfPos(bot); if(!me) return null;
  const r2=within*within; let best=null, bestD2=Infinity;
  for(const ent of Object.values(bot.entities||{})){
    if(!ent || ent.type!=='mob' || !ent.position) continue;
    if(isDenied(ent) || !isHostile(ent)) continue;
    if(filterFn && !filterFn(ent)) continue;
    const d2=distSq(me, ent.position);
    if(Number.isFinite(d2) && d2<r2 && d2<bestD2){ best=ent; bestD2=d2; }
  }
  return best;
}

async function attackNearest(bot, opts={}){
  const say=makeChatQueue(bot);
  const keep=Number(opts.keep??2.8);
  const reach=2.95;
  const timeoutMs=Number(opts.timeoutMs??20000);
  const scan=Number(opts.scan??SCAN_RADIUS);
  const strafes=['left','right'];

  if(state.inCombat) return;
  state.inCombat=true;
  setTimeout(()=>{ state.inCombat=false; }, timeoutMs+400);

  let target=nearestHostile(bot, scan, opts.filterFn||null);
  if(!target){ say.sayOnce(sample(['🤔 никого опасного рядом','👀 чисто','тихо, врагов нет'])); state.inCombat=false; return; }
  say.sayOnce(`⚔️ цель: ${normName(target.name)||'враг'}`);

  await sleep(90+Math.floor(Math.random()*180));

  try{
    const mc=require('minecraft-data')(bot.version);
    const { Movements } = require('mineflayer-pathfinder');
    const mv=new Movements(bot, mc);
    mv.allowSprinting=true; mv.canDig=true;
    bot.pathfinder.setMovements(mv);
  }catch{}

  const { goals } = require('mineflayer-pathfinder');
  const ddl=Date.now()+timeoutMs; let lastSwing=0,lastDodge=0;

  try{
    while(Date.now()<ddl){
      const me=selfPos(bot); if(!me) break;

      if(!target?.isValid || isDenied(target) || !isHostile(target)){
        target=nearestHostile(bot, scan, opts.filterFn||null);
        if(!target) break;
        say.sayOnce(`🎯 переключаюсь → ${normName(target.name)}`);
      }

      const d=Math.sqrt(distSq(me,target.position));
      if(Number.isFinite(d)){
        if(d>keep+0.8){ try{ bot.pathfinder.setGoal(new goals.GoalFollow(target, keep), true); }catch{} }
        else if(d<1.5){ try{ bot.pathfinder.setGoal(null); }catch{} }
      }

      if(d<3.4 && Date.now()-lastDodge>700){
        lastDodge=Date.now();
        const s=sample(strafes);
        try{
          bot.setControlState(s,true);
          bot.setControlState('back', Math.random()<0.5);
          setTimeout(()=>{ try{ bot.clearControlStates?.(); }catch{} }, 180+Math.floor(Math.random()*180));
        }catch{}
      }

      try{ bot.lookAt(target.position.offset(0, target.height||1, 0), true); }catch{}
      const now=Date.now();
      const swingCd=520+Math.floor(Math.random()*360);
      if(Number.isFinite(d) && d<=reach+0.1 && now-lastSwing>=swingCd){
        try{ await bot.attack(target); }catch{ try{ bot.swingArm('hand'); }catch{} }
        lastSwing=now;
      }
      await sleep(55+Math.floor(Math.random()*70));
    }
  }finally{
    try{ bot.pathfinder.setGoal(null); }catch{}
    state.inCombat=false;
  }
}

// поиск моба по имени (рус/англ)
function makeMobFilter(tokenRaw){
  const raw=baseNameEn(normalize(tokenRaw));
  const maybeEnFromRu=EN_MOB[raw]||EN_MOB[raw.replace(/ /g,'_')];
  const tokenEn=maybeEnFromRu||raw;
  const tokenRu=RU_MOB[tokenEn]||raw;
  return (ent)=>{
    const en=baseNameEn(ent.name);
    const ru=normName(ent.name);
    return en===tokenEn || ru===tokenRu || en===raw || ru===raw;
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// РУБКА ДЕРЕВА (умная + fallback)
// ──────────────────────────────────────────────────────────────────────────────
async function equipBestAxe(bot){
  const tier=['netherite','diamond','iron','stone','golden','wooden'];
  const inv=bot.inventory?.items()||[];
  let best=null,bestRank=999;
  for(const it of inv){
    if(!/_axe$/.test(it.name)) continue;
    const r=tier.indexOf(it.name.split('_')[0]);
    if(r!==-1 && r<bestRank){ best=it; bestRank=r; }
  }
  if(best){ try{ await bot.equip(best,'hand'); }catch{} }
}

function pickNearestLogBlock(bot, radius, allowSet){
  try{
    const found=bot.findBlocks({
      matching:(b)=>!!b && (
        (allowSet ? allowSet.has(b.name) : (WOOD_LOGS.has(b.name))) ||
        (/(_log|_stem)$/.test(b?.name) && !/mushroom/.test(b.name))
      ),
      maxDistance:radius,
      count:24
    });
    if(!found||!found.length) return null;
    const me=selfPos(bot)||bot.entity?.position||new Vec3(0,0,0);
    let best=null,bestD2=Infinity;
    for(const pos of found){ const d2=distSq(me,pos); if(d2<bestD2){ bestD2=d2; best=pos; } }
    return best ? bot.blockAt(best) : null;
  }catch{ return null; }
}

function findTrunkBase(bot,pos){
  if(!pos) return null;
  let p=pos.clone();
  for(let i=0;i<32;i++){
    const below=bot.blockAt(p.offset(0,-1,0));
    if(!below || !(WOOD_LOGS.has(below.name) || /(_log|_stem)$/.test(below.name))) return p;
    p=p.offset(0,-1,0);
  }
  return p;
}
function walkable(bot,p){
  const floor=bot.blockAt(p);
  const head=bot.blockAt(p.offset(0,1,0));
  return floor && floor.boundingBox==='block' && (!head || head.name==='air');
}

async function smartChop(bot, qty=8, radius=28, only){
  const say=makeChatQueue(bot);
  const task=createTaskController(bot);
  try{
    const mc=require('minecraft-data')(bot.version);
    const { Movements } = require('mineflayer-pathfinder');
    const mv=new Movements(bot,mc);
    mv.allowSprinting=true; mv.canDig=true;
    bot.pathfinder.setMovements(mv);
  }catch{}

  await equipBestAxe(bot);

  let cut=0,attempts=0;
  while((qty===Infinity || cut<qty) && attempts<(qty===Infinity?9e6:qty*6)){
    if(task.isCanceled()) break;
    attempts++;

    const trunkBlock=pickNearestLogBlock(bot, radius, only);
    if(!trunkBlock){ if(cut===0) makeChatQueue(bot).sayOnce('🌲 рядом деревьев не вижу'); break; }

    const basePos=trunkBlock && findTrunkBase(bot, trunkBlock.position);
    if(!basePos){ await sleep(120); continue; }

    const cand=[new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)].map(v=>basePos.plus(v));
    const stand=cand.find(p=>walkable(bot,p)) || cand[0];

    try{
      const { goals } = require('mineflayer-pathfinder');
      await bot.pathfinder.goto(new goals.GoalNear(stand.x, stand.y, stand.z, 1));
    }catch{}

    // Skip duplicate hint: if message is "копай дерево/...", interceptor already answered
    try{ if(/^коп(?:ай|ни|ать)\s+(дерев|брев|брёв|древес|дров)/i.test(String(rawMsg||''))) { return; } }catch{}

    for(let h=0; h<3 && (qty===Infinity || cut<qty); h++){
      if(task.isCanceled()) break;
      const pos=basePos.offset(0,h,0);
      const block=bot.blockAt(pos);
      if(!block || (!WOOD_LOGS.has(block.name) && !/(_log|_stem)$/.test(block.name))) break;
      try{ await bot.lookAt(pos.offset(0,0.6,0), true); }catch{}
      try{ await bot.dig(block,true); cut++; }catch{ break; }
      await sleep(120);
    }

    await sleep(250);
  }

  if(cut) makeChatQueue(bot).sayOnce(`🪓 срублено: ${cut}${(qty!==Infinity && cut<qty)?' (больше рядом нет)':''}`);
  return cut;
}

async function collectChopFallback(bot, amount, radius=50, only){
  const say=makeChatQueue(bot);
  const task=createTaskController(bot);
  const found=bot.findBlocks({
    matching:(b)=>!!b && ((only?only.has(b.name):WOOD_LOGS.has(b.name)) || (/(_log|_stem)$/.test(b.name) && !/mushroom/.test(b.name))),
    maxDistance:radius,
    count:Math.max(8, (amount===Infinity?64:amount)*4)
  });
  if(!found||!found.length){ say.sayOnce('🙈 рядом нет подходящих стволов'); return 0; }
  let done=0;
  for(const pos of found){
    if(task.isCanceled()) break;
    if(amount!==Infinity && done>=amount) break;
    const block=bot.blockAt(pos); if(!block) continue;
    try{ await bot.collectBlock.collect(block); done++; }catch{}
  }
  if(done) say.sayOnce(`✅ fallback: срублено ${done}`);
  return done;
}

// Legacy (migrated to woodcutter.cjs)
async function chopTrees_legacy(bot, amount, opts={}){
  const say=makeChatQueue(bot);
  const task=createTaskController(bot);
  const infinite=opts.infinite===true;
  const species=opts.species ? new Set([opts.species]) : null;
  const want=infinite ? Infinity : Math.max(1, Math.min(64, Number(amount)||1));

  task.begin(infinite ? 'chop:∞' : `chop:${want}`);

  if(SMART_CHOP){
    say.sayOnce(`🪓 рублю ${opts.species ? '['+opts.species+'] ' : ''}${infinite ? 'до стоп' : `×${want}`} (умная рубка)`);
    const got=await smartChop(bot, want, 28, species).catch(()=>0);
    if(infinite || got>=want) return true;
    const rest=want-(got||0);
    if(rest>0 && bot.collectBlock?.collect){
      await collectChopFallback(bot, rest, 50, species).catch(()=>{});
    }
    return true;
  }else{
    say.sayOnce(`🪓 рублю ${infinite ? 'до стоп' : `×${want}`}`);
    await collectChopFallback(bot, want, 50, species).catch(()=>{});
    return true;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// БЕЗОПАСНЫЙ ЛОКАЛЬНЫЙ МАЙНЕР (без emit '!mine')
// ──────────────────────────────────────────────────────────────────────────────
async function safeMineBlocks(bot, blockId, qty /* number|Infinity */){
  const say=makeChatQueue(bot);
  const task=createTaskController(bot);

  if(isStoneOrOre(blockId)) { say.sayOnce('⛔ Камни и руды не копаю (запрещено, лагает).'); return false; }

  // дерево → перенаправляем в рубку
  if (/_log$/.test(blockId) || blockId==='bamboo_block'){
    const n = qty===Infinity ? Infinity : Math.max(1, Number(qty)||1);
    return chopTrees(bot, n, { infinite: qty===Infinity });
  }

  const want = qty===Infinity ? Infinity : Math.max(1, Number(qty)||1);
  task.begin(want===Infinity?`mine:${blockId}:∞`:`mine:${blockId}:${want}`);
  say.sayOnce(`⛏️ добываю ${blockId} ${want===Infinity ? 'до стоп' : `×${want}`}`);

  let done=0;
  while(!task.isCanceled() && (want===Infinity || done<want)){
    let targets=[];
    try{
      targets = bot.findBlocks({
        matching:(b)=>!!b && baseNameEn(b.name)===blockId,
        maxDistance:32,
        count:16
      });
    }catch{}

    if(!targets || !targets.length){
      if(done===0) say.sayOnce('🤷 Блоков рядом не вижу.');
      break;
    }

    for(const pos of targets){
      if(task.isCanceled() || (want!==Infinity && done>=want)) break;
      try{
        const block = bot.blockAt(pos);
        if(!block) continue;
        await bot.collectBlock.collect(block);
        done++;
      }catch{}
      await sleep(80);
    }

    await sleep(200);
  }

  say.sayOnce(`⛏️ готово: ${done}${(want!==Infinity && done<want)?' (рядом больше нет)':''}`);
  return true;
}

const MINER_OPTION_KEYS = {
  layer: 'layers',
  layers: 'layers',
  stair: 'stairSteps',
  stairs: 'stairSteps',
  step: 'stairSteps',
  steps: 'stairSteps',
  tunnel: 'tunnelLen',
  len: 'tunnelLen',
  length: 'tunnelLen',
  width: 'width',
  w: 'width',
  height: 'height',
  h: 'height',
  torch: 'torchEvery',
  torches: 'torchEvery',
  ticks: 'ticksPerStep',
  tick: 'ticksPerStep',
  speed: 'ticksPerStep',
  reverse: 'reverseChance'
};

function parseMinerCommandOptions(raw){
  const opt = {};
  if (!raw) return opt;
  const tokens = raw.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
  const numeric = [];

  for (const token of tokens){
    const [k,v] = token.split('=');
    if (v !== undefined){
      const key = (k || '').toLowerCase();
      const mapTo = MINER_OPTION_KEYS[key];
      if (!mapTo) continue;
      let num = Number(v);
      if (!Number.isFinite(num)) continue;
      if (mapTo === 'reverseChance'){
        if (num > 1) num = num / 100;
        opt[mapTo] = Math.max(0, Math.min(1, num));
      } else {
        opt[mapTo] = Math.max(1, Math.round(num));
      }
      continue;
    }
    const asNum = Number(token);
    if (Number.isFinite(asNum)) numeric.push(asNum);
  }

  if (numeric[0] != null) opt.layers = Math.max(1, Math.round(numeric[0]));
  if (numeric[1] != null) opt.stairSteps = Math.max(1, Math.round(numeric[1]));
  if (numeric[2] != null) opt.tunnelLen = Math.max(1, Math.round(numeric[2]));
  return opt;
}

function describeMinerStatus(st){
  if (!st) return '⛏️ Шахтёр не инициализирован.';
  const running = st.running ? 'работает' : 'стоит';
  const done = st.stats?.layersDone ?? 0;
  const planned = st.opt?.layers;
  const target = Number.isFinite(planned) ? planned : '∞';
  const stairs = st.stats?.stairsSteps ?? 0;
  const tunnel = st.stats?.tunnelBlocks ?? 0;
  return `⛏️ Шахтёр ${running}. Слои ${done}/${target}, ступеней ${stairs}, тоннельных блоков ${tunnel}.`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Охрана
// ──────────────────────────────────────────────────────────────────────────────
function startGuardLoop(bot){
  if(bot.__fun_guardIv) return;
  bot.__fun_guardIv=setInterval(()=>{
    if(!state.protectMode) return;
    if(state.inCombat) return;
    attackNearest(bot,{ timeoutMs:6000, keep:2.6 }).catch(()=>{});
  },1850);
}
function stopGuardLoop(bot){
  if(bot.__fun_guardIv){ clearInterval(bot.__fun_guardIv); bot.__fun_guardIv=null; }
}

// ──────────────────────────────────────────────────────────────────────────────
// Регексы/алиасы (РУ++)
// ──────────────────────────────────────────────────────────────────────────────
const RE = {
  // общение
  help:/^(help|помощь|команды|хелп|справка|команда|что ты умеешь|\?)$/i,
  hello:/^(привет(ик)?|здравствуй(те)?|салют|йо|йоу|ку|даров|здоров(о|а)|hi|hello)\b/i,
  how: /(как\s+(дела|жизнь|сам)|как ты)\??$/i,
  what:/^(что\s+(делаешь|происходит|делаешь сейчас)|чем занят)\??$/i,

  // базовые режимы
  stop:/^(stop|стоп|стой|стопэ|остановись|остановка|замри|фриз|cancel|отмена|пауза|хватит)$/i,
  come:/^(come|подойди( ко мне)?|ко мне|сюда|иди (ко )?мне|иди сюда|подкатись)(?:\s|$)/i,

  // follow
  followToggle:/^(?:follow|следуй|следовать|иди за мной|за мной)\s+(on|off|вкл|выкл)$/i,
  followOn:/^(?:следуй|следовать|иди за мной|за мной|пошли|погнали|пойдём|идем|идём)\b.*(вкл|on)?$/i,
  followOff:/^(?:не\s*следуй|отстань|стой тут|стой здесь|останься|хватит следовать|следовать (выкл|off))$/i,

  // guard
  guardOn:/^(?:охрана|защита|охраняй|прикрой|guard|protect|сторожи|дефай|деф)(?:\s*(вкл|on))?$/i,
  guardOff:/^(?:охрана|защита|guard|protect|хватит охранять|охрана стоп|не охраняй)(?:\s*(выкл|off))?$/i,

  // шахтёр
  miner:/^(?:miner|шахт[её]р)\s+(start|stop|status)(?:\s+(.+))?$/i,

  // атака
  attack:/^(?:атак(?:а|уй|овать)|бей|ударь|удари|убей|вали|дерись|фигачи|лупи|атк|fight|attack|atk)(?:\s|$)/i,
  attackName:/^(?:атак(?:а|уй|овать)|бей|ударь|убей|вали|fight|attack|atk)\s+([a-zA-Zа-яА-ЯёЁ_\-\s]+)$/i,

  // инвентарь/статы
  inv:/^(инв|инвентарь|рюкзак|вещи|шмот|шмотки|карманы)$/i,
  stats:/^(статы|статистика|уровень|уровни|профиль|profile|stats)$/i,

  // текст в чат
  say:/^(скажи|напиши|в чат|скажи в чат)\s+(.+)$/i,

  // точки
  wpSet:/^(точка|метка|сохрани точку|пометь)\s+(.+)$/i,
  wpGo:/^(к\s*(точке|метке)\s+|иди\s+к\s+|на\s+метку\s+)(.+)$/i,
  wpList:/^(точки|метки|список точек|все точки)$/i,
  wpDel:/^(удали(ть)?\s*(точку|метку)\s+|сотри\s+)(.+)$/i,

  // ресурсы
  // строгое mine c количеством: «копай песок 20»
  mine:/^(?:добыть|добудь|добывай|копай|копать|ломай|фарм|фармить|собери|нафармь|намайнь|mine)\s+(.+?)\s+(\d+)$/i,

  // chop (без породы): «руб(и) / спили / дерево / древесину / брёвна [N|до стоп]»
  chop:/^(?:руби|руб|сруби|спили|спилить|пили|заготавливай|заготовь|лес|дерево|деревья|древесину|бр[её]вн[ао]?|бревно|wood|log|logs|chop)(?:\s+(до\s+стоп|беск(?:онечно)?|∞|inf|\d+))?$/i,

  // породы деревьев: «руби дуб [N|до стоп]»
  chopKind:/^(?:руби|сруби|спили|пили|дерево|деревья|бр[её]вна|бревна|wood|log|chop)\s+(дуб|т[её]мный дуб|ель|сосна|бер[её]за|джунгли|акация|мангров[а-я]*|вишня|черри|бамбук|бледный дуб)(?:\s+(до\s+стоп|беск(?:онечно)?|∞|inf))?(?:\s+(\d+))?$/i,

  // «копай|добудь дерево|древесину|брёвна [N|до стоп]»
  mineTree:/^(?:добы(?:ть|вай)|добудь|копай|копать|ломай|собери|собирать|фарм|фармить|нафармь|намайнь)\s+(?:дерево|деревья|древесину|бр[её]вн[ао]?|wood|log|logs)s?(?:\s+(до\s+стоп|беск(?:онечно)?|∞|inf|\d+))?$/i,

  // «копай <русский блок> [N|до стоп]»
  mineRu:/^(?:добы(?:ть|вай)|добудь|копай|копать|ломай|собери|собирать|фарм|фармить|нафармь|намайнь)\s+([а-яё_\-\s]+?)(?:\s+(до\s+стоп|беск(?:онечно)?|∞|inf|\d+))?$/i,

  craft:/^(крафт|скрафт(?:и|ань)|сделай|собери|создай)\s+(.+)$/i,
  smelt:/^(?:переплавка|переплавь|в печь|печь)(?:\s+(auto|ores|food))?$/i,
  house:/^(?:дом|построй дом|построй|постройка)(?:\s+(\d+))?(?:\s+(\d+))?$/i,

  // viewer
  viewer:/^(?:вьювер|вьюер|viewer|просмотр)\s+(on|off|вкл|выкл)$/i,

  // локальные инфо
  where:/^(?:где ты|ты где|координаты|коорд(ы|ыни)|coords?)$/i,
  time:/^(?:время|день|ночь|time)$/i,
  weather:/^(?:погода|дождь|снег|weather|rain)$/i,

  // моб-листы
  deny:/^(?:запрети|не бей|игнорировать|игнор)\s+(.+)$/i,
  allow:/^(?:разреши|бей|разрешить)\s+(.+)$/i,
  denyList:/^(?:чёрный список|черный список|blacklist|deny\s*list)$/i,

  // чистое число 1..64 → «руби дерево N»
  justNum:/^([1-9]|[1-5]\d|6[0-4])$/
};

// быстрые ответы
const RESP = {
  hello: (u = '') => sample([
    `Привет, ${u}!`,
    `Хэй, ${u}.`,
    `Здарова, ${u}!`,
    `${u}, рад видеть.`,
  ]),
  ok: () => sample(['Готово.', 'Сделано.', 'Есть.', 'Принял.']),
  stop: () => sample(['Останавливаюсь.', 'Встал на паузу.', 'Без проблем, стою.']),
  followOn: () => sample(['Следую за тобой.', 'Я в хвосте.', 'Держусь рядом.']),
  followOff: () => sample(['Перестал идти за тобой.', 'Остаюсь здесь.', 'Отцепился.']),
  guardOn: () => sample(['Включил режим охраны.', 'Сканирую угрозы.', 'Патрулирую рядом.']),
  guardOff: () => sample(['Охрану снял.', 'Патруль выключен.', 'Перехожу в пассив.']),
  attack: () => sample(['Атакую цель.', 'Жму на них.', 'Цель принята, работаю.', 'Врубаю боевой режим.']),
  coords: (p) => {
    const x = p?.x?.toFixed?.(1) ?? '??';
    const y = p?.y?.toFixed?.(1) ?? '??';
    const z = p?.z?.toFixed?.(1) ?? '??';
    return sample([
      `Моя позиция: X ${x} Y ${y} Z ${z}`,
      `Стою на ${x} / ${y} / ${z}`,
      `Координаты: ${x}, ${y}, ${z}`,
    ]);
  },
  time: (isNight) => isNight
    ? sample(['Сейчас ночь, будь осторожен.', 'Темнота вокруг.', 'Ночная смена.'])
    : sample(['День, всё видно.', 'Сейчас светло.', 'Работаем при свете.']),
  weather: (raining) => raining
    ? sample(['Льёт как из ведра.', 'Дождь включен.'])
    : sample(['Погода ясная.', 'Небо чистое.']),
  denyAdded: (n) => `Не трогаю: ${n}`,
  denyRemoved: (n) => `Убрал из стоп-листа: ${n}`,
  denyList: () => {
    const items = Array.from(DENY_SET).sort();
    return items.length ? `Стоп-лист: ${items.join(', ')}` : 'Стоп-лист пуст.';
  }
};

// ──────────────────────────────────────────────────────────────────────────────
// Форвард в ядро — только утилиты (никаких тяжёлых майнов!)
// ──────────────────────────────────────────────────────────────────────────────
function forward(bot, say, line, ack){
  if(ack) say.sayOnce(ack);
  bot.emit('message', { toString: () => line });
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Основной модуль
// ──────────────────────────────────────────────────────────────────────────────
function setupFunCommands(bot){
  try{ bot.__funCommandsLoaded=true; }catch{}
  const say=makeChatQueue(bot);
  const task=createTaskController(bot);
  let botname='';
  bot.once('spawn', ()=>{ botname=(bot.username||'').toLowerCase(); startGuardLoop(bot); });

  const prefix = HAS_CHAT_PREFIX ? CHAT_PREFIX : '!';

  // Нормализуем фразу "копай дерево" -> "руби дерево" (или "добудь дерево")
  try{
    let __rewrite=false;
    bot.on('chat', (username, message)=>{
      if(__rewrite) return; // защита от рекурсии
      try{
        const raw=String(message||'').trim();
        if(/^коп(?:ай|ни|ать)\s+дерев/i.test(raw)){
          __rewrite=true;
          const fixed=raw.replace(/^коп(?:ай|ни|ать)\s+дерев[а-яё]*/i,'руби дерево');
          // Подсказка пользователю
          say.sayOnce('Подсказка: лучше скажи: "руби дерево" или "добудь дерево".');
          // Переотправляем исправленную команду в общий обработчик
          __rewrite=false; return;
        }
      }catch{ __rewrite=false; }
    });
  }catch{}

  async function handle(username, rawMsg){
    if(!rawMsg) return;
    if(username===bot.username) return;

    // Always greet on simple hello/привет, но не всегда, чтобы не спамить
    try{
      const txt = String(rawMsg||'');
      if(/\b(привет|hi|hello)\b/i.test(txt)) { say.maybe('hello:auto', RESP.hello(username), { chance: 0.8, cooldown: 8000 }); return; }
    }catch{}
    // свободный смолток
    if(!CHAT_REQUIRE_MENTION){
      if(RE.hello.test(rawMsg)){ say.maybe('hello:auto', RESP.hello(username), { chance: 0.8, cooldown: 8000 }); return; }
      if(RE.how.test(rawMsg))  { say.maybe('mood:auto', `Все ок, ${state.task && state.task!=='idle' ? `занят ${state.task}` : 'просто наблюдаю'}.`, { chance: 0.7, cooldown: 8000 }); return; }
      if(RE.what.test(rawMsg)) { say.maybe('task:auto', `${state.task && state.task!=='idle' ? state.task : 'ни чем не занят'}.`, { chance: 0.7, cooldown: 8000 }); return; }
    }
    let cmd=extractCommand(rawMsg, botname);
    if(!cmd) return;
    cmd=normalize(cmd);
    const cleanedCmd=cmd.replace(/[.!?,…]+$/u,'').trim();
    if(cleanedCmd) cmd=cleanedCmd;
    try{ if(/^коп(?:ай|ни|ать)\s+(дерев|брев|брёв|древес|дров)/i.test(cmd)){ return; } }catch{}

    // чистое число → руби дерево N
    const mNum=cmd.match(RE.justNum);
    if(mNum){ chopTrees(bot, Number(mNum[1])).catch(()=>{}); return; }

    // смолток при обращении
    if(RE.hello.test(cmd)){ say.sayOnce(RESP.hello(username)); return; }
    if(RE.how.test(cmd))  { say.sayOnce(`😊 Норм, ${state.task && state.task!=='idle' ? `сейчас ${state.task}` : 'на готове'}.`); return; }
    if(RE.what.test(cmd)) { say.sayOnce(`⚙️ ${state.task && state.task!=='idle' ? state.task : 'осматриваюсь вокруг'}.`); return; }

    // справка
    if(RE.help.test(cmd)){
      say.say([
        '📖 Команды:',
        '• "5" → рубить дерево 5 (1..64)',
        '• руби|спили [порода] [N|до стоп] — дуб/ель/берёза/акация/джунгли/мангровое/вишня/бамбук/бледный дуб',
        '• дерево|древесину|брёвна [N|до стоп] — без породы (по умолчанию 8)',
        '• копай/добудь <блок> [N|до стоп] — песок, гравий, земля, глина... (камни/руды: ЗАПРЕТ)',
        '• атакуй [<моб>] — ближайшего или по имени (рус/англ)',
        '• подойди | следуй вкл|выкл | охраняй вкл|выкл',
        '• инвентарь | статы | где ты | время | погода',
        '• точка <имя> | к точке <имя> | удалить точку <имя> | точки',
        '• крафт <что> | переплавка [auto|ores|food] | дом [S H]',
        '• "miner start [слои] [ступени] [тоннель]" — шахтёр layered (stop|status)',
        '• стоп / отмена — остановить задачу'
      ].join('\n'));
      return;
    }

    // стоп
    if(RE.stop.test(cmd)){ task.stop(); state.isFollowing=false; state.followTarget=null; say.sayOnce(RESP.stop()); return; }

    // режимы/движение
    if(RE.followOn.test(cmd)){ state.isFollowing=true; state.followTarget=username; say.sayOnce(RESP.followOn()); return; }
    if(RE.followOff.test(cmd)){ state.isFollowing=false; state.followTarget=null; say.sayOnce(RESP.followOff()); return; }
    const mFT=cmd.match(RE.followToggle);
    if(mFT){ const sw=(mFT[1]||'').toLowerCase(); if(sw==='on'||sw==='вкл'){ state.isFollowing=true; state.followTarget=username; say.sayOnce(RESP.followOn()); } else { state.isFollowing=false; state.followTarget=null; say.sayOnce(RESP.followOff()); } return; }
    if(RE.guardOn.test(cmd)) { state.protectMode=true;  startGuardLoop(bot); say.sayOnce(RESP.guardOn()); return; }
    if(RE.guardOff.test(cmd)){ state.protectMode=false; stopGuardLoop(bot);  say.sayOnce(RESP.guardOff()); return; }

    const minerMatch = RE.miner && cmd.match(RE.miner);
    if (minerMatch){
      if (!bot.miner || typeof bot.miner.status !== 'function'){
        say.sayOnce('⛏️ Шахтёр недоступен.');
        return;
      }
      const action = (minerMatch[1] || '').toLowerCase();
      const tail = (minerMatch[2] || '').trim();

      if (action === 'status'){
        let status = null;
        try { status = bot.miner.status?.(); } catch {}
        say.sayOnce(describeMinerStatus(status));
        return;
      }

      if (action === 'stop'){
        try {
          const res = bot.miner.stop?.();
          if (res && typeof res.catch === 'function') res.catch(err => dlog('miner.stop', err?.message || err));
        } catch (e) {
          dlog('miner.stop', e?.message || e);
        }
        say.sayOnce('⛏️ Останавливаю шахтёра.');
        return;
      }

      if (action === 'start'){
        let status = null;
        try { status = bot.miner.status?.(); } catch {}
        if (status?.running){ say.sayOnce('⛏️ Уже копаю слой.'); return; }
        const opts = parseMinerCommandOptions(tail);
        say.sayOnce('⛏️ Запускаю шахтёра (layered).');
        task.stop();
        try {
          const maybe = bot.miner.start?.(Object.keys(opts).length ? opts : undefined);
          if (maybe && typeof maybe.catch === 'function'){
            maybe.catch(err => console.warn('[fun] miner.start fail', err?.message || err));
          }
        } catch (e) {
          console.warn('[fun] miner.start error', e?.message || e);
          say.sayOnce('❌ Не могу запустить шахтёра.');
        }
        return;
      }
    }

    if(RE.come.test(cmd)){
      try{
        const target=Object.values(bot.entities).find(e=>e?.type==='player' && e.username===username);
        if(!target){ say.sayOnce(`🙈 не вижу ${username}.`); return; }
        say.sayOnce(sample(['🏃 лечу','🏃 иду','🏃 бегу']));
        const mc=require('minecraft-data')(bot.version);
        const { Movements, goals } = require('mineflayer-pathfinder');
        const mv=new Movements(bot,mc); mv.allowSprinting=true; mv.canDig=false;
        bot.pathfinder.setMovements(mv);
        await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1));
        say.sayOnce(sample(['✅ я тут','✅ прибыл','✅ рядом']));
      }catch{ say.sayOnce('⚠️ не получилось подойти.'); }
      return;
    }

    // атака
    const mAttackName=cmd.match(RE.attackName);
    if(mAttackName){
      const token=normalize(mAttackName[1]).toLowerCase();
      const filterFn=makeMobFilter(token);
      say.sayOnce(RESP.attack());
      attackNearest(bot,{ filterFn }).catch(()=>{});
      return;
    }
    if(RE.attack.test(cmd)){ say.sayOnce(RESP.attack()); attackNearest(bot).catch(()=>{}); return; }

    // локальные инфо
    if(RE.where.test(cmd)){ const p=selfPos(bot); if(!p){ say.sayOnce('🧭 координаты неизвестны'); return; } say.sayOnce(RESP.coords(p)); return; }
    if(RE.time.test(cmd)) { const t=bot.time?.timeOfDay ?? 0; const isNight=(t>=13000 || t<1000); say.sayOnce(RESP.time(isNight)); return; }
    if(RE.weather.test(cmd)){ const r=!!bot.isRaining; say.sayOnce(RESP.weather(r)); return; }

    // моб-лист
    if(RE.deny.test(cmd)){ const m=cmd.match(RE.deny);  const raw=normName(m[1]); if(!raw){ say.sayOnce('❔ кого запретить?'); return; } DENY_SET.add(raw);    say.sayOnce(RESP.denyAdded(raw)); return; }
    if(RE.allow.test(cmd)){ const m=cmd.match(RE.allow); const raw=normName(m[1]); if(!raw){ say.sayOnce('❔ кого разрешить?'); return; } DENY_SET.delete(raw); say.sayOnce(RESP.denyRemoved(raw)); return; }
    if(RE.denyList.test(cmd)){ say.sayOnce(RESP.denyList()); return; }

    // короткие утилиты (прокидываем)
    if(RE.inv.test(cmd))   return forward(bot, say, `${prefix}inv`,   sample(['🎒 гляну рюкзак','🎒 чекну инвентарь']));
    if(RE.stats.test(cmd)) return forward(bot, say, `${prefix}stats`, sample(['📊 статы открываю','📈 смотрю профиль']));

    const mSay=cmd.match(RE.say); if(mSay) return forward(bot, say, `${prefix}say ${mSay[2]}`, `💬 ${mSay[2]}`);
    const mWpSet=cmd.match(RE.wpSet); if(mWpSet) return forward(bot, say, `${prefix}wp set ${normalize(mWpSet[2])}`, `📍 точка «${normalize(mWpSet[2])}» сохранена`);
    const mWpGo=cmd.match(RE.wpGo); if(mWpGo) return forward(bot, say, `${prefix}wp go ${normalize(mWpGo[3])}`, `🚶 иду к «${normalize(mWpGo[3])}»`);
    if(RE.wpList.test(cmd))        return forward(bot, say, `${prefix}wp list`, '📍 список точек');
    const mWpDel=cmd.match(RE.wpDel); if(mWpDel) return forward(bot, say, `${prefix}wp del ${normalize(mWpDel[4])}`, `🗑️ удаляю «${normalize(mWpDel[4])}»`);

    // рубка дерева (порода)
    const mChopKind=cmd.match(RE.chopKind);
    if(mChopKind){
      const kindRaw=mChopKind[1].toLowerCase();
      const speciesId=RU2EN_WOOD[kindRaw];
      const paramInf=mChopKind[2] && /до\s+стоп|беск|∞|inf/i.test(mChopKind[2]);
      const n=!paramInf && mChopKind[3] ? Math.max(1, Math.min(64, +mChopKind[3])) : (paramInf ? Infinity : 8);
      return chopTrees(bot, n, { species: speciesId, infinite: paramInf });
    }

    // рубка без породы
    // Quick Russian wood commands (no prefix/mention)
    try{
      const mQuickWood = cmd.match(/^(руби|сруби|добудь|добыть|добывай|собери|собрать)\s+дерев/i);
      if(mQuickWood){
        const tail=(cmd.split(/\s+/).slice(2).join(' ')||'').toLowerCase();
        const inf=/(до\s+конца|бесконечно|без\s*лимита|∞|inf|\?)/i.test(tail);
        const n=inf ? Infinity : Math.max(1, Math.min(64, +(tail || 8)));
        chopTrees(bot, n, { infinite: inf }).catch(()=>{});
        return;
      }
    }catch{}

    const mChop=cmd.match(RE.chop);
    if(mChop){
      const tail=(cmd.split(/\s+/).slice(1).join(' ')||'').toLowerCase();
      const inf=/до\s+стоп|беск|∞|inf/.test(tail);
      const n=inf ? Infinity : Math.max(1, Math.min(64, +(tail || 8)));
      chopTrees(bot, n, { infinite: inf }).catch(()=>{});
      return;
    }

    // «копай/добудь дерево …» → рубка
    const mMineTree=cmd.match(RE.mineTree);
    if(mMineTree){
      const p=(mMineTree[1]||'').toLowerCase();
      const inf=/до\s+стоп|беск|∞|inf/.test(p);
      const n=inf ? Infinity : Math.max(1, Math.min(64, +(p || 8)));
      chopTrees(bot, n, { infinite: inf }).catch(()=>{});
      return;
    }

    // «копай <рус> [N|до стоп]»
    const mMineRu=cmd.match(RE.mineRu);
    if(mMineRu){
      const raw=normalize(mMineRu[1]).toLowerCase();
      const mapped = RU2EN_ORE[raw] || RU2EN_BLOCK[raw];
      // запреты
      if (isStoneOrOre(mapped) || /руда|обломки|кварц/.test(raw) || /камень|булыжник|сланец|чернит|базальт|адский/.test(raw)) {
        return say.sayOnce('⛔ Камни и руды не копаю (запрещено, лагает).');
      }
      const param=(mMineRu[2]||'').toLowerCase();
      const inf=/до\s+стоп|беск|∞|inf/.test(param);
      const n=inf ? Infinity : Math.max(1, +param|0 || 1);
      if(!mapped) return say.sayOnce(`❓ не знаю блок «${raw}»`);
      return safeMineBlocks(bot, mapped, n);
    }

    // англ/точный mine: «mine sand 10»
    const mMine=cmd.match(RE.mine);
    if(mMine){
      const id=baseNameEn(mMine[1]);
      if(isStoneOrOre(id)) return say.sayOnce(`⛏️ ${id}: не копаю (запрещено, лагает).`);
      return safeMineBlocks(bot, id, Math.max(1, +mMine[2] || 1));
    }

    // viewer / build / craft / smelt
    const mCraft=cmd.match(RE.craft); if(mCraft) return forward(bot, say, `${prefix}craft ${mCraft[2]}`, `🛠️ крафчу: ${mCraft[2]}`);
    const mSmelt=cmd.match(RE.smelt); if(mSmelt) return forward(bot, say, `${prefix}smelt ${mSmelt[1]||'auto'}`, `🔥 переплавка: ${mSmelt[1]||'auto'}`);
    const mHouse=cmd.match(RE.house); if(mHouse) return forward(bot, say, `${prefix}build house ${mHouse[1]||5} ${mHouse[2]||3}`, `🏠 дом ${mHouse[1]||5}×${mHouse[1]||5}, высота ${mHouse[2]||3}`);

    const mViewer=cmd.match(RE.viewer);
    if(mViewer){ const sw=/^(on|вкл)$/i.test(mViewer[1])?'on':'off'; return forward(bot, say, `${prefix}viewer ${sw}`, `🖥️ viewer: ${sw}`); }

    // если ничего не совпало — просто отвечаем
    say.sayOnce('❔ Не понял. Напиши: помощь');
  }

  // подписка на чат
  const mode=String(process.env.COMMANDS_INPUT || 'both').toLowerCase();
  if(mode!=='telegram'){
    bot.on('chat', (username, message)=>{ handle(username, String(message||'').trim()).catch(()=>{}); });
    bot.on?.('systemChat', (json)=>{
      const txt=json?.toString?.().trim(); if(!txt) return;
      const mentioned=Object.keys(bot.players||{}).find((p)=>txt.includes(p));
      if(!mentioned) return;
      handle(mentioned, txt).catch(()=>{});
    });
  }
}

// Экспорт совместим как setupFunCommands и setup
module.exports = { setupFunCommands, setup: setupFunCommands };


