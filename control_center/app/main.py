from __future__ import annotations
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from api import api_router
from app.config import Settings, load_settings
from app.state import AppState
from services.udp_listener import run_udp_listener

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    state = AppState(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(run_udp_listener(state, settings))
        app.state.listener_task = task
        try:
            yield
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    app = FastAPI(title="DDOS Sim Command Center", version="0.1.0", lifespan=lifespan)
    app.state.state = state
    app.state.settings = settings
    app.include_router(api_router)
    return app
