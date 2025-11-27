'use strict';
/**
 * features/ai/quantum/superposition.cjs
 * 📦 Вероятностные и «квантовые» методы выбора/поиска:
 *  • softmax / Gumbel-Softmax / Boltzmann exploration
 *  • ансамблевое голосование (majority / weighted)
 *  • Dirichlet/Гамма-семплинг для «сглаженных» распределений
 *  • частицный фильтр (particle filter) для скрытых состояний
 *  • beam search (пучковый) и легковесный MCTS (Монте-Карло поиск)
 *  • rollout-планировщик сценариев с наградой
 *  • Mixture-of-Experts (смешивание экспертов) + temperature annealing
 *
 * Без зависимостей. Опционально дружит с ./core.cjs (Q).
 */

let Q; // подключим лениво и опционально
try { Q = require('./core.cjs'); } catch { /* допускаем независимое использование */ }

// ──────────────────────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ
// ──────────────────────────────────────────────────────────────────────────────

function _rand(){ return Q?.quantumRandom ? Q.quantumRandom() : Math.random(); }
const _clamp = (x,a,b)=> Math.max(a, Math.min(b, x));

function _normalize(obj){
  const out = {}; let s = 0;
  for (const v of Object.values(obj)) s += Math.max(0, Number(v)||0);
  if (s <= 0) return { ...obj };
  for (const [k,v] of Object.entries(obj)) out[k] = Math.max(0, Number(v)||0) / s;
  return out;
}

function _softmax(scores, temperature=1.0){
  const t = Math.max(1e-6, temperature);
  const max = Math.max(...Object.values(scores).map(Number));
  const exps = {}; let sum = 0;
  for (const [k,v] of Object.entries(scores)){
    const e = Math.exp((Number(v)-max)/t);
    exps[k] = e; sum += e;
  }
  const out = {}; for (const [k,e] of Object.entries(exps)) out[k] = e / sum;
  return out;
}

function _pickCategorical(weights){
  const arr = Object.entries(weights).filter(([,w])=>w>0);
  if (!arr.length) return null;
  let s=0; for (const [,w] of arr) s+=w;
  let r = _rand() * s, acc=0;
  for (const [k,w] of arr){ acc+=w; if (r<=acc) return k; }
  return arr.at(-1)[0];
}

// Gumbel(0,1) семпл через -ln(-ln(U))
function _gumbel(){
  const u = Math.max(1e-12, _rand());
  return -Math.log(-Math.log(u));
}

// ──────────────────────────────────────────────────────────────────────────────
// ОСНОВНЫЕ ФУНКЦИИ ВЫБОРА
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Boltzmann/Softmax выбор.
 * scores: {action: score}, temperature > 0
 */
function softmaxChoice(scores, temperature=1.0){
  const p = _softmax(scores, temperature);
  return { probs: p, choice: _pickCategorical(p) };
}

/**
 * Gumbel-Softmax (sample-argmax): дифференцируемый трик в ML, тут — для стохастического argmax.
 * Чем ниже temperature, тем «жестче» выбор.
 */
function gumbelSoftmaxChoice(scores, temperature=1.0){
  const t = Math.max(1e-6, temperature);
  let bestK=null, bestV=-Infinity;
  for (const [k, v] of Object.entries(scores)){
    const g = _gumbel();
    const val = (Number(v) + g) / t;
    if (val > bestV){ bestV = val; bestK = k; }
  }
  // вероятности можно вернуть как softmax для прозрачности
  const probs = _softmax(scores, temperature);
  return { probs, choice: bestK };
}

/**
 * Случай с плавным «охлаждением» температуры (annealing).
 * step — номер шага, k — скорость охлаждения.
 */
function softmaxAnneal(scores, step, { T0=1.0, k=0.01 }={}){
  const T = Math.max(1e-4, T0 * Math.exp(-k * step));
  return softmaxChoice(scores, T);
}

// ──────────────────────────────────────────────────────────────────────────────
/** Ансамблевые голоса: несколько «моделей» выдают распределения или баллы */
// ──────────────────────────────────────────────────────────────────────────────

/**
 * majorityVote: массив выборов ['attack','dodge',...] → победитель
 */
function majorityVote(choices){
  const c = {};
  for (const ch of choices) c[ch] = (c[ch]||0) + 1;
  let best=null, bestN=-1;
  for (const [k,n] of Object.entries(c)){ if (n>bestN){ bestN=n; best=k; } }
  return best;
}

/**
 * weightedEnsemble:
 * distList: [{attack:0.6,dodge:0.4}, {...}, ...]
 * weights:  [0.5, 0.3, 0.2]  (если не дано — поровну)
 * Возвращает объединённое распределение.
 */
function weightedEnsemble(distList, weights=null){
  if (!Array.isArray(distList) || !distList.length) return {};
  const w = Array.isArray(weights) && weights.length===distList.length
    ? weights.slice()
    : new Array(distList.length).fill(1 / distList.length);
  const acc = {};
  for (let i=0;i<distList.length;i++){
    const d = _normalize(distList[i]);
    const ww = Math.max(0, Number(w[i])||0);
    for (const [k,p] of Object.entries(d)) acc[k] = (acc[k]||0) + ww*p;
  }
  return _normalize(acc);
}

// ──────────────────────────────────────────────────────────────────────────────
/** Dirichlet / Gamma вспомогательные (для семплинга сглаженных распределений) */
// ──────────────────────────────────────────────────────────────────────────────

function _gammaSample(shape){
  // простая аппроксимация: сумма экспонент (подходит для shape>=1), для <1 — грубая коррекция
  const k = Math.max(1, Math.floor(shape));
  let sum=0; for(let i=0;i<k;i++) sum += -Math.log(Math.max(1e-12, _rand()));
  const frac = shape - k; if (frac>1e-6) sum += -Math.log(Math.max(1e-12, _rand())) * frac;
  return Math.max(1e-9, sum);
}

/** sampleDirichlet({key: alpha_k}) → probs по Дирихле */
function sampleDirichlet(alpha){
  const out = {}; let sum=0;
  for (const [k,a] of Object.entries(alpha)){
    const g = _gammaSample(Math.max(1e-3, Number(a)||1));
    out[k] = g; sum += g;
  }
  for (const k of Object.keys(out)) out[k] /= sum;
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
/** Частицный фильтр — отслеживание скрытых состояний по наблюдениям */
// ──────────────────────────────────────────────────────────────────────────────

/**
 * particleFilter:
 *  - init(n) → массив частиц (пользователь задаёт)
 *  - predict(p) → новая частица из старой (динамика)
 *  - weight(p, obs) → вес частицы при текущем наблюдении
 *  - resample: систематический
 */
function particleFilter({ particles, predict, weight, observation, resample=true }){
  if (!Array.isArray(particles) || !particles.length) return [];
  // predict
  const pred = particles.map(p => predict(p));
  // weight
  let w = []; let sum=0;
  for (let i=0;i<pred.length;i++){
    const ww = Math.max(0, Number(weight(pred[i], observation))||0);
    w[i] = ww; sum += ww;
  }
  if (sum <= 0) return pred; // без информации
  // normalize
  for (let i=0;i<w.length;i++) w[i] /= sum;
  if (!resample) return pred.map((p,i)=>({ ...p, _w: w[i] }));

  // систематический ресемплинг
  const N = pred.length;
  const out = new Array(N);
  const step = 1 / N;
  let u = _rand() * step;
  let acc = w[0], idx = 0;
  for (let i=0;i<N;i++){
    while (u > acc){ idx++; acc += w[idx] || 0; if (idx>=N){ idx=N-1; break; } }
    out[i] = pred[idx];
    u += step;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
/** Beam Search (пучковый) — наилучшие топ-k последовательностей действий */
// ──────────────────────────────────────────────────────────────────────────────

/**
 * beamSearch(stepFn, { start, width, depth }):
 *  - stepFn(state) → [{ state, action, scoreDelta }]
 *  - на каждом шаге оставляет только top-width по суммарному score
 */
function beamSearch(stepFn, { start, width=3, depth=4 }){
  let beam = [{ state: start, actions: [], score: 0 }];
  for (let d=0; d<depth; d++){
    const next = [];
    for (const node of beam){
      const outs = stepFn(node.state) || [];
      for (const o of outs){
        next.push({
          state: o.state,
          actions: node.actions.concat(o.action),
          score: node.score + (Number(o.scoreDelta)||0)
        });
      }
    }
    // top-k
    next.sort((a,b)=> b.score - a.score);
    beam = next.slice(0, Math.max(1, width));
    if (!beam.length) break;
  }
  // лучший
  beam.sort((a,b)=> b.score - a.score);
  return beam[0] || null;
}

// ──────────────────────────────────────────────────────────────────────────────
/** Лёгкий MCTS (UCT) — когда есть симулятор награды */
// ──────────────────────────────────────────────────────────────────────────────

function _uctValue(parentVisits, nodeWins, nodeVisits, c=1.414){
  if (nodeVisits === 0) return Infinity;
  const mean = nodeWins / nodeVisits;
  return mean + c * Math.sqrt(Math.log(Math.max(1, parentVisits)) / nodeVisits);
}

/**
 * mcts:
 *  - rootState
 *  - expand(state) → [{action, nextState}]
 *  - rollout(state) → reward (стохастическая симуляция до конца)
 *  - isTerminal(state) → boolean
 *  - iterations, explorationC (UCT параметр), timeLimitMs (опционально)
 * Возвращает { action, stats }, где action — лучшая на корне.
 */
function mcts({ rootState, expand, rollout, isTerminal, iterations=200, explorationC=1.414, timeLimitMs=0 }){
  const startTs = Date.now();

  const Node = (state, parent=null, parentAction=null)=>({
    state, parent, parentAction,
    children: [],
    visits: 0,
    wins: 0, // суммарная награда
    untried: expand(state) || []
  });

  const root = Node(rootState);

  function select(node){
    while (node.untried.length===0 && node.children.length){
      // выбрать по UCT
      let best=null, bestV=-Infinity;
      for (const ch of node.children){
        const v = _uctValue(node.visits, ch.wins, ch.visits, explorationC);
        if (v>bestV){ bestV=v; best=ch; }
      }
      node = best;
    }
    return node;
  }

  function expandOne(node){
    if (!node.untried.length) return node;
    const i = Math.floor(_rand() * node.untried.length);
    const { action, nextState } = node.untried.splice(i,1)[0];
    const child = Node(nextState, node, action);
    node.children.push(child);
    return child;
  }

  function rolloutSim(node){
    let s = node.state;
    // быстрый стохастический спуск
    let depth = 0;
    while (!isTerminal(s) && depth < 128){
      const outs = expand(s) || [];
      if (!outs.length) break;
      const pick = outs[Math.floor(_rand()*outs.length)];
      s = pick.nextState;
      depth++;
    }
    return Number(rollout(s)) || 0;
  }

  function backprop(node, reward){
    while (node){
      node.visits += 1;
      node.wins += reward;
      node = node.parent;
    }
  }

  let it = 0;
  while (it < iterations){
    if (timeLimitMs > 0 && Date.now() - startTs > timeLimitMs) break;

    // 1) select
    let node = select(root);
    // 2) expand
    if (node.untried.length) node = expandOne(node);
    // 3) rollout
    const reward = rolloutSim(node);
    // 4) backprop
    backprop(node, reward);

    it++;
  }

  // выбрать лучшего ребёнка по среднему вознаграждению
  let best=null, bestV=-Infinity;
  for (const ch of root.children){
    const v = ch.visits>0 ? ch.wins/ch.visits : -Infinity;
    if (v>bestV){ bestV=v; best=ch; }
  }

  const stats = root.children.map(ch=>({
    action: ch.parentAction,
    visits: ch.visits,
    meanReward: ch.visits>0 ? ch.wins/ch.visits : 0
  })).sort((a,b)=> b.meanReward - a.meanReward);

  return { action: best?.parentAction ?? null, stats, iterations: it };
}

// ──────────────────────────────────────────────────────────────────────────────
/** Rollout-планировщик: многократные симуляции и усреднение награды */
// ──────────────────────────────────────────────────────────────────────────────

/**
 * rolloutPlanner:
 *  candidates: [{ action, simulate: (rng)=> reward }]
 *  trials: сколько прогонов на кандидата
 *  Возвращает { action, meanRewards: {a: r}, trials }.
 */
function rolloutPlanner(candidates, trials=64){
  const means = {};
  for (const c of candidates){
    let sum=0;
    for (let i=0;i<trials;i++){
      sum += Number(c.simulate(_rand)) || 0;
    }
    means[c.action] = sum / trials;
  }
  // победитель
  let best=null, bestV=-Infinity;
  for (const [k,v] of Object.entries(means)){
    if (v>bestV){ bestV=v; best=k; }
  }
  return { action: best, meanRewards: means, trials };
}

// ──────────────────────────────────────────────────────────────────────────────
/** Mixture-of-Experts: смешивание нескольких «экспертов» по весам/температуре */
// ──────────────────────────────────────────────────────────────────────────────

/**
 * mixtureOfExperts:
 *  experts: [{ name, scores: {a:..}, weight }]
 *  temperature: для мягкого сглаживания
 *  returns { probs, choice }
 */
function mixtureOfExperts(experts, temperature=1.0){
  if (!Array.isArray(experts) || !experts.length) return { probs:{}, choice:null };
  // нормализуем веса экспертов
  const wSum = experts.reduce((s,e)=> s + Math.max(0, Number(e.weight??1)), 0) || 1;
  // агрегируем логиты (веса * оценки), затем softmax
  const agg = {};
  for (const e of experts){
    const w = Math.max(0, Number(e.weight??1)) / wSum;
    for (const [k,v] of Object.entries(e.scores||{})){
      agg[k] = (agg[k]||0) + w * Number(v||0);
    }
  }
  const probs = _softmax(agg, temperature);
  return { probs, choice: _pickCategorical(probs) };
}

// ──────────────────────────────────────────────────────────────────────────────
// ЭКСПОРТ
// ──────────────────────────────────────────────────────────────────────────────

module.exports = {
  // базовые стохастические выборы
  softmaxChoice,
  gumbelSoftmaxChoice,
  softmaxAnneal,

  // ансамбли
  majorityVote,
  weightedEnsemble,

  // сглаженные распределения
  sampleDirichlet,

  // фильтр частиц
  particleFilter,

  // поиски/планирование
  beamSearch,
  mcts,
  rolloutPlanner,

  // mixture-of-experts
  mixtureOfExperts,
};
