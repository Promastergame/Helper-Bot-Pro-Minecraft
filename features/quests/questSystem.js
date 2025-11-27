// ===============================
// features/questSystem.js
// 🎯 Система квестов HelperBot
// ===============================

const {  state  } = require('../../core/state.cjs');
const leveling = require('../leveling.js');

class QuestSystem {
    constructor() {
        this.quests = new Map();
        this.loadQuests();

        // Безопасная инициализация
        state.quests ??= { active: [], completed: [] };
        state.skills ??= { combat: { level: 1 } };
        state.economy ??= { coins: 0 };
        state.botStats ??= { mobsKilled: {} };
        state.structures ??= { built: [] };
        state.exploredBiomes ??= [];
        state.unlockedAbilities ??= [];
    }

    // ===============================
    // КВЕСТЫ
    // ===============================
    loadQuests() {
        // Добыча
        this.quests.set('first_mining', {
            id: 'first_mining',
            name: 'Первая добыча',
            description: 'Добудь 10 блоков древесины и 5 булыжника',
            type: 'mining',
            objectives: [
                { type: 'collect', item: 'oak_log', target: 10 },
                { type: 'collect', item: 'cobblestone', target: 5 }
            ],
            rewards: {
                exp: 50,
                coins: 10,
                items: ['wooden_pickaxe'],
                unlock: 'basic_mining'
            },
            requiredLevel: 1
        });

        // Строительство
        this.quests.set('first_house', {
            id: 'first_house',
            name: 'Первый дом',
            description: 'Построй дом с крышей и дверью',
            type: 'building',
            objectives: [
                { type: 'build', structure: 'house', target: 1 }
            ],
            rewards: {
                exp: 100,
                coins: 25,
                items: ['crafting_table', 'furnace'],
                unlock: 'basic_building'
            },
            requiredLevel: 2
        });

        // Бой
        this.quests.set('monster_hunter', {
            id: 'monster_hunter',
            name: 'Охотник на монстров',
            description: 'Убей 5 зомби и 3 скелета',
            type: 'combat',
            objectives: [
                { type: 'kill', mob: 'zombie', target: 5 },
                { type: 'kill', mob: 'skeleton', target: 3 }
            ],
            rewards: {
                exp: 150,
                coins: 50,
                items: ['iron_sword'],
                unlock: 'combat_training'
            },
            requiredLevel: 3
        });

        // Экспедиция
        this.quests.set('nether_expedition', {
            id: 'nether_expedition',
            name: 'Экспедиция в Незер',
            description: 'Добудь обсидиан, построй портал и исследуй Незер',
            type: 'exploration',
            objectives: [
                { type: 'collect', item: 'obsidian', target: 10 },
                { type: 'build', structure: 'nether_portal', target: 1 },
                { type: 'explore', biome: 'nether', target: 1 }
            ],
            rewards: {
                exp: 300,
                coins: 100,
                items: ['netherite_scrap'],
                unlock: 'nether_travel'
            },
            requiredLevel: 10
        });
    }

    // ===============================
    // ПРОВЕРКА УСЛОВИЙ
    // ===============================
    checkEligibility(questId) {
        const quest = this.quests.get(questId);
        if (!quest) return false;

        const combatLvl = state.skills.combat?.level ?? 0;
        const notCompleted = !state.quests.completed.includes(questId);
        const notActive = !state.quests.active.find(q => q.id === questId);

        return combatLvl >= quest.requiredLevel && notCompleted && notActive;
    }

    startQuest(bot, questId) {
        const quest = this.quests.get(questId);
        if (!quest) return false;

        if (!this.checkEligibility(questId)) {
            bot.chat(`❌ Квест "${quest.name}" пока недоступен.`);
            return false;
        }

        state.quests.active.push({ ...quest, progress: {} });
        bot.chat(`📜 Новый квест начат: "${quest.name}" — ${quest.description}`);
        return true;
    }

    // ===============================
    // ПРОГРЕСС И ВЫПОЛНЕНИЕ
    // ===============================
    checkQuestProgress(bot) {
        for (const quest of state.quests.active) {
            let completed = true;

            for (const objective of quest.objectives) {
                const progress = this.getObjectiveProgress(bot, objective);
                if (progress < objective.target) {
                    completed = false;
                }
            }

            if (completed) {
                this.completeQuest(bot, quest.id);
            }
        }
    }

    getObjectiveProgress(bot, objective) {
        switch (objective.type) {
            case 'collect': {
                const item = bot.inventory.items().find(i => i.name === objective.item);
                return item?.count ?? 0;
            }
            case 'kill': {
                return state.botStats.mobsKilled?.[objective.mob] ?? 0;
            }
            case 'build': {
                return state.structures.built.filter(s => s.type === objective.structure).length;
            }
            case 'explore': {
                return state.exploredBiomes.includes(objective.biome) ? 1 : 0;
            }
            default:
                return 0;
        }
    }

    // ===============================
    // ЗАВЕРШЕНИЕ КВЕСТА
    // ===============================
    completeQuest(bot, questId) {
        const quest = this.quests.get(questId);
        if (!quest) return;

        // Удаляем из активных
        state.quests.active = state.quests.active.filter(q => q.id !== questId);
        if (!state.quests.completed.includes(questId)) {
            state.quests.completed.push(questId);
        }

        // Награды
        leveling.addExp(quest.rewards.exp, `за квест "${quest.name}"`);
        state.economy.coins += quest.rewards.coins;

        // Разблокировка
        if (quest.rewards.unlock && !state.unlockedAbilities.includes(quest.rewards.unlock)) {
            state.unlockedAbilities.push(quest.rewards.unlock);
        }

        // Лог
        bot.chat(`🎉 Квест "${quest.name}" завершён!\n🏅 Опыт: +${quest.rewards.exp}\n💰 Монеты: +${quest.rewards.coins}`);
    }

    // ===============================
    // ПОЛУЧЕНИЕ ДОСТУПНЫХ КВЕСТОВ
    // ===============================
    getAvailableQuests() {
        return Array.from(this.quests.values()).filter(q => this.checkEligibility(q.id));
    }

    listActiveQuests() {
        return state.quests.active.map(q => `📜 ${q.name}: ${q.description}`);
    }

    listCompletedQuests() {
        return state.quests.completed.map(id => {
            const q = this.quests.get(id);
            return `✅ ${q?.name || id}`;
        });
    }
}

const questSystem = new QuestSystem();
