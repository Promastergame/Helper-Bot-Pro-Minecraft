'use strict';
/**
 * features/crafting/autoCrafter.js — v7.5
 * 🤖 ИИ-автокрафт:
 *  • buildCraftPlan()/missingFor() совместимость (smartCraft.js)
 *  • очереди на бота (без параллельных автокрафтов)
 *  • адресная/пакетная подготовка RAW (дерево/руды/слитки)
 *  • батч-крафт одинаковых шагов, умные ретраи (экспоненциальный backoff)
 *  • отмена: cancelCraft() + AbortSignal
 *  • прогресс-колбэки: onProgress({ phase, step, index, total, pct, note })
 */

const { craftItem, craftSimple } = require('./crafting.js');
const { recipes, buildCraftPlan, missingFor, CATS } = require('./smartCraft.js');
const { chopWood, mineOres }   = require('../mining/mining.js');
const { smeltAll }             = require('../building/smelting.js');
const { addExp }               = require('../leveling.js');
const { retryAsync }           = require('../../core/utils.cjs'); // ⬅️ добавлено

// ───────────────────────── внутреннее состояние ─────────────────────────
const _queues = new WeakMap();          // per-bot promise chain (serialize tasks)
const _busy   = new WeakSet();          // быстрый флаг «идёт автокрафт»
let   _cancel = false;

const sleep  = (ms)=> new Promise(r=> setTimeout(r, ms));
const jitter = ()=> 70 + Math.random()*160;
const now    = ()=> Date.now();
const clamp  = (v,a,b)=> Math.min(b, Math.max(a,v));

// без спама в чат
function safeChat(bot, msg){ try { bot.chat(msg); } catch {} }
function throttle(fn, ms=1600){ let t=0; return (...a)=>{ const n=now(); if (n-t>=ms){ t=n; try{ fn(...a);}catch{} } }; }
const chatInfo = throttle((bot,msg)=> safeChat(bot,msg), 1700);

// инвентарь
function items(bot){ try { return bot.inventory.items(); } catch { return []; } }
function count(bot, id){ return items(bot).filter(i=>i.name===id).reduce((s,i)=>s+i.count,0); }
function has(bot, id, n=1){ return count(bot,id)>=n; }
function hasAny(bot, set){ for (const n of set){ if (has(bot,n,1)) return true; } return false; }
function invSnapshot(bot){ const m=Object.create(null); for (const it of items(bot)) m[it.name]=(m[it.name]||0)+it.count; return m; }

// отмена
function resetCancel(){ _cancel=false; }
function cancelCraft(){
  _cancel=true;
  try { globalThis.state?.getBot?.().chat?.('🛑 Автокрафт остановлен.'); } catch {}
}
function checkAbort(signal){
  if (_cancel || signal?.aborted){
    const e = new Error('⛔ Автокрафт отменён пользователем');
    e.isCanceled = true;
    throw e;
  }
}

// ───────────────────── RAW-подготовка (пакет/адресная) ─────────────────────
async function preEnsureRaw(bot, miss, opts){
  checkAbort(opts?.signal);

  // дерево
  if (miss.some(m=> CATS['#planks']?.has(m.id)) || miss.some(m=> CATS['#logs']?.has(m.id))){
    const targetLogs = clamp(8 + Math.ceil(miss.length/2), 6, 24);
    chatInfo(bot, '🌲 Заготавливаю дерево…');
    try { await chopWood(bot, targetLogs); } catch {}
  }

  // слитки
  if (miss.some(m=> /_ingot$/.test(m.id))){
    chatInfo(bot, '🔥 Переплавляю руды в слитки…');
    try {
      // поддержка разных сигнатур smeltAll
      await (smeltAll.length>=2 ? smeltAll(bot, 'ores', { timeoutMs:24000 }) : smeltAll(bot));
    } catch {
      try { await smeltAll(bot); } catch {}
    }
  }

  // руды/камни
  if (miss.some(m=> /(ore|raw_|deepslate|stone)/.test(m.id))){
    chatInfo(bot, '⛏️ Добываю руду…');
    try { await mineOres(bot, 12); } catch {}
  }
}

async function ensureRaw(bot, id, need=1, opts){
  checkAbort(opts?.signal);

  // planks
  if (CATS['#planks']?.has(id)){
    if (!hasAny(bot, CATS['#planks'])){
      if (!hasAny(bot, CATS['#logs'])){ chatInfo(bot, '🌲 Нужно дерево → рублю…'); try{ await chopWood(bot, Math.max(6, Math.ceil(need/2))); }catch{} }
      try { await craftSimple(bot, 'oak_planks', Math.max(1, Math.ceil(need/4))); } catch {}
    }
    return true;
  }

  // stick
  if (id==='stick'){
    if (!has(bot,'stick',need)){
      if (!hasAny(bot, CATS['#planks'])){
        if (!hasAny(bot, CATS['#logs'])){ try{ await chopWood(bot,6); }catch{} }
        try { await craftSimple(bot,'oak_planks',1); } catch {}
      }
      try { await craftSimple(bot,'stick',Math.max(1,Math.ceil(need/4))); } catch {}
    }
    return true;
  }

  // ingots
  if (/_ingot$/.test(id)){
    chatInfo(bot,'🔥 Переплавка…');
    try { await (smeltAll.length>=2 ? smeltAll(bot,'ores',{timeoutMs:22000}) : smeltAll(bot)); } catch { try{ await smeltAll(bot);}catch{} }
    return true;
  }

  // руды/камни/дерево
  if (/ore|coal|redstone|diamond|iron|gold|copper|lapis|emerald|deepslate|stone/.test(id)){
    chatInfo(bot,`⛏️ Добываю: ${id}`);
    try { await mineOres(bot, 10); } catch {}
    return true;
  }
  if (/log|planks/.test(id)){
    chatInfo(bot,'🌲 Заготавливаю дерево…'); try{ await chopWood(bot,8); }catch{}
    return true;
  }
  return false;
}

// ───────────────────── план: сжатие одинаковых шагов ─────────────────────
function compressConsecutive(plan){
  const out=[];
  for (const step of plan){
    if (step.ruName?.startsWith?.('#RAW:')){
      // RAW тоже имеет смысл сжимать
      const last = out[out.length-1];
      if (last && last.ruName===step.ruName){
        last.amount = (last.amount|0) + (step.amount|0 || 1);
      } else {
        out.push({ ...step, amount: Math.max(1, step.amount|0) });
      }
      continue;
    }
    const last = out[out.length-1];
    if (last && last.ruName===step.ruName){
      last.amount = (last.amount|0) + (step.amount|0 || 1);
    } else {
      out.push({ ...step, amount: Math.max(1, step.amount|0) });
    }
  }
  return out;
}

// ───────────────────────── ретраи крафта (stable) ─────────────────────────
async function craftWithRetries(bot, ruName, amount, { retries=2 } = {}){
  // пробуем «партиями»: сначала одной пачкой через craftSimple(id, n),
  // иначе — fallback на craftItem(ru) поштучно; всё под retryAsync
  let id = null;
  try {
    const { ruToId } = require('./crafting.js');
    id = typeof ruToId === 'function' ? ruToId(ruName) : null;
  } catch { /* ok */ }

  return retryAsync(async () => {
    checkAbort(); // мгновенная отмена между попытками

    if (id){
      await craftSimple(bot, id, amount);
      return;
    }
    for (let i=0;i<amount;i++){
      const ok = await craftItem(bot, ruName, 1);
      if (!ok) throw new Error('craftItem failed');
      await sleep(120);
    }
  }, {
    retries,        // по умолчанию 2 ретрая (всего 3 попытки)
    base: 400,      // стартовая задержка
    cap: 2000,      // максимум между попытками
    label: `craft:${ruName}`
  });
}

// ───────────────────── выполнение плана с прогрессом ─────────────────────
async function executePlan(bot, plan, { onProgress, signal } = {}){
  const list  = compressConsecutive(plan);
  const total = list.length;

  for (let i=0; i<list.length; i++){
    checkAbort(signal);

    const step = list[i] || {};
    const pct  = Math.round((i/Math.max(1,total))*100);
    try { onProgress && onProgress({ phase:'craft', step, index:i, total, pct }); } catch {}

    // RAW
    if (step.ruName?.startsWith?.('#RAW:')){
      const id   = step.ruName.slice(5);
      const need = Math.max(1, step.amount|0);
      if (!has(bot, id, need)) await ensureRaw(bot, id, need, { signal });
      await sleep(jitter());
      continue;
    }

    // обычный крафт (батч → fallback), с ретраями
    const amt = Math.max(1, step.amount|0);
    await craftWithRetries(bot, step.ruName, amt, { retries:2 });
    await sleep(jitter());
  }

  // финальный прогресс = 100%
  try { onProgress && onProgress({ phase:'craft', step:null, index:total, total, pct:100, note:'done' }); } catch {}
}

// ───────────────────────── очередь задач per-bot ─────────────────────────
function runQueued(bot, task){
  const prev = _queues.get(bot) || Promise.resolve();
  // гарантируем линейность даже если task бросает исключение
  const next = prev.finally(()=>{}).then(task, (e)=>{ throw e; });
  _queues.set(bot, next);
  return next;
}

// ───────────────────────── высокоуровневые API ─────────────────────────
/**
 * smartAutoCraft(bot, 'факелы', 8, { onProgress, signal })
 */
async function smartAutoCraft(bot, ruTarget, amount=1, opts={}){
  if (!ruTarget || !recipes[ruTarget]){
    safeChat(bot, `❌ Не знаю рецепт для "${ruTarget}"`);
    return;
  }
  return runQueued(bot, async ()=>{
    if (_busy.has(bot)){ safeChat(bot,'⏳ Автокрафт уже выполняется.'); return; }
    _busy.add(bot); resetCancel();

    const started = now();
    const { onProgress=null, signal=null } = opts;

    try{
      safeChat(bot, `🧠 Планирую крафт: ${ruTarget} ×${amount}`);

      const plan = buildCraftPlan(ruTarget, amount);
      const miss = missingFor(bot, ruTarget, amount);

      if (miss.length){
        chatInfo(bot, '📦 Не хватает: ' + miss.map(m=>`${m.id}×${m.need}`).join(', '));
        try { onProgress && onProgress({ phase:'prepare', step:null, index:0, total:0, pct:0, note:'preEnsureRaw' }); } catch {}
        await preEnsureRaw(bot, miss, { signal });
      }

      const invBefore   = invSnapshot(bot);
      const productId   = recipes[ruTarget]?.id || null;

      try { onProgress && onProgress({ phase:'plan', step:null, index:0, total:plan.length, pct:0 }); } catch {}
      await executePlan(bot, plan, { onProgress, signal });

      const invAfter = invSnapshot(bot);
      let craftedCount = amount;
      if (productId) craftedCount = Math.max(0, (invAfter[productId]||0) - (invBefore[productId]||0));

      addExp(Math.max(8, 5*amount), `автокрафт ${ruTarget}`);
      const dt = Math.round((now()-started)/1000);
      safeChat(bot, `✅ "${ruTarget}" готово! (${craftedCount||amount} шт., ${dt}с)`);
    } catch(e){
      if (e?.isCanceled) safeChat(bot, e.message);
      else safeChat(bot, `⚠️ Автокрафт не завершён: ${e?.message||e}`);
    } finally {
      _busy.delete(bot);
    }
  });
}

/**
 * fullAutoCraft(bot, list?, { onProgress, signal })
 */
async function fullAutoCraft(bot, list=null, opts={}){
  return runQueued(bot, async ()=>{
    if (_busy.has(bot)){ safeChat(bot,'⏳ Уже выполняется другая операция.'); return; }
    _busy.add(bot); resetCancel();

    const names = Array.isArray(list)&&list.length ? list : Object.keys(recipes);
    safeChat(bot, '🔁 Запуск полного автокрафта…');

    try{
      for (const ru of names){
        checkAbort(opts?.signal);
        if (_cancel){ safeChat(bot,'🛑 Прервано пользователем.'); return; }
        if (!recipes[ru]){ chatInfo(bot, `ℹ️ Пропускаю неизвестный рецепт: ${ru}`); continue; }
        await smartAutoCraft(bot, ru, 1, opts);
        await sleep(jitter());
      }
      safeChat(bot, '✅ Полный автокрафт завершён!');
    } catch(e){
      if (e?.isCanceled) safeChat(bot, e.message);
      else safeChat(bot, `⚠️ Цикл автокрафта прерван: ${e?.message||e}`);
    } finally {
      _busy.delete(bot);
    }
  });
}

// ───────────────────────── экспорт ─────────────────────────
module.exports = { smartAutoCraft, fullAutoCraft, cancelCraft };
