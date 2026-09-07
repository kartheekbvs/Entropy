#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  Entropy — dev server with logging (v5.2, cross-platform)
//
//  Replaces the old POSIX-only `next dev -p 3000 2>&1 | tee
//  dev.log`. Works on Windows cmd/PowerShell, macOS and Linux
//  with node OR bun. Prefer `npm start` (production) — dev mode
//  compiles on the fly, uses ~2GB RAM and feels slow.
// ─────────────────────────────────────────────────────────────
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, 'dev.log');
const out = fs.createWriteStream(LOG, { flags: 'a' });

const { spawn } = require('node:child_process');
const runner = process.env.ENTROPY_DEV_RUNNER || 'npx';
const child = spawn(runner, ['next', 'dev', '-p', '3000'], {
  cwd: ROOT,
  shell: true,
  stdio: ['inherit', 'pipe', 'pipe'],
});

const stamp = () => new Date().toISOString().slice(11, 19);
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    out.write(chunk);
    process.stdout.write(chunk);
  });
}

console.log(`[entropy] dev server starting — http://localhost:3000 (log: dev.log, ${stamp()})`);
child.on('exit', (code) => {
  out.end();
  process.exit(code ?? 0);
});
