"""CORS middleware configuration.

In development, the frontend dev server runs on a different origin than the API,
so CORS is enabled for that dev origin. In production, a single-service deploy
serves the frontend from the same origin as the API and needs no CORS. A split
deploy (frontend on a static host such as GitHub Pages, API on a separate host)
serves the frontend from a different origin, so the allowed origins are supplied
via the CORS_ALLOW_ORIGINS environment variable (comma separated).
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import ENV, FRONTEND_DEV_ORIGIN, CORS_ALLOW_ORIGINS


def _configured_origins() -> list[str]:
    """Return the browser origins that may call this API.

    Development always includes the local dev server origin. Production adds any
    origins listed in CORS_ALLOW_ORIGINS (comma separated, blanks ignored), which
    is how a split deploy authorizes its static frontend host.
    """
    origins: list[str] = []
    if ENV == "development":
        origins.append(FRONTEND_DEV_ORIGIN)
    for origin in CORS_ALLOW_ORIGINS.split(","):
        cleaned = origin.strip()
        if cleaned and cleaned not in origins:
            origins.append(cleaned)
    return origins


def add_cors(app: FastAPI) -> None:
    """Apply CORS middleware when any allowed browser origin is configured."""
    origins = _configured_origins()
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_methods=["*"],
            allow_headers=["*"],
        )
