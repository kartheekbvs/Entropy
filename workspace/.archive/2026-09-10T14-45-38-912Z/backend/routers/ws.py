"""WebSocket telemetry endpoint (``/ws``).

Query params:
    ``since`` — last event ``seq`` seen by the client. The hub replays every
    buffered event with a greater seq before live streaming, making
    reconnects lossless.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from backend.dependencies import get_hub
from backend.realtime import RealtimeHub

router = APIRouter(tags=["realtime"])


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, hub: RealtimeHub = Depends(get_hub)) -> None:
    """Stream realtime events to a connected client until it disconnects."""
    since_raw = ws.query_params.get("since")
    try:
        since = int(since_raw) if since_raw is not None else None
    except ValueError:
        since = None
    try:
        await hub.connect(ws, since=since)
    except WebSocketDisconnect:
        pass
