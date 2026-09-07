"""Real-time WebSocket event hub.

Every state change in the API is published here and fanned out to all
connected WebSocket clients (dashboard, landing page, external tooling):

* monotonic ``seq`` per event + a ring buffer of the last ``HISTORY`` events
  → clients that reconnect with ``?since=<last seq>`` get **lossless replay**
  (same pattern proven by the JCC agent event bus and vscode-copilot-chat
  session transcripts)
* one background task per hub broadcasts ``server.stats`` heartbeats so
  dashboards tick even without traffic
* slow consumers are dropped (never block a request path on a stuck client)

Wire protocol (server -> client)::

    {"seq": 42, "ts": "2026-09-06T...", "type": "prediction.completed",
     "data": {...}}

Event types: ``server.ready``, ``server.stats``, ``model.uploaded``,
``model.deleted``, ``key.created``, ``key.revoked``,
``prediction.completed``, ``prediction.failed``.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import threading
import time
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger("modelforge.realtime")

HISTORY = 200
STATS_INTERVAL_S = 15.0


class RealtimeHub:
    """Fan-out hub with sequence numbers, replay history and heartbeats."""

    def __init__(self, stats_provider: Any | None = None) -> None:
        self._connections: dict[WebSocket, asyncio.Task | None] = {}
        self._lock = threading.Lock()
        self._seq = itertools.count(1)
        self._history: list[dict[str, Any]] = []
        self._loop: asyncio.AbstractEventLoop | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._stats_provider = stats_provider

    # ── introspection ────────────────────────────────────────────────────

    def client_count(self) -> int:
        with self._lock:
            return len(self._connections)

    def last_seq(self) -> int:
        with self._lock:
            return self._history[-1]["seq"] if self._history else 0

    # ── publishing ───────────────────────────────────────────────────────

    def publish(self, event_type: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
        """Record + fan out one event. Safe to call from sync request handlers."""
        event = {
            "seq": next(self._seq),
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
            "type": event_type,
            "data": data or {},
        }
        with self._lock:
            self._history.append(event)
            if len(self._history) > HISTORY:
                self._history = self._history[-HISTORY:]
        self._dispatch(event)
        return event

    def _dispatch(self, event: dict[str, Any]) -> None:
        """Hand the event to the serving event loop (thread-safe)."""
        loop = self._loop
        if loop is None or not self._connections:
            return
        payload = json.dumps(event, ensure_ascii=False, default=str)
        try:
            running = asyncio.run_coroutine_threadsafe(self._broadcast(payload), loop)
            # request paths should not wait on slow clients; 1s budget
            running.result(timeout=1.0)
        except (TimeoutError, TimeoutError, Exception) as exc:  # noqa: BLE001
            logger.debug("dispatch_skipped err=%s", exc)

    async def _broadcast(self, payload: str) -> None:
        dead: list[WebSocket] = []
        for ws in list(self._connections):
            try:
                await asyncio.wait_for(ws.send_text(payload), timeout=2.0)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self._drop(ws)

    def _drop(self, ws: WebSocket) -> None:
        with self._lock:
            self._connections.pop(ws, None)

    # ── connection lifecycle ─────────────────────────────────────────────

    async def connect(self, ws: WebSocket, *, since: int | None = None) -> None:
        """Accept a client, replay missed events, then pump client messages."""
        await ws.accept()
        with self._lock:
            self._connections[ws] = None
        logger.info("ws_connected clients=%d", self.client_count())

        await ws.send_text(json.dumps({
            "seq": self.last_seq(),
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
            "type": "server.ready",
            "data": {"clients": self.client_count(), "replayed": 0},
        }, ensure_ascii=False))

        if since is not None:
            with self._lock:
                missed = [e for e in self._history if e["seq"] > since]
            for event in missed:
                await ws.send_text(json.dumps(event, ensure_ascii=False, default=str))

        try:
            while True:
                message = await ws.receive_text()
                await self._handle_client_message(ws, message)
        except Exception:  # noqa: BLE001 - normal disconnect path
            pass
        finally:
            self._drop(ws)
            logger.info("ws_disconnected clients=%d", self.client_count())

    async def _handle_client_message(self, ws: WebSocket, message: str) -> None:
        """Minimal client protocol: ``{"type":"ping"}`` -> pong."""
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            await ws.send_text(json.dumps({"type": "server.error", "data": {"message": "invalid json"}}))
            return
        if payload.get("type") == "ping":
            await ws.send_text(json.dumps({"type": "server.pong", "ts": time.time()}))

    # ── heartbeat ────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Bind the hub to the running loop and launch the stats heartbeat."""
        self._loop = asyncio.get_running_loop()
        self._heartbeat_task = self._loop.create_task(self._heartbeat())
        logger.info("hub_started")

    async def stop(self) -> None:
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
        for ws in list(self._connections):
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass
        self._connections.clear()
        logger.info("hub_stopped")

    async def _heartbeat(self) -> None:
        """Broadcast fresh stats periodically while any client is connected."""
        while True:
            await asyncio.sleep(STATS_INTERVAL_S)
            if not self._connections or not self._stats_provider:
                continue
            try:
                stats = self._stats_provider()
                self.publish("server.stats", stats)
            except Exception as exc:  # noqa: BLE001
                logger.warning("heartbeat_failed err=%s", exc)
