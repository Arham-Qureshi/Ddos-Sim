from fastapi import Request

from app.config import Settings
from app.state import AppState


def get_state(request: Request) -> AppState:
    return request.app.state.state


def get_settings(request: Request) -> Settings:
    return request.app.state.settings
