'use strict';

// Подключаем твой фасад
const Q = require('./index.cjs');

// ──────────────────────────────
// Базовые тесты RNG
// ──────────────────────────────
console.log('⚙️ Quantum facade v' + Q.version);
console.log('Random float:', Q.quantumRandom());
console.log('RandInt 1–10:', Q.randInt(1, 10));
console.log('RandSign:', Q.randSign());

// ──────────────────────────────
// Пример конфигурации RNG
// ──────────────────────────────
Q.configure({ rng: 'seed', seed: 'demo-seed' });
console.log('🎲 Seeded quantum randoms:');
for (let i = 0; i < 5; i++) {
  console.log('  →', Q.quantumRandom().toFixed(6));
}

// ──────────────────────────────
// Mixture of Experts
// ──────────────────────────────
const experts = [
  { name: 'builder', weight: 0.6, scores: { mine: 0.2, build: 0.8 } },
  { name: 'miner',   weight: 0.4, scores: { mine: 0.9, build: 0.1 } }
];
const mix = Q.mixtureOfExperts(experts, 1.0);
console.log('\n🧩 Mixture of Experts:', mix.probs);

// ──────────────────────────────
// Collapse (вероятностный выбор)
// ──────────────────────────────
const action = Q.collapse(mix.probs);
console.log('🎯 Collapsed action →', action);

// ──────────────────────────────
// Температурные расписания
// ──────────────────────────────
console.log('\n🔥 Temperature schedule demo:');
for (let step = 0; step <= 5000; step += 1000) {
  console.log(` step=${step} → T=${Q.scheduleTemperature(step).toFixed(3)}`);
}

// ──────────────────────────────
// Улучшенная симуляция температуры
// ──────────────────────────────
console.log('\n🌡 Improved temperature simulation:');
for (let step = 0; step <= 12000; step += 1000) {
  console.log(` step=${step} → T=${Q.scheduleTemperature(step, { T0: 1.1, floor: 0.6, k: 0.002, amplitude: 0.6, noise: 0.05 }).toFixed(3)}`);
}

// ──────────────────────────────
// Энтропия (если есть)
// ──────────────────────────────
if (typeof Q.measureEntropy === 'function') {
  const e = Q.measureEntropy({ a: 0.7, b: 0.3 });
  console.log('\n🧠 Entropy test:', e);
}

// ──────────────────────────────
// Человеческие задержки / паузы
// ──────────────────────────────
(async () => {
  console.log('\n⏱  Testing humanDelay...');
  const t0 = Date.now();
  await Q.humanDelay(500);
  const dt = Date.now() - t0;
  console.log('  Done after', dt, 'ms (примерно 0.5с)');
})();