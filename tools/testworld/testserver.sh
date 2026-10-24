#!/usr/bin/env bash
# testserver.sh — run a sealed test world (built by build.js) on a second local server.
#
#   tools/testworld/testserver.sh start <name>   reset testserver/world from test-worlds/<name>, start on :25566
#   tools/testworld/testserver.sh reset <name>   stop, reset, start again (fresh copy of the template)
#   tools/testworld/testserver.sh stop
#
# The main server (server/, :25565) is never touched. Console commands go through the FIFO:
#   echo 'tp Bot 8 112 120' > testserver/server.stdin     (output in testserver/server.log)
# Connect a bot with MC_PORT=25566, and give it a throwaway data dir so its memory of the
# world doesn't carry over between runs:
#   MC_PORT=25566 IONGOLEM_DATA_DIR=$(mktemp -d) node bot.js BotT --debug --no-ai --no-chat
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="$PROJECT/testserver"
TEMPLATES="$PROJECT/test-worlds"
LOG="$DIR/server.log"
FIFO="$DIR/server.stdin"
JAR="$DIR/server.jar"

die()  { echo "ERROR: $*" >&2; exit 1; }
info() { echo ":: $*"; }

server_pid() { pgrep -f "java .*-jar $JAR" || true; }

do_start() {
    local name="${1:-}"
    [[ -n "$name" ]] || die "usage: $0 start <name>   (templates: $(ls "$TEMPLATES" 2>/dev/null | tr '\n' ' '))"
    [[ -f "$TEMPLATES/$name/level.dat" ]] || die "no template $TEMPLATES/$name (build it with tools/testworld/build.js)"
    [[ -f "$DIR/server.properties" ]] || die "$DIR is not set up (run tools/testworld/build.js once)"
    [[ -z "$(server_pid)" ]] || die "test server already running (PID $(server_pid)); use reset or stop"

    rm -rf "$DIR/world"
    cp -r "$TEMPLATES/$name" "$DIR/world"
    rm -f "$FIFO" "$LOG"
    mkfifo "$FIFO"
    cd "$DIR"
    setsid bash -c "tail -f '$FIFO' | exec java -Xms512M -Xmx1G -jar '$JAR' nogui" > "$LOG" 2>&1 < /dev/null &
    local elapsed=0
    until grep -q '\[Server thread/INFO\].*Done (' "$LOG" 2>/dev/null; do
        (( elapsed < 120 )) || die "server not ready after 120s, see $LOG"
        sleep 1
        (( elapsed += 1 ))
    done
    info "test world '$name' up on localhost:25566 (PID $(server_pid))"
    tr -d '\n' < "$DIR/world/testworld.json" | tr -s ' '; echo
}

do_stop() {
    local pid
    pid="$(server_pid)"
    if [[ -z "$pid" ]]; then
        info "test server not running"
    else
        echo stop > "$FIFO"
        local elapsed=0
        while kill -0 "$pid" 2>/dev/null && (( elapsed < 30 )); do sleep 1; (( elapsed += 1 )); done
        kill -0 "$pid" 2>/dev/null && kill "$pid"
        info "test server stopped"
    fi
    pkill -f "tail -f $FIFO" || true
    rm -f "$FIFO"
}

case "${1:-}" in
    start) do_start "${2:-}" ;;
    stop)  do_stop ;;
    reset) do_stop; do_start "${2:-}" ;;
    *)     echo "usage: $0 start <name> | reset <name> | stop" >&2; exit 1 ;;
esac
