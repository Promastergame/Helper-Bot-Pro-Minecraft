const { Vec3 } = require('vec3');
const { Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');
const mcDataLoader = require('minecraft-data');

function makeWoodcutter(bot) {
  const state = {
    active: false,
    targetTree: null,
    logType: "oak_log",
    searchRadius: 32
  };

  async function start() {
    if (state.active) return;
    state.active = true;
    bot.chat("🪓 Лесоруб включён");
    loop();
  }

  function stop() {
    state.active = false;
    bot.pathfinder.setGoal(null);
    bot.chat("❌ Лесоруб выключен");
  }

  async function loop() {
    const mcData = mcDataLoader(bot.version);
    const movements = new Movements(bot, mcData);

    while (state.active) {
      if (!state.targetTree) {
        state.targetTree = findTree();
        if (!state.targetTree) {
          bot.chat("🌲 Нет деревьев, ищу...");
          await wait(1500);
          continue;
        }
      }

      bot.pathfinder.setMovements(movements);
      bot.chat("👣 Иду к дереву...");

      try {
        await bot.pathfinder.goto(
          new GoalNear(state.targetTree.x, state.targetTree.y, state.targetTree.z, 2)
        );
      } catch {}

      // Пока только подход — без копания
      bot.chat("📍 На месте, жду...");
      await wait(2000);

      state.targetTree = null;
    }
  }

  function findTree() {
    const logs = bot.findBlocks({
      matching: (block) => block && block.name === state.logType,
      maxDistance: state.searchRadius,
      count: 50
    });

    if (!logs.length) return null;

    logs.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
    const p = logs[0];
    return new Vec3(p.x, p.y, p.z);
  }

  function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  return { start, stop };
}

module.exports = makeWoodcutter;
