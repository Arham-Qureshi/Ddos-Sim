from __future__ import annotations
from pydantic import BaseModel, ConfigDict

class Metrics(BaseModel):
    model_config = ConfigDict(extra="ignore")
    normal_rps: float = 0
    attack_rps: float = 0
    blocked_rps: float = 0
    cpu_load_pct: float = 0
    active_connections: int = 0

class RecentBlock(BaseModel):
    model_config = ConfigDict(extra="ignore")
    vip: str
    unblock_ts: int

class TelemetryFrame(BaseModel):
    model_config = ConfigDict(extra="ignore")
    timestamp: int
    metrics: Metrics = Metrics()
    recent_blocks: list[RecentBlock] = []

class BlockRecord(BaseModel):
    vip: str
    blocked_at_ms: int | None = None
    unblock_ts: int

class HealthResponse(BaseModel):
    status: str
    engine_connected: bool
    listener_up: bool
    last_rx_age_ms: float | None = None
    dropped_frames: int
    uptime_s: float
    stale_threshold_s: float

class TelemetryResponse(BaseModel):
    engine_connected: bool
    latest: TelemetryFrame | None = None
    history: list[TelemetryFrame] = []
    history_len: int = 0

class WsFrame(BaseModel):
    """chart-shaped frame pushed over the websocket every 0.5s"""
    ts: float
    normal_rps: float
    attack_rps: float
    blocked_rps: float
    cpu_load_pct: float
    active_connections: int
    blocks: list[BlockRecord] = []

class BlocksResponse(BaseModel):
    engine_connected: bool
    recent: list[BlockRecord] = []
