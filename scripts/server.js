#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  Entropy — production server launcher (v5.2, cross-platform)
//
//  `npm start` / `bun run start` / `node scripts/server.js` — all
//  route here on Windows, macOS and Linux alike. The old
//  "start" script was POSIX-only (`NODE_ENV=production bun … |
//  tee`) which dies instantly on Windows cmd. This wrapper has
//  zero dependencies and:
//
//    1. loads the PROJECT ROOT .env (keys edited by the user
//       always win over the copy baked into .next/standalone
//       at build time — real shell env vars still win over both)
//    2. sets ENTROPY_PROJECT_ROOT so src/lib/db.ts resolves the
//       SQLite `file:./db/custom.db` URL against the project
//       root, NOT the standalone dir the server chdir()s into
//    3. defaults PORT=3000 / HOSTNAME=0.0.0.0
//    4. requires the standalone server (boots in ~130ms,
//       ~130MB RSS — the OOM-proof production mode)
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STANDALONE = path.join(ROOT, '.next', 'standalone', 'server.js');

if (!fs.existsSync(STANDALONE)) {
  console.error(
    '[entropy] No production build found (.next/standalone/server.js).\n' +
      '           Build it first:  npm run build   (or: bun run build)\n' +
      '           Or run dev mode: npm run dev'
  );
  process.exit(1);
}

// ── 1. load root .env (only variables not already in the real env) ──
function loadEnv(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env) || process.env[key] === '') {
        process.env[key] = val;
      }
    }
  } catch {
    /* no .env — fine, real env only */
  }
}
loadEnv(path.join(ROOT, '.env'));

// ── 2/3. deterministic runtime knobs ──────────────────────────
process.env.ENTROPY_PROJECT_ROOT = ROOT;
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.PORT = process.env.PORT || '3000';
process.env.HOSTNAME = process.env.HOSTNAME || '0.0.0.0';

console.log(
  `[entropy] production server starting — http://localhost:${process.env.PORT}` +
    ` (root: ${ROOT})`
);

// ── 4. boot the standalone Next server ────────────────────────
require(STANDALONE);
