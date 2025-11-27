'use strict';

// ===============================
// core/logger.cjs - simple file logger with daily rotation
// Writes logs to ./logs/<category>-YYYY-MM-DD.log
// ===============================

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs');
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_TO_CONSOLE = String(process.env.LOG_TO_CONSOLE || 'false').toLowerCase() === 'true';
const LOG_JSON = String(process.env.LOG_JSON || 'false').toLowerCase() === 'true';
// Comma-separated list for enabling debug on specific categories, or "*" for all
const LOG_DEBUG = String(process.env.LOG_DEBUG || '').trim();

const levels = ['debug', 'info', 'warn', 'error'];
const levelIndex = (lvl) => levels.indexOf(lvl);
const minLevelIdx = Math.max(0, levelIndex(LOG_LEVEL));

function ensureDir(dir) {
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sanitizeName(name) {
  return String(name).replace(/[^a-z0-9._-]/gi, '_');
}

function shouldDebug(category) {
  if (!LOG_DEBUG) return levelIndex('debug') >= minLevelIdx; // only if global level is debug
  if (LOG_DEBUG === '*') return true;
  return LOG_DEBUG.split(',').map(s => s.trim()).filter(Boolean).some(p => {
    if (p.endsWith('*')) return category.startsWith(p.slice(0, -1));
    return category === p;
  });
}

function serialize(obj) {
  if (obj == null) return undefined;
  try { return JSON.stringify(obj); } catch {
    try {
      const seen = new WeakSet();
      return JSON.stringify(obj, (k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return v;
      });
    } catch { return String(obj); }
  }
}

function formatLine({ ts, level, category, msg, meta }) {
  if (LOG_JSON) {
    const rec = { ts, lvl: level, cat: category, msg };
    if (meta !== undefined) rec.meta = meta;
    return JSON.stringify(rec) + '\n';
  }
  const metaStr = meta === undefined ? '' : ` | ${serialize(meta)}`;
  return `${ts} ${level.toUpperCase()} [${category}] ${msg}${metaStr}\n`;
}

class FileSink {
  constructor(category) {
    this.category = sanitizeName(category);
    this.date = todayStr();
    ensureDir(LOG_DIR);
    this.stream = fs.createWriteStream(path.join(LOG_DIR, `${this.category}-${this.date}.log`), { flags: 'a' });
  }
  _rotateIfNeeded() {
    const now = todayStr();
    if (now !== this.date) {
      try { this.stream?.end?.(); } catch {}
      this.date = now;
      this.stream = fs.createWriteStream(path.join(LOG_DIR, `${this.category}-${this.date}.log`), { flags: 'a' });
    }
  }
  write(line) {
    this._rotateIfNeeded();
    try { this.stream.write(line); } catch {}
  }
}

const sinks = new Map();
function getSink(category) {
  if (!sinks.has(category)) sinks.set(category, new FileSink(category));
  return sinks.get(category);
}

function ts() {
  return new Date().toISOString();
}

function createLogger(category) {
  category = String(category || 'app');
  const sink = getSink(category);
  const debugEnabled = shouldDebug(category);

  function emit(level, msg, meta) {
    if (levelIndex(level) < (level === 'debug' ? (debugEnabled ? 0 : Infinity) : minLevelIdx)) return;
    const line = formatLine({ ts: ts(), level, category, msg: String(msg), meta });
    sink.write(line);
    if (LOG_TO_CONSOLE) {
      const fn = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
      try { fn(line.trimEnd()); } catch {}
    }
  }

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info:  (m, meta) => emit('info', m, meta),
    warn:  (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (suffix) => createLogger(`${category}.${sanitizeName(suffix)}`)
  };
}

module.exports = { createLogger };

