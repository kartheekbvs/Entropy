#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  Entropy — post-build asset sync (v5.2, cross-platform)
//
//  `next build` (standalone output) does not copy .next/static
//  and public/ into .next/standalone — the classic postbuild
//  step is `cp -r` which is POSIX-only and dies on Windows.
//  This node script does the same copy with the standard
//  library, identically on every platform.
// ─────────────────────────────────────────────────────────────
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NEXT = path.join(ROOT, '.next');
const STANDALONE = path.join(NEXT, 'standalone');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.cpSync(src, dest, { recursive: true, force: true });
  return true;
}

const staticOk = copyDir(path.join(NEXT, 'static'), path.join(STANDALONE, '.next', 'static'));
const publicOk = copyDir(path.join(ROOT, 'public'), path.join(STANDALONE, 'public'));

// keep the root .env fresh inside the standalone dir (Next loads it
// from there first; scripts/server.js overrides with the root copy)
if (fs.existsSync(path.join(ROOT, '.env'))) {
  fs.copyFileSync(path.join(ROOT, '.env'), path.join(STANDALONE, '.env'));
}

console.log(
  `[entropy] postbuild: static ${staticOk ? '✓' : 'MISSING'} · public ${publicOk ? '✓' : 'MISSING'}`
);
if (!staticOk) {
  console.error('[entropy] ERROR: .next/static not found — did `next build` run?');
  process.exit(1);
}
