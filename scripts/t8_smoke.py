#!/usr/bin/env python3
"""Smoke test for the Ticket 8 admin controls (C++ engine).

Boots a real ddos_server against the committed config and drives the
admin TCP channel to exercise the new command surface:
  - CMD_SET_ALGORITHM (runtime token_bucket <-> sliding_window)
  - CMD_SET_BASELINE on/off (normal-mode botnet, fixed VIPs, persists)
  - CMD_EMERGENCY_STOP (kills attack + baseline instantly)
  - enriched CMD_GET_STATUS (algorithm / baseline_* / attack_params)
Run from the repo root:  python3 scripts/t8_smoke.py
Requires: stdlib only (socket, subprocess, json, time, pathlib).
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
CONFIG = REPO_ROOT / "config" / "ddos_sim_config.json"
ADMIN_PORT = 9091
ADMIN_HOST = "127.0.0.1"
BOTNET_NAME = "ddos_botnet"

results: list[tuple[str, bool]] = []


def check(name: str, cond: bool) -> None:
    results.append((name, cond))
    print(f"{'PASS' if cond else 'FAIL'}: {name}")


def send(line: str, timeout: float = 8.0) -> str:
    """send one newline-terminated command, return the reply line"""
    with socket.create_connection((ADMIN_HOST, ADMIN_PORT), timeout=timeout) as s:
        s.sendall(line.encode() + b"\n")
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(1024)
            if not chunk:
                break
            data += chunk
    return data.decode().strip()


def status() -> dict:
    return json.loads(send("CMD_GET_STATUS").split("OK:STATUS ", 1)[1])


def wait_admin_ready(timeout_s: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            send("CMD_GET_STATUS", timeout=1.0)
            return True
        except OSError:
            time.sleep(0.2)
    return False


def botnets_alive() -> int:
    return int(subprocess.run(
        ["pgrep", "-xc", BOTNET_NAME], capture_output=True, text=True
    ).stdout.strip() or "0")


def main() -> int:
    cfg = json.loads(CONFIG.read_text())
    if cfg["admin_control_port"] != ADMIN_PORT:
        print("config admin_control_port mismatch; expected", ADMIN_PORT)
        return 1
    if not SERVER.exists():
        print("engine not built; run: cmake --build build")
        return 1

    log = open("/tmp/t8_smoke_server.log", "w")
    proc = subprocess.Popen(
        [str(SERVER), str(CONFIG)],
        cwd=REPO_ROOT, stdout=log, stderr=log, start_new_session=True,
    )
    try:
        if not wait_admin_ready():
            check("admin channel comes up", False)
            return 1
        check("admin channel comes up", True)

        st = status()
        check("initial status carries new fields",
              "algorithm" in st and "baseline_running" in st and "attack_params" in st)
        check("default algorithm is token_bucket", st["algorithm"] == "token_bucket")
        check("no baseline at boot", st["baseline_running"] is False)
        check("attack_params snapshot present", st["attack_params"] == {"rps": 0, "threads": 0, "duration": 0})

        check("unknown algorithm rejected", send("CMD_SET_ALGORITHM leap_year") == "ERR:INVALID_ARGS")
        check("algorithm switch to sliding_window",
              send("CMD_SET_ALGORITHM sliding_window") == "OK:ALGORITHM sliding_window")
        st = status()
        check("status reflects algorithm switch", st["algorithm"] == "sliding_window")
        check("switch back to token_bucket",
              send("CMD_SET_ALGORITHM token_bucket") == "OK:ALGORITHM token_bucket")
        st = status()
        check("status reflects switch back", st["algorithm"] == "token_bucket")

        check("baseline zero bots rejected", send("CMD_SET_BASELINE on 0") == "ERR:INVALID_ARGS")
        check("baseline bad bots rejected", send("CMD_SET_BASELINE on 999") == "ERR:INVALID_ARGS")
        r = send("CMD_SET_BASELINE on 6")
        check("baseline starts", r.startswith("OK:BASELINE_STARTED"))
        st = status()
        check("status reflects baseline running", st["baseline_running"] is True)
        check("status reports baseline bots", st["baseline_bots"] == 6)
        check("one botnet (baseline) alive", botnets_alive() == 1)
        check("overlapping baseline rejected",
              send("CMD_SET_BASELINE on 4") == "ERR:BASELINE_ALREADY_RUNNING")

        # attack can run alongside baseline; emergency stop nukes both
        r = send("CMD_START_ATTACK 200 4 3")
        check("attack starts alongside baseline", r.startswith("OK:ATTACK_STARTED"))
        st = status()
        check("status shows both running",
              st["baseline_running"] is True and st["attack_running"] is True)
        check("attack_params captured", st["attack_params"] == {"rps": 200, "threads": 4, "duration": 3})

        check("emergency stop issued", send("CMD_EMERGENCY_STOP") == "OK:EMERGENCY_STOP")
        st = status()
        check("emergency stop clears both", st["attack_running"] is False and st["baseline_running"] is False)
        check("no botnet after emergency stop", botnets_alive() == 0)

        # baseline persists across a stop command (graceful path)
        send("CMD_SET_BASELINE on 3")
        time.sleep(0.3)
        check("baseline restart accepted", status()["baseline_running"] is True)
        check("baseline stop accepted", send("CMD_SET_BASELINE off") == "OK:BASELINE_STOPPED")
        check("baseline off reflected in status", status()["baseline_running"] is False)
        check("baseline off -> no botnet", botnets_alive() == 0)

        # graceful shutdown: SIGTERM, clean exit, no orphan botnet
        proc.terminate()
        try:
            proc.wait(timeout=6.0)
            check("server exits on SIGTERM", True)
        except subprocess.TimeoutExpired:
            check("server exits on SIGTERM", False)
        check("no orphan botnet after shutdown", botnets_alive() == 0)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        log.close()

    failed = [name for name, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("failed:", ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
