// ===============================
// core/bot.cjs — v16 Clean Orchestrator
// • Все игровые команды и рутины: ТОЛЬКО через внешние модули (fun.js, masterAI, авто-еда/броня и т.п.)
// • В ядре нет встроенных mine/chop/auto-eat/auto-armor/guard — только подключение
// • Глобальные флаги/состояния вынесены в единый контейнер Global
// • Один инстанс safeChat (throttle), без повторного создания
// • Меньше require() внутри горячих событий; кеш minecraft-data по версии
// • Реконнект с backoff; «cold restart» через ENV: COLD_RESTART=true
// • Viewer автоподбор порта; follow-цикл аккуратно на Movements
// ===============================

'use strict';
require('dotenv/config');

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlockPlugin = require('mineflayer-collectblock').plugin;

// ──────────────── КОНТЕЙНЕР ГЛОБАЛЬНЫХ ФЛАГОВ ────────────────
const Global = {
  flags: {
    viewerUp: false,
    viewerWarned: false,
    sigintHooked: false,
  },
  coldRestart: String(process.env.COLD_RESTART || 'false').toLowerCase() === 'true',
  cache: {
    mcData: new Map(), // key: version -> minecraft-data instance
  }
};

// ──────────────── ИМПОРТЫ ОДИН РАЗ ────────────────
const net = require('net');
const { state, clearAllIntervals } = require('./state.cjs');
const { randInt, sleep, jitter, backoff, ts, warnShort } = require('../features/utils.cjs');
const { createLogger } = require('./logger.cjs');
const log = createLogger('core.bot');

const { GoalFollow } = goals || {};

// ──────────────── ENV ────────────────
const DEFAULT_NAME = process.env.BOT_NAME || 'HelperBot';
const RECONNECT_DELAY = +process.env.RECONNECT_DELAY || 5000;
const MAX_RECONNECT_ATTEMPTS = +process.env.MAX_RECONNECT_ATTEMPTS || 5;
const AUTO_NAME = String(process.env.AUTO_NAME ?? 'true').toLowerCase() === 'true';

const ENV_AWARE = String(process.env.ENV_AWARE ?? 'true') !== 'false';
const ENV_CHAT  = String(process.env.ENV_CHAT  ?? 'false') !== 'false';
const ENV_HAZARD_RADIUS    = +process.env.ENV_HAZARD_RADIUS || 6;
const ENV_TORCH_PLACE      = String(process.env.ENV_TORCH_PLACE ?? 'true') !== 'false';
const ENV_TORCH_COOLDOWN   = +process.env.ENV_TORCH_COOLDOWN || 10000;
const ENV_NIGHT_START_TICK = +process.env.ENV_NIGHT_START_TICK || 12000;

const VIEWER_PORT = +process.env.VIEWER_PORT || 0;
const VIEWER_MAX_TRIES = +process.env.VIEWER_MAX_TRIES || 6;

const COMBAT_ADVANCED = String(process.env.COMBAT_ADVANCED || 'false').toLowerCase() === 'true';

const CHAT_PREFIX = (process.env.CHAT_PREFIX || '!').trim();

// ──────────────── HELPERS ────────────────
function createSafeChat(bot) {
  const GAP_MS = 900;
  let lastAt = 0;
  return (msg) => {
    const now = Date.now();
    if (now - lastAt < GAP_MS) return;
    try { bot.chat(String(msg)); lastAt = now; } catch {}
  };
}

function loadPluginSafe(bot, plugin, name) {
  try {
    bot.__loadedPlugins ||= new Set();
    if (bot.__loadedPlugins.has(name)) return;
    bot.loadPlugin(plugin);
    bot.__loadedPlugins.add(name);
  } catch (e) {
    console.warn(`[${ts()}] ⚠️ Плагин ${name} не загрузился: ${e.message}`);
  }
}

// minecraft-data кеш по версии (без require в каждом тике)
function getMcData(bot) {
  const v = bot.version || process.env.VERSION || '1.20.1';
  if (Global.cache.mcData.has(v)) return Global.cache.mcData.get(v);
  try {
    const mc = require('minecraft-data')(v);
    Global.cache.mcData.set(v, mc);
    return mc;
  } catch (e) {
    warnShort('minecraft-data', e);
    return null;
  }
}

function ensureSelfEntity(bot) {
  if (!bot) return;
  const MAX_ATTEMPTS = 40, TICK_MS = 200;
  let attempts = 0, timer = null;

  const pickCandidate = () => {
    if (bot.entity?.position) return bot.entity;
    const selfPlayer = bot.players?.[bot.username]?.entity;
    if (selfPlayer?.position) return selfPlayer;
    const eid = bot._client?.entityId;
    if (eid != null) {
      const byId = bot.entities?.[eid];
      if (byId?.position) return byId;
    }
    return null;
  };

  const link = (label) => {
    const c = pickCandidate();
    if (!c) return false;
    if (!bot.entity || bot.entity.id !== c.id) {
      bot.entity = c;
      console.log(`[${ts()}] [self-link] entity id=${c.id} via ${label}.`);
    }
    return true;
  };

  const tick = () => {
    attempts += 1;
    if (link('interval')) { clearInterval(timer); timer = null; return; }
    if (attempts >= MAX_ATTEMPTS) {
      clearInterval(timer); timer = null;
      warnShort('selfEntity', new Error('self entity not linked after spawn'));
    }
  };

  // event-driven + fallback
  bot.on('entitySpawn', (ent) => {
    try {
      if (ent?.type === 'player' && ent.username === bot.username) {
        attempts = 0;
        if (link('entitySpawn') && timer) { clearInterval(timer); timer = null; }
      }
    } catch (e) { warnShort('entitySpawn', e); }
  });
  bot.on('spawn',   () => { try { attempts = 0; if (!link('spawn')   && !timer) timer = setInterval(tick, TICK_MS); } catch (e) { warnShort('spawn', e); } });
  bot.on('respawn', () => { try { attempts = 0; if (!link('respawn') && !timer) timer = setInterval(tick, TICK_MS); } catch (e) { warnShort('respawn', e); } });
  bot.once('end', () => { if (timer) clearInterval(timer); });

  if (!link('initial')) timer = setInterval(tick, TICK_MS);
}

async function isPortFree(port) {
  return await new Promise(res => {
    const srv = net.createServer()
      .once('error', () => res(false))
      .once('listening', () => srv.close(() => res(true)))
      .listen(port, '0.0.0.0');
  });
}

async function startViewerSmart(bot) {
  if (Global.flags.viewerUp) return;
  if (!VIEWER_PORT) { console.log(`[${ts()}] ℹ️ Viewer выключен (VIEWER_PORT=0).`); return; }
  let port = VIEWER_PORT;
  for (let i = 0; i < VIEWER_MAX_TRIES; i++) {
    if (!(await isPortFree(port))) { console.log(`[${ts()}] 🌍 Порт ${port} занят → пробую ${port + 1}...`); port++; continue; }
    try {
      const { mineflayer: viewer } = require('prismarine-viewer');
      viewer(bot, { port, viewDistance: 4 });
      Global.flags.viewerUp = true;
      console.log(`[${ts()}] 🌍 Viewer запущен на порту ${port}`);
      process.env.VIEWER_PORT = String(port);
      return;
    } catch (e) {
      if (e?.code === 'EADDRINUSE') { port++; continue; }
      warnShort('viewer', e); return;
    }
  }
  console.warn(`[${ts()}] ❌ Viewer не удалось запустить (все порты заняты).`);
}

function setMovements(bot, { canDig = true } = {}) {
  try {
    const mc = getMcData(bot);
    if (!mc) return;
    const mv = new Movements(bot, mc);
    mv.canDig = !!canDig;
    mv.allowSprinting = true;
    bot.pathfinder.setMovements(mv);
  } catch (e) { warnShort('setMovements', e); }
}

// универсальный загрузчик «если есть — подключим»
async function loadOptional(bot, paths = [], inits = ['init']) {
  for (const p of paths) {
    try {
      const mod = require(p);
      const fn = inits.find(n => typeof mod?.[n] === 'function') || (typeof mod === 'function' ? 'call' : null);
      if (!fn) continue;
      if (fn === 'call') { await mod(bot); }
      else              { await mod[fn](bot); }
      console.log(`[AI] optional loaded: ${p}`);
      return true;
    } catch {}
  }
  return false;
}

// ===============================
// 🚀 Создание или реконнект бота
// ===============================
let reconnectAttempts = 0;

function wireTelemetry(bot) {
  const tlog = createLogger('telemetry');

  // Patch attack to log target
  try {
    if (!bot.__telemetry) bot.__telemetry = {};
    if (!bot.__telemetry.attack && typeof bot.attack === 'function') {
      bot.__telemetry.attack = bot.attack.bind(bot);
      bot.attack = function(entity, ...args) {
        try {
          const me = this.entity?.position;
          const d = (me && entity?.position) ? me.distanceTo(entity.position) : null;
          tlog.info('attack', { id: entity?.id, name: entity?.name, type: entity?.type, dist: d && +d.toFixed(2) });
        } catch {}
        return bot.__telemetry.attack(entity, ...args);
      }
    }
  } catch {}

  // Patch dig to log start/ok/err and listen completion/abort
  try {
    if (!bot.__telemetry) bot.__telemetry = {};
    if (!bot.__telemetry.dig && typeof bot.dig === 'function') {
      bot.__telemetry.dig = bot.dig.bind(bot);
      bot.dig = async function(block, ...args){
        try { tlog.info('dig:start', { name: block?.name, x: block?.position?.x, y: block?.position?.y, z: block?.position?.z }); } catch {}
        try {
          const r = await bot.__telemetry.dig(block, ...args);
          try { tlog.info('dig:ok', { name: block?.name }); } catch {}
          return r;
        } catch (e) {
          try { tlog.warn('dig:err', { name: block?.name, err: e?.message || String(e) }); } catch {}
          throw e;
        }
      }
    }
    bot.on('diggingCompleted', (b) => { try { tlog.info('dig:completed', { name: b?.name, x: b?.position?.x, y: b?.position?.y, z: b?.position?.z }); } catch {} });
    bot.on('diggingAborted',   (b) => { try { tlog.warn('dig:aborted',   { name: b?.name, x: b?.position?.x, y: b?.position?.y, z: b?.position?.z }); } catch {} });
  } catch {}

  // Equip logging
  try {
    if (!bot.__telemetry) bot.__telemetry = {};
    if (!bot.__telemetry.equip && typeof bot.equip === 'function') {
      bot.__telemetry.equip = bot.equip.bind(bot);
      bot.equip = async function(item, dest='hand', ...rest){
        try { tlog.info('equip', { item: item?.name, dest }); } catch {}
        return bot.__telemetry.equip(item, dest, ...rest);
      }
    }
  } catch {}

  // Pathfinder logging
  try {
    const pf = bot.pathfinder;
    if (pf) {
      if (!pf.__telemetry && typeof pf.goto === 'function') {
        pf.__telemetry = { goto: pf.goto.bind(pf) };
        pf.goto = function(goal){
          try {
            const g = goal || {};
            const payload = { goal: g?.constructor?.name };
            if ('x' in g && 'y' in g && 'z' in g) Object.assign(payload, { x: g.x, y: g.y, z: g.z });
            tlog.info('goto', payload);
          } catch {}
          const p = pf.__telemetry.goto(goal);
          try {
            p.then(() => tlog.info('goto:done'))
             .catch(e => tlog.warn('goto:err', { err: e?.message || String(e) }));
          } catch {}
          return p;
        }
      }
      try { pf.on('path_update', (r) => tlog.debug('path:update', { status: r?.status, nodes: r?.path?.length })); } catch {}
      try { pf.on('goal_reached', () => tlog.info('path:reached')); } catch {}
      try { pf.on('path_reset', (reason) => tlog.warn('path:reset', { reason })); } catch {}
    }
  } catch {}

  // Collecting items
  try { bot.on('playerCollect', (collector, item) => { try { if (collector?.id === bot.entity?.id) tlog.info('collect:item', { x: item?.position?.x, y: item?.position?.y, z: item?.position?.z }); } catch {} }); } catch {}

  // Damage proximity context + last attacker heuristic
  try {
    bot.on('entityHurt', (entity) => {
      try {
        if (!entity) return;
        const me = bot.entity;
        // heuristic: if we are hurt, guess closest hostile/player within 6m as attacker
        if (me && entity.id === me.id) {
          let attacker = null, best = Infinity;
          for (const e of Object.values(bot.entities || {})) {
            if (!e || e.id === me.id) continue;
            if (e.type !== 'player' && e.type !== 'mob') continue;
            if (!e.position || !me.position) continue;
            const d = me.position.distanceTo(e.position);
            if (d < best && d <= 6.0) { attacker = e; best = d; }
          }
          if (!bot.__telemetry) bot.__telemetry = {};
          bot.__telemetry.lastAttacker = attacker ? { id: attacker.id, name: attacker.name, type: attacker.type, dist: +best.toFixed(2) } : null;
        }
        // debug any hurt near us
        if (entity?.position && me?.position) {
          const d2 = me.position.distanceTo(entity.position);
          if (d2 <= 8) tlog.debug('entity:hurt', { id: entity.id, name: entity.name, type: entity.type, dist: +d2.toFixed(2) });
        }
      } catch {}
    });
  } catch {}
}

function createOrReconnect(customName = DEFAULT_NAME) {
  console.log(`[${ts()}] 🤖 Запуск HelperBot (${customName})...`);

  let bot;
  try {
    bot = mineflayer.createBot({
      host: process.env.SERVER_HOST || 'localhost',
      port: +(process.env.SERVER_PORT || 25565),
      username: customName,
      version: process.env.VERSION || '1.20.1',
      auth: process.env.AUTH || 'offline'
    });
  } catch (err) {
    console.error(`[${ts()}] ❌ Ошибка создания бота:`, err);
    return;
  }

  // плагины
  loadPluginSafe(bot, pathfinder, 'pathfinder');
  loadPluginSafe(bot, collectBlockPlugin, 'collectblock');

  // опыт/телеметрия (мягко)
  try {
    const experience = require('../features/ai/experience.cjs');
    if (typeof experience.init === 'function') {
      experience.init(bot, { debug: false });
      bot.experience = experience;
    }
  } catch (e) { warnShort('experience.init', e); }

  // состояние + утилиты
  state.setBot(bot);
  bot.safeChat = createSafeChat(bot); // один инстанс
  ensureSelfEntity(bot);
  try { wireTelemetry(bot); } catch {}

  // Follow-цикл (включается/выключается извне — здесь только поведение)
  bot.on('physicsTick', () => {
    try {
      if (!state.isFollowing || !state.followTarget) return;
      const target = Object.values(bot.entities).find(e => e.type === 'player' && e.username === state.followTarget);
      if (!target) return;
      setMovements(bot, { canDig: false });
      bot.pathfinder.setGoal(new GoalFollow(target, 2), true);
    } catch (e) { warnShort('physicsTick.follow', e); }
  });

  // Lightweight guard tick if advanced combat manager is not attached
  bot.on('physicsTick', () => {
    try {
      if (bot.combat) return; // advanced manager handles its own loop
      if (!bot.__basicCombatLoaded) {
        try { bot.__basicCombatModule = require('../features/combat/combat.js'); } catch {}
        bot.__basicCombatLoaded = true;
      }
      const mod = bot.__basicCombatModule;
      if (mod && typeof mod.guardTick === 'function') mod.guardTick(bot);
    } catch (e) { warnShort('physicsTick.guard', e); }
  });

  // локальный мозг/жизненный цикл (только сервис)
  const brain = {
    active: true,
    loops: [],
    lastDeathAt: 0,
    deathCount: 0,
    skipNextReconnect: false
  };
  bot.__brain = brain;

  // ===== SPAWN =====
  bot.once('spawn', async () => {
    console.log(`[${ts()}] ✅ Бот "${customName}" заспавнен!`);
    reconnectAttempts = 0;
    state.isDead = false;

    try { await bot.waitForChunksToLoad?.(); } catch {}
    await sleep(250);

    // Лёгкий мозг (внешний)
    await loadOptional(bot, [
      '../features/ai/brain_light.cjs',
      '../features/ai/brainLight.cjs'
    ]);

    // Combat (optional advanced AI, fallback to basic guard)
    (async () => {
      let attached = false;
      if (COMBAT_ADVANCED) {
        try {
          const adv = require('../features/combat/advancedCombat.js');
          if (typeof adv.initCombat === 'function') { adv.initCombat(bot); attached = true; }
          else if (typeof adv.init === 'function')   { adv.init(bot);      attached = true; }
          if (attached) console.log('[AI] Combat module loaded (advanced)');
        } catch (e) {
          warnShort('combat.advanced', e);
        }
      }
      if (!attached) {
        try {
          const basic = require('../features/combat/combat.js');
          if (typeof basic.initCombat === 'function') basic.initCombat(bot);
          else if (typeof basic.init === 'function')   basic.init(bot);
          attached = true;
          console.log('[AI] Combat module loaded (basic)');
        } catch (e) { warnShort('combat.basic', e); }
      }
      if (!attached) console.warn('[AI] Combat module failed to load');
    })().catch(e => warnShort('combat.load', e));

    // Команды — только из features/exploration/fun.js
    try {
      const fun = require('../features/exploration/fun.js');
      const setup = fun?.setupFunCommands || fun?.setup || fun;
      if (typeof setup === 'function') setup(bot);
      console.log('[CMD] fun.js commands loaded');
    } catch (e) { warnShort('fun.setup', e); }

    // Master AI (оркестратор, охрана и т.п.) — внешний
    try {
      const masterAI = require('../features/ai/masterAI.cjs');
      if (typeof masterAI?.init === 'function') {
        await masterAI.init(bot, { debug: false, guardIntervalMs: 1400 });
        console.log('[AI] masterAI loaded');
      } else if (typeof masterAI === 'function') {
        await masterAI(bot);
        console.log('[AI] masterAI factory loaded');
      } else {
        console.log('[AI] masterAI present but no init() — skipped');
      }
    } catch (e) { warnShort('masterAI', e); }

    // Навыки (кастомные плагины)
    try {
      const { loadSkills } = require('./plugins.cjs');
      bot.__skills ||= new Set();
      loadSkills(bot);
      console.log('[AI] Custom skill plugins loaded');
    } catch (e) {
      console.log('[AI] Plugins load failed', e.message);
    }

    // Окружение (адаптивка/ночь/факелы) — внешнее
    if (ENV_AWARE) {
      try {
        const { startEnvironmentAwareness } = require('../features/environment/adaptive.cjs');
        if (typeof startEnvironmentAwareness === 'function') {
          startEnvironmentAwareness(bot, {
            chat:  { enabled: ENV_CHAT, minGapMs: 9500, biomeMsgCooldownMs: 90000, dayPhaseCooldownMs: 65000 },
            sense: { hazardRadius: ENV_HAZARD_RADIUS },
            night: { placeTorch: ENV_TORCH_PLACE, torchCooldownMs: ENV_TORCH_COOLDOWN, startTick: ENV_NIGHT_START_TICK }
          });
        }
      } catch (e) { warnShort('adaptive', e); }
    }

    // Авто-ед/броня — только если присутствуют внешние модули
    await loadOptional(bot, [
      '../features/automation/autoEat.cjs',
      '../features/utility/autoEat.cjs',
      '../features/ai/autoEat.cjs'
    ]);
    await loadOptional(bot, [
      '../features/automation/autoArmor.cjs',
      '../features/utility/autoArmor.cjs',
      '../features/ai/autoArmor.cjs'
    ]);

    // Miner agent (2x2 layered core)
    try {
      if (!bot.miner) {
        bot.miner = require('../features/ai/agents/miner.cjs')(bot);
        console.log('[AI] miner agent attached');
      }
    } catch (e) {
      warnShort('miner.attach', e);
    }

    // viewer (если нужен)
    if (VIEWER_PORT) startViewerSmart(bot).catch(()=>{});

    // привет
    setTimeout(() => bot.safeChat?.(`Привет! Я ${bot.username}. Команды — help`), randInt(450, 900));
  });

  // ──────────────── БАЗОВЫЙ РОУТЕР (служебки ядра) ────────────────
  bot.on('message', async (msg) => {
    try {
      const line = String(msg?.toString?.() || '').trim();
      if (!line || !line.startsWith(CHAT_PREFIX)) return;

      const raw = line.slice(CHAT_PREFIX.length).trim();
      const [cmd, ...rest] = raw.split(/\s+/);
      const C = (cmd || '').toLowerCase();

      // Служебные мини-команды ядра
      if (C === 'say') {
        const text = rest.join(' ').trim();
        if (text) bot.safeChat?.(text);
        return;
      }
      if (C === 'inv') {
        try {
          const items = bot.inventory?.items() || [];
          if (!items.length) return bot.safeChat?.('🎒 Пусто.');
          const list = items.map(i => `${i.count}×${i.name}`).slice(0, 10).join(', ');
          bot.safeChat?.(`🎒 ${list}${items.length > 10 ? '…' : ''}`);
        } catch {}
        return;
      }
      if (C === 'stats') {
        const hp = (bot.health ?? 0).toFixed(0);
        const food = (bot.food ?? 0).toFixed(0);
        const p = bot.entity?.position;
        bot.safeChat?.(`❤️ ${hp}/20  🍗 ${food}/20  📍 ${p ? (p.x|0)+' '+(p.y|0)+' '+(p.z|0) : '???'}`);
        return;
      }
      if (C === 'viewer') {
        const sw = (rest[0] || '').toLowerCase();
        if (sw === 'on' || sw === 'вкл') { startViewerSmart(bot).catch(()=>{}); bot.safeChat?.('🖥️ Viewer: вкл'); }
        else { bot.safeChat?.('🖥️ Viewer: выкл (отключится при рестарте или VIEWER_PORT=0)'); }
        return;
      }

      // ВАЖНО: никаких chop/mine/guard/auto-ед/броня в ядре — этим рулит fun.js
    } catch (e) { warnShort('message.router', e); }
  });

  // ──────────────── Смерть / респавн ────────────────
  bot.on('death', () => {
    try {
      state.isDead = true;
      const now = Date.now();
      const recently = now - bot.__brain.lastDeathAt < 20000;
      bot.__brain.lastDeathAt = now;
      bot.__brain.deathCount++;
      try { bot.clearControlStates?.(); bot.pathfinder?.setGoal(null); } catch {}
      try {
        const saver = require('../core/saver.cjs');
        saver?.saveAll?.();
      } catch (e) { warnShort('saver.saveAll(death)', e); }
      if (bot.__brain.deathCount >= 5 && recently) {
        const nap = randInt(8000, 12000);
        setTimeout(() => { try { bot.respawn(); } catch {} bot.__brain.deathCount = 0; }, nap);
        return;
      }
      setTimeout(() => { try { bot.respawn(); } catch {} }, randInt(1100, 2200));
    } catch (e) { warnShort('death', e); }
  });

  // extra file logging for network/lifecycle
  try {
    bot.on('kicked', (reason) => { try { const txt = typeof reason === 'string' ? reason : JSON.stringify(reason||{}); log.warn('kicked', { reason: txt }); } catch {} });
    bot.on('end', (reason) => { try { const txt = typeof reason === 'string' ? reason : JSON.stringify(reason||{}); log.info('end', { reason: txt }); } catch {} });
    bot.on('error', (err) => { try { log.error('error', { code: err?.code, message: err?.message || String(err) }); } catch {} });
  } catch {}

  // file logging for lifecycle (with context)
  try {
    bot.on('death', () => {
      try {
        const pos = bot.entity?.position || bot.players?.[bot.username]?.entity?.position;
        const dim = (bot.game?.dimension || bot.game?.dimension?.toString?.() || 'unknown');
        // prefer last attacker heuristic if present, else nearest entity snapshot
        let killer = bot.__telemetry?.lastAttacker || null;
        if (!killer) {
          let nearest = null, best = Infinity;
          try {
            for (const e of Object.values(bot.entities || {})) {
              if (!e || e.id === bot.entity?.id) continue;
              if (!e.position) continue;
              const dx = e.position.x - (pos?.x || 0);
              const dy = e.position.y - (pos?.y || 0);
              const dz = e.position.z - (pos?.z || 0);
              const d = Math.hypot(dx, dy, dz);
              if (d < best) { best = d; nearest = e; }
            }
          } catch {}
          killer = nearest ? { id: nearest.id, name: nearest.name, type: nearest.type, dist: +best.toFixed(2) } : null;
        }
        // equipment snapshot (best-effort)
        let equip = undefined;
        try {
          const inv = (bot.inventory?.items?.() || []);
          const snap = {};
          if (bot.heldItem?.name) snap.main = bot.heldItem.name;
          const setIf = (re, key) => { const it = inv.find(i => re.test(i.name)); if (it) snap[key] = it.name; };
          setIf(/_helmet$/, 'helmet');
          setIf(/_chestplate$/, 'chest');
          setIf(/_leggings$/, 'legs');
          setIf(/_boots$/, 'boots');
          const off = inv.find(i => i?.name === 'shield'); if (off) snap.off = 'shield';
          if (Object.keys(snap).length) equip = snap;
        } catch {}
        log.warn('death', { pos: pos && { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) }, dim, near: killer || undefined, equip });
      } catch {}
    });
    bot.on('respawn', () => {
      try {
        const pos = bot.entity?.position || bot.players?.[bot.username]?.entity?.position;
        const dim = (bot.game?.dimension || bot.game?.dimension?.toString?.() || 'unknown');
        log.info('respawn', { pos: pos && { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) }, dim });
      } catch {}
    });
    bot.on('spawn', () => {
      try {
        const pos = bot.entity?.position || bot.players?.[bot.username]?.entity?.position;
        const dim = (bot.game?.dimension || bot.game?.dimension?.toString?.() || 'unknown');
        log.info('spawn', { pos: pos && { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) }, dim });
      } catch {}
    });
  } catch {}

  bot.on('respawn', () => {
    try {
      state.isDead = false;
      setTimeout(() => { if (Math.random() < 0.8) bot.safeChat?.('💪 Я снова в строю!'); }, randInt(450, 900));
      setTimeout(() => {
        try { const saver = require('../core/saver.cjs'); saver?.saveAll?.(); } catch (e) { warnShort('saver.saveAll(respawn)', e); }
      }, 1000);
    } catch (e) { warnShort('respawn', e); }
  });

  // ──────────────── Кик / авто-имя ────────────────
  bot.on('kicked', (reason) => {
    try {
      const txt = typeof reason === 'string' ? reason : JSON.stringify(reason || {});
      console.warn(`[${ts()}] 🚪 Кикнут: ${txt}`);
      state.isDead = false;
      if (/incompatible/i.test(txt)) console.warn(`[${ts()}] ℹ️ Версия не совпала. Проверь .env → VERSION=...`);
      if (AUTO_NAME && /duplicate_login/i.test(txt)) {
        const m = customName.match(/_(\d+)$/);
        const nextName = m ? `${customName.slice(0, -m[0].length)}_${+m[1] + 1}` : `${customName}_1`;
        console.warn(`[${ts()}] ⚠️ Имя занято. Пробую "${nextName}"...`);
        bot.__brain.skipNextReconnect = true;
        setTimeout(() => createOrReconnect(nextName), 1500);
      }
    } catch (e) { warnShort('kicked', e); }
  });

  // ──────────────── Отключение / реконнект ────────────────
  bot.on('end', (reason) => {
    try {
      const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason || {});
      console.log(`[${ts()}] 🔌 Отключился: ${reasonStr}`);

      bot.__brain.active = false;
      for (const stop of bot.__brain.loops) { try { stop(); } catch {} }
      bot.__brain.loops.length = 0;
      clearAllIntervals();
      state.isDead = false;

      // «Холодный» рестарт только по флагу — иначе не трогаем кеш mineflayer
      if (Global.coldRestart) {
        try { delete require.cache[require.resolve('mineflayer')]; } catch {}
      }

      if (bot.__brain.skipNextReconnect) { bot.__brain.skipNextReconnect = false; return; }

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = jitter(backoff(reconnectAttempts, RECONNECT_DELAY, 30000));
        reconnectAttempts++;
        console.log(`[${ts()}] ♻️ Реконнект (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) через ~${delay}мс`);
        setTimeout(() => createOrReconnect(customName), delay);
      } else {
        console.error(`[${ts()}] ❌ Лимит переподключений.`);
      }
    } catch (e) { warnShort('end', e); }
  });

  bot.on('error', (err) => {
    try {
      if (!err) return;
      const code = String(err.code || '').toLowerCase();
      const msg  = String(err.message || err).toLowerCase();
      const isNet = /econnreset|econnrefused|etimedout|ehostunreach|enet|eai_again|socket|network/.test(code + msg);
      if (isNet) console.warn(`[${ts()}] ⚠️ Сеть:`, err.code || err.message);
      else warnShort('bot.error', err);
    } catch (e) { warnShort('error.handler', e); }
  });

  // SIGINT → сейв (один глобальный хук)
  if (!Global.flags.sigintHooked) {
    Global.flags.sigintHooked = true;
    process.on('SIGINT', async () => {
      console.log(`\n[${ts()}] 🧷 SIGINT → сохраняю всё...`);
      try { const saver = require('../core/saver.cjs'); await saver?.saveAll?.(); } catch {}
      process.exit(0);
    });
  }

  // Память → совет по viewer
  const memInt = setInterval(() => {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    if (used > 700 && !Global.flags.viewerWarned) {
      console.warn(`[${ts()}] ⚠️ Память ${used.toFixed(0)}MB — не включай Viewer или выключи его.`);
      Global.flags.viewerWarned = true;
    }
  }, 60000);
  memInt.unref?.();
  bot.__brain.loops.push(() => clearInterval(memInt));

  return bot;
}

module.exports = { createOrReconnect };



