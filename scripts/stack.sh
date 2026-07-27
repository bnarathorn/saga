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

# Kill whatever is listening on the API port. Used by `down` so an orphan from a crashed or
# externally started run cannot keep answering health checks with stale code.
kill_port_holder() {
  local port="$1"
  local pids
  pids="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)"
  [[ -z "$pids" ]] && return 0
  for pid in $pids; do
    echo "stopping stale process $pid holding port $port"
    kill -TERM "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 30); do
    ss -ltnH "sport = :$port" 2>/dev/null | grep -q . || return 0
    sleep 0.2
  done
  for pid in $pids; do kill -KILL "$pid" 2>/dev/null || true; done
}

stop_one() {
  local name="$1"
  local pidfile="$RUN_DIR/$name.pid"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      # `setsid` makes the child a process-group leader, so signalling the negative pid
      # reaches the node process too. Killing only the pid would leave a grandchild holding
      # the API port and silently serving stale code.
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 40); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

start_one() {
  local name="$1" entry="$2"
  stop_one "$name"
  # setsid + </dev/null fully detaches the child, so a caller that pipes this script's
  # output (`scripts/stack.sh up | tail`) is not left waiting on an inherited pipe.
  # `node --import tsx` rather than `npx tsx`: one process instead of three, so the pid in
  # the pidfile is the process that actually holds the port.
  ( cd "$ROOT" && setsid nohup node --import tsx "$entry" >"$RUN_DIR/$name.log" 2>&1 </dev/null & echo $! >"$RUN_DIR/$name.pid" )
}

case "${1:-up}" in
  up)
    # A leftover process holding the port would answer /health/live with stale code and make
    # the readiness check below pass against the wrong build.
    if curl -fsS "http://127.0.0.1:$api_port/health/live" >/dev/null 2>&1; then
      echo "port $api_port is already serving; run '$0 down' first (or kill the stale process)" >&2
      exit 1
    fi
    start_one api apps/server/src/main.ts
    start_one worker apps/worker/src/main.ts
    api_pid="$(cat "$RUN_DIR/api.pid")"
    for _ in $(seq 1 60); do
      # A stale process from an earlier run would answer /health/live with old code, so the
      # readiness check also requires *this* process to still be alive.
      if ! kill -0 "$api_pid" 2>/dev/null; then
        echo "api process $api_pid exited during startup; last log lines:" >&2
        tail -20 "$RUN_DIR/api.log" >&2
        exit 1
      fi
      if curl -fsS "http://127.0.0.1:$api_port/health/live" >/dev/null 2>&1; then
        echo "saga stack up (api pid $api_pid, worker pid $(cat "$RUN_DIR/worker.pid"))"
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
    kill_port_holder "$api_port"
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
