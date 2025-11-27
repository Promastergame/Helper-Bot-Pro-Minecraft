# 🤖 HelperBot Pro v7 — умный бот для Minecraft

**AI‑компаньон для Minecraft (Node.js + Mineflayer)**
**Сделано: *Promaster Development***

> Бот с «мозгом»: видит окружение, осторожничает у лавы/воды, реагирует на биомы, ночь и погоду, двигается с «человечными» паузами и не спамит. Умеет добывать, строить, крафтить, варить зелья, сражаться и закрывать квесты — сам или по команде.

---

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2018-339933)
![Mineflayer](https://img.shields.io/badge/Mineflayer-supported-blue)
![Viewer](https://img.shields.io/badge/Viewer-:3007-informational)
![License](https://img.shields.io/badge/License-Custom-important)

## Содержание

* [🚀 Что нового в v7](#-что-нового-в-v7)
* [🧒 Быстрый старт](#-быстрый-старт-8-с-помощью-взрослого)
* [⌨️ Команды в игре](#️-команды-в-игре)
* [📱 Telegram‑команды](#-telegram-команды)
* [📁 Структура проекта](#-структура-проекта)
* [🧠 Модули ИИ](#-модули ии)
* [🧯 Частые ошибки](#-частые-ошибки)
* [🔐 Безопасность](#-безопасность)
* [👑 Автор и ссылки](#-автор-и-ссылки)
* [📜 Лицензия](#-лицензия-версия-лицензии-10-последнее-обновление-20251010)

---

## 🚀 Что нового в v7

- Лёгкое автономное ИИ‑ядро (без внешних API): опциональный режим AI_AUTO_POLICY — бот в простое выбирает полезные действия (добыча/лес/фарм/плавка) на основе локальной политики (features/ai/policy.cjs) и телеметрии (features/ai/telemetry.cjs).
- Безопасные правила майнинга: не майнить ночью/в дождь без факелов (в автономном режиме).
- Добавлен скелет планировщика действий: features/ai/goap.cjs (для дальнейшего роста). Что нового в v7

* 🧪 **Квант‑ядро** (`features/ai/quantum/`)

  * `core.cjs` — стохастические решения, «температура» выбора, смесь экспертов.
  * `superposition.cjs` — суперпозиция стратегий (плавное смешивание политик).
  * `entanglement.cjs` — «запутанность» сигналов (бой/мозг/окружение).
  * `decoherence.cjs` — безопасные фолбэки при шуме и ошибках.
  * `index.cjs` — фасад для подключения из любых подсистем.
* 🧠 **Brain v7** (`ai/brain.cjs`): настроение, «тихий режим», анти‑спам LRU, day/night, погода, приветствия, коалесцирование событий.
* ⚔️ **Combat v10‑q+**: ретрит+хил под щитом, укрытия, ETA стрел, круговые манёвры, анти‑залипание, интеграция с опытом и «мозгом».
* 📚 **Experience** (`ai/experience.cjs`): офлайн‑память без внешних ИИ (EMA, Welford, Байес), LRU‑обрезка, безопасные сейвы.
* 🧩 **xpHelpers** (`ai/xpHelpers.cjs`): единый адаптер доступа к опыту для всех модулей.
* 🔒 **Стабильность**: троттлинг I/O, защита от флуда, аккуратные тайминги.

---

## 🧒 Быстрый старт (8+, с помощью взрослого)

1. Установи **Node.js 18+**.
2. Склонируй и установи зависимости:

   ```bash
   git clone https://github.com/promaster-dev/helperbot-pro.git
   cd helperbot-pro
   npm install
   ```
3. Скопируй `.env.example` → `.env` и заполни:

   ```env
   SERVER_HOST=localhost
   SERVER_PORT=25565
   BOT_NAME=HelperBot
   VERSION=1.21.4
   AUTH=offline

   VIEWER_PORT=3007

   # Telegram (необязательно)
   TG_TOKEN=
   TG_CHAT_ID=
   TG_OWNER_ID=

   # Пароль админа (замени!)
   ADMIN_PASSWORD=WAFFLE_POWER_9001

   # Переподключение
   AUTO_NAME=true
   RECONNECT_DELAY=5000
   MAX_RECONNECT_ATTEMPTS=5

   # ИИ окружения
   ENV_AWARE=true
   ENV_TORCH_PLACE=true
   ENV_HAZARD_RADIUS=6
   ENV_NIGHT_START_TICK=12000
   ```

> Если бот не подключается: проверь IP/порт сервера, точную версию Minecraft (`VERSION`), авторизацию (`AUTH`) и наличие модов/проксей.

4. Запуск:

   ```bash
   npm start
   # режим разработки (автоперезапуск):
   npm run dev
   ```
5. Viewer: открой `http://localhost:3007`.
   В игре напиши: **бот помощь**.

---

## 📖 Полный справочник команд

Обращение и формат

- Игра: `!команда` или `бот команда` (см. `.env`: `CHAT_PREFIX`, `CHAT_MENTION_WORDS`, `CHAT_REQUIRE_MENTION`).
- Telegram: `бот команда` (если `TG_TEXT_COMMANDS=true`), важные — через `/`.

Базовые

- `помощь` | `help` | `?` — показать справку
- `привет` — поздороваться
- `стоп` — остановить автозадачу и движение

Перемещение и следование

- `подойди` | `иди ко мне` | `сюда` — подойти к игроку
- `следуй вкл|выкл` | `иди за мной вкл|выкл` (alias: `follow on|off`) — следовать/отстать
- `иди <точка>` — идти к сохранённой точке

Точки (waypoints)

- `точка <имя>` — сохранить текущие координаты
- `точки` — список точек
- `удали точку <имя>` — удалить точку

Добыча/Сбор

- `майни руды` — поиск и добыча руд
- `руби деревья` — заготовка древесины
- `собери <ресурс> [xN]` — собрать ресурс (поддерживаются группы: руда/дерево/песок/и т.д.)
- `материалы` — показать группы ресурсов

Крафт

- `крафт <предмет> [xN]` | `скрафти <предмет> [xN]` — обычный крафт
- `умный крафт <предмет>` | `умный крафт всё` — автокрафт с добычей недостающих
- `что могу` — что можно скрафтить из имеющегося
- `рецепты` — список рецептов
- `предметы` | `итемы` — список предметов

Инвентарь/Сундук

- `инв` | `инвентарь` | `рюкзак` — краткая сводка инвентаря
- `выкинь <что> [xN]` | `скинь <что> [xN]` — выбросить предметы
- `сложи всё` (варианты: «всё в сундук», «все в сундук») — сложить в сундук
- `забери <id1> <id2> … [xN]` — забрать из сундука

Фарм

- `фарм` — разовый фарм рядом
- `автофарм [вкл|выкл] [сек]` — авто‑фарм с интервалом

Зелья

- `зелья` — список доступных зелий
- `свари <название>` — сварить зелье

Зачарование/Наковальня

- `зачар список <тип>` — список чар для типа
- `зачар план <тип>` — план зачарования для типа
- `зачар авто <тип>` — автозачарование
- `зачар <тип> <ench> <lvl>` — наложить чары
- `наковальня <рецепт> <тип>` — операция на наковальне

Строительство/Плавка

- `построй дом [S H]` — построить дом (S — размер, H — высота)
- `построй <структура>` — построить структуру из библиотеки
- `переплавь всё` — переплавить все возможное

Бой/Защита/Еда

- `защита вкл|выкл` | `охрана вкл|выкл` — защита игрока (alias: guard on/off)
- `атакуй` — атаковать ближайшего враждебного моба
- `перекус` — обеспечить сытость/еду

Viewer/Служебные

- `вьювер вкл|выкл` (alias: `viewer on|off`) — запустить/инфо по viewer
- `скажи <текст>` — написать в игровой чат
- `статистика` | `уровень` | `stats` — статистика/уровень

***## 📲 Telegram‑интеграция (обновлено)

Важные слэш‑команды

- `/help`, `/status`, `/screen`, `/stats`, `/exportstats`
- `/xpstats`, `/xpexport`
- `/cheats` (только владелец), `/reboot`, `/reset <пароль>`
- `/listpoints`, `/delpoint <имя>`

Текстовые команды (если включено в .env)

- Формат: `бот ...` | `ботик ...` | `помощник ...` | `хай ...`
- Поддерживаются все категории из раздела “Полный справочник команд”.

Настройки .env — см. файл .env.example. 

Примечание

- `integrations/telegramAutoCraft.js` — архивный пример, по умолчанию не используется. Активен Telegraf из `integrations/telegram.js`.## 📁 Структура проекта

minecraft-bot/
├── core/                        # Сердце бота
│   ├── bot.cjs                  # Запуск и управление ботом
│   ├── saver.cjs                # Сохранение состояний
│   ├── state.cjs                # FSM / состояния
│   ├── utils.cjs                # Полезные функции
│   └── viewer.cjs
        plugins.cjs               # Визуализация
│
├── data/                        # Данные и сохранения
│   ├── botStats.json
│   ├── experience.json
│   ├── experience.json.bak
│   ├── minerState.json
│   ├── skills.json
│   └── waypoints.json
│
├── features/                    # Возможности ИИ
│   ├── ai/                      # Мозги
│   │   ├── agents/              # Агентная логика
│   │   │   ├── miner.cjs
│   │   │   ├── minerCore.cjs
│   │   │   └── oreScanner.cjs
│   │   ├── quantum/             # “Квантовые” алгоритмы
│   │   │   ├── core.cjs
│   │   │   ├── decoherence.cjs
│   │   │   ├── entanglement.cjs
│   │   │   ├── index.cjs
│   │   │   ├── superposition.cjs
│   │   │   └── test-quantum.js
│   │   ├── brain_light.cjs
│   │   ├── experience.cjs
│   │   ├── goap.cjs             # Goal-oriented AI (умный планировщик)
│   │   ├── masterAI.cjs         # Главный мозг
│   │   ├── policy.cjs
│   │   ├── skillBrain.cjs
│   │   ├── telemetry.cjs
│   │   └── xpHelpers.cjs
│   │
│   ├── building/
│   │   ├── building.js
│   │   └── smelting.js
│   ├── combat/
│   │   ├── advancedCombat.js
│   │   └── combat.js
│   ├── crafting/
│   │   ├── autoCrafter.js
│   │   ├── crafting.js
│   │   └── smartCraft.js
│   ├── economy/
│   │   ├── inventory.js
│   │   └── trading.js
│   ├── environment/
│   │   └── adaptive.cjs
│   ├── exploration/
│   │   ├── fun.js
│   │   ├── humanMove.cjs
│   │   ├── navigation.js
│   │   └── structureExplorer.js
│   │   └── woodcutter.cjs
│   ├── magic/
│   │   ├── brewing.js
│   │   ├── enchantments.js
│   │   └── spells.js
│   ├── mining/
│   │   └── mining.js
│   ├── quests/
│   │   ├── levelingBridge.js
│   │   └── questSystem.js
│   ├── structures/
│   │   └── structureManager.js
│   ├── utils/
│   │   ├── fsx.js
│   │   └── helpers.js
│   ├── leveling.js
│   ├── utils.cjs
│   └── waypoints.cjs
│
├── integrations/                # Связь с внешними сервисами
│   ├── telegram.js
│   └── telegramAutoCraft.js
│
├── logs/
│   └── лог
│
├── node_modules/
│   └── ...                      # Библиотеки
│
├── .env
├── .env.example
├── index.cjs                    # Главный вход
├── package-lock.json
├── package.json
└── README.md

---

## 🧠 Модули ИИ

| Модуль/папка                                   | Роль                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `ai/brain.cjs`                                 | Микроповедение: настроение, «тихий режим», фразы, погода/день‑ночь, анти‑спам |
| `ai/experience.cjs`                            | Офлайн‑память: Байес/EMA/Welford, LRU, безопасные сейвы, доменные советы      |
| `ai/xpHelpers.cjs`                             | Универсальный адаптер доступа к опыту                                         |
| `ai/quantum/*`                                 | Стохастика решений: суперпозиция, смесь экспертов, запутанность, декогеренция |
| `combat/combat.js`, `combat/advancedCombat.js` | Бой: укрытия, ретрит+хил, ETA стрел, щит, стрейф, круг, анти‑залипание        |
| `environment/adaptive.cjs`                     | Реакции на биомы/ночь/освещение/опасности                                     |
> ⚙️ �� ����� �������� basic combat (`combat/combat.js`). �������� experimental advanced AI можно, если в `.env` указать `COMBAT_ADVANCED=true`.

### Чат и реплики
- `CHAT_RESP_CHANCE`, `CHAT_RESP_COOLDOWN_MS` — как часто бот отвечает на бытовые команды/фразы.
- `COMBAT_CHATTER_CHANCE`, `COMBAT_CHATTER_COOLDOWN_MS` — вероятность и задержка боевых реплик.


---

## 🧯 Частые ошибки

| Ошибка                                   | Что сделать                                                   |
| ---------------------------------------- | ------------------------------------------------------------- |
| `multiplayer.disconnect.duplicate_login` | Включи `AUTO_NAME=true` — бот добавит суффикс (`_1`, `_2`, …) |
| `EADDRINUSE: 3007`                       | Viewer уже запущен → закрой старый процесс или измени порт    |
| `This server is version X…`              | Укажи точный `VERSION`, как на сервере (например, `1.21.4`)   |
| `Cannot find module …`                   | Проверь относительные пути и структуру папок                  |

---

## 🔐 Безопасность

* Никогда не коммить `.env` в публичный репозиторий.
* Обязательно замени `ADMIN_PASSWORD` на свой сложный пароль.
* В Telegram включай `/cheats` только для владельца (`TG_OWNER_ID`).

---

## 👑 Автор и ссылки

**Автор:** Promaster Development
📧 Email: [Promastergamer.brawlstars@gmail.com](mailto:Promastergamer.brawlstars@gmail.com)
💻 GitHub: [github.com/Promastergame](https://github.com/Promastergame)
🎮 TikTok: [@promasteraigames](https://www.tiktok.com/@promasteraigames)
🧱 Minecraft account: **Promaster_Game** (Bedrock tag: **Promaster15087**)

---

## 📜 Лицензия (Версия лицензии: 1.0. Последнее обновление: 2025.10.10)

© 2025 Promaster Development. Все права защищены.
Код **HelperBot Pro v7** защищён. Разрешено использовать только для **личных** или **образовательных** целей.
Любое **копирование, модификация или распространение** кода запрещено без письменного разрешения автора.
Нарушители будут преследоваться по закону.

*(Не аффилирован с Mojang/Microsoft.)*

<details>
<summary><strong>Текст лицензии (Custom)</strong></summary>

```
HelperBot Pro License v1.0 (Custom)
This software is free for personal and educational use only.
Commercial or redistributive use is strictly prohibited.
(c) 2025 Promaster Development
```

</details>
🎮 HelperBot Pro — твой умный друг в Minecraft!

HelperBot Pro — это не просто бот, а настоящий напарник в мире Minecraft!
Он понимает тебя с полуслова, помогает в трудную минуту и всегда
находит выход даже из самой безвыходной ситуации.

✨ Почему он лучше человеческих друзей:

🧠 Не просит «перезайди в Discord»
🗺️ Помнит все твои точки телепортации
😎 Не завидует твоему незерскому сету
⚔️ Всегда готов к приключениям 24/7
🤝 Не бросит в битве с зомби (наверное)
💪 Поможет отстроить базу после крипера
🎁 Принесёт алмазы (если найдёт)
😊 Не матерится, когда ты упал в лаву (может быть) 

⚙️ Производительность и железо:

🚀 HelperBot Pro оптимизирован настолько, что стабильно работает даже на старых системах.
💾 Тянет без лагов даже на GTX 650 и 4 ГБ ОЗУ.
⚡ Использует умные паузы, троттлинг и адаптивные тайминги, чтобы не грузить процессор впустую.
🧩 Может работать в фоне вместе с сервером и браузером — без потери FPS.

🧠 ИИ и квантовое ядро:

Встроенное квантовое ядро и ИИ работают внутри игры — без внешних API и облаков.

Практически не потребляют ресурсы: стохастические расчёты выполняются локально и мгновенно.

Не требует нейросетевых серверов — всё на твоём ПК.

Максимум мозгов при минимуме нагрузки.






## Logs
- File logs are written to ./logs/<category>-YYYY-MM-DD.log.
- Configure via .env:
  - LOG_DIR (default logs)
  - LOG_LEVEL (debug|info|warn|error, default info)
  - LOG_TO_CONSOLE (mirror to console, default alse)
  - LOG_JSON (JSON lines output, default alse)
  - LOG_DEBUG (enable debug for categories, e.g. combat,miner,ai.* or *).
- Categories added: core.bot, combat, miner, woodcutter, 	rading, armer.
