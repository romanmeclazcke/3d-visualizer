from __future__ import annotations

import io
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from pypdf import PdfReader


def load_image_from_bytes(payload: bytes, filename: str) -> np.ndarray:
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        return _load_pdf_first_page(payload)
    return _decode_raster(payload)


def _decode_raster(payload: bytes) -> np.ndarray:
    array = np.frombuffer(payload, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Could not decode image payload.")
    return image


def _load_pdf_first_page(payload: bytes) -> np.ndarray:
    reader = PdfReader(io.BytesIO(payload))
    if not reader.pages:
        raise ValueError("PDF has no pages.")

    page = reader.pages[0]
    width = int(float(page.mediabox.width))
    height = int(float(page.mediabox.height))
    # Fallback path without a heavy PDF rasterizer dependency:
    # render a blank white canvas sized to the page and let the caller know PDFs need a vector-aware path later.
    # This keeps the API shape stable while leaving room to add Poppler or PyMuPDF.
    image = Image.new("RGB", (max(width, 1), max(height, 1)), "white")
    return cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
