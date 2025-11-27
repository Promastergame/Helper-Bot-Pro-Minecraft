const {  state, enqueue  } = require('../../core/state.cjs');
const { createLogger } = require('../../core/logger.cjs');
const log = createLogger('trading');

class TradingSystem {
  constructor() {
    this.villagers = new Map();
    this.marketPrices = new Map();
    this.playerShops = new Map();
    this.stockMarket = new Map();
    this.contracts = new Map();

    this.loadVillagers();
    this.loadMarketPrices();
    this.initStockMarket();
    this.loadContracts();
    try { log.info('init', { villagers: this.villagers.size, marketItems: this.marketPrices.size }); } catch {}
  }
 
    loadVillagers() {
        // Разные типы жителей с их профессиями и торговыми предложениями
        this.villagers.set('farmer', {
            name: 'Фермер',
            profession: 'farmer',
            level: 1,
            trades: [
                { 
                    give: 'wheat', 
                    giveAmount: 20, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 16,
                    xp: 2
                },
                { 
                    give: 'carrot', 
                    giveAmount: 22, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 16,
                    xp: 2
                },
                { 
                    give: 'potato', 
                    giveAmount: 26, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 16,
                    xp: 2
                },
                { 
                    give: 'pumpkin', 
                    giveAmount: 6, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 3
                },
                { 
                    give: 'melon_slice', 
                    giveAmount: 4, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 3
                },
                { 
                    give: 'emerald', 
                    giveAmount: 1, 
                    get: 'bread', 
                    getAmount: 6,
                    maxUses: 12,
                    xp: 1
                },
                { 
                    give: 'emerald', 
                    giveAmount: 3, 
                    get: 'pumpkin_pie', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 1
                }
            ],
            reputation: 0,
            requiredReputation: 0
        });
        
        this.villagers.set('librarian', {
            name: 'Библиотекарь',
            profession: 'librarian',
            level: 1,
            trades: [
                { 
                    give: 'paper', 
                    giveAmount: 24, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 16,
                    xp: 2
                },
                { 
                    give: 'book', 
                    giveAmount: 4, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 2
                },
                { 
                    give: 'emerald', 
                    giveAmount: 5, 
                    get: 'bookshelf', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 10
                },
                { 
                    give: 'emerald', 
                    giveAmount: 10, 
                    get: 'lantern', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 5
                },
                { 
                    give: 'emerald', 
                    giveAmount: 20, 
                    get: 'enchanted_book', 
                    getAmount: 1,
                    maxUses: 2,
                    xp: 30,
                    enchantment: 'sharpness'
                }
            ],
            reputation: 0,
            requiredReputation: 10
        });
        
        this.villagers.set('blacksmith', {
            name: 'Кузнец',
            profession: 'armorer',
            level: 1,
            trades: [
                { 
                    give: 'coal', 
                    giveAmount: 15, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 16,
                    xp: 2
                },
                { 
                    give: 'iron_ingot', 
                    giveAmount: 4, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 2
                },
                { 
                    give: 'emerald', 
                    giveAmount: 7, 
                    get: 'iron_axe', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 10
                },
                { 
                    give: 'emerald', 
                    giveAmount: 8, 
                    get: 'iron_pickaxe', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 10
                },
                { 
                    give: 'emerald', 
                    giveAmount: 5, 
                    get: 'iron_helmet', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 10
                },
                { 
                    give: 'diamond', 
                    giveAmount: 1, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 20
                }
            ],
            reputation: 0,
            requiredReputation: 20
        });
        
        this.villagers.set('butcher', {
            name: 'Мясник',
            profession: 'butcher',
            level: 1,
            trades: [
                { 
                    give: 'raw_chicken', 
                    giveAmount: 14, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 16,
                    xp: 2
                },
                { 
                    give: 'raw_porkchop', 
                    giveAmount: 7, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 16,
                    xp: 2
                },
                { 
                    give: 'raw_beef', 
                    giveAmount: 10, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 16,
                    xp: 2
                },
                { 
                    give: 'emerald', 
                    giveAmount: 1, 
                    get: 'cooked_porkchop', 
                    getAmount: 5,
                    maxUses: 16,
                    xp: 2
                },
                { 
                    give: 'emerald', 
                    giveAmount: 1, 
                    get: 'cooked_beef', 
                    getAmount: 5,
                    maxUses: 16,
                    xp: 2
                }
            ],
            reputation: 0,
            requiredReputation: 5
        });
        
        this.villagers.set('cleric', {
            name: 'Священник',
            profession: 'cleric',
            level: 1,
            trades: [
                { 
                    give: 'rotten_flesh', 
                    giveAmount: 32, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 16,
                    xp: 2
                },
                { 
                    give: 'gold_ingot', 
                    giveAmount: 3, 
                    get: 'emerald', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 2
                },
                { 
                    give: 'emerald', 
                    giveAmount: 1, 
                    get: 'redstone', 
                    getAmount: 4,
                    maxUses: 12,
                    xp: 2
                },
                { 
                    give: 'emerald', 
                    giveAmount: 2, 
                    get: 'lapis_lazuli', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 5
                },
                { 
                    give: 'emerald', 
                    giveAmount: 4, 
                    get: 'glowstone', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 5
                },
                { 
                    give: 'emerald', 
                    giveAmount: 5, 
                    get: 'ender_pearl', 
                    getAmount: 1,
                    maxUses: 12,
                    xp: 20
                }
            ],
            reputation: 0,
            requiredReputation: 15
        });
    }
    
    loadMarketPrices() {
        // Динамические цены на рынке с базовой стоимостью и флуктуацией
        const items = {
            'diamond': { base: 64, fluctuation: 8 },
            'emerald': { base: 1, fluctuation: 0.2 },
            'iron_ingot': { base: 8, fluctuation: 2 },
            'gold_ingot': { base: 16, fluctuation: 4 },
            'coal': { base: 4, fluctuation: 1 },
            'redstone': { base: 2, fluctuation: 0.5 },
            'lapis_lazuli': { base: 3, fluctuation: 1 },
            'wheat': { base: 1, fluctuation: 0.2 },
            'carrot': { base: 1, fluctuation: 0.2 },
            'potato': { base: 1, fluctuation: 0.2 },
            'bread': { base: 3, fluctuation: 0.5 },
            'cooked_beef': { base: 5, fluctuation: 1 },
            'cooked_porkchop': { base: 5, fluctuation: 1 },
            'string': { base: 2, fluctuation: 0.5 },
            'spider_eye': { base: 4, fluctuation: 1 },
            'gunpowder': { base: 8, fluctuation: 2 },
            'ender_pearl': { base: 32, fluctuation: 8 },
            'blaze_rod': { base: 48, fluctuation: 12 }
        };
        
        for (const [item, data] of Object.entries(items)) {
            this.marketPrices.set(item, data);
        }
    }
    
    initStockMarket() {
        // Имитация фондового рынка для редких предметов
        this.stockMarket.set('diamond_stock', {
            item: 'diamond',
            currentPrice: 64,
            history: [64],
            volatility: 0.1,
            lastUpdate: Date.now()
        });
        
        this.stockMarket.set('netherite_stock', {
            item: 'netherite_scrap',
            currentPrice: 128,
            history: [128],
            volatility: 0.15,
            lastUpdate: Date.now()
        });
        
        this.stockMarket.set('emerald_stock', {
            item: 'emerald',
            currentPrice: 1,
            history: [1],
            volatility: 0.05,
            lastUpdate: Date.now()
        });
        
        // Запуск обновления цен каждые 30 секунд
        setInterval(() => this.updateStockPrices(), 30000);
    }
    
    loadContracts() {
        // Контракты на поставку товаров
        this.contracts.set('wheat_delivery', {
            id: 'wheat_delivery',
            name: 'Поставка пшеницы',
            description: 'Доставьте 64 блока пшеницы в указанное место',
            requiredItem: 'wheat',
            requiredAmount: 64,
            reward: { coins: 50, exp: 100 },
            timeLimit: 600000, // 10 минут
            difficulty: 'easy'
        });
        
        this.contracts.set('diamond_mining', {
            id: 'diamond_mining',
            name: 'Добыча алмазов',
            description: 'Найдите и доставьте 8 алмазов',
            requiredItem: 'diamond',
            requiredAmount: 8,
            reward: { coins: 200, exp: 300 },
            timeLimit: 1800000, // 30 минут
            difficulty: 'hard'
        });
        
        this.contracts.set('monster_hunt', {
            id: 'monster_hunt',
            name: 'Охота на монстров',
            description: 'Уничтожьте 10 зомби и 5 скелетов',
            requiredKills: { 'zombie': 10, 'skeleton': 5 },
            reward: { coins: 150, exp: 250 },
            timeLimit: 1200000, // 20 минут
            difficulty: 'medium'
        });
    }
    
    getCurrentPrice(item) {
        const priceInfo = this.marketPrices.get(item);
        if (!priceInfo) return 1;
        
        // Флуктуация цены на основе времени и случайности
        const timeFactor = Math.sin(Date.now() / 3600000) * 0.3; // Цикл каждые 60 минут
        const randomFactor = (Math.random() - 0.5) * 2 * priceInfo.fluctuation;
        const finalPrice = priceInfo.base * (1 + timeFactor + randomFactor);
        
        return Math.max(1, Math.round(finalPrice));
    }
    
    updateStockPrices() {
        for (const [stockId, stock] of this.stockMarket) {
            const change = (Math.random() - 0.5) * 2 * stock.volatility;
            stock.currentPrice = Math.max(1, Math.round(stock.currentPrice * (1 + change)));
            stock.history.push(stock.currentPrice);
            
            // Сохраняем только последние 100 значений
            if (stock.history.length > 100) {
                stock.history.shift();
            }
            
            stock.lastUpdate = Date.now();
        }
    }
    
    async tradeWithVillager(bot, villagerType, tradeIndex) {
        return new Promise((resolve, reject) => {
            enqueue(async () => {
                try {
                    const villager = this.villagers.get(villagerType);
                    if (!villager) {
                        reject(new Error(`Неизвестный тип жителя: ${villagerType}`));
                        return;
                    }
                    
                    // Проверка репутации
                    if (villager.reputation < villager.requiredReputation) {
                        reject(new Error(`Недостаточно репутации. Нужно: ${villager.requiredReputation}, есть: ${villager.reputation}`));
                        return;
                    }
                    
                    const trade = villager.trades[tradeIndex];
                    if (!trade) {
                        reject(new Error(`Неизвестный trade: ${tradeIndex}`));
                        return;
                    }
                    
                    // Проверка наличия предметов
                    const giveItem = bot.inventory.items().find(item => item.name === trade.give);
                    if (!giveItem || giveItem.count < trade.giveAmount) {
                        reject(new Error(`Недостаточно ${trade.give}. Нужно: ${trade.giveAmount}`));
                        return;
                    }
                    
                    // Поиск жителя поблизости
                    const villagerEntity = this.findVillagerNearby(bot, villager.profession);
                    if (!villagerEntity) {
                        reject(new Error(`Рядом нет жителя профессии ${villager.profession}`));
                        return;
                    }
                    
                    // Подход к жителю
                    const { goals } = await import('mineflayer-pathfinder');
                    bot.pathfinder.setGoal(new goals.GoalNear(villagerEntity.position.x, villagerEntity.position.y, villagerEntity.position.z, 2));
                    
                    // Ждем подхода
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Выполнение торговли
                    bot.chat(`🛒 Торгую с ${villager.name}: ${trade.giveAmount} ${trade.give} → ${trade.getAmount} ${trade.get}`);
                    
                    // Увеличение репутации
                    villager.reputation += 1;
                    state.economy.trades += 1;
                    state.economy.reputation += trade.xp;
                    
                    // Начисление опыта за торговлю
                    const { addExp } = await import('../leveling.js');
                    addExp(trade.xp, `торговля с ${villager.name}`);
                    
                    resolve({
                        success: true,
                        villager: villager.name,
                        given: { item: trade.give, amount: trade.giveAmount },
                        received: { item: trade.get, amount: trade.getAmount },
                        reputationGain: 1,
                        xpGain: trade.xp
                    });
                    
                } catch (error) {
                    reject(error);
                }
            }, 'villager_trade');
        });
    }
    
    findVillagerNearby(bot, profession) {
        return Object.values(bot.entities).find(entity => 
            entity.type === 'villager' && 
            entity.metadata && 
            entity.metadata[16] === profession
        );
    }
    
    async buyFromMarket(bot, item, amount) {
        return new Promise((resolve, reject) => {
            enqueue(async () => {
                try {
                    const price = this.getCurrentPrice(item) * amount;
                    
                    if (state.economy.coins < price) {
                        reject(new Error(`Недостаточно монет. Нужно: ${price}, есть: ${state.economy.coins}`));
                        return;
                    }
                    
                    // Проверяем, есть ли товар на рынке
                    const marketItem = this.getMarketItem(item);
                    if (!marketItem || marketItem.stock < amount) {
                        reject(new Error(`Недостаточно товара на рынке. Доступно: ${marketItem?.stock || 0}`));
                        return;
                    }
                    
                    // Совершаем покупку
                    state.economy.coins -= price;
                    marketItem.stock -= amount;
                    
                    // Добавляем предмет в инвентарь (в реальности нужно физически выдать предмет)
                    bot.chat(`🛒 Куплено ${amount} ${item} за ${price} монет`);
                    
                    resolve({
                        success: true,
                        item: item,
                        amount: amount,
                        price: price,
                        remainingCoins: state.economy.coins
                    });
                    
                } catch (error) {
                    reject(error);
                }
            }, 'market_buy');
        });
    }
    
    async sellToMarket(bot, item, amount) {
        return new Promise((resolve, reject) => {
            enqueue(async () => {
                try {
                    // Проверяем наличие предметов в инвентаре
                    const items = bot.inventory.items().filter(i => i.name === item);
                    const totalAmount = items.reduce((sum, i) => sum + i.count, 0);
                    
                    if (totalAmount < amount) {
                        reject(new Error(`Недостаточно ${item}. Нужно: ${amount}, есть: ${totalAmount}`));
                        return;
                    }
                    
                    const price = this.getCurrentPrice(item) * amount;
                    
                    // Продажа предметов
                    state.economy.coins += price;
                    
                    // Удаляем предметы из инвентаря (в реальности нужно физически удалить)
                    bot.chat(`💰 Продано ${amount} ${item} за ${price} монет`);
                    
                    resolve({
                        success: true,
                        item: item,
                        amount: amount,
                        price: price,
                        newBalance: state.economy.coins
                    });
                    
                } catch (error) {
                    reject(error);
                }
            }, 'market_sell');
        });
    }
    
    async createPlayerShop(bot, shopName, items) {
        return new Promise((resolve, reject) => {
            enqueue(async () => {
                try {
                    const shopId = `player_${Date.now()}`;
                    
                    this.playerShops.set(shopId, {
                        id: shopId,
                        name: shopName,
                        owner: bot.username,
                        location: bot.entity.position.floored(),
                        items: items,
                        created: Date.now(),
                        revenue: 0
                    });
                    
                    bot.chat(`🏪 Магазин "${shopName}" создан!`);
                    
                    resolve({
                        success: true,
                        shopId: shopId,
                        shopName: shopName,
                        items: items
                    });
                    
                } catch (error) {
                    reject(error);
                }
            }, 'create_shop');
        });
    }
    
    async acceptContract(bot, contractId) {
        const contract = this.contracts.get(contractId);
        if (!contract) {
            throw new Error(`Контракт не найден: ${contractId}`);
        }
        
        // Добавляем контракт в активные
        state.activeContracts = state.activeContracts || [];
        state.activeContracts.push({
            ...contract,
            acceptedAt: Date.now(),
            progress: 0
        });
        
        bot.chat(`📝 Принят контракт: ${contract.name}`);
        
        return {
            success: true,
            contract: contract.name,
            timeLimit: contract.timeLimit,
            reward: contract.reward
        };
    }
    
    checkContractProgress(bot) {
        if (!state.activeContracts) return;
        
        for (const contract of state.activeContracts) {
            let completed = true;
            
            if (contract.requiredItem) {
                const items = bot.inventory.items().filter(i => i.name === contract.requiredItem);
                const total = items.reduce((sum, i) => sum + i.count, 0);
                contract.progress = Math.min(total / contract.requiredAmount, 1);
                completed = total >= contract.requiredAmount;
            }
            
            if (contract.requiredKills) {
                // Проверка убийств монстров
                completed = Object.entries(contract.requiredKills).every(([mob, count]) => 
                    (state.botStats.mobsKilled?.[mob] || 0) >= count
                );
            }
            
            if (completed) {
                this.completeContract(bot, contract.id);
            } else if (Date.now() - contract.acceptedAt > contract.timeLimit) {
                this.failContract(bot, contract.id);
            }
        }
    }
    
    async completeContract(bot, contractId) {
        const contractIndex = state.activeContracts.findIndex(c => c.id === contractId);
        if (contractIndex === -1) return;
        
        const contract = state.activeContracts[contractIndex];
        state.activeContracts.splice(contractIndex, 1);
        
        // Выдача награды
        state.economy.coins += contract.reward.coins;
        const { addExp } = await import('../leveling.js');
        addExp(contract.reward.exp, `контракт "${contract.name}"`);
        
        bot.chat(`🎉 Контракт "${contract.name}" выполнен! Награда: ${contract.reward.coins} монет, ${contract.reward.exp} опыта`);
    }
    
    getMarketItem(item) {
        // В реальной реализации здесь была бы база данных рыночных товаров
        return {
            item: item,
            stock: 1000, // Бесконечный запас для демонстрации
            price: this.getCurrentPrice(item)
        };
    }
    
    getAvailableVillagers() {
        return Array.from(this.villagers.values()).map(villager => ({
            name: villager.name,
            profession: villager.profession,
            level: villager.level,
            reputation: villager.reputation,
            requiredReputation: villager.requiredReputation,
            trades: villager.trades.length
        }));
    }
    
    getStockPrices() {
        const prices = {};
        for (const [item] of this.marketPrices) {
            prices[item] = this.getCurrentPrice(item);
        }
        return prices;
    }
    
    getPlayerShops() {
        return Array.from(this.playerShops.values());
    }
    
    getAvailableContracts() {
        return Array.from(this.contracts.values());
    }
}

const tradingSystem = new TradingSystem();

// Lightweight logging wrappers
try {
  const proto = TradingSystem.prototype;
  if (proto && typeof proto.tradeWithVillager === 'function') {
    const _trade = proto.tradeWithVillager;
    proto.tradeWithVillager = function(bot, villagerType, tradeIndex){
      try { log.info('tradeWithVillager:call', { villagerType, tradeIndex }); } catch {}
      const p = _trade.call(this, bot, villagerType, tradeIndex);
      try {
        p.then(() => log.info('tradeWithVillager:done', { villagerType, tradeIndex }))
         .catch(e => log.error('tradeWithVillager:err', { err: e?.message || String(e) }));
      } catch {}
      return p;
    }
  }
  if (proto && typeof proto.buyFromMarket === 'function') {
    const _buy = proto.buyFromMarket;
    proto.buyFromMarket = function(bot, item, amount){
      try { log.info('market:buy:call', { item, amount }); } catch {}
      const p = _buy.call(this, bot, item, amount);
      try {
        p.then(() => log.info('market:buy:done', { item, amount }))
         .catch(e => log.error('market:buy:err', { err: e?.message || String(e) }));
      } catch {}
      return p;
    }
  }
  if (proto && typeof proto.sellToMarket === 'function') {
    const _sell = proto.sellToMarket;
    proto.sellToMarket = function(bot, item, amount){
      try { log.info('market:sell:call', { item, amount }); } catch {}
      const p = _sell.call(this, bot, item, amount);
      try {
        p.then(() => log.info('market:sell:done', { item, amount }))
         .catch(e => log.error('market:sell:err', { err: e?.message || String(e) }));
      } catch {}
      return p;
    }
  }
} catch {}
