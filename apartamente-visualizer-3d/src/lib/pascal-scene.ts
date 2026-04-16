import {
  BuildingNode,
  detectSpacesForLevel,
  DoorNode,
  generateId,
  LevelNode,
  SiteNode,
  SlabNode,
  useScene,
  WallNode,
  WindowNode,
  ZoneNode,
} from "@pascal-app/core";
import { getCleanInteriorWalls } from "./plan-geometry";
import type { ParsedPlan, PlanOpening, Point } from "./plan-types";

type MeterPoint = {
  x: number;
  z: number;
};

const OUTLINE_WALL_PREFIX = "outline-wall-";

export function buildPascalScene({
  imageHeight,
  parsedPlan,
  pixelsPerMeter,
  wallHeight,
  wallThickness,
}: {
  imageHeight: number;
  parsedPlan: ParsedPlan;
  pixelsPerMeter: number;
  wallHeight: number;
  wallThickness: number;
}) {
  const siteId = generateId("site");
  const buildingId = generateId("building");
  const levelId = generateId("level");
  const slabId = generateId("slab");

  const perimeterMeters = parsedPlan.outline.points.map((point) => projectPoint(point, pixelsPerMeter, imageHeight));
  const center = findCentroid(perimeterMeters);
  const normalizedPerimeter = perimeterMeters.map((point) => normalizePoint(point, center));

  const cleanedInteriorWalls = getCleanInteriorWalls(parsedPlan);
  const normalizedWalls = cleanedInteriorWalls.map((wall) => ({
    ...wall,
    start: normalizePoint(projectPoint(wall.start, pixelsPerMeter, imageHeight), center),
    end: normalizePoint(projectPoint(wall.end, pixelsPerMeter, imageHeight), center),
  }));

  const building = BuildingNode.parse({
    id: buildingId,
    name: "Edificio base",
    parentId: siteId,
    children: [levelId],
    position: [0, 0, 0],
  });

  const site = SiteNode.parse({
    id: siteId,
    name: "Proyecto detectado automáticamente",
    children: [building],
  });

  const perimeterWallIds = normalizedPerimeter.map(() => generateId("wall"));
  const interiorWallIds = normalizedWalls.map(() => generateId("wall"));

  const perimeterWalls = normalizedPerimeter.map((point, index) =>
    WallNode.parse({
      id: perimeterWallIds[index],
      parentId: levelId,
      name: `Muro exterior ${index + 1}`,
      start: [point.x, point.z],
      end: [
        normalizedPerimeter[(index + 1) % normalizedPerimeter.length].x,
        normalizedPerimeter[(index + 1) % normalizedPerimeter.length].z,
      ],
      thickness: wallThickness,
      height: wallHeight,
      material: {
        preset: "plaster",
      },
    }),
  );

  const interiorWalls = normalizedWalls.map((wall, index) =>
    WallNode.parse({
      id: interiorWallIds[index],
      parentId: levelId,
      name: `Muro interior ${index + 1}`,
      start: [wall.start.x, wall.start.z],
      end: [wall.end.x, wall.end.z],
      thickness: wallThickness * 0.72,
      height: wallHeight,
      material: {
        preset: "plaster",
      },
    }),
  );

  const wallLookup = new Map<string, { id: string; start: MeterPoint; end: MeterPoint; height: number }>();
  parsedPlan.outline.points.forEach((point, index) => {
    const start = normalizePoint(projectPoint(point, pixelsPerMeter, imageHeight), center);
    const end = normalizePoint(
      projectPoint(parsedPlan.outline.points[(index + 1) % parsedPlan.outline.points.length], pixelsPerMeter, imageHeight),
      center,
    );
    wallLookup.set(getOutlineWallId(index), { id: perimeterWallIds[index], start, end, height: wallHeight });
  });

  normalizedWalls.forEach((wall, index) => {
    wallLookup.set(interiorWallIds[index], {
      id: interiorWallIds[index],
      start: wall.start,
      end: wall.end,
      height: wallHeight,
    });
  });

  const openingsByWall = new Map<string, PlanOpening[]>();
  for (const opening of parsedPlan.openings) {
    const bucket = openingsByWall.get(opening.wallId) ?? [];
    bucket.push(opening);
    openingsByWall.set(opening.wallId, bucket);
  }

  const doorNodes: Array<ReturnType<typeof DoorNode.parse>> = [];
  const windowNodes: Array<ReturnType<typeof WindowNode.parse>> = [];

  [...perimeterWalls, ...interiorWalls].forEach((wall, wallIndex) => {
    const wallSourceId = wallIndex < perimeterWalls.length ? getOutlineWallId(wallIndex) : wall.id;
    const openings = openingsByWall.get(wallSourceId) ?? [];
    if (!openings.length) {
      return;
    }

    const childrenIds = openings.map((opening) =>
      opening.kind === "door" ? generateId("door") : generateId("window"),
    );

    wall.children = childrenIds as unknown as typeof wall.children;

    openings.forEach((opening, index) => {
      const childId = childrenIds[index];
      const child = buildWallOpeningNode({
        id: childId,
        opening,
        wall,
        wallGeometry: wallLookup.get(wallSourceId),
      });

      if (!child) {
        return;
      }

      if (child.type === "door") {
        doorNodes.push(child);
      } else {
        windowNodes.push(child);
      }
    });
  });

  const slab = SlabNode.parse({
    id: slabId,
    name: "Losa detectada",
    parentId: levelId,
    polygon: normalizedPerimeter.map((point) => [point.x, point.z]),
    material: {
      preset: "wood",
    },
  });

  const detectedSpaces = detectSpacesForLevel(levelId, [...perimeterWalls, ...interiorWalls], 0.35).spaces;
  const zones = detectedSpaces.map((space, index) =>
    ZoneNode.parse({
      id: generateId("zone"),
      parentId: levelId,
      name: `Ambiente ${index + 1}`,
      polygon: space.polygon,
      color: ROOM_COLORS[index % ROOM_COLORS.length],
      metadata: {
        isAutoDetected: true,
      },
    }),
  );

  const level = LevelNode.parse({
    id: levelId,
    name: "Nivel 1",
    parentId: buildingId,
    level: 0,
    children: [
      ...perimeterWallIds,
      ...interiorWallIds,
      slabId,
      ...zones.map((zone) => zone.id),
    ],
  });

  const nodes = [
    site,
    building,
    level,
    slab,
    ...zones,
    ...perimeterWalls,
    ...interiorWalls,
    ...doorNodes,
    ...windowNodes,
  ].reduce<Record<string, unknown>>((accumulator, node) => {
    accumulator[node.id] = node;
    return accumulator;
  }, {});

  return {
    buildingId,
    center: { x: 0, z: 0 },
    levelId,
    nodes: nodes as ReturnType<typeof useScene.getState>["nodes"],
    openingCount: parsedPlan.openings.length,
    radius: Math.max(getPolygonRadius(normalizedPerimeter), 3),
    roomCount: zones.length,
    rootNodeIds: [siteId],
  };
}

function getOutlineWallId(index: number) {
  return `${OUTLINE_WALL_PREFIX}${index}`;
}

const ROOM_COLORS = ["#D6F5E3", "#FFE3C2", "#DDEBFF", "#F9DCF6", "#FFF4B8"];

function buildWallOpeningNode({
  id,
  opening,
  wall,
  wallGeometry,
}: {
  id: string;
  opening: PlanOpening;
  wall: ReturnType<typeof WallNode.parse>;
  wallGeometry?: { id: string; start: MeterPoint; end: MeterPoint; height: number };
}) {
  if (!wallGeometry) {
    return null;
  }

  const length = distanceMeters(wallGeometry.start, wallGeometry.end);
  if (length <= 0.001) {
    return null;
  }

  const localX = clamp(opening.offsetRatio, 0.05, 0.95) * length;

  if (opening.kind === "door") {
    return DoorNode.parse({
      id,
      parentId: wall.id,
      wallId: wall.id,
      name: "Puerta",
      position: [localX, opening.heightMeters / 2, 0],
      width: opening.widthMeters,
      height: Math.min(opening.heightMeters, wallGeometry.height - 0.05),
      material: {
        preset: "wood",
      },
      segments: [
        {
          type: "panel",
          heightRatio: 0.66,
          columnRatios: [1],
        },
        {
          type: "glass",
          heightRatio: 0.34,
          columnRatios: [1],
        },
      ],
    });
  }

  return WindowNode.parse({
    id,
    parentId: wall.id,
    wallId: wall.id,
    name: "Ventana",
    position: [localX, opening.sillHeightMeters + opening.heightMeters / 2, 0],
    width: opening.widthMeters,
    height: Math.min(opening.heightMeters, wallGeometry.height - opening.sillHeightMeters - 0.05),
    material: {
      preset: "white",
    },
    sill: true,
    columnRatios: [1, 1],
    rowRatios: [1],
  });
}

function projectPoint(point: Point, pixelsPerMeter: number, imageHeight: number) {
  return {
    x: point.x / pixelsPerMeter,
    z: (imageHeight - point.y) / pixelsPerMeter,
  };
}

function normalizePoint(point: MeterPoint, center: MeterPoint) {
  return {
    x: point.x - center.x,
    z: point.z - center.z,
  };
}

function findCentroid(points: MeterPoint[]) {
  const sum = points.reduce(
    (accumulator, point) => ({
      x: accumulator.x + point.x,
      z: accumulator.z + point.z,
    }),
    { x: 0, z: 0 },
  );

  return {
    x: sum.x / points.length,
    z: sum.z / points.length,
  };
}

function getPolygonRadius(points: MeterPoint[]) {
  return points.reduce((maxRadius, point) => Math.max(maxRadius, Math.hypot(point.x, point.z)), 0);
}

function distanceMeters(start: MeterPoint, end: MeterPoint) {
  return Math.hypot(end.x - start.x, end.z - start.z);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
