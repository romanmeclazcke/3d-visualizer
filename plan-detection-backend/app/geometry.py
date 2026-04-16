from __future__ import annotations

import math
import uuid
from dataclasses import dataclass

import cv2
import numpy as np

from .models import PlanIssue, PlanRoom, PlanWall, Point


Point2D = tuple[int, int]


@dataclass(frozen=True)
class RawLine:
    x1: int
    y1: int
    x2: int
    y2: int

    @property
    def is_vertical(self) -> bool:
        return self.x1 == self.x2

    @property
    def length(self) -> float:
        return math.hypot(self.x2 - self.x1, self.y2 - self.y1)

    @property
    def start(self) -> Point2D:
        return (self.x1, self.y1)

    @property
    def end(self) -> Point2D:
        return (self.x2, self.y2)


@dataclass
class PreprocessedData:
    gray: np.ndarray
    binary: np.ndarray
    structural_mask: np.ndarray
    horizontal_mask: np.ndarray
    vertical_mask: np.ndarray


@dataclass
class WallGraph:
    lines: list[RawLine]
    nodes: set[Point2D]
    adjacency: dict[Point2D, set[Point2D]]
    intersections: set[Point2D]
    wall_raster: np.ndarray


@dataclass
class WallDetectionDebug:
    raw_vertical_segments: int
    raw_horizontal_segments: int
    merged_segment_count: int
    pruned_segment_count: int
    intersection_count: int
    graph_node_count: int
    graph_edge_count: int


def preprocess(image: np.ndarray) -> PreprocessedData:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)

    adaptive = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        35,
        5,
    )
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    binary = cv2.bitwise_or(adaptive, otsu)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), iterations=1)
    binary = _drop_noise(binary, min_area=max(10, binary.size // 60000))

    horizontal_mask, vertical_mask = _extract_axis_masks(binary)
    structural_mask = cv2.bitwise_or(horizontal_mask, vertical_mask)
    structural_mask = cv2.morphologyEx(structural_mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=2)
    structural_mask = _drop_noise(structural_mask, min_area=max(20, binary.size // 18000))
    horizontal_mask = cv2.bitwise_and(horizontal_mask, structural_mask)
    vertical_mask = cv2.bitwise_and(vertical_mask, structural_mask)

    return PreprocessedData(
        gray=gray,
        binary=binary,
        structural_mask=structural_mask,
        horizontal_mask=horizontal_mask,
        vertical_mask=vertical_mask,
    )


def detect_walls(pre: PreprocessedData) -> tuple[list[PlanWall], float | None, list[PlanIssue], WallDetectionDebug, WallGraph]:
    raw_verticals = _extract_component_lines(pre.vertical_mask, vertical=True)
    raw_horizontals = _extract_component_lines(pre.horizontal_mask, vertical=False)
    lsd_verticals, lsd_horizontals = _extract_lsd_lines(pre.structural_mask)

    raw_verticals = _merge_lines(raw_verticals + lsd_verticals)
    raw_horizontals = _merge_lines(raw_horizontals + lsd_horizontals)

    merged_verticals = _merge_lines(raw_verticals)
    merged_horizontals = _merge_lines(raw_horizontals)

    intersections = _find_intersections(merged_verticals, merged_horizontals, pre.structural_mask)
    snapped_verticals = _snap_and_split(merged_verticals, intersections, vertical=True)
    snapped_horizontals = _snap_and_split(merged_horizontals, intersections, vertical=False)

    merged_lines = _merge_lines(snapped_verticals + snapped_horizontals)
    filtered_lines, pruned = _prune_lines(merged_lines, pre.structural_mask)
    filtered_lines = _merge_lines(filtered_lines)

    graph = _build_graph(filtered_lines, pre.structural_mask)
    thickness_px = _estimate_wall_thickness(pre.horizontal_mask, pre.vertical_mask) or 3.0

    issues: list[PlanIssue] = []
    if len(filtered_lines) < 4:
        issues.append(
            PlanIssue(
                code="wall_network_sparse",
                message="Too few orthogonal walls were reconstructed from the plan.",
                severity="warning",
            )
        )
    if len(graph.intersections) < 2:
        issues.append(
            PlanIssue(
                code="low_intersection_count",
                message="The detected wall network has too few valid intersections.",
                severity="warning",
            )
        )

    walls = [
        PlanWall(
            id=f"wall_{uuid.uuid4().hex[:8]}",
            kind="interior",
            start=Point(x=float(line.x1), y=float(line.y1)),
            end=Point(x=float(line.x2), y=float(line.y2)),
            confidence=_wall_confidence(line, pre.structural_mask, graph),
            thickness_px=thickness_px,
        )
        for line in filtered_lines
    ]

    debug = WallDetectionDebug(
        raw_vertical_segments=len(raw_verticals),
        raw_horizontal_segments=len(raw_horizontals),
        merged_segment_count=len(merged_lines),
        pruned_segment_count=pruned,
        intersection_count=len(graph.intersections),
        graph_node_count=len(graph.nodes),
        graph_edge_count=len(graph.lines),
    )
    return walls, thickness_px, issues, debug, graph


def detect_outline(graph: WallGraph, image_shape: tuple[int, int]) -> tuple[list[Point], float, list[PlanIssue], dict[str, float | bool | str | int]]:
    verticals = [line for line in graph.lines if line.is_vertical]
    horizontals = [line for line in graph.lines if not line.is_vertical]
    issues: list[PlanIssue] = []

    if len(verticals) < 2 or len(horizontals) < 2:
        issues.append(
            PlanIssue(
                code="outline_not_found",
                message="Not enough exterior wall candidates to derive the structural outline.",
                severity="error",
            )
        )
        return [], 0.0, issues, {
            "outline_area_ratio": 0.0,
            "outline_valid": False,
            "outline_source": "none",
            "cycle_count": 0,
        }

    edge_margin_x = max(12, int(image_shape[1] * 0.08))
    edge_margin_y = max(12, int(image_shape[0] * 0.08))

    left = _pick_outer_line(sorted(verticals, key=lambda line: line.x1), edge_margin=edge_margin_x, vertical=True)
    right = _pick_outer_line(sorted(verticals, key=lambda line: -line.x1), edge_margin=edge_margin_x, vertical=True)
    top = _pick_outer_line(sorted(horizontals, key=lambda line: line.y1), edge_margin=edge_margin_y, vertical=False)
    bottom = _pick_outer_line(sorted(horizontals, key=lambda line: -line.y1), edge_margin=edge_margin_y, vertical=False)

    if left is None or right is None or top is None or bottom is None:
        issues.append(
            PlanIssue(
                code="outline_not_found",
                message="Could not find four coherent outer wall candidates.",
                severity="error",
            )
        )
        return [], 0.0, issues, {
            "outline_area_ratio": 0.0,
            "outline_valid": False,
            "outline_source": "none",
            "cycle_count": 0,
        }

    x_left = left.x1
    x_right = right.x1
    y_top = top.y1
    y_bottom = bottom.y1

    width_span = x_right - x_left
    height_span = y_bottom - y_top
    height, width = image_shape
    area_ratio = (width_span * height_span) / max(1.0, float(width * height))
    touches_canvas = (
        x_left <= max(6, int(width * 0.02))
        and y_top <= max(6, int(height * 0.02))
        and x_right >= width - max(6, int(width * 0.02))
        and y_bottom >= height - max(6, int(height * 0.02))
    )

    overlaps_ok = (
        _interval_overlap((left.y1, left.y2), (top.y1, bottom.y1)) > 0.75
        and _interval_overlap((right.y1, right.y2), (top.y1, bottom.y1)) > 0.75
        and _interval_overlap((top.x1, top.x2), (left.x1, right.x1)) > 0.75
        and _interval_overlap((bottom.x1, bottom.x2), (left.x1, right.x1)) > 0.75
    )

    valid = width_span > 20 and height_span > 20 and overlaps_ok and not touches_canvas and area_ratio < 0.92
    if not valid:
        issues.append(
            PlanIssue(
                code="outline_invalid",
                message="The outermost wall envelope is not coherent enough to be used as a valid outline.",
                severity="error",
            )
        )
        return [], 0.0, issues, {
            "outline_area_ratio": area_ratio,
            "outline_valid": False,
            "outline_source": "outer_wall_envelope_invalid",
            "cycle_count": 0,
        }

    points = [
        Point(x=float(x_left), y=float(y_top)),
        Point(x=float(x_right), y=float(y_top)),
        Point(x=float(x_right), y=float(y_bottom)),
        Point(x=float(x_left), y=float(y_bottom)),
    ]
    confidence = max(0.25, min(0.94, 0.55 + min(0.25, area_ratio)))
    return points, confidence, issues, {
        "outline_area_ratio": area_ratio,
        "outline_valid": True,
        "outline_source": "outer_wall_envelope",
        "cycle_count": 1,
    }


def detect_rooms(graph: WallGraph, pixels_per_meter: float | None, structural_quality_ok: bool) -> tuple[list[PlanRoom], int]:
    if not structural_quality_ok:
        return [], 0

    sealed = cv2.morphologyEx(graph.wall_raster, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8), iterations=2)
    free_space = cv2.bitwise_not(sealed)
    padded = cv2.copyMakeBorder(free_space, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=255)
    flood_mask = np.zeros((padded.shape[0] + 2, padded.shape[1] + 2), np.uint8)
    cv2.floodFill(padded, flood_mask, (0, 0), 128)
    inside = np.where(padded[1:-1, 1:-1] == 255, 255, 0).astype(np.uint8)

    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(inside, connectivity=4)
    rooms: list[PlanRoom] = []
    raw_count = 0
    min_area = max(1200, inside.size // 700)

    for label in range(1, num_labels):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        raw_count += 1
        component_mask = np.where(labels == label, 255, 0).astype(np.uint8)
        contours, _ = cv2.findContours(component_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        x, y, w, h = cv2.boundingRect(contour)
        if x <= 1 or y <= 1 or x + w >= inside.shape[1] - 1 or y + h >= inside.shape[0] - 1:
            continue
        epsilon = max(2.0, 0.01 * cv2.arcLength(contour, True))
        approx = cv2.approxPolyDP(contour, epsilon, True)
        polygon = [Point(x=float(p[0][0]), y=float(p[0][1])) for p in approx]
        area_sq_meters = area / (pixels_per_meter * pixels_per_meter) if pixels_per_meter and pixels_per_meter > 0 else None
        rooms.append(
            PlanRoom(
                id=f"room_{uuid.uuid4().hex[:8]}",
                name=f"Room {len(rooms) + 1}",
                polygon=polygon,
                area_sq_meters=area_sq_meters,
            )
        )
    return rooms, raw_count


def estimate_pixels_per_meter(outline_points: list[Point]) -> float | None:
    if len(outline_points) < 2:
        return None
    xs = [point.x for point in outline_points]
    ys = [point.y for point in outline_points]
    width = max(xs) - min(xs)
    height = max(ys) - min(ys)
    if width <= 0 or height <= 0:
        return None
    aspect = height / width
    if aspect > 1.6:
        return (width / 6.5 + height / 16) / 2
    if aspect > 1.15:
        return (width / 8 + height / 12) / 2
    return (width / 10 + height / 10) / 2


def wall_mask_ratio(mask: np.ndarray) -> float:
    return float(np.count_nonzero(mask)) / float(mask.size)


def structural_coverage_ratio(graph: WallGraph) -> float:
    return wall_mask_ratio(graph.wall_raster)


def classify_exterior_walls(walls: list[PlanWall], outline_points: list[Point]) -> list[PlanWall]:
    if not outline_points:
        return walls
    xs = [point.x for point in outline_points]
    ys = [point.y for point in outline_points]
    tolerance = 10.0
    for wall in walls:
        if abs(wall.start.x - wall.end.x) < 1e-6:
            if abs(wall.start.x - min(xs)) <= tolerance or abs(wall.start.x - max(xs)) <= tolerance:
                wall.kind = "exterior"
        else:
            if abs(wall.start.y - min(ys)) <= tolerance or abs(wall.start.y - max(ys)) <= tolerance:
                wall.kind = "exterior"
    return walls


def estimate_wall_thickness(mask: np.ndarray, walls: list[PlanWall]) -> float | None:
    samples: list[float] = []
    for wall in walls[:20]:
        dx = wall.end.x - wall.start.x
        dy = wall.end.y - wall.start.y
        length = math.hypot(dx, dy)
        if length < 1:
            continue
        nx = -dy / length
        ny = dx / length
        cx = (wall.start.x + wall.end.x) / 2
        cy = (wall.start.y + wall.end.y) / 2
        thickness = 0
        for step in range(-20, 21):
            x = int(round(cx + nx * step))
            y = int(round(cy + ny * step))
            if x < 0 or y < 0 or x >= mask.shape[1] or y >= mask.shape[0]:
                continue
            if mask[y, x] > 0:
                thickness += 1
        if thickness > 0:
            samples.append(float(thickness))
    if not samples:
        return None
    return float(sum(samples) / len(samples))


def _extract_axis_masks(binary: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    height, width = binary.shape[:2]
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(12, width // 26), 1))
    vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(12, height // 26)))

    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, horizontal_kernel)
    horizontal = cv2.morphologyEx(horizontal, cv2.MORPH_CLOSE, np.ones((11, 3), np.uint8), iterations=1)

    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN, vertical_kernel)
    vertical = cv2.morphologyEx(vertical, cv2.MORPH_CLOSE, np.ones((3, 11), np.uint8), iterations=1)
    return horizontal, vertical


def _extract_component_lines(mask: np.ndarray, vertical: bool) -> list[RawLine]:
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    lines: list[RawLine] = []
    min_major = max(28, (mask.shape[0] if vertical else mask.shape[1]) // 14)

    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        major = h if vertical else w
        minor = w if vertical else h
        if major < min_major:
            continue
        if minor > max(24, major * 0.5):
            continue
        fill_ratio = cv2.contourArea(contour) / max(1, w * h)
        if fill_ratio < 0.18:
            continue
        if vertical:
            center_x = int(round(x + w / 2))
            lines.append(RawLine(x1=center_x, y1=y, x2=center_x, y2=y + h - 1))
        else:
            center_y = int(round(y + h / 2))
            lines.append(RawLine(x1=x, y1=center_y, x2=x + w - 1, y2=center_y))
    return lines


def _extract_lsd_lines(mask: np.ndarray) -> tuple[list[RawLine], list[RawLine]]:
    if not hasattr(cv2, "createLineSegmentDetector"):
        return [], []

    detector = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
    detected = detector.detect(mask)
    if not detected or detected[0] is None:
        return [], []

    verticals: list[RawLine] = []
    horizontals: list[RawLine] = []
    min_length = max(26, min(mask.shape[:2]) // 14)

    for entry in detected[0]:
        x1, y1, x2, y2 = [int(round(value)) for value in entry[0]]
        line = _snap_axis_line(x1, y1, x2, y2)
        if line is None or line.length < min_length:
            continue
        if not _line_supported_by_mask(line, mask):
            continue
        if line.is_vertical:
            verticals.append(line)
        else:
            horizontals.append(line)
    return verticals, horizontals


def _snap_axis_line(x1: int, y1: int, x2: int, y2: int) -> RawLine | None:
    dx = x2 - x1
    dy = y2 - y1
    angle = abs(math.degrees(math.atan2(dy, dx)))
    angle = angle if angle <= 90 else 180 - angle

    if angle <= 10:
        y = int(round((y1 + y2) / 2))
        return RawLine(x1=min(x1, x2), y1=y, x2=max(x1, x2), y2=y)
    if angle >= 80:
        x = int(round((x1 + x2) / 2))
        return RawLine(x1=x, y1=min(y1, y2), x2=x, y2=max(y1, y2))
    return None


def _find_intersections(verticals: list[RawLine], horizontals: list[RawLine], mask: np.ndarray) -> set[Point2D]:
    intersections: set[Point2D] = set()
    tolerance = 8
    for vertical in verticals:
        for horizontal in horizontals:
            if horizontal.x1 - tolerance <= vertical.x1 <= horizontal.x2 + tolerance and vertical.y1 - tolerance <= horizontal.y1 <= vertical.y2 + tolerance:
                point = (vertical.x1, horizontal.y1)
                if _intersection_supported(mask, point):
                    intersections.add(point)
    return intersections


def _snap_and_split(lines: list[RawLine], intersections: set[Point2D], vertical: bool) -> list[RawLine]:
    output: list[RawLine] = []
    tolerance = 8
    for line in lines:
        cuts = [line.y1, line.y2] if vertical else [line.x1, line.x2]
        axis_value = line.x1 if vertical else line.y1
        for x, y in intersections:
            if vertical and abs(axis_value - x) <= tolerance and line.y1 + tolerance < y < line.y2 - tolerance:
                cuts.append(y)
            if not vertical and abs(axis_value - y) <= tolerance and line.x1 + tolerance < x < line.x2 - tolerance:
                cuts.append(x)
        ordered = sorted(set(cuts))
        for start, end in zip(ordered, ordered[1:]):
            if end - start < 10:
                continue
            output.append(
                RawLine(x1=axis_value, y1=start, x2=axis_value, y2=end) if vertical else RawLine(x1=start, y1=axis_value, x2=end, y2=axis_value)
            )
    return output


def _prune_lines(lines: list[RawLine], mask: np.ndarray) -> tuple[list[RawLine], int]:
    kept: list[RawLine] = []
    pruned = 0
    min_keep = max(34, min(mask.shape[:2]) // 16)
    for line in lines:
        if line.length < min_keep:
            pruned += 1
            continue
        if not _line_supported_by_mask(line, mask):
            pruned += 1
            continue
        kept.append(line)
    return kept, pruned


def _build_graph(lines: list[RawLine], mask: np.ndarray) -> WallGraph:
    adjacency: dict[Point2D, set[Point2D]] = {}
    nodes: set[Point2D] = set()
    intersections: set[Point2D] = set()
    filtered = [line for line in lines if _line_supported_by_mask(line, mask)]

    for line in filtered:
        start = line.start
        end = line.end
        nodes.add(start)
        nodes.add(end)
        adjacency.setdefault(start, set()).add(end)
        adjacency.setdefault(end, set()).add(start)

    for node, neighbors in adjacency.items():
        if len(neighbors) >= 2:
            intersections.add(node)

    wall_raster = _rasterize_lines(filtered, mask.shape, thickness=3)
    return WallGraph(
        lines=filtered,
        nodes=nodes,
        adjacency=adjacency,
        intersections=intersections,
        wall_raster=wall_raster,
    )


def _merge_lines(lines: list[RawLine]) -> list[RawLine]:
    verticals = [line for line in lines if line.is_vertical]
    horizontals = [line for line in lines if not line.is_vertical]
    return _merge_axis_lines(verticals, vertical=True) + _merge_axis_lines(horizontals, vertical=False)


def _merge_axis_lines(lines: list[RawLine], vertical: bool) -> list[RawLine]:
    if not lines:
        return []
    coordinate = (lambda line: line.x1) if vertical else (lambda line: line.y1)
    start = (lambda line: line.y1) if vertical else (lambda line: line.x1)
    end = (lambda line: line.y2) if vertical else (lambda line: line.x2)

    buckets: list[list[RawLine]] = []
    for line in sorted(lines, key=lambda item: (coordinate(item), start(item))):
        attached = False
        for bucket in buckets:
            bucket_coordinate = int(round(sum(coordinate(item) for item in bucket) / len(bucket)))
            if abs(coordinate(line) - bucket_coordinate) > 8:
                continue
            bucket_start = min(start(item) for item in bucket)
            bucket_end = max(end(item) for item in bucket)
            if start(line) > bucket_end + 12 or end(line) < bucket_start - 12:
                continue
            bucket.append(line)
            attached = True
            break
        if not attached:
            buckets.append([line])

    merged: list[RawLine] = []
    for bucket in buckets:
        if vertical:
            x = int(round(sum(line.x1 for line in bucket) / len(bucket)))
            merged.append(RawLine(x1=x, y1=min(line.y1 for line in bucket), x2=x, y2=max(line.y2 for line in bucket)))
        else:
            y = int(round(sum(line.y1 for line in bucket) / len(bucket)))
            merged.append(RawLine(x1=min(line.x1 for line in bucket), y1=y, x2=max(line.x2 for line in bucket), y2=y))
    return _dedupe_lines(merged)


def _dedupe_lines(lines: list[RawLine]) -> list[RawLine]:
    deduped: list[RawLine] = []
    for line in sorted(lines, key=lambda item: item.length, reverse=True):
        if any(_line_equivalent(line, existing) for existing in deduped):
            continue
        deduped.append(line)
    return deduped


def _line_equivalent(a: RawLine, b: RawLine) -> bool:
    if a.is_vertical != b.is_vertical:
        return False
    if a.is_vertical:
        return abs(a.x1 - b.x1) <= 6 and _interval_overlap((a.y1, a.y2), (b.y1, b.y2)) > 0.8
    return abs(a.y1 - b.y1) <= 6 and _interval_overlap((a.x1, a.x2), (b.x1, b.x2)) > 0.8


def _pick_outer_line(lines: list[RawLine], edge_margin: int, vertical: bool) -> RawLine | None:
    if not lines:
        return None
    reference = lines[0].x1 if vertical else lines[0].y1
    best: RawLine | None = None
    best_score = -1e9
    for line in lines[:10]:
        coordinate = line.x1 if vertical else line.y1
        distance = abs(coordinate - reference)
        score = line.length - distance * 2.0
        if distance > edge_margin:
            score -= edge_margin
        if score > best_score:
            best = line
            best_score = score
    return best


def _line_supported_by_mask(line: RawLine, mask: np.ndarray) -> bool:
    samples = max(8, int(line.length // 8))
    hits = 0
    for index in range(samples + 1):
        t = index / max(1, samples)
        x = int(round(line.x1 + (line.x2 - line.x1) * t))
        y = int(round(line.y1 + (line.y2 - line.y1) * t))
        if _sample_band(mask, x, y, line.is_vertical):
            hits += 1
    return hits / max(1, samples + 1) >= 0.65


def _sample_band(mask: np.ndarray, x: int, y: int, vertical: bool) -> bool:
    if x < 0 or y < 0 or x >= mask.shape[1] or y >= mask.shape[0]:
        return False
    if vertical:
        band = mask[y, max(0, x - 2) : min(mask.shape[1], x + 3)]
    else:
        band = mask[max(0, y - 2) : min(mask.shape[0], y + 3), x]
    return np.count_nonzero(band) >= 2


def _intersection_supported(mask: np.ndarray, point: Point2D) -> bool:
    x, y = point
    x0 = max(0, x - 4)
    x1 = min(mask.shape[1], x + 5)
    y0 = max(0, y - 4)
    y1 = min(mask.shape[0], y + 5)
    return np.count_nonzero(mask[y0:y1, x0:x1]) >= 8


def _rasterize_lines(lines: list[RawLine], image_shape: tuple[int, int], thickness: int) -> np.ndarray:
    canvas = np.zeros(image_shape, dtype=np.uint8)
    for line in lines:
        cv2.line(canvas, (line.x1, line.y1), (line.x2, line.y2), 255, thickness=max(1, thickness))
    return cv2.morphologyEx(canvas, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=1)


def _estimate_wall_thickness(horizontal_mask: np.ndarray, vertical_mask: np.ndarray) -> float | None:
    widths: list[int] = []
    widths.extend(end - start + 1 for start, end in _extract_runs(np.count_nonzero(vertical_mask, axis=0) > 0))
    widths.extend(end - start + 1 for start, end in _extract_runs(np.count_nonzero(horizontal_mask, axis=1) > 0))
    widths = [width for width in widths if 1 <= width <= 40]
    if not widths:
        return None
    return float(np.median(widths))


def _wall_confidence(line: RawLine, mask: np.ndarray, graph: WallGraph) -> float:
    degree_start = len(graph.adjacency.get(line.start, set()))
    degree_end = len(graph.adjacency.get(line.end, set()))
    support = 0.3 if _line_supported_by_mask(line, mask) else 0.0
    topology = min(0.25, 0.08 * (degree_start + degree_end))
    length_score = min(0.25, line.length / max(mask.shape[:2]))
    return max(0.1, min(0.98, 0.2 + support + topology + length_score))


def _drop_noise(mask: np.ndarray, min_area: int) -> np.ndarray:
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    filtered = np.zeros_like(mask)
    for label in range(1, num_labels):
        area = int(stats[label, cv2.CC_STAT_AREA])
        width = int(stats[label, cv2.CC_STAT_WIDTH])
        height = int(stats[label, cv2.CC_STAT_HEIGHT])
        elongated = max(width, height) / max(1, min(width, height)) >= 2.0
        if area < min_area and not elongated:
            continue
        if max(width, height) < 4:
            continue
        filtered[labels == label] = 255
    return filtered


def _extract_runs(values: np.ndarray) -> list[tuple[int, int]]:
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, value in enumerate(values):
        if value and start is None:
            start = index
        elif not value and start is not None:
            runs.append((start, index - 1))
            start = None
    if start is not None:
        runs.append((start, len(values) - 1))
    return runs


def _interval_overlap(a: tuple[int, int], b: tuple[int, int]) -> float:
    a0, a1 = sorted(a)
    b0, b1 = sorted(b)
    overlap = max(0, min(a1, b1) - max(a0, b0))
    base = max(1, min(a1 - a0, b1 - b0))
    return overlap / base
