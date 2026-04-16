import type { ParsedPlan, PlanWall, Point } from "./plan-types";

export function getOutlineWalls(parsedPlan: ParsedPlan): PlanWall[] {
  return parsedPlan.outline.points.map((point, index) => ({
    id: getOutlineWallId(index),
    kind: "exterior",
    start: point,
    end: parsedPlan.outline.points[(index + 1) % parsedPlan.outline.points.length],
    confidence: parsedPlan.outline.confidence,
  }));
}

export function getCleanInteriorWalls(parsedPlan: ParsedPlan) {
  const outlineWalls = getOutlineWalls(parsedPlan);

  return parsedPlan.walls.filter((wall) => {
    return !outlineWalls.some((outlineWall) => isWallRedundantWithOutline(wall, outlineWall));
  });
}

export function getOutlineWallId(index: number) {
  return `outline-wall-${index}`;
}

function isWallRedundantWithOutline(wall: PlanWall, outlineWall: PlanWall) {
  const wallLength = distanceBetween(wall.start, wall.end);
  const outlineLength = distanceBetween(outlineWall.start, outlineWall.end);
  if (wallLength < 24 || outlineLength < 24) {
    return false;
  }

  const orientationAlignment = Math.abs(directionDot(wall, outlineWall));
  if (orientationAlignment < 0.985) {
    return false;
  }

  const wallMid = midpoint(wall.start, wall.end);
  const outlineMid = midpoint(outlineWall.start, outlineWall.end);
  const distanceToOutline = pointToSegmentDistance(wallMid, outlineWall.start, outlineWall.end);
  const overlapRatio = projectedOverlapRatio(wall, outlineWall);
  const midpointSeparation = distanceBetween(wallMid, outlineMid);

  return distanceToOutline < 22 && overlapRatio > 0.58 && midpointSeparation < Math.max(outlineLength * 0.65, 40);
}

function projectedOverlapRatio(a: PlanWall, b: PlanWall) {
  const axis = normalize({
    x: b.end.x - b.start.x,
    y: b.end.y - b.start.y,
  });

  const bStart = dot(b.start, axis);
  const bEnd = dot(b.end, axis);
  const aStart = dot(a.start, axis);
  const aEnd = dot(a.end, axis);

  const bMin = Math.min(bStart, bEnd);
  const bMax = Math.max(bStart, bEnd);
  const aMin = Math.min(aStart, aEnd);
  const aMax = Math.max(aStart, aEnd);
  const overlap = Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));

  return overlap / Math.max(Math.min(distanceBetween(a.start, a.end), distanceBetween(b.start, b.end)), 1);
}

function directionDot(a: PlanWall, b: PlanWall) {
  const aDir = normalize({
    x: a.end.x - a.start.x,
    y: a.end.y - a.start.y,
  });
  const bDir = normalize({
    x: b.end.x - b.start.x,
    y: b.end.y - b.start.y,
  });

  return aDir.x * bDir.x + aDir.y * bDir.y;
}

function pointToSegmentDistance(point: Point, start: Point, end: Point) {
  const segment = {
    x: end.x - start.x,
    y: end.y - start.y,
  };
  const lengthSquared = segment.x * segment.x + segment.y * segment.y;
  if (!lengthSquared) {
    return distanceBetween(point, start);
  }

  const projection = ((point.x - start.x) * segment.x + (point.y - start.y) * segment.y) / lengthSquared;
  const t = Math.min(1, Math.max(0, projection));
  const closest = {
    x: start.x + segment.x * t,
    y: start.y + segment.y * t,
  };

  return distanceBetween(point, closest);
}

function midpoint(start: Point, end: Point) {
  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  };
}

function normalize(vector: Point) {
  const length = Math.hypot(vector.x, vector.y) || 1;
  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

function dot(point: Point, axis: Point) {
  return point.x * axis.x + point.y * axis.y;
}

function distanceBetween(start: Point, end: Point) {
  return Math.hypot(end.x - start.x, end.y - start.y);
}
