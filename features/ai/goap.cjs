'use strict';

// features/ai/goap.cjs — v1 scaffold (no external APIs)
// Minimal GOAP planner skeleton: register actions with preconditions/effects;
// simple breadth-first search over symbolic world states (shallow plans only).

class Action {
  constructor(name, { pre = {}, eff = {}, cost = 1, run = null } = {}) {
    this.name = name; this.pre = pre; this.eff = eff; this.cost = cost; this.run = run;
  }
}

function matchPre(world, pre) {
  for (const k of Object.keys(pre)) if (world[k] !== pre[k]) return false;
  return true;
}

function applyEff(world, eff) {
  const next = { ...world };
  for (const k of Object.keys(eff)) next[k] = eff[k];
  return next;
}

function equalWorld(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

function plan(start, goal, actions, maxDepth = 6) {
  // BFS frontier
  const q = [{ w: { ...start }, seq: [], cost: 0 }];
  const seen = new Set();
  const key = (w)=> JSON.stringify(w);
  seen.add(key(start));

  while (q.length) {
    const cur = q.shift();
    if (matchPre(cur.w, goal)) return cur.seq; // found a plan
    if (cur.seq.length >= maxDepth) continue;

    for (const a of actions) {
      if (!matchPre(cur.w, a.pre)) continue;
      const nxt = applyEff(cur.w, a.eff);
      const k = key(nxt);
      if (seen.has(k)) continue;
      seen.add(k);
      q.push({ w: nxt, seq: [...cur.seq, a], cost: cur.cost + a.cost });
    }
  }
  return null;
}

module.exports = { Action, plan, matchPre, applyEff };

