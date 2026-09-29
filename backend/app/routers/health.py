"""Health check router."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health_check():
    """Return service health status."""
    return {"status": "ok"}
