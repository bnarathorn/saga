#!/usr/bin/env bash
# Start/stop the API and worker as background processes for manual verification.
#   scripts/stack.sh up      start both, wait for readiness
#   scripts/stack.sh down    stop both
#   scripts/stack.sh restart
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${SAGA_RUN_DIR:-$ROOT/.saga-run}"
mkdir -p "$RUN_DIR"

api_port="${SAGA_API_PORT:-4319}"

stop_one() {
  local name="$1"
  local pidfile="$RUN_DIR/$name.pid"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 30); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

start_one() {
  local name="$1" entry="$2"
  stop_one "$name"
  # setsid + </dev/null fully detaches the child, so a caller that pipes this script's
  # output (`scripts/stack.sh up | tail`) is not left waiting on an inherited pipe.
  ( cd "$ROOT" && setsid nohup npx tsx "$entry" >"$RUN_DIR/$name.log" 2>&1 </dev/null & echo $! >"$RUN_DIR/$name.pid" )
}

case "${1:-up}" in
  up)
    start_one api apps/server/src/main.ts
    start_one worker apps/worker/src/main.ts
    for _ in $(seq 1 60); do
      if curl -fsS "http://127.0.0.1:$api_port/health/live" >/dev/null 2>&1; then
        echo "saga stack up (api pid $(cat "$RUN_DIR/api.pid"), worker pid $(cat "$RUN_DIR/worker.pid"))"
        exit 0
      fi
      sleep 0.5
    done
    echo "api did not become live; last log lines:" >&2
    tail -20 "$RUN_DIR/api.log" >&2
    exit 1
    ;;
  down)
    stop_one api
    stop_one worker
    echo "saga stack down"
    ;;
  restart)
    "$0" down
    "$0" up
    ;;
  logs)
    tail -n "${2:-40}" "$RUN_DIR"/api.log "$RUN_DIR"/worker.log
    ;;
  *)
    echo "usage: $0 {up|down|restart|logs [n]}" >&2
    exit 2
    ;;
esac
