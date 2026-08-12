#!/usr/bin/env bash
# Single-command runner for the whole DDoS stack: C++ engine, FastAPI
# command center, and the static dashboard host. Background daemons,
# logs under build/logs, pids tracked so `stop` can take them all down.
#
#   ./scripts/run.sh         start everything and wait until healthy
#   ./scripts/run.sh stop    shut it all down cleanly
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$REPO_ROOT/build/.run.pids"
LOG_DIR="$REPO_ROOT/build/logs"
UV="${UV:-$HOME/.local/bin/uv}"
ENGINE="$REPO_ROOT/build/ddos_server"
CONFIG="$REPO_ROOT/config/ddos_sim_config.json"

ADMIN_PORT=9091   # mirrors config admin_control_port
API_PORT=8000     # mirrors config dashboard_ui_port
FE_PORT=8081      # static host serving the dashboard

# re-export styles with a little warmth the hard-nosed checks deserve
ok()  { printf '  \033[1;32m[ok]\033[0m %s\n' "$*"; }
warn(){ printf '  \033[1;33m[warn]\033[0m %s\n' "$*"; }

pids_alive() {
    # true when any pid we track is still running
    [[ -f "$PID_FILE" ]] && while read -r _ pid; do
        kill -0 "$pid" 2>/dev/null && return 0
    done < "$PID_FILE"
    return 1
}

spawn() {
    # setsid+nohup so the daemons outlive this shell (AGENTS.md), log to file
    local name="$1" dir="$2"; shift 2
    (
        cd "$dir"
        setsid nohup "$@" >> "$LOG_DIR/$name.log" 2>&1 &
        echo $! > "$LOG_DIR/$name.pid.$$"
    )
    # the inner subshell captured its own $$; read the real pid back
    while [[ ! -f "$LOG_DIR/$name.pid.$$" ]]; do sleep 0.05; done
    local pid
    pid="$(cat "$LOG_DIR/$name.pid.$$")"
    rm -f "$LOG_DIR/$name.pid.$$"
    echo "$pid"
}

wait_tcp() {
    # python one-liner beats relying on nc being installed
    python3 - "$1" "$2" <<'PY'
import socket, sys, time
host, port = sys.argv[1], int(sys.argv[2])
deadline = time.monotonic() + 20
while time.monotonic() < deadline:
    try:
        with socket.create_connection((host, port), timeout=1):
            sys.exit(0)
    except OSError:
        time.sleep(0.3)
sys.exit(1)
PY
}

wait_url() {
    # poll an HTTP url until it answers (uvicorn takes a second to boot)
    local url="$1"
    for _ in $(seq 1 40); do
        if curl -sf --max-time 2 "$url" >/dev/null; then
            return 0
        fi
        sleep 0.5
    done
    return 1
}

start() {
    if pids_alive; then
        warn "stack already running — './scripts/run.sh stop' first"
        exit 1
    fi

    cmake --build "$REPO_ROOT/build" >/dev/null
    mkdir -p "$LOG_DIR"
    : > "$PID_FILE"

    ok "booting target server on 127.0.0.1:8080"
    engine_pid="$(spawn engine "$REPO_ROOT" "$ENGINE" "$CONFIG")"
    echo "engine $engine_pid" >> "$PID_FILE"

    ok "booting command center (FastAPI) on 127.0.0.1:8000"
    api_pid="$(spawn api "$REPO_ROOT/control_center" "$UV" run uvicorn app.main:create_app --factory --port "$API_PORT")"
    echo "api $api_pid" >> "$PID_FILE"

    ok "serving dashboard on http://localhost:8081"
    fe_pid="$(spawn dashboard "$REPO_ROOT/frontend" python3 -m http.server "$FE_PORT" --bind 127.0.0.1)"
    echo "dashboard $fe_pid" >> "$PID_FILE"

    ok "waiting for everything to come up…"
    if wait_tcp 127.0.0.1 "$ADMIN_PORT"; then ok "engine control channel up (9091)"; else warn "engine control channel did not come up"; fi
    if wait_url "http://127.0.0.1:$API_PORT/api/health"; then ok "command center healthy (8000)"; else warn "backend not answering /api/health"; fi
    if wait_url "http://127.0.0.1:$FE_PORT/"; then ok "dashboard reachable (8081)"; else warn "static host not answering"; fi

    if ! alivemeter; then
        warn "some daemons crashed — scroll up for their logs, then run './scripts/run.sh stop'"
        exit 1
    fi

    printf '\n  stack is live:\n'
    printf '    dashboard  -> http://localhost:%s\n' "$FE_PORT"
    printf '    api        -> http://localhost:%s\n' "$API_PORT"
    printf '    logs       -> %s\n' "$LOG_DIR"
    printf '    hit Launch Attack in the browser to drive the botnet (Ticket 7)\n'
}

stop() {
    if [[ ! -f "$PID_FILE" ]]; then
        warn "nothing tracked — checking for strays anyway"
    fi

    local pid
    while read -r _ pid; do
        kill "$pid" 2>/dev/null || true
    done < "$PID_FILE" 2>/dev/null || true

    # sweep strays so nothing holds the ports afterwards. -x is exact for
    # the C++ binaries; -f patterns target only OUR daemons so a normal
    # './run.sh stop' (which has none of these in its own argv) is safe.
    pkill -x ddos_server 2>/dev/null || true
    pkill -x ddos_botnet 2>/dev/null || true
    pkill -f "uvicorn app.main:create_app" 2>/dev/null || true
    pkill -f "http.server 8081" 2>/dev/null || true

    # give them a beat, then escalate on anything stubborn
    sleep 1
    while read -r _ pid; do
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    done < "$PID_FILE" 2>/dev/null || true

    rm -f "$PID_FILE"
    ok "stopped"
}

# names of the daemons we manage, for the alive-check after booting
declare -A DAEMON_NAME=( [engine]=ddos_server [api]=uvicorn [dashboard]=http.server )

alivemeter() {
    # once everything is up, confirm each spawned pid has really survived;
    # a dead one dumps its log tail so the failure reads loud and clear
    local i pid status=0
    while read -r i pid; do
        if ! kill -0 "$pid" 2>/dev/null; then
            warn "process [$i] (pid $pid) died — last log lines:"
            tail -n 5 "$LOG_DIR/$i.log" 2>/dev/null | sed 's/^/      /'
            status=1
        fi
    done < "$PID_FILE"
    return "$status"
}

case "${1:-start}" in
    start) start ;;
    stop)  stop ;;
    *) warn "usage: $0 [start|stop]"; exit 2 ;;
esac