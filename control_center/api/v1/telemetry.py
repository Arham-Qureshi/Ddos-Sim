import time

from fastapi import APIRouter, Depends

from api.deps import get_state
from app.schemas import TelemetryResponse
from app.state import AppState

router = APIRouter(tags=["telemetry"])


@router.get("/telemetry/latest", response_model=TelemetryResponse)
async def telemetry_latest(state: AppState = Depends(get_state)) -> TelemetryResponse:
    now = time.monotonic()
    history = state.history_snapshot()
    return TelemetryResponse(
        engine_connected=state.engine_connected(now),
        latest=state.latest,
        history=history,
        history_len=len(history),
    )
