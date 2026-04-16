import type { ParsedPlan } from "./plan-types";

const DEFAULT_BACKEND_URL = "http://localhost:8000";

type AnalyzeResponse = {
  parsed_plan: {
    confidence: number;
    image: {
      width: number;
      height: number;
    };
    outline: {
      points: Array<{ x: number; y: number }>;
      confidence: number;
    };
    walls: Array<{
      id: string;
      kind: "exterior" | "interior";
      start: { x: number; y: number };
      end: { x: number; y: number };
      confidence: number;
      thickness_px?: number | null;
    }>;
    openings: Array<{
      id: string;
      wall_id: string;
      kind: "door" | "window";
      offset_ratio: number;
      width_meters: number;
      height_meters: number;
      sill_height_meters: number;
      confidence: number;
    }>;
    rooms: Array<{
      id: string;
      name: string;
      polygon: Array<{ x: number; y: number }>;
      area_sq_meters?: number | null;
    }>;
    issues: Array<{
      code: string;
      message: string;
      severity: "info" | "warning" | "error";
    }>;
    scale: {
      source: "auto" | "manual";
      pixels_per_meter?: number | null;
    };
    wall_thickness_px?: number | null;
  };
};

export async function analyzePlanWithBackend(file: File): Promise<ParsedPlan> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${getBackendUrl()}/analyze/file`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const message = await safeReadError(response);
    throw new Error(message);
  }

  const payload = (await response.json()) as AnalyzeResponse;
  return mapParsedPlan(payload.parsed_plan);
}

export function getBackendUrl() {
  return (import.meta.env.VITE_PLAN_BACKEND_URL as string | undefined)?.trim() || DEFAULT_BACKEND_URL;
}

async function safeReadError(response: Response) {
  try {
    const payload = await response.json();
    if (typeof payload?.detail === "string") {
      return payload.detail;
    }
  } catch {
    // Ignore JSON parsing errors and fall through to generic message.
  }

  return `Backend request failed with status ${response.status}.`;
}

function mapParsedPlan(plan: AnalyzeResponse["parsed_plan"]): ParsedPlan {
  return {
    confidence: plan.confidence,
    image: plan.image,
    issues: plan.issues.map((issue) => issue.message),
    openings: plan.openings.map((opening) => ({
      id: opening.id,
      wallId: opening.wall_id,
      kind: opening.kind,
      offsetRatio: opening.offset_ratio,
      widthMeters: opening.width_meters,
      heightMeters: opening.height_meters,
      sillHeightMeters: opening.sill_height_meters,
      confidence: opening.confidence,
    })),
    outline: {
      points: plan.outline.points,
      confidence: plan.outline.confidence,
    },
    rooms: plan.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      polygon: room.polygon,
      areaSqMeters: room.area_sq_meters ?? undefined,
    })),
    scale: {
      source: plan.scale.source,
      pixelsPerMeter: plan.scale.pixels_per_meter ?? undefined,
    },
    wallThicknessPx: plan.wall_thickness_px ?? undefined,
    walls: plan.walls.map((wall) => ({
      id: wall.id,
      kind: wall.kind,
      start: wall.start,
      end: wall.end,
      confidence: wall.confidence,
    })),
  };
}
