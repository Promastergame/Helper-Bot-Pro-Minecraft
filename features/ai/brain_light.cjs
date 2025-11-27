'use strict';
// ===============================
// features/ai/brain_light.cjs — v10.0 (ULTRA-BRO-MODE)
// 🧠 УМНЫЙ ДИАЛОГ + РЕАКЦИИ НА МОБОВ + ИНТЕГРАЦИЯ БОЯ
// • Реакции на атаки всех мобов (включая новых)
// • Умные ответы в бою и мирное время
// • Никаких сетевых запросов
// • Токен-бакет, кулдауны, микропамять
// • Реалистичная задержка перед ответом
// • Режим "бот-бро": дружелюбные, не рабские реплики
// • Узнаёт владельца через .env OWNER_NAME (и алиасы)
// • Интеграция с combat system
// ===============================

// ───────────────────────────────────────────────────────────────────────────────
// Конфиг по умолчанию (переопределяется .env)
// ───────────────────────────────────────────────────────────────────────────────
const DEFAULTS = {
  enabled: process.env.BRAIN_ENABLED !== 'false',

  // Токен-бакет: частота и объём ответов (анти-спам)
  chatChance: parseFloat(process.env.BRAIN_CHAT_CHANCE ?? '0.15'),
  minGapMs: parseInt(process.env.BRAIN_MIN_GAP_MS ?? '12000', 10),
  idleCheckMs: parseInt(process.env.BRAIN_IDLE_CHECK_MS ?? '8000', 10),
  memoryMs: parseInt(process.env.BRAIN_MEMORY_MS ?? '90000', 10),
  tokens: parseInt(process.env.BRAIN_TOKENS ?? '4', 10),
  refillMs: parseInt(process.env.BRAIN_REFILL_MS ?? '12000', 10),

  // Радиусы/кулдауны
  greetRadius: parseFloat(process.env.BRAIN_GREET_RADIUS ?? '6.0'),
  greetCooldownMs: parseInt(process.env.BRAIN_GREET_COOLDOWN_MS ?? '45000', 10),
  painCooldownMs: parseInt(process.env.BRAIN_PAIN_COOLDOWN_MS ?? '15000', 10),
  combatChatCooldownMs: parseInt(process.env.BRAIN_COMBAT_COOLDOWN_MS ?? '10000', 10),

  // Префикс/обращения
  rawPrefix: typeof process.env.CHAT_PREFIX === 'string' ? process.env.CHAT_PREFIX : '!',
  requireMention: String(process.env.CHAT_REQUIRE_MENTION ?? 'true') !== 'false',
  mentionWords: String(process.env.CHAT_MENTION_WORDS || 'бот,bot,helperbot,hb,helper,помощник')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),

  // Владелец
  ownerName: String(process.env.OWNER_NAME || '').trim(),
  ownerAliases: String(process.env.OWNER_ALIASES || '').split(',')
    .map(s => s.trim()).filter(Boolean),

  // Реалистичная задержка (без "..." и typing)
  delayMinMs: parseInt(process.env.BRAIN_DELAY_MIN_MS ?? '380', 10),
  delayMaxMs: parseInt(process.env.BRAIN_DELAY_MAX_MS ?? '950', 10),

  // "Активный бро" смолток
  smallTalk: String(process.env.BRAIN_SMALLTALK || 'true') === 'true',
  smallTalkEveryMsMin: parseInt(process.env.BRAIN_ST_MIN_MS ?? '25000', 10),
  smallTalkEveryMsMax: parseInt(process.env.BRAIN_ST_MAX_MS ?? '45000', 10),

  // 🆕 Реакции в бою
  combatReactions: String(process.env.BRAIN_COMBAT_REACTIONS || 'true') === 'true',
  mobReactionChance: parseFloat(process.env.BRAIN_MOB_REACTION_CHANCE ?? '0.35'),
};

function rand(a, b) { return a + Math.random() * (b - a); }
function sample(arr) { return arr[(Math.random() * arr.length) | 0]; }
function now() { return Date.now(); }
function norm(s='') {
  return String(s).replace(/[ \t\r\n]+/g,' ').trim();
}
function low(s='') { return norm(s).toLowerCase(); }

// ───────────────────────────────────────────────────────────────────────────────
// Токен-бакет (анти-спам) + микро-память
// ───────────────────────────────────────────────────────────────────────────────
function makeBucket(limit, refillMs) {
  let tokens = Math.max(0, limit|0);
  let lastRefill = now();
  return {
    take(n=1) {
      const t = now();
      const add = Math.floor((t - lastRefill) / refillMs);
      if (add > 0) {
        tokens = Math.min(limit, tokens + add);
        lastRefill = t;
      }
      if (tokens >= n) { tokens -= n; return true; }
      return false;
    }
  };
}

function makeMemory(ttlMs) {
  const buf = [];
  return {
    push(x) {
      buf.push({ t: now(), x });
      const t0 = now();
      while (buf.length && (t0 - buf[0].t) > ttlMs) buf.shift();
    },
    recent(n=8) {
      const t0 = now();
      return buf.filter(e => (t0 - e.t) <= ttlMs).slice(-n).map(e => e.x);
    }
  };
}

// ───────────────────────────────────────────────────────────────────────────────
/** Реалистичная отправка сообщения: тихая задержка, без "typing..." */
function humanSend(bot, msg, cfg) {
  if (!msg) return;
  const min = Math.max(120, cfg.delayMinMs|0);
  const max = Math.max(min+50, cfg.delayMaxMs|0);
  const delay = Math.floor(rand(min, max));
  setTimeout(() => { try { bot.chat(String(msg)); } catch {} }, delay);
}

// ───────────────────────────────────────────────────────────────────────────────
// Владелец
// ───────────────────────────────────────────────────────────────────────────────
function isOwnerName(cfg, username='') {
  if (!username) return false;
  const base = (cfg.ownerName || '').toLowerCase();
  const aliases = (cfg.ownerAliases || []).map(s => s.toLowerCase());
  const u = username.toLowerCase();
  return (base && u === base) || aliases.includes(u);
}

// ───────────────────────────────────────────────────────────────────────────────
// 🆕 РЕАКЦИИ НА МОБОВ И БОЕВЫЕ СИТУАЦИИ
// ───────────────────────────────────────────────────────────────────────────────
const COMBAT_REACTIONS = {
  // Реакции на начало боя
  battle_start: (mobName) => sample([
    `Вступаю в бой с ${mobName}!`,
    `Замечен ${mobName}! К оружию!`,
    `Атакован ${mobName}! Защищаюсь!`,
    `Обнаружен ${mobName}! Уничтожаю!`,
    `Эх, ${mobName}... Ну погоди!`
  ]),

  // Реакции на победу
  battle_win: (mobName) => sample([
    `✅ Готово, ${mobName} повержен!`,
    `🎯 Одолел ${mobName}!`,
    `💪 С ${mobName} покончено!`,
    `☠️ ${mobName} больше не опасен.`,
    `Вот так, ${mobName} был силён, но я сильнее!`
  ]),

  // Реакции на получение урона
  took_damage: (mobName) => {
    const general = sample([
      'Ай, больно!',
      'Ой, задел!',
      'Эй, полегче!',
      'Получил удар!',
      'Больно, чёрт!'
    ]);
    
    // Специфические реакции для мобов
    const specific = {
      creeper: sample(['Крипер близко! Отступаю!', 'Щас бахнет! Бежим!', 'Зелёный пуфер!']),
      skeleton: sample(['Стрелы! Уворачиваюсь!', 'Костяной лучник! В укрытие!', 'Скелет стреляет!']),
      desert_skeleton: sample([
        'Пустынный скелет! Песчаные стрелы!',
        'Костяшка из пустыни! Блокирую!',
        'Песчаный лучник! Опасно!'
      ]),
      camel_zombie: sample([
        'Зомби-верблюд! Фу, воняет!',
        'Верблюжий зомби! Держись подальше!',
        '🐫☠️ Отстань, вонючий зомби!'
      ]),
      enderman: sample(['Эндермен! Не смотреть в глаза!', 'Варп-варп! Телепортер!', 'Эндермен атакует!']),
      spider: sample(['Паук! Мерзость!', 'Паучиха прыгает!', 'Паук лезет!']),
      zombie: sample(['Зомби! Бей мозги!', 'Мозгоеды идут!', 'Зомби тупой, но сильный!']),
    };

    return specific[mobName] || `${general} ${mobName} атакует!`;
  },

  // Реакции на лечение
  healing: () => sample([
    '🍗 Перекушу и вернусь в бой!',
    '🥩 Нужно подлечиться...',
    '❤️ Восстанавливаю здоровье!',
    '🍎 Перекус для восстановления!',
    '💊 Лечусь, секундочку!'
  ]),

  // Реакции на низкое ХП
  low_health: () => sample([
    '🆘 Мало здоровья! Отступаю!',
    '💔 Почти мёртв! Нужно бежать!',
    '🚑 Критически ранен! Ретрит!',
    '🏃 Бегу, не могу больше драться!',
    '🛡️ Слишком повреждён, отходжу!'
  ]),
};

// ───────────────────────────────────────────────────────────────────────────────
// Интенты (бро-стиль, без сервильности)
// ───────────────────────────────────────────────────────────────────────────────
const BRO = {
  greet: (user, owner) => owner
    ? sample([`👋 Йо, ${user}! Как дела?`, `✌️ Привет, босс ${user}!`, `🫡 На связи, ${user}!`])
    : sample([`👋 Привет, ${user}!`, '✌️ Хей, друг!', '🙂 О, здорово!', '😄 Приветик!']),
  
  help: () => sample([
    '📘 Команды: !help • !come • !follow on|off • !stop • !protect on|off • !craft <что> xN • !mine <id> N • !chop N • !build house [S H] • !inv • !stats',
    '🛠️ Помощь: !help • !come подзовёт • !follow следует за тобой • !protect защищает от мобов • !inv показывает инвентарь',
    '❓ Нужна помощь? Команды: !help, !come, !follow, !stop, !protect, !craft, !mine, !build, !inv'
  ]),
  
  thanks: () => sample([
    '😉 Всегда пожалуйста!', 
    '👍 Не за что!', 
    '🫡 Рад помочь!',
    '💪 Обращайся!',
    '😄 В любой время!'
  ]),
  
  insult: (owner) => owner
    ? sample(['🙂 Спокойно, босс.', '🫶 Понял, без обид.', '👌 Принято, владелец.'])
    : sample(['😶 Окей...', '🤐 Давай без оскорблений.', '🧊 Остынь, друг.', '😐 Не надо так.']),
  
  where: (bot) => {
    const p = bot.entity?.position;
    if (!p) return '🧭 Кажется, я потерялся...';
    return `🧭 Мои координаты: X${p.x.toFixed(0)} Y${p.y.toFixed(0)} Z${p.z.toFixed(0)}. Напиши !come чтобы я подошёл.`;
  },
  
  time: (bot) => {
    const t = bot.time?.timeOfDay ?? 0;
    const isNight = (t >= 13000 || t < 1000);
    return isNight ? sample(['🌙 Сейчас ночь, опасно!', '🌚 Тёмное время суток.', '⭐ Ночь, монстры рядом!']) 
                   : sample(['☀️ Сейчас день, безопасно.', '🌞 Яркий день!', '🌅 Светлое время суток.']);
  },
  
  weather: (bot) => bot.isRaining 
    ? sample(['🌧️ Идёт дождь...', '💧 На улице ливень!', '☔ Дождик, беги домой!'])
    : sample(['🌤️ Погода ясная!', '☀️ Солнечно и сухо!', '🌈 Отличная погода!']),
  
  inventory: (bot) => {
    try {
      const items = bot.inventory?.items() || [];
      if (!items.length) return '🎒 Инвентарь пуст.';
      const sum = items.reduce((m, it) => (m[it.name] = (m[it.name]||0) + it.count, m), {});
      const head = Object.entries(sum).slice(0, 12).map(([n,c])=>`${n}:${c}`).join(', ');
      return `🎒 Инвентарь: ${head}${Object.keys(sum).length>12?'...':''}`;
    } catch { return '⚠️ Не могу посмотреть инвентарь.'; }
  },
  
  default: () => sample([
    '🤔 Понял. Нужна помощь - пиши !help',
    '🛠️ Могу помочь с крафтом: !craft стол',
    '📍 Поставь точку: !wp set дом',
    '⛏️ Добыть ресурсы: !mine iron_ore 5',
    '🌲 Нарубить дерева: !chop 10',
    '🏠 Построить дом: !build house'
  ]),

  // 🆕 Улучшенные реакции на боль
  pain: (ownerVisible, mobName) => {
    if (mobName) {
      return COMBAT_REACTIONS.took_damage(mobName);
    }
    
    return ownerVisible
      ? sample(['Эй, полегче, босс!', 'Ай, принял. Без агрессии.', 'Оу, больно, владелец.'])
      : sample(['Эй, поаккуратнее!', 'Ай, больно же! 😅', 'Ой, задел!', 'Получил удар!']);
  },
};

// ───────────────────────────────────────────────────────────────────────────────
// Извлечение адресации (префикс/ник/"имя: команда")
// ───────────────────────────────────────────────────────────────────────────────
function makeExtractor(bot, cfg) {
  const my = (bot.username || 'helperbot').toLowerCase();
  const prefix = norm(cfg.rawPrefix).toLowerCase();
  const hasPrefix = prefix.length > 0;

  return function extract(rawMsg) {
    const original = String(rawMsg || '').trim();
    if (!original) return { ok:false };

    const lo = original.toLowerCase();

    // 1) Явный префикс → отдаём командному парсеру
    if (hasPrefix && lo.startsWith(prefix)) {
      return { ok:false, passthrough:true };
    }

    // 2) Обращение по имени/словам — считаем чатом для нас
    const byName = lo.startsWith(my) || cfg.mentionWords.some(w => lo.startsWith(w + ' '));
    if (byName) {
      let s = original.slice(original.split(/\s+/)[0].length).trim();
      if (s.startsWith(':') || s.startsWith(',') || s.startsWith('-')) s = s.slice(1).trim();
      return { ok:true, text: norm(s), via:'mention' };
    }

    // 3) "Имя: фраза"
    const idx = lo.indexOf(':');
    if (idx > 0 && idx < 20) {
      const head = lo.slice(0, idx).trim();
      if (head === my || cfg.mentionWords.includes(head)) {
        return { ok:true, text: norm(original.slice(idx + 1)), via:'colon' };
      }
    }

    // 4) Если упоминание не требуется и нет префикса — позволяем свободный чат
    if (!cfg.requireMention && !hasPrefix) {
      return { ok:true, text: norm(original), via:'free' };
    }

    return { ok:false };
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Главная инициализация
// ───────────────────────────────────────────────────────────────────────────────
function init(bot, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts);

  if (!cfg.enabled) {
    console.log('[brain_light] отключен в .env');
    return;
  }

  const extract = makeExtractor(bot, cfg);
  const bucket  = makeBucket(cfg.tokens, cfg.refillMs);
  const memory  = makeMemory(cfg.memoryMs);

  let lastReplyAt = 0;
  let lastGreetAt = 0;
  let lastPainAt  = 0;
  let lastCombatAt = 0;

  function canTalk() {
    if (!bucket.take(1)) return false;
    if (now() - lastReplyAt < cfg.minGapMs) return false;
    return true;
  }

  function say(msg) {
    humanSend(bot, msg, cfg);
    lastReplyAt = now();
  }

  // 🆕 Функция для боевых реакций
  function combatSay(msg) {
    if (!cfg.combatReactions) return;
    if (now() - lastCombatAt < cfg.combatChatCooldownMs) return;
    if (!bucket.take(1)) return;
    
    humanSend(bot, msg, cfg);
    lastCombatAt = now();
    lastReplyAt = now();
  }

  // — приветствие, если игрок рядом (редко)
  function tryProximityGreet() {
    if (now() - lastGreetAt < cfg.greetCooldownMs) return;
    const me = bot.entity?.position; if (!me) return;
    const near = Object.values(bot.entities)
      .filter(e => e.type === 'player' && e.username && e.username !== bot.username)
      .find(p => me.distanceTo(p.position) <= cfg.greetRadius);
    if (near) {
      if (canTalk()) {
        const ownerFlag = isOwnerName(cfg, near.username);
        say(BRO.greet(near.username, ownerFlag));
        lastGreetAt = now();
      }
    }
  }

  // — лёгкий смолток по таймеру (если включено)
  if (cfg.smallTalk) {
    const loop = () => {
      const delay = rand(cfg.smallTalkEveryMsMin, cfg.smallTalkEveryMsMax);
      setTimeout(() => {
        try {
          if (canTalk()) {
            const phrases = [
              'угу', 'мм', 'ага', 'ясно', 'окей', 'интересно', 
              'правда?', 'круто', 'понимаю', 'заметил', 'вижу',
              'неплохо', 'забавно', 'любопытно', 'хм...'
            ];
            say(sample(phrases));
          }
        } catch {}
        loop();
      }, delay);
    };
    loop();
  }

  // 🆕 УЛУЧШЕННЫЕ РЕАКЦИИ НА УРОН С ИНТЕГРАЦИЕЙ С COMBAT SYSTEM
  bot.on('entityHurt', (ent) => {
    if (!ent || ent.id !== bot?.entity?.id) return;
    if (now() - lastPainAt < cfg.painCooldownMs) return;
    if (!canTalk()) return;

    // Пытаемся определить, кто атаковал
    let attacker = null;
    let attackerName = null;
    
    // Ищем ближайшего враждебного моба
    const me = bot.entity?.position;
    if (me) {
      const HOSTILE_MOBS = [
        'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch',
        'desert_skeleton', 'camel_zombie', 'phantom', 'ravager', 'pillager'
      ];
      
      const nearbyHostiles = Object.values(bot.entities)
        .filter(e => e.type === 'mob' && HOSTILE_MOBS.includes(e.name) && 
                 me.distanceTo(e.position) <= 8);
      
      if (nearbyHostiles.length > 0) {
        attacker = nearbyHostiles[0];
        attackerName = attacker.name;
      }
    }

    // Если рядом виден владелец — с большей вероятностью "бро"-реплика
    let ownerVisible = false;
    if (me) {
      ownerVisible = Object.values(bot.entities)
        .some(e => e.type === 'player' && isOwnerName(cfg, e.username) && 
               me.distanceTo(e.position) <= cfg.greetRadius * 1.5);
    }

    // Шанс ответить зависит от настройки
    if (Math.random() < cfg.mobReactionChance) {
      say(BRO.pain(ownerVisible, attackerName));
      lastPainAt = now();
    }
  });

  // 🆕 РЕАКЦИИ НА НАЧАЛО И ОКОНЧАНИЕ БОЯ
  bot.on('combatStarted', (data) => {
    if (!data?.mobName) return;
    combatSay(COMBAT_REACTIONS.battle_start(data.mobName));
  });

  bot.on('combatEnded', (data) => {
    if (!data?.mobName || !data.win) return;
    combatSay(COMBAT_REACTIONS.battle_win(data.mobName));
  });

  bot.on('healingStarted', () => {
    combatSay(COMBAT_REACTIONS.healing());
  });

  bot.on('lowHealth', () => {
    combatSay(COMBAT_REACTIONS.low_health());
  });

  // ── чат
  bot.on('message', (json) => {
    const raw = json?.toString?.() || '';
    if (!raw) return;

    // Игнорируем явные игровые команды (!...) — это территория fun.js
    const rawLo = raw.toLowerCase();
    if (rawLo.startsWith('!') || rawLo.startsWith('бот ') || rawLo.startsWith((bot.username||'').toLowerCase())) {
      // всё равно попробуем извлечь как обращение-реплику, но если это команда — выходим
      const ex0 = extract(raw);
      if (ex0.passthrough) return;
    }

    memory.push({ type:'chat', text: raw });

    const ex = extract(raw);
    if (!ex.ok) {
      // Без адресации — изредка "подслушать"
      if (Math.random() < cfg.chatChance && canTalk()) {
        const s = low(raw);
        const ownerFlag = !!cfg.ownerName && raw.toLowerCase().includes(cfg.ownerName.toLowerCase());
        let msg = null;
        if (/^(пр(и|е)в|зд(а|о)ров|hi|hello|hey|хай|хей|здаров|здоров)\b/.test(s)) 
          msg = BRO.greet('друг', ownerFlag);
        else if (/\b(спасибо|спс|ty|thx|thanks|благодарю|пасиб)\b/.test(s)) 
          msg = BRO.thanks();
        else if (/\b(дурак|туп(ой|ая)|лох|идиот|соси|еблан|придурок)\b/.test(s)) 
          msg = BRO.insult(ownerFlag);
        if (msg) say(msg);
      }
      return;
    }

    const s = low(ex.text);
    if (!s) { if (canTalk()) say('🤖 Я тут. Напиши "помощь" или !help.'); return; }

    // Примерно определим пользователя
    const user = (Object.keys(bot.players||{}).find(p => raw.includes(p)) || 'друг');
    const ownerFlag = isOwnerName(cfg, user);

    // Намерения
    let msg = null;
    if (/\b(помощь|команды|help|\?|хелп)\b/.test(s)) 
      msg = BRO.help();
    else if (/^(пр(и|е)в|зд(а|о)ров|hi|hello|hey|хай|хей)\b/.test(s)) 
      msg = BRO.greet(user, ownerFlag);
    else if (/\b(спасибо|спс|ty|thx|thanks|благодарю|пасиб)\b/.test(s)) 
      msg = BRO.thanks();
    else if (/\b(дурак|туп(ой|ая)|лох|идиот|соси|еблан|придурок)\b/.test(s)) 
      msg = BRO.insult(ownerFlag);
    else if (/\b(где ты|ты где|ко мне|сюда|подойди|location|pos)\b/.test(s)) 
      msg = BRO.where(bot);
    else if (/\b(который час|время|ночь|день|time|day|night)\b/.test(s)) 
      msg = BRO.time(bot);
    else if (/\b(погода|дождь|дождик|снег|rain|weather)\b/.test(s)) 
      msg = BRO.weather(bot);
    else if (/\b(инвентарь|инв|что в сумке|что несёшь|inventory|inv)\b/.test(s)) 
      msg = BRO.inventory(bot);
    else 
      msg = BRO.default();

    if (msg && canTalk()) say(msg);
  });

  // ── приватки
  bot.on('whisper', (username, message) => {
    memory.push({ type:'dm', user: username, text: message });
    const s = low(message);
    const ownerFlag = isOwnerName(cfg, username);
    let msg = null;
    if (/\b(помощь|команды|help|\?)\b/.test(s)) msg = BRO.help();
    else if (/^(пр(и|е)в|зд(а|о)ров|hi|hello|hey)\b/.test(s)) msg = BRO.greet(username, ownerFlag);
    else if (/\b(спасибо|спс|ty|thx|thanks)\b/.test(s)) msg = BRO.thanks();
    else if (/\b(дурак|туп(ой|ая)|лох|идиот|соси|еблан)\b/.test(s)) msg = BRO.insult(ownerFlag);
    else if (/\b(где ты|ты где|ко мне|сюда|подойди)\b/.test(s)) msg = BRO.where(bot);
    else if (/\b(который час|время|ночь|день)\b/.test(s)) msg = BRO.time(bot);
    else if (/\b(погода|дождь|дождик|снег)\b/.test(s)) msg = BRO.weather(bot);
    else if (/\b(инвентарь|инв|что в сумке|что несёшь)\b/.test(s)) msg = BRO.inventory(bot);
    else msg = BRO.default();

    if (msg && canTalk()) {
      const min = Math.max(120, cfg.delayMinMs|0);
      const max = Math.max(min+50, cfg.delayMaxMs|0);
      setTimeout(() => { try { bot.whisper(username, String(msg)); } catch {} }, Math.floor(rand(min, max)));
      lastReplyAt = now();
    }
  });

  // — idle-проверка
  const t = setInterval(() => {
    tryProximityGreet();
  }, Math.max(2000, cfg.idleCheckMs));
  t.unref?.();

  console.log('[brain_light] инициализирован (v10.0 ULTRA-BRO-MODE)');
}

module.exports = { init, COMBAT_REACTIONS };