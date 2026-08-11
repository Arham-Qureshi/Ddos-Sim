import time

from fastapi import APIRouter, Depends, Request

from api.deps import get_settings, get_state
from app.config import Settings
from app.schemas import HealthResponse
from app.state import AppState

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health(
    state: AppState = Depends(get_state),
    settings: Settings = Depends(get_settings),
    request: Request = None,
) -> HealthResponse:
    now = time.monotonic()
    age = state.last_rx_age_s(now)
    return HealthResponse(
        status="ok",
        engine_connected=state.engine_connected(now),
        listener_up=state.listener_up,
        last_rx_age_ms=None if age is None else age * 1000,
        dropped_frames=state.dropped_frames,
        uptime_s=now - state.started_at,
        stale_threshold_s=settings.stale_threshold_s,
    )
