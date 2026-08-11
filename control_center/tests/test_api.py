import time

from fastapi.testclient import TestClient

from app.main import create_app
from app.schemas import Metrics, TelemetryFrame


def client():
    return TestClient(create_app())


def test_health_engine_lost_without_data():
    with client() as c:
        r = c.get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert body["engine_connected"] is False
        assert "listener_up" in body


async def test_health_connected_after_frame():
    app = create_app()
    await app.state.state.update(
        TelemetryFrame(timestamp=1, metrics=Metrics(normal_rps=2)),
        now=time.monotonic(),
    )
    with TestClient(app) as c:
        r = c.get("/api/health")
        assert r.json()["engine_connected"] is True


def test_health_reports_stale_threshold():
    with client() as c:
        body = c.get("/api/health").json()
        assert body["stale_threshold_s"] > 0


def test_telemetry_latest_returns_frame_and_history():
    with client() as c:
        got = c.get("/api/telemetry/latest")
        assert got.status_code == 200
        assert got.json()["engine_connected"] is False
        assert got.json()["latest"] is None
        assert got.json()["history"] == []


def test_blocks_returns_recent():
    with client() as c:
        r = c.get("/api/blocks")
        assert r.status_code == 200
        assert "recent" in r.json()
