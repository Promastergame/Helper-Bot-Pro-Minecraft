'use strict';
/**
 * features/mining/mining.js — v2.0 "Cool mining with crypto"
 * Самостоятельный шахтёр с крипторандомом, FSM и безопасным роем.
 *
 * Цели:
 *  - Без X-ray и тяжёлого анализа: не сканирует руды, деревья и т.п.
 *  - Красиво роет коридоры 3×2 (высота 2), факел каждые N шагов.
 *  - Избегает опасностей (лава, вода, мобы, обрывы).
 *  - Не уходит далеко от точки старта (WORK_RADIUS).
 *  - Плавные повороты, лестница до нужного Y перед стартом.
 *  - Anti-lag: интеграция с features/ai/quantum/performance.cjs (если есть).
 */

const crypto = require('crypto');
const { Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock, GoalNear } = goals || {};

// ──────────────────────────────────────────────────────────────────────────────
// Опциональная оптимизация (если у тебя есть quantum/performance.cjs)
// ──────────────────────────────────────────────────────────────────────────────
let perf = null;
try { perf = require('../ai/quantum/performance.cjs'); } catch {}

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const waitTicks = async (bot,t)=> perf?.yieldTicks? await perf.yieldTicks(bot,t): await sleep(t*50);

// ──────────────────────────────────────────────────────────────────────────────
// Константы и наборы блоков
// ──────────────────────────────────────────────────────────────────────────────
const LIQUIDS = new Set(['water','flowing_water','lava','flowing_lava','bubble_column']);
const DANGERS = new Set([
  ...LIQUIDS,
  'cave_air','void_air' // пустота/край
]);
const SOLID_FILL = ['cobblestone','stone','deepslate','dirt','netherrack'];
const TORCH_NAMES = new Set(['torch','soul_torch']);

// Без анализа руд — намеренно не используем списки ORES.

// ──────────────────────────────────────────────────────────────────────────────
// FSM
// ──────────────────────────────────────────────────────────────────────────────
const STATE = {
  INIT: 0,
  MAKE_STAIRS: 1,
  CHOOSE_DIR: 2,
  DIG_STEP: 3,
  AVOID_HAZARD: 4,
  RETURN_HOME: 5,
  STOPPED: 6
};

// ──────────────────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ──────────────────────────────────────────────────────────────────────────────
function setMovements(bot){
  try{
    const mc = require('minecraft-data')(bot.version);
    const m = new Movements(bot, mc);
    m.allow1by1towers = false;
    m.parkour = false;
    m.maxDropDownDistance = 3;
    bot.pathfinder.setMovements(m);
  } catch {}
}

async function equipAny(bot, predicate){
  const it = bot.inventory.items().find(predicate);
  if(!it) return false;
  try { await bot.equip(it, 'hand'); return true; } catch { return false; }
}

function blockAt(bot, pos){ try { return bot.blockAt(pos); } catch { return null; } }
function blockNameAt(bot,pos){ return blockAt(bot,pos)?.name ?? null; }

function rndInt(min, max){ // крипторандом, включительно
  const span = (max - min + 1) >>> 0;
  const buf = crypto.randomBytes(4).readUInt32LE(0) >>> 0;
  return min + (buf % span);
}
function rndChoice(arr){ return arr[rndInt(0, arr.length-1)]; }

function forwardVec(bot){
  // Плавающий вектор (не округляем заранее)
  const yaw = bot.entity.yaw;
  return { dx: Math.sin(yaw), dz: Math.cos(yaw) };
}
function rightVec(bot){
  // Вправо относительно взгляда
  const { dx, dz } = forwardVec(bot);
  return { rx: dz, rz: -dx };
}

function flooredPos(bot){ return bot.entity.position.floored(); }
function dist(a, b){ return a.distanceTo(b); }

// Проверка мобов рядом
function nearestHostile(bot,within=6){
  try{
    for(const e of Object.values(bot.entities||{})){
      if(e?.type==='mob' && e.position){
        const d = bot.entity.position.distanceTo(e.position);
        if (d<=within && [
          'zombie','skeleton','creeper','spider','witch','enderman','slime','hoglin','zoglin','blaze',
          'magma_cube','guardian','drowned','husk','stray','pillager','vindicator','evoker','vex','bogged','breeze'
        ].includes(e.name)) return e;
      }
    }
  }catch{}
  return null;
}

async function dig(bot, pos) {
  try {
    const b = blockAt(bot,pos);
    if (!b || b.name === 'air' || b.name === 'bedrock') return false;
    // Защита от сыпучего: просто копаем аккуратно (минимум логики, без RAM-анализа)
    await bot.dig(b);
    return true;
  } catch { return false; }
}

function isDangerBlockName(name){
  return !!name && DANGERS.has(name);
}
function isLiquidName(name){ return !!name && LIQUIDS.has(name); }

async function seal(bot,pos){
  // ставим блок на позицию pos (если там жидкость или дырка с поддержкой снизу)
  const base = blockAt(bot, pos.offset(0,-1,0)) || blockAt(bot, bot.entity.position.offset(0,-1,0));
  if (!base) return false;
  const ok = await equipAny(bot, i=>SOLID_FILL.includes(i.name));
  if (!ok) { bot.chat('❗ Нет блоков для застройки'); return false; }
  try{
    await bot.placeBlock(base,{x:0,y:1,z:0}); // ставим над базой
    return true;
  } catch { return false; }
}

async function placeTorch(bot){
  // Пытаемся поставить факел на бок стены / на пол
  const hasTorch = await equipAny(bot, i=>TORCH_NAMES.has(i.name));
  if (!hasTorch) return false;
  // ставим на блок под ногами или сбоку
  const base = blockAt(bot, bot.entity.position.offset(0,-1,0));
  if (base){
    try { await bot.placeBlock(base, {x:0, y:1, z:0}); return true; } catch {}
  }
  // пробуем стену спереди
  const { dx, dz } = forwardVec(bot);
  const f = flooredPos(bot).offset(Math.round(dx), 0, Math.round(dz));
  const wall = blockAt(bot, f);
  if (wall){
    // попытка поставить на стену сверху (если API позволяет направленные клики)
    try { await bot.placeBlock(wall, {x:0, y:0, z:0}); return true; } catch {}
  }
  return false;
}

// Плавные повороты
async function lookRelative(bot, yawDelta){
  await bot.look(bot.entity.yaw + yawDelta, 0, false);
}

// ──────────────────────────────────────────────────────────────────────────────
// Красивая секция копания 3×2 (высота 2), без анализа руд.
// Роем "фронт" — тело и голова, ширина 3 по вектору вправо.
// Если видим опасность — выходим с false.
// ──────────────────────────────────────────────────────────────────────────────
async function digSlice3x2(bot, ahead=1){
  const base = flooredPos(bot);
  const { dx, dz } = forwardVec(bot);
  const { rx, rz } = rightVec(bot);

  // ограничиваем смещения к сетке
  const fdx = Math.round(dx), fdz = Math.round(dz);
  const frx = Math.round(rx), frz = Math.round(rz);

  for(let side=-1; side<=1; side++){ // -1,0,1 — ширина 3
    for(let h=0; h<=1; h++){ // 0 — тело, 1 — голова (высота 2)
      const pos = base.offset(frx*side + fdx*ahead, h, frz*side + fdz*ahead);
      const n = blockNameAt(bot,pos);
      if(!n) continue;

      if(isDangerBlockName(n)){
        // Попробуем закрыть жидкость/дыру, затем вернуть false для смены направления
        if (isLiquidName(n)) await seal(bot,pos);
        return false;
      }

      // Копаем блок (без анализа соседей)
      await dig(bot,pos);
      if(perf?.cd && !perf.cd('slice',80)) await waitTicks(bot,1);
    }
  }
  return true;
}

// Шаг вперёд с контролем
async function stepForward(bot){
  bot.setControlState('forward', true);
  await waitTicks(bot,6);
  bot.setControlState('forward', false);
}

// ──────────────────────────────────────────────────────────────────────────────
// Лестница вниз до targetY (аккуратно, 3×3 снизу + "ступень")
// ──────────────────────────────────────────────────────────────────────────────
async function digSlice3x3Down(bot, ahead=0){
  const base = flooredPos(bot);
  const { dx, dz } = forwardVec(bot);
  const { rx, rz } = rightVec(bot);

  const fdx = Math.round(dx), fdz = Math.round(dz);
  const frx = Math.round(rx), frz = Math.round(rz);

  for(let ax=-1; ax<=1; ax++){
    for(let az=-1; az<=1; az++){
      const pos = base.offset(frx*ax + fdx*ahead, -1, frz*ax + fdz*ahead);
      const n = blockNameAt(bot,pos);
      if(!n) continue;
      if(isDangerBlockName(n)){
        if (isLiquidName(n)) await seal(bot,pos);
        return false;
      }
      await dig(bot,pos);
    }
  }
  return true;
}

async function stepDownStair(bot){
  await digSlice3x3Down(bot,0);
  // ступень спереди (на уровне ног/головы)
  const ok = await digSlice3x2(bot,1);
  if(!ok) return false;
  bot.setControlState('forward', true);
  await waitTicks(bot,6);
  bot.setControlState('forward', false);
  return true;
}

async function makeStaircaseToY(bot,targetY=8){
  setMovements(bot);
  bot.chat(`⬇️ Спускаюсь лесенкой до Y=${targetY} (без X-ray, без анализа руд)`);
  while(Math.floor(bot.entity.position.y) > targetY){
    const h = nearestHostile(bot,6);
    if(h){
      bot.chat('⚠️ Моб рядом — отхожу назад');
      bot.setControlState('back', true);
      await waitTicks(bot,10);
      bot.setControlState('back', false);
    }
    await stepDownStair(bot);
    await waitTicks(bot, perf?1:2);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Выбор направления (крипторандом, мягкие фильтры)
// ──────────────────────────────────────────────────────────────────────────────
function dangerAhead(bot, steps=2){
  const { dx, dz } = forwardVec(bot);
  const fdx = Math.round(dx), fdz = Math.round(dz);
  const here = flooredPos(bot);
  for(let i=1; i<=steps; i++){
    const pos     = here.offset(fdx * i, 0, fdz * i);
    const posDown = pos.offset(0,-1,0);
    const name    = blockNameAt(bot,pos);
    const down    = blockNameAt(bot,posDown);
    if(isDangerBlockName(name)) return { pos, name };
    if(isDangerBlockName(down)) return { pos: posDown, name: down };
    if(!down || down === 'air') return { pos: posDown, name: 'void' }; // обрыв/яма
  }
  return null;
}

function scoreYaw(bot, yawDelta){
  const yaw = bot.entity.yaw;
  const dir = { dx: Math.sin(yaw + yawDelta), dz: Math.cos(yaw + yawDelta) };
  const here = flooredPos(bot);
  let score = 0;
  for(let i=1;i<=2;i++){
    const pos = here.offset(Math.round(dir.dx)*i,0,Math.round(dir.dz)*i);
    const below = pos.offset(0,-1,0);
    const n = blockNameAt(bot,pos);
    const dn = blockNameAt(bot, below);
    if(isDangerBlockName(n) || isDangerBlockName(dn)) score += 4;
    else if(!dn || dn === 'air') score += 2; // яма/обрыв — избегаем
    else if(n && n !== 'air') score += 0.1; // плотные блоки — небольшая цена
  }
  return score + Math.random()*0.05; // легкая рандомизация
}

async function chooseRandomDirection(bot){
  // Набор базовых поворотов: налево, направо, разворот, чуть-чуть
  const yawOptions = [
    Math.PI/2, -Math.PI/2, Math.PI, 0,
    Math.PI/4, -Math.PI/4
  ];
  // Предпочитаем направление с минимальной угрозой
  let best = yawOptions[0], bestScore = Infinity;
  for(const delta of yawOptions){
    const sc = scoreYaw(bot, delta);
    if(sc < bestScore){ bestScore = sc; best = delta; }
  }
  await lookRelative(bot, best);
  if(perf?.cd && !perf.cd('look',120)) await waitTicks(bot,1);
}

// ──────────────────────────────────────────────────────────────────────────────
// Один «красивый шаг»: копаем фронт 3×2 и шагаем вперёд. Факелы по счётчику.
// ──────────────────────────────────────────────────────────────────────────────
async function prettyStep(bot, ctx){
  // Проверка опасностей перед нами (моб/обрыв/жидкость)
  const mob = nearestHostile(bot,6);
  if(mob){
    bot.chat('⚠️ Моб! Поворачиваю и отступаю');
    await lookRelative(bot, Math.PI);
    await waitTicks(bot,2);
    return false;
  }

  // Проверяем ближайшие 2 блока по ходу — если жидкость, пробуем запечатать и сменить курс
  const danger = dangerAhead(bot,2);
  if(danger){
    if(isLiquidName(danger.name)) await seal(bot, danger.pos);
    bot.chat('🌊 Опасность впереди, меняю маршрут');
    return false;
  }

  // Проверка дыры под ногами (на один блок вперёд)
  const aheadGround = blockAt(bot, flooredPos(bot).offset( Math.round(forwardVec(bot).dx), -1, Math.round(forwardVec(bot).dz) ));
  if(!aheadGround || aheadGround.name === 'air' || isDangerBlockName(aheadGround.name)){
    // попробуем подложить блок
    const ok = await seal(bot, flooredPos(bot).offset( Math.round(forwardVec(bot).dx), 0, Math.round(forwardVec(bot).dz) ));
    if(!ok){ bot.chat('⚠️ Обрыв, разворачиваюсь'); return false; }
  }

  const okDig = await digSlice3x2(bot,1);
  if(!okDig) return false;

  await stepForward(bot);

  // Факел каждые N шагов
  ctx.stepsSinceTorch++;
  if (ctx.stepsSinceTorch >= ctx.torchEvery){
    const placed = await placeTorch(bot);
    if(placed) ctx.stepsSinceTorch = 0;
  }

  // Лёгкая рандомизация «характера»: иногда чуть поворачиваемся
  if (rndInt(1,10) === 1){ // ~10% шанс
    await lookRelative(bot, rndChoice([Math.PI/8, -Math.PI/8]));
  }

  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Петля “тоннели” с ограничением радиуса
// ──────────────────────────────────────────────────────────────────────────────
async function tunnelLoop(bot, ctx){
  bot.chat('🚇 Режим: свободные тоннели 3×2 с крипторандомом');
  while(ctx.running){
    // Не уходить далеко
    const here = bot.entity.position;
    if (dist(here, ctx.HOME) > ctx.WORK_RADIUS){
      bot.chat('↩️ Далеко от базы — возвращаюсь');
      ctx.state = STATE.RETURN_HOME;
    }

    switch (ctx.state){
      case STATE.CHOOSE_DIR:
        await chooseRandomDirection(bot);
        ctx.state = STATE.DIG_STEP;
        break;

      case STATE.DIG_STEP: {
        const ok = await prettyStep(bot, ctx);
        if(!ok) ctx.state = STATE.AVOID_HAZARD;
        else ctx.state = STATE.CHOOSE_DIR;
        break;
      }

      case STATE.AVOID_HAZARD:
        // Манёвр: отходим назад и ищем более безопасный угол
        try{ bot.setControlState('back', true); await waitTicks(bot,3); }catch{}
        try{ bot.setControlState('back', false); }catch{}
        await chooseRandomDirection(bot);
        ctx.state = STATE.CHOOSE_DIR;
        break;

      case STATE.RETURN_HOME:
        try {
          setMovements(bot);
          await bot.pathfinder.goto(new GoalNear(Math.floor(ctx.HOME.x), Math.floor(ctx.HOME.y), Math.floor(ctx.HOME.z), 2));
        } catch {}
        ctx.state = STATE.CHOOSE_DIR;
        break;

      default:
        ctx.state = STATE.CHOOSE_DIR;
        break;
    }

    if(perf?.cd && !perf.cd('loop',100)) await waitTicks(bot,1);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Публичное API
// ──────────────────────────────────────────────────────────────────────────────
module.exports = function makeShaftMiner(bot){
  let ctx = {
    running: false,
    state: STATE.INIT,
    HOME: null,
    WORK_RADIUS: 40,     // ограничение района
    targetY: 12,         // до какого Y копать лестницу (по умолчанию чуть выше лавовых озёр)
    torchEvery: 8,       // факел каждые N шагов
    stepsSinceTorch: 0
  };

  async function start(opts={}){
    if (ctx.running) return;
    ctx.running = true;

    ctx.WORK_RADIUS   = Number.isFinite(opts.radius) ? opts.radius : ctx.WORK_RADIUS;
    ctx.targetY       = Number.isFinite(opts.targetY) ? opts.targetY : ctx.targetY;
    ctx.torchEvery    = Number.isFinite(opts.torchEvery) ? opts.torchEvery : ctx.torchEvery;
    ctx.stepsSinceTorch = 0;

    ctx.HOME = bot.entity.position.clone();
    ctx.state = STATE.MAKE_STAIRS;

    try{
      setMovements(bot);
      // INIT → MAKE_STAIRS
      await makeStaircaseToY(bot, ctx.targetY);

      // Переход к свободным тоннелям
      ctx.state = STATE.CHOOSE_DIR;
      await tunnelLoop(bot, ctx);

    }catch(e){
      bot.chat('❌ Ошибка майнинга: '+(e?.message||e));
      ctx.running = false;
      ctx.state = STATE.STOPPED;
    }
  }

  async function stop(){
    if(!ctx.running) return;
    ctx.running = false;
    ctx.state = STATE.STOPPED;
    try{ bot.clearControlStates?.(); }catch{}
    bot.chat('🛑 Шахтёр остановлен');
  }

  return { start, stop };
};
