/**
 * ModelForge — Realtime WebSocket client (v2.0)
 *
 * A single connection per page, shared by every widget:
 *   - auto-reconnect with exponential backoff + full jitter (0.5s → 8s)
 *   - lossless replay: tracks the last event `seq` and reconnects with
 *     `?since=<seq>` so nothing published while offline is missed
 *   - connection state publishing for the nav badge (#ws-status)
 *   - simple pub/sub: MFRealtime.onEvent(fn) / MFRealtime.onState(fn)
 *
 * Wire protocol: {"seq": n, "ts": "...", "type": "...", "data": {...}}
 */
'use strict';

window.MFRealtime = (function () {
  const PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const URL = `${PROTOCOL}//${window.location.host}/ws`;

  let socket = null;
  let state = 'offline';        // offline | connecting | live
  let lastSeq = 0;
  let attempts = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  const eventListeners = [];
  const stateListeners = [];

  const MAX_BACKOFF_MS = 8000;
  const BASE_BACKOFF_MS = 500;

  function fullJitter(cap) {
    return Math.random() * cap;
  }

  function setState(next) {
    state = next;
    stateListeners.slice().forEach(fn => {
      try { fn(next); } catch (e) { /* listener bugs must not kill the socket */ }
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempts)) ;
    const wait = fullJitter(delay);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
  }

  function handleEvent(event) {
    if (event && typeof event.seq === 'number') {
      lastSeq = Math.max(lastSeq, event.seq);
    }
    eventListeners.slice().forEach(fn => {
      try { fn(event); } catch (e) { /* keep fan-out alive */ }
    });
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    setState('connecting');
    const since = lastSeq > 0 ? `?since=${lastSeq}` : '';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${proto}//${window.location.host}/ws${since}`);

    socket.onopen = () => {
      attempts = 0;
      setState('live');
      startPing();
    };

    socket.onmessage = (msg) => {
      try {
        handleEvent(JSON.parse(msg.data));
      } catch (e) { /* malformed frame — ignore */ }
    };

    socket.onclose = () => {
      stopPing();
      attempts += 1;
      setState('offline');
      scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose follows; nothing else to do safely here
      try { socket.close(); } catch (e) { /* noop */ }
    };
  }

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopPing();
    attempts = Infinity; // prevent auto-reconnect after manual disconnect
    if (socket) { try { socket.close(); } catch (e) { /* noop */ } }
    setState('offline');
  }

  return {
    connect,
    disconnect,
    onEvent(fn) { if (typeof fn === 'function') eventListeners.push(fn); return () => {
      const i = eventListeners.indexOf(fn); if (i >= 0) eventListeners.splice(i, 1);
    }; },
    onState(fn) { if (typeof fn === 'function') stateListeners.push(fn); fn(state); return () => {
      const i = stateListeners.indexOf(fn); if (i >= 0) stateListeners.splice(i, 1);
    }; },
    get state() { return state; },
    get lastSeq() { return lastSeq; },
    get url() { return URL; },
  };
})();
