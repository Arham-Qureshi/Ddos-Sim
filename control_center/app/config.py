from __future__ import annotations
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[2]

@dataclass
class Settings:
    udp_host: str = "127.0.0.1"
    udp_port: int = 9090
    stale_threshold_s: float = 2.5
    history_len: int = 120
    blocks_cap: int = 64
    control_host: str = "127.0.0.1"
    control_port: int = 9091
    control_timeout_s: float = 2.0
    attack_max_rps: int = 1000
    attack_max_threads: int = 64
    attack_max_duration: int = 300

def load_settings(config_path: Path | None = None) -> Settings:
    path = config_path or (REPO_ROOT / "config" / "ddos_sim_config.json")
    try:
        with path.open() as fh:
            data = json.load(fh)
        return Settings(
            udp_port=data.get("telemetry_udp_port", 9090),
            control_port=data.get("admin_control_port", 9091),
            attack_max_rps=data.get("attack_max_rps", 1000),
            attack_max_threads=data.get("attack_max_threads", 64),
            attack_max_duration=data.get("attack_max_duration", 300),
        )
    except (OSError, ValueError) as exc:
        logger.warning("config %s unreadable (%s); using defaults", path, exc)
        return Settings()
