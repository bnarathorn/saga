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

# Is this pid something this checkout started, and therefore something `down` may kill?
#
# The default API port is 4319 in a developer's `.env` and 4319 in the systemd reference
# deployment as well, so on a host running both, `down` aims straight at the production
# `saga-api`. It has never landed because that unit runs as another user and the `kill` fails —
# which is luck, not a guard: the same command under `sudo`, or as the service user, would stop
# production. Ownership is therefore checked rather than relied upon.
#
# Two questions, both of which must answer yes:
#   - is the process ours? another user's process is never ours to stop;
#   - was it started from this checkout? `start_one` cds to $ROOT, so a stack this script
#     started has $ROOT as its cwd. A systemd unit lives under /system.slice and does not.
owned_by_this_checkout() {
  local pid="$1" owner cgroup cwd
  owner="$(ps -o user= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$owner" && "$owner" == "$(id -un)" ]] || return 1
  cgroup="$(cat "/proc/$pid/cgroup" 2>/dev/null || true)"
  [[ "$cgroup" == *"/system.slice/"* ]] && return 1
  # No /proc (non-Linux) leaves the cwd unknown; the ownership check above still stands.
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ -z "$cwd" || "$cwd" == "$ROOT" ]]
}

# Kill whatever is listening on the API port. Used by `down` so an orphan from a crashed or
# externally started run cannot keep answering health checks with stale code. It stops only
# processes this checkout started — anything else is reported and left running.
kill_port_holder() {
  local port="$1"
  ss -ltnH "sport = :$port" 2>/dev/null | grep -q . || return 0

  local pids
  pids="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)"
  if [[ -z "$pids" ]]; then
    # `ss` reports the pid only for sockets this user owns, so an unnamed holder is someone
    # else's — the production unit, most likely. Say so instead of failing to bind later.
    echo "port $port is held by a process this user cannot see, so it is not ours to stop." >&2
    echo "Leaving it alone. Set SAGA_API_PORT to a port this checkout owns." >&2
    return 0
  fi

  local pid
  for pid in $pids; do
    if ! owned_by_this_checkout "$pid"; then
      echo "port $port is held by pid $pid ($(ps -o user= -p "$pid" 2>/dev/null | tr -d '[:space:]')," \
        "$(ps -o args= -p "$pid" 2>/dev/null | cut -c1-60)), which this checkout did not start." >&2
      echo "Leaving it alone. Set SAGA_API_PORT to a port this checkout owns." >&2
      return 0
    fi
  done

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
    # A pidfile outlives the process it names, and the kernel reuses pids — so a stale file can
    # name something else entirely by the time `down` reads it. The kill below signals the whole
    # process group, which makes guessing wrong expensive.
    if kill -0 "$pid" 2>/dev/null && ! owned_by_this_checkout "$pid"; then
      echo "$pidfile names pid $pid, which this checkout did not start; leaving it alone" >&2
      rm -f "$pidfile"
      return 0
    fi
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
    # `node --import tsx` compiles the *app* sources on the fly, but `@saga/*` imports resolve
    # through the package exports to `dist`. Without this build the stack serves current route
    # code on top of whatever the domain packages last compiled to — and `scripts/verify.ts`
    # would then be certifying that build rather than the working tree. Both app tsconfigs
    # reference all eight packages, so one invocation covers the API and the worker. `tsc` is
    # addressed by path because this script never goes through pnpm.
    "$ROOT/node_modules/.bin/tsc" -b apps/server apps/worker

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
