// ===============================
// core/viewer.cjs
// 👁️ Визуализация и скриншоты мира HelperBot
// ===============================

const { MineflayerViewer } = require('prismarine-viewer').mineflayer;
const http = require('http');

let viewerServer = null;
let isViewerRunning = false;

// === Запуск 3D Viewer ===
function startViewer(bot, port = 3007) {
  try {
    if (isViewerRunning) {
      console.log('⚠️ Viewer уже запущен');
      return true;
    }

    MineflayerViewer(bot, { 
      port, 
      firstPerson: false, 
      width: 800, 
      height: 600 
    });
    
    isViewerRunning = true;
    console.log(`✅ Viewer запущен на http://localhost:${port}`);
    return true;
  } catch (e) {
    console.error('❌ Ошибка запуска Viewer:', e.message);
    return false;
  }
}

// === Скриншот мира ===
async function viewerScreenshot(port = 3007) {
  if (!isViewerRunning) {
    throw new Error('Viewer не запущен');
  }

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: port,
      path: '/screenshot',
      method: 'GET',
      timeout: 10000
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer);
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Ошибка запроса скриншота: ${err.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Таймаут запроса скриншота'));
    });

    req.end();
  });
}

// === Остановка Viewer ===
function stopViewer() {
  if (viewerServer) {
    viewerServer.close();
    viewerServer = null;
  }
  isViewerRunning = false;
  console.log('👁️ Viewer остановлен');
}

// === Экспорт ===
module.exports = {
  startViewer,
  viewerScreenshot,
  stopViewer
};