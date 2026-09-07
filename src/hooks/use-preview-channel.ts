"use client";

// ─────────────────────────────────────────────────────────────
// usePreviewChannel — the client half of the live-preview SSE.
//
// Shared by the full Preview Studio tab and the compact panel in
// the AI Agent view. Reconnects automatically (EventSource does
// the retrying while the stream is mid-error; we re-create it if
// the server retired it), and exposes:
//   • connected     — stream health for the LIVE chip
//   • lastWrite     — {path, ts} of the newest agent write
//   • statsVersion  — increments on every workspace signature
//                     change (external writes safety net)
//   • onStats       — optional callback fired INSIDE the SSE
//     listener (event time, not effect time — React Compiler
//     safe) so consumers can bump reload keys without setState
//     in effects. Receives the age of the newest agent write so
//     consumers can skip reloading when the webview already
//     reloaded itself on that write.
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";

export interface PreviewWrite {
  path: string;
  ts: number;
}

export interface PreviewStatsInfo {
  /** ms since the newest agent write (Infinity if none). */
  lastWriteAgeMs: number;
}

export function usePreviewChannel(opts?: { onStats?: (info: PreviewStatsInfo) => void }) {
  const [connected, setConnected] = useState(false);
  const [lastWrite, setLastWrite] = useState<PreviewWrite | null>(null);
  const [statsVersion, setStatsVersion] = useState(0);

  // keep the newest write timestamp readable inside callbacks
  // without re-subscribing on every event
  const lastWriteTsRef = useRef(0);
  // latest onStats callback (ref so the stream is never re-created)
  const onStatsRef = useRef(opts?.onStats);
  useEffect(() => {
    onStatsRef.current = opts?.onStats;
  }, [opts?.onStats]);

  useEffect(() => {
    let closed = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      try {
        es = new EventSource("/api/preview/events");
      } catch {
        retryTimer = setTimeout(connect, 3000);
        return;
      }
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        // CLOSED (server retired / stream dropped) → manual retry;
        // CONNECTING → EventSource is already reconnecting itself
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          if (!closed) retryTimer = setTimeout(connect, 3000);
        }
      };
      es.addEventListener("write", (ev) => {
        try {
          const d = JSON.parse((ev as MessageEvent<string>).data) as PreviewWrite;
          if (d && typeof d.path === "string") {
            lastWriteTsRef.current = d.ts || Date.now();
            setLastWrite({ path: d.path, ts: d.ts || Date.now() });
          }
        } catch {
          /* malformed event — ignore */
        }
      });
      es.addEventListener("stats", () => {
        setStatsVersion((v) => v + 1);
        const age = lastWriteTsRef.current === 0 ? Infinity : Date.now() - lastWriteTsRef.current;
        try {
          onStatsRef.current?.({ lastWriteAgeMs: age });
        } catch {
          /* consumer callback must never break the stream */
        }
      });
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        es?.close();
      } catch {
        /* already closed */
      }
    };
  }, []);

  return { connected, lastWrite, statsVersion };
}
