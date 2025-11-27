'use strict';

// features/ai/telemetry.cjs — v1 (no external APIs)
// Lightweight counters and snapshot for actions and errors.

const { state } = require('../../core/state.cjs');

function inc(group, key, delta = 1) {
  state.telemetry ||= Object.create(null);
  state.telemetry[group] ||= Object.create(null);
  state.telemetry[group][key] = (state.telemetry[group][key] || 0) + delta;
}

function markAction(name, ok = true, ms = 0) {
  inc('actions', name, 1);
  if (!ok) inc('errors', name, 1);
  if (ms) inc('timeMs', name, ms);
}

function snapshot() {
  return JSON.parse(JSON.stringify(state.telemetry || {}));
}

module.exports = { inc, markAction, snapshot };

