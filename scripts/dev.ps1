# ==============================================================================
# IE Suite - Development Server Startup Script (Windows PowerShell)
# Starts both React dev server and FastAPI server concurrently.
# Usage: .\suite\scripts\dev.ps1 (from project root) or .\dev.ps1 (from scripts\)
# ==============================================================================

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SuiteDir = Split-Path -Parent $ScriptDir
$FrontendDir = Join-Path $SuiteDir "frontend"
$BackendDir = Join-Path $SuiteDir "backend"

$FrontendProcess = $null
$BackendProcess = $null

# ------------------------------------------------------------------------------
# Cleanup function: terminate both processes
# ------------------------------------------------------------------------------
function Stop-DevServers {
    Write-Host ""
    Write-Host "[dev] Shutting down dev servers..."

    if ($null -ne $BackendProcess -and -not $BackendProcess.HasExited) {
        try {
            Stop-Process -Id $BackendProcess.Id -Force -ErrorAction SilentlyContinue
            Write-Host "[dev] Backend server terminated."
        } catch {
            # Process already exited
        }
    }

    if ($null -ne $FrontendProcess -and -not $FrontendProcess.HasExited) {
        try {
            Stop-Process -Id $FrontendProcess.Id -Force -ErrorAction SilentlyContinue
            Write-Host "[dev] Frontend server terminated."
        } catch {
            # Process already exited
        }
    }

    # Also terminate any child processes (node, uvicorn spawn children)
    if ($null -ne $BackendProcess) {
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$($BackendProcess.Id)" -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }

    if ($null -ne $FrontendProcess) {
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$($FrontendProcess.Id)" -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }

    Write-Host "[dev] All servers stopped."
}

# Register cleanup on Ctrl+C
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Stop-DevServers }

try {
    # --------------------------------------------------------------------------
    # Validation
    # --------------------------------------------------------------------------
    if (-not (Test-Path $FrontendDir)) {
        Write-Host "[dev] ERROR: Frontend directory not found at $FrontendDir"
        exit 1
    }

    if (-not (Test-Path $BackendDir)) {
        Write-Host "[dev] ERROR: Backend directory not found at $BackendDir"
        exit 1
    }

    if (-not (Test-Path (Join-Path $FrontendDir "package.json"))) {
        Write-Host "[dev] ERROR: package.json not found in $FrontendDir. Run 'npm install' first."
        exit 1
    }

    if (-not (Test-Path (Join-Path $BackendDir "requirements.txt"))) {
        Write-Host "[dev] ERROR: requirements.txt not found in $BackendDir."
        exit 1
    }

    # --------------------------------------------------------------------------
    # Start Backend (FastAPI with uvicorn --reload)
    # --------------------------------------------------------------------------
    Write-Host "[dev] Starting backend server (FastAPI)..."
    $BackendProcess = Start-Process -FilePath "uvicorn" `
        -ArgumentList "app.main:app --reload --host 0.0.0.0 --port 8000" `
        -WorkingDirectory $BackendDir `
        -PassThru `
        -NoNewWindow

    Write-Host "[dev] Backend server started (PID: $($BackendProcess.Id))"

    # Brief pause to let backend initialize
    Start-Sleep -Seconds 2

    # Check if backend started successfully
    if ($BackendProcess.HasExited) {
        Write-Host "[dev] ERROR: Backend server failed to start."
        exit 1
    }

    # --------------------------------------------------------------------------
    # Start Frontend (Vite dev server)
    # --------------------------------------------------------------------------
    Write-Host "[dev] Starting frontend server (Vite)..."
    $FrontendProcess = Start-Process -FilePath "npm" `
        -ArgumentList "run dev" `
        -WorkingDirectory $FrontendDir `
        -PassThru `
        -NoNewWindow

    Write-Host "[dev] Frontend server started (PID: $($FrontendProcess.Id))"

    # Brief pause to let frontend initialize
    Start-Sleep -Seconds 3

    # Check if frontend started successfully
    if ($FrontendProcess.HasExited) {
        Write-Host "[dev] ERROR: Frontend server failed to start."
        Write-Host "[dev] Terminating backend server..."

        $timeout = 5
        $elapsed = 0
        Stop-Process -Id $BackendProcess.Id -Force -ErrorAction SilentlyContinue

        while (-not $BackendProcess.HasExited -and $elapsed -lt $timeout) {
            Start-Sleep -Seconds 1
            $elapsed++
        }

        if (-not $BackendProcess.HasExited) {
            Stop-Process -Id $BackendProcess.Id -Force -ErrorAction SilentlyContinue
        }

        Write-Host "[dev] Backend server terminated."
        exit 1
    }

    # --------------------------------------------------------------------------
    # Both servers running
    # --------------------------------------------------------------------------
    Write-Host ""
    Write-Host "[dev] ========================================"
    Write-Host "[dev] Both servers running:"
    Write-Host "[dev]   Frontend: http://localhost:5173"
    Write-Host "[dev]   Backend:  http://localhost:8000"
    Write-Host "[dev] ========================================"
    Write-Host "[dev] Press Ctrl+C to stop both servers."
    Write-Host ""

    # --------------------------------------------------------------------------
    # Monitor processes - if one dies, terminate the other within 5 seconds
    # --------------------------------------------------------------------------
    while ($true) {
        # Check if backend is still running
        if ($BackendProcess.HasExited) {
            Write-Host "[dev] ERROR: Backend server (PID: $($BackendProcess.Id)) has stopped unexpectedly."
            Write-Host "[dev] Terminating frontend server within 5 seconds..."

            if (-not $FrontendProcess.HasExited) {
                Stop-Process -Id $FrontendProcess.Id -Force -ErrorAction SilentlyContinue
                $timeout = 5
                $elapsed = 0
                while (-not $FrontendProcess.HasExited -and $elapsed -lt $timeout) {
                    Start-Sleep -Seconds 1
                    $elapsed++
                }
                if (-not $FrontendProcess.HasExited) {
                    Stop-Process -Id $FrontendProcess.Id -Force -ErrorAction SilentlyContinue
                }
            }

            Write-Host "[dev] Frontend server terminated."
            exit 1
        }

        # Check if frontend is still running
        if ($FrontendProcess.HasExited) {
            Write-Host "[dev] ERROR: Frontend server (PID: $($FrontendProcess.Id)) has stopped unexpectedly."
            Write-Host "[dev] Terminating backend server within 5 seconds..."

            if (-not $BackendProcess.HasExited) {
                Stop-Process -Id $BackendProcess.Id -Force -ErrorAction SilentlyContinue
                $timeout = 5
                $elapsed = 0
                while (-not $BackendProcess.HasExited -and $elapsed -lt $timeout) {
                    Start-Sleep -Seconds 1
                    $elapsed++
                }
                if (-not $BackendProcess.HasExited) {
                    Stop-Process -Id $BackendProcess.Id -Force -ErrorAction SilentlyContinue
                }
            }

            Write-Host "[dev] Backend server terminated."
            exit 1
        }

        Start-Sleep -Seconds 2
    }
}
finally {
    Stop-DevServers
}
