// ===============================
// core/saver.cjs
// 💾 Сохранение и загрузка данных HelperBot
// ===============================

const fs = require('fs');
const { state } = require('./state.cjs');

const STATS_PATH = './data/botStats.json';
const WAYPOINTS_PATH = './data/waypoints.json';

// 💾 Сохранение статистики
async function saveStats() {
  try {
    await fs.promises.writeFile(STATS_PATH, JSON.stringify(state.botStats, null, 2));
    console.log('✅ Статистика сохранена');
  } catch (e) {
    console.error('❌ Ошибка сохранения статистики:', e);
  }
}

// 💾 Сохранение любых JSON
async function saveJson(path, data) {
  try {
    await fs.promises.writeFile(path, JSON.stringify(data, null, 2));
    console.log(`💾 Сохранён файл: ${path}`);
  } catch (e) {
    console.error('❌ Ошибка сохранения файла', path, e);
  }
}

// 📖 Загрузка статистики при старте
function loadStats() {
  try {
    if (fs.existsSync(STATS_PATH)) {
      const data = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
      Object.assign(state.botStats, data);
      console.log('📊 Статистика загружена');
    }
  } catch (e) {
    console.log('⚠️ Не удалось загрузить статистику:', e.message);
  }
}

// === Экспорт ===
// Aggregated saver: extend as needed to persist more data
async function saveAll() {
  try {
    await saveStats();
  } catch (e) {
    console.error('saveAll error:', e);
  }
}

module.exports = {
  saveStats,
  saveJson,
  loadStats,
  saveAll
};
