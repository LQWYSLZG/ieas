"""
Application configuration module.

Loads environment variables with sensible defaults for the IE Suite API Server.
"""

import os

# Environment mode: "development" or "production"
ENV: str = os.environ.get("ENV", "production")

# Server port
PORT: int = int(os.environ.get("PORT", "8080"))

# Frontend dev server origin (used for CORS in development mode)
FRONTEND_DEV_ORIGIN: str = os.environ.get("FRONTEND_DEV_ORIGIN", "http://localhost:5173")

# Allowed browser origins for CORS in production (comma separated). In the split
# deploy the frontend is served from a different origin (for example GitHub
# Pages) than this API, so that origin must be allowed. Empty by default so a
# same-origin single-service deploy needs no CORS at all.
CORS_ALLOW_ORIGINS: str = os.environ.get("CORS_ALLOW_ORIGINS", "")

# API keys for backend services (add as needed)
OPENAI_API_KEY: str = os.environ.get("OPENAI_API_KEY", "")

# File upload constraints
MAX_UPLOAD_SIZE_BYTES: int = 10 * 1024 * 1024  # 10 MB
ALLOWED_EXTENSIONS: set[str] = {".xlsx", ".xls"}

# Static files directory (production build output)
STATIC_DIR: str = os.environ.get("STATIC_DIR", "static")
