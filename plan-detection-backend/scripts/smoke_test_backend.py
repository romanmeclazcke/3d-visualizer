from __future__ import annotations

import json
import sys


def main() -> int:
    try:
        import cv2  # noqa: F401
        import numpy as np
        from app.pipeline import analyze_plan
    except ModuleNotFoundError as exc:
        print(f"Missing runtime dependency for smoke test: {exc}", file=sys.stderr)
        return 2

    image = np.full((600, 380, 3), 255, dtype=np.uint8)
    cv2.rectangle(image, (40, 40), (340, 560), (0, 0, 0), 10)
    cv2.line(image, (190, 40), (190, 560), (0, 0, 0), 8)
    cv2.line(image, (40, 220), (190, 220), (0, 0, 0), 8)
    cv2.line(image, (190, 380), (340, 380), (0, 0, 0), 8)

    parsed = analyze_plan(image)
    payload = parsed.model_dump()

    assert "outline" in payload
    assert "walls" in payload
    assert "issues" in payload
    assert "debug" in payload
    assert isinstance(payload["outline"]["points"], list)
    assert isinstance(payload["walls"], list)
    assert isinstance(payload["issues"], list)
    assert isinstance(payload["debug"], dict)

    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
