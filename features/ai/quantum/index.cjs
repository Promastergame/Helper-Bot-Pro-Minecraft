'use strict';
/**
 * features/ai/quantum/index.cjs
 * 🧩 Фасад квантового стека: core + superposition + entanglement + decoherence.
 * v1.1.0 — lazy-safe импорты, scoped/withConfig, measureEntropy алиас, freeze().
 */

// ── Lazy-safe require с заглушками ───────────────────────────────────────────
function safeReq(path, fallback = {}) {
  try { return require(path); } catch { return fallback; }
}

const core         = safeReq('./core.cjs',         {});
const superpos     = safeReq('./superposition.cjs', {});
const entanglement = safeReq('./entanglement.cjs',  {});
const decoherence  = safeReq('./decoherence.cjs',   {});

// короткие ноопы (если модуль не найден)
const noop = () => {};
const N    = Number;

// Версия фасада
const VERSION = '1.1.0';

// ── Плоский API (с мягкими fallback’ами) ─────────────────────────────────────
const API = {
  // meta
  version: VERSION,

  // CORE
  setSeed        : core.setSeed        || noop,
  setRngMode     : core.setRngMode     || noop,
  quantumRandom  : core.quantumRandom  || (() => Math.random()),
  randInt        : core.randInt        || ((a,b)=>Math.floor(a + Math.random()*(b-a+1))),
  randSign       : core.randSign       || (() => (Math.random()<0.5?-1:1)),

  clamp          : core.clamp          || ((x,a,b)=>Math.max(a,Math.min(b,x))),
  mapRange       : core.mapRange       || ((x,a,b,c,d)=>c+(d-c)*((x-a)/(b-a))),
  lerp           : core.lerp           || ((a,b,t)=>a+(b-a)*t),
  Vec2           : core.Vec2           || function Vec2(x=0,y=0){this.x=x;this.y=y;},
  Vec3           : core.Vec3           || function Vec3(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;},

  uniform        : core.uniform        || ((a=0,b=1)=>a+Math.random()*(b-a)),
  exponential    : core.exponential    || ((l=1)=>-Math.log(1-Math.random())/l),
  normal         : core.normal         || ((m=0,s=1)=>{ // Box-Muller
                      const u1=Math.random()||1e-9,u2=Math.random();
                      return m+s*Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);
                    }),
  bernoulli      : core.bernoulli      || ((p=0.5)=>Math.random()<p),
  categorical    : core.categorical    || ((weights={})=>{
                      let s=0;for(const v of Object.values(weights)) s+=N(v)||0;
                      let r=(Math.random()* (s||1));
                      for(const [k,v] of Object.entries(weights)){ r-=N(v)||0; if(r<=0) return k; }
                      return Object.keys(weights)[0] ?? null;
                    }),

  superposition  : core.superposition  || ((s)=>s),
  decohere       : core.decohere       || ((s)=>s),
  entangle       : core.entangle       || ((a,b)=>[a,b]),
  entangleVec2   : core.entangleVec2   || ((a,b)=>[a,b]),

  Easing         : core.Easing         || { linear:t=>t },
  humanMicroPause: core.humanMicroPause|| (async()=>{}),
  humanTimingScale:core.humanTimingScale||(()=>1),
  humanJitter2D  : core.humanJitter2D  || ((v)=>v),
  humanJitter3D  : core.humanJitter3D  || ((v)=>v),
  smoothPath     : core.smoothPath     || ((p)=>p),
  humanTrajectory3D: core.humanTrajectory3D || ((a,b)=>[a,b]),
  planHumanSteps : core.planHumanSteps || ((a,b)=>[a,b]),

  sleep          : core.sleep          || (ms=>new Promise(r=>setTimeout(r,ms))),
  humanDelay     : core.humanDelay     || (ms=>new Promise(r=>setTimeout(r,ms))),
  throttle       : core.throttle       || ((fn)=>fn),
  debounce       : core.debounce       || ((fn)=>fn),
  rateLimiter    : core.rateLimiter    || ((fn)=>fn),

  emaUpdate      : core.emaUpdate      || ((p,x,a)=>a*x+(1-a)*p),
  welfordAdd     : core.welfordAdd     || noop,
  welfordVar     : core.welfordVar     || (()=>0),
  updateLearningRate: core.updateLearningRate || ((lr)=>lr),
  thompsonBeta   : core.thompsonBeta   || ((a,b)=>a/(a+b)),
  ucb1           : core.ucb1           || ((avg,cnt,tot)=>avg+Math.sqrt(2*Math.log(Math.max(1,tot))/Math.max(1,cnt))),
  acceptAnnealing: core.acceptAnnealing|| ((d,T)=>d>=0||Math.random()<Math.exp(d/(T||1))),
  temperatureSchedule: core.temperatureSchedule || ((t)=>1),
  normalizeWeights: core.normalizeWeights || (w=>w),
  updateWeight   : core.updateWeight   || ((w,k,v)=>{w[k]=v;return w;}),

  onDecision     : core.onDecision     || noop,

  // SUPERPOSITION
  softmaxChoice      : superpos.softmaxChoice      || ((s)=>API.categorical(s)),
  gumbelSoftmaxChoice: superpos.gumbelSoftmaxChoice|| ((s)=>API.softmaxChoice(s)),
  softmaxAnneal      : superpos.softmaxAnneal      || ((s)=>s),

  majorityVote   : superpos.majorityVote   || ((arr)=>arr[0]),
  weightedEnsemble: superpos.weightedEnsemble|| ((arr)=>arr?.[0]??null),

  sampleDirichlet: superpos.sampleDirichlet || ((a)=>a),
  particleFilter : superpos.particleFilter  || ((p)=>p),

  beamSearch     : superpos.beamSearch      || ((...x)=>x),
  mcts           : superpos.mcts            || ((...x)=>x),
  rolloutPlanner : superpos.rolloutPlanner  || ((...x)=>x),

  mixtureOfExperts: superpos.mixtureOfExperts || ((experts)=>({
    probs: (()=>{
      const acc={}; let wsum=0;
      for(const ex of experts||[]){ const w=N(ex.weight)||0; wsum+=w;
        for(const [k,v] of Object.entries(ex.scores||{})) acc[k]=(acc[k]||0)+w*(N(v)||0);
      }
      if (wsum>0) for(const k of Object.keys(acc)) acc[k]/=wsum;
      let s=0; for(const v of Object.values(acc)) s+=Math.max(0,N(v)||0);
      const out={}; if(s>0) for(const [k,v] of Object.entries(acc)) out[k]=Math.max(0,N(v)||0)/s;
      return out;
    })()
  })),

  // ENTANGLEMENT
  entangle2       : entanglement.entangle2       || ((a,b)=>[a,b]),
  entangleMany    : entanglement.entangleMany    || ((xs)=>xs),
  consensusStep   : entanglement.consensusStep   || ((x)=>x),
  entangleGraph   : entanglement.entangleGraph   || ((g)=>g),

  dampedCouple    : entanglement.dampedCouple    || ((a,b)=>[a,b]),
  hysteresisLatch : entanglement.hysteresisLatch || ((x)=>x),
  coupleWithHysteresis: entanglement.coupleWithHysteresis || ((a,b)=>[a,b]),
  coupleDists     : entanglement.coupleDists     || ((a,b)=>[a,b]),
  entropyShrinkage: entanglement.entropyShrinkage|| ((p)=>p),
  balanceAggressiveDefensive: entanglement.balanceAggressiveDefensive || ((s)=>s),

  entangleMoodLearning: entanglement.entangleMoodLearning || ((x)=>x),
  shareEnergy         : entanglement.shareEnergy          || ((x)=>x),
  coupleRates         : entanglement.coupleRates          || ((x)=>x),
  vectorEntangle3     : entanglement.vectorEntangle3      || ((x)=>x),

  fuseGaussians  : entanglement.fuseGaussians  || ((a,b)=>[a,b]),
  kalman1D       : entanglement.kalman1D       || ((x)=>x),

  // DECOHERENCE
  noiseUniform   : decoherence.noiseUniform    || ((x)=>x),
  noiseNormal    : decoherence.noiseNormal     || ((x)=>x),
  noiseLaplace   : decoherence.noiseLaplace    || ((x)=>x),
  brownianStep   : decoherence.brownianStep    || ((x)=>x),
  ornsteinUhlenbeck: decoherence.ornsteinUhlenbeck || ((x)=>x),

  collapse       : decoherence.collapse       || ((p)=>API.categorical(p)),
  sharpen        : decoherence.sharpen        || ((p)=>p),
  soften         : decoherence.soften         || ((p)=>p),
  labelSmoothing : decoherence.labelSmoothing || ((p)=>p),

  stochasticRound: decoherence.stochasticRound|| ((x)=>Math.round(x)),
  quantizeWithDither: decoherence.quantizeWithDither || ((x)=>x),

  randomMask     : decoherence.randomMask     || ((n)=>Array(n).fill(1)),
  dropout        : decoherence.dropout        || ((x)=>x),

  decayExp       : decoherence.decayExp       || ((x)=>x),
  decayWeights   : decoherence.decayWeights   || ((x)=>x),
  decayMemory    : decoherence.decayMemory    || ((x)=>x),

  renormSafe     : decoherence.renormSafe     || ((p)=>p),
  entropy        : decoherence.entropy        || ((p)=>0),
  mixWithEntropyCap: decoherence.mixWithEntropyCap || ((a,b)=>a),

  scheduleTemperature: decoherence.scheduleTemperature || ((t)=>1),
  scheduleEpsilon    : decoherence.scheduleEpsilon    || ((t)=>0),
  scheduleLinear     : decoherence.scheduleLinear     || ((t)=>t),
  scheduleCosine     : decoherence.scheduleCosine     || ((t)=>t),
  schedulePoly       : decoherence.schedulePoly       || ((t)=>t),

  nanGuard       : decoherence.nanGuard       || ((x)=>x),
  stabilityClamp : decoherence.stabilityClamp || ((x)=>x),
  safeMix        : decoherence.safeMix        || ((a,b)=>a),

  noiseVec3      : decoherence.noiseVec3      || ((v)=>v),
  jitterPath3D   : decoherence.jitterPath3D   || ((p)=>p),
  ouFilterPath3D : decoherence.ouFilterPath3D || ((p)=>p),
};

// ── Удобные хелперы фасада ───────────────────────────────────────────────────
function configure({ rng='crypto', seed=null } = {}) {
  if (seed != null && API.setSeed) API.setSeed(String(seed));
  if (API.setRngMode) API.setRngMode(rng === 'seed' ? 'seed' : 'crypto');
  return { rng: (rng === 'seed' ? 'seed' : 'crypto'), seed: seed ?? null };
}

/** Временная смена конфигурации RNG/seed на время вызова fn */
async function withConfig(cfg, fn) {
  if (!fn) return;
  // сохраним старые значения, если доступны
  const oldMode = 'crypto'; // нет публичного геттера — считаем crypto
  try {
    configure(cfg || {});
    return await fn();
  } finally {
    configure({ rng: oldMode, seed: null });
  }
}

/** Почти-изолированная сессия: обёртка, которая применяет cfg на каждый вызов API и откатывает назад */
function scoped(cfg = {}) {
  const handler = {};
  for (const k of Object.keys(API)) {
    const v = API[k];
    if (typeof v === 'function') {
      handler[k] = (...args) => withConfig(cfg, () => v(...args));
    } else {
      Object.defineProperty(handler, k, { value: v, enumerable: true, writable: false });
    }
  }
  // также добавить util-функции
  handler.configure = (next) => Object.assign(cfg, next || {});
  handler.version = VERSION;
  return handler;
}

/** Поставить фасад на глобал для отладки (не обязательно) */
function installTo(globalName='Q') {
  try {
    if (typeof global !== 'undefined') {
      Object.defineProperty(global, globalName, {
        value: module.exports,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    }
  } catch {/* ignore */}
  return globalName;
}

/** “Заморозить” экспорт — защита от случайных мутаций */
function freeze() {
  try { Object.freeze(API); } catch {}
  try { Object.freeze(module.exports); } catch {}
  return true;
}

/** Алиас под brain: measureEntropy() → decoherence.entropy() */
function measureEntropy(p) { try { return API.entropy(p); } catch { return null; } }

// ── Экспорт ───────────────────────────────────────────────────────────────────
module.exports = {
  ...API,
  configure,
  withConfig,
  scoped,
  installTo,
  freeze,
  measureEntropy,
  version: VERSION,
};
