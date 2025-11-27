'use strict';

// features/ai/policy.cjs — v1 (no external APIs)
// Lightweight multi-armed bandit (UCB1) to pick next high-level action.

const { state } = require('../../core/state.cjs');

function now() { return Date.now(); }

function ensureStore() {
  state.policy ||= { total: 0, actions: Object.create(null) };
  return state.policy;
}

function touchAction(name) {
  const store = ensureStore();
  const a = store.actions[name] ||= { n: 0, value: 0, lastAt: 0 };
  return a;
}

function update(name, reward) {
  const store = ensureStore();
  const a = touchAction(name);
  a.n += 1;
  a.value = a.value + (reward - a.value) / a.n; // incremental mean
  a.lastAt = now();
  store.total += 1;
}

function scoreUCB1(name, c = 1.4) {
  const store = ensureStore();
  const a = touchAction(name);
  if (a.n === 0) return Infinity; // force exploration
  const bonus = c * Math.sqrt(Math.log(Math.max(1, store.total)) / a.n);
  return a.value + bonus;
}

function select(candidates, opts = {}) {
  const c = opts.c ?? 1.4;
  const scored = candidates.map(name => ({ name, s: scoreUCB1(name, c) }));
  scored.sort((x, y) => y.s - x.s);
  return scored[0]?.name || candidates[0];
}

module.exports = {
  ensureStore,
  update,
  select
};

