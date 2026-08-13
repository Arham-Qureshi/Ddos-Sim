from fastapi import APIRouter

from api.v1 import blocks, config, control, health, telemetry, ws

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(config.router)
api_router.include_router(telemetry.router)
api_router.include_router(blocks.router)
api_router.include_router(ws.router)
api_router.include_router(control.router)
