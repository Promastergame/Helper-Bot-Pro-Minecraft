// ===============================
// features/structureExplorer.js
// Система исследования структур Minecraft
// ===============================

const {  state, enqueue  } = require('../../core/state.cjs');
const {  Vec3  } = require('vec3');

class StructureExplorer {
  constructor() {
    this.structures = new Map();
    this.activeExplorations = new Map();
    this.loadStructures();
  }

  // -------------------------------
  // Загрузка списка известных структур
  // -------------------------------
  loadStructures() {
    this.structures.set('mineshaft', {
      id: 'mineshaft',
      name: 'Заброшенная шахта',
      type: 'underground',
      difficulty: 'medium',
      characteristicBlocks: ['rail', 'oak_planks', 'cobweb', 'chest'],
      commonMobs: ['zombie', 'skeleton', 'spider', 'cave_spider'],
      rewards: {
        common: ['rail', 'gold_ingot', 'iron_ingot', 'coal'],
        rare: ['diamond', 'emerald', 'enchanted_book'],
        special: 'minecart'
      },
      explorationTime: 600000,
      dangerLevel: 0.6
    });

    this.structures.set('village', {
      id: 'village',
      name: 'Деревня',
      type: 'surface',
      difficulty: 'easy',
      characteristicBlocks: ['oak_door', 'farmland', 'hay_block', 'chest'],
      commonMobs: ['iron_golem', 'villager'],
      rewards: {
        common: ['wheat', 'carrot', 'potato', 'bread'],
        rare: ['emerald', 'iron_ingot'],
        special: 'trading_access'
      },
      explorationTime: 300000,
      dangerLevel: 0.1
    });

    this.structures.set('desert_temple', {
      id: 'desert_temple',
      name: 'Пустынный храм',
      type: 'surface',
      difficulty: 'medium',
      characteristicBlocks: ['sandstone', 'terracotta', 'blue_terracotta', 'tnt'],
      commonMobs: ['husk', 'spider'],
      rewards: {
        common: ['gold_ingot', 'iron_ingot', 'rotten_flesh', 'bone'],
        rare: ['diamond', 'emerald', 'enchanted_book'],
        special: 'temple_treasure'
      },
      explorationTime: 480000,
      dangerLevel: 0.4
    });

    this.structures.set('nether_fortress', {
      id: 'nether_fortress',
      name: 'Крепость Незера',
      type: 'nether',
      difficulty: 'hard',
      characteristicBlocks: ['nether_brick', 'nether_brick_fence', 'nether_brick_stairs'],
      commonMobs: ['blaze', 'wither_skeleton', 'magma_cube'],
      rewards: {
        common: ['blaze_rod', 'nether_wart', 'coal'],
        rare: ['netherite_scrap', 'ghast_tear'],
        special: 'nether_travel'
      },
      explorationTime: 900000,
      dangerLevel: 0.8
    });

    this.structures.set('ocean_monument', {
      id: 'ocean_monument',
      name: 'Океанский памятник',
      type: 'underwater',
      difficulty: 'hard',
      characteristicBlocks: ['prismarine', 'sea_lantern', 'dark_prismarine'],
      commonMobs: ['guardian', 'elder_guardian'],
      rewards: {
        common: ['prismarine_shard', 'prismarine_crystals'],
        rare: ['gold_block', 'sponge'],
        special: 'ocean_explorer'
      },
      explorationTime: 1200000,
      dangerLevel: 0.7
    });

    this.structures.set('stronghold', {
      id: 'stronghold',
      name: 'Крепость',
      type: 'underground',
      difficulty: 'hard',
      characteristicBlocks: ['stone_bricks', 'iron_bars', 'end_portal_frame', 'chest'],
      commonMobs: ['silverfish', 'zombie', 'skeleton'],
      rewards: {
        common: ['iron_ingot', 'gold_ingot', 'diamond'],
        rare: ['ender_pearl', 'eye_of_ender', 'enchanted_book'],
        special: 'end_access'
      },
      explorationTime: 900000,
      dangerLevel: 0.5
    });

    this.structures.set('woodland_mansion', {
      id: 'woodland_mansion',
      name: 'Лесной особняк',
      type: 'surface',
      difficulty: 'hard',
      characteristicBlocks: ['dark_oak_planks', 'cobblestone', 'chest'],
      commonMobs: ['evoker', 'vindicator', 'witch'],
      rewards: {
        common: ['emerald', 'iron_ingot', 'gold_ingot'],
        rare: ['totem_of_undying', 'enchanted_book'],
        special: 'illager_hunter'
      },
      explorationTime: 1200000,
      dangerLevel: 0.9
    });

    this.structures.set('bastion_remnant', {
      id: 'bastion_remnant',
      name: 'Бастион',
      type: 'nether',
      difficulty: 'expert',
      characteristicBlocks: ['blackstone', 'gilded_blackstone', 'chest'],
      commonMobs: ['piglin', 'piglin_brute', 'magma_cube'],
      rewards: {
        common: ['gold_ingot', 'ancient_debris'],
        rare: ['netherite_upgrade_smithing_template', 'enchanted_golden_apple'],
        special: 'netherite_master'
      },
      explorationTime: 900000,
      dangerLevel: 0.8
    });
  }

  // -------------------------------
  // Начало исследования структуры
  // -------------------------------
  async exploreStructure(bot, structureId) {
    return new Promise((resolve, reject) => {
      enqueue(async () => {
        try {
          const structure = this.structures.get(structureId);
          if (!structure) return reject(new Error(`Структура не найдена: ${structureId}`));

          if (!this.isReadyForStructure(bot, structure)) {
            return reject(new Error(`Недостаточно подготовки для ${structure.name}`));
          }

          const structureLocation = await this.findStructure(bot, structure);
          if (!structureLocation)
            return reject(new Error(`Не удалось найти ${structure.name} поблизости.`));

          const exploration = {
            ...structure,
            startTime: Date.now(),
            location: structureLocation,
            chestsFound: 0,
            mobsKilled: 0,
            resourcesCollected: 0,
            exploredPercent: 0,
            completed: false
          };

          this.activeExplorations.set(bot.username, exploration);

          bot.chat(`🏔️ Начинаю исследование: ${structure.name}`);
          bot.chat(`📍 Тип: ${this.getTypeText(structure.type)}, ⚡ Сложность: ${this.getDifficultyText(structure.difficulty)}`);
          bot.chat(`⏱️ Примерное время: ${structure.explorationTime / 60000} мин`);

          const result = await this.performExploration(bot, exploration);
          resolve(result);

        } catch (error) {
          reject(error);
        }
      }, 'structure_exploration');
    });
  }

  async findStructure(bot, structure) {
    const blocks = bot.findBlocks({
      matching: (block) => block?.name && structure.characteristicBlocks.includes(block.name),
      maxDistance: 100,
      count: 5
    });
    return blocks.length ? blocks[0] : null;
  }

  isReadyForStructure(bot, structure) {
    const inv = bot.inventory.items();
    const hasWeapon = inv.some(i => i.name.endsWith('_sword') || i.name.endsWith('_axe'));
    if (!hasWeapon && structure.dangerLevel > 0.3) {
      bot.chat('❌ Нужно оружие!');
      return false;
    }

    if (structure.type === 'underwater') {
      const hasPotion = inv.some(i => i.name === 'potion' && i.nbt?.value?.Potion?.value === 'water_breathing');
      if (!hasPotion) {
        bot.chat('❌ Нужны зелья подводного дыхания!');
        return false;
      }
    }

    if (structure.type === 'nether') {
      const fireRes = inv.some(i => i.name === 'potion' && i.nbt?.value?.Potion?.value === 'fire_resistance');
      if (!fireRes) {
        bot.chat('❌ Для Незера нужно зелье огнестойкости!');
        return false;
      }
    }

    const armor = inv.filter(i => /_helmet|_chestplate|_leggings|_boots/.test(i.name)).length;
    if (armor < 2 && structure.dangerLevel > 0.5) {
      bot.chat('❌ Нужно больше брони!');
      return false;
    }

    const food = inv.filter(i => /cooked_|bread|apple/.test(i.name)).reduce((a, b) => a + b.count, 0);
    if (food < 10 && structure.explorationTime > 600000) {
      bot.chat('❌ Возьмите побольше еды!');
      return false;
    }
    return true;
  }

  getTypeText(type) {
    const t = { surface: 'Наземная', underground: 'Подземная', nether: 'Незер', underwater: 'Подводная' };
    return t[type] || type;
  }

  getDifficultyText(d) {
    const diff = { easy: 'Лёгкая', medium: 'Средняя', hard: 'Сложная', expert: 'Эксперт' };
    return diff[d] || d;
  }

  async performExploration(bot, exploration) {
    const { goals } = await import('mineflayer-pathfinder');
    bot.pathfinder.setGoal(new goals.GoalNear(exploration.location.x, exploration.location.y, exploration.location.z, 10));
    bot.chat('🗺️ Иду к структуре...');

    await new Promise(r => setTimeout(r, 5000));

    let progress = 0;
    while (progress < 100 && bot.health > 0) {
      const ch = await this.searchForChests(bot, exploration);
      const res = await this.collectResources(bot, exploration);
      const mobs = await this.clearMobs(bot, exploration);

      progress = Math.min(100, progress + 10 + ch * 5 + res * 2 + mobs * 3);
      exploration.exploredPercent = progress;

      bot.chat(`📊 Прогресс: ${progress}%`);
      await new Promise(r => setTimeout(r, 3000));
    }

    return await this.completeExploration(bot, exploration);
  }

  async searchForChests(bot, exploration) {
    const chests = bot.findBlocks({
      matching: b => b?.name === 'chest',
      maxDistance: 15,
      count: 10
    });
    let found = 0;

    for (const pos of chests) {
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (exploration.openedChests?.includes(key)) continue;

      bot.chat('📦 Нашёл сундук!');
      const { goals } = await import('mineflayer-pathfinder');
      bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
      await new Promise(r => setTimeout(r, 2000));

      const loot = this.generateLoot(exploration);
      bot.chat(`💎 Лут: ${loot.join(', ')}`);
      found++;
      exploration.openedChests = exploration.openedChests || [];
      exploration.openedChests.push(key);

      const { addExp } = await import('../leveling.js');
      addExp(25, `сундук в ${exploration.name}`);
    }
    return found;
  }

  async collectResources(bot, exploration) {
    let count = 0;
    for (const blockName of exploration.characteristicBlocks) {
      if (blockName === 'chest') continue;
      const blocks = bot.findBlocks({
        matching: b => b?.name === blockName,
        maxDistance: 10,
        count: 3
      });
      for (const pos of blocks) {
        const block = bot.blockAt(pos);
        if (!block || block.name === 'air') continue;
        try {
          if (block.name === 'tnt' && exploration.id === 'desert_temple') {
            bot.chat('💣 Осторожно, TNT!');
            continue;
          }
          await bot.dig(block);
          count++;
          const { addExp } = await import('../leveling.js');
          addExp(2, `добыча ${blockName}`);
        } catch {}
      }
    }
    if (count > 0) bot.chat(`⛏️ Собрано ${count} блоков`);
    return count;
  }

  async clearMobs(bot, exploration) {
    let killed = 0;
    const mobs = Object.values(bot.entities).filter(
      e => e.type === 'mob' && exploration.commonMobs.includes(e.name) &&
      e.position.distanceTo(bot.entity.position) < 15
    );

    for (const mob of mobs) {
      if (!mob.isValid) continue;
      bot.chat(`⚔️ Сражаюсь с ${this.getMobName(mob.name)}...`);
      const { combatManager } = await import('../combat/advancedCombat.js');
      await combatManager.engageCombat(bot, mob);

      await new Promise(res => {
        const t = setInterval(() => {
          if (!mob.isValid) {
            clearInterval(t);
            killed++;
            res();
          }
        }, 1000);
        setTimeout(() => clearInterval(t), 15000);
      });
      const { addExp } = await import('../leveling.js');
      addExp(15, `бой в ${exploration.name}`);
    }
    if (killed) bot.chat(`👹 Убито мобов: ${killed}`);
    return killed;
  }

  getMobName(id) {
    const n = {
      zombie: 'Зомби', skeleton: 'Скелет', spider: 'Паук', cave_spider: 'Пещерный паук',
      blaze: 'Ифрит', wither_skeleton: 'Скелет-иссушитель', magma_cube: 'Магмовый куб',
      guardian: 'Страж', elder_guardian: 'Древний страж', evoker: 'Заклинатель',
      vindicator: 'Поборник', witch: 'Ведьма', piglin: 'Пиглин', piglin_brute: 'Пиглин-брут',
      husk: 'Кадавр', iron_golem: 'Железный голем', villager: 'Житель'
    };
    return n[id] || id;
  }

  generateLoot(exp) {
    const loot = [];
    const r = Math.random();
    if (r < 0.7) loot.push(exp.rewards.common[Math.floor(Math.random() * exp.rewards.common.length)]);
    if (r < 0.3) loot.push(exp.rewards.rare[Math.floor(Math.random() * exp.rewards.rare.length)]);
    if (r < 0.05) loot.push(exp.rewards.special);
    return loot.length ? loot : [exp.rewards.common[0]];
  }

  async completeExploration(bot, exp) {
    exp.completed = true;
    this.activeExplorations.delete(bot.username);

    const time = Date.now() - exp.startTime;
    const eff = Math.max(0.5, Math.min(1.5, exp.explorationTime / time));
    const reward = {
      coins: Math.round((exp.chestsFound * 20 + exp.mobsKilled * 5 + exp.resourcesCollected * 2) * eff),
      exp: Math.round((exp.chestsFound * 30 + exp.mobsKilled * 10 + exp.resourcesCollected * 5) * eff)
    };

    state.economy.coins += reward.coins;
    const { addExp } = await import('../leveling.js');
    addExp(reward.exp, `исследование ${exp.name}`);

    bot.chat(`🏆 Исследование завершено: ${exp.name}`);
    bot.chat(`🎁 Монеты: ${reward.coins}, Опыт: ${reward.exp}`);
    if (eff > 1.2) bot.chat(`⚡ Бонус за скорость: +${Math.round((eff - 1) * 100)}%`);

    if (exp.exploredPercent >= 80) this.unlockAchievement(bot, exp.id);

    return { success: true, structure: exp.name, reward };
  }

  async unlockAchievement(bot, id) {
    const a = {
      mineshaft: 'Шахтёр-исследователь',
      village: 'Друг деревни',
      desert_temple: 'Расхититель гробниц',
      nether_fortress: 'Покоритель Незера',
      ocean_monument: 'Океанский исследователь',
      stronghold: 'Искатель крепостей',
      woodland_mansion: 'Охотник на илледжеров',
      bastion_remnant: 'Властелин бастионов'
    };

    const name = a[id];
    if (name && !state.botStats.achievements.includes(name)) {
      state.botStats.achievements.push(name);
      bot.chat(`🎖️ Достижение разблокировано: ${name}!`);
      const { addExp } = await import('../leveling.js');
      addExp(100, `достижение "${name}"`);
    }
  }

  getAvailableStructures() {
    return Array.from(this.structures.values()).map(s => ({
      id: s.id,
      name: s.name,
      type: this.getTypeText(s.type),
      difficulty: this.getDifficultyText(s.difficulty),
      time: `${s.explorationTime / 60000} мин`,
      danger: `${Math.round(s.dangerLevel * 100)}%`
    }));
  }

  getActiveExploration(user) {
    return this.activeExplorations.get(user);
  }

  async findNearbyStructures(bot) {
    const found = [];
    for (const [id, s] of this.structures) {
      const loc = await this.findStructure(bot, s);
      if (loc) {
        found.push({
          id,
          name: s.name,
          distance: Math.round(bot.entity.position.distanceTo(loc)),
          type: s.type,
          difficulty: s.difficulty
        });
      }
    }
    return found.sort((a, b) => a.distance - b.distance);
  }
}

const structureExplorer = new StructureExplorer();
