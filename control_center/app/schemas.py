from __future__ import annotations
import ipaddress
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

class Metrics(BaseModel):
    model_config = ConfigDict(extra="ignore")
    normal_rps: float = 0
    attack_rps: float = 0
    blocked_rps: float = 0
    cpu_load_pct: float = 0
    connections_per_sec: float = 0
    active_connections: int = 0

class BlockRecord(BaseModel):
    vip: str
    blocked_at_ms: int | None = None
    unblock_ts: int
    remaining_s: float | None = None

class RecentBlock(BaseModel):
    model_config = ConfigDict(extra="ignore")
    vip: str
    unblock_ts: int

class DecisionRecord(BaseModel):
    vip: str
    allowed: bool
    ts_ms: int
    tokens: float = 0
    window_count: int = 0

class VipStat(BaseModel):
    vip: str
    active_rps: int = 0
    sent: int = 0
    blocked: int = 0
    worker_id: int = 0

class TelemetryFrame(BaseModel):
    model_config = ConfigDict(extra="ignore")
    timestamp: int
    metrics: Metrics = Metrics()
    recent_blocks: list[RecentBlock] = []
    algorithm: str = "token_bucket"
    decisions: list[DecisionRecord] = []
    vip_stats: list[VipStat] = []

class BlockRecord(BaseModel):
    vip: str
    blocked_at_ms: int | None = None
    unblock_ts: int
    remaining_s: float | None = None

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

class ConfigResponse(BaseModel):
    rate_limit_max_rps: int
    rate_limit_block_seconds: int
    attack_max_rps: int
    attack_max_threads: int
    attack_max_duration: int

class WsFrame(BaseModel):
    """chart-shaped frame pushed over the websocket every 0.5s"""
    ts: float
    normal_rps: float
    attack_rps: float
    blocked_rps: float
    cpu_load_pct: float
    connections_per_sec: float = 0
    active_connections: int = 0
    blocks: list[BlockRecord] = []
    algorithm: str = "token_bucket"
    decisions: list[DecisionRecord] = []
    vip_stats: list[VipStat] = []

class BlocksResponse(BaseModel):
    engine_connected: bool
    recent: list[BlockRecord] = []

class AttackRequest(BaseModel):
    rps: int = Field(default=200, ge=10, le=1000)
    threads: int = Field(default=4, ge=1, le=64)
    duration: int = Field(default=10, ge=1, le=300)

class MitigationRequest(BaseModel):
    enabled: bool


class AlgorithmRequest(BaseModel):
    algorithm: Literal["token_bucket", "sliding_window"]


class BaselineRequest(BaseModel):
    enabled: bool
    bots: int = Field(default=8, ge=1, le=32)

class VipBanRequest(BaseModel):
    vip: str

    @field_validator("vip")
    @classmethod
    def public_ipv4(cls, v: str) -> str:
        clean = v.strip()
        try:
            addr = ipaddress.ip_address(clean)
        except ValueError:
            raise ValueError("not a valid IP address")
        if addr.version != 4 or addr.is_loopback:
            raise ValueError("must be a non-loopback IPv4 address")
        return str(addr)

class ControlResponse(BaseModel):
    ok: bool
    reply: str
    engine_reachable: bool = True

class ControlStatus(BaseModel):
    mitigation_on: bool = True
    algorithm: str = "token_bucket"
    attack_running: bool = False
    pid: int = 0
    baseline_running: bool = False
    baseline_bots: int = 0
    attack_params: dict | None = None
    engine_reachable: bool = True
