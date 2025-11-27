// ===============================
// features/exploration/humanMove.cjs
// 🧠 Human-like поведение и передвижение для Mineflayer
// v7: микроповороты головы, осмотры, анти-застревание, «человечная» походка,
//     избегание краёв, вода/лестницы, мини‑паркур через маленькие препятствия,
//     интеграция с brain (необязательно), follow/goTo c шумом и репланом
// Без внешних модов. CommonJS.
// ===============================

const { Vec3 } = require('vec3');

// ───────────────────────────────────────────────────────────────────────────────
// Утилиты
// ───────────────────────────────────────────────────────────────────────────────
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(t) { return t * t * (3 - 2 * t); } // плавная интерполяция
function rnd(min, max) { return Math.random() * (max - min) + min; }
function dist(a, b) { return a.distanceTo ? a.distanceTo(b) : Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function yawPitchToLookAt(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const yaw = Math.atan2(-dx, -dz);
  const distXZ = Math.hypot(dx, dz);
  const pitch = Math.atan2(dy, distXZ);
  return { yaw, pitch };
}

// Небольшая «склейка» объектов настроек (глубокая для plain-объектов)
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// Настройки по умолчанию
// ───────────────────────────────────────────────────────────────────────────────
const defaultOpts = {
  head: {
    jitterIntervalMs: 250,        // «дыхание» — лёгкие микросдвиги камеры
    jitterYaw: 0.025,
    jitterPitch: 0.015,
    scanEveryMsMin: 3500,         // случайные осмотры по сторонам
    scanEveryMsMax: 6500,
    scanYawAmplitude: 0.6,
    scanPitchAmplitude: 0.2,
    scanDurationMs: 900,
    glancePlayers: true,          // изредка смотреть на ближайшего игрока
    glanceEveryMsMin: 4500,
    glanceEveryMsMax: 9000,
    glanceYawSnap: 0.15,
  },
  move: {
    tickMs: 120,                  // главный «человечный» тиканье движений
    strafeChance: 0.06,
    jumpChance: 0.06,
    sprintOnSlopeChance: 0.08,
    sprintRandomToggleChance: 0.02,
    strafeDurationMs: 450,
    noiseRadius: 0.45,            // шум цели (GoalNear)
    arriveRadius: 1.1,
    headBob: true,                // лёгкое «покачивание головы» при движении
    headBobAmpYaw: 0.01,
    headBobAmpPitch: 0.01,
    headBobHz: 2.0,
  },
  antiStuck: {
    checkEveryMs: 900,
    minProgress: 0.18,            // минимум м/интервал, иначе «застрял»
    wiggleMs: 800,                // «раскачка» из застревания
    replanMs: 2200,               // если не помогло — перепрокладка
    maxRetries: 3,                // после N попыток — вращение и полный reset
    rotateNudgeYaw: 0.35,
    hardResetCooldownMs: 6000,
  },
  edges: {
    avoid: true,
    lookDownOnEdge: true,
    crouchOnEdge: false,          // можно пригибаться у края
    edgeAheadDistance: 1.25,
    edgeSideProbe: 0.6            // боковой зонд, чтобы не срывать спринт зря
  },
  water: {
    swim: true,                   // в воде — всплывать
    swimUpPitch: -0.25,           // чуть смотреть вверх при всплытии (pitch < 0)
    sprint: false
  },
  ladders: {
    enabled: true,                // изредка подпрыгивать на лестнице для компенсации
    hopEveryMs: 900,
  },
  parkour: {
    enabled: true,                // мини-паркур: перепрыгивать невысокие препятствия
    maxStepHeight: 1,             // «ступенька» в 1 блок
    preJumpMs: 120,               // заранее прожать jump на N мс
  },
  follow: {
    updateEveryMs: 1100,          // частота обновления GoalFollow
    personalSpace: 1.7,           // дистанция комфорта у цели
    keepOnSight: true,            // иногда смотреть на цель
    lookEveryMsMin: 1400,
    lookEveryMsMax: 2600
  },
  chat: {
    smallTalk: false,             // при желании — фразы в чат с интервалами
    everyMsMin: 20000,
    everyMsMax: 36000,
    phrases: ['мм...', 'угу', 'интересно...', 'ага', 'кек', 'хмм...']
  },
  integration: {
    withBrain: true,              // мягкая интеграция: setMode() при старте/остановке
    modeWhileMoving: 'follow',    // в режиме перемещения
    modeIdle: 'idle'
  },
  debug: {
    log: false
  }
};

// ───────────────────────────────────────────────────────────────────────────────
// Состояние
// ───────────────────────────────────────────────────────────────────────────────
function makeState(bot, opts) {
  return {
    bot,
    opts,
    intervals: [],
    timeouts: [],
    listeners: [],
    currentGoal: null,
    lastPos: null,
    lastPosTime: 0,
    stuckRetries: 0,
    lastHardResetAt: 0,
    busy: false,
    stopping: false,
    headBobPhase: 0,
    // временные флаги
    lastEdgeCheckAt: 0,
  };
}

function clearTimers(st) {
  for (const i of st.intervals) clearInterval(i);
  for (const t of st.timeouts) clearTimeout(t);
  st.intervals.length = 0;
  st.timeouts.length = 0;
}

function clearListeners(st) {
  for (const [emitter, event, fn] of st.listeners) {
    try { emitter.removeListener(event, fn); } catch {}
  }
  st.listeners.length = 0;
}

function scheduleInterval(st, fn, ms) {
  const id = setInterval(() => !st.stopping && fn(), ms);
  st.intervals.push(id);
  return id;
}
function scheduleTimeout(st, fn, ms) {
  const id = setTimeout(() => !st.stopping && fn(), ms);
  st.timeouts.push(id);
  return id;
}
function on(st, emitter, event, fn) {
  emitter.on(event, fn);
  st.listeners.push([emitter, event, fn]);
}

// ───────────────────────────────────────────────────────────────────────────────
// Плавный поворот головы
// ───────────────────────────────────────────────────────────────────────────────
async function smoothLook(bot, targetYaw, targetPitch, durationMs = 250, ease = smoothstep) {
  const start = Date.now();
  const sy = bot.entity.yaw;
  const sp = bot.entity.pitch;
  const tick = 30;
  while (Date.now() - start < durationMs) {
    const t = clamp((Date.now() - start) / durationMs, 0, 1);
    const tt = ease(t);
    const ny = lerp(sy, targetYaw, tt);
    const np = lerp(sp, targetPitch, tt);
    bot.look(ny, clamp(np, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01), true);
    await new Promise(r => setTimeout(r, tick));
  }
  bot.look(targetYaw, clamp(targetPitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01), true);
}

// Плавно посмотреть на точку (Vec3)
async function humanLookAt(bot, vec, durationMs = 280) {
  const head = bot.entity.position.offset(0, bot.entity.height * 0.9, 0);
  const { yaw, pitch } = yawPitchToLookAt(head, vec);
  await smoothLook(bot, yaw, pitch, durationMs);
}

// ───────────────────────────────────────────────────────────────────────────────
// «Дыхание» — лёгкие микродвижения камеры
// ───────────────────────────────────────────────────────────────────────────────
function startHeadJitter(st) {
  const { jitterIntervalMs, jitterYaw, jitterPitch } = st.opts.head;
  scheduleInterval(st, () => {
    const dyaw = rnd(-jitterYaw, jitterYaw);
    const dpitch = rnd(-jitterPitch, jitterPitch);
    const ny = clamp(st.bot.entity.yaw + dyaw, -Math.PI, Math.PI);
    const np = clamp(st.bot.entity.pitch + dpitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    st.bot.look(ny, np, true);
  }, jitterIntervalMs);
}

// Периодический осмотр окружения
function startRandomScans(st) {
  const scan = async () => {
    const o = st.opts.head;
    const delay = rnd(o.scanEveryMsMin, o.scanEveryMsMax);
    scheduleTimeout(st, async () => {
      try {
        const baseY = st.bot.entity.yaw;
        const baseP = st.bot.entity.pitch;
        await smoothLook(st.bot, baseY + rnd(0.2, o.scanYawAmplitude), baseP + rnd(-o.scanPitchAmplitude, o.scanPitchAmplitude), o.scanDurationMs);
        await smoothLook(st.bot, baseY - rnd(0.2, o.scanYawAmplitude), baseP + rnd(-o.scanPitchAmplitude, o.scanPitchAmplitude), o.scanDurationMs);
        await smoothLook(st.bot, baseY, baseP, 300);
      } catch {}
      scan();
    }, delay);
  };
  scan();
}

// Иногда смотреть на ближайшего игрока
function startGlancePlayers(st) {
  if (!st.opts.head.glancePlayers) return;
  const loop = () => {
    const delay = rnd(st.opts.head.glanceEveryMsMin, st.opts.head.glanceEveryMsMax);
    scheduleTimeout(st, async () => {
      try {
        const bot = st.bot;
        const players = Object.values(bot.entities)
          .filter(e => e.type === 'player' && e.username && e.username !== bot.username);
        if (players.length) {
          players.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
          const p = players[0];
          const head = bot.entity.position.offset(0, bot.entity.height * 0.9, 0);
          const { yaw, pitch } = yawPitchToLookAt(head, p.position.offset(0, 1.6, 0));
          await smoothLook(bot, bot.entity.yaw * (1 - st.opts.head.glanceYawSnap) + yaw * st.opts.head.glanceYawSnap, pitch, 320);
        }
      } catch {}
      loop();
    }, delay);
  };
  loop();
}

// ───────────────────────────────────────────────────────────────────────────────
// Проверка «края» перед ботом
// ───────────────────────────────────────────────────────────────────────────────
function blockAt(bot, pos) {
  try { return bot.blockAt(pos); } catch { return null; }
}
function isEdgeAhead(bot, distAhead = 1.2) {
  const dir = new Vec3(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw));
  const ahead = bot.entity.position.offset(dir.x * distAhead, -1, dir.z * distAhead).floored();
  const below = blockAt(bot, ahead);
  return !below || below.name === 'air' || below?.boundingBox === 'empty';
}

// ───────────────────────────────────────────────────────────────────────────────
// Мини‑паркур и «человечные» шаги
// ───────────────────────────────────────────────────────────────────────────────
function detectLowObstacle(bot) {
  // Блок перед ботом на уровне ног
  const dir = new Vec3(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw));
  const front = bot.entity.position.offset(dir.x * 0.8, 0, dir.z * 0.8).floored();
  const atFeet = blockAt(bot, front);
  const above = blockAt(bot, front.offset(0, 1, 0));
  if (atFeet && atFeet.name !== 'air' && (!above || above.name === 'air')) {
    return { pos: front, name: atFeet.name };
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Главный «человечный» тиканье движения
// ───────────────────────────────────────────────────────────────────────────────
function startHumanStepper(st) {
  const m = st.opts.move;
  const e = st.opts.edges;
  const w = st.opts.water;
  const l = st.opts.ladders;
  const p = st.opts.parkour;
  let strafeUntil = 0;

  scheduleInterval(st, () => {
    const b = st.bot;
    const now = Date.now();

    // Вода / плавание
    if (w.swim && b.entity.isInWater) {
      try { b.look(b.entity.yaw, st.opts.water.swimUpPitch, true); } catch {}
      b.setControlState('jump', true); // всплывать
      if (!w.sprint && b.controlState.sprint) b.setControlState('sprint', false);
      return;
    }

    // Лестницы — подпрыгивание время от времени, чтобы компенсировать «застревания»
    if (l.enabled && b.entity.isOnLadder && Math.random() < 0.2) {
      b.setControlState('jump', true);
      setTimeout(() => b.setControlState('jump', false), 80);
    }

    // Изредка страйф
    if (Math.random() < m.strafeChance && now > strafeUntil) {
      const left = Math.random() < 0.5;
      b.setControlState(left ? 'left' : 'right', true);
      strafeUntil = now + m.strafeDurationMs;
      setTimeout(() => b.setControlState(left ? 'left' : 'right', false), m.strafeDurationMs);
    }

    // Мини‑паркур: невысокое препятствие — заранее прыжок
    if (p.enabled && b.controlState.forward) {
      const obs = detectLowObstacle(b);
      if (obs && Math.random() < 0.55) {
        setTimeout(() => {
          b.setControlState('jump', true);
          setTimeout(() => b.setControlState('jump', false), 120 + Math.random() * 80);
        }, p.preJumpMs);
      }
    }

    // Периодически подпрыгивать (неровности)
    if (Math.random() < m.jumpChance) {
      b.setControlState('jump', true);
      setTimeout(() => b.setControlState('jump', false), 120 + Math.random() * 80);
    }

    // Спринт: случайно или «на подъёме»
    const vy = b.entity.velocity.y;
    if (Math.random() < m.sprintRandomToggleChance || (vy > 0.04 && Math.random() < m.sprintOnSlopeChance)) {
      b.setControlState('sprint', !b.controlState.sprint);
    }

    // Края блоков — придержать коней
    if (e.avoid) {
      const edgeMain = isEdgeAhead(b, e.edgeAheadDistance);
      if (edgeMain) {
        if (e.lookDownOnEdge) {
          b.look(b.entity.yaw, clamp(b.entity.pitch + 0.06, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01), true);
        }
        if (e.crouchOnEdge) b.setControlState('sneak', true);
        b.setControlState('forward', false);
        b.setControlState('sprint', false);
        // иногда аккуратный шажок
        if (Math.random() < 0.25) {
          b.setControlState('forward', true);
          setTimeout(() => b.setControlState('forward', false), 130);
        }
        return;
      } else if (e.crouchOnEdge && b.controlState.sneak) {
        b.setControlState('sneak', false);
      }
    }

    // «Покачивание головы» во время движения
    if (m.headBob && b.controlState.forward) {
      st.headBobPhase += (m.headBobHz * 2 * Math.PI) * (m.tickMs / 1000);
      const by = Math.sin(st.headBobPhase) * m.headBobAmpYaw;
      const bp = Math.sin(st.headBobPhase * 0.5) * m.headBobAmpPitch;
      try { b.look(b.entity.yaw + by, b.entity.pitch + bp, true); } catch {}
    }

    // Шагаем по умолчанию вперёд
    b.setControlState('forward', true);
  }, m.tickMs);
}

// ───────────────────────────────────────────────────────────────────────────────
// Анти-застревание
// ───────────────────────────────────────────────────────────────────────────────
function startAntiStuck(st, onReplan) {
  scheduleInterval(st, () => {
    const b = st.bot;
    const now = Date.now();
    const pos = b.entity.position.clone();
    if (!st.lastPos) {
      st.lastPos = pos;
      st.lastPosTime = now;
      return;
    }
    const d = dist(pos, st.lastPos);
    const dt = now - st.lastPosTime;

    if (dt >= st.opts.antiStuck.checkEveryMs) {
      if (d < st.opts.antiStuck.minProgress) {
        // wiggle
        const left = Math.random() < 0.5;
        b.setControlState(left ? 'left' : 'right', true);
        b.setControlState('jump', true);
        setTimeout(() => {
          b.setControlState(left ? 'left' : 'right', false);
          b.setControlState('jump', false);
        }, st.opts.antiStuck.wiggleMs);

        st.stuckRetries++;
        // переплан через паузу
        setTimeout(() => onReplan && onReplan(), st.opts.antiStuck.replanMs);

        // если часто застревает — «вертимся» и жёсткий reset реже
        if (st.stuckRetries >= st.opts.antiStuck.maxRetries) {
          st.stuckRetries = 0;
          try {
            const yaw = b.entity.yaw + (Math.random() < 0.5 ? -1 : 1) * st.opts.antiStuck.rotateNudgeYaw;
            b.look(yaw, b.entity.pitch, true);
          } catch {}
          const since = now - st.lastHardResetAt;
          if (since > st.opts.antiStuck.hardResetCooldownMs) {
            st.lastHardResetAt = now;
            try { b.pathfinder.setGoal(st.currentGoal, true); } catch {}
          }
        }
      } else {
        st.stuckRetries = 0;
      }
      st.lastPos = pos;
      st.lastPosTime = now;
    }
  }, st.opts.antiStuck.checkEveryMs);
}

// ───────────────────────────────────────────────────────────────────────────────
// Смолтолк (по желанию)
// ───────────────────────────────────────────────────────────────────────────────
function startSmallTalk(st) {
  if (!st.opts.chat.smallTalk) return;
  const loop = () => {
    const delay = rnd(st.opts.chat.everyMsMin, st.opts.chat.everyMsMax);
    scheduleTimeout(st, () => {
      const phrase = st.opts.chat.phrases[Math.floor(Math.random() * st.opts.chat.phrases.length)];
      try { st.bot.chat(phrase); } catch {}
      loop();
    }, delay);
  };
  loop();
}

// ───────────────────────────────────────────────────────────────────────────────
// Небольшая случайная дрожь цели (offset)
// ───────────────────────────────────────────────────────────────────────────────
function offsetWithNoise(target, radius) {
  if (!radius || radius <= 0) return target;
  const ang = Math.random() * Math.PI * 2;
  const r = Math.random() * radius;
  return target.offset(Math.cos(ang) * r, 0, Math.sin(ang) * r);
}

// ───────────────────────────────────────────────────────────────────────────────
// PUBLIC API: старт/стоп «очеловечивания»
// ───────────────────────────────────────────────────────────────────────────────
function startHumanizer(bot, options = {}) {
  const opts = deepMerge(defaultOpts, options);
  const st = makeState(bot, opts);
  bot.__humanState = st;

  // Интеграция: сказать brain, что мы «в движении»/«idle»
  try {
    if (opts.integration.withBrain && bot.brain && typeof bot.brain.setMode === 'function') {
      bot.brain.setMode(opts.integration.modeIdle);
    }
  } catch {}

  startHeadJitter(st);
  startRandomScans(st);
  startGlancePlayers(st);
  startHumanStepper(st);
  startSmallTalk(st);

  const onEnd = () => stopHumanizer(st);
  on(st, bot, 'end', onEnd);
  on(st, bot, 'kicked', onEnd);

  return st; // вернуть state для продвинутого контроля
}

function stopHumanizer(stOrBot) {
  const st = stOrBot.bot ? stOrBot : stOrBot.__humanState;
  if (!st) return;
  st.stopping = true;
  clearTimers(st);
  clearListeners(st);
  try { st.bot.clearControlStates(); } catch {}
  try {
    if (st.opts.integration.withBrain && st.bot.brain && typeof st.bot.brain.setMode === 'function') {
      st.bot.brain.setMode(st.opts.integration.modeIdle);
    }
  } catch {}
}

// ───────────────────────────────────────────────────────────────────────────────
// PUBLIC API: «человечный» переход к точке (исп. pathfinder внутри)
// ───────────────────────────────────────────────────────────────────────────────
async function goToHuman(bot, targetPos, options = {}) {
  const st = bot.__humanState || startHumanizer(bot, options);
  bot.__humanState = st;
  const { goals } = require('mineflayer-pathfinder');
  const { GoalNear } = goals;

  // Интеграция с brain: режим движения
  try {
    if (st.opts.integration.withBrain && bot.brain && typeof bot.brain.setMode === 'function') {
      bot.brain.setMode(st.opts.integration.modeWhileMoving);
    }
  } catch {}

  const replan = () => {
    const noisy = offsetWithNoise(targetPos, st.opts.move.noiseRadius);
    const goal = new GoalNear(Math.round(noisy.x), Math.round(noisy.y), Math.round(noisy.z), st.opts.move.arriveRadius);
    st.currentGoal = goal;
    try { bot.pathfinder.setGoal(goal, true); } catch {}
  };

  startAntiStuck(st, replan);
  replan();

  // Ждём достижения
  return await new Promise((resolve) => {
    const check = setInterval(() => {
      const d = dist(bot.entity.position, targetPos);
      if (d <= st.opts.move.arriveRadius + 0.2 || !bot.pathfinder.isMoving()) {
        clearInterval(check);
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        try {
          if (st.opts.integration.withBrain && bot.brain && typeof bot.brain.setMode === 'function') {
            bot.brain.setMode(st.opts.integration.modeIdle);
          }
        } catch {}
        resolve(true);
      }
    }, 300);
    st.intervals.push(check);
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// PUBLIC API: следовать за сущностью человечно
// ───────────────────────────────────────────────────────────────────────────────
function followHuman(bot, entity, options = {}) {
  const st = bot.__humanState || startHumanizer(bot, options);
  bot.__humanState = st;
  const { goals } = require('mineflayer-pathfinder');
  const { GoalFollow } = goals;

  try {
    if (st.opts.integration.withBrain && bot.brain && typeof bot.brain.setMode === 'function') {
      bot.brain.setMode(st.opts.integration.modeWhileMoving);
    }
  } catch {}

  const replan = () => {
    if (!entity || !entity.isValid) return;
    const goal = new GoalFollow(entity, st.opts.move.arriveRadius);
    st.currentGoal = goal;
    try { bot.pathfinder.setGoal(goal, true); } catch {}
  };

  startAntiStuck(st, replan);
  replan();

  // авто-обновление цели
  const updater = setInterval(() => {
    if (!entity || !entity.isValid) return;
    replan();
  }, st.opts.follow.updateEveryMs);
  st.intervals.push(updater);

  // смотреть на цель иногда (если близко)
  if (st.opts.follow.keepOnSight) {
    const lookLoop = () => {
      const delay = rnd(st.opts.follow.lookEveryMsMin, st.opts.follow.lookEveryMsMax);
      scheduleTimeout(st, async () => {
        if (!entity || !entity.isValid) return lookLoop();
        const d = dist(bot.entity.position, entity.position);
        if (d < 6) {
          const head = bot.entity.position.offset(0, bot.entity.height * 0.9, 0);
          const { yaw, pitch } = yawPitchToLookAt(head, entity.position.offset(0, 1.6, 0));
          await smoothLook(bot, yaw, pitch, 240);
        }
        lookLoop();
      }, delay);
    };
    lookLoop();
  }
}

module.exports = {
  startHumanizer,
  stopHumanizer,
  goToHuman,
  followHuman,
  humanLookAt
};
