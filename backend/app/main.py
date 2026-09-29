"""Main FastAPI application for the IE Suite API."""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.middleware import add_cors
from app.routers import health, inventory_assistant, operations_assistant, simulator

app = FastAPI(title="IE Suite API", version="1.0.0")

# Apply CORS middleware based on environment config
add_cors(app)

# Router registration
app.include_router(health.router, prefix="/api/v1")
app.include_router(
    inventory_assistant.router, prefix="/api/v1/inventory-assistant"
)
app.include_router(
    operations_assistant.router, prefix="/api/v1/operations-assistant"
)
app.include_router(
    simulator.router, prefix="/api/v1/operations-assistant/simulator"
)

# Static file serving (production) — only mount if directory exists
_static_dir = Path(__file__).resolve().parent.parent / "static"
if _static_dir.is_dir():
    app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")


# SPA fallback: unmatched non-API paths return index.html
@app.get("/{path:path}")
async def spa_fallback(request: Request, path: str):
    """Serve index.html for client-side routing support.

    This handler catches all GET requests that:
    - Are NOT under /api/ (those are handled by registered routers)
    - Are NOT static file requests (those are handled by the StaticFiles mount)

    For any remaining paths, it returns index.html to support client-side routing.
    """
    # Guard: never intercept API routes (this shouldn't happen due to router
    # registration order, but provides an explicit safety net)
    if path.startswith("api/"):
        return JSONResponse(
            status_code=404,
            content={"detail": "Not found"},
        )

    # If the static directory exists and the path maps to a real file in it,
    # serve that file directly (handles cases like /favicon.ico, /manifest.json)
    if _static_dir.is_dir():
        requested_file = _static_dir / path
        # Security: ensure the resolved path is still within _static_dir
        try:
            requested_file.resolve().relative_to(_static_dir.resolve())
            if requested_file.is_file():
                return FileResponse(str(requested_file))
        except ValueError:
            # Path traversal attempt — ignore and fall through to SPA fallback
            pass

    # SPA fallback: return index.html for client-side routing
    index_file = _static_dir / "index.html"
    if index_file.is_file():
        return FileResponse(str(index_file))

    return JSONResponse(
        status_code=404,
        content={"detail": "index.html not found — run the frontend build first"},
    )
