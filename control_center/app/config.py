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

def load_settings(config_path: Path | None = None) -> Settings:
    path = config_path or (REPO_ROOT / "config" / "ddos_sim_config.json")
    try:
        with path.open() as fh:
            data = json.load(fh)
        return Settings(udp_port=data.get("telemetry_udp_port", 9090))
    except (OSError, ValueError) as exc:
        logger.warning("config %s unreadable (%s); using defaults", path, exc)
        return Settings()
