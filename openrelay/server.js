#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────
//  ██████╗ ██████╗ ███████╗██╗     ███████╗██╗    ██╗   ██╗
//  ██╔══██╗██╔══██╗██╔════╝██║     ██╔════╝██║    ╚██╗ ██╔╝
//  ██████╔╝██████╔╝█████╗  ██║     █████╗  ██║     ╚████╔╝
//  ██╔═══╝ ██╔══██╗██╔══╝  ██║     ██╔══╝  ██║      ╚██╔╝
//  ██║     ██║  ██║███████╗███████╗███████╗███████╗   ██║
//
//  OpenRelay — the never-fail LLM relay gateway.
//  One OpenAI-compatible endpoint in front of a provider CHAIN with
//  infinite wrap-around rotation, circuit breakers, persistent
//  failover memory, request queue and a live dashboard.
//  ZERO dependencies (Node.js >= 18 built-ins only).
//
//  Quick start:   node server.js               → http://127.0.0.1:8787
//  Point any OpenAI SDK at:
//      baseUrl = http://127.0.0.1:8787/v1   (apiKey = anything)
// ─────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Breaker } = require('./lib/breaker');
const { Queue } = require('./lib/queue');
const { Usage } = require('./lib/usage');
const { Engine, RelayExhaustedError } = require('./lib/engine');
const { ApiError } = require('./lib/providers');

const VERSION = '1.0.0';

// ── CLI ───────────────────────────────────────────────────────
function argValue(name, fallback) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  for (const a of argv) {
    if (a.startsWith(name + '=')) return a.slice(name.length + 1);
  }
  return fallback;
}
const CONFIG_PATH = argValue('--config', path.join(__dirname, 'config.json'));
const PORT = Number(argValue('--port', null)) || null;
const HOST = argValue('--host', null);
const AUTODETECT = argValue('--autodetect', '1') !== '0';

// ── config + steps ────────────────────────────────────────────
function loadConfig(p) {
  if (!fs.existsSync(p)) {
    console.error(`openrelay: config not found at ${p}\n  copy config.example.json → config.json and drop your keys in.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const config = loadConfig(CONFIG_PATH);
const cfgServer = Object.assign({ port: 8787, host: '127.0.0.1' }, config.server || {});
const PORT_FINAL = PORT || cfgServer.port;
const HOST_FINAL = HOST || cfgServer.host;

function entryKey(entry, model) { return `${entry.id}/${model}`; }

function expandSteps(entries) {
  const steps = [];
  let rank = 0;
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const models = Array.isArray(entry.models) && entry.models.length ? entry.models : [entry.model].filter(Boolean);
    for (const model of models) {
      steps.push({ key: entryKey(entry, model), rank: ++rank, entry, model });
    }
  }
  return steps;
}

// env override wins over the file's apiKey (open-source friendly)
function resolveKey(entry) {
  if (entry.apiKeyEnv && process.env[entry.apiKeyEnv]) return process.env[entry.apiKeyEnv];
  return entry.apiKey;
}

// ── local open-weights autodetect (Ollama / LM Studio) ────────
// The free, unlimited tail of the chain: appended ONLY when the
// daemon actually answers, so a laptop without Ollama never waits.
async function detectLocal() {
  if (!AUTODETECT || !config.local || !config.local.autodetect) return [];
  const found = [];
  const probes = [
    { id: 'ollama', label: 'Ollama (local)', baseUrl: config.local.ollamaUrl || 'http://127.0.0.1:11434/v1' },
    { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: config.local.lmstudioUrl || 'http://127.0.0.1:1234/v1' },
  ];
  for (const p of probes) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(p.baseUrl.replace(/\/+$/, '') + '/models', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const json = await res.json();
      const models = (json.data || []).map((m) => m.id).filter(Boolean).slice(0, config.local.maxModels || 8);
      if (!models.length) continue;
      found.push({
        id: p.id, label: p.label, baseUrl: p.baseUrl,
        apiKey: 'local', models,
        quirks: { includeUsage: false, timeoutMs: 300000 },
        local: true,
      });
      console.log(`  💻 ${p.label} detected — ${models.length} model(s) appended to the chain tail: ${models.slice(0, 3).join(', ')}${models.length > 3 ? ' …' : ''}`);
    } catch { /* not running — skip silently */ }
  }
  return found;
}

// ── state singletons ──────────────────────────────────────────
const STATE_DIR = argValue('--state-dir', path.join(__dirname, 'state'));
const breaker = new Breaker(config.breaker, path.join(STATE_DIR, 'breaker.json'));
const queue = new Queue(config.queue);
const usage = new Usage(path.join(STATE_DIR, 'usage.json'));
const engine = new Engine({ config, steps: [], breaker, queue, usage, log: () => {} });

function log(tag, text) { console.log(`[${new Date().toISOString().slice(11, 23)}] ${tag}: ${text}`); }

// ── helpers ───────────────────────────────────────────────────
function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-requested-with');
}
function sendJson(res, status, obj) {
  cors(res);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
async function readBody(req, capBytes = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > capBytes) throw new ApiError('bad_model', 413, 'request body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError('bad_model', 400, 'request body is not valid JSON'); }
}
const startedAt = Date.now();

function statsSnapshot() {
  const steps = engine.steps.map((s) => ({
    key: s.key, rank: s.rank, entry: s.entry.id, label: s.entry.label,
    model: s.model, local: Boolean(s.entry.local),
    breaker: breaker.snapshotEntry(s.entry.id),
    usage: usage.snapshot().steps[s.key] || null,
  }));
  return {
    ok: true,
    name: 'OpenRelay',
    version: VERSION,
    uptimeMs: Date.now() - startedAt,
    port: PORT_FINAL,
    rotation: engine.rotation,
    queue: queue.stats(),
    usage: usage.snapshot(),
    steps,
    chain: engine.steps.reduce((acc, s) => { if (!acc.includes(s.entry.label)) acc.push(s.entry.label); return acc; }, []),
  };
}

// ── request handler ───────────────────────────────────────────
async function handleChat(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, e.status || 400, { error: { message: e.message, type: 'invalid_request_error', code: 'bad_body' } }); }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return sendJson(res, 400, { error: { message: 'messages[] is required', type: 'invalid_request_error', code: 'missing_messages' } });
  }
  if (!engine.steps.length) {
    return sendJson(res, 503, { error: { message: 'no steps configured — check config.json chain', type: 'relay_config', code: 'empty_chain' } });
  }

  const wantStream = Boolean(body.stream);
  const clientAbort = new AbortController();
  req.on('close', () => { if (!res.writableEnded) clientAbort.abort(); });

  const ctx = {
    signal: clientAbort.signal,
    began: false,
    beginStream() {
      if (ctx.began || res.writableEnded) return;
      ctx.began = true;
      cors(res);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`: openrelay stream starting\n\n`);
    },
    onChunk(line) {
      if (!res.writableEnded) res.write(line + '\n');
    },
    endStream(meta) {
      if (res.writableEnded) return;
      res.write(`\n: openrelay served by ${meta.step} · model ${meta.model} · attempt ${meta.attempts} · round ${meta.round}\n\n`);
      res.end();
    },
    streamFailure(err, meta) {
      if (res.writableEnded) return;
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: { message: `upstream died mid-stream: ${err.message}`, type: 'relay_midstream_error', code: err.kind || 'server' }, openrelay: meta })}\n\n`);
        res.write(`data: [DONE]\n\n`);
      } catch { /* client gone */ }
      res.end();
    },
  };

  try {
    const out = await engine.relay(body, ctx);
    if (out.ok) {
      const meta = out.meta;
      log('chat', `200 ${meta.step} attempts=${meta.attempts} round=${meta.round} ${Math.round(meta.elapsedMs)}ms${out.usage ? ` tok=${(out.usage.prompt_tokens || 0) + (out.usage.completion_tokens || 0)}` : ''}`);
      if (!wantStream) {
        const json = Object.assign({}, out.json, { openrelay: meta });
        cors(res);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'x-openrelay-step': meta.step,
          'x-openrelay-attempts': String(meta.attempts),
          'x-openrelay-round': String(meta.round),
        });
        return res.end(JSON.stringify(json));
      }
      return; // streamed
    }
    // mid-stream failure — response already terminated by streamFailure
    log('chat', `midstream-fail ${out.meta.step} ${out.error.message}`);
    return;
  } catch (e) {
    if (e instanceof RelayExhaustedError) {
      log('chat', `504 exhausted attempts=${e.detail.attempts} rounds=${e.detail.rounds}`);
      return sendJson(res, 504, {
        error: { message: e.message, type: 'relay_exhausted', code: 'all_steps_refused' },
        openrelay: { diagnosis: e.detail.failures, attempts: e.detail.attempts, rounds: e.detail.rounds, elapsedMs: e.detail.elapsedMs },      });
    }
    log('chat', `502 ${e.message}`);
    return sendJson(res, 502, { error: { message: e.message, type: 'relay_error', code: (e.kind || 'server') } });
  }
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  try {
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/dashboard')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (req.method === 'GET' && url === '/healthz') {
      return sendJson(res, 200, { ok: true, name: 'OpenRelay', version: VERSION, uptimeMs: Date.now() - startedAt, steps: engine.steps.length, port: PORT_FINAL });
    }
    if (req.method === 'GET' && url === '/stats') {
      return sendJson(res, 200, statsSnapshot());
    }
    if (req.method === 'GET' && url === '/v1/models') {
      const data = [{ id: 'openrelay/auto', object: 'model', owned_by: 'openrelay', created: 1700000000, openrelay: { rank: 0, entry: 'openrelay', label: 'Auto — full chain rotation' } }]
        .concat(engine.steps.map((s) => ({
          id: s.model, object: 'model', owned_by: s.entry.id, created: 1700000000,
          openrelay: { rank: s.rank, entry: s.entry.id, label: s.entry.label },
        })));
      return sendJson(res, 200, { object: 'list', data });
    }
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      return await handleChat(req, res);
    }
    if (req.method === 'POST' && url === '/admin/breaker/reset') {
      for (const s of engine.steps) breaker.reset(s.entry.id);
      return sendJson(res, 200, { ok: true, reset: 'all' });
    }
    return sendJson(res, 404, { error: { message: `no route: ${req.method} ${url}`, type: 'not_found' } });
  } catch (e) {
    return sendJson(res, 500, { error: { message: String(e.message || e), type: 'internal' } });
  }
});

// ── boot ──────────────────────────────────────────────────────
(async () => {
  const localEntries = await detectLocal();
  const entries = (config.chain || []).concat(localEntries).filter((e) => e.enabled !== false);
  engine.setSteps(expandSteps(entries));

  server.listen(PORT_FINAL, HOST_FINAL, () => {
    console.log('');
    console.log('  ⚡ OpenRelay v' + VERSION + ' — the relay that never drops the baton');
    console.log('  ─────────────────────────────────────────────────────────');
    console.log(`  endpoint   http://${HOST_FINAL}:${PORT_FINAL}/v1/chat/completions`);
    console.log(`  models     http://${HOST_FINAL}:${PORT_FINAL}/v1/models`);
    console.log(`  dashboard  http://${HOST_FINAL}:${PORT_FINAL}/`);
    console.log(`  config     ${CONFIG_PATH}`);
    console.log('');
    console.log('  RELAY CHAIN (order = priority; wraps back to #1):');
    for (const s of engine.steps) {
      console.log(`   #${String(s.rank).padStart(2, '0')}  ${s.key.padEnd(46)} ${s.entry.local ? '💻 local' : ''}`);
    }
    console.log(`   ↺  … → back to #1 after ${engine.rotation.roundBaseMs}ms→${engine.rotation.roundMaxMs}ms exponential backoff${engine.rotation.maxRounds === 0 ? ' (unlimited rounds)' : ` (max ${engine.rotation.maxRounds} rounds)`}, deadline ${engine.rotation.deadlineMs}ms`);
    console.log('');
    console.log('  Point any OpenAI SDK at it:  baseUrl = http://' + HOST_FINAL + ':' + PORT_FINAL + '/v1');
    console.log('');
  });
})();

// ── graceful shutdown: persist failover memory ────────────────
function shutdown() {
  console.log('\n  openrelay: flushing state (failover memory) …');
  usage._persistNow();
  setTimeout(() => process.exit(0), 400);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
