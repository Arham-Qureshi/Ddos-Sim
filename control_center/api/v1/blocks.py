import time

from fastapi import APIRouter, Depends

from api.deps import get_state
from app.schemas import BlocksResponse
from app.state import AppState

router = APIRouter(tags=["blocks"])


@router.get("/blocks", response_model=BlocksResponse)
async def blocks(state: AppState = Depends(get_state)) -> BlocksResponse:
    now = time.monotonic()
    return BlocksResponse(
        engine_connected=state.engine_connected(now),
        recent=state.recent_blocks_snapshot(),
    )
