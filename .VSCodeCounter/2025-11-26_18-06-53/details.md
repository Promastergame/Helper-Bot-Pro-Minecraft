# Details

Date : 2025-11-26 18:06:53

Directory c:\\minecraft-bot

Total : 70 files,  21698 codes, 2677 comments, 2614 blanks, all 26989 lines

[Summary](results.md) / Details / [Diff Summary](diff.md) / [Diff Details](diff-details.md)

## Files
| filename | language | code | comment | blank | total |
| :--- | :--- | ---: | ---: | ---: | ---: |
| [.env](/.env) | Dotenv | 48 | 30 | 10 | 88 |
| [README.md](/README.md) | Markdown | 323 | 0 | 99 | 422 |
| [core/bot.cjs](/core/bot.cjs) | JavaScript | 599 | 58 | 74 | 731 |
| [core/logger.cjs](/core/logger.cjs) | JavaScript | 106 | 5 | 19 | 130 |
| [core/plugins.cjs](/core/plugins.cjs) | JavaScript | 39 | 14 | 17 | 70 |
| [core/saver.cjs](/core/saver.cjs) | JavaScript | 44 | 9 | 8 | 61 |
| [core/state.cjs](/core/state.cjs) | JavaScript | 287 | 59 | 52 | 398 |
| [core/utils.cjs](/core/utils.cjs) | JavaScript | 53 | 10 | 9 | 72 |
| [core/viewer.cjs](/core/viewer.cjs) | JavaScript | 67 | 8 | 14 | 89 |
| [data/botStats.json](/data/botStats.json) | JSON | 13 | 0 | 0 | 13 |
| [data/experience.json](/data/experience.json) | JSON | 50 | 0 | 0 | 50 |
| [data/minerState.json](/data/minerState.json) | JSON | 1 | 0 | 0 | 1 |
| [data/skills.json](/data/skills.json) | JSON | 180 | 0 | 0 | 180 |
| [data/waypoints.json](/data/waypoints.json) | JSON | 1 | 0 | 0 | 1 |
| [features/ai/agents/miner.cjs](/features/ai/agents/miner.cjs) | JavaScript | 608 | 69 | 93 | 770 |
| [features/ai/agents/minerCore.cjs](/features/ai/agents/minerCore.cjs) | JavaScript | 310 | 63 | 50 | 423 |
| [features/ai/agents/woodcutter.cjs](/features/ai/agents/woodcutter.cjs) | JavaScript | 62 | 1 | 16 | 79 |
| [features/ai/brain\_light.cjs](/features/ai/brain_light.cjs) | JavaScript | 411 | 70 | 73 | 554 |
| [features/ai/experience.cjs](/features/ai/experience.cjs) | JavaScript | 417 | 88 | 75 | 580 |
| [features/ai/goap.cjs](/features/ai/goap.cjs) | JavaScript | 42 | 4 | 11 | 57 |
| [features/ai/masterAI.cjs](/features/ai/masterAI.cjs) | JavaScript | 272 | 53 | 45 | 370 |
| [features/ai/policy.cjs](/features/ai/policy.cjs) | JavaScript | 38 | 2 | 11 | 51 |
| [features/ai/quantum/core.cjs](/features/ai/quantum/core.cjs) | JavaScript | 305 | 65 | 55 | 425 |
| [features/ai/quantum/decoherence.cjs](/features/ai/quantum/decoherence.cjs) | JavaScript | 186 | 71 | 50 | 307 |
| [features/ai/quantum/entanglement.cjs](/features/ai/quantum/entanglement.cjs) | JavaScript | 181 | 104 | 39 | 324 |
| [features/ai/quantum/index.cjs](/features/ai/quantum/index.cjs) | JavaScript | 191 | 23 | 39 | 253 |
| [features/ai/quantum/superposition.cjs](/features/ai/quantum/superposition.cjs) | JavaScript | 248 | 123 | 49 | 420 |
| [features/ai/quantum/test-quantum.js](/features/ai/quantum/test-quantum.js) | JavaScript | 38 | 25 | 9 | 72 |
| [features/ai/skillBrain.cjs](/features/ai/skillBrain.cjs) | JavaScript | 741 | 117 | 85 | 943 |
| [features/ai/telemetry.cjs](/features/ai/telemetry.cjs) | JavaScript | 16 | 2 | 8 | 26 |
| [features/ai/xpHelpers.cjs](/features/ai/xpHelpers.cjs) | JavaScript | 226 | 61 | 37 | 324 |
| [features/building/building.js](/features/building/building.js) | JavaScript | 479 | 75 | 69 | 623 |
| [features/building/smelting.js](/features/building/smelting.js) | JavaScript | 478 | 89 | 69 | 636 |
| [features/combat/advancedCombat.js](/features/combat/advancedCombat.js) | JavaScript | 802 | 60 | 147 | 1,009 |
| [features/combat/combat.js](/features/combat/combat.js) | JavaScript | 435 | 79 | 75 | 589 |
| [features/crafting/autoCrafter.js](/features/crafting/autoCrafter.js) | JavaScript | 222 | 42 | 40 | 304 |
| [features/crafting/crafting.js](/features/crafting/crafting.js) | JavaScript | 355 | 53 | 35 | 443 |
| [features/crafting/smartCraft.js](/features/crafting/smartCraft.js) | JavaScript | 191 | 43 | 28 | 262 |
| [features/economy/inventory.js](/features/economy/inventory.js) | JavaScript | 409 | 82 | 78 | 569 |
| [features/economy/trading.js](/features/economy/trading.js) | JavaScript | 658 | 26 | 75 | 759 |
| [features/environment/adaptive.cjs](/features/environment/adaptive.cjs) | JavaScript | 407 | 52 | 43 | 502 |
| [features/exploration/fun.js](/features/exploration/fun.js) | JavaScript | 773 | 102 | 120 | 995 |
| [features/exploration/humanMove.cjs](/features/exploration/humanMove.cjs) | JavaScript | 483 | 74 | 51 | 608 |
| [features/exploration/navigation.js](/features/exploration/navigation.js) | JavaScript | 129 | 47 | 24 | 200 |
| [features/exploration/structureExplorer.js](/features/exploration/structureExplorer.js) | JavaScript | 394 | 10 | 56 | 460 |
| [features/exploration/woodcutter.cjs](/features/exploration/woodcutter.cjs) | JavaScript | 121 | 4 | 18 | 143 |
| [features/leveling.js](/features/leveling.js) | JavaScript | 178 | 22 | 31 | 231 |
| [features/magic/brewing.js](/features/magic/brewing.js) | JavaScript | 380 | 75 | 49 | 504 |
| [features/magic/enchantments.js](/features/magic/enchantments.js) | JavaScript | 363 | 73 | 61 | 497 |
| [features/magic/spells.js](/features/magic/spells.js) | JavaScript | 201 | 40 | 35 | 276 |
| [features/mining/mining.js](/features/mining/mining.js) | JavaScript | 293 | 70 | 54 | 417 |
| [features/quests/levelingBridge.js](/features/quests/levelingBridge.js) | JavaScript | 41 | 13 | 9 | 63 |
| [features/quests/questSystem.js](/features/quests/questSystem.js) | JavaScript | 164 | 28 | 27 | 219 |
| [features/structures/structureManager.js](/features/structures/structureManager.js) | JavaScript | 808 | 65 | 73 | 946 |
| [features/utils.cjs](/features/utils.cjs) | JavaScript | 79 | 13 | 13 | 105 |
| [features/utils/fsx.js](/features/utils/fsx.js) | JavaScript | 17 | 0 | 4 | 21 |
| [features/utils/helpers.js](/features/utils/helpers.js) | JavaScript | 433 | 90 | 74 | 597 |
| [features/waypoints.cjs](/features/waypoints.cjs) | JavaScript | 189 | 24 | 31 | 244 |
| [index.cjs](/index.cjs) | JavaScript | 442 | 77 | 62 | 581 |
| [integrations/telegram.js](/integrations/telegram.js) | JavaScript | 356 | 36 | 50 | 442 |
| [integrations/telegramAutoCraft.js](/integrations/telegramAutoCraft.js) | JavaScript | 469 | 52 | 48 | 569 |
| [logs/combat-2025-11-09.log](/logs/combat-2025-11-09.log) | Log | 0 | 0 | 1 | 1 |
| [logs/core.bot-2025-11-09.log](/logs/core.bot-2025-11-09.log) | Log | 39 | 0 | 1 | 40 |
| [logs/miner-2025-11-09.log](/logs/miner-2025-11-09.log) | Log | 0 | 0 | 1 | 1 |
| [logs/session\_2025-11-09T09-36-26-882Z.log](/logs/session_2025-11-09T09-36-26-882Z.log) | Log | 6 | 0 | 1 | 7 |
| [logs/session\_2025-11-09T11-46-48-684Z.log](/logs/session_2025-11-09T11-46-48-684Z.log) | Log | 6 | 0 | 1 | 7 |
| [logs/telemetry-2025-11-09.log](/logs/telemetry-2025-11-09.log) | Log | 22 | 0 | 1 | 23 |
| [package-lock.json](/package-lock.json) | JSON | 4,676 | 0 | 1 | 4,677 |
| [package.json](/package.json) | JSON | 54 | 0 | 1 | 55 |
| [temp.env](/temp.env) | Dotenv | 43 | 27 | 10 | 80 |

[Summary](results.md) / Details / [Diff Summary](diff.md) / [Diff Details](diff-details.md)