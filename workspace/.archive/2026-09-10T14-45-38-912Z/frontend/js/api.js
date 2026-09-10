/**
 * ModelForge — API client + shared UI helpers (v2.0)
 *
 * One client for every page. Normalizes the backend's typed error envelope
 *   {"error": {"code", "message", "request_id"}}
 * into thrown `Error` objects carrying `.code` and `.requestId`, so pages can
 * branch on machine-readable codes. Also hosts the cross-page helpers used
 * by static/main.js (showToast, copyToClipboard, formatBytes, timeAgo).
 */
'use strict';

const API_BASE = '/api';

/** Fetch wrapper: JSON in, JSON out, typed errors out. */
async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { ...(options.headers || {}) },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (body && body.error) {
      const err = new Error(body.error.message || res.statusText);
      err.code = body.error.code;
      err.requestId = body.error.request_id;
      err.status = res.status;
      throw err;
    }
    const err = new Error(res.statusText || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

const api = {
  // ── Models ────────────────────────────────────────────────────────────
  listModels() {
    return request('/models');
  },

  uploadModel(formData) {
    return request('/upload', { method: 'POST', body: formData });
  },

  deleteModel(modelId) {
    return request(`/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
  },

  // ── API Keys ──────────────────────────────────────────────────────────
  listKeys(modelId) {
    return request(`/keys?model_id=${encodeURIComponent(modelId)}`);
  },

  createKey(modelId, purpose, label) {
    return request('/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId, purpose, label }),
    });
  },

  revokeKey(keyId) {
    return request(`/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
  },

  // ── Predictions ───────────────────────────────────────────────────────
  predict(modelId, data, apiKey) {
    return request(`/predict/${encodeURIComponent(modelId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ data }),
    });
  },

  logs(modelId, limit = 100) {
    return request(`/logs/${encodeURIComponent(modelId)}?limit=${limit}`);
  },

  // ── Dashboard / health ────────────────────────────────────────────────
  getStats() {
    return request('/dashboard');
  },

  health() {
    return request('/health');
  },
};

// ── Utility helpers (used by static/main.js and inline handlers) ─────────

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function timeAgo(isoString) {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => showToast('Copied to clipboard!'),
      () => legacyCopy(text),
    );
  } else {
    legacyCopy(text);
  }
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); showToast('Copied to clipboard!'); }
  catch (e) { showToast('Copy failed — select manually', 'error'); }
  document.body.removeChild(ta);
}

let _toastTimeout = null;
function showToast(message, type = 'success') {
  let toast = document.querySelector('.mf-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'mf-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `mf-toast mf-toast-${type} mf-toast-visible`;
  clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => {
    toast.classList.remove('mf-toast-visible');
  }, 3000);
}

// Toast styles kept inline so the API client stays a single drop-in file.
if (!document.getElementById('mf-toast-style')) {
  const toastStyle = document.createElement('style');
  toastStyle.id = 'mf-toast-style';
  toastStyle.textContent = `
    .mf-toast {
      position: fixed;
      bottom: 30px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: #22c55e;
      color: #fff;
      padding: 12px 28px;
      border-radius: 50px;
      font-family: 'Space Grotesk', sans-serif;
      font-size: 0.9rem;
      font-weight: 600;
      z-index: 99999;
      transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      pointer-events: none;
      box-shadow: 0 8px 30px rgba(0,0,0,0.3);
      white-space: nowrap;
      max-width: 90vw;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mf-toast.mf-toast-error { background: #ef4444; }
    .mf-toast.mf-toast-visible { transform: translateX(-50%) translateY(0); }
  `;
  document.head.appendChild(toastStyle);
}
