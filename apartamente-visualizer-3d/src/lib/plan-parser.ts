import { generateId } from "@pascal-app/core";
import type { ParsedPlan, PlanWall, Point } from "./plan-types";

type InkBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type CandidateSegment = {
  start: Point;
  end: Point;
  strength: number;
};

type AxisRun = {
  start: number;
  end: number;
  fixed: number;
  support: number;
};

type AxisBand = {
  start: number;
  end: number;
  fixedStart: number;
  fixedEnd: number;
  supportSum: number;
  samples: number;
};

type OccupancyGrid = {
  cellSize: number;
  cols: number;
  rows: number;
  occupied: Uint8Array;
  originX: number;
  originY: number;
};

type GridEdge = {
  start: string;
  end: string;
};

const DEFAULT_OUTLINE = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

export async function autoDetectPlanGeometry(src: string): Promise<ParsedPlan> {
  const image = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("No se pudo inicializar el canvas de análisis.");
  }

  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const inkMask = createInkMask(imageData.data, canvas.width, canvas.height);
  const bounds = findInkBounds(inkMask, canvas.width, canvas.height);
  if (!bounds) {
    throw new Error("No se detectaron líneas suficientemente contrastadas.");
  }

  const occupancy = buildOccupancyGrid(inkMask, canvas.width, canvas.height, bounds);
  const outline = buildOutlineFromOccupancy(occupancy) ?? buildRectangleOutline(bounds);
  const verticals = detectVerticalWalls(inkMask, canvas.width, canvas.height, bounds);
  const horizontals = detectHorizontalWalls(inkMask, canvas.width, canvas.height, bounds);
  const snapped = snapOrthogonalIntersections(verticals, horizontals);
  const walls = dedupeWalls([...snapped.verticals, ...snapped.horizontals]).map<PlanWall>((segment) => ({
    id: generateId("wall"),
    kind: "interior",
    start: segment.start,
    end: segment.end,
    confidence: segment.strength,
  }));

  const wallThicknessPx = estimateWallThicknessPx(inkMask, canvas.width, canvas.height, walls);
  const outlineConfidence = outline.length > 4 ? 0.82 : 0.58;

  return {
    confidence: clamp(average([outlineConfidence, Math.min(0.95, 0.35 + walls.length * 0.02)]), 0.2, 0.98),
    image: {
      width: canvas.width,
      height: canvas.height,
    },
    issues: walls.length === 0 ? ["No se detectaron muros interiores. Puedes agregarlos manualmente."] : [],
    openings: [],
    outline: {
      points: outline,
      confidence: outlineConfidence,
    },
    rooms: [],
    scale: {
      source: "auto",
    },
    wallThicknessPx,
    walls,
  };
}

export function estimatePixelsPerMeter(parsedPlan: ParsedPlan) {
  const outline = parsedPlan.outline.points.length >= 4 ? parsedPlan.outline.points : DEFAULT_OUTLINE;
  const bounds = getPointBounds(outline);
  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const aspect = height / width;

  if (aspect > 1.6) {
    return average([width / 6.5, height / 16]);
  }

  if (aspect > 1.15) {
    return average([width / 8, height / 12]);
  }

  return average([width / 10, height / 10]);
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function createInkMask(data: Uint8ClampedArray, width: number, height: number) {
  const mask = new Uint8Array(width * height);

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const a = data[offset + 3];
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);

    mask[index] = a > 0 && (luminance < 212 || (luminance < 228 && chroma < 32)) ? 1 : 0;
  }

  return mask;
}

function findInkBounds(mask: Uint8Array, width: number, height: number): InkBounds | null {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let seen = false;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }

      seen = true;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (!seen) {
    return null;
  }

  return {
    minX: Math.max(0, minX - 8),
    minY: Math.max(0, minY - 8),
    maxX: Math.min(width - 1, maxX + 8),
    maxY: Math.min(height - 1, maxY + 8),
  };
}

function buildRectangleOutline(bounds: InkBounds): Point[] {
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];
}

function buildOccupancyGrid(mask: Uint8Array, width: number, height: number, bounds: InkBounds): OccupancyGrid {
  const spanX = bounds.maxX - bounds.minX + 1;
  const spanY = bounds.maxY - bounds.minY + 1;
  const cellSize = clamp(Math.round(Math.min(spanX, spanY) / 42), 6, 18);
  const cols = Math.max(1, Math.ceil(spanX / cellSize));
  const rows = Math.max(1, Math.ceil(spanY / cellSize));
  const occupied = new Uint8Array(cols * rows);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const startX = bounds.minX + col * cellSize;
      const startY = bounds.minY + row * cellSize;
      const endX = Math.min(bounds.maxX + 1, startX + cellSize);
      const endY = Math.min(bounds.maxY + 1, startY + cellSize);
      let inkCount = 0;
      const total = Math.max((endX - startX) * (endY - startY), 1);

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          inkCount += mask[y * width + x];
        }
      }

      occupied[row * cols + col] = inkCount / total > 0.08 ? 1 : 0;
    }
  }

  keepLargestComponent(occupied, cols, rows);

  return {
    cellSize,
    cols,
    rows,
    occupied,
    originX: bounds.minX,
    originY: bounds.minY,
  };
}

function keepLargestComponent(occupied: Uint8Array, cols: number, rows: number) {
  const seen = new Uint8Array(occupied.length);
  let bestComponent: number[] = [];

  for (let index = 0; index < occupied.length; index += 1) {
    if (!occupied[index] || seen[index]) {
      continue;
    }

    const queue = [index];
    const component: number[] = [];
    seen[index] = 1;

    while (queue.length) {
      const current = queue.shift()!;
      component.push(current);

      const row = Math.floor(current / cols);
      const col = current % cols;
      const neighbors = [
        [col - 1, row],
        [col + 1, row],
        [col, row - 1],
        [col, row + 1],
      ];

      for (const [nextCol, nextRow] of neighbors) {
        if (nextCol < 0 || nextCol >= cols || nextRow < 0 || nextRow >= rows) {
          continue;
        }

        const nextIndex = nextRow * cols + nextCol;
        if (!occupied[nextIndex] || seen[nextIndex]) {
          continue;
        }

        seen[nextIndex] = 1;
        queue.push(nextIndex);
      }
    }

    if (component.length > bestComponent.length) {
      bestComponent = component;
    }
  }

  if (!bestComponent.length) {
    return;
  }

  occupied.fill(0);
  for (const index of bestComponent) {
    occupied[index] = 1;
  }
}

function buildOutlineFromOccupancy(grid: OccupancyGrid): Point[] | null {
  const edges: GridEdge[] = [];

  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      if (!grid.occupied[row * grid.cols + col]) {
        continue;
      }

      if (!getOccupiedCell(grid, col, row - 1)) {
        edges.push({
          start: keyPoint(col, row),
          end: keyPoint(col + 1, row),
        });
      }
      if (!getOccupiedCell(grid, col + 1, row)) {
        edges.push({
          start: keyPoint(col + 1, row),
          end: keyPoint(col + 1, row + 1),
        });
      }
      if (!getOccupiedCell(grid, col, row + 1)) {
        edges.push({
          start: keyPoint(col + 1, row + 1),
          end: keyPoint(col, row + 1),
        });
      }
      if (!getOccupiedCell(grid, col - 1, row)) {
        edges.push({
          start: keyPoint(col, row + 1),
          end: keyPoint(col, row),
        });
      }
    }
  }

  if (!edges.length) {
    return null;
  }

  const nextByStart = new Map<string, string[]>();
  for (const edge of edges) {
    const bucket = nextByStart.get(edge.start) ?? [];
    bucket.push(edge.end);
    nextByStart.set(edge.start, bucket);
  }

  const loops: string[][] = [];
  const visitedEdges = new Set<string>();

  for (const edge of edges) {
    const edgeKey = `${edge.start}->${edge.end}`;
    if (visitedEdges.has(edgeKey)) {
      continue;
    }

    const loop = [edge.start];
    let currentStart = edge.start;
    let currentEnd = edge.end;

    while (true) {
      visitedEdges.add(`${currentStart}->${currentEnd}`);
      loop.push(currentEnd);

      if (currentEnd === loop[0]) {
        break;
      }

      const nextCandidates = nextByStart.get(currentEnd) ?? [];
      const nextPoint = nextCandidates.find((candidate) => !visitedEdges.has(`${currentEnd}->${candidate}`));
      if (!nextPoint) {
        break;
      }

      currentStart = currentEnd;
      currentEnd = nextPoint;
    }

    if (loop.length > 4 && loop.at(-1) === loop[0]) {
      loops.push(loop);
    }
  }

  if (!loops.length) {
    return null;
  }

  const bestLoop = loops
    .map((loop) => simplifyPolyline(loop.slice(0, -1).map((point) => pointFromKey(point, grid))))
    .sort((left, right) => polygonArea(right) - polygonArea(left))[0];

  return bestLoop.length >= 4 ? bestLoop : null;
}

function simplifyPolyline(points: Point[]) {
  if (points.length <= 4) {
    return points;
  }

  const simplified: Point[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];

    const horizontalRun = previous.y === current.y && current.y === next.y;
    const verticalRun = previous.x === current.x && current.x === next.x;
    if (horizontalRun || verticalRun) {
      continue;
    }

    simplified.push(current);
  }

  return simplified;
}

function getOccupiedCell(grid: OccupancyGrid, col: number, row: number) {
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) {
    return 0;
  }

  return grid.occupied[row * grid.cols + col];
}

function keyPoint(col: number, row: number) {
  return `${col},${row}`;
}

function pointFromKey(key: string, grid: OccupancyGrid): Point {
  const [col, row] = key.split(",").map(Number);
  return {
    x: grid.originX + col * grid.cellSize,
    y: grid.originY + row * grid.cellSize,
  };
}

function polygonArea(points: Point[]) {
  let area = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }

  return Math.abs(area) / 2;
}

function detectVerticalWalls(mask: Uint8Array, width: number, height: number, bounds: InkBounds) {
  return buildBandsIntoSegments(
    collectAxisRuns(mask, width, height, bounds, "vertical"),
    bounds,
    "vertical",
  );
}

function detectHorizontalWalls(mask: Uint8Array, width: number, height: number, bounds: InkBounds) {
  return buildBandsIntoSegments(
    collectAxisRuns(mask, width, height, bounds, "horizontal"),
    bounds,
    "horizontal",
  );
}

function collectAxisRuns(
  mask: Uint8Array,
  width: number,
  height: number,
  bounds: InkBounds,
  axis: "vertical" | "horizontal",
) {
  const runs: AxisRun[] = [];
  const minRunLength = axis === "vertical" ? (bounds.maxY - bounds.minY) * 0.1 : (bounds.maxX - bounds.minX) * 0.12;

  if (axis === "vertical") {
    for (let x = bounds.minX + 6; x <= bounds.maxX - 6; x += 1) {
      let currentStart = -1;
      let supportSum = 0;
      let supportSamples = 0;

      for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
        const support = getVerticalSupport(mask, width, height, x, y);
        const active = support >= 0.58;

        if (active && currentStart === -1) {
          currentStart = y;
        }
        if (active) {
          supportSum += support;
          supportSamples += 1;
        }

        if ((!active || y === bounds.maxY) && currentStart !== -1) {
          const end = active && y === bounds.maxY ? y : y - 1;
          if (end - currentStart >= minRunLength) {
            runs.push({
              start: currentStart,
              end,
              fixed: x,
              support: supportSum / Math.max(supportSamples, 1),
            });
          }
          currentStart = -1;
          supportSum = 0;
          supportSamples = 0;
        }
      }
    }

    return mergeAxisRuns(runs, "vertical");
  }

  for (let y = bounds.minY + 6; y <= bounds.maxY - 6; y += 1) {
    let currentStart = -1;
    let supportSum = 0;
    let supportSamples = 0;

    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const support = getHorizontalSupport(mask, width, height, x, y);
      const active = support >= 0.58;

      if (active && currentStart === -1) {
        currentStart = x;
      }
      if (active) {
        supportSum += support;
        supportSamples += 1;
      }

      if ((!active || x === bounds.maxX) && currentStart !== -1) {
        const end = active && x === bounds.maxX ? x : x - 1;
        if (end - currentStart >= minRunLength) {
          runs.push({
            start: currentStart,
            end,
            fixed: y,
            support: supportSum / Math.max(supportSamples, 1),
          });
        }
        currentStart = -1;
        supportSum = 0;
        supportSamples = 0;
      }
    }
  }

  return mergeAxisRuns(runs, "horizontal");
}

function mergeAxisRuns(runs: AxisRun[], axis: "vertical" | "horizontal") {
  if (!runs.length) {
    return [];
  }

  const sorted = [...runs].sort((left, right) => left.fixed - right.fixed);
  const bands: AxisBand[] = [];

  for (const run of sorted) {
    const band = bands.find((candidate) => {
      const close = Math.abs(candidate.fixedEnd - run.fixed) <= 8;
      if (!close) {
        return false;
      }

      const overlap = Math.min(candidate.end, run.end) - Math.max(candidate.start, run.start);
      const minLength = Math.min(candidate.end - candidate.start, run.end - run.start);
      return overlap >= minLength * 0.55;
    });

    if (!band) {
      bands.push({
        start: run.start,
        end: run.end,
        fixedStart: run.fixed,
        fixedEnd: run.fixed,
        supportSum: run.support,
        samples: 1,
      });
      continue;
    }

    band.start = Math.min(band.start, run.start);
    band.end = Math.max(band.end, run.end);
    band.fixedEnd = Math.max(band.fixedEnd, run.fixed);
    band.supportSum += run.support;
    band.samples += 1;
  }

  return bands
    .map<CandidateSegment>((band) => {
      const strength = band.supportSum / Math.max(band.samples, 1);
      if (axis === "vertical") {
        const x = (band.fixedStart + band.fixedEnd) / 2;
        return {
          start: { x, y: band.start },
          end: { x, y: band.end },
          strength,
        };
      }

      const y = (band.fixedStart + band.fixedEnd) / 2;
      return {
        start: { x: band.start, y },
        end: { x: band.end, y },
        strength,
      };
    })
    .filter((segment) => distanceBetween(segment.start, segment.end) > 32);
}

function buildBandsIntoSegments(segments: CandidateSegment[], bounds: InkBounds, axis: "vertical" | "horizontal") {
  const nearBorderMargin = 18;
  return segments.filter((segment) => {
    if (axis === "vertical") {
      return segment.start.x >= bounds.minX + nearBorderMargin && segment.start.x <= bounds.maxX - nearBorderMargin;
    }

    return segment.start.y >= bounds.minY + nearBorderMargin && segment.start.y <= bounds.maxY - nearBorderMargin;
  });
}

function getVerticalSupport(mask: Uint8Array, width: number, height: number, x: number, y: number) {
  let hits = 0;
  let total = 0;

  for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
    const sampleX = x + offsetX;
    if (sampleX < 0 || sampleX >= width) {
      continue;
    }

    total += 1;
    if (mask[y * width + sampleX]) {
      hits += 1;
    }
  }

  const thickness = countContiguousInk(mask, width, height, x, y, "horizontal", 16);
  if (thickness > 28) {
    return 0;
  }

  return total ? hits / total : 0;
}

function getHorizontalSupport(mask: Uint8Array, width: number, height: number, x: number, y: number) {
  let hits = 0;
  let total = 0;

  for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
    const sampleY = y + offsetY;
    if (sampleY < 0 || sampleY >= height) {
      continue;
    }

    total += 1;
    if (mask[sampleY * width + x]) {
      hits += 1;
    }
  }

  const thickness = countContiguousInk(mask, width, height, x, y, "vertical", 16);
  if (thickness > 28) {
    return 0;
  }

  return total ? hits / total : 0;
}

function countContiguousInk(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  axis: "vertical" | "horizontal",
  radius: number,
) {
  let count = mask[y * width + x] ? 1 : 0;

  for (const direction of [-1, 1] as const) {
    for (let step = 1; step <= radius; step += 1) {
      const sampleX = axis === "horizontal" ? x + step * direction : x;
      const sampleY = axis === "vertical" ? y + step * direction : y;
      if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) {
        break;
      }
      if (!mask[sampleY * width + sampleX]) {
        break;
      }
      count += 1;
    }
  }

  return count;
}

function snapOrthogonalIntersections(verticals: CandidateSegment[], horizontals: CandidateSegment[]) {
  const snappedVerticals = verticals.map((segment) => ({
    start: { ...segment.start },
    end: { ...segment.end },
    strength: segment.strength,
  }));
  const snappedHorizontals = horizontals.map((segment) => ({
    start: { ...segment.start },
    end: { ...segment.end },
    strength: segment.strength,
  }));

  for (const vertical of snappedVerticals) {
    for (const horizontal of snappedHorizontals) {
      const intersectsX = vertical.start.x >= horizontal.start.x - 18 && vertical.start.x <= horizontal.end.x + 18;
      const intersectsY = horizontal.start.y >= vertical.start.y - 18 && horizontal.start.y <= vertical.end.y + 18;

      if (!intersectsX || !intersectsY) {
        continue;
      }

      const intersection = {
        x: vertical.start.x,
        y: horizontal.start.y,
      };

      if (Math.abs(intersection.x - horizontal.start.x) <= 18) {
        horizontal.start.x = intersection.x;
      }
      if (Math.abs(intersection.x - horizontal.end.x) <= 18) {
        horizontal.end.x = intersection.x;
      }
      if (Math.abs(intersection.y - vertical.start.y) <= 18) {
        vertical.start.y = intersection.y;
      }
      if (Math.abs(intersection.y - vertical.end.y) <= 18) {
        vertical.end.y = intersection.y;
      }
    }
  }

  return {
    verticals: snappedVerticals.filter((segment) => distanceBetween(segment.start, segment.end) > 32),
    horizontals: snappedHorizontals.filter((segment) => distanceBetween(segment.start, segment.end) > 32),
  };
}

function dedupeWalls(segments: CandidateSegment[]) {
  return segments.filter((segment, index) => {
    return !segments.some((other, otherIndex) => {
      if (otherIndex === index) {
        return false;
      }

      const sameOrientation =
        Math.abs(segment.start.x - segment.end.x) < 2 === Math.abs(other.start.x - other.end.x) < 2;
      if (!sameOrientation) {
        return false;
      }

      return (
        distanceBetween(segment.start, other.start) < 16 &&
        distanceBetween(segment.end, other.end) < 16 &&
        other.strength >= segment.strength
      );
    });
  });
}

function estimateWallThicknessPx(mask: Uint8Array, width: number, height: number, walls: PlanWall[]) {
  const samples = walls
    .slice(0, 20)
    .map((wall) => estimateSegmentThickness(mask, width, height, wall))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);

  if (!samples.length) {
    return undefined;
  }

  return average(samples);
}

function estimateSegmentThickness(mask: Uint8Array, width: number, height: number, wall: PlanWall) {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) {
    return undefined;
  }

  const normalX = -dy / length;
  const normalY = dx / length;
  const centerX = (wall.start.x + wall.end.x) / 2;
  const centerY = (wall.start.y + wall.end.y) / 2;
  let thickness = 0;

  for (let step = -24; step <= 24; step += 1) {
    const sampleX = Math.round(centerX + normalX * step);
    const sampleY = Math.round(centerY + normalY * step);
    if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) {
      continue;
    }

    if (mask[sampleY * width + sampleX]) {
      thickness += 1;
    }
  }

  return thickness || undefined;
}

function getPointBounds(points: Point[]) {
  return points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function distanceBetween(start: Point, end: Point) {
  return Math.hypot(end.x - start.x, end.y - start.y);
}
