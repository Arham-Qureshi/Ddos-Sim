import asyncio

from starlette.testclient import TestClient


def test_create_app_sets_state_without_listener(monkeypatch):
    import app.main as m

    calls = []

    async def fake_listener(state, settings):
        calls.append((state, settings))
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            pass

    monkeypatch.setattr(m, "run_udp_listener", fake_listener)
    app = m.create_app()
    assert hasattr(app.state, "state")
    assert hasattr(app.state, "settings")


def test_lifespan_starts_and_stops_listener(monkeypatch):
    import app.main as m

    started = []
    cancelled = []

    async def fake_listener(state, settings):
        started.append((state, settings))
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    monkeypatch.setattr(m, "run_udp_listener", fake_listener)
    app = m.create_app()
    with TestClient(app) as client:
        assert len(started) == 1
        assert client.app.state.state is not None
    assert len(cancelled) == 1
