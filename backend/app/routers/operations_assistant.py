"""Operations Assistant router - file upload and processing endpoints."""

from fastapi import APIRouter, UploadFile, File, HTTPException

router = APIRouter(tags=["operations-assistant"])

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
ALLOWED_EXTENSIONS = (".xlsx", ".xls")


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Accept an Excel file upload, validate size and extension, process in-memory only."""
    contents = await file.read()

    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(status_code=422, detail="File exceeds 10 MB limit")

    if not file.filename or not file.filename.endswith(ALLOWED_EXTENSIONS):
        raise HTTPException(
            status_code=422, detail="Only .xlsx and .xls files are accepted"
        )

    return {"filename": file.filename, "size": len(contents)}
