#!/bin/bash
#
# Development server launcher
# Usage: ./scripts/dev.sh [start|stop|restart|status|logs]
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGER_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$SCRIPT_DIR/.dev.pid"
LOG_FILE="$SCRIPT_DIR/.dev.log"
ENV_FILE="$SCRIPT_DIR/.env.dev"

# Clean up old PID/log files from previous location (manager/.dev.*)
OLD_PID_FILE="$MANAGER_DIR/.dev.pid"
if [ -f "$OLD_PID_FILE" ]; then
    OLD_PID=$(cat "$OLD_PID_FILE")
    if ps -p "$OLD_PID" > /dev/null 2>&1; then
        echo "Stopping old server (PID: $OLD_PID)..."
        kill "$OLD_PID" 2>/dev/null || true
        sleep 1
    fi
    rm -f "$OLD_PID_FILE" "$MANAGER_DIR/.dev.log"
fi

# Source environment from .env.dev if it exists
if [ -f "$ENV_FILE" ]; then
    set -a
    source "$ENV_FILE"
    set +a
else
    echo "Note: Create $ENV_FILE for persistent dev settings"
    echo ""
fi

# Defaults (env file or command line can override)
export TEST_USERNAME="${TEST_USERNAME:-testuser}"
export TEST_PASSWORD="${TEST_PASSWORD:-testpass}"
export ADMIN_USER="${ADMIN_USER:-$TEST_USERNAME}"
export JWT_SECRET="${JWT_SECRET:-dev-secret-do-not-use-in-production}"

# Use test database (separate from production)
mkdir -p "$MANAGER_DIR/data"
export DB_PATH="${DB_PATH:-$MANAGER_DIR/data/test_app.db}"

# Legacy JSON files (still used during migration)
export STATE_FILE="${STATE_FILE:-$MANAGER_DIR/data/test_state.json}"
export USER_DATA_FILE="${USER_DATA_FILE:-$MANAGER_DIR/data/test_users.json}"
export ENABLE_STATE_PERSISTENCE=true

# Node environment
export NODE_ENV=development

# Default port (exported for potential use by server)
export PORT="${PORT:-3000}"

# Get PIDs listening on a port (portable: lsof or ss)
get_port_pids() {
    local port=$1
    if command -v lsof >/dev/null 2>&1; then
        lsof -ti:"$port" 2>/dev/null || true
    elif command -v ss >/dev/null 2>&1; then
        ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {gsub(/.*pid=/,"",$NF); gsub(/,.*/,"",$NF); print $NF}' | sort -u || true
    else
        echo ""
    fi
}

# Kill any process holding the port (graceful then force)
kill_port() {
    local port=$1
    local pids=$(get_port_pids "$port")
    if [ -n "$pids" ]; then
        echo "Stopping process(es) on port $port: $pids"
        echo "$pids" | xargs kill 2>/dev/null || true
        sleep 2
        # Force kill if still running
        local remaining=$(get_port_pids "$port")
        if [ -n "$remaining" ]; then
            echo "Force killing: $remaining"
            echo "$remaining" | xargs kill -9 2>/dev/null || true
            sleep 1
        fi
    fi
}

start_server() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "Server already running (PID: $PID)"
            echo "Use './scripts/dev.sh stop' to stop it first"
            exit 1
        fi
        rm -f "$PID_FILE"
    fi

    # Kill any stale process holding the port
    kill_port "$PORT"

    echo "Starting development server (transpile-only mode)..."
    echo "  TEST_USERNAME: $TEST_USERNAME"
    echo "  ADMIN_USER: $ADMIN_USER"
    echo "  DB_PATH: $DB_PATH"
    echo "  Log file: $LOG_FILE"
    echo ""

    cd "$MANAGER_DIR"
    npx ts-node --transpile-only server.ts > "$LOG_FILE" 2>&1 &
    PID=$!
    echo $PID > "$PID_FILE"

    # Wait a moment and check if it started
    sleep 1
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Server started (PID: $PID)"
        echo "  URL: http://localhost:$PORT"
        echo ""
        echo "Use './scripts/dev.sh logs' to view logs"
        echo "Use './scripts/dev.sh stop' to stop"
    else
        echo "Failed to start server. Check logs:"
        tail -20 "$LOG_FILE"
        rm -f "$PID_FILE"
        exit 1
    fi
}

stop_server() {
    if [ ! -f "$PID_FILE" ]; then
        echo "No PID file found. Server not running?"
        exit 0
    fi

    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Stopping server (PID: $PID)..."
        kill "$PID"

        # Wait for graceful shutdown
        for i in {1..5}; do
            if ! ps -p "$PID" > /dev/null 2>&1; then
                break
            fi
            sleep 1
        done

        # Force kill if still running
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "Force killing..."
            kill -9 "$PID" 2>/dev/null || true
        fi

        echo "Server stopped"
    else
        echo "Server not running (stale PID file)"
    fi

    rm -f "$PID_FILE"

    # Also kill any orphaned process holding the port
    kill_port "$PORT"
}

show_status() {
    if [ ! -f "$PID_FILE" ]; then
        echo "Server not running (no PID file)"
        exit 0
    fi

    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Server running (PID: $PID)"
        echo "  URL: http://localhost:$PORT"
        echo "  DB: $DB_PATH"
    else
        echo "Server not running (stale PID file)"
        rm -f "$PID_FILE"
    fi
}

show_logs() {
    if [ ! -f "$LOG_FILE" ]; then
        echo "No log file found"
        exit 1
    fi

    # Follow logs
    tail -f "$LOG_FILE"
}

case "${1:-start}" in
    start)
        start_server
        ;;
    stop)
        stop_server
        ;;
    restart)
        stop_server
        sleep 1
        start_server
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    *)
        echo "Usage: $0 [start|stop|restart|status|logs]"
        echo ""
        echo "Commands:"
        echo "  start   - Start the development server (default)"
        echo "  stop    - Stop the development server"
        echo "  restart - Restart the development server"
        echo "  status  - Check if server is running"
        echo "  logs    - Tail the server logs"
        echo ""
        echo "Environment variables (set in scripts/.env.dev):"
        echo "  TEST_USERNAME - Login username (default: testuser)"
        echo "  TEST_PASSWORD - Login password (default: testpass)"
        echo "  ADMIN_USER    - Admin username (default: testuser)"
        echo "  DB_PATH       - SQLite database path (default: data/test_app.db)"
        exit 1
        ;;
esac
