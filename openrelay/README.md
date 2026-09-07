# ⚡ OpenRelay

**The relay that never drops the baton.**

A zero-dependency LLM gateway that puts **one OpenAI-compatible endpoint** in front of a chain of providers and rotates it like a relay race: **provider 1 fails → 2 → 3 … → N → back to 1**, with exponential backoff, circuit breakers, persistent failover memory, request queue and a live dashboard.

> Born from a real production failure: an autonomous coding agent ran for 240+ steps across a FastAPI project, and **one** upstream provider's `HTTP 400: provider rejected the request` at the final summary turn killed the entire run. Ten models were configured — and the run still died, because "many models" is not "a chain that never gives up". OpenRelay is that chain.

```
 MIT license · Node.js ≥ 18 · zero npm dependencies · single-file boot
```

---

## The rotation model

```
        ┌──────────────────────────────────────────────────────┐
        │                                                      │
        ▼                                                      │
   ┌───────┐    ┌───────┐    ┌───────┐         ┌──────────┐    │
   │   1   │ ➜ │   2   │ ➜ │   3   │ ➜  …  ➜ │ free/local│    │
   └───────┘    └───────┘    └───────┘         └──────────┘    │
     explabs      groq        nvidia              :free tail   │
        ▲                                     ollama/lmstudio │
        └──── after backoff (2s → 4s → 8s … cap 30s, full jitter)
              "when it comes to the end, the first one is free again"
```

- **Order is priority.** `config.json`'s `chain` array IS the relay order; put your best provider first and the free/local providers last, so the last line of defense is always zero-cost and unlimited.
- **One pass = a round, not the end.** When a whole round fails, the engine sleeps an exponentially-growing, full-jitter delay and **wraps back to step 1** — a provider that rejected a request gets a fresh turn once the others had theirs.
- **A request only stops when it succeeds** — or when the deadline (`rotation.deadlineMs`, default 120 s) expires, in which case you get a typed `504 relay_exhausted` with a **per-step diagnosis** instead of a raw stack trace.
- **Rate-limited ≠ broken.** `429` + `Retry-After` sets a *short cooldown* (no breaker trip) so the provider rejoins rotation exactly when it is free again — this is how hundreds of requests a day ride on free tiers.
- **Failover memory survives restarts.** Breaker state and usage totals persist to `state/`, so a provider that was cooling down before the restart is still cooling down after it.

## Quick start

```bash
# 1. get the repo (or just copy the folder) — nothing to install
cd openrelay

# 2. drop your keys into config.json (or export the env vars)
cp config.example.json config.json
$EDITOR config.json          # every entry also honors apiKeyEnv

# 3. run
node server.js               # → http://127.0.0.1:8787
```

Open the **dashboard** at `http://127.0.0.1:8787/` — pink glass, live relay ring, breaker states, rotation log, token meters.

Point **any OpenAI SDK / client** at it:

```js
// Node / Python / curl — the key can be anything non-empty
const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "openrelay",
});
const res = await client.chat.completions.create({
  model: "openrelay/auto",           // full chain rotation
  messages: [{ role: "user", content: "hello" }],
});
console.log(res.choices[0].message.content);
console.log(res.openrelay);           // which step served you, attempts, rounds
```

```bash
# minimal curl (streaming)
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"openrelay/auto","stream":true,
       "messages":[{"role":"user","content":"Say OK"}]}'
```

`model` is optional: **omit it or send `openrelay/auto`** for pure chain order, or name a chain model to make it the starting leg (the rest of the chain still backs it up — model-bar semantics).

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/chat/completions` | POST | OpenAI-compatible chat. Streaming (SSE) and non-streaming. Extra response fields/headers: `x-openrelay-step`, `x-openrelay-attempts`, `x-openrelay-round`, `body.openrelay{step,model,attempts,round,elapsedMs}` |
| `/v1/models` | GET | All chain models with `openrelay.rank` — feed this straight into your model picker |
| `/stats` | GET | Live JSON: breaker states, queue depth, per-step usage, rotation log, totals |
| `/healthz` | GET | Liveness + step count |
| `/admin/breaker/reset` | POST | Close every breaker (manual override) |
| `/` | GET | The dashboard |

Errors are typed OpenAI-style:
- `504 relay_exhausted` — every step refused until the deadline; `openrelay.diagnosis[]` lists each failure.
- SSE `event: error` — an upstream died **mid-stream** after bytes were already delivered (unrecoverable for that stream; your client's retry rotates to a healthy step automatically).

## Streaming failover — first-chunk gating

Nothing is forwarded to the client until the upstream produced a real token. Any failure *before* the first chunk (connect errors, `401`, `429`, `5xx`, NIM's famous *HTTP 200 + `{"error":…}` inside the SSE stream*) **fails over silently** — the client never knows. Only a failure *after* delivery surfaces as a typed `event: error`.

## Error classification matrix

| Kind | HTTP examples | Action |
|---|---|---|
| `auth` | 401, 403 | blacklist step for this request; breaker trips fast (dead key) |
| `rate_limited` | 402, 429 | short cooldown honoring `Retry-After`; **no** breaker trip |
| `bad_model` | 400, 404, 422 | rotate to next model; step blacklisted for this request |
| `server` | 5xx, in-stream errors | failure counted; rotate |
| `network`/`timeout` | fetch errors, aborts | failure counted; rotate |

## Config reference (`config.json`)

```jsonc
{
  "server":  { "port": 8787, "host": "127.0.0.1" },
  "rotation": {
    "roundBaseMs": 2000,   // first wrap-around wait
    "roundMaxMs": 30000,   // backoff ceiling
    "maxRounds": 0,        // 0 = rotate forever until deadline
    "deadlineMs": 120000   // wall-clock cap per request
  },
  "breaker": {
    "failureThreshold": 3, // counted failures within windowMs → open
    "windowMs": 120000,
    "cooldownMs": 60000,   // first open duration; doubles per trip
    "maxCooldownMs": 900000
  },
  "queue": { "maxConcurrent": 8, "perEntry": 2 },
  "request": { "timeoutMs": 180000 },
  "local": {
    "autodetect": true,    // Ollama / LM Studio at boot → free tail
    "ollamaUrl": "http://127.0.0.1:11434/v1",
    "lmstudioUrl": "http://127.0.0.1:1234/v1"
  },
  "chain": [
    {
      "id": "explabs",
      "label": "Experiential Labs",
      "baseUrl": "https://api.experientiallabs.ai/v1",
      "apiKey": "…",            // or apiKeyEnv: "EXPLABS_API_KEY" (env wins)
      "models": ["minimax-m2.7-free", "kimi-k2.6"],
      "headers": { "HTTP-Referer": "…", "X-Title": "…" },
      "quirks": {
        "minimalBody": true,    // sampling-pinned catalogs: send only
                                // model/messages/tools/stream/max_tokens
        "includeUsage": true,   // stream_options.include_usage
        "force": { "temperature": 1, "topP": 0.95 },
        "extraBody": { "chat_template_kwargs": { "enable_thinking": true } },
        "timeoutMs": 120000
      },
      "enabled": true
    }
  ]
}
```

Every entry is one OpenAI-compatible upstream: Groq, NVIDIA NIM, OpenRouter (paid + `:free` relay), Experiential Labs, Gemini-compat, OpenAI, Together, Fireworks, DeepInfra, Mistral, **your own** — and local daemons (Ollama, LM Studio, vLLM's OpenAI server on `localhost:8000/v1`) are auto-detected at boot and appended as the free tail.

CLI: `node server.js [--config path] [--port 8787] [--host 0.0.0.0] [--state-dir dir] [--autodetect=0]`

## Using it with the Job Command Center app (or any agent)

The gateway is agent-agnostic — anything that speaks the OpenAI wire. For the Job Command Center's `openai` provider, set in `.env`:

```ini
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=openrelay
OPENAI_MODEL=openrelay/auto
```

…and every LLM call of the app now rides the full rotation chain with memory, breakers and the live dashboard. (The app's *internal* 10-provider chain also has its own v4.4 relay-rounds mode — the two layers compose.)

## Testing

```bash
node test/smoke.js
```

Four phases, real network: a dead provider first in the chain (request still succeeds + breaker trips), an all-dead chain (wrap-around rounds, then typed `504` + diagnosis), streaming with `[DONE]`, and the surface endpoints. Exits non-zero on any failure.

## Project layout

```
openrelay/
├── server.js            # HTTP layer, routes, local autodetect, boot
├── lib/
│   ├── engine.js        # the rotation engine (rounds, wrap-around)
│   ├── providers.js     # wire: payload quirks, classification, SSE
│   ├── breaker.js       # circuit breaker + persistent failover memory
│   ├── queue.js         # global/per-entry concurrency queue
│   └── usage.js         # live token meters + rotation log ring
├── public/index.html    # the pink glass dashboard (no CDN deps)
├── test/smoke.js        # end-to-end failover + wrap-around proof
├── config.json          # your chain (keys)
├── config.example.json  # sanitized template
└── state/               # breaker.json + usage.json (survive restarts)
```

## Roadmap

- vLLM/OpenAI local server autodetect alongside Ollama & LM Studio
- weighted/priority round-robin across rounds (fairness for paid tiers)
- OpenTelemetry export of the rotation log
- multi-config hot reload (SIGHUP)

## License

MIT — see [LICENSE](LICENSE). Ship it inside your product, fork it, rename it. If it saves a run, star it.
