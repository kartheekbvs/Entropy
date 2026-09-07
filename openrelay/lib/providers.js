'use strict';
// ─────────────────────────────────────────────────────────────────
// OpenRelay provider wire — one OpenAI-compatible HTTP transport
// for every entry in the chain, with per-entry payload quirks:
//
//   minimalBody : true      → explabs-style catalogs that pin their
//                             own sampling params: only model/
//                             messages/tools/stream/max_tokens
//   force {temperature,…}   → NIM-style: exact sampling required
//   extraBody {…}           → merged top-level (chat_template_kwargs…)
//   includeUsage : true     → stream_options.include_usage (usage
//                             arrives in the final SSE chunk)
//   headers {…}             → OpenRouter HTTP-Referer / X-Title
//
// Errors are CLASSIFIED, never stringly-typed:
//   auth | rate_limited | bad_model | server | network | timeout
// Rate-limits carry retryAfterMs (Retry-After honored, capped).
// ─────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(kind, status, message, extra) {
    super(message || kind);
    this.name = 'ApiError';
    this.kind = kind;       // auth | rate_limited | bad_model | server | network | timeout
    this.status = status || 0;
    Object.assign(this, extra || {}); // retryAfterMs, midStream, bodyText
  }
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 429) return 'rate_limited';
  if (status === 400 || status === 404 || status === 422 || status === 413) return 'bad_model';
  return 'server';
}

/** Retry-After (seconds float or HTTP-date) → ms, capped at 60s. */
function retryAfterMs(res) {
  const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (!raw) return undefined;
  const asSec = Number(raw);
  if (Number.isFinite(asSec) && asSec >= 0) return Math.min(asSec * 1000, 60000);
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, Math.min(asDate - Date.now(), 60000));
  return undefined;
}

/** Build the exact JSON body this entry expects for this request. */
function buildPayload(entry, model, body) {
  const q = entry.quirks || {};
  const p = { model, messages: body.messages };
  if (Array.isArray(body.tools) && body.tools.length) p.tools = body.tools;
  if (body.tool_choice !== undefined) p.tool_choice = body.tool_choice;
  if (body.stream) {
    p.stream = true;
    if (q.includeUsage) p.stream_options = { include_usage: true };
  }
  if (body.max_tokens !== undefined && body.max_tokens !== null) p.max_tokens = body.max_tokens;
  else if (q.force && q.force.maxTokens) p.max_tokens = q.force.maxTokens;

  if (q.minimalBody) {
    // Sampling-pinned catalog (Experiential Labs): send ONLY the
    // documented-safe fields; extra params 400.
    return p;
  }
  if (q.force) {
    if (q.force.temperature !== undefined) p.temperature = q.force.temperature;
    if (q.force.topP !== undefined) p.top_p = q.force.topP;
  } else {
    if (body.temperature !== undefined && body.temperature !== null) p.temperature = body.temperature;
    if (body.top_p !== undefined && body.top_p !== null) p.top_p = body.top_p;
  }
  if (Array.isArray(body.stop) && body.stop.length) p.stop = body.stop;
  if (q.extraBody) Object.assign(p, q.extraBody);
  return p;
}

/** POST /chat/completions to one entry. Throws classified ApiError. */
async function callUpstream(entry, model, body, { timeoutMs, signal, onAbort }) {
  const url = entry.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const key = entry.apiKeyEnv && process.env[entry.apiKeyEnv] ? process.env[entry.apiKeyEnv] : entry.apiKey;
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
  };
  if (entry.headers) Object.assign(headers, entry.headers);
  const q = entry.quirks || {};
  const payload = buildPayload(entry, model, body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new ApiError('timeout', 0, `${entry.id}: request timed out after ${q.timeoutMs || timeoutMs}ms`)), q.timeoutMs || timeoutMs);
  const onClientAbort = () => ctrl.abort(new ApiError('network', 0, 'client disconnected'));
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new ApiError('network', 0, 'client disconnected'); }
    signal.addEventListener('abort', onClientAbort, { once: true });
  }
  if (onAbort) onAbort(() => { clearTimeout(timer); ctrl.abort(new ApiError('network', 0, 'client disconnected')); });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof ApiError) throw e;
    throw new ApiError('network', 0, `${entry.id}: ${e && e.message ? e.message : String(e)}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const kind = classifyStatus(res.status);
    throw new ApiError(kind, res.status, `${entry.id} · ${model}: HTTP ${res.status}: ${text.slice(0, 300)}`, { retryAfterMs: retryAfterMs(res), bodyText: text.slice(0, 500) });
  }
  return res;
}

/**
 * Read an SSE upstream body line-by-line.
 * Yields { line, json } where json is the parsed data payload when the
 * line is a `data:` line (null otherwise; [DONE] yields json === '[DONE]').
 * Throws ApiError('server') when a provider embeds an error object in
 * the stream (NIM: HTTP 200 + {"error":{...}} inside SSE).
 */
async function* sseLines(res, entryId) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        yield { line, json: parseDataLine(line) };
      }
    }
    if (buf.trim().length) yield { line: buf, json: parseDataLine(buf) };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('network', 0, `${entryId}: stream read failed: ${e && e.message ? e.message : String(e)}`);
  }
}

function parseDataLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (data === '[DONE]') return '[DONE]';
  try { return JSON.parse(data); } catch { return null; }
}

module.exports = { ApiError, classifyStatus, retryAfterMs, buildPayload, callUpstream, sseLines };
