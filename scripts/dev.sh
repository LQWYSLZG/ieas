#!/usr/bin/env bash
# ==============================================================================
# IE Suite - Development Server Startup Script (Linux/Mac)
# Starts both React dev server and FastAPI server concurrently.
# Usage: ./suite/scripts/dev.sh (from project root) or ./dev.sh (from scripts/)
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$SUITE_DIR/frontend"
BACKEND_DIR="$SUITE_DIR/backend"

FRONTEND_PID=""
BACKEND_PID=""
SHUTDOWN_IN_PROGRESS=false

# ------------------------------------------------------------------------------
# Cleanup: terminate both processes on exit
# ------------------------------------------------------------------------------
cleanup() {
  if [ "$SHUTDOWN_IN_PROGRESS" = true ]; then
    return
  fi
  SHUTDOWN_IN_PROGRESS=true

  echo ""
  echo "[dev] Shutting down dev servers..."

  if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
    echo "[dev] Frontend server terminated."
  fi

  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    echo "[dev] Backend server terminated."
  fi

  # Wait briefly for processes to exit
  sleep 1

  # Force kill if still running
  if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill -9 "$FRONTEND_PID" 2>/dev/null || true
  fi

  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill -9 "$BACKEND_PID" 2>/dev/null || true
  fi

  echo "[dev] All servers stopped."
}

# Trap signals for clean shutdown
trap cleanup SIGINT SIGTERM EXIT

# ------------------------------------------------------------------------------
# Validation
# ------------------------------------------------------------------------------
if [ ! -d "$FRONTEND_DIR" ]; then
  echo "[dev] ERROR: Frontend directory not found at $FRONTEND_DIR"
  exit 1
fi

if [ ! -d "$BACKEND_DIR" ]; then
  echo "[dev] ERROR: Backend directory not found at $BACKEND_DIR"
  exit 1
fi

if [ ! -f "$FRONTEND_DIR/package.json" ]; then
  echo "[dev] ERROR: package.json not found in $FRONTEND_DIR. Run 'npm install' first."
  exit 1
fi

if [ ! -f "$BACKEND_DIR/requirements.txt" ]; then
  echo "[dev] ERROR: requirements.txt not found in $BACKEND_DIR."
  exit 1
fi

# ------------------------------------------------------------------------------
# Start Backend (FastAPI with uvicorn --reload)
# ------------------------------------------------------------------------------
echo "[dev] Starting backend server (FastAPI)..."
cd "$BACKEND_DIR"
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!
echo "[dev] Backend server started (PID: $BACKEND_PID)"

# Brief pause to let backend initialize
sleep 2

# Check if backend started successfully
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "[dev] ERROR: Backend server failed to start."
  echo "[dev] Terminating frontend server if running..."
  if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
  exit 1
fi

# ------------------------------------------------------------------------------
# Start Frontend (Vite dev server)
# ------------------------------------------------------------------------------
echo "[dev] Starting frontend server (Vite)..."
cd "$FRONTEND_DIR"
npm run dev &
FRONTEND_PID=$!
echo "[dev] Frontend server started (PID: $FRONTEND_PID)"

# Brief pause to let frontend initialize
sleep 3

# Check if frontend started successfully
if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
  echo "[dev] ERROR: Frontend server failed to start."
  echo "[dev] Terminating backend server..."
  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    # Wait up to 5 seconds for backend to terminate
    for i in $(seq 1 5); do
      if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    # Force kill if still running
    if kill -0 "$BACKEND_PID" 2>/dev/null; then
      kill -9 "$BACKEND_PID" 2>/dev/null || true
    fi
  fi
  echo "[dev] Backend server terminated."
  exit 1
fi

# ------------------------------------------------------------------------------
# Monitor processes - if one dies, terminate the other
# ------------------------------------------------------------------------------
echo ""
echo "[dev] ========================================"
echo "[dev] Both servers running:"
echo "[dev]   Frontend: http://localhost:5173"
echo "[dev]   Backend:  http://localhost:8000"
echo "[dev] ========================================"
echo "[dev] Press Ctrl+C to stop both servers."
echo ""

while true; do
  # Check if backend is still running
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "[dev] ERROR: Backend server (PID: $BACKEND_PID) has stopped unexpectedly."
    echo "[dev] Terminating frontend server within 5 seconds..."
    if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
      kill "$FRONTEND_PID" 2>/dev/null || true
      for i in $(seq 1 5); do
        if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
          break
        fi
        sleep 1
      done
      if kill -0 "$FRONTEND_PID" 2>/dev/null; then
        kill -9 "$FRONTEND_PID" 2>/dev/null || true
      fi
    fi
    echo "[dev] Frontend server terminated."
    exit 1
  fi

  # Check if frontend is still running
  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    echo "[dev] ERROR: Frontend server (PID: $FRONTEND_PID) has stopped unexpectedly."
    echo "[dev] Terminating backend server within 5 seconds..."
    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
      kill "$BACKEND_PID" 2>/dev/null || true
      for i in $(seq 1 5); do
        if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
          break
        fi
        sleep 1
      done
      if kill -0 "$BACKEND_PID" 2>/dev/null; then
        kill -9 "$BACKEND_PID" 2>/dev/null || true
      fi
    fi
    echo "[dev] Backend server terminated."
    exit 1
  fi

  sleep 2
done
