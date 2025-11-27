// core/plugins.cjs
'use strict';

/**
 * Автозагрузка AI-агентов из features/ai/agents
 * Подключает каждый .cjs модуль как bot.skills[<имя>]
 *
 * Поддерживает:
 *  - try/catch на каждом модуле (не падает целиком)
 *  - фильтрацию директорий
 *  - проверку, что экспорт — функция
 *  - логирование
 */

const fs = require('fs');
const path = require('path');

function loadSkills(bot) {
  const skillsDir = path.join(__dirname, '../features/ai/agents');

  // если директории нет — не ломаемся
  if (!fs.existsSync(skillsDir)) {
    console.warn('[plugins] ⚠ Папка с навыками не найдена:', skillsDir);
    return;
  }

  const files = fs.readdirSync(skillsDir);
  bot.skills = bot.skills || {};

  for (const f of files) {
    const full = path.join(skillsDir, f);

    // пропуск директорий
    const stat = fs.statSync(full);
    if (!stat.isFile()) continue;

    // нужны только .cjs
    if (!f.endsWith('.cjs')) continue;

    try {
      const mod = require(full);

      if (typeof mod !== 'function') {
        console.warn(`[plugins] ⚠ Модуль ${f} не экспортирует функцию — пропуск`);
        continue;
      }

      const instance = mod(bot);

      if (!instance || typeof instance !== 'object') {
        console.warn(`[plugins] ⚠ ${f} вернул некорректный объект`);
        continue;
      }

      const name = f.replace(/\.cjs$/,'');
      bot.skills[name] = instance;

      console.log(`[plugins] ✅ Loaded ${name}`);
    }
    catch (err) {
      console.error(`[plugins] ❌ Failed ${f}`);
      console.error('Reason:', err.stack || err.message);
    }
  }

  console.log(`[plugins] 🎮 Skills loaded: ${Object.keys(bot.skills).join(', ')}`);
}

module.exports = { loadSkills };
