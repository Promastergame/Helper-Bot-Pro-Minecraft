'use strict';
// ===============================
// integrations/telegram.js
// Управление HelperBot через Telegram (только для владельца)
// ===============================

const { Telegraf } = require('telegraf');
const { state } = require('../core/state.cjs');
const { viewerScreenshot } = require('../core/viewer.cjs');
// Use main leveling module
const leveling = require('../features/leveling.js');
const inventory = require('../features/economy/inventory.js');
const mining = require('../features/mining/mining.js');
const { craftItem, getItemList } = require('../features/crafting/crafting.js');
const { recipes, suggestCraftable } = require('../features/crafting/smartCraft.js');
const { brewPotion, getPotionList } = require('../features/magic/brewing.js');
const { enchantmentSystem } = require('../features/magic/enchantments.js');
const { smartAutoCraft, fullAutoCraft, cancelCraft } = require('../features/crafting/autoCrafter.js');
const { goToWaypoint, setWaypoint, listWaypoints, deleteWaypoint } = require('../features/waypoints.cjs');
const { buildSmallHouse } = require('../features/building/building.js');
const { smeltAll } = require('../features/building/smelting.js');
const { saveStats } = require('../core/saver.cjs');
const { getBot } = require('../core/state.cjs');
// moved-up imports above
const fs = require('fs');
const path = require('path');
const xp = require('../features/ai/experience.cjs');

// === Переменные окружения ===
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const OWNER_ID = process.env.OWNER_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';

let tg = null;

function setupTelegram() {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log('ℹ️ Telegram не настроен');
    return;
  }
  if (tg) return;

  try {
    tg = new Telegraf(TG_TOKEN);

    // === Команды ===
    tg.command('help', (ctx) => {
  const helpText = [
    '📜 Помощь',
    'Слэш‑команды (важные):',
    '/screen — скрин экрана',
    '/stats — показать статистику',
    '/exportstats — экспорт JSON статистики',
    '/xpstats — отчёт по боям',
    '/xpexport — экспорт опыта',
    '/cheats — включить/выключить читы (владелец)',
    '/status — статус и HP',
    '/reboot — перезапустить бота (владелец)',
    '/reset <пароль> — сброс прогресса (владелец)',
    '/listpoints — список точек',
    '/delpoint <имя> — удалить точку',
    '',
    'Текстовые команды (если включено в .env):',
    'Обращение: “бот …” | “ботик …” | “помощник …” | “хай …”',
    'Перемещение: “подойди”, “следуй вкл|выкл”, “иди <точка>”',
    'Крафт: “крафт <предмет> [xN]”, “умный крафт <предмет|всё>”, “что могу”',
    'Добыча: “майни руды”, “руби деревья”, “собери <ресурс> [xN]”',
    'Инвентарь/сундук: “инв”, “выкинь <что> [xN]”, “сложи всё”, “забери <id…> [xN]”',
    'Точки: “точка <имя>”, “иди <имя>”, “удали точку <имя>”',
    'Строительство/плавка: “построй дом [S H]”, “переплавь всё”',
    'Зелья: “зелья”, “свари <название>”',
    'Зачарование: “зачар список <тип>”, “зачар план <тип>”, “зачар авто <тип>”, “зачар <тип> <ench> <lvl>”, “наковальня <рецепт> <тип>”',
    'Служебные: “скажи <текст>”, “вьювер вкл|выкл”, “стоп”, “помощь”',
    '',
    'Настройки .env: COMMANDS_INPUT, TG_TEXT_COMMANDS, CHAT_MENTION_WORDS, CHAT_REQUIRE_MENTION, CHAT_PREFIX'
  ].join('\n');
  return ctx.reply(helpText);
});

    // === Команда: XP-статистика (боевой опыт) ===
    tg.command('xpstats', async (ctx) => {
      try {
        const top = xp.reportTop({ type: 'combat', topN: 8 });
        if (!top || top.length === 0) return ctx.reply('📭 Ещё нет данных опыта. Сразись с кем-нибудь!');

        const lines = top.map((r, i) => {
          const rate = Math.round(r.successRate * 100);
          const name = r.key.replace(/^combat:/, '').split('|')[0];
          const when = new Date(r.lastAt || Date.now()).toLocaleString();
          return `${i+1}. ${name} — ${rate}% (попыток: ${r.tries}) • ${when}`;
        });

        const header = '📊 Опыт боёв (топ):\n';
        await ctx.reply(header + lines.join('\n'));
      } catch (e) {
        await ctx.reply('❌ Ошибка XP-статистики: ' + e.message);
      }
    });

    // === Команда: экспорт файла опыта ===
    tg.command('xpexport', async (ctx) => {
      try {
        const file = path.join(process.cwd(), 'data', 'experience.json');
        if (!fs.existsSync(file)) return ctx.reply('📭 Нет файла опыта (ещё не накоплен).');
        await ctx.replyWithDocument({ source: file, filename: 'experience.json' });
      } catch (e) {
        await ctx.reply('❌ Не удалось выгрузить опыт: ' + e.message);
      }
    });

    // === Скриншот ===
    tg.command('screen', async (ctx) => {
      try {
        const port = Number(process.env.VIEWER_PORT || 3007);
        console.log(`📸 Пытаюсь сделать скриншот с порта ${port}...`);
        
        const buf = await viewerScreenshot(port);
        if (buf) {
          await ctx.replyWithPhoto(
            { source: Buffer.from(buf) }, 
            { caption: '📸 Скриншот от HelperBot' }
          );
        } else {
          await ctx.reply('❌ Не удалось сделать скриншот. Viewer не запущен?');
        }
      } catch (e) {
        console.error('❌ Ошибка скриншота:', e);
        await ctx.reply('❌ Не удалось сделать скриншот: ' + e.message);
      }
    });

    // === Статистика ===
    tg.command('stats', (ctx) => {
      try {
        const stats = leveling.showStats();
        ctx.reply(stats);
      } catch (e) {
        ctx.reply('❌ Ошибка получения статистики: ' + e.message);
      }
    });

    // === Выгрузка статистики в файл ===
    tg.command('exportstats', async (ctx) => {
      try {
        const statsJSON = JSON.stringify(state.botStats || {}, null, 2);
        await ctx.replyWithDocument({
          source: Buffer.from(statsJSON),
          filename: 'botStats.json'
        });
      } catch (e) {
        await ctx.reply('❌ Не удалось выгрузить статистику: ' + e.message);
      }
    });

    // === Статус ===
    tg.command('status', (ctx) => {
      const bot = getBot();
      if (!bot || !bot.entity) {
        return ctx.reply('🤖 Бот ещё не готов или отключен.');
      }
      
      const pos = bot.entity.position;
      const statusText = `🤖 Статус HelperBot:
📍 Позиция: ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}
❤️ Здоровье: ${bot.health || 0}/20
🍖 Еда: ${bot.food || 0}/20
🎯 Уровень: ${state.botStats?.level || 1}
⭐ Опыт: ${state.botStats?.exp || 0}`;

      ctx.reply(statusText);
    });

    // === Читы (только владелец) ===
    tg.command('cheats', async (ctx) => {
      if (String(ctx.from.id) !== String(OWNER_ID)) {
        return ctx.reply('⛔ Только владелец может использовать эту команду');
      }
      
      state.cheatsEnabled = !state.cheatsEnabled;
      await ctx.reply(`⚡ Режим читов: ${state.cheatsEnabled ? 'ВКЛЮЧЕН' : 'ВЫКЛЮЧЕН'}`);
      
      const bot = getBot();
      if (bot && bot.chat) {
        bot.chat(`⚡ Админ ${state.cheatsEnabled ? 'включил' : 'выключил'} читы через Telegram!`);
      }
    });

    // === Перезапуск ===
    tg.command('reboot', async (ctx) => {
      if (String(ctx.from.id) !== String(OWNER_ID)) {
        return ctx.reply('⛔ Только владелец может использовать эту команду');
      }
      
      await ctx.reply('🔄 Перезапуск бота...');
      try { 
        const bot = getBot();
        if (bot) bot.end('Перезапуск по команде из Telegram');
      } catch (e) {
        console.log('Ошибка при перезапуске:', e.message);
      }
    });

    // === Полный сброс ===
    tg.command('reset', async (ctx) => {
      if (String(ctx.from.id) !== String(OWNER_ID)) {
        return ctx.reply('⛔ Только владелец может использовать эту команду');
      }
      
      const parts = ctx.message.text.split(/\s+/);
      const pass = parts[1] || '';
      
      if (pass !== ADMIN_PASSWORD) {
        return ctx.reply('❌ Неверный пароль для сброса');
      }

      try {
        // Сброс статистики
        state.botStats = {
          level: 1,
          exp: 0,
          blocksMined: 0,
          mobsKilled: {},
          cropsHarvested: 0,
          itemsCrafted: 0,
          housesBuilt: 0,
          unlockedAbilities: []
        };

        // Сброс точек
        if (fs.existsSync('./data/waypoints.json')) {
          fs.writeFileSync('./data/waypoints.json', '{}');
        }

        await saveStats();
        await ctx.reply('✅ Сброс завершён. Перезапускаюсь...');
        
        // Перезапуск бота
        const bot = getBot();
        if (bot) bot.end('Сброс по команде из Telegram');
        
      } catch (e) {
        ctx.reply('❌ Ошибка сброса: ' + e.message);
      }
    });

    // === Список точек ===
    tg.command('listpoints', async (ctx) => {
      if (String(ctx.from.id) !== String(OWNER_ID)) {
        return ctx.reply('⛔ Только влалелец может использовать эту команду');
      }
      
      try {
        const points = listWaypoints();
        if (!points || Object.keys(points).length === 0) {
          return ctx.reply('📭 Нет сохранённых точек');
        }
        
        const pointsList = Object.keys(points)
          .map(name => `📍 ${name}`)
          .join('\n');
        
        ctx.reply(`📍 Сохранённые точки:\n${pointsList}`);
      } catch (e) {
        ctx.reply('❌ Ошибка получения точек: ' + e.message);
      }
    });

    // === Удаление точки ===
    tg.command('delpoint', async (ctx) => {
      if (String(ctx.from.id) !== String(OWNER_ID)) {
        return ctx.reply('⛔ Только владелец может использовать эту команду');
      }
      
      const parts = ctx.message.text.split(/\s+/);
      if (parts.length < 2) {
        return ctx.reply('❌ Укажите имя точки: /delpoint <имя>');
      }
      
      const pointName = parts[1];
      try {
        const success = deleteWaypoint(pointName);
        if (success) {
          ctx.reply(`✅ Точка "${pointName}" удалена`);
        } else {
          ctx.reply(`❌ Точка "${pointName}" не найдена`);
        }
      } catch (e) {
        ctx.reply('❌ Ошибка удаления точки: ' + e.message);
      }
    });

    // ==== Текстовые команды без слэша (если разрешено в .env) ====
    const TG_TEXT_COMMANDS = String(process.env.TG_TEXT_COMMANDS ?? 'true') !== 'false';
    const MENTION_WORDS = String(process.env.CHAT_MENTION_WORDS || 'бот,ботик,помощник,хай')
      .split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    if (TG_TEXT_COMMANDS) {
      // Узкоспециализированные текстовые команды (дополнение)
      tg.hears(/^(что могу|предметы|итемы|рецепты|майни ру|руби дерев|собери|зелья|свари|материалы).*/i, async (ctx) => {
        try {
          const bot = getBot(); if (!bot) return ctx.reply('🤖 Бот ещё не готов.');
          const textRaw = String(ctx.message?.text || '').trim();
          const low = textRaw.toLowerCase();
          const words = String(process.env.CHAT_MENTION_WORDS || 'бот,ботик,помощник,хай').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
          let cmd = textRaw; const hit = words.find(w => low.startsWith(w + ' ')); if (hit) cmd = textRaw.slice(hit.length).trim();
          const normalize = (s) => s.replace(/\s+/g,' ').trim();
          const clampInt = (n,min,max)=>{ const v=parseInt(n,10); return Number.isNaN(v)?min:Math.max(min,Math.min(max,v)); };

          let m;
          if (/^что\s+могу$/.test(cmd)) { const have = suggestCraftable(bot)||[]; return ctx.reply(have.length?('🧰 Могу: '+have.slice(0,18).join(', ')+ (have.length>18?` …+${have.length-18}`:'')):'⚠️ Нечего крафтить'); }
          if (/^(предметы|итемы)$/.test(cmd)) { return ctx.reply(String(getItemList())); }
          if (/^рецепты$/.test(cmd)) { const names=Object.keys(recipes||{}); return ctx.reply(names.length?('📘 Рецепты: '+names.slice(0,44).join(', ')+ (names.length>44?` …+${names.length-44}`:'')):'⚠️ Нет рецептов'); }
          if (/^материалы$/.test(cmd)) { return ctx.reply('📚 Справочник ресурсов — смотри в игре командой «материалы».'); }
          if (/^майни\s+руды$/.test(cmd)) { await mining.mineOres(bot, 18); return ctx.reply('⛏️ Ищу руды…'); }
          if (/^руби\s+деревья$/.test(cmd)) { await mining.chopWood(bot, 24); return ctx.reply('🪓 Рублю деревья…'); }
          if ((m = cmd.match(/^собери\s+(.+)$/))) { const tail = normalize(m[1]); const mm=tail.match(/\s*x\s*(\d+)\s*$/); const name=mm?tail.slice(0,mm.index).trim():tail; const cnt=clampInt(mm?mm[1]:16,4,64); await mining.collectBlocksByNames?.(bot, [name], cnt); return ctx.reply('📦 Собираю ресурсы…'); }
          if (/^зелья$/.test(cmd)) { return ctx.reply(String(getPotionList())); }
          if ((m = cmd.match(/^свари\s+(.+)$/))) { await brewPotion(bot, normalize(m[1])); return ctx.reply('🧪 Варю зелье'); }
        } catch (e) { try { await ctx.reply('⚠️ Ошибка: ' + (e?.message || e)); } catch {} }
      });

      tg.hears(/^[^\/].*/s, async (ctx) => {
        try {
          const bot = getBot();
          if (!bot) return ctx.reply('🤖 Бот ещё не готов.');
          const textRaw = String(ctx.message?.text || '').trim();
          if (!textRaw) return;
          const low = textRaw.toLowerCase();
          const requireMention = String(process.env.CHAT_REQUIRE_MENTION ?? 'true') !== 'false';
          const hit = MENTION_WORDS.find(w => low.startsWith(w + ' '));
          if (requireMention && !hit) return; // пропустим случайные фразы
          let cmd = hit ? textRaw.slice(hit.length).trim() : textRaw;

          const normalize = (s) => s.replace(/\s+/g,' ').trim();
          const clampInt = (n,min,max)=>{ const v=parseInt(n,10); return Number.isNaN(v)?min:Math.max(min,Math.min(max,v)); };

          // помощь
          if (/^(помощь|help|\?)$/.test(cmd)) {
            return ctx.reply('📜 Примеры: стоп | подойди | следуй вкл|выкл | скажи <текст> | вьювер вкл|выкл | крафт <что> [xN] | умный крафт <что|всё> | фарм | автофарм [вкл|выкл] [сек] | выкинь <что> [xN] | сложи всё | забери <id…> [xN] | инв | материалы | точка <имя> | иди <имя> | удали точку <имя> | построй дом [S H] | переплавь всё');
          }
          // стоп
          if (/^стоп$/.test(cmd)) { try { cancelCraft(); } catch {} try { bot.pathfinder?.setGoal?.(null); } catch {} return ctx.reply('🛑 Остановил автозадачу/движение.'); }
          // следование
          let m;
          if ((m = cmd.match(/^(?:следуй|иди за мной)\s+(вкл|выкл)$/))) {
            const on = m[1] === 'вкл'; state.isFollowing = on;
            const possible = Object.keys(bot.players||{}).find(p=>p && p.toLowerCase()!==bot.username?.toLowerCase());
            state.followTarget = on ? possible : null;
            return ctx.reply(`🚶 Режим следования: ${on?'ВКЛ':'ВЫКЛ'}`);
          }
          // подойди
          if (/^(подойди|иди ко мне|сюда)(?:\s|$)/.test(cmd)) {
            try {
              const mc = require('minecraft-data')(bot.version);
              const { Movements, goals } = require('mineflayer-pathfinder');
              const mv = new Movements(bot, mc); mv.allowSprinting = true; mv.canDig = false;
              bot.pathfinder.setMovements(mv);
              const targetName = Object.keys(bot.players || {}).find(p => p && p.toLowerCase() !== bot.username?.toLowerCase());
              const target = Object.values(bot.entities).find(e => e.type==='player' && e.username===targetName);
              if (!target) return ctx.reply('❓ Не вижу игрока.');
              await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1));
              return ctx.reply('✅ Подошёл.');
            } catch { return ctx.reply('⚠️ Не удалось подойти.'); }
          }
          // скажи
          if ((m = cmd.match(/^скажи\s+(.+)$/))) { try { bot.chat(m[1]); } catch {} return ctx.reply('💬 Отправлено.'); }
          // вьювер
          if ((m = cmd.match(/^(?:вьювер|viewer)\s+(вкл|выкл)$/))) {
            if (m[1] === 'вкл') { try { const { mineflayer: viewer } = require('prismarine-viewer'); const port=+(process.env.VIEWER_PORT||3007); viewer(bot,{port,viewDistance:4}); return ctx.reply(`🖥️ Viewer на порту ${port}`);} catch { return ctx.reply('⚠️ Не удалось запустить viewer.'); } }
            else return ctx.reply('ℹ️ Отключение viewer недоступно (нужен рестарт).');
          }
          // крафт
          if ((m = cmd.match(/^(?:крафт|скрафт(?:и|ь)?)\s+([^x×\n]+?)(?:\s*[x×]\s*(\d+))?\s*$/i))) {
            const name = normalize(m[1]); const cnt = clampInt(m[2] || 1, 1, 64);
            for (let i=0;i<cnt;i++) await craftItem(bot, name);
            return ctx.reply(`🛠️ Крафт: ${name} ×${cnt}`);
          }
          if ((m = cmd.match(/^умный\s+крафт\s+(все|всё|all)$/))) { await fullAutoCraft(bot); return ctx.reply('🔧 Умный автокрафт: всё'); }
          if ((m = cmd.match(/^умный\s+крафт\s+(.+)$/))) { const name = normalize(m[1]); await smartAutoCraft(bot, name); return ctx.reply(`🔧 Умный крафт: ${name}`); }
          // фарм/автофарм
          if (/^фарм$/.test(cmd)) { await inventory.autoFarm(bot, { radius: 10, replant: true }); return ctx.reply('🌾 Фарм…'); }
          if ((m = cmd.match(/^автофарм(?:\s+(вкл|выкл))?(?:\s+(\d+))?$/))) { const on=(m[1]?m[1]==='вкл':true); const sec=clampInt(m[2]||20,5,600); state.autoFarm=on; state.autoFarmPeriod=sec; return ctx.reply(`🌾 Автофарм: ${on?'ВКЛ':'ВЫКЛ'} (~${sec}с)`); }
          // инвентарь/сундук
          if (/^(инв|инвентарь|рюкзак)$/.test(cmd)) { const items=bot.inventory.items(); const summary=items.reduce((a,i)=>(a[i.name]=(a[i.name]||0)+i.count,a),{}); const text=Object.entries(summary).slice(0,18).map(([n,c])=>`${n}:${c}`).join(', '); return ctx.reply(`📦 Инвентарь: ${text||'пусто'}`); }
          if ((m = cmd.match(/^(?:выкинь|скинь)\s+(.+)$/))) { const tail=normalize(m[1]); const mm=tail.match(/\s*x\s*(\d+)\s*$/); const name = mm?tail.slice(0,mm.index).trim():tail; const cnt=clampInt(mm?mm[1]:1,1,640); await inventory.dropSomething(bot, name, cnt); return ctx.reply('🧹 Выкинул.'); }
          if (/^(?:сложи всё|сложи все|всё в сундук|все в сундук)$/.test(cmd)) { await inventory.storeToChest(bot, { include: null, exclude: null, keepHotbar: true }); return ctx.reply('📦 Сложил в сундук'); }
          // точки
          if ((m = cmd.match(/^точка\s+(.+)$/))) { await setWaypoint(bot, normalize(m[1])); return ctx.reply('📍 Точка сохранена'); }
          if ((m = cmd.match(/^иди\s+(.+)$/))) { await goToWaypoint(bot, normalize(m[1])); return ctx.reply('➡️ Иду к точке'); }
          if ((m = cmd.match(/^удали\s+точку\s+(.+)$/))) { await deleteWaypoint(bot, normalize(m[1])); return ctx.reply('🗑️ Точка удалена'); }
          // строительство и плавка
          if ((m = cmd.match(/^построй\s+дом(?:\s+(\d+))?(?:\s+(\d+))?$/))) { const s=clampInt(m[1]||5,3,16); const h=clampInt(m[2]||4,3,12); await buildSmallHouse(bot,{size:s,height:h}); return ctx.reply('🏠 Построено'); }
          if (/^переплавь\s+всё$/.test(cmd)) { await smeltAll(bot); return ctx.reply('🔥 Переплавляю всё возможное'); }

        } catch (e) {
          try { await ctx.reply('⚠️ Ошибка: ' + (e?.message || e)); } catch {}
        }
      });
    }

    tg.launch().then(() => {
      console.log('✅ Telegram бот запущен');
    }).catch(err => {
      console.log('❌ Ошибка запуска Telegram бота:', err.message);
    });

  } catch (error) {
    console.log('❌ Ошибка настройки Telegram:', error.message);
  }
}

// === Утилиты для отправки сообщений из других модулей ===
const sendToTelegram = {
  async text(msg) {
    if (!tg || !TG_CHAT_ID) {
      console.log('📡 Telegram не настроен для отправки:', msg);
      return;
    }
    try { 
      await tg.telegram.sendMessage(TG_CHAT_ID, msg); 
    } catch (e) {
      console.log('❌ Ошибка отправки в Telegram:', e.message);
    }
  },
  
  async photo(buffer, caption = '') {
    if (!tg || !TG_CHAT_ID) return;
    try { 
      await tg.telegram.sendPhoto(
        TG_CHAT_ID, 
        { source: Buffer.from(buffer) }, 
        { caption }
      ); 
    } catch (e) {
      console.log('❌ Ошибка отправки фото в Telegram:', e.message);
    }
  }
};

module.exports = { setupTelegram, sendToTelegram };

