export type Point = {
  x: number;
  y: number;
};

export type WallKind = "exterior" | "interior";
export type OpeningKind = "door" | "window";
export type ScaleSource = "auto" | "manual";

export type PlanWall = {
  id: string;
  kind: WallKind;
  start: Point;
  end: Point;
  confidence: number;
};

export type PlanOpening = {
  id: string;
  wallId: string;
  kind: OpeningKind;
  offsetRatio: number;
  widthMeters: number;
  heightMeters: number;
  sillHeightMeters: number;
  confidence: number;
};

export type PlanRoom = {
  id: string;
  name: string;
  polygon: Point[];
  areaSqMeters?: number;
};

export type ParsedPlan = {
  confidence: number;
  image: {
    width: number;
    height: number;
  };
  issues: string[];
  outline: {
    points: Point[];
    confidence: number;
  };
  openings: PlanOpening[];
  rooms: PlanRoom[];
  scale: {
    source: ScaleSource;
    pixelsPerMeter?: number;
  };
  wallThicknessPx?: number;
  walls: PlanWall[];
};
