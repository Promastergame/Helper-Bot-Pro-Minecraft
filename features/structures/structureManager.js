'use strict';
/**
 * features/building/structureManager.js — v5 UltraBuilder
 * 🏗️ Супер-менеджер построек: палитры материалов (дерево/камень/кирпич/медь/незер/Энд),
 *     цветное стекло, ориентация NESW, безопасная укладка, автодокрафт (мягкий),
 *     расширенные чертежи: дом, башня, ферма, мост, ВИЛЛА, БЕСЕДКА.
 * CommonJS
 */

const { state } = require('../../core/state.cjs');
const { placeBlockSmart, sleep } = require('../utils/helpers.js');
const { addExp } = require('../leveling.js');
const { Vec3 } = require('vec3');
const { Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;

/* ────────────────────────── Utils ────────────────────────── */
const clamp  = (n,a,b)=> Math.max(a, Math.min(b,n));
const norm   = (s='')=> String(s).toLowerCase().replaceAll('ё','е').trim();
const key    = (p)=> `${p.x}|${p.y}|${p.z}`;
const now    = ()=> Date.now();
const throttle = (fn, ms=1400)=>{ let t=0; return (...a)=>{ const n=Date.now(); if (n-t>=ms){ t=n; try{ fn(...a);}catch{} } };};
const chatInfo = throttle((bot,msg)=>{ try{ bot.chat(msg);}catch{} }, 1400);

function items(bot){ try{ return bot.inventory.items(); } catch{ return []; } }
function countItem(bot,name){ return items(bot).filter(i=>i.name===name).reduce((s,it)=> s+(it.count||0),0); }
function hasAny(bot, names){ const set=new Set([].concat(names)); return items(bot).some(i=> set.has(i.name)); }

function dedupePlan(plan){
  const m=new Map(); for (const it of plan) m.set(key(it.pos), it); return [...m.values()];
}
function orderPlanSerpentine(plan){
  const byY = new Map();
  for (const it of plan){ const a=byY.get(it.pos.y)||[]; a.push(it); byY.set(it.pos.y,a); }
  const ys=[...byY.keys()].sort((a,b)=>a-b);
  const out=[];
  for (const y of ys){
    const layer = byY.get(y);
    const byZ = new Map();
    for (const it of layer){ const a=byZ.get(it.pos.z)||[]; a.push(it); byZ.set(it.pos.z,a); }
    const zs=[...byZ.keys()].sort((a,b)=>a-b);
    let flip=false;
    for (const z of zs){
      const row=byZ.get(z).sort((a,b)=> a.pos.x-b.pos.x);
      out.push(...(flip?row.reverse():row)); flip=!flip;
    }
  }
  return out;
}

/* ───────────────── Movements (бережно) ──────────────── */
const _mvCache=new WeakMap();
function ensureMovements(bot){
  if (_mvCache.has(bot)){ bot.pathfinder.setMovements(_mvCache.get(bot)); return; }
  let mc; try{ mc=require('minecraft-data')(bot.version); } catch{ mc=null; }
  if (!mc) return;
  const m = new Movements(bot, mc);
  m.scaffoldingBlocks = [];
  m.allow1by1towers = false;
  m.canDig = false;
  m.allowSprinting = true;
  m.maxDropDownDistance = 3;
  _mvCache.set(bot,m);
  bot.pathfinder.setMovements(m);
}
async function gotoNear(bot,pos,r=2){
  try{ await bot.pathfinder.goto(new GoalNear(pos.x,pos.y,pos.z,r)); }
  catch{ await bot.waitForTicks(10); }
}

/* ───────────────── Face/Placement ──────────────── */
async function lookFace(bot, face){
  if (!face) return;
  try{
    const yaw = Math.atan2(-face.x, -face.z);
    bot.look(yaw, bot.entity.pitch, true);
    await bot.waitForTicks(1);
  } catch{}
}
async function placeWithRetry(bot, it, { retries=2, microDelay=true } = {}){
  let ok=false, tries=0;
  while(!ok && tries<=retries){
    try{
      await lookFace(bot, it.face);
      await placeBlockSmart(bot, it.name, it.pos);
      ok=true;
    } catch{
      tries++;
      if (tries<=retries){ await sleep(60 + Math.floor(Math.random()*140)); }
    }
  }
  if (microDelay) await sleep(50 + Math.floor(Math.random()*80));
  return ok;
}
async function placeBatch(bot, plan, {
  batch=22, skipIfSame=true, microDelay=true, onProgress=null, signal=null, retries=2
} = {}){
  let used=0, fail=0, i=0;
  for (const it of plan){
    if (signal?.aborted) throw new Error('⛔ Строительство отменено');
    try{
      if (skipIfSame){
        const b = bot.blockAt(it.pos, false);
        if (b && b.name===it.name){
          i++; if ((i%batch)===0) await bot.waitForTicks(6);
          if (microDelay) await sleep(1);
          if (onProgress && (i%25===0)) try{ onProgress(i, plan.length);}catch{}
          continue;
        }
      }
      const ok = await placeWithRetry(bot, it, { retries, microDelay });
      if (ok) used++; else fail++;
    } catch{ fail++; }
    i++; if ((i%batch)===0) await bot.waitForTicks(6);
    if (onProgress && (i%25===0)) try{ onProgress(i, plan.length);}catch{}
  }
  if (onProgress) try{ onProgress(plan.length, plan.length);}catch{}
  return { placed: used, failed: fail, total: plan.length };
}

/* ───────────────── Directions ──────────────── */
const DIR_ALIASES = {
  n:'north', north:'north', север:'north',
  e:'east', east:'east', восток:'east',
  s:'south', south:'south', юг:'south',
  w:'west', west:'west', запад:'west'
};
function parseDirToken(words){
  for (const [k,v] of Object.entries(DIR_ALIASES)) if (words.includes(k)) return v;
  return null;
}
function quantizeYawToDir(yaw){
  const dirs = ['south','west','north','east'];
  const a = (yaw + Math.PI*2) % (Math.PI*2);
  const idx = Math.round(a / (Math.PI/2)) % 4;
  return dirs[idx];
}
function rotatePointLocal(x,z,dir){
  switch(dir){
    case 'north': return { x:+x, z:+z };
    case 'south': return { x:-x, z:-z };
    case 'east' : return { x:+z, z:-x };
    case 'west' : return { x:-z, z:+x };
    default     : return { x:+x, z:+z };
  }
}
function rotateFace(face, dir){
  if (!face) return null;
  const {x,z} = rotatePointLocal(face.x, face.z, dir);
  return { x, y:0, z };
}

/* ───────────────── Палитры / Материалы ──────────────── */
/** семейства палитр: wood / stone / brick / copper / nether / end */
const WOOD_BASES = {
  oak:'oak', spruce:'spruce', birch:'birch', jungle:'jungle', acacia:'acacia',
  dark_oak:'dark_oak', mangrove:'mangrove', cherry:'cherry', bamboo:'bamboo', pale_oak:'pale_oak'
};
const STONE_BASES = {
  stone:'stone', cobblestone:'cobblestone', andesite:'andesite', diorite:'diorite', granite:'granite', deepslate:'deepslate'
};
const BRICK_BASES = {
  bricks:'bricks', stone_bricks:'stone_bricks', deepslate_bricks:'deepslate_bricks',
  nether_bricks:'nether_bricks', red_nether_bricks:'red_nether_bricks', end_stone_bricks:'end_stone_bricks'
};
const COPPER_BASES = {
  cut_copper:'cut_copper', exposed_cut_copper:'exposed_cut_copper',
  weathered_cut_copper:'weathered_cut_copper', oxidized_cut_copper:'oxidized_cut_copper'
};
const NETHER_BASES = {
  blackstone:'blackstone', polished_blackstone_bricks:'polished_blackstone_bricks', basalt:'basalt'
};
const END_BASES = {
  end_stone:'end_stone', end_stone_bricks:'end_stone_bricks', purpur:'purpur'
};

const PAL_ALIAS = {
  // дерево (ru→en)
  дуб:'oak', ель:'spruce', береза:'birch', берёза:'birch', джунгли:'jungle', акация:'acacia',
  'темный дуб':'dark_oak','темный_дуб':'dark_oak','тёмный дуб':'dark_oak', мангровое:'mangrove',
  вишня:'cherry', бамбук:'bamboo', 'бледный дуб':'pale_oak', 'пале дуб':'pale_oak',
  // камень/кирпич
  камень:'stone', булыжник:'cobblestone', андезит:'andesite', диорит:'diorite', гранит:'granite', глубинный_сланец:'deepslate',
  кирпич:'bricks', каменные_кирпичи:'stone_bricks', сланцевые_кирпичи:'deepslate_bricks',
  адский_кирпич:'nether_bricks', красный_адский_кирпич:'red_nether_bricks', эндский_кирпич:'end_stone_bricks',
  // медь/незер/энд
  медь:'cut_copper', патинированная_медь:'weathered_cut_copper', окисленная_медь:'oxidized_cut_copper',
  чернит:'blackstone', полированный_чернит_кирпич:'polished_blackstone_bricks',
  базальт:'basalt', энд:'end_stone', пурпур:'purpur'
};

const GLASS_COLORS = {
  white:'white', light_gray:'light_gray', gray:'gray', black:'black', brown:'brown',
  red:'red', orange:'orange', yellow:'yellow', lime:'lime', green:'green',
  cyan:'cyan', light_blue:'light_blue', blue:'blue', purple:'purple', magenta:'magenta', pink:'pink'
};
const GLASS_ALIAS = {
  белое:'white', светло_серое:'light_gray', серое:'gray', черное:'black', коричневое:'brown',
  красное:'red', оранжевое:'orange', желтое:'yellow', лаймовое:'lime', зеленое:'green',
  бирюзовое:'cyan', голубое:'light_blue', синее:'blue', фиолетовое:'purple', пурпурное:'magenta', розовое:'pink'
};

function itemsMap(bot){
  const m=new Map(); for (const it of items(bot)) m.set(it.name, (m.get(it.name)||0) + (it.count||0)); return m;
}
function resolvePalette(bot, preferred){
  const pick = (pool, names)=> {
    for (const k of Object.keys(pool)) {
      if (hasAny(bot, names(k))) return k;
    }
    return null;
  };
  // 1) явный / алиас
  if (preferred){
    const p = WOOD_BASES[preferred] || STONE_BASES[preferred] || BRICK_BASES[preferred] ||
              COPPER_BASES[preferred] || NETHER_BASES[preferred] || END_BASES[preferred] ||
              WOOD_BASES[PAL_ALIAS[preferred]] || STONE_BASES[PAL_ALIAS[preferred]] ||
              BRICK_BASES[PAL_ALIAS[preferred]] || COPPER_BASES[PAL_ALIAS[preferred]] ||
              NETHER_BASES[PAL_ALIAS[preferred]] || END_BASES[PAL_ALIAS[preferred]];
    if (p) return p;
  }
  // 2) авто: что есть — дерево → камень → кирпич → медь → незер → энд
  const mp = itemsMap(bot);
  const wood = pick(WOOD_BASES, k => [`${k}_planks`, `${k}_log`, `${k}_stairs`, `${k}_door`, `${k}_fence`]);
  if (wood) return wood;
  const stone = pick(STONE_BASES, k => [`${k}`, `${k}_slab`, `${k}_stairs`, `${k}_wall`, 'cobblestone']);
  if (stone) return stone;
  const brick = pick(BRICK_BASES, k => [`${k}`, `${k}_slab`, `${k}_stairs`, `${k}_wall`]);
  if (brick) return brick;
  const copper = pick(COPPER_BASES, k => [k, `${k}_slab`, `${k}_stairs`]);
  if (copper) return copper;
  const nether = pick(NETHER_BASES, k => [k, `${k}_slab`, `${k}_stairs`, `${k}_wall`]);
  if (nether) return nether;
  const end = pick(END_BASES, k => [k, `${k}_slab`, `${k}_stairs`]);
  if (end) return end;
  return 'oak';
}
function resolveGlassColorToken(words){
  for (const [ru,en] of Object.entries(GLASS_ALIAS)) if (words.includes(ru)) return en;
  for (const en of Object.keys(GLASS_COLORS)) if (words.includes(en)) return en;
  return null;
}

/** семейство по палитре */
function paletteFamily(pal){
  if (WOOD_BASES[pal]) return 'wood';
  if (STONE_BASES[pal]) return 'stone';
  if (BRICK_BASES[pal]) return 'brick';
  if (COPPER_BASES[pal]) return 'copper';
  if (NETHER_BASES[pal]) return 'nether';
  if (END_BASES[pal]) return 'end';
  return 'wood';
}

/** теги → реальные блоки */
function resolveTag(tag, pal, glassColor='light_gray'){
  if (!tag || !tag.startsWith(':')) return tag;
  const fam = paletteFamily(pal);
  const base = pal;

  const wallFor = (b)=> `${b}_wall`;
  const stairsFor = (b)=> `${b}_stairs`;
  const slabFor   = (b)=> `${b}_slab`;

  switch(tag){
    case ':planks': // универсальный «стеновой» материал
    case ':wall':
      if (fam==='wood') return `${base}_planks`;
      if (fam==='stone') return base==='stone' ? 'stone' : base;
      if (fam==='brick') return base;
      if (fam==='copper') return base; // cut_copper
      if (fam==='nether') return base;
      if (fam==='end') return base==='end_stone' ? 'end_stone' : base;
      return `${base}_planks`;
    case ':floor':
      if (fam==='wood') return `${base}_planks`;
      if (fam==='copper') return slabFor(base);
      return slabFor((fam==='stone'||fam==='brick'||fam==='nether'||fam==='end') ? base : `${base}_planks`);
    case ':stairs':
    case ':roof':
      if (fam==='wood') return stairsFor(`${base}`);
      if (fam==='copper') return stairsFor(base);
      if (fam==='stone'||fam==='brick'||fam==='nether'||fam==='end') return stairsFor(base);
      return stairsFor(`${base}_planks`);
    case ':slab':
      if (fam==='wood') return slabFor(`${base}`);
      if (fam==='copper') return slabFor(base);
      if (fam==='stone'||fam==='brick'||fam==='nether'||fam==='end') return slabFor(base);
      return slabFor(`${base}_planks`);
    case ':fence':
      if (fam==='wood') return `${base}_fence`;
      // для камня/кирпича — «стены»
      if (fam!=='wood') return wallFor(base==='stone' ? 'cobblestone' : base);
      return `${base}_fence`;
    case ':door':
      if (fam==='wood') return `${base}_door`;
      return 'iron_door';
    case ':window':
    case ':glass':
      return glassColor ? `${glassColor}_stained_glass_pane` : 'glass_pane';
    case ':pillar':
      if (fam==='wood') return `${base}_log`;
      if (fam==='brick'||fam==='stone') return wallFor(base);
      if (fam==='nether') return wallFor(base);
      if (fam==='copper') return base;
      return `${base}_planks`;
    case ':accent':
      if (fam==='wood') return stairsFor(base);
      if (fam==='brick'||fam==='stone') return stairsFor(base);
      if (fam==='copper') return slabFor(base);
      return stairsFor(base);
    case ':light':
      return 'lantern'; // красивее факела
    default:
      return `${base}_planks`;
  }
}
function mapPlanMaterials(plan, pal, glassColor){
  return plan.map(it => ({ ...it, name: resolveTag(it.name, pal, glassColor) }));
}
function estimateFromTags(tagCounts, pal, glassColor){
  const out = {};
  for (const [name, cnt] of Object.entries(tagCounts)){
    const real = resolveTag(name, pal, glassColor);
    out[real] = (out[real]||0) + cnt;
  }
  return out;
}

/* ───────────────── Hazard / фундамент ──────────────── */
function hazardScore(bot, plan){
  try{
    const sample = plan.slice(0, Math.min(100, plan.length));
    let risk = 0;
    for (const it of sample){
      const below = bot.blockAt(it.pos.offset(0,-1,0));
      const n = below?.name || '';
      if (n.includes('lava'))  risk += 2;
      if (n.includes('water')) risk += 0.6;
    }
    return risk;
  } catch{ return 0; }
}

/* ───────────────── Парсер запросов ──────────────── */
function parseStructureQuery(q){
  const s = norm(q);
  const words = s.split(/\s+/);

  const mm   = s.match(/(\d+)\s*[xх]\s*(\d+)/);
  const nums = !mm ? s.match(/\b(\d{1,3})\b/g) : null;

  const pickPaletteToken = ()=>{
    for (const [k,v] of Object.entries(PAL_ALIAS)) if (s.includes(k)) return PAL_ALIAS[k];
    for (const k of Object.keys(WOOD_BASES))  if (s.includes(k)) return k;
    for (const k of Object.keys(STONE_BASES)) if (s.includes(k)) return k;
    for (const k of Object.keys(BRICK_BASES)) if (s.includes(k)) return k;
    for (const k of Object.keys(COPPER_BASES))if (s.includes(k)) return k;
    for (const k of Object.keys(NETHER_BASES))if (s.includes(k)) return k;
    for (const k of Object.keys(END_BASES))   if (s.includes(k)) return k;
    return null;
  };
  const dir = parseDirToken(words);
  const glassColor = resolveGlassColorToken(words) || 'light_gray';

  if (/^(дом|house|simple_house)\b/.test(s)){
    const size   = mm ? +mm[1] : (nums?.[0] ? +nums[0] : undefined);
    const height = mm ? +mm[2] : (nums?.[1] ? +nums[1] : undefined);
    return { id:'simple_house', opts:{ size, height, palette: pickPaletteToken(), dir, glassColor } };
  }
  if (/^(вилла|villa)\b/.test(s)){
    const sx = mm ? +mm[1] : (nums?.[0] ? +nums[0] : 9);
    const sz = mm ? +mm[2] : (nums?.[1] ? +nums[1] : 7);
    return { id:'villa', opts:{ sizeX:sx, sizeZ:sz, palette: pickPaletteToken(), dir, glassColor } };
  }
  if (/^(беседка|gazebo)\b/.test(s)){
    const r = nums?.[0] ? +nums[0] : 3;
    return { id:'gazebo', opts:{ radius:r, palette: pickPaletteToken(), dir, glassColor } };
  }
  if (/^(башня|watchtower|tower)\b/.test(s)){
    const height = nums?.[0] ? +nums[0] : undefined;
    return { id:'watchtower', opts:{ height, palette: pickPaletteToken(), dir, glassColor } };
  }
  if (/^(ферма|auto_farm|farm)\b/.test(s)){
    const size = nums?.[0] ? +nums[0] : undefined;
    return { id:'auto_farm', opts:{ size, palette: pickPaletteToken(), dir, glassColor } };
  }
  if (/^(мост|bridge)\b/.test(s)){
    const length = mm ? +mm[1] : (nums?.[0] ? +nums[0] : undefined);
    const width  = mm ? +mm[2] : (nums?.[1] ? +nums[1] : undefined);
    return { id:'bridge', opts:{ length, width, palette: pickPaletteToken(), dir, glassColor } };
  }
  return { id: s.split(/\s+/)[0], opts: {} };
}

/* ───────────────── Оценщики ──────────────── */
const estimators = {
  simple_house(opts){
    const size = clamp(opts.size ?? 5, 5, 11);
    const height = clamp(opts.height ?? 3, 3, 6);
    const perim = size*size;
    const walls = ((size*4)-4) * height;
    const roof  = (size+2) * (size+2);
    const windows = Math.max(2, Math.floor(size/2));
    const tags = {
      ':planks': perim + Math.ceil(walls*0.9),
      ':roof'  : roof,
      ':glass' : windows,
      ':door'  : 1,
      ':light' : Math.ceil(size/2)
    };
    return estimateFromTags(tags, opts.palette || 'oak', opts.glassColor || 'light_gray');
  },
  watchtower(opts){
    const h = clamp(opts.height ?? 10, 6, 24);
    return { cobblestone: 8*h, ladder: Math.max(1, h-1), lantern: Math.ceil(h/3) };
  },
  auto_farm(opts){
    const size = clamp(opts.size ?? 7, 5, 13);
    const inner = (size-2)*(size-2);
    const fence = size*4 - 4;
    return { fence, dirt: inner, farmland: inner-1, wheat: inner-1, water: 1, lantern: Math.ceil(size/2) };
  },
  bridge(opts){
    const L = clamp(opts.length ?? 12, 3, 64);
    const W = clamp(opts.width  ?? 3, 2, 9);
    const tags = { ':planks': L*W, ':fence': L*2 + Math.ceil(L/3)*2, ':light': Math.ceil(L/6) };
    return estimateFromTags(tags, opts.palette || 'oak', opts.glassColor || 'light_gray');
  },
  villa(opts){
    const sx = clamp(opts.sizeX ?? 9, 7, 17);
    const sz = clamp(opts.sizeZ ?? 7, 5, 15);
    const h  = 4;
    const floor = sx*sz;
    const walls = (sx*2 + (sz*2) - 4) * h;
    const roof  = (sx+2)*(sz+2);
    const cols  = 6; // колонны террасы
    const tags = {
      ':floor': floor,
      ':planks': Math.ceil(walls*0.9),
      ':roof': roof,
      ':pillar': cols*4,
      ':glass': Math.max(4, Math.floor((sx+sz)/2)),
      ':door': 2,
      ':light': Math.ceil((sx+sz)/2)
    };
    return estimateFromTags(tags, opts.palette || 'oak', opts.glassColor || 'light_gray');
  },
  gazebo(opts){
    const r = clamp(opts.radius ?? 3, 2, 6);
    const circ = Math.round(2*Math.PI*r);
    const floor = Math.round(Math.PI*r*r);
    const cols = 8;
    const tags = {
      ':floor': floor,
      ':pillar': cols*3,
      ':fence': circ,
      ':roof': (r+2)*(r+2),
      ':light': Math.ceil(cols/2)
    };
    return estimateFromTags(tags, opts.palette || 'oak', opts.glassColor || 'light_gray');
  }
};

/* ───────────────── Материалы: проверка и автодокрафт ──────────────── */
function checkMaterials(bot, required){
  const miss=[];
  for (const [id, need] of Object.entries(required||{})){
    const have = countItem(bot, id);
    if (have < need) miss.push({ id, need, have });
  }
  return miss;
}

async function tryAutoCraft(bot, shortages){
  // мягкий автокрафт (если доступен craftSimple)
  let craftSimple=null;
  try{ ({ craftSimple } = require('../crafting/crafting.js')); } catch{}
  if (!craftSimple) return false;

  const needMap = new Map(shortages.map(x=>[x.id, x]));
  const want = (id)=> (needMap.get(id)?.need || 0) - countItem(bot, id);

  const craft = async (name, qty)=> {
    if (qty<=0) return;
    try{ await craftSimple(bot, name, qty); await bot.waitForTicks(4); } catch{}
  };

  // Дерево: log → planks(4) → slabs/stairs/fence/door
  for (const k of Object.keys(WOOD_BASES)){
    const pl = `${k}_planks`;
    const log = `${k}_log`;
    const lackPl = want(pl);
    if (lackPl>0){
      const logs = countItem(bot, log);
      const makePl = Math.min(Math.ceil(lackPl/4), logs); // 1 log → 4 planks
      if (makePl>0) await craft(pl, makePl*4);
    }
    const pairs = [
      [`${k}_stairs`, 4], [`${k}_slab`, 6], [`${k}_fence`, 3], [`${k}_door`, 3]
    ];
    for (const [p,pack] of pairs){
      const need = want(p);
      if (need>0){
        const batches = Math.ceil(need/pack);
        await craft(p, batches*pack);
      }
    }
  }

  // Стекло: glass → panes(16)
  if (shortages.some(s=> s.id.endsWith('_stained_glass_pane') || s.id==='glass_pane')){
    const paneIds = shortages.map(s=>s.id).filter(id=> id.endsWith('_stained_glass_pane'));
    for (const pid of paneIds){
      const base = 'glass'; // упрощаем (без красителей)
      const need = want(pid);
      if (need>0){
        const batches = Math.ceil(need/16);
        await craft(pid, batches*16);
      }
    }
    const gp = 'glass_pane';
    const needGP = want(gp);
    if (needGP>0){
      const batches = Math.ceil(needGP/16);
      await craft(gp, batches*16);
    }
  }

  // Каменные стены/ступени/плиты — пробуем базовые варианты
  const stoneVariants = ['cobblestone','stone','stone_bricks','deepslate','deepslate_bricks','blackstone','polished_blackstone_bricks','end_stone_bricks'];
  for (const base of stoneVariants){
    for (const p of [`${base}_wall`, `${base}_stairs`, `${base}_slab`]){
      const need = want(p);
      if (need>0){
        const pack = p.endsWith('_wall') ? 6 : p.endsWith('_stairs') ? 4 : 6;
        const batches = Math.ceil(need/pack);
        await craft(p, batches*pack);
      }
    }
  }

  return true;
}

/* ───────────────── Менеджер ──────────────── */
class StructureManager {
  constructor(){
    this.blueprints = new Map();
    this._loadBlueprints();
    state.structures ??= { built:[], planned:[], maintained:[] };
    state.botStats ??= { housesBuilt:0 };
  }

  registerBlueprint(bp){
    if (!bp?.id || typeof bp.build!=='function') throw new Error('Некорректный чертёж');
    if (typeof bp.estimate!=='function') bp.estimate = () => bp.materials||{};
    this.blueprints.set(bp.id, bp);
  }

  listBlueprints(){ return [...this.blueprints.values()].map(b=>({id:b.id,name:b.name})); }

  getBuildableStructures(bot){
    return [...this.blueprints.values()].map(bp=>({id:bp.id, name:bp.name}))
      .filter(entry=>{
        const bp = this.blueprints.get(entry.id);
        const {miss} = this._check(bot, bp.estimate, {});
        return miss.length===0;
      });
  }

  estimate(q){
    const { id, opts } = parseStructureQuery(q||'');
    const bp = this.blueprints.get(id);
    if (!bp) throw new Error(`Неизвестная структура: ${id}`);
    return bp.estimate(opts);
  }

  _check(bot, estimator, opts){
    const need = estimator(opts||{});
    const miss = checkMaterials(bot, need);
    return { need, miss };
  }

  /**
   * Построить структуру.
   * @param {import('mineflayer').Bot} bot
   * @param {string} structureQuery  Примеры: "вилла 11x9 ель восток синие стекло"
   * @param {{ position?: Vec3, dryRun?: boolean, signal?: AbortSignal, onProgress?: Function, autoCraft?: boolean }} options
   */
  async buildStructure(bot, structureQuery, options={}){
    const { position=null, dryRun=false, signal=null, onProgress=null, autoCraft=true } = options;
    const { id, opts } = parseStructureQuery(structureQuery||'');
    const bp = this.blueprints.get(id);
    if (!bp) throw new Error(`Неизвестная структура: ${id}`);

    // палитра/направление/цвет стекла
    const palette = resolvePalette(bot, opts.palette);
    const dir = opts.dir || quantizeYawToDir(bot.entity?.yaw ?? 0);
    const glassColor = opts.glassColor || 'light_gray';
    const buildPos = (position || bot.entity?.position)?.floored?.() ?? bot.entity.position.floored();

    const { need, miss } = this._check(bot, (o)=> bp.estimate({...o, palette, glassColor}), {...opts, palette, glassColor});

    if (dryRun){
      if (miss.length) chatInfo(bot, `📦 Не хватает: ${miss.map(m=>`${m.id} (${m.have}/${m.need})`).join(', ')}`);
      else chatInfo(bot, `✅ Материалов достаточно для "${bp.name}".`);
      return { success: miss.length===0, position: buildPos, estimate: need, missing: miss, palette, dir, glassColor };
    }

    let missing = miss;
    if (missing.length && autoCraft){
      chatInfo(bot, '🛠️ Пробую докрафтить недостающее…');
      await tryAutoCraft(bot, missing).catch(()=>{});
      const re = this._check(bot, (o)=> bp.estimate({...o, palette, glassColor}), {...opts, palette, glassColor});
      missing = re.miss;
    }
    if (missing.length){
      chatInfo(bot, `❌ Не хватает: ${missing.map(m=>`${m.id} (${m.have}/${m.need})`).join(', ')}`);
      return { success:false, missing, estimate: need, palette, dir, glassColor };
    }

    chatInfo(bot, `🏗️ Строю: ${bp.name} (${palette}, ${dir})…`);
    ensureMovements(bot);
    await gotoNear(bot, buildPos, 2);

    const result = await bp.build(bot, buildPos, { ...opts, palette, dir, glassColor, signal, onProgress });
    if (!result?.success) throw new Error(`Строительство "${bp.name}" не удалось.`);

    state.structures.built.push({ id, position: result.position, builtAt: now(), params: { ...opts, palette, dir, glassColor }, ...result });
    if (id==='simple_house' || id==='villa') state.botStats.housesBuilt = (state.botStats.housesBuilt||0)+1;

    addExp(55, `строительство (${bp.name})`);
    chatInfo(bot, `✅ Готово: ${bp.name}.`);
    return result;
  }

  /* ───────── Blueprints ───────── */
  _loadBlueprints(){
    /* 🏠 Дом */
    this.registerBlueprint({
      id: 'simple_house',
      name: 'Простой дом',
      estimate: (opts)=> estimators.simple_house(opts),
      build: async (bot, position, opts={})=>{
        const pal = resolvePalette(bot, opts.palette);
        const dir = opts.dir || 'north';
        const size   = clamp(opts.size ?? 6, 5, 11);
        const height = clamp(opts.height ?? 4, 3, 6);
        const base   = position.floored();
        const doorX  = Math.floor(size/2);

        /** @type {{name:string,pos:Vec3,face?:{x:number,y:number,z:number}}[]} */
        const plan = [];

        // пол/фундамент
        for (let x=0;x<size;x++) for (let z=0;z<size;z++)
          plan.push({ name: ':floor', pos: base.offset(x,-1,z) });

        // стены
        for (let y=0;y<height;y++){
          for (let x=0;x<size;x++){
            for (let z=0;z<size;z++){
              const edge = (x===0||x===size-1||z===0||z===size-1);
              const doorHole = (x===doorX && z===0 && y<2);
              if (!edge || doorHole) continue;
              let face = {x:0,y:0,z:1};
              if (z===0) face={x:0,y:0,z:-1};
              else if (z===size-1) face={x:0,y:0,z:1};
              else if (x===0) face={x:-1,y:0,z:0};
              else face={x:1,y:0,z:0};
              plan.push({ name: ':planks', pos: base.offset(x,y,z), face });
            }
          }
        }

        // окна/дверь/фонари
        if (size>=5){
          plan.push({ name: ':glass', pos: base.offset(doorX-1,1,0) });
          plan.push({ name: ':glass', pos: base.offset(doorX+1,1,0) });
        }
        plan.push({ name: ':door', pos: base.offset(doorX,0,0), face:{x:0,y:0,z:-1} });
        plan.push({ name: ':light', pos: base.offset(0, height-1, Math.floor(size/2)) });

        // крыша (ступени наружу)
        for (let x=-1;x<=size;x++)
          for (let z=-1;z<=size;z++){
            const dx = (x<0) ? -1 : (x>size-1?1:0);
            const dz = (z<0) ? -1 : (z>size-1?1:0);
            const face = (Math.abs(dx)+Math.abs(dz)) ? {x:dx,y:0,z:dz} : {x:0,y:0,z:1};
            plan.push({ name: ':roof', pos: base.offset(x, height, z), face });
          }

        // поворот
        const rotated = plan.map(it=>{
          const rel = it.pos.minus(base); const r = rotatePointLocal(rel.x, rel.z, dir);
          return { ...it, pos: new Vec3(base.x + r.x, it.pos.y, base.z + r.z), face: rotateFace(it.face, dir) };
        });

        const materialized = mapPlanMaterials(rotated, pal, opts.glassColor);
        const risk = hazardScore(bot, materialized);
        if (risk>2) chatInfo(bot, '⚠️ Вода/лава рядом — ставлю аккуратно.');

        const ordered = orderPlanSerpentine(dedupePlan(materialized));
        const res = await placeBatch(bot, ordered, { batch: 24, microDelay:true, skipIfSame:true, retries:2, onProgress:opts.onProgress, signal:opts.signal });
        return { success: res.placed>0, position: base, size, height, palette: pal, dir, ...res };
      }
    });

    /* 🏛️ Вилла с террасой и колоннами */
    this.registerBlueprint({
      id: 'villa',
      name: 'Вилла',
      estimate: (opts)=> estimators.villa(opts),
      build: async (bot, position, opts={})=>{
        const pal = resolvePalette(bot, opts.palette);
        const dir = opts.dir || 'south';
        const sx = clamp(opts.sizeX ?? 11, 7, 17);
        const sz = clamp(opts.sizeZ ?? 9, 5, 15);
        const h  = 4;
        const base = position.floored();
        const cx = Math.floor(sx/2);

        const plan=[];
        // пол
        for (let x=0;x<sx;x++) for (let z=0;z<sz;z++)
          plan.push({ name: ':floor', pos: base.offset(x,-1,z) });

        // стены + окна по периметру
        for (let y=0;y<h;y++){
          for (let x=0;x<sx;x++) for (let z=0;z<sz;z++){
            const edge = (x===0||x===sx-1||z===0||z===sz-1);
            const doorHole = (z===0 && x===cx && y<2);
            if (!edge || doorHole) continue;
            let face = {x:0,y:0,z:1};
            if (z===0) face={x:0,y:0,z:-1}; else if (z===sz-1) face={x:0,y:0,z:1};
            else if (x===0) face={x:-1,y:0,z:0}; else face={x:1,y:0,z:0};
            // окна через один блок
            if (y===2 && (x%3===1) && (z===0||z===sz-1)) plan.push({ name: ':glass', pos: base.offset(x,y, z) });
            else plan.push({ name: ':planks', pos: base.offset(x,y,z), face });
          }
        }

        // парадный вход: двойная дверь + навес
        plan.push({ name: ':door', pos: base.offset(cx,0,0), face:{x:0,y:0,z:-1} });
        plan.push({ name: ':door', pos: base.offset(cx-1,0,0), face:{x:0,y:0,z:-1} });
        for (let x=cx-2; x<=cx+2; x++) plan.push({ name: ':roof', pos: base.offset(x, h, -1), face:{x:0,y:0,z:-1} });

        // колонны террасы спереди
        for (const x of [1, Math.floor(sx/3), Math.floor(2*sx/3), sx-2]){
          for (let y=0;y<3;y++) plan.push({ name: ':pillar', pos: base.offset(x, y, -1) });
          plan.push({ name: ':light', pos: base.offset(x, 3, -1) });
        }

        // крыша по периметру
        for (let x=-1;x<=sx;x++) for (let z=-1;z<=sz;z++){
          const dx = (x<0)?-1:(x>sx-1?1:0); const dz=(z<0)?-1:(z>sz-1?1:0);
          const face = (Math.abs(dx)+Math.abs(dz)) ? {x:dx,y:0,z:dz} : {x:0,y:0,z:1};
          plan.push({ name: ':roof', pos: base.offset(x, h+1, z), face });
        }

        // поворот и материализация
        const rotated = plan.map(it=>{
          const rel = it.pos.minus(base); const r = rotatePointLocal(rel.x, rel.z, dir);
          return { ...it, pos: new Vec3(base.x + r.x, it.pos.y, base.z + r.z), face: rotateFace(it.face, dir) };
        });
        const materialized = mapPlanMaterials(rotated, pal, opts.glassColor);
        const ordered = orderPlanSerpentine(dedupePlan(materialized));
        const res = await placeBatch(bot, ordered, { batch: 28, microDelay:true, skipIfSame:true, retries:2, onProgress:opts.onProgress, signal:opts.signal });
        return { success: res.placed>0, position: base, sizeX:sx, sizeZ:sz, palette:pal, dir, ...res };
      }
    });

    /* 🛖 Беседка (октагон) */
    this.registerBlueprint({
      id: 'gazebo',
      name: 'Беседка',
      estimate: (opts)=> estimators.gazebo(opts),
      build: async (bot, position, opts={})=>{
        const pal = resolvePalette(bot, opts.palette);
        const r = clamp(opts.radius ?? 3, 2, 6);
        const base = position.floored();
        const plan=[];
        // дисковый пол (грубая аппроксимация круга)
        for (let x=-r; x<=r; x++)
          for (let z=-r; z<=r; z++)
            if (x*x + z*z <= r*r + r*0.6)
              plan.push({ name: ':floor', pos: base.offset(x,-1,z) });

        // 8 колонн по окружности и ограждение
        const pts=[];
        for (let k=0;k<8;k++){
          const ang = (Math.PI*2)*k/8;
          const x = Math.round(Math.cos(ang)*r);
          const z = Math.round(Math.sin(ang)*r);
          pts.push([x,z]);
        }
        for (const [x,z] of pts){
          for (let y=0;y<3;y++) plan.push({ name: ':pillar', pos: base.offset(x,y,z) });
          plan.push({ name: ':light', pos: base.offset(x,3,z) });
        }
        // перила
        for (let k=0;k<8;k++){
          const [x1,z1] = pts[k];
          const [x2,z2] = pts[(k+1)%8];
          const steps = Math.max(Math.abs(x2-x1),Math.abs(z2-z1));
          for (let t=0;t<=steps;t++){
            const x = Math.round(x1 + (x2-x1)*t/steps);
            const z = Math.round(z1 + (z2-z1)*t/steps);
            plan.push({ name: ':fence', pos: base.offset(x,0,z) });
          }
        }

        // купольная крыша (ступени слоями)
        for (let y=0;y<=2;y++){
          const rr = r + 1 - y;
          for (let x=-rr-1;x<=rr+1;x++)
            for (let z=-rr-1;z<=rr+1;z++){
              if (x*x + z*z <= (rr+0.5)*(rr+0.5))
                plan.push({ name: ':roof', pos: base.offset(x, 3+y, z), face:{x:0,y:0,z:1} });
            }
        }

        const materialized = mapPlanMaterials(plan, pal, opts.glassColor);
        const ordered = orderPlanSerpentine(dedupePlan(materialized));
        const res = await placeBatch(bot, ordered, { batch: 22, microDelay:true, skipIfSame:true, retries:2, onProgress:opts.onProgress, signal:opts.signal });
        return { success: res.placed>0, position: base, radius:r, palette:pal, ...res };
      }
    });

    /* 🗼 Башня */
    this.registerBlueprint({
      id: 'watchtower',
      name: 'Смотровая башня',
      estimate: (opts)=> estimators.watchtower(opts),
      build: async (bot, position, opts={})=>{
        const base = position.floored();
        const height = clamp(opts.height ?? 10, 6, 24);
        const plan=[];
        for (let y=0;y<height;y++){
          for (let x=-1;x<=1;x++) for (let z=-1;z<=1;z++){
            const center = (x===0 && z===0);
            if (!center) plan.push({ name:'cobblestone', pos: base.offset(x,y,z) });
          }
          if (y<height-1) plan.push({ name:'ladder', pos: base.offset(0,y,1), face:{x:0,y:0,z:1} });
          if (y%3===0)   plan.push({ name:'lantern',  pos: base.offset(-1,y,-1) });
        }
        const ordered = orderPlanSerpentine(dedupePlan(plan));
        const res = await placeBatch(bot, ordered, { batch: 24, microDelay:true, skipIfSame:true, retries:2, onProgress:opts.onProgress, signal:opts.signal });
        return { success: res.placed>0, position: base, height, ...res };
      }
    });

    /* 🌾 Ферма */
    this.registerBlueprint({
      id: 'auto_farm',
      name: 'Авто-ферма',
      estimate: (opts)=> estimators.auto_farm(opts),
      build: async (bot, position, opts={})=>{
        const pal = resolvePalette(bot, opts.palette);
        const size = clamp(opts.size ?? 7, 5, 13);
        const base = position.floored();
        const plan=[];
        // забор по контуру
        for (let i=0;i<size;i++){
          plan.push({ name:':fence', pos: base.offset(i,0,0), face:{x:0,y:0,z:-1} });
          plan.push({ name:':fence', pos: base.offset(i,0,size-1), face:{x:0,y:0,z:1} });
          plan.push({ name:':fence', pos: base.offset(0,0,i), face:{x:-1,y:0,z:0} });
          plan.push({ name:':fence', pos: base.offset(size-1,0,i), face:{x:1,y:0,z:0} });
        }
        // центр — вода, остальное грядки
        const cx=Math.floor(size/2), cz=Math.floor(size/2);
        for (let x=1;x<size-1;x++){
          for (let z=1;z<size-1;z++){
            if (x===cx && z===cz) plan.push({ name:'water', pos: base.offset(x,0,z) });
            else{
              plan.push({ name:'farmland', pos: base.offset(x,0,z) });
              plan.push({ name:'wheat',    pos: base.offset(x,1,z) });
            }
          }
        }
        // фонари по углам
        plan.push({ name:':light', pos: base.offset(0,1,0) });
        plan.push({ name:':light', pos: base.offset(size-1,1,0) });
        plan.push({ name:':light', pos: base.offset(0,1,size-1) });
        plan.push({ name:':light', pos: base.offset(size-1,1,size-1) });

        const materialized = mapPlanMaterials(plan, pal, opts.glassColor);
        const ordered = orderPlanSerpentine(dedupePlan(materialized));
        const res = await placeBatch(bot, ordered, { batch: 24, microDelay:true, skipIfSame:true, retries:2, onProgress:opts.onProgress, signal:opts.signal });
        return { success: res.placed>0, position: base, size, palette:pal, ...res };
      }
    });

    /* 🌉 Мост (перила + стойки) */
    this.registerBlueprint({
      id: 'bridge',
      name: 'Деревянный мост',
      estimate: (opts)=> estimators.bridge(opts),
      build: async (bot, position, opts={})=>{
        const pal = resolvePalette(bot, opts.palette);
        const dir = opts.dir || quantizeYawToDir(bot.entity?.yaw ?? 0);
        const L = clamp(opts.length ?? 14, 3, 64);
        const W = clamp(opts.width  ?? 3, 2, 9);
        const base = position.floored();

        const forward = (()=>{ switch(dir){case'north':return {x:0,z:-1}; case'south':return {x:0,z:1}; case'east':return {x:1,z:0}; case'west':return {x:-1,z:0}; default:return {x:0,z:1}; }})();
        const right = { x: -forward.z, z: forward.x };

        const plan=[];
        for (let i=0;i<L;i++){
          for (let w=0; w<W; w++){
            const px = base.x + forward.x*i + right.x*w;
            const pz = base.z + forward.z*i + right.z*w;
            plan.push({ name: ':floor', pos: new Vec3(px, base.y-1, pz) });
            if (w===0 || w===W-1){
              const face = w===0 ? {x:-right.x, y:0, z:-right.z} : {x:right.x,y:0,z:right.z};
              plan.push({ name: ':fence', pos: new Vec3(px, base.y, pz), face });
              if (i%6===0) plan.push({ name: ':light', pos: new Vec3(px, base.y+1, pz) });
            }
          }
          // стойки вниз
          if (i%3===0){
            for (const w of [0, W-1]){
              const sx = base.x + forward.x*i + right.x*w;
              const sz = base.z + forward.z*i + right.z*w;
              for (let dy=0; dy<4; dy++) plan.push({ name: ':fence', pos: new Vec3(sx, base.y-1-dy, sz) });
            }
          }
        }
        const materialized = mapPlanMaterials(plan, pal, opts.glassColor);
        const ordered = orderPlanSerpentine(dedupePlan(materialized));
        const res = await placeBatch(bot, ordered, { batch: 28, microDelay:true, skipIfSame:true, retries:2, onProgress:opts.onProgress, signal:opts.signal });
        return { success: res.placed>0, position: base, length:L, width:W, palette:pal, dir, ...res };
      }
    });
  }
}

const structureManager = new StructureManager();

module.exports = {
  StructureManager,
  structureManager
};
