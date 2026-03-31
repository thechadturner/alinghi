#!/bin/bash
# Startup script for Node.js servers
# Runs all 4 servers in background and aggregates their logs

# Don't use set -e here - we want to handle errors gracefully for each server
# set -e

# Function to get timestamp
get_timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}

echo "============================================"
echo "  Starting All Node.js Servers"
echo "  $(get_timestamp)"
echo "============================================"
echo

# Function to ensure dependencies are installed
ensure_dependencies() {
    SERVER_DIR=$1
    SERVER_NAME=$2
    
    # Check if node_modules exists and has content
    if [ ! -d "$SERVER_DIR/node_modules" ] || [ -z "$(ls -A "$SERVER_DIR/node_modules" 2>/dev/null)" ]; then
        if [ -f "$SERVER_DIR/package.json" ]; then
            echo "[INFO] Installing dependencies for $SERVER_NAME..."
            if cd "$SERVER_DIR" 2>/dev/null; then
                # Run npm install (with timeout if available, otherwise run normally)
                if command -v timeout >/dev/null 2>&1; then
                    timeout 300 npm install --only=production > "/tmp/${SERVER_NAME}_install.log" 2>&1
                    INSTALL_EXIT=$?
                    if [ $INSTALL_EXIT -eq 124 ]; then
                        echo "[ERROR] Dependency installation for $SERVER_NAME timed out after 5 minutes"
                        echo "[ERROR] Check /tmp/${SERVER_NAME}_install.log for details"
                        return 1
                    fi
                else
                    npm install --only=production > "/tmp/${SERVER_NAME}_install.log" 2>&1
                    INSTALL_EXIT=$?
                fi
                
                if [ $INSTALL_EXIT -eq 0 ]; then
                    echo "[SUCCESS] Dependencies installed for $SERVER_NAME"
                else
                    echo "[WARNING] Failed to install dependencies for $SERVER_NAME (exit code: $INSTALL_EXIT)"
                    echo "[WARNING] Check /tmp/${SERVER_NAME}_install.log for details"
                    # Don't return error - dependencies might have been partially installed
                    # or might exist from Docker build
                fi
            else
                echo "[ERROR] Cannot access directory: $SERVER_DIR"
                return 1
            fi
        else
            echo "[WARNING] package.json not found for $SERVER_NAME at $SERVER_DIR/package.json"
        fi
    else
        echo "[INFO] Dependencies already installed for $SERVER_NAME"
    fi
    return 0
}

# Function to start a server
start_server() {
    SERVER_DIR=$1
    SERVER_NAME=$2
    PORT=$3
    
    echo "[INFO] [$(get_timestamp)] Starting $SERVER_NAME..."
    
    # Ensure dependencies are installed before starting (don't exit on error)
    if ! ensure_dependencies "$SERVER_DIR" "$SERVER_NAME"; then
        echo "[ERROR] Failed to ensure dependencies for $SERVER_NAME, attempting to start anyway..."
    fi
    
    # Change to server directory
    if ! cd "$SERVER_DIR" 2>/dev/null; then
        echo "[ERROR] Cannot access server directory: $SERVER_DIR"
        return 1
    fi
    
    # Verify server.js exists
    if [ ! -f "server.js" ]; then
        echo "[ERROR] server.js not found in $SERVER_DIR"
        return 1
    fi
    
    # Start server in background and capture PID
    node server.js > "/tmp/${SERVER_NAME}.log" 2>&1 &
    SERVER_PID=$!
    
    # Verify the process started
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "[ERROR] Failed to start $SERVER_NAME (process died immediately)"
        echo "[ERROR] Check /tmp/${SERVER_NAME}.log for details"
        return 1
    fi
    
    echo "[INFO] [$(get_timestamp)] $SERVER_NAME started (PID: $SERVER_PID) on port $PORT"
    echo "$SERVER_PID" > "/tmp/${SERVER_NAME}.pid"
    return 0
}

# Start log aggregation: tail all server log files and output to stdout with prefixes
# This ensures all logs appear in Docker Desktop
tail_logs() {
    # Create log files if they don't exist (so tail -F can follow them)
    for server in server_app server_admin server_file server_media server_stream; do
        touch "/tmp/${server}.log" 2>/dev/null || true
    done
    
    # Use a simple approach: tail each log file with a prefix
    # We'll use a background process for each server's log
    # Use tail -F (follow with retry) to handle files that don't exist yet
    for server in server_app server_admin server_file server_media server_stream; do
        # Tail each log file with prefix in background using sed for reliable prefixing
        # tail -F will follow the file even if it doesn't exist yet (waits for creation)
        tail -F "/tmp/${server}.log" 2>/dev/null | sed "s/^/[$server] /" &
        echo "$!" > "/tmp/${server}_tail.pid"
    done
}

# Start all servers (continue even if one fails)
FAILED_SERVERS=0
start_server "/app/server_app" "server_app" "${APP_PORT:-8069}" || FAILED_SERVERS=$((FAILED_SERVERS + 1))
start_server "/app/server_admin" "server_admin" "${ADMIN_PORT:-8059}" || FAILED_SERVERS=$((FAILED_SERVERS + 1))
start_server "/app/server_file" "server_file" "${FILE_PORT:-8079}" || FAILED_SERVERS=$((FAILED_SERVERS + 1))
start_server "/app/server_media" "server_media" "${MEDIA_PORT:-8089}" || FAILED_SERVERS=$((FAILED_SERVERS + 1))
start_server "/app/server_stream" "server_stream" "${STREAM_PORT:-8099}" || FAILED_SERVERS=$((FAILED_SERVERS + 1))

if [ $FAILED_SERVERS -gt 0 ]; then
    echo "[WARNING] $FAILED_SERVERS server(s) failed to start"
fi

echo
echo "[INFO] [$(get_timestamp)] All servers started!"
echo "[INFO] [$(get_timestamp)] Starting log aggregation..."
echo

# Start tailing logs immediately so all server output appears in Docker logs
tail_logs

echo "[INFO] [$(get_timestamp)] Waiting for servers to be ready..."
echo

# Function to check if a server is ready
# Use 127.0.0.1 (not localhost): in many Linux containers /etc/hosts lists ::1 first,
# so "localhost" hits IPv6 while Node may listen on IPv4-only (0.0.0.0) — health would
# fail even when the server is up.
check_health() {
    PORT=$1
    NAME=$2
    MAX_ATTEMPTS=25
    ATTEMPT=0
    
    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
        ATTEMPT=$((ATTEMPT + 1))
        # Pass PORT as argv; drain response body so the socket closes cleanly
        if node -e "
const http = require('http');
const port = parseInt(process.argv[1], 10);
const req = http.get(
  { hostname: '127.0.0.1', port, path: '/api/health', family: 4, timeout: 5000 },
  (r) => {
    r.resume();
    r.on('end', () => process.exit(r.statusCode === 200 ? 0 : 1));
  }
);
req.on('error', () => process.exit(1));
req.on('timeout', () => { try { req.destroy(); } catch (e) {} process.exit(1); });
" "$PORT" 2>/dev/null; then
            echo "[SUCCESS] [$(get_timestamp)] $NAME is ready!"
            return 0
        fi
        if [ $ATTEMPT -lt $MAX_ATTEMPTS ]; then
            sleep 2
        fi
    done
    echo "[WARNING] $NAME may not be ready after $MAX_ATTEMPTS attempts (check logs if issues persist)"
    return 1
}

# Check health of all servers (give them more time to start)
sleep 5
check_health "${APP_PORT:-8069}" "server_app" || true
check_health "${ADMIN_PORT:-8059}" "server_admin" || true
check_health "${FILE_PORT:-8079}" "server_file" || true
check_health "${MEDIA_PORT:-8089}" "server_media" || true
check_health "${STREAM_PORT:-8099}" "server_stream" || true

echo
echo "============================================"
echo "  All servers are running!"
echo "  $(get_timestamp)"
echo "============================================"
echo

# Function to cleanup on exit
cleanup() {
    echo
    echo "[INFO] [$(get_timestamp)] Shutting down all servers..."
    
    # Stop log tailing processes
    for server in server_app server_admin server_file server_media server_stream; do
        if [ -f "/tmp/${server}_tail.pid" ]; then
            TAIL_PID=$(cat "/tmp/${server}_tail.pid" 2>/dev/null || echo "")
            if [ -n "$TAIL_PID" ] && kill -0 "$TAIL_PID" 2>/dev/null; then
                kill "$TAIL_PID" 2>/dev/null || true
            fi
            rm -f "/tmp/${server}_tail.pid"
        fi
    done
    
    # Stop all servers
    for server in server_app server_admin server_file server_media server_stream; do
        if [ -f "/tmp/${server}.pid" ]; then
            PID=$(cat "/tmp/${server}.pid" 2>/dev/null || echo "")
            if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
                echo "[INFO] [$(get_timestamp)] Stopping $server (PID: $PID)..."
                kill "$PID" 2>/dev/null || true
                # Wait a bit for graceful shutdown
                sleep 1
                # Force kill if still running
                kill -9 "$PID" 2>/dev/null || true
            fi
            rm -f "/tmp/${server}.pid"
        fi
    done
    echo "[INFO] [$(get_timestamp)] All servers stopped"
    exit 0
}

# Trap signals for graceful shutdown (use numeric signals for better compatibility)
trap 'cleanup' 15 2

# Wait for any process to exit
while true; do
    sleep 5
    for server in server_app server_admin server_file server_media server_stream; do
        if [ -f "/tmp/${server}.pid" ]; then
            PID=$(cat "/tmp/${server}.pid" 2>/dev/null || echo "")
            if [ -n "$PID" ] && ! kill -0 "$PID" 2>/dev/null; then
                echo "[ERROR] [$(get_timestamp)] $server (PID: $PID) has exited!"
                # Dump last 80 lines of the crashed server's log to help diagnose OOM or other crashes
                LOG_FILE="/tmp/${server}.log"
                if [ -f "$LOG_FILE" ] && [ -r "$LOG_FILE" ]; then
                    echo "[ERROR] [$(get_timestamp)] Last 80 lines of $server log:"
                    echo "----------------------------------------"
                    tail -n 80 "$LOG_FILE" 2>/dev/null | while IFS= read -r line; do echo "[$server] $line"; done
                    echo "----------------------------------------"
                fi
                cleanup
                exit 1
            fi
        fi
    done
done

