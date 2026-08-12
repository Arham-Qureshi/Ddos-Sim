#!/usr/bin/env python3
"""Smoke test for the Ticket 7 control socket (C++ engine).

Boots a real ddos_server against the committed config, drives the admin
TCP channel with raw commands, and checks the resource-bound guarantees:
  - strict validation (bad ip / loopback / unknown cmd / oversize args)
  - one botnet at a time (overlap rejected)
  - attack args clamped to config caps
  - graceful shutdown: SIGTERM -> clean exit, no orphan ddos_botnet
Run from the repo root:  python3 scripts/t7_smoke.py
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

    log = open("/tmp/t7_smoke_server.log", "w")
    proc = subprocess.Popen(
        [str(SERVER), str(CONFIG)],
        cwd=REPO_ROOT, stdout=log, stderr=log, start_new_session=True,
    )
    try:
        if not wait_admin_ready():
            check("admin channel comes up", False)
            return 1
        check("admin channel comes up", True)

        st = json.loads(send("CMD_GET_STATUS").split("OK:STATUS ", 1)[1])
        check("initial status sane", st["mitigation"] is True and st["attack_running"] is False)

        check("unknown command rejected", send("CMD_BOGUS") == "ERR:UNKNOWN_COMMAND")
        check("bad mitigation arg rejected", send("CMD_SET_MITIGATION maybe") == "ERR:INVALID_ARGS")
        check("mitigation off accepted", send("CMD_SET_MITIGATION off") == "OK:MITIGATION off")
        check("mitigation back on", send("CMD_SET_MITIGATION on") == "OK:MITIGATION on")

        check("ban invalid ip rejected", send("CMD_BAN_VIP 999.1.1.1") == "ERR:INVALID_ARGS")
        check("ban loopback rejected", send("CMD_BAN_VIP 127.0.0.1") == "ERR:INVALID_ARGS")
        check("ban vip accepted", send("CMD_BAN_VIP 10.0.0.99").startswith("OK:BANNED"))
        check("unban vip accepted", send("CMD_UNBAN_VIP 10.0.0.99") == "OK:UNBANNED 10.0.0.99")
        check("unban unknown vip rejected", send("CMD_UNBAN_VIP 10.0.0.98") == "ERR:NOT_BANNED 10.0.0.98")

        r = send("CMD_START_ATTACK 200 4 3")
        check("attack starts", r.startswith("OK:ATTACK_STARTED"))
        check("overlapping attack rejected",
              send("CMD_START_ATTACK 200 4 3") == "ERR:ATTACK_ALREADY_RUNNING")
        check("oversize rps rejected (cap 1000)",
              send("CMD_START_ATTACK 5000 4 3") == "ERR:INVALID_ARGS")
        check("oversize threads rejected (cap 64)",
              send("CMD_START_ATTACK 200 300 3") == "ERR:INVALID_ARGS")
        check("oversize duration rejected (cap 300)",
              send("CMD_START_ATTACK 200 4 999") == "ERR:INVALID_ARGS")
        st = json.loads(send("CMD_GET_STATUS").split("OK:STATUS ", 1)[1])
        check("status reflects running attack", st["attack_running"] is True)
        check("one botnet running", botnets_alive() == 1)

        time.sleep(3.6)  # let the 3s run self-terminate
        st = json.loads(send("CMD_GET_STATUS").split("OK:STATUS ", 1)[1])
        check("botnet self-terminates", st["attack_running"] is False)
        check("no botnet after expiry and reap", botnets_alive() == 0)

        check("huge command line rejected",
              send("X" * 600) == "ERR:INVALID_ARGS")

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