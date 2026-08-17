from __future__ import annotations
import asyncio
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.schemas import WsFrame

router = APIRouter(tags=["ws"])

_TICK_S = 0.5


def _build_frame(state) -> WsFrame | None:
    """latest telemetry reshaped for the chart, or None while silent"""
    latest = state.latest
    if latest is None:
        return None
    blocks = [
        {"vip": b.vip, "unblock_ts": b.unblock_ts, "remaining_s": b.remaining_s}
        for b in state.recent_blocks_snapshot()
    ]
    return WsFrame(
        ts=latest.timestamp,
        normal_rps=latest.metrics.normal_rps,
        attack_rps=latest.metrics.attack_rps,
        blocked_rps=latest.metrics.blocked_rps,
        cpu_load_pct=latest.metrics.cpu_load_pct,
        connections_per_sec=latest.metrics.connections_per_sec,
        active_connections=latest.metrics.active_connections,
        blocks=blocks,
        algorithm=latest.algorithm,
        decisions=[d.model_dump() for d in latest.decisions],
    )


@router.websocket("/ws/telemetry")
async def ws_telemetry(websocket: WebSocket) -> None:
    state = websocket.app.state.state
    await websocket.accept()
    try:
        while True:
            frame = _build_frame(state)
            await websocket.send_json(frame.model_dump() if frame else None)
            await asyncio.sleep(_TICK_S)
    except WebSocketDisconnect:
        pass