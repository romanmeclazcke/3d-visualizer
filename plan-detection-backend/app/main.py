from __future__ import annotations

import os

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .image_loader import load_image_from_bytes
from .models import AnalyzeResponse
from .pipeline import analyze_plan

app = FastAPI(
    title="Plan Detection Backend",
    version="0.1.0",
    description="Geometry-first floor plan analysis backend without AI dependencies.",
)

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOW_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/analyze/file", response_model=AnalyzeResponse)
async def analyze_file(file: UploadFile = File(...)) -> AnalyzeResponse:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename.")

    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty file payload.")

    try:
        image = load_image_from_bytes(payload, file.filename)
        parsed_plan = analyze_plan(image)
        return AnalyzeResponse(parsed_plan=parsed_plan)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - API boundary fallback
        raise HTTPException(status_code=500, detail=f"Plan analysis failed: {exc}") from exc
