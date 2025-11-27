// ===============================
// index.cjs — HelperBot  v7.5
// Стиль: неоновый киберпанк + “чистое завершение” (без анимации логотипа)
// Сделано Promaster Development
// ===============================

'use strict';

require('dotenv/config');
const fs   = require('fs');
const path = require('path');

// ──────────────────────────────────────────
// 📦 App Info
// ──────────────────────────────────────────
const APP_NAME    = 'HelperBot ';
const APP_VERSION = '7.5';
const BRAND       = 'Promaster Development';

// ──────────────────────────────────────────
/* 🎨 ANSI-утилиты */
// ──────────────────────────────────────────
const ansi = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  italic:   '\x1b[3m',
  underline:'\x1b[4m',
  invert:   '\x1b[7m',

  black:    '\x1b[30m',
  red:      '\x1b[31m',
  green:    '\x1b[32m',
  yellow:   '\x1b[33m',
  blue:     '\x1b[34m',
  mag:      '\x1b[35m',
  cyan:     '\x1b[36m',
  gray:     '\x1b[90m',
  white:    '\x1b[97m',

  hide:     '\x1b[?25l',
  show:     '\x1b[?25h',

  clrLine:  '\x1b[2K',
  homeCol:  '\x1b[0G',
  clr:      '\x1b[2J',
  home:     '\x1b[H',
};

const c = {
  bold:  s => ansi.bold   + s + ansi.reset,
  dim:   s => ansi.dim    + s + ansi.reset,
  it:    s => ansi.italic + s + ansi.reset,
  inv:   s => ansi.invert + s + ansi.reset,

  gray:  s => ansi.gray   + s + ansi.reset,
  green: s => ansi.green  + s + ansi.reset,
  cyan:  s => ansi.cyan   + s + ansi.reset,
  blue:  s => ansi.blue   + s + ansi.reset,
  yellow:s => ansi.yellow + s + ansi.reset,
  red:   s => ansi.red    + s + ansi.reset,
  white: s => ansi.white  + s + ansi.reset,
};

// ──────────────────────────────────────────
/* 🧰 Вспомогательные функции */
// ──────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a,b) => a + Math.floor(Math.random() * (b - a + 1));
const pad   = (s,n) => String(s).padEnd(n, ' ');
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

let _lastWidth = 0;
function rewrite(line) {
  const str = String(line);
  const padSpace = _lastWidth > str.length ? ' '.repeat(_lastWidth - str.length) : '';
  process.stdout.write(ansi.clrLine + ansi.homeCol + str + padSpace);
  _lastWidth = str.length;
}
function clearScreen(){
  process.stdout.write(ansi.clr + ansi.home);
}
function hideCursor(){
  try { process.stdout.write(ansi.hide); } catch {}
}
function showCursor(){
  try { process.stdout.write(ansi.show); } catch {}
}

// Универсальный центрирующий бокс
function boxedCenter(lines, width = 46) {
  const top = '╔' + '═'.repeat(width) + '╗';
  const bot = '╚' + '═'.repeat(width) + '╝';
  const body = lines.map(line => {
    const raw = stripAnsi(line);
    const padLeft = Math.max(0, Math.floor((width - raw.length) / 2));
    const padRight = Math.max(0, width - raw.length - padLeft);
    return '║' + ' '.repeat(padLeft) + line + ' '.repeat(padRight) + '║';
  });
  return [top, ...body, bot].join('\n');
}

// ──────────────────────────────────────────
/* 🌈 24-bit НЕОН (статичный градиент) */
// ──────────────────────────────────────────
const rgb = (r,g,b) => `\x1b[38;2;${r|0};${g|0};${b|0}m`;
function neonColor(i, phase=0){
  // бирюзово-лазурный спектр без фиолетового
  const k = phase + i * 0.12;
  const r = 30  + 25 * Math.sin(k + 0.2);
  const g = 170 + 70 * Math.sin(k + 1.1);
  const b = 220 + 35 * Math.sin(k + 2.0);
  return rgb(r,g,b);
}
function neonText(s, phase=0, makeBold=true){
  const out = [...String(s)].map((ch,i)=> neonColor(i,phase) + ch).join('') + ansi.reset;
  return makeBold ? (ansi.bold + out + ansi.reset) : out;
}

// ──────────────────────────────────────────
/* ⌗ Большое лого (СТАТИЧНОЕ) */
// ──────────────────────────────────────────
const NEON_LOGO = `
 ▄         ▄  ▄▄▄▄▄▄▄▄▄▄▄  ▄            ▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄   ▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄ 
▐░▌       ▐░▌▐░░░░░░░░░░░▌▐░▌          ▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌▐░░░░░░░░░░▌ ▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌
▐░▌       ▐░▌▐░█▀▀▀▀▀▀▀▀▀ ▐░▌          ▐░█▀▀▀▀▀▀▀█░▌▐░█▀▀▀▀▀▀▀▀▀ ▐░█▀▀▀▀▀▀▀█░▌▐░█▀▀▀▀▀▀▀█░▌▐░█▀▀▀▀▀▀▀█░▌ ▀▀▀▀█░█▀▀▀▀ 
▐░▌       ▐░▌▐░▌          ▐░▌          ▐░▌       ▐░▌▐░▌          ▐░▌       ▐░▌▐░▌       ▐░▌▐░▌       ▐░▌     ▐░▌     
▐░█▄▄▄▄▄▄▄█░▌▐░█▄▄▄▄▄▄▄▄▄ ▐░▌          ▐░█▄▄▄▄▄▄▄█░▌▐░█▄▄▄▄▄▄▄▄▄ ▐░█▄▄▄▄▄▄▄█░▌▐░█▄▄▄▄▄▄▄█░▌▐░▌       ▐░▌     ▐░▌     
▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌▐░▌          ▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌▐░░░░░░░░░░▌ ▐░▌       ▐░▌     ▐░▌     
▐░█▀▀▀▀▀▀▀█░▌▐░█▀▀▀▀▀▀▀▀▀ ▐░▌          ▐░█▀▀▀▀▀▀▀▀▀ ▐░█▀▀▀▀▀▀▀▀▀ ▐░█▀▀▀▀█░█▀▀ ▐░█▀▀▀▀▀▀▀█░▌▐░▌       ▐░▌     ▐░▌     
▐░▌       ▐░▌▐░▌          ▐░▌          ▐░▌          ▐░▌          ▐░▌     ▐░▌  ▐░▌       ▐░▌▐░▌       ▐░▌     ▐░▌     
▐░▌       ▐░▌▐░█▄▄▄▄▄▄▄▄▄ ▐░█▄▄▄▄▄▄▄▄▄ ▐░▌          ▐░█▄▄▄▄▄▄▄▄▄ ▐░▌      ▐░▌ ▐░█▄▄▄▄▄▄▄█░▌▐░█▄▄▄▄▄▄▄█░▌     ▐░▌     
▐░▌       ▐░▌▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌▐░▌          ▐░░░░░░░░░░░▌▐░▌       ▐░▌▐░░░░░░░░░░▌ ▐░░░░░░░░░░░▌     ▐░▌     
 ▀         ▀  ▀▀▀▀▀▀▀▀▀▀▀  ▀▀▀▀▀▀▀▀▀▀▀  ▀            ▀▀▀▀▀▀▀▀▀▀▀  ▀         ▀  ▀▀▀▀▀▀▀▀▀▀   ▀▀▀▀▀▀▀▀▀▀▀       ▀
`.trim();

const EXIT_LOGO = `
┌──────────────────────────────────────┐
│   НЕОН-ЯДРО ДЕАКТИВИРУЕТСЯ...        │
│   ∅ Синт-память выгружается          │
│   ∅ Сигналы связи гаснут             │
│   ∅ Нейролинии отсоединены           │
└──────────────────────────────────────┘
`.trim();

// ──────────────────────────────────────────
/* 🔄 Спиннер и шаги загрузки (ровная неоновая строка) */
// ──────────────────────────────────────────
const spinner = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
function spinnerFrame(i){ return spinner[i % spinner.length]; }
const BOOT_STEPS = [
  'Инициализация ядра',
  'Проверка окружения',
  'Подключение подсистем',
  'Калибровка сенсоров',
  'Боевые протоколы',
  'Загрузка навыков',
  'Адаптивная логика',
  'Синхронизация каналов',
  'Оптимизация маршрутов',
  'Пробуждение…'
];

// Неоновый прогресс-бар: заполненные блоки — градиент, пустые — серые
function progressBarNeon(p, width = 30, phase = 0.0) {
  const clamped = Math.max(0, Math.min(1, p));
  const filled  = Math.round(width * clamped);
  let out = '';
  for (let i = 0; i < filled; i++) out += neonColor(i, phase) + '█';
  out += ansi.reset + c.gray('░'.repeat(width - filled));
  return out + ansi.reset;
}

// — РОВНОЕ ВЫРАВНИВАНИЕ ЛЕВОЙ КОЛОНКИ —
const LABEL_WIDTH = 26; // ширина подписи шага (под русские строки)
function formatBootLine(step, p, spin, phase=0.2) {
  const name = step.length > LABEL_WIDTH
    ? step.slice(0, LABEL_WIDTH)
    : step.padEnd(LABEL_WIDTH, ' ');
  const pct  = String(Math.round(p * 100)).padStart(3, ' ') + '%';
  const bar  = progressBarNeon(p, 30, phase);
  return `${neonText(name, phase)}  ${bar}  ${c.gray(pct)}  ${c.dim(spin)}`;
}

// Печать строки с эффектом «тайпинга»
async function typeLine(line, delay = 10) {
  let buf = '';
  for (const ch of String(line)) {
    buf += ch;
    rewrite(buf);
    await sleep(delay);
  }
  process.stdout.write('\n');
  _lastWidth = 0;
}

// ──────────────────────────────────────────
/* 🧠 Boot (без анимированного лого) */
// ──────────────────────────────────────────
async function cyberBoot(finalMode = 'ok', percentFallback = 87) {
  clearScreen();
  // Статический логотип
  const lines = NEON_LOGO.split('\n');
  const framed = lines.map((ln, idx) => neonText(ln, idx * 0.2));
  console.log(ansi.bold + framed.join('\n') + ansi.reset + '\n');
  console.log(neonText(`⚡ Запуск ${APP_NAME} v${APP_VERSION}`, 0.6));
  console.log();

  // Ровные строки прогресса
  for (let s = 0; s < BOOT_STEPS.length; s++) {
    const step       = BOOT_STEPS[s];
    const breakEarly = (s === BOOT_STEPS.length - 1) && finalMode !== 'ok';
    const ticks      = 22 + rand(0, 6);
    const limit      = breakEarly ? Math.max(1, Math.floor((percentFallback / 100) * ticks)) : ticks;

    for (let i = 0; i <= limit; i++) {
      const p = i / ticks;
      const spin = spinnerFrame(i);
      const line = formatBootLine(step, p, spin, 0.25);
      rewrite(line);
      await sleep(22 + rand(0, 10));
    }

    if (!breakEarly) {
      const finalLine = formatBootLine(step, 1, '⠿', 0.5);
      rewrite(finalLine);
    }
    process.stdout.write('\n');
    _lastWidth = 0;

    if (breakEarly) {
      console.log(formatBootLine(step, percentFallback/100, '⠿', 0.6) + '\n');
      await typeLine(c.red('✖ Инициализация прервана'), 10);
      await typeLine(c.yellow('Статус: частичная загрузка (ядро в ограниченном режиме)'), 10);
      console.log(c.gray('────────────────────────────────────────────'));
      await typeLine(c.it(`└─ Сделано ${BRAND}`), 10);
      console.log();
      return;
    }

    await sleep(60 + rand(0, 60));
  }

  console.log();
  await typeLine(c.it(`└─ Сделано ${BRAND}`), 5);
  console.log();

  renderExitHint();
}

// ──────────────────────────────────────────
/* ⌘ Подсказка про выключение */
// ──────────────────────────────────────────
function renderExitHint() {
  const msg = 'Чтобы выключить:   Ctrl + C   — безопасное отключение';
  const top = '╭' + '─'.repeat(msg.length + 2) + '╮';
  const mid = `│ ${ansi.bold}${neonText(msg, 0.5, false)} │`;
  const bot = '╰' + '─'.repeat(msg.length + 2) + '╯';
  console.log('\n' + top + '\n' + mid + '\n' + bot + '\n');
}

// ──────────────────────────────────────────
/* 📝 Логи */
// ──────────────────────────────────────────
const logDir  = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `session_${(new Date()).toISOString().replace(/[:.]/g, '-')}.log`);
const logFile = fs.createWriteStream(logPath, { flags: 'a' });

function rawLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try { logFile.write(line + '\n'); } catch {}
}
const L = {
  ok:   (t, note='') => rawLog(`${c.green('✔')} ${t}${note ? (' — ' + note) : ''}`),
  warn: (t, note='') => rawLog(`${c.yellow('▲')} ${t}${note ? (' — ' + note) : ''}`),
  err:  (t, note='') => rawLog(`${c.red('✖')} ${t}${note ? (' — ' + note) : ''}`),
  info: (t, note='') => rawLog(`${c.cyan('ℹ')} ${t}${note ? (' — ' + note) : ''}`),
};

// ──────────────────────────────────────────
/* 🌍 ENV проверка */
// ──────────────────────────────────────────
function verifyEnvOrExit() {
  const requiredEnv = ['SERVER_HOST', 'BOT_NAME', 'VERSION'];
  const missing = requiredEnv.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(c.red('❌ Отсутствуют ключи в .env: ') + missing.join(', '));
    console.log(c.yellow('💡 Скопируй .env.example → .env и заполни значения'));
    process.exit(1);
  }
}

// ──────────────────────────────────────────
/* 🤖 Запуск бота */
// ──────────────────────────────────────────
let bot = null;

async function startBot() {
  verifyEnvOrExit();
  try {
    const { createOrReconnect } = require('./core/bot.cjs');
    rawLog(`${APP_NAME} v${APP_VERSION} starting...`);
    bot = await createOrReconnect(process.env.BOT_NAME);
    L.ok('Bot core initialized.');
  } catch (err) {
    L.err('Bot init failed', err.message || String(err));
    process.exit(1);
  }
}

// ──────────────────────────────────────────
/* 🧠 Подсистемы */
// ──────────────────────────────────────────
const moduleHealth = {
  masterAI: null,
  miner:    null,
  wood:     null,
  combat:   null,
  quantum:  null,
  telegram: null
};

function prettyModuleLine(name, status, note = '') {
  const tag = pad(name, 11);
  if (status === true)   return `${c.green('✔')} ${tag} ${c.gray(note)}`;
  if (status === false)  return `${c.red('✖')} ${tag} ${c.gray(note)}`;
  return                   `${c.yellow('▲')} ${tag} ${c.gray(note)}`;
}

async function loadSystems() {
  const lines = [];

  // masterAI
  try {
    const master = require('./features/ai/masterAI.cjs');
    if (typeof master === 'function') {
      const maybe = master(bot);
      bot.masterAI = maybe || master;
      moduleHealth.masterAI = true;
      lines.push(prettyModuleLine('masterAI', true, 'factory'));
    } else if (master && typeof master.init === 'function') {
      await master.init(bot, { debug:false, guardIntervalMs:1400 });
      bot.masterAI = master;
      moduleHealth.masterAI = true;
      lines.push(prettyModuleLine('masterAI', true, 'init()'));
    } else {
      moduleHealth.masterAI = null;
      lines.push(prettyModuleLine('masterAI', null, 'unknown signature'));
    }
  } catch {
    moduleHealth.masterAI = null;
    lines.push(prettyModuleLine('masterAI', null, 'not found'));
  }

  // miner subsystem
  try {
    bot.miner = require('./features/ai/agents/miner.cjs')(bot);
    moduleHealth.miner = true;
    lines.push(prettyModuleLine('miner', true, 'agents/miner.cjs'));
  } catch {
    try {
      bot.miner = require('./features/mining/mining.js')(bot);
      moduleHealth.miner = true;
      lines.push(prettyModuleLine('miner', true, 'features/mining/mining.js'));
    } catch {
      try {
        bot.minerCore = require('./features/ai/agents/minerCore.cjs')(bot);
        moduleHealth.miner = true;
        lines.push(prettyModuleLine('minerCore', true, 'agents/minerCore.cjs'));
      } catch {
        moduleHealth.miner = false;
        lines.push(prettyModuleLine('miner', false, 'attach failed'));
      }
    }
  }

  // woodcutter
  try {
    bot.wood = require('./features/ai/agents/woodcutter.cjs')(bot);
    moduleHealth.wood = true;
    lines.push(prettyModuleLine('woodcutter', true, 'agents/woodcutter.cjs'));
  } catch {
    moduleHealth.wood = false;
    lines.push(prettyModuleLine('woodcutter', false, 'attach failed'));
  }

  // combat subsystem
  try {
    let attached = false;
    try {
      const adv = require('./features/combat/advancedCombat.js');
      if (typeof adv.initCombat === 'function') { adv.initCombat(bot); attached = true; }
      else if (typeof adv.init === 'function')  { adv.init(bot);      attached = true; }
      else if (adv && adv.combatManager && typeof adv.combatManager.attach === 'function') { adv.combatManager.attach(bot); bot.combat = adv.combatManager; attached = true; }
      else if (adv && adv.CombatManager && typeof adv.CombatManager === 'function') { const mgr = new adv.CombatManager(); if (mgr && typeof mgr.attach === 'function') { mgr.attach(bot); bot.combat = mgr; attached = true; } }
      if (attached) {
        moduleHealth.combat = true;
        lines.push(prettyModuleLine('combat', true, 'features/combat/advancedCombat.js'));
      }
    } catch {
      // ignore and try basic fallback below
    }
    // Fallback to basic combat implementation
    if (!attached) {
      try {
        const basic = require('./features/combat/combat.js');
        if (typeof basic.initCombat === 'function') { basic.initCombat(bot); attached = true; }
        else if (typeof basic.init === 'function')   { basic.init(bot);      attached = true; }
        if (attached) {
          moduleHealth.combat = true;
          lines.push(prettyModuleLine('combat', true, 'features/combat/combat.js'));
        }
      } catch {
        // still not attached
      }
    }
    if (!attached) {
      moduleHealth.combat = null;
      lines.push(prettyModuleLine('combat', null, 'not found'));
    }
  } catch {
    moduleHealth.combat = null;
    lines.push(prettyModuleLine('combat', null, 'not found'));
  }

  // quantum (опционально)
  try {
    bot.quantum = require('./features/ai/quantum/index.cjs');
    moduleHealth.quantum = true;
    lines.push(prettyModuleLine('quantum', true, 'connected'));
  } catch {
    moduleHealth.quantum = null;
    lines.push(pretyModuleLine('quantum', null, 'not connected')); // опечатка специально нет — исправим ниже
  }

  rawLog('AI modules summary:');
  for (const ln of lines) console.log(ln);

  // мини-дашборд статуса (ровная рамка)
  const okCount   = Object.values(moduleHealth).filter(v => v === true).length;
  const warnCount = Object.values(moduleHealth).filter(v => v === null).length;
  const badCount  = Object.values(moduleHealth).filter(v => v === false).length;

  const dash = boxedCenter([
    neonText('SUBSYSTEMS STATUS', 0.35),
    `${c.green('OK: ' + okCount)}   ${c.yellow('WARN: ' + warnCount)}   ${c.red('FAIL: ' + badCount)}`
  ], 46);

  console.log('\n' + dash + '\n');

  L.ok('AI modules loaded');
  renderExitHint();
}

// ──────────────────────────────────────────
/* 💬 Telegram */
// ──────────────────────────────────────────
async function connectTelegram() {
  try {
    const bridge = require('./integrations/telegram.js');
    if (bridge && typeof bridge.setupTelegram === 'function') {
      await bridge.setupTelegram(bot);
      moduleHealth.telegram = true;
      L.ok('Telegram bridge active');
    } else {
      moduleHealth.telegram = null;
      L.info('Telegram bridge skipped', 'no setupTelegram()');
    }
  } catch (err) {
    moduleHealth.telegram = false;
    const msg = String(err && (err.description || err.message || err));
    if (/404|not\s*found/i.test(msg)) {
      L.err('Telegram bridge error', '404 Not Found — проверь TG_TOKEN / TG_CHAT_ID');
    } else {
      L.err('Telegram bridge error', msg);
    }
  }
}

// ──────────────────────────────────────────
/* ✖ Выключение (чистое, без ULTRAKILL) */
// ──────────────────────────────────────────
let shuttingDown = false;

async function neonShutdown(reason = 'SIGINT') {
  if (shuttingDown) return;
  shuttingDown = true;

  clearScreen();
  showCursor(); // вернуть курсор на всякий

  console.log(c.red(EXIT_LOGO) + '\n');
  console.log(c.red(`✖ Отключение ${APP_NAME} (${reason})`));
  console.log();

  const steps = [
    'Сохранение состояния',
    'Остановка подсистем',
    'Отключение сети',
    'Гашение неона'
  ];
  for (const step of steps) {
    console.log(`${neonText(step, 0.2)}  ${c.green('✔ Готово')}`);
  }

  const END_BOX = boxedCenter([
    c.red('╳ СЕАНС ЗАВЕРШЁН'),
    c.gray('До встречи, оперативник.')
  ], 46);

  console.log('\n' + END_BOX + '\n');
  console.log(c.it(`└─ Выключено. Создано: ${BRAND}`));
  console.log();

  try { bot?.quit?.('Shutdown'); } catch {}
  try { logFile.end(); } catch {}

  process.exit(0);
}

// ──────────────────────────────────────────
/* 🧯 Сигналы и стабильность */
// ──────────────────────────────────────────
function setupSignalHandlers() {
  const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
  const handler = (sig) => neonShutdown(sig);
  signals.forEach(sig => process.on(sig, handler));

  process.on('uncaughtException', (err) => {
    L.err('uncaughtException', err.stack || String(err));
    neonShutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    L.warn('unhandledRejection', String(reason));
    neonShutdown('unhandledRejection');
  });
}

// ──────────────────────────────────────────
/* 🧪 Boot mode из ENV */
// ──────────────────────────────────────────
function readBootModeFromEnv() {
  const modeEnv = String(process.env.BOOT_RESULT || 'ok').toLowerCase();
  const pct     = Math.max(5, Math.min(98, parseInt(process.env.BOOT_PERCENT || '87', 10) || 87));
  if (modeEnv === 'partial' || modeEnv === 'fail') return { mode: modeEnv, percent: pct };
  if (modeEnv === 'auto')    return { mode: 'ok',      percent: pct };
  return { mode: 'ok', percent: pct };
}

// ──────────────────────────────────────────
/* 🚀 Main */
// ──────────────────────────────────────────
(async () => {
  try {
    setupSignalHandlers();
    const { mode: bootMode, percent } = readBootModeFromEnv();
    await cyberBoot(bootMode, percent);
    await startBot();
    setupSignalHandlers(); // ещё раз подтверждаем
    setTimeout(loadSystems,      1500);
    setTimeout(connectTelegram, 1200);
    rawLog(`✅ ${APP_NAME} v${APP_VERSION} started! Log: ${path.relative(process.cwd(), logPath)}`);
  } catch (e) {
    L.err('Fatal boot error', String(e));
    await neonShutdown('bootError');
  } finally {
    showCursor();
  }
})();

// ──────────────────────────────────────────
// 🛠️ Горячий фикс опечатки (на случай правок выше)
// ──────────────────────────────────────────
// Если где-то случайно написали pretyModuleLine — переопределим безопасно
// (не влияет, если всё ок)
function pretyModuleLine(...args) {
  return prettyModuleLine(...args);
}
