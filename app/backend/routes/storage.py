import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.backend.models.schemas import ErrorResponse

router = APIRouter(prefix="/storage")


class SaveJsonRequest(BaseModel):
    filename: str
    data: dict


def resolve_output_file(outputs_dir: Path, filename: str) -> Path:
    """Accept a plain JSON filename only; never allow caller-controlled paths."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,122}\.json", filename):
        raise HTTPException(
            status_code=400,
            detail="filename must be a simple .json filename without path components",
        )

    root = outputs_dir.resolve()
    target = (root / filename).resolve()
    if target.parent != root:
        raise HTTPException(status_code=400, detail="Invalid output filename")
    return target


@router.post(
    path="/save-json",
    responses={
        200: {"description": "File saved successfully"},
        400: {"model": ErrorResponse, "description": "Invalid request parameters"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)
async def save_json_file(request: SaveJsonRequest):
    """Save JSON data to the project's /outputs directory."""
    project_root = Path(__file__).parent.parent.parent.parent
    outputs_dir = project_root / "outputs"

    try:
        file_path = resolve_output_file(outputs_dir, request.filename)
        outputs_dir.mkdir(parents=True, exist_ok=True)
        with file_path.open("w", encoding="utf-8") as output_file:
            json.dump(request.data, output_file, indent=2, ensure_ascii=False)

        return {
            "success": True,
            "message": "File saved successfully",
            "filename": request.filename,
        }
    except HTTPException:
        raise
    except OSError:
        raise HTTPException(status_code=500, detail="Failed to save JSON output")
