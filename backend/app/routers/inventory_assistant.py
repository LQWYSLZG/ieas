"""Inventory Assistant router — file upload and processing endpoints."""

from fastapi import APIRouter, File, HTTPException, UploadFile

router = APIRouter(tags=["inventory-assistant"])

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Accept an Excel file upload, validate size and extension, and return file info.

    The file is processed entirely in-memory — no data is persisted beyond the
    request-response lifecycle.
    """
    contents = await file.read()

    # Validate file size
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=422, detail="File exceeds 10 MB limit"
        )

    # Validate file extension
    filename = file.filename or ""
    if not filename.lower().endswith((".xlsx", ".xls")):
        raise HTTPException(
            status_code=422,
            detail="Only .xlsx and .xls files are accepted",
        )

    # Process in-memory only — no persistence beyond this request
    return {"filename": file.filename, "size": len(contents)}
