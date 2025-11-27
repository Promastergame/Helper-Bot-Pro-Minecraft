'use strict';
/**
 * features/ai/quantum/core.cjs
 * ⚛️ Универсальное «квантовое» ядро без внешних зависимостей.
 * Работает для всех подсистем (combat/mining/crafting/navigation/brain/experience/...).
 *
 * Включает:
 *  • RNG: крипто-рандом + детерминируемый xorshift (seedable)
 *  • Распределения: uniform/normal/exponential/bernoulli/categorical
 *  • Квант-операции: superposition/decohere/entangle(+vec2)
 *  • «Человеческие» движения: jitter 2D/3D, траектории, сглаживание, micro-pauses, easing
 *  • Вектора/геометрия: vec2/vec3 утилиты, длины/нормализация/линейная интерполяция
 *  • Обучение: EMA/Welford, learningRate, bandits (Thompson/UCB), simulated annealing
 *  • Служебное: clamp/mapRange/throttle/debounce/sleep/humanDelay/rateLimiter
 *  • Хуки: onDecision(fn) — подписка «мозгу/опыту» на все выборы (для логов/обучения)
 */

const crypto = require('crypto');

// ──────────────────────────────────────────────────────────────────────────────
// RNG: crypto + seedable xorshift128+
// ──────────────────────────────────────────────────────────────────────────────

let RNG_MODE = 'crypto'; // 'crypto' | 'seed'
let _seedState = (() => {
  const b = crypto.randomBytes(16);
  return {
    a: b.readBigUInt64BE(0),
    b: b.readBigUInt64BE(8)
  };
})();

function _xorshift128p() {
  // xorshift128+ (детерминируемый генератор)
  let { a, b } = _seedState;
  a ^= a << 23n;
  a ^= a >> 17n;
  a ^= b;
  a ^= b >> 26n;
  _seedState = { a: b, b: a };
  const t = (a + b) & ((1n << 64n) - 1n);
  // 53-битный float [0,1)
  const x = Number(t >> 11n) / 9007199254740991; // 2^53-1
  return x;
}

function setSeed(seedStr = 'promaster') {
  const h = crypto.createHash('sha256').update(String(seedStr)).digest();
  _seedState = {
    a: h.readBigUInt64BE(0),
    b: h.readBigUInt64BE(8)
  };
  RNG_MODE = 'seed';
}

function setRngMode(mode = 'crypto') { RNG_MODE = mode === 'seed' ? 'seed' : 'crypto'; }

function quantumRandom() {
  if (RNG_MODE === 'seed') return _xorshift128p();
  // crypto 48 бит точности
  const buf = crypto.randomBytes(6);
  const n = buf.readUIntBE(0, 6); // 0..2^48-1
  return n / 281474976710655;
}

function randInt(min, max) {
  if (max < min) [min, max] = [max, min];
  const span = max - min + 1;
  return min + Math.floor(quantumRandom() * span);
}

function randSign() { return quantumRandom() < 0.5 ? -1 : 1; }

// ──────────────────────────────────────────────────────────────────────────────
// Математика/вектора/геометрия
// ──────────────────────────────────────────────────────────────────────────────

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mapRange = (x, a1, b1, a2, b2) => a2 + (clamp((x - a1) / (b1 - a1), 0, 1) * (b2 - a2));
const lerp = (a, b, t) => a + (b - a) * t;

const Vec2 = {
  add: (A,B)=>[A[0]+B[0], A[1]+B[1]],
  sub: (A,B)=>[A[0]-B[0], A[1]-B[1]],
  mul: (A,s)=>[A[0]*s, A[1]*s],
  len: (A)=>Math.hypot(A[0],A[1]),
  norm: (A)=>{ const l=Vec2.len(A)||1; return [A[0]/l,A[1]/l]; },
  dot: (A,B)=>A[0]*B[0]+A[1]*B[1],
  lerp: (A,B,t)=>[lerp(A[0],B[0],t), lerp(A[1],B[1],t)],
};

const Vec3 = {
  add: (A,B)=>[A[0]+B[0], A[1]+B[1], A[2]+B[2]],
  sub: (A,B)=>[A[0]-B[0], A[1]-B[1], A[2]-B[2]],
  mul: (A,s)=>[A[0]*s, A[1]*s, A[2]*s],
  len: (A)=>Math.hypot(A[0],A[1],A[2]),
  norm:(A)=>{const l=Vec3.len(A)||1; return [A[0]/l,A[1]/l,A[2]/l];},
  dot:(A,B)=>A[0]*B[0]+A[1]*B[1]+A[2]*B[2],
  lerp:(A,B,t)=>[lerp(A[0],B[0],t), lerp(A[1],B[1],t), lerp(A[2],B[2],t)],
};

// ──────────────────────────────────────────────────────────────────────────────
// Распределения
// ──────────────────────────────────────────────────────────────────────────────

function uniform(a=0,b=1){ return a + quantumRandom()*(b-a); }

function exponential(lambda=1){
  const u = Math.max(1e-12, quantumRandom());
  return -Math.log(u)/lambda;
}

function normal(mean=0, std=1){
  const u1 = Math.max(1e-12, quantumRandom());
  const u2 = quantumRandom();
  const r = Math.sqrt(-2*Math.log(u1));
  const th = 2*Math.PI*u2;
  return mean + std * r * Math.cos(th);
}

function bernoulli(p=0.5){ return quantumRandom() < p ? 1 : 0; }

function categorical(weightsObj){
  const arr = Object.entries(weightsObj).filter(([,w])=>w>0);
  if (!arr.length) return null;
  let sum=0; for(const [,w] of arr) sum+=w;
  let r = quantumRandom() * sum, acc=0;
  for (const [k,w] of arr){ acc+=w; if(r<=acc) return k; }
  return arr.at(-1)[0];
}

// ──────────────────────────────────────────────────────────────────────────────
// Квант-операции
// ──────────────────────────────────────────────────────────────────────────────

function superposition(states){
  if (!Array.isArray(states)||!states.length) return null;
  let total = 0;
  for (const s of states) total += Math.max(0, Number(s.weight)||0);
  if (total<=0) return states[0].state;
  let r = quantumRandom()*total, acc=0;
  for (const s of states){
    const w = Math.max(0, Number(s.weight)||0);
    acc += w;
    if (r<=acc) return s.state;
  }
  return states.at(-1).state;
}

function decohere(value, noise=0.03){
  return value + (quantumRandom()-0.5)*noise;
}

function entangle(a,b,factor=0.4){
  factor = clamp(factor,0,1);
  const avg=(a+b)/2;
  return [avg+(a-avg)*(1-factor), avg+(b-avg)*(1-factor)];
}

function entangleVec2(ax,ay,bx,by,factor=0.4){
  const [x1,x2] = entangle(ax,bx,factor);
  const [y1,y2] = entangle(ay,by,factor);
  return [[x1,y1],[x2,y2]];
}

// ──────────────────────────────────────────────────────────────────────────────
// Easing + человеческие движения
// ──────────────────────────────────────────────────────────────────────────────

const Easing = {
  linear: t=>t,
  easeInQuad: t=>t*t,
  easeOutQuad: t=>t*(2-t),
  easeInOutQuad: t=>t<0.5?2*t*t:-1+(4-2*t)*t,
  easeInCubic: t=>t*t*t,
  easeOutCubic: t=>(--t)*t*t+1,
  easeInOutCubic: t=> t<0.5?4*t*t*t:(t-1)*(2*t-2)*(2*t-2)+1,
};

function humanMicroPause(baseMs=120, jitter=0.35){
  const m = Math.log(Math.max(1, baseMs));
  const s = 0.25 + 0.25*jitter;
  const val = Math.exp(normal(m, s));
  return clamp(val, 20, 2000)|0;
}

function humanTimingScale(){
  const base = 0.9 + quantumRandom()*0.2;
  if (quantumRandom() < 0.05) return 0.75 + quantumRandom()*0.5;
  return base;
}

function humanJitter2D(x,y,scale=0.008){
  return [x+normal(0,scale), y+normal(0,scale)];
}

function humanJitter3D(x,y,z,scale=0.008){
  return [x+normal(0,scale), y+normal(0,scale), z+normal(0,scale*0.6)];
}

function smoothPath(points, iters=1, tension=0.25){
  if (!Array.isArray(points) || points.length<3) return points||[];
  let pts = points.map(p=>[p[0],p[1],p[2]??0]);
  for(let it=0; it<iters; it++){
    const out=[pts[0]];
    for(let i=0;i<pts.length-1;i++){
      const [x0,y0,z0]=pts[i], [x1,y1,z1]=pts[i+1];
      const Q=[lerp(x0,x1,tension), lerp(y0,y1,tension), lerp(z0,z1,tension)];
      const R=[lerp(x0,x1,1-tension), lerp(y0,y1,1-tension), lerp(z0,z1,1-tension)];
      out.push(Q,R);
    }
    out.push(pts.at(-1));
    pts=out;
  }
  return pts;
}

function humanTrajectory3D(A,B,steps=30,easing='easeInOutCubic'){
  const e = Easing[easing]||Easing.easeInOutCubic;
  const out=[];
  for(let i=0;i<=steps;i++){
    const t=e(i/steps);
    const P=Vec3.lerp(A,B,t);
    const [jx,jy,jz] = humanJitter3D(P[0],P[1],P[2],0.01);
    out.push([jx,jy,jz]);
  }
  return smoothPath(out,1,0.2);
}

function planHumanSteps(A,B,avgStepMs=55,steps=28){
  const traj=humanTrajectory3D(A,B,steps);
  const plan=[];
  for(let i=0;i<traj.length;i++){
    const scale=humanTimingScale();
    const waitMs=Math.max(20, Math.floor(avgStepMs*scale));
    plan.push({ pos: traj[i], waitMs });
    if(i%7===0 && i!==0 && quantumRandom()<0.22){
      plan.push({ pos: traj[i], waitMs: humanMicroPause(140) });
    }
  }
  return plan;
}

// ──────────────────────────────────────────────────────────────────────────────
/** Служебные: таймеры/троттлинг/дебаунс/лимитер */
// ──────────────────────────────────────────────────────────────────────────────

const sleep = (ms)=> new Promise(res=>setTimeout(res, ms));

async function humanDelay(baseMs=90){
  const scale = humanTimingScale();
  const micro = humanMicroPause(baseMs, 0.35) * (0.8 + quantumRandom()*0.4);
  const ms = Math.max(15, Math.floor(micro * scale));
  await sleep(ms);
  return ms;
}

function throttle(fn, ms){
  let last=0, timer=null, lastArgs=null;
  return function(...args){
    const now=Date.now();
    lastArgs=args;
    if (now-last>=ms){
      last=now; return fn.apply(this,args);
    }
    if (!timer){
      const delay = ms - (now-last);
      timer = setTimeout(()=>{ timer=null; last=Date.now(); fn.apply(this,lastArgs); }, delay);
    }
  };
}

function debounce(fn, ms){
  let timer=null;
  return function(...args){
    clearTimeout(timer);
    timer=setTimeout(()=>fn.apply(this,args),ms);
  };
}

function rateLimiter({ capacity=5, refillMs=1000 }={}){
  let tokens=capacity;
  setInterval(()=>{ tokens=Math.min(capacity,tokens+1); }, refillMs).unref?.();
  return function tryUse(){
    if(tokens<=0) return false;
    tokens--; return true;
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Обучение: EMA / Welford / learningRate / bandits / annealing
// ──────────────────────────────────────────────────────────────────────────────

function emaUpdate(prev, x, alpha=0.25){
  const n = Number(x);
  if (!Number.isFinite(n)) return prev ?? null;
  return prev==null ? n : (alpha*n + (1-alpha)*(prev));
}

function welfordAdd(stat, x){
  if (!stat || stat.n==null) stat={ n:0, mean:0, m2:0 };
  stat.n+=1;
  const d = x - stat.mean;
  stat.mean += d / stat.n;
  const d2 = x - stat.mean;
  stat.m2 += d * d2;
  return stat;
}
function welfordVar(stat){ return stat && stat.n>1 ? stat.m2/(stat.n-1) : 0; }

function updateLearningRate(prev=1.0, success, up=1.05, down=0.9, min=0.1, max=5.0){
  let lr = prev*(success?up:down);
  return clamp(lr, min, max);
}

function thompsonBeta(successCount=0, failCount=0){
  const alpha = Math.max(1e-3, 1+successCount);
  const beta  = Math.max(1e-3, 1+failCount);
  function gamma(shape){
    const k = Math.max(1, Math.floor(shape));
    let sum=0; for(let i=0;i<k;i++) sum+=exponential(1);
    const frac = shape - k; if (frac>1e-6) sum += exponential(1)*frac;
    return sum;
  }
  const x=gamma(alpha), y=gamma(beta);
  return x/(x+y);
}

function ucb1(mean, totalTries, armTries, c=2){
  if (armTries===0) return Infinity;
  return mean + Math.sqrt((c*Math.log(Math.max(1,totalTries)))/armTries);
}

function acceptAnnealing(delta, temperature){
  if (delta<0) return true;
  const p = Math.exp(-delta/Math.max(1e-9, temperature));
  return quantumRandom()<p;
}
function temperatureSchedule(t, T0=1.0, k=0.003){
  return Math.max(1e-4, T0*Math.exp(-k*t));
}

function normalizeWeights(obj){
  const out={}; let sum=0;
  for(const v of Object.values(obj)) sum+=Math.max(0,Number(v)||0);
  if (sum<=0) return { ...obj };
  for (const [k,v] of Object.entries(obj)) out[k]=Math.max(0,Number(v)||0)/sum;
  return out;
}

function updateWeight(w, r, rate=0.12){
  const rr = clamp(r||0, -1, 1);
  return Math.max(1e-4, w*(1 + rate*rr));
}

// ──────────────────────────────────────────────────────────────────────────────
// ХУКИ ДЛЯ МОЗГА/ОПЫТА: наблюдать решения
// ──────────────────────────────────────────────────────────────────────────────

const _decisionSubscribers = new Set();

/**
 * Подписка на события выбора/решения.
 * cb(payload) где payload = { domain, context, candidates, picked, scored, ts }
 */
function onDecision(cb){
  if (typeof cb==='function') _decisionSubscribers.add(cb);
  return ()=>_decisionSubscribers.delete(cb);
}
function _emitDecision(payload){
  for (const cb of _decisionSubscribers) { try { cb(payload); } catch{} }
}

/**
 * Рекомендация действия: комбинирует веса и Thompson-семплы успеха.
 * @param {Object} weights { action: weight }
 * @param {Object} stats   { action: { success, fail } }
 * @param {String} domain  'combat'|'craft'|'build'|... (для логики/фильтров)
 * @param {Object} context любая полезная информация (mob, tool, biome, ...)
 */
function recommendAction(weights, stats={}, domain='generic', context=null){
  const norm = normalizeWeights(weights);
  const scored = Object.fromEntries(
    Object.keys(norm).map(k=>{
      const st = stats[k] || { success:0, fail:0 };
      const beta = thompsonBeta(st.success||0, st.fail||0);
      // смешиваем собственный вес и «успешность» по опыту
      const w = 0.55*norm[k] + 0.45*beta;
      return [k, w];
    })
  );
  const picked = categorical(scored);
  const out = { choice: picked, scored: normalizeWeights(scored) };
  _emitDecision({
    domain, context, candidates: { ...weights }, picked, scored: out.scored, ts: Date.now()
  });
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Экспорт
// ──────────────────────────────────────────────────────────────────────────────

module.exports = {
  // RNG
  setSeed, setRngMode, quantumRandom, randInt, randSign,
  // math/vec
  clamp, mapRange, lerp, Vec2, Vec3,
  // distributions
  uniform, exponential, normal, bernoulli, categorical,
  // quantum ops
  superposition, decohere, entangle, entangleVec2,
  // human motion
  Easing, humanMicroPause, humanTimingScale,
  humanJitter2D, humanJitter3D, smoothPath, humanTrajectory3D, planHumanSteps,
  // timers/limits
  sleep, humanDelay, throttle, debounce, rateLimiter,
  // learning
  emaUpdate, welfordAdd, welfordVar, updateLearningRate,
  thompsonBeta, ucb1, acceptAnnealing, temperatureSchedule,
  normalizeWeights, updateWeight,
  // hooks for brain/experience
  onDecision,
};
