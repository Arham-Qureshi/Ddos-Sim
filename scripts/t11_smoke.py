#!/usr/bin/env python3
"""Smoke test for Ticket 11 per-decision telemetry (C++ engine).

Boots a real ddos_server, launches a short ddos_botnet burst, and reads the
UDP telemetry to confirm the payload now carries the active algorithm and the
per-packet decision ring.
Run from the repo root:  python3 scripts/t11_smoke.py
"""

from __future__ import annotations

import json
import pathlib
import socket
import subprocess
import sys
import time

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVER = REPO_ROOT / "build" / "ddos_server"
BOTNET = REPO_ROOT / "build" / "ddos_botnet"
CONFIG = REPO_ROOT / "config" / "ddos_sim_config.json"
UDP_PORT = 9090
SERVER_TCP = 8080

results: list[tuple[str, bool]] = []


def check(name: str, cond: bool) -> None:
    results.append((name, cond))
    print(f"{'PASS' if cond else 'FAIL'}: {name}")


def wait_port(port: int, timeout: float = 8.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.25)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.2)
    return False


def read_frames(duration_s: float) -> list[dict]:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", UDP_PORT))
    sock.settimeout(0.3)
    frames: list[dict] = []
    deadline = time.monotonic() + duration_s
    while time.monotonic() < deadline:
        try:
            data, _ = sock.recvfrom(65535)
        except socket.timeout:
            continue
        try:
            frames.append(json.loads(data.decode("utf-8")))
        except (ValueError, UnicodeDecodeError):
            continue
    sock.close()
    return frames


def main() -> int:
    cfg = json.loads(CONFIG.read_text())
    if cfg.get("telemetry_udp_port") != UDP_PORT:
        print(f"config telemetry_udp_port is {cfg.get('telemetry_udp_port')}, expected {UDP_PORT}")
        return 2
    if not SERVER.exists():
        print(f"missing {SERVER} — run: cmake -S engine -B build && cmake --build build")
        return 2

    server = subprocess.Popen([str(SERVER), str(CONFIG)])
    try:
        if not wait_port(SERVER_TCP):
            check("server listens on 8080", False)
            return 1
        # a 3s burst at 120rps is enough to overflow the token bucket (limit 2)
        botnet = subprocess.Popen(
            [str(BOTNET), "--rps", "120", "--threads", "4", "--duration", "3"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            frames = read_frames(5.0)
        finally:
            botnet.terminate()
            try:
                botnet.wait(timeout=5)
            except subprocess.TimeoutExpired:
                botnet.kill()

        check("received >= 5 telemetry frames", len(frames) >= 5)
        with_decisions = [f for f in frames if f.get("decisions")]
        with_algorithm = [f for f in frames if f.get("algorithm")]
        check("payload carries algorithm", len(with_algorithm) >= 1)
        check("payload carries decisions", len(with_decisions) >= 1)
        if with_decisions:
            d = with_decisions[0]["decisions"][0]
            check("decision keys vip/allowed/ts_ms/tokens/window_count",
                  all(k in d for k in ("vip", "allowed", "ts_ms", "tokens", "window_count")))
            check("decision vip is a 10.0.0.x address", d["vip"].startswith("10.0.0."))
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    failed = [name for name, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
