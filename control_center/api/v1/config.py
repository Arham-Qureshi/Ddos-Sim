from fastapi import APIRouter, Depends

from api.deps import get_settings
from app.config import Settings
from app.schemas import ConfigResponse

router = APIRouter(tags=["config"])


@router.get("/config", response_model=ConfigResponse)
async def config(settings: Settings = Depends(get_settings)) -> ConfigResponse:
    return ConfigResponse(
        rate_limit_max_rps=settings.rate_limit_max_rps,
        rate_limit_block_seconds=settings.rate_limit_block_seconds,
        attack_max_rps=settings.attack_max_rps,
        attack_max_threads=settings.attack_max_threads,
        attack_max_duration=settings.attack_max_duration,
    )