'use strict';
// ===============================
// integrations/telegramAutoCraft.js — v7.0
// 🤖 Telegram: быстрый крафт (с категориями и страницами), автокрафт, расширенный майнинг, инвентарь, поиск
// Основные улучшения:
//  • Переработано меню «Быстрый крафт»: категории + пагинация для большого числа рецептов
//  • Расширен список заготовок (инструменты/оружие/база/редстоун/еда)
//  • Пер‑чатовая блокировка задач (без общего global isBusy)
//  • Стоп‑кнопка для любых операций крафта/майнинга
//  • /help, /start, /stop, /craft <имя> xN, /autocraft <имя> xN
//  • Улучшенное форматирование инвентаря и сортировки
//  • Аккуратные editMessage* (без ошибок «message is not modified»)
//  • Небольшой rate‑limit по кнопкам и безопасные хелперы
//  • Расширенные сценарии майнинга (железо, уголь, редстоун, золото, лазурит, изумруд, алмаз)
// ===============================

const TelegramBot = require('node-telegram-bot-api');
const { craftItem } = require('../features/crafting/crafting.js');
const { smartAutoCraft, fullAutoCraft, cancelCraft } = require('../features/crafting/autoCrafter.js');
const { suggestCraftable } = require('../features/crafting/smartCraft.js');
const { chopWood, mineOres, collectBlocksByNames } = require('../features/mining/mining.js');
const { getBot } = require('../core/state.cjs');

const telegramBot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// ————————————————————————————————————————————————————————————————
// Каталог «Быстрый крафт»: категории и элементы (можно легко дополнять)
// callback_data должен быть коротким — используем короткие ключи категорий
// ————————————————————————————————————————————————————————————————
const CATS = {
  base:   { key: 'base',   title: 'База',     emoji: '🧱' },
  tools:  { key: 'tools',  title: 'Инструм.', emoji: '🛠️' },
  weap:   { key: 'weap',   title: 'Оружие',   emoji: '⚔️' },
  armor:  { key: 'armor',  title: 'Броня',    emoji: '🛡️' },
  red:    { key: 'red',    title: 'Редстоун', emoji: '🔺' },
  util:   { key: 'util',   title: 'Утиль',    emoji: '📦' },
  food:   { key: 'food',   title: 'Еда',      emoji: '🍗' }
};

// Элементы каталога. name.ru — точное русскоязычное имя предмета (как в ваших рецептах)
// presets — быстрые количества, можно задавать под специфику предмета
const QUICK_CATALOG = {
  [CATS.base.key]: [
    { label: '🪵 Палки',             ru: 'палка',                   presets: [1, 8, 16, 32, 64] },
    { label: '🪚 Доски',             ru: 'доски',                   presets: [4, 16, 32, 64] },
    { label: '🧰 Верстак',           ru: 'верстак',                 presets: [1, 2, 4] },
    { label: '🔥 Факелы',            ru: 'факел',                   presets: [4, 16, 32, 64] },
    { label: '🔥 Печь',              ru: 'печь',                    presets: [1, 2, 4] },
    { label: '🔥 Плавильная печь',   ru: 'плавильная печь',         presets: [1, 2] },
    { label: '🔥 Коптильня',         ru: 'коптильня',               presets: [1, 2] },
    { label: '📦 Сундук',            ru: 'сундук',                  presets: [1, 2, 4, 8] },
    { label: '📦 Бочка',             ru: 'бочка',                   presets: [1, 2, 4] },
    { label: '🪜 Лестницы',          ru: 'лестница',                presets: [4, 8, 16, 32] },
    { label: '🧱 Ступени',           ru: 'ступени',                 presets: [4, 8, 16, 32] },
    { label: '🛤️ Рельсы',            ru: 'рельсы',                  presets: [16, 32, 64] },
    { label: '⚡ Энергорельсы',       ru: 'энергорельсы',            presets: [8, 16, 32] },
    { label: '🧪 Детекторные рельсы',ru: 'детекторные рельсы',      presets: [8, 16, 32] },
  ],
  [CATS.tools.key]: [
    { label: '⛏️ Кирка (дерев.)',    ru: 'деревянная кирка',        presets: [1, 2] },
    { label: '⛏️ Кирка (кам.)',      ru: 'каменная кирка',          presets: [1, 2] },
    { label: '⛏️ Кирка (желез.)',    ru: 'железная кирка',          presets: [1, 2] },
    { label: '⛏️ Кирка (золот.)',    ru: 'золотая кирка',           presets: [1] },
    { label: '⛏️ Кирка (алмаз.)',    ru: 'алмазная кирка',          presets: [1] },
    { label: '⛏️ Кирка (незерит.)',  ru: 'незеритовая кирка',       presets: [1] },

    { label: '🪓 Топор (дерев.)',    ru: 'деревянный топор',        presets: [1, 2] },
    { label: '🪓 Топор (кам.)',      ru: 'каменный топор',          presets: [1, 2] },
    { label: '🪓 Топор (желез.)',    ru: 'железный топор',          presets: [1, 2] },
    { label: '🪓 Топор (золот.)',    ru: 'золотой топор',           presets: [1] },
    { label: '🪓 Топор (алмаз.)',    ru: 'алмазный топор',          presets: [1] },
    { label: '🪓 Топор (незерит.)',  ru: 'незеритовый топор',       presets: [1] },

    { label: '🧹 Лопата (дерев.)',   ru: 'деревянная лопата',       presets: [1, 2] },
    { label: '🧹 Лопата (кам.)',     ru: 'каменная лопата',         presets: [1, 2] },
    { label: '🧹 Лопата (желез.)',   ru: 'железная лопата',         presets: [1, 2] },
    { label: '🧹 Лопата (золот.)',   ru: 'золотая лопата',          presets: [1] },
    { label: '🧹 Лопата (алмаз.)',   ru: 'алмазная лопата',         presets: [1] },
    { label: '🧹 Лопата (незерит.)', ru: 'незеритовая лопата',      presets: [1] },

    { label: '🌾 Мотыга (дерев.)',   ru: 'деревянная мотыга',       presets: [1, 2] },
    { label: '🌾 Мотыга (кам.)',     ru: 'каменная мотыга',         presets: [1, 2] },
    { label: '🌾 Мотыга (желез.)',   ru: 'железная мотыга',         presets: [1, 2] },
    { label: '🌾 Мотыга (золот.)',   ru: 'золотая мотыга',          presets: [1] },
    { label: '🌾 Мотыга (алмаз.)',   ru: 'алмазная мотыга',         presets: [1] },
    { label: '🌾 Мотыга (незерит.)', ru: 'незеритовая мотыга',      presets: [1] },

    { label: '✂️ Ножницы',           ru: 'ножницы',                 presets: [1] },
    { label: '🔥 Огниво',            ru: 'огниво',                  presets: [1] },
    { label: '🎣 Удочка',            ru: 'удочка',                  presets: [1] },
  ],
  [CATS.weap.key]: [
    { label: '🗡️ Меч (дерев.)',     ru: 'деревянный меч',          presets: [1, 2] },
    { label: '🗡️ Меч (кам.)',       ru: 'каменный меч',            presets: [1, 2] },
    { label: '🗡️ Меч (желез.)',     ru: 'железный меч',            presets: [1, 2] },
    { label: '🗡️ Меч (золот.)',     ru: 'золотой меч',             presets: [1] },
    { label: '🗡️ Меч (алмаз.)',     ru: 'алмазный меч',            presets: [1] },
    { label: '🗡️ Меч (незерит.)',   ru: 'незеритовый меч',         presets: [1] },
    { label: '🏹 Лук',               ru: 'лук',                     presets: [1] },
    { label: '🏹 Арбалет',           ru: 'арбалет',                 presets: [1] },
    { label: '🎯 Стрелы',            ru: 'стрела',                  presets: [8, 16, 32, 64] },
    { label: '🛡️ Щит',              ru: 'щит',                     presets: [1] },
  ],
  [CATS.armor.key]: [
    { label: '⛑️ Шлем (кожа)',       ru: 'кожаный шлем',            presets: [1] },
    { label: '👕 Нагрудник (кожа)',  ru: 'кожаный нагрудник',       presets: [1] },
    { label: '🩳 Поножи (кожа)',     ru: 'кожаные штаны',           presets: [1] },
    { label: '👢 Ботинки (кожа)',    ru: 'кожаные ботинки',         presets: [1] },

    { label: '⛑️ Шлем (железо)',    ru: 'железный шлем',           presets: [1] },
    { label: '👕 Нагрудник (жел.)',  ru: 'железный нагрудник',      presets: [1] },
    { label: '🩳 Поножи (жел.)',     ru: 'железные поножи',         presets: [1] },
    { label: '👢 Ботинки (жел.)',    ru: 'железные ботинки',        presets: [1] },

    { label: '⛑️ Шлем (золото)',    ru: 'золотой шлем',            presets: [1] },
    { label: '👕 Нагрудник (зол.)',  ru: 'золотой нагрудник',       presets: [1] },
    { label: '🩳 Поножи (зол.)',     ru: 'золотые поножи',          presets: [1] },
    { label: '👢 Ботинки (зол.)',    ru: 'золотые ботинки',         presets: [1] },

    { label: '⛑️ Шлем (алмаз)',     ru: 'алмазный шлем',           presets: [1] },
    { label: '👕 Нагрудник (алм.)',  ru: 'алмазный нагрудник',      presets: [1] },
    { label: '🩳 Поножи (алм.)',     ru: 'алмазные поножи',         presets: [1] },
    { label: '👢 Ботинки (алм.)',    ru: 'алмазные ботинки',        presets: [1] },

    { label: '⛑️ Шлем (незерит)',   ru: 'незеритовый шлем',        presets: [1] },
    { label: '👕 Нагрудник (нез.)',  ru: 'незеритовый нагрудник',   presets: [1] },
    { label: '🩳 Поножи (нез.)',     ru: 'незеритовые поножи',      presets: [1] },
    { label: '👢 Ботинки (нез.)',    ru: 'незеритовые ботинки',     presets: [1] },
  ],
  [CATS.red.key]: [
    { label: '⚙️ Рычаг',             ru: 'рычаг',                   presets: [1, 4, 8] },
    { label: '⚙️ Кнопка',            ru: 'кнопка',                  presets: [1, 4, 8] },
    { label: '⚙️ Плита (кам.)',      ru: 'каменная нажимная плита', presets: [1, 2, 4] },
    { label: '⚙️ Плита (дерев.)',    ru: 'деревянная нажимная плита', presets: [1, 2, 4] },
    { label: '🧲 Редстоун‑факел',     ru: 'редстоун факел',          presets: [2, 8, 16, 32] },
    { label: '🔁 Повторитель',       ru: 'редстоун повторитель',    presets: [1, 2, 4] },
    { label: '🧮 Компаратор',        ru: 'редстоун компаратор',     presets: [1, 2, 4] },
    { label: '👀 Наблюдатель',       ru: 'наблюдатель',             presets: [1, 2, 4] },
    { label: '🧱 Поршень',           ru: 'поршень',                 presets: [1, 2, 4] },
    { label: '🧱 Липкий поршень',    ru: 'липкий поршень',          presets: [1, 2, 4] },
    { label: '📤 Раздатчик',         ru: 'раздатчик',               presets: [1, 2, 4] },
    { label: '📦 Выбрасыватель',     ru: 'выбрасыватель',           presets: [1, 2, 4] },
    { label: '🕳️ Воронка',           ru: 'воронка',                 presets: [1, 2, 4] },
  ],
  [CATS.util.key]: [
    { label: '🧭 Компас',            ru: 'компас',                  presets: [1] },
    { label: '🗺️ Карта',             ru: 'карта',                   presets: [1, 2] },
    { label: '🪣 Ведро',             ru: 'ведро',                   presets: [1, 2, 4] },
    { label: '🛏️ Кровать',          ru: 'кровать',                 presets: [1, 2, 4] },
    { label: '🛶 Лодка',             ru: 'лодка',                   presets: [1, 2] },
    { label: '⚒️ Наковальня',        ru: 'наковальня',              presets: [1] },
    { label: '🪵 Точило',            ru: 'точило',                  presets: [1] },
    { label: '📚 Стол зачарования',  ru: 'стол зачарования',        presets: [1] },
    { label: '🪓 Камнерез',          ru: 'камнерез',                presets: [1] },
    { label: '🗺️ Картографический стол', ru: 'картографический стол', presets: [1] },
    { label: '🛠️ Стол кузнеца',     ru: 'стол кузнеца',            presets: [1] },
    { label: '🧵 Ткацкий станок',    ru: 'ткацкий станок',          presets: [1] },
    { label: '🧪 Зельеварка',        ru: 'стойка зельеварения',     presets: [1] },
  ],
  [CATS.food.key]: [
    { label: '🍞 Хлеб',              ru: 'хлеб',                    presets: [1, 3, 6, 12] },
    { label: '🍪 Печенье',           ru: 'печенье',                 presets: [8, 16, 32] },
    { label: '🍰 Торт',              ru: 'торт',                    presets: [1, 2] },
    { label: '🥕 Золотая морковь',   ru: 'золотая морковь',         presets: [1, 3, 6] },
    { label: '🍎 Золотое яблоко',    ru: 'золотое яблоко',          presets: [1, 2, 4] },
    { label: '🎃 Тыквенный пирог',   ru: 'тыквенный пирог',         presets: [1, 2, 4] },
  ]
};

// Элементы, которые лучше крафтить через smartAutoCraft (со сложными подкомпонентами)
const USE_SMART = new Set([
  // сложные или многошаговые рецепты / апгрейды
  'щит','лук','стрела','арбалет',
  'компас','карта','воронка','раздатчик','выбрасыватель','наблюдатель',
  'редстоун повторитель','редстоун компаратор','поршень','липкий поршень',
  'наковальня','стол зачарования','камнерез','картографический стол','стол кузнеца','стойка зельеварения',
  // высокие тиры инструментов и оружия
  'алмазная кирка','алмазный меч','алмазный топор','алмазная лопата','алмазная мотыга',
  'незеритовая кирка','незеритовый меч','незеритовый топор','незеритовая лопата','незеритовая мотыга',
  // броня
  'алмазный шлем','алмазный нагрудник','алмазные поножи','алмазные ботинки',
  'незеритовый шлем','незеритовый нагрудник','незеритовые поножи','незеритовые ботинки'
]);

// ————————————————————————————————————————————————————————————————
// Вспомогательные: состояние, безопасные edit/send, троттлинг
// ————————————————————————————————————————————————————————————————
const chatState = new Map(); // chatId -> { itemRu, amount, invSort }
const busyChats = new Set(); // chatIds where a long task is running
const lastActionAt = new Map(); // лёгкий rate‑limit по кнопкам

function now() { return Date.now(); }
function rateLimited(chatId, ms = 450) {
  const t = lastActionAt.get(chatId) || 0; const ok = now() - t > ms;
  if (ok) lastActionAt.set(chatId, now());
  return !ok;
}

function ensureBot(chatId) {
  const bot = getBot?.();
  if (!bot || !bot.entity) {
    telegramBot.sendMessage(chatId, '🤖 Бот ещё не готов. Попробуй позже.');
    return null;
  }
  return bot;
}

function guardBusy(chatId) {
  if (busyChats.has(chatId)) {
    telegramBot.sendMessage(chatId, '⌛ Уже идёт задача. Нажми «⏹ Остановить», либо дождись завершения.');
    return true;
  }
  return false;
}

async function sendSafely(chatId, text, opts) {
  try { return await telegramBot.sendMessage(chatId, text, opts); } catch { /* noop */ }
}
async function editTextSafely(chatId, messageId, text, opts) {
  try { return await telegramBot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }); }
  catch (e) { /* ignore edit errors (not modified / message changed) */ }
}
async function editMarkupSafely(chatId, messageId, markup) {
  try { return await telegramBot.editMessageReplyMarkup(markup, { chat_id: chatId, message_id: messageId }); }
  catch (e) { /* ignore */ }
}

async function withBusy(chatId, fn) {
  if (guardBusy(chatId)) return;
  busyChats.add(chatId);
  try { return await fn(); } finally { busyChats.delete(chatId); }
}

function withTyping(chatId, fn) {
  return (async () => {
    try { await telegramBot.sendChatAction(chatId, 'typing'); } catch {}
    return await fn();
  })();
}

// ————————————————————————————————————————————————————————————————
// Инвентарь: форматирование и клавиатуры
// ————————————————————————————————————————————————————————————————
function fmtInv(bot, { limit = 28, sort = 'count' } = {}) {
  const counts = new Map();
  try {
    for (const it of bot.inventory.items()) counts.set(it.name, (counts.get(it.name) || 0) + it.count);
  } catch {}
  let items = [...counts.entries()];
  if (sort === 'count') items.sort((a, b) => b[1] - a[1]); else items.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'ru'));
  items = items.slice(0, limit);
  const pos = bot.entity.position || { x: 0, y: 0, z: 0 };
  const header = `🤖 Инвентарь\n❤️ HP: ${bot.health ?? 0}/20  🍖 Еда: ${bot.food ?? 0}/20\n📍 X:${Math.round(pos.x)} Y:${Math.round(pos.y)} Z:${Math.round(pos.z)}`;
  if (!items.length) return header + '\n📦 Пусто';
  const lines = items.map(([n, c]) => `• ${n} ×${c}`).join('\n');
  return `${header}\n${lines}`;
}

function invKeyboard(sort = 'count') {
  const sortBtn = sort === 'count' ? { text: '🔤 Сорт. по имени', callback_data: 'inv:sort:name' } : { text: '🔢 Сорт. по кол-ву', callback_data: 'inv:sort:count' };
  return {
    inline_keyboard: [
      [sortBtn, { text: '🔁 Обновить', callback_data: 'inv:refresh' }],
      [{ text: '🧰 Быстрый крафт', callback_data: 'menu:quick' }]
    ]
  };
}

// ————————————————————————————————————————————————————————————————
// Быстрый крафт: меню категорий, страницы, выбор количества
// ————————————————————————————————————————————————————————————————
function chunk2(arr) { const out = []; for (let i = 0; i < arr.length; i += 2) out.push(arr.slice(i, i + 2)); return out; }
function paginate(arr, page = 0, size = 10) { const start = page * size; return arr.slice(start, start + size); }

function quickCategoriesKeyboard() {
  const row1 = [
    { text: `${CATS.base.emoji} ${CATS.base.title}`, callback_data: `qc:cat:${CATS.base.key}:0` },
    { text: `${CATS.tools.emoji} ${CATS.tools.title}`, callback_data: `qc:cat:${CATS.tools.key}:0` }
  ];
  const row2 = [
    { text: `${CATS.weap.emoji} ${CATS.weap.title}`, callback_data: `qc:cat:${CATS.weap.key}:0` },
    { text: `${CATS.armor.emoji} ${CATS.armor.title}`, callback_data: `qc:cat:${CATS.armor.key}:0` }
  ];
  const row3 = [
    { text: `${CATS.red.emoji} ${CATS.red.title}`, callback_data: `qc:cat:${CATS.red.key}:0` },
    { text: `${CATS.util.emoji} ${CATS.util.title}`, callback_data: `qc:cat:${CATS.util.key}:0` }
  ];
  const row4 = [
    { text: `${CATS.food.emoji} ${CATS.food.title}`, callback_data: `qc:cat:${CATS.food.key}:0` }
  ];
  const bottom = [
    { text: '⛏️ Алмазы', callback_data: 'mine:diamond' },
    { text: '🪙 Железо', callback_data: 'mine:iron' },
    { text: '🌑 Уголь', callback_data: 'mine:coal' }
  ];
  const bottom2 = [
    { text: '🔵 Лазурит', callback_data: 'mine:lapis' },
    { text: '🟥 Редстоун', callback_data: 'mine:redstone' },
    { text: '💚 Изумруд', callback_data: 'mine:emerald' }
  ];
  const bottom3 = [
    { text: '🟡 Золото', callback_data: 'mine:gold' },
    { text: '🟤 Обломки', callback_data: 'mine:debris' },
    { text: '📦 Инвентарь', callback_data: 'inv:show' }
  ];
  return { inline_keyboard: [row1, row2, row3, row4, bottom, bottom2, bottom3] };
}

function quickItemsKeyboard(catKey, page = 0) {
  const items = QUICK_CATALOG[catKey] || [];
  const pageItems = paginate(items, page, 12); // до 12 предметов на страницу
  const rows = chunk2(pageItems.map(it => ({ text: it.label, callback_data: `qc:sel:${it.ru}` })));
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Назад', callback_data: `qc:cat:${catKey}:${page - 1}` });
  if ((page + 1) * 12 < items.length) nav.push({ text: '➡️ Далее', callback_data: `qc:cat:${catKey}:${page + 1}` });
  if (!nav.length) nav.push({ text: '⬅ Меню', callback_data: 'menu:quick' }); else nav.push({ text: '🏠 Меню', callback_data: 'menu:quick' });
  rows.push(nav);
  rows.push([{ text: '📦 Инвентарь', callback_data: 'inv:show' }]);
  return { inline_keyboard: rows };
}

function amountKeyboard(ru, amount) {
  // Найдём пресеты из каталога или применим дефолт
  let presets = [1, 8, 16, 32, 64];
  outer: for (const arr of Object.values(QUICK_CATALOG)) {
    for (const x of arr) if (x.ru === ru) { presets = x.presets || presets; break outer; }
  }
  return {
    inline_keyboard: [
      [
        { text: '−1', callback_data: `qca:-:1:${ru}` },
        { text: `${amount}`, callback_data: `qcnop:${ru}` },
        { text: '+1', callback_data: `qca:+:1:${ru}` }
      ],
      [ { text: '−5', callback_data: `qca:-:5:${ru}` }, { text: '+5', callback_data: `qca:+:5:${ru}` } ],
      [ ...presets.slice(0, 5).map(p => ({ text: `×${p}`, callback_data: `qcp:${p}:${ru}` })) ],
      [ { text: '⬅ Меню', callback_data: 'menu:quick' }, { text: '✅ Крафтить', callback_data: `qcok:${ru}:${amount}` } ]
    ]
  };
}

// ————————————————————————————————————————————————————————————————
// Команды
// ————————————————————————————————————————————————————————————————
telegramBot.onText(/\/(start|help)/, (msg) => {
  const chatId = msg.chat.id;
  const help = [
    '📝 Команды:',
    '• /inv — показать инвентарь',
    '• /quickcraft — быстрое меню крафта',
    '• /craft <название> xN — мгновенный крафт (пример: /craft факел x32)',
    '• /autocraft <название> xN — автокрафт со сбором подкомпонентов',
    '• /autocraft_all — полный автокрафт (рекомендуется с осторожностью)',
    '• /stop — остановить текущую задачу',
  ].join('\n');
  sendSafely(chatId, `Добро пожаловать!\n${help}`, { reply_markup: quickCategoriesKeyboard() });
});

telegramBot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  try { cancelCraft(); } catch {}
  busyChats.delete(chatId);
  sendSafely(chatId, '🛑 Остановлено.');
});

telegramBot.onText(/\/inv(?:\s+(name|count))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const bot = ensureBot(chatId); if (!bot) return;
  const sort = (match?.[1] === 'name') ? 'name' : 'count';
  chatState.set(chatId, { ...(chatState.get(chatId) || {}), invSort: sort });
  sendSafely(chatId, fmtInv(bot, { sort }), { reply_markup: invKeyboard(sort) });
});

telegramBot.onText(/\/quickcraft/, (msg) => {
  const chatId = msg.chat.id;
  sendSafely(chatId, '🧰 Быстрый крафт: выбери категорию', { reply_markup: quickCategoriesKeyboard() });
});

// /craft <имя> xN  — простой крафт (без smart)
telegramBot.onText(/\/craft\s+([^x×\n]+?)(?:\s*[x×]\s*(\d+))?\s*$/i, async (msg, match) => {
  const chatId = msg.chat.id; const ruName = (match?.[1] || '').trim();
  const amount = Math.max(1, parseInt(match?.[2] || '1', 10));
  const bot = ensureBot(chatId); if (!bot) return;
  await withBusy(chatId, async () => withTyping(chatId, async () => {
    const m = await sendSafely(chatId, `🛠️ Крафчу: ${ruName} ×${amount}`);
    try {
      await craftItem(bot, ruName, amount);
      await editTextSafely(chatId, m?.message_id, `✅ Готово: ${ruName} ×${amount}`);
    } catch (e) {
      await sendSafely(chatId, `❌ Ошибка крафта (${ruName}): ${e?.message || e}`);
    }
  }));
});

// /autocraft <имя> xN  — smartAutoCraft
telegramBot.onText(/\/autocraft\s+([^x×\n]+?)(?:\s*[x×]\s*(\d+))?\s*$/i, async (msg, match) => {
  const chatId = msg.chat.id; const ruName = (match?.[1] || '').trim();
  const amount = Math.max(1, parseInt(match?.[2] || '1', 10));
  const bot = ensureBot(chatId); if (!bot) return;
  await withBusy(chatId, async () => withTyping(chatId, async () => {
    let m = await sendSafely(chatId, `🚀 Автокрафт: ${ruName} ×${amount}`);
    try {
      await smartAutoCraft(bot, ruName, amount, {
        onProgress: async ({ pct, step }) => {
          try {
            await editTextSafely(chatId, m?.message_id, `⚙️ Автокрафт: ${ruName} ×${amount}\nПрогресс: ${pct}%\nСейчас: ${step.ruName} ×${step.amount}`, {
              reply_markup: { inline_keyboard: [[{ text: '⏹ Остановить', callback_data: 'stop_autocraft' }]] }
            });
          } catch {}
        }
      });
      await editTextSafely(chatId, m?.message_id, `✅ Готово: ${ruName} ×${amount}`);
    } catch (e) {
      await sendSafely(chatId, `❌ Ошибка: ${e?.message || e}`);
    }
  }));
});

telegramBot.onText(/\/autocraft_all/, async (msg) => {
  const chatId = msg.chat.id; const bot = ensureBot(chatId); if (!bot) return;
  await withBusy(chatId, async () => withTyping(chatId, async () => {
    let m = await sendSafely(chatId, '🔁 Полный автокрафт…');
    try { await fullAutoCraft(bot); await editTextSafely(chatId, m?.message_id, '✅ Полный автокрафт завершён'); }
    catch (e) { await sendSafely(chatId, `❌ Ошибка: ${e?.message || e}`); }
  }));
});

// Список потенциально крафтимых — оставлен совместимым с вашим API
telegramBot.onText(/\/craftable/, (msg) => {
  const chatId = msg.chat.id; const bot = ensureBot(chatId); if (!bot) return;
  try { suggestCraftable(bot); } catch { sendSafely(chatId, 'ℹ️ Не удалось получить список.'); }
});

// ————————————————————————————————————————————————————————————————
// Callback‑кнопки (меню, выбор, количество, майнинг, инвентарь)
// ————————————————————————————————————————————————————————————————
telegramBot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id; const data = q.data || ''; const bot = ensureBot(chatId); if (!bot) return;
  if (rateLimited(chatId)) { try { await telegramBot.answerCallbackQuery(q.id); } catch {} return; }

  // Стоп для автокрафта/задач
  if (data === 'stop_autocraft' || data === 'stop') {
    try { cancelCraft(); } catch {}
    busyChats.delete(chatId);
    try { await telegramBot.answerCallbackQuery(q.id, { text: '🛑 Остановлено' }); } catch {}
    return;
  }

  // Главное меню «Быстрый крафт»
  if (data === 'menu:quick') {
    try {
      await editTextSafely(chatId, q.message.message_id, '🧰 Быстрый крафт: выбери категорию', { reply_markup: quickCategoriesKeyboard() });
    } finally { try { await telegramBot.answerCallbackQuery(q.id); } catch {} }
    return;
  }

  // Инвентарь: показать/обновить/сортировка
  if (data === 'inv:show' || data === 'inv:refresh' || data.startsWith('inv:sort:')) {
    const sort = data === 'inv:refresh' ? (chatState.get(chatId)?.invSort || 'count') : (data.split(':')[2] || 'count');
    chatState.set(chatId, { ...(chatState.get(chatId) || {}), invSort: sort });
    try {
      await editTextSafely(chatId, q.message.message_id, fmtInv(bot, { sort }), { reply_markup: invKeyboard(sort) });
    } catch {
      await sendSafely(chatId, fmtInv(bot, { sort }), { reply_markup: invKeyboard(sort) });
    } finally { try { await telegramBot.answerCallbackQuery(q.id); } catch {} }
    return;
  }

  // Майнинг (расширенный)
  if (data.startsWith('mine:')) {
    if (busyChats.has(chatId)) { try { await telegramBot.answerCallbackQuery(q.id, { text: '⌛ Уже идёт задача' }); } catch {} return; }
    const type = data.split(':')[1];
    const oreMap = {
      diamond: ['diamond_ore', 'deepslate_diamond_ore'],
      iron:    ['iron_ore', 'deepslate_iron_ore'],
      coal:    ['coal_ore', 'deepslate_coal_ore'],
      redstone:['redstone_ore', 'deepslate_redstone_ore'],
      gold:    ['gold_ore', 'deepslate_gold_ore'],
      lapis:   ['lapis_ore', 'deepslate_lapis_ore'],
      emerald: ['emerald_ore', 'deepslate_emerald_ore'],
      debris:  ['ancient_debris']
    };
    await withBusy(chatId, async () => withTyping(chatId, async () => {
      try { await telegramBot.answerCallbackQuery(q.id, { text: '⛏️ Ищу…' }); } catch {}
      try {
        if (typeof collectBlocksByNames === 'function') {
          await collectBlocksByNames(bot, oreMap[type] || [], 8);
        } else {
          await mineOres(bot);
        }
        await sendSafely(chatId, '✅ Готово (если поблизости были соответствующие жилы).');
      } catch (e) { await sendSafely(chatId, `❌ Не вышло: ${e?.message || e}`); }
    }));
    return;
  }

  // Открыть категорию и страницу: qc:cat:<catKey>:<page>
  if (data.startsWith('qc:cat:')) {
    const [, , catKey, pageStr] = data.split(':');
    const page = Math.max(0, parseInt(pageStr || '0', 10) || 0);
    try {
      await editTextSafely(chatId, q.message.message_id, `🗂 Категория: ${catKey}`, { reply_markup: quickItemsKeyboard(catKey, page) });
    } finally { try { await telegramBot.answerCallbackQuery(q.id); } catch {} }
    return;
  }

  // Выбор позиции (новый формат): qc:sel:<ru>
  if (data.startsWith('qc:sel:') || data.startsWith('qcsel:')) {
    const ru = data.includes('qc:sel:') ? data.split(':')[2] : data.split(':')[1];
    const def = (() => {
      for (const arr of Object.values(QUICK_CATALOG)) {
        const found = arr.find(x => x.ru === ru);
        if (found) return found.presets?.[0] || 1;
      }
      return 1;
    })();
    chatState.set(chatId, { ...(chatState.get(chatId) || {}), itemRu: ru, amount: def });
    try {
      await editTextSafely(chatId, q.message.message_id, `🔧 ${ru}: выбери количество`, { reply_markup: amountKeyboard(ru, def) });
    } finally { try { await telegramBot.answerCallbackQuery(q.id); } catch {} }
    return;
  }

  // Изменение количества: qca:<+|->:<n>:<ru>
  if (data.startsWith('qca:')) {
    const [, op, nStr, ru] = data.split(':');
    const st = chatState.get(chatId) || { itemRu: ru, amount: 1 };
    let amt = st.amount || 1; const n = Math.max(1, parseInt(nStr, 10) || 1);
    amt = op === '+' ? (amt + n) : Math.max(1, amt - n);
    st.itemRu = ru; st.amount = amt; chatState.set(chatId, st);
    try { await editMarkupSafely(chatId, q.message.message_id, amountKeyboard(ru, amt)); } catch {}
    try { await telegramBot.answerCallbackQuery(q.id); } catch {}
    return;
  }

  // Пресет количества: qcp:<preset>:<ru>
  if (data.startsWith('qcp:')) {
    const [, pStr, ru] = data.split(':');
    const p = Math.max(1, parseInt(pStr, 10) || 1);
    chatState.set(chatId, { ...(chatState.get(chatId) || {}), itemRu: ru, amount: p });
    try { await editMarkupSafely(chatId, q.message.message_id, amountKeyboard(ru, p)); } catch {}
    try { await telegramBot.answerCallbackQuery(q.id); } catch {}
    return;
  }

  // Подтверждение крафта: qcok:<ru>:<amount>
  if (data.startsWith('qcok:')) {
    const [, ru, amtStr] = data.split(':');
    const amount = Math.max(1, parseInt(amtStr, 10) || 1);
    if (busyChats.has(chatId)) { try { await telegramBot.answerCallbackQuery(q.id, { text: '⌛ Уже идёт задача' }); } catch {} return; }

    await withBusy(chatId, async () => withTyping(chatId, async () => {
      try { await telegramBot.answerCallbackQuery(q.id, { text: `🛠️ Крафчу: ${ru} ×${amount}` }); } catch {}
      try {
        if (USE_SMART.has(ru)) await smartAutoCraft(bot, ru, amount);
        else await craftItem(bot, ru, amount);
        await sendSafely(chatId, `✅ Готово: ${ru} ×${amount}`);
      } catch (e) {
        await sendSafely(chatId, `❌ Ошибка крафта (${ru}): ${e?.message || e}`);
      }
    }));
    return;
  }

  try { await telegramBot.answerCallbackQuery(q.id); } catch {}
});

module.exports = { telegramBot };
