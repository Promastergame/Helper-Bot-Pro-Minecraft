'use strict';
/**
 * features/ai/quantum/entanglement.cjs
 * 🔗 Запутанность/согласование состояний для всего ИИ-стека.
 *
 * Что умеет:
 *  • Пары и множества: entangle2 / entangleMany / consensusStep
 *  • Графовая запутанность: entangleGraph (узлы + взвешенные рёбра)
 *  • Плавная физика: dampedCouple (затухающий «пружинный» связчик)
 *  • Гистерезис: hysteresisLatch (устойчивые переключения)
 *  • Слияние распределений: coupleDists / entropyShrinkage / balanceAggressiveDefensive
 *  • Связи «мозг↔обучение↔энергия»: entangleMoodLearning / shareEnergy / coupleRates
 *  • Оценивание: fuseGaussians (байес-слияние 1D) / kalman1D (упрощённый)
 *
 * Без внешних зависимостей.
 */

// ──────────────────────────────────────────────────────────────────────────────
// БАЗА
// ──────────────────────────────────────────────────────────────────────────────
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
const lerp  = (a,b,t)=>a+(b-a)*t;

function _normWeights(arr){
  const out=[]; let s=0;
  for (const v of arr) s+=Math.max(0,Number(v)||0);
  if (s<=0) return arr.map(_=>1/Math.max(1,arr.length));
  for (const v of arr) out.push(Math.max(0,Number(v)||0)/s);
  return out;
}

function _normalizeObj(obj){
  const out={}; let s=0;
  for (const v of Object.values(obj)) s+=Math.max(0, Number(v)||0);
  if (s<=0) return {...obj};
  for (const [k,v] of Object.entries(obj)) out[k]=Math.max(0,Number(v)||0)/s;
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// 1) ПАРНАЯ/МНОЖЕСТВЕННАЯ ЗАПУТАННОСТЬ
// ──────────────────────────────────────────────────────────────────────────────

/** entangle2: мягко тянет a и b к их среднему; factor∈[0..1] — сила сближения */
function entangle2(a,b,factor=0.3){
  factor = clamp(factor,0,1);
  const avg=(a+b)/2;
  return [
    avg+(a-avg)*(1-factor),
    avg+(b-avg)*(1-factor),
  ];
}

/** entangleMany: согласует множество чисел к общему центру (веса опциональны) */
function entangleMany(values, factor=0.3, weights=null){
  if (!Array.isArray(values)||values.length===0) return [];
  const w = weights ? _normWeights(weights) : new Array(values.length).fill(1/values.length);
  // взвешенный центр
  let c=0; for (let i=0;i<values.length;i++) c+= (Number(values[i])||0)*w[i];
  const f = clamp(factor,0,1);
  return values.map(v => c + (v - c)*(1 - f));
}

/** consensusStep: один шаг среднего согласования (как в алгоритмах консенсуса) */
function consensusStep(values, neighbors, step=0.2){
  // neighbors: массив списков индексов соседей для каждого i
  const out = values.slice();
  for (let i=0;i<values.length;i++){
    const neigh = neighbors[i]||[];
    if (!neigh.length) continue;
    let m=0; for (const j of neigh) m += Number(values[j])||0;
    m /= neigh.length;
    out[i] = values[i] + clamp(step,0,1)*(m - values[i]);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// 2) ГРАФОВАЯ ЗАПУТАННОСТЬ
// ──────────────────────────────────────────────────────────────────────────────

/**
 * entangleGraph(nodes, edges, factor, iters)
 * nodes: number[] (значения узлов)
 * edges: [{i,j,w}] — связь между i и j с весом w (0..1)
 * factor: сила стягивания по ребру
 * iters: число итераций согласования
 */
function entangleGraph(nodes, edges=[], factor=0.2, iters=1){
  let vals = nodes.slice();
  const F = clamp(factor,0,1);
  for (let t=0;t<Math.max(1, iters); t++){
    const delta = new Array(vals.length).fill(0);
    const degree = new Array(vals.length).fill(0);
    for (const e of edges){
      const i=e.i|0, j=e.j|0, w=clamp(Number(e.w)||0,0,1);
      if (i===j||w<=0) continue;
      const avg = (vals[i]+vals[j])/2;
      delta[i] += (avg - vals[i]) * w;
      delta[j] += (avg - vals[j]) * w;
      degree[i]+=w; degree[j]+=w;
    }
    for (let k=0;k<vals.length;k++){
      if (degree[k]>0) vals[k] += F * (delta[k]/degree[k]);
    }
  }
  return vals;
}

// ──────────────────────────────────────────────────────────────────────────────
// 3) ПЛАВНАЯ ФИЗИКА СВЯЗИ (пружина с демпфированием)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * dampedCouple(x, target, v, dt, {omega, zeta})
 *  • x — текущее значение; target — цель; v — «скорость» (состояние)
 *  • dt — шаг времени (сек)
 *  • omega — собственная частота (рад/с), zeta — демпфирование (0..1+)
 * Возвращает { x, v } — новое значение и скорость.
 * Формула классического критически/слабо демпфированного осциллятора.
 */
function dampedCouple(x, target, v=0, dt=0.05, { omega=6, zeta=0.8 }={}){
  const k = omega*omega;
  const c = 2*zeta*omega;
  const a = -k*(x - target) - c*v;
  const v2 = v + a*dt;
  const x2 = x + v2*dt;
  return { x: x2, v: v2 };
}

// ──────────────────────────────────────────────────────────────────────────────
// 4) ГИСТЕРЕЗИС ДЛЯ УСТОЙЧИВЫХ ПЕРЕКЛЮЧЕНИЙ
// ──────────────────────────────────────────────────────────────────────────────

/**
 * hysteresisLatch(prevState, value, low, high)
 *  • если было 0 — включится только если value>=high
 *  • если было 1 — выключится только если value<=low
 */
function hysteresisLatch(prevState, value, low=0.3, high=0.7){
  if (prevState) return value <= low ? 0 : 1;
  return value >= high ? 1 : 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// 5) СЛИЯНИЕ РАСПРЕДЕЛЕНИЙ/СТРАТЕГИЙ
// ──────────────────────────────────────────────────────────────────────────────

/** coupleDists(A,B,alpha): смешивает два распределения (объекты с весами) */
function coupleDists(A, B, alpha=0.5){
  alpha = clamp(alpha,0,1);
  const keys = new Set([...Object.keys(A||{}), ...Object.keys(B||{})]);
  const out = {};
  for (const k of keys){
    const a = Math.max(0, Number(A?.[k])||0);
    const b = Math.max(0, Number(B?.[k])||0);
    out[k] = (1-alpha)*a + alpha*b;
  }
  return _normalizeObj(out);
}

/** entropyShrinkage: «приплющивает» распределение к равномерному (λ сила) */
function entropyShrinkage(dist, lambda=0.1){
  const keys = Object.keys(dist||{});
  if (!keys.length) return {};
  const uni = 1/keys.length;
  const out={};
  for (const k of keys){
    const p = Math.max(0, Number(dist[k])||0);
    out[k] = (1-lambda)*p + lambda*uni;
  }
  return _normalizeObj(out);
}

/**
 * balanceAggressiveDefensive(weights, aggrKeys, defKeys, s∈[0..1])
 *  • s>0.5 → усиливаем агрессию, s<0.5 → усиление защиты
 */
function balanceAggressiveDefensive(weights, aggrKeys, defKeys, s=0.5, maxShift=0.25){
  const W = {...weights};
  const shiftA =  2*maxShift*(s-0.5); // -max..+max
  const shiftD = -shiftA/2;           // помягче компенсируем защитой
  for (const k of Object.keys(W)){
    if (aggrKeys.includes(k)) W[k] = Math.max(0, W[k]*(1 + shiftA));
    if (defKeys.includes(k))  W[k] = Math.max(0, W[k]*(1 + shiftD));
  }
  return _normalizeObj(W);
}

// ──────────────────────────────────────────────────────────────────────────────
// 6) «МОЗГ ↔ ОБУЧЕНИЕ ↔ ЭНЕРГИЯ»
// ──────────────────────────────────────────────────────────────────────────────

/** entangleMoodLearning: связывает уровень «настроение» и «скорость обучения» */
function entangleMoodLearning(mood, learningRate, factor=0.3){
  const [m, lr] = entangle2(mood, learningRate, factor);
  // небольшая биас-правка: хорошее настроение слегка повышает lr
  const boost = clamp((m - 0.5)*0.1, -0.05, 0.08);
  return [clamp(m,0,1), clamp(lr + boost, 0.05, 5.0)];
}

/** shareEnergy: мягко делится энергией между подсистемами по важности */
function shareEnergy(energies, priorities){
  if (!Array.isArray(energies)||energies.length===0) return [];
  const P=_normWeights(priorities||new Array(energies.length).fill(1));
  const total = energies.reduce((s,x)=>s+(Number(x)||0),0);
  // целевая распределённость — по приоритетам
  const target = P.map(p => p*total);
  // один шаг тяготения к target
  return entangleMany(energies, 0.25, P).map((x,i)=> clamp(x + 0.4*(target[i]-x), 0, total));
}

/** coupleRates: согласует несколько «скоростей» обучений/охлаждений */
function coupleRates(rates, factor=0.25, min=0.05, max=5.0){
  const out = entangleMany(rates, factor);
  return out.map(x=>clamp(x, min, max));
}

// ──────────────────────────────────────────────────────────────────────────────
// 7) ОЦЕНИВАНИЕ: ГАУССОВО СЛИЯНИЕ И ПРОСТОЙ КАЛМАН 1D
// ──────────────────────────────────────────────────────────────────────────────

/** fuseGaussians: объединяет две 1D-оценки (m, v) как байес с независимыми шумами */
function fuseGaussians(m1, v1, m2, v2){
  v1=Math.max(1e-9, Number(v1)||1); v2=Math.max(1e-9, Number(v2)||1);
  const w1 = 1/v1, w2 = 1/v2;
  const m = (w1*m1 + w2*m2) / (w1 + w2);
  const v = 1 / (w1 + w2);
  return { mean:m, var:v };
}

/**
 * kalman1D(state, { processVar, measureVar, measure })
 *  • state: { mean, var } (если нет — инициализирует)
 *  • processVar: дисперсия процесса (шум модели)
 *  • measureVar: дисперсия измерения
 *  • measure: новое измерение
 */
function kalman1D(state, { processVar=1e-2, measureVar=1e-1, measure=null }={}){
  let mean = Number(state?.mean)||0;
  let v    = Math.max(1e-9, Number(state?.var)||1);

  // предсказание (модель x' = x, v' = v + q)
  v += Math.max(1e-12, processVar);

  if (measure!=null){
    const r = Math.max(1e-12, measureVar);
    const K = v / (v + r);        // Калмановский коэффициент
    mean = mean + K*(measure - mean);
    v = (1 - K)*v;
  }

  return { mean, var: v, K: v/(v + Math.max(1e-12, measureVar)) };
}

// ──────────────────────────────────────────────────────────────────────────────
// 8) УТИЛИТЫ ДЛЯ ИНТЕГРАЦИИ С ПОДСИСТЕМАМИ
// ──────────────────────────────────────────────────────────────────────────────

/**
 * coupleWithHysteresis:
 *  • тянем value к target (entangle2), но переключатели (напр. «в бой»/«из боя»)
 *    решаются через гистерезис на основании score∈[0..1].
 */
function coupleWithHysteresis(value, target, score, low=0.35, high=0.65, factor=0.3){
  const [v] = entangle2(value, target, factor);
  const on = hysteresisLatch(score>=high ? 1 : score<=low ? 0 : (score>=(low+high)/2?1:0), score, low, high);
  return { value: v, on };
}

/** vectorEntangle3: «векторная» запутанность для 3D (позиции/скорости) */
function vectorEntangle3(A, B, factor=0.25){
  factor = clamp(factor,0,1);
  const avg = [(A[0]+B[0])/2, (A[1]+B[1])/2, (A[2]+B[2])/2];
  const outA = [
    avg[0] + (A[0]-avg[0])*(1-factor),
    avg[1] + (A[1]-avg[1])*(1-factor),
    avg[2] + (A[2]-avg[2])*(1-factor),
  ];
  const outB = [
    avg[0] + (B[0]-avg[0])*(1-factor),
    avg[1] + (B[1]-avg[1])*(1-factor),
    avg[2] + (B[2]-avg[2])*(1-factor),
  ];
  return [outA, outB];
}

// ──────────────────────────────────────────────────────────────────────────────
// ЭКСПОРТ
// ──────────────────────────────────────────────────────────────────────────────

module.exports = {
  // базовые
  clamp, lerp,

  // парная/множественная/графовая запутанность
  entangle2,
  entangleMany,
  consensusStep,
  entangleGraph,

  // физика
  dampedCouple,

  // устойчивые режимы
  hysteresisLatch,
  coupleWithHysteresis,

  // распределения и балансы
  coupleDists,
  entropyShrinkage,
  balanceAggressiveDefensive,

  // мозг ↔ обучение ↔ энергия
  entangleMoodLearning,
  shareEnergy,
  coupleRates,
  vectorEntangle3,

  // оценивание
  fuseGaussians,
  kalman1D,
};
