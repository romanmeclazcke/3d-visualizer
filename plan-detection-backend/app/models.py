from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Point(BaseModel):
    x: float
    y: float


class PlanWall(BaseModel):
    id: str
    kind: Literal["exterior", "interior"] = "interior"
    start: Point
    end: Point
    confidence: float = Field(ge=0.0, le=1.0)
    thickness_px: float | None = None


class PlanOpening(BaseModel):
    id: str
    wall_id: str
    kind: Literal["door", "window"]
    offset_ratio: float = Field(ge=0.0, le=1.0)
    width_meters: float = Field(gt=0)
    height_meters: float = Field(gt=0)
    sill_height_meters: float = Field(ge=0)
    confidence: float = Field(ge=0.0, le=1.0)


class PlanRoom(BaseModel):
    id: str
    name: str
    polygon: list[Point]
    area_sq_meters: float | None = None


class PlanIssue(BaseModel):
    code: str
    message: str
    severity: Literal["info", "warning", "error"] = "warning"


class ImageInfo(BaseModel):
    width: int
    height: int


class Outline(BaseModel):
    points: list[Point]
    confidence: float = Field(ge=0.0, le=1.0)


class ScaleInfo(BaseModel):
    source: Literal["auto", "manual"] = "auto"
    pixels_per_meter: float | None = None


class DebugInfo(BaseModel):
    line_count: int
    room_count_raw: int
    wall_mask_ratio: float
    raw_vertical_segments: int = 0
    raw_horizontal_segments: int = 0
    merged_segment_count: int = 0
    pruned_segment_count: int = 0
    intersection_count: int = 0
    graph_node_count: int = 0
    graph_edge_count: int = 0
    cycle_count: int = 0
    outline_source: str = "none"
    outline_area_ratio: float | None = None
    outline_valid: bool = False
    structural_coverage_ratio: float | None = None


class ParsedPlan(BaseModel):
    confidence: float = Field(ge=0.0, le=1.0)
    image: ImageInfo
    outline: Outline
    walls: list[PlanWall]
    openings: list[PlanOpening] = Field(default_factory=list)
    rooms: list[PlanRoom] = Field(default_factory=list)
    issues: list[PlanIssue] = Field(default_factory=list)
    scale: ScaleInfo = Field(default_factory=ScaleInfo)
    wall_thickness_px: float | None = None
    debug: DebugInfo


class AnalyzeResponse(BaseModel):
    parsed_plan: ParsedPlan
