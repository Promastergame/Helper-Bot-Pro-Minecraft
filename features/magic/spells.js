'use strict';
// ===============================
// features/magic/spells.js — v6.2
// 🪄 Ванильная «магия» без модов + опциональные «читы» (если включены в state.cheatsEnabled)
//   • Заклинания работают через реальные действия Mineflayer: факелы, бросок снежка, рывок, барьеры и т.д.
//   • В режиме читов (если сервер разрешает команды) — мягкий переход к /effect, /tp, /weather
//   • Таймеры, мана, кулдауны, безопасная укладка блоков, прицел с микросмещением
// ===============================

const { state } = require('../../core/state.cjs');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { placeBlockSmart } = require('../utils/helpers.js');

// ───────────────────────────────────────────────────────────────────────────────
// Вспомогательные
// ───────────────────────────────────────────────────────────────────────────────
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const jitter = ()=> 80 + Math.random()*170; // 80–250 мс «живости»
const clamp = (v,a,b)=> Math.max(a, Math.min(b,v));

function isCheats(){ return !!state.cheatsEnabled; }
function safeChat(bot, msg){ try { bot.chat(msg); } catch {} }
function items(bot){ try { return bot.inventory.items(); } catch { return []; } }
function count(bot, name){ return items(bot).filter(i=> i.name===name).reduce((s,it)=>s+it.count,0); }
function has(bot, name, n=1){ return count(bot,name) >= n; }

function solid(bot, p){ const b = bot.blockAt(p); return b && b.name !== 'air' && b.boundingBox !== 'empty'; }
function isHazard(bot, p){ const b = bot.blockAt(p); if(!b) return false; return new Set(['lava','magma_block','cactus','fire','campfire','sweet_berry_bush']).has(b.name); }
function isAir(bot, p){ const b = bot.blockAt(p); return !b || b.name === 'air' || b.boundingBox === 'empty'; }
function isSafeStanding(bot, p){
  // есть твёрдый блок под ногами и нет опасности рядом
  const feet = p.floored();
  if (!solid(bot, feet.offset(0,-1,0))) return false;
  for (let dx=-1; dx<=1; dx++) for (let dz=-1; dz<=1; dz++){
    if (isHazard(bot, feet.offset(dx,0,dz))) return false;
  }
  return true;
}

async function lookAtSoft(bot, vec){ try { await bot.lookAt(vec, true); } catch {} }

async function equipAny(bot, names){
  const inv = items(bot);
  const it = inv.find(i=> names.includes(i.name));
  if (!it) return null;
  try { await bot.equip(it, 'hand'); return it; } catch { return null; }
}

// ───────────────────────────────────────────────────────────────────────────────
// Мана и кулдауны
// ───────────────────────────────────────────────────────────────────────────────
const MANA = { start: 100, max: 100, regenMs: 3000, regenPerTick: 1 };
const COOLDOWNS = { heal: 7000, light: 2500, missile: 1200, dash: 4000, barrier: 8000, flare: 6000 };
const COST = { heal: 12, light: 6, missile: 4, dash: 10, barrier: 14, flare: 8 };

class TTLMap { constructor(){ this.m = new Map(); } set(k,ms){ this.m.set(k, Date.now()+ms); } ready(k){ return (Date.now() >= (this.m.get(k)||0)); } }

// ───────────────────────────────────────────────────────────────────────────────
// Основная система
// ───────────────────────────────────────────────────────────────────────────────
class MagicSystem {
  constructor(){
    this.cool = new TTLMap();
    if (!state.magic) state.magic = { mana: MANA.start, maxMana: MANA.max };
    this.startManaRegen();
    this._spells = this._loadSpells();
  }

  startManaRegen(){
    if (this._regen) return;
    this._regen = setInterval(()=>{
      if (!state.magic) return;
      state.magic.mana = clamp((state.magic.mana||0) + MANA.regenPerTick, 0, state.magic.max||MANA.max);
    }, MANA.regenMs);
  }

  manaEnough(cost){ return (state.magic?.mana||0) >= cost; }
  spend(cost){ state.magic.mana = clamp((state.magic.mana||0) - cost, 0, state.magic.max||MANA.max); }

  list(){
    return Object.entries(this._spells).map(([id,s])=>({ id, name:s.title, mana:COST[id]||0, cd:(COOLDOWNS[id]||0)/1000+'s', cheats:s.cheats||false }));
  }

  async cast(bot, id, payload=null){
    const s = this._spells[id]; if (!s) throw new Error('Неизвестное заклинание: '+id);
    if (!this.cool.ready(id)) throw new Error('Заклинание ещё перезаряжается ⚡');
    if (!this.manaEnough(COST[id]||0)) throw new Error(`Недостаточно маны (${state.magic.mana}/${COST[id]})`);

    // Выполнить
    await s.run(bot, payload);

    // Успех → списать ману и повесить КД
    this.spend(COST[id]||0);
    this.cool.set(id, COOLDOWNS[id]||0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Реестр ванильных «заклинаний»
  // ───────────────────────────────────────────────────────────────────────────
  _loadSpells(){
    return {
      // 💡 Свет: ставит до 4 факелов вокруг безопасно; если нет факелов — сообщает
      light: {
        title: 'Свет',
        cheats: false,
        run: async (bot) => {
          const pos = bot.entity.position.floored();
          const around = [ new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1) ]
            .map(d=> pos.plus(d));

          // есть ли факелы?
          const torch = await equipAny(bot, ['torch']);
          if (!torch){ safeChat(bot,'💡 Нужны факелы в инвентаре.'); return; }

          let placed = 0;
          for (const p of around){
            if (placed>=4) break;
            if (!isAir(bot,p)) continue;
            const base = p.offset(0,-1,0); if (!solid(bot, base)) continue;
            try { await placeBlockSmart(bot, 'torch', p); placed++; await sleep(60); } catch {}
          }
          if (placed>0) safeChat(bot, '💡 Свет во тьме зажжён! ('+placed+')');
          else safeChat(bot, 'ℹ️ Здесь негде поставить факел.');
        }
      },

      // ❤️ Исцеление: без модов — ест еду/золотое яблоко; в читах — /effect
      heal: {
        title: 'Исцеление',
        cheats: true,
        run: async (bot) => {
          if (isCheats()){
            // если сервер разрешит
            safeChat(bot, '✨ Пробую исцелиться чит‑эффектом.');
            try { bot.chat('/effect give @s instant_health 1 2 true'); } catch {}
            await sleep(300);
            return;
          }
          // Ваниль: поесть (лучше золотое яблоко, иначе любая еда)
          const prefer = ['golden_apple','cooked_beef','cooked_porkchop','cooked_mutton','cooked_chicken','bread','baked_potato'];
          const food = await equipAny(bot, prefer);
          if (!food){ safeChat(bot, '🍎 Нет еды для лечения.'); return; }
          try { bot.activateItem(); await sleep(900); bot.deactivateItem(); } catch {}
          safeChat(bot, '🍖 Перекусил — восстановлюсь со временем.');
        }
      },

      // 🎯 Волшебная «стрела»: бросает снежок/яйцо в цель (или в направлении взгляда)
      missile: {
        title: 'Магический снаряд',
        cheats: true,
        run: async (bot, target) => {
          // приоритет: снежок → яйцо
          const proj = await equipAny(bot, ['snowball','egg']);
          if (!proj){ safeChat(bot,'❄️ Нужен снежок или яйцо.'); return; }

          // куда целиться
          let aim;
          if (target?.position){
            aim = target.position.offset(0, target.height? target.height*0.7 : 1.2, 0);
          } else {
            // небольшой рывок взгляда вперёд
            aim = bot.entity.position.offset(Math.random()*0.2-0.1, 1.5+Math.random()*0.1, 3.5);
          }
          // микросмещение «чтобы не идеально»
          aim = new Vec3(aim.x + (Math.random()-0.5)*0.12, aim.y + (Math.random()-0.5)*0.08, aim.z + (Math.random()-0.5)*0.12);

          await lookAtSoft(bot, aim);
          await sleep(jitter());
          try { bot.activateItem(); } catch {}
          safeChat(bot, '✨ Пшш!');

          // В режиме читов — можно добавить огненную анимацию командой (если разрешено)
          if (isCheats()){
            try { bot.chat('/title @s actionbar {"text":"🔥 BOOM","color":"gold"}'); } catch {}
          }
        }
      },

      // 🌀 Рывок (dash): короткий перенос вперёд безопасно; в читах — /tp на 4–6 блоков
      dash: {
        title: 'Рывок',
        cheats: true,
        run: async (bot, howFar = 4) => {
          const dist = clamp(Number(howFar)||4, 2, 6);
          const yaw = bot.entity.yaw || 0;
          const dir = new Vec3(Math.sin(yaw), 0, Math.cos(yaw));
          const base = bot.entity.position.floored();

          // подбираем безопасную цель в конусе
          let best = null;
          for (let r=dist; r>=2; r--){
            const p = new Vec3(Math.round(base.x + dir.x*r), base.y, Math.round(base.z + dir.z*r));
            if (isSafeStanding(bot, p)) { best = p; break; }
          }
          if (!best){ safeChat(bot,'⚠️ Некуда «рывком» — небезопасно.'); return; }

          if (isCheats()){
            try { bot.chat(`/tp ${Math.floor(best.x)} ${Math.floor(best.y)} ${Math.floor(best.z)}`); return; } catch {}
          }

          try {
            const { GoalNear } = goals;
            bot.pathfinder.setGoal(new GoalNear(best.x, best.y, best.z, 1));
            await sleep(350);
            safeChat(bot, '💨 Рывок!');
          } catch { safeChat(bot,'😕 Не удалось сдвинуться.'); }
        }
      },

      // 🧱 Барьер: ставит 3–4 блока вокруг бота из доступных материалов, потом (опционально) убирает
      barrier: {
        title: 'Барьер', cheats: false,
        run: async (bot, ttlMs = 12000) => {
          const whitelist = ['cobblestone','stone','dirt','oak_planks','spruce_planks','birch_planks','sandstone','netherrack'];
          const have = items(bot).find(i=> whitelist.includes(i.name));
          if (!have){ safeChat(bot,'🧱 Нужны блоки (камень/доски/земля).'); return; }
          try { await bot.equip(have, 'hand'); } catch {}

          const base = bot.entity.position.floored();
          const ring = [ new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1) ].map(d=> base.plus(d));
          const placed = [];
          for (const p of ring){
            if (!isAir(bot,p) || !solid(bot,p.offset(0,-1,0))) continue;
            try { await placeBlockSmart(bot, have.name, p); placed.push(p); await sleep(40); } catch {}
          }
          if (!placed.length){ safeChat(bot,'ℹ️ Некуда поставить барьер.'); return; }
          safeChat(bot, `🛡️ Барьер поставлен (${placed.length}).`);

          // опционально через ttl — убрать (попробовать выкопать)
          if (ttlMs>0){
            setTimeout(async ()=>{
              for (const p of placed){
                const b = bot.blockAt(p); if (!b || b.name!==have.name) continue;
                try { await bot.dig(b); await sleep(20); } catch {}
              }
              safeChat(bot,'🧹 Барьер убран.');
            }, Math.max(4000, ttlMs|0));
          }
        }
      },

      // ✨ Flare (ракета/маячок): запускает фейерверк вверх или ставит факел‑маяк
      flare: {
        title: 'Маяк', cheats: false,
        run: async (bot) => {
          const fw = await equipAny(bot, ['firework_rocket']);
          if (fw){ try { bot.activateItem(); safeChat(bot,'🎆 Салют!'); } catch {} return; }

          // fallback: один факел под ногами
          const p = bot.entity.position.floored();
          const here = p.clone();
          if (isAir(bot, here) && solid(bot, here.offset(0,-1,0))){
            const torch = await equipAny(bot, ['torch']);
            if (torch){ try { await placeBlockSmart(bot, 'torch', here); safeChat(bot,'📍 Маяк‑факел установлен.'); } catch {} return; }
          }
          safeChat(bot,'ℹ️ Нет фейерверков/факелов для маяка.');
        }
      },

      // Дополнительно: «погода ясная» — только в читах, иначе RP‑сообщение
      weather_clear: {
        title: 'Смена погоды', cheats: true,
        run: async (bot) => {
          if (isCheats()) try { bot.chat('/weather clear'); } catch {}
          else safeChat(bot,'🌦️ Я бы разогнал тучи, но без модов не могу.');
        }
      },
    };
  }
}

const magicSystem = new MagicSystem();
module.exports = { MagicSystem, magicSystem };
