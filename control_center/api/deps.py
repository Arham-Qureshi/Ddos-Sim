from fastapi import Request

from app.state import AppState


def get_state(request: Request) -> AppState:
    return request.app.state.state
