'use strict';
/**
 * features/ai/quantum/decoherence.cjs
 * 🌫️ Декогеренция/шум/затухание для ИИ-стека:
 *  • Шумы: гаусс/лаплас/равномерный, броуновский шаг, Орнштейна–Уленбека (OU)
 *  • «Распад волновой функции»: collapse()/sharpen()/soften()
 *  • Дезеринг и квантизация: stochasticRound(), quantizeWithDither()
 *  • Dropout/Mask: случайные выключатели фич/действий
 *  • Забывание/decay: экспоненциальное затухание весов/памяти (L1/L2/каппинг)
 *  • Энтропия и нормализации: entropy(), renormSafe(), labelSmoothing()
 *  • Расписания: temperature/epsilon/poly/cosine/linear
 *  • Стабилизация: nanGuard(), stabilityClamp(), safeMix()
 *
 * Без внешних зависимостей. Опционально использует ./core.cjs для RNG.
 */

let Q; // опционально
try { Q = require('./core.cjs'); } catch { /* ок, fallback на Math.random */ }

const _rand = ()=> (Q?.quantumRandom ? Q.quantumRandom() : Math.random());
const clamp = (x,a,b)=> Math.max(a, Math.min(b, x));
const lerp  = (a,b,t)=> a + (b-a)*t;

// ──────────────────────────────────────────────────────────────────────────────
// БАЗОВЫЕ ШУМЫ
// ──────────────────────────────────────────────────────────────────────────────

function noiseUniform(scale=1){ return ( _rand()*2 - 1 ) * scale; }

function noiseNormal(std=1){
  const u1 = Math.max(1e-12, _rand());
  const u2 = _rand();
  const r  = Math.sqrt(-2*Math.log(u1));
  return std * r * Math.cos(2*Math.PI*u2);
}

function noiseLaplace(b=1){ // плотный хвостовой шум
  const u = _rand() - 0.5;
  return -b * Math.sign(u) * Math.log(1 - 2*Math.abs(u));
}

// ──────────────────────────────────────────────────────────────────────────────
// РАСПАД / СГЛАЖИВАНИЕ РАСПРЕДЕЛЕНИЙ
// ──────────────────────────────────────────────────────────────────────────────

/** collapse: выбор категории с шумом (распад «волновой функции» распределения) */
function collapse(dist){
  const arr = Object.entries(dist||{}).filter(([,p])=>p>0);
  if (!arr.length) return null;
  let s=0; for (const [,p] of arr) s+=p;
  let r=_rand()*s, acc=0;
  for (const [k,p] of arr){ acc+=p; if (r<=acc) return k; }
  return arr.at(-1)[0];
}

/** sharpen: «заостряет» распределение (температура < 1) */
function sharpen(dist, temperature=0.7){
  const t = Math.max(1e-6, temperature);
  const out={}; let max=-Infinity;
  for (const v of Object.values(dist||{})) max = Math.max(max, Number(v)||0);
  let sum=0;
  for (const [k,v] of Object.entries(dist||{})){
    const e = Math.exp(((Number(v)||0) - max)/t);
    out[k]=e; sum+=e;
  }
  for (const k of Object.keys(out)) out[k] /= sum || 1;
  return out;
}

/** soften: «размазывает» распределение (температура > 1) */
function soften(dist, temperature=1.5){
  return sharpen(dist, Math.max(temperature, 1e-6));
}

/** labelSmoothing: смешивает дистрибуцию с равномерной (λ сила) */
function labelSmoothing(dist, lambda=0.1){
  const keys = Object.keys(dist||{});
  if (!keys.length) return {};
  const uni = 1/keys.length;
  const out={};
  for (const k of keys){
    const p = Math.max(0, Number(dist[k])||0);
    out[k] = (1-lambda)*p + lambda*uni;
  }
  return renormSafe(out);
}

// ──────────────────────────────────────────────────────────────────────────────
// ДЕЗЕРИНГ / КВАНТИЗАЦИЯ / СТОХАСТИЧЕСКОЕ ОКРУГЛЕНИЕ
// ──────────────────────────────────────────────────────────────────────────────

function stochasticRound(x){
  const f = Math.floor(x), c = f+1, p = clamp(x - f, 0, 1);
  return (_rand() < p) ? c : f;
}

/** quantizeWithDither: квантизация с добавлением шума для минимизации систематической ошибки */
function quantizeWithDither(x, step=0.1, ditherStd=0.3){
  const noisy = x + noiseNormal(ditherStd*step);
  return Math.round(noisy/step)*step;
}

// ──────────────────────────────────────────────────────────────────────────────
// DROPOUT / MASK
// ──────────────────────────────────────────────────────────────────────────────

/** randomMask: массив булей длиной N, истина с вероятностью keepP */
function randomMask(N, keepP=0.8){
  const out=new Array(N);
  for (let i=0;i<N;i++) out[i] = _rand() < keepP;
  return out;
}

/** dropout: зануляет элементы массива/объекта по вероятности dropP */
function dropout(data, dropP=0.2){
  if (Array.isArray(data)){
    return data.map(v => (_rand()<dropP ? 0 : v));
  } else if (data && typeof data==='object'){
    const out={};
    for (const [k,v] of Object.entries(data)) out[k] = (_rand()<dropP ? 0 : v);
    return out;
  }
  return data;
}

// ──────────────────────────────────────────────────────────────────────────────
// БРОУНОВСКОЕ И OU-ПРОЦЕССЫ (для траекторий/настроений/скоростей)
// ──────────────────────────────────────────────────────────────────────────────

/** brownianStep: x_{t+1} = x_t + N(0, sigma) */
function brownianStep(x, sigma=0.05){ return x + noiseNormal(sigma); }

/** ornsteinUhlenbeck: тянет к центру μ с силой θ, добавляет шум σ */
function ornsteinUhlenbeck(x, dt=0.05, { mu=0, theta=0.5, sigma=0.2 }={}){
  const dx = theta*(mu - x)*dt + sigma*Math.sqrt(dt)*noiseNormal(1);
  return x + dx;
}

// ──────────────────────────────────────────────────────────────────────────────
// ЗАБЫВАНИЕ / ЗАТУХАНИЕ ВЕСОВ И ПАМЯТИ
// ──────────────────────────────────────────────────────────────────────────────

/** decayExp: экспоненциальное затухание скаляра x ← x*(1-λ) */
function decayExp(x, lambda=0.05){ return x*(1 - clamp(lambda,0,1)); }

/** decayWeights: L1/L2/каппинг для объекта весов {k: w} */
function decayWeights(W, { l1=0.0, l2=0.01, capMin=1e-4, capMax=Infinity }={}){
  const out={};
  for (const [k,w0] of Object.entries(W||{})){
    let w = Number(w0)||0;
    if (l2>0) w *= (1 - clamp(l2,0,1));
    if (l1>0) w -= Math.sign(w)*l1;
    w = clamp(w, capMin, capMax);
    out[k] = isFinite(w) ? w : 0;
  }
  return out;
}

/** decayMemory: уменьшает значения, удаляет «мелочь» ниже порога prune */
function decayMemory(obj, { decay=0.02, prune=1e-6 }={}){
  const out={};
  for (const [k,v0] of Object.entries(obj||{})){
    const v = (Number(v0)||0) * (1 - clamp(decay,0,1));
    if (Math.abs(v) >= prune) out[k] = v;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// ЭНТРОПИЯ И НОРМАЛИЗАЦИЯ
// ──────────────────────────────────────────────────────────────────────────────

function renormSafe(obj){
  const out={}; let s=0;
  for (const v of Object.values(obj||{})) s += Math.max(0, Number(v)||0);
  if (s<=0) return { ...obj };
  for (const [k,v] of Object.entries(obj||{})) out[k] = Math.max(0, Number(v)||0)/s;
  return out;
}

function entropy(dist){
  const d = renormSafe(dist||{});
  let H=0; for (const p of Object.values(d)){
    if (p>1e-12) H += -p*Math.log2(p);
  }
  return H; // в битах
}

/** mixWithEntropyCap: смешение A и B, ограничивая рост энтропии */
function mixWithEntropyCap(A,B,alpha=0.5,{ maxEntropy=null }={}){
  alpha = clamp(alpha,0,1);
  let mix = renormSafe(Object.fromEntries(
    Array.from(new Set([...Object.keys(A||{}),...Object.keys(B||{})])).map(k=>{
      const a = Math.max(0, Number(A?.[k])||0);
      const b = Math.max(0, Number(B?.[k])||0);
      return [k, (1-alpha)*a + alpha*b];
    })
  ));
  if (maxEntropy!=null){
    // если энтропия выше лимита — слегка «заточим»
    while (entropy(mix) > maxEntropy){
      mix = sharpen(mix, 0.9);
    }
  }
  return mix;
}

// ──────────────────────────────────────────────────────────────────────────────
// РАСПИСАНИЯ (температура/эпсилон/линейные/косинусные/полиномиальные)
// ──────────────────────────────────────────────────────────────────────────────

function scheduleTemperature(step = 0, cfg = {}) {
  const {
    T0 = 1.0,
    k = 0.0025,
    floor = 0.6,
    amplitude = 0.4,
    noise = 0.05
  } = cfg;

  const baseWave = Math.sin(step * k) * 0.5 + 0.5;
  const rand = (Math.random() - 0.5) * 2 * noise;
  const T = floor + (T0 - floor) * (baseWave * amplitude + (1 - amplitude) * 0.5 + rand);
  return Math.max(floor, Math.min(T, T0));
}

// ──────────────────────────────────────────────────────────────────────────────
// СТАБИЛИЗАЦИЯ/ЗАЩИТА
// ──────────────────────────────────────────────────────────────────────────────

function nanGuard(x, fallback=0){
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function stabilityClamp(x, { min=-1e9, max=1e9 }={}){
  return clamp(Number(x)||0, min, max);
}

function safeMix(a, b, alpha){
  alpha = clamp(alpha,0,1);
  const A = nanGuard(a,0), B = nanGuard(b,0);
  return A*(1-alpha) + B*alpha;
}

// ──────────────────────────────────────────────────────────────────────────────
// ВЕКТОРНЫЕ/ПУТЕВЫЕ ШУМЫ (для движений и камер)
// ──────────────────────────────────────────────────────────────────────────────

function noiseVec3([x,y,z], { std=0.01 }={}){
  return [ x + noiseNormal(std), y + noiseNormal(std), z + noiseNormal(std*0.7) ];
}

function jitterPath3D(points, { std=0.01 }={}){
  if (!Array.isArray(points)) return [];
  return points.map(p => noiseVec3(p, { std }));
}

/** OU-фильтр по массиву 3D-точек — сглаживает рывки, но тянет к «целям» */
function ouFilterPath3D(points, { dt=0.05, mu=[0,0,0], theta=1.2, sigma=0.12 }={}){
  const out=[];
  let x=0,y=0,z=0, init=false;
  for (const p of points||[]){
    if (!init){ x=p[0]; y=p[1]; z=p[2]; init=true; }
    const nx = ornsteinUhlenbeck(p[0], dt, { mu: mu[0], theta, sigma });
    const ny = ornsteinUhlenbeck(p[1], dt, { mu: mu[1], theta, sigma });
    const nz = ornsteinUhlenbeck(p[2], dt, { mu: mu[2], theta, sigma });
    x = 0.5*(x + nx); y = 0.5*(y + ny); z = 0.5*(z + nz);
    out.push([x,y,z]);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// ЭКСПОРТ
// ──────────────────────────────────────────────────────────────────────────────

module.exports = {
  // шумы
  noiseUniform, noiseNormal, noiseLaplace,
  brownianStep, ornsteinUhlenbeck,

  // распад распределений
  collapse, sharpen, soften, labelSmoothing,

  // стохастическое округление / квантизация
  stochasticRound, quantizeWithDither,

  // dropout/mask
  randomMask, dropout,

  // затухание/забывание
  decayExp, decayWeights, decayMemory,

  // энтропия/нормализация/смешивание
  renormSafe, entropy, mixWithEntropyCap,

  // расписания
  scheduleTemperature,

  // стабилизация
  nanGuard, stabilityClamp, safeMix,

  // векторные/путевые шумы
  noiseVec3, jitterPath3D, ouFilterPath3D,
};
