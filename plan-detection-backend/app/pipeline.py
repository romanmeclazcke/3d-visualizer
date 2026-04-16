from __future__ import annotations

from .geometry import (
    classify_exterior_walls,
    detect_outline,
    detect_rooms,
    detect_walls,
    estimate_pixels_per_meter,
    preprocess,
    structural_coverage_ratio,
    wall_mask_ratio,
)
from .models import DebugInfo, ImageInfo, ParsedPlan, PlanIssue, ScaleInfo


def analyze_plan(image) -> ParsedPlan:
    pre = preprocess(image)
    walls, wall_thickness_px, wall_issues, wall_debug, graph = detect_walls(pre)
    outline_points, outline_confidence, outline_issues, outline_meta = detect_outline(
        graph,
        pre.gray.shape,
    )
    walls = classify_exterior_walls(walls, outline_points)
    pixels_per_meter = estimate_pixels_per_meter(outline_points)
    structural_quality_ok = (
        bool(outline_meta.get("outline_valid", False))
        and len(walls) >= 4
        and wall_debug.intersection_count >= 2
    )
    rooms, room_count_raw = detect_rooms(graph, pixels_per_meter, structural_quality_ok)

    issues = list(wall_issues)
    for issue in outline_issues:
        if issue.code not in {existing.code for existing in issues}:
            issues.append(issue)
    if pixels_per_meter is None:
        issues.append(
            PlanIssue(
                code="scale_estimation_failed",
                message="Automatic scale estimation failed. Manual calibration will be required.",
                severity="warning",
            )
        )
    if not rooms:
        issues.append(
            PlanIssue(
                code="room_detection_empty",
                message="No enclosed rooms were detected from the current wall mask.",
                severity="info",
            )
        )
    if room_count_raw and not structural_quality_ok:
        issues.append(
            PlanIssue(
                code="rooms_suppressed_by_low_structure_quality",
                message="Potential rooms were suppressed because the structural wall graph is not reliable enough.",
                severity="warning",
            )
        )
    if len(walls) < 4:
        issues.append(
            PlanIssue(
                code="too_few_walls",
                message="Detected wall count is too low for a reliable structural interpretation.",
                severity="warning",
            )
        )
    if wall_debug.pruned_segment_count > max(4, wall_debug.graph_edge_count):
        issues.append(
            PlanIssue(
                code="too_many_pruned_segments",
                message="A large number of weak wall segments had to be pruned from the graph.",
                severity="warning",
            )
        )
    if not outline_points:
        issues.append(
            PlanIssue(
                code="outline_unavailable",
                message="Exterior outline could not be inferred with enough confidence.",
                severity="error",
            )
        )

    confidence_parts = [
        outline_confidence,
        min(0.9, 0.2 + len(walls) * 0.035),
        0.7 if wall_debug.intersection_count >= 4 else 0.35,
        0.6 if wall_debug.graph_edge_count >= 6 else 0.35,
        0.55 if rooms else 0.3,
    ]
    penalty = 0.0
    penalty += 0.2 if not outline_meta.get("outline_valid", False) else 0.0
    penalty += 0.15 if len(walls) < 4 else 0.0
    penalty += 0.1 if wall_debug.intersection_count < 2 else 0.0
    penalty += 0.1 if wall_debug.graph_edge_count < 4 else 0.0
    penalty += 0.05 * sum(1 for issue in issues if issue.severity == "error")
    confidence = max(0.05, min(0.98, (sum(confidence_parts) / len(confidence_parts)) - penalty))

    return ParsedPlan(
        confidence=confidence,
        image=ImageInfo(width=int(pre.gray.shape[1]), height=int(pre.gray.shape[0])),
        outline={"points": outline_points, "confidence": outline_confidence},
        walls=walls,
        openings=[],
        rooms=rooms,
        issues=issues,
        scale=ScaleInfo(source="auto", pixels_per_meter=pixels_per_meter),
        wall_thickness_px=wall_thickness_px,
        debug=DebugInfo(
            line_count=wall_debug.graph_edge_count,
            room_count_raw=room_count_raw,
            wall_mask_ratio=wall_mask_ratio(pre.structural_mask),
            raw_vertical_segments=wall_debug.raw_vertical_segments,
            raw_horizontal_segments=wall_debug.raw_horizontal_segments,
            merged_segment_count=wall_debug.merged_segment_count,
            pruned_segment_count=wall_debug.pruned_segment_count,
            intersection_count=wall_debug.intersection_count,
            graph_node_count=wall_debug.graph_node_count,
            graph_edge_count=wall_debug.graph_edge_count,
            cycle_count=int(outline_meta.get("cycle_count", 0)),
            outline_source=str(outline_meta.get("outline_source", "none")),
            outline_area_ratio=float(outline_meta.get("outline_area_ratio", 0.0)) if outline_meta.get("outline_area_ratio") is not None else None,
            outline_valid=bool(outline_meta.get("outline_valid", False)),
            structural_coverage_ratio=structural_coverage_ratio(graph),
        ),
    )
