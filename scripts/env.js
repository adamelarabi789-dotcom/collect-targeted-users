'use strict';
/**
 * env.js — zero-dependency .env loader.
 *
 * Reads KEY=VALUE pairs from a local .env file (looked up at the current
 * directory, then the repo root) and copies them into process.env WITHOUT
 * overwriting variables that are already set. This makes the documented
 * `cp .env.example .env` workflow work with no extra dependency.
 *
 * Call loadEnv() before any other require that reads configuration at module
 * load time (see scan-candidates.js / build-targets.js / lib/twitter.js).
 */
const fs = require('fs');
const path = require('path');

function parseLine(raw) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return null;
  const eq = line.indexOf('=');
  if (eq < 0) return null;
  const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let val = line.slice(eq + 1).trim();
  if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
    val = val.slice(1, -1);
  }
  return { key, val };
}

/** Load the first .env found. Returns its path, or null when none exists. */
function loadEnv() {
  const candidates = [
    process.env.X_ENV_FILE,
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
  ].filter(Boolean);
  const seen = new Set();
  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      const parsed = parseLine(raw);
      if (parsed && process.env[parsed.key] === undefined) process.env[parsed.key] = parsed.val;
    }
    return file;
  }
  return null;
}

module.exports = { loadEnv };
