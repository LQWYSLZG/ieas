# =============================================================================
# IE Suite — Multi-stage Production Dockerfile
# =============================================================================
# Stage 1 (builder): Build the React frontend into a minified static bundle
# Stage 2 (production): Run the FastAPI backend serving the static bundle
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Build frontend
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /build

# Install dependencies first (layer caching)
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy frontend source and build
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: Production
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS production

# Set environment variables
ENV ENV=production \
    PORT=8080 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install system dependencies for Python packages (pandas, openpyxl)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend application code
COPY backend/app ./app

# Copy built frontend static bundle from builder stage
COPY --from=builder /build/dist ./static

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash appuser
USER appuser

# Expose configurable port
EXPOSE ${PORT}

# Health check using the /api/v1/health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${PORT}/api/v1/health || exit 1

# Start uvicorn with configurable port
CMD uvicorn app.main:app --host 0.0.0.0 --port $PORT
