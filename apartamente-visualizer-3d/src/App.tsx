import { generateId, useScene } from "@pascal-app/core";
import { OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { useViewer, Viewer } from "@pascal-app/viewer";
import { analyzePlanWithBackend, getBackendUrl } from "./lib/backend-client";
import { getCleanInteriorWalls, getOutlineWallId, getOutlineWalls } from "./lib/plan-geometry";
import { autoDetectPlanGeometry, estimatePixelsPerMeter } from "./lib/plan-parser";
import { buildPascalScene } from "./lib/pascal-scene";
import type { OpeningKind, ParsedPlan, PlanOpening, PlanWall, Point } from "./lib/plan-types";

type UploadedPlan = {
  src: string;
  width: number;
  height: number;
  name: string;
};

type UiMode = "detection" | "calibration" | "edit";
type CreationTool = "none" | "wall" | "door" | "window";

type SceneViewState = {
  center: { x: number; z: number };
  radius: number;
  revision: number;
  roomCount: number;
  openingCount: number;
};

type SelectedEntity =
  | { type: "wall"; id: string }
  | { type: "opening"; id: string }
  | null;

type DragState =
  | { type: "outline-point"; index: number }
  | { type: "wall-start"; wallId: string }
  | { type: "wall-end"; wallId: string }
  | null;

type DisplayWall = PlanWall & {
  source: "outline" | "interior";
};

const DEFAULT_WALL_HEIGHT = 2.8;
const DEFAULT_WALL_THICKNESS = 0.16;
function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const [plan, setPlan] = useState<UploadedPlan | null>(null);
  const [parsedPlan, setParsedPlan] = useState<ParsedPlan | null>(null);
  const [mode, setMode] = useState<UiMode>("detection");
  const [creationTool, setCreationTool] = useState<CreationTool>("none");
  const [dragState, setDragState] = useState<DragState>(null);
  const [pendingWallPoint, setPendingWallPoint] = useState<Point | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity>(null);
  const [calibrationPoints, setCalibrationPoints] = useState<Point[]>([]);
  const [realDistanceMeters, setRealDistanceMeters] = useState(1);
  const [pixelsPerMeter, setPixelsPerMeter] = useState<number | null>(null);
  const [wallHeight, setWallHeight] = useState(DEFAULT_WALL_HEIGHT);
  const [wallThickness, setWallThickness] = useState(DEFAULT_WALL_THICKNESS);
  const [status, setStatus] = useState("Sube un plano y la app intentará detectar automáticamente la geometría.");
  const [isParsing, setIsParsing] = useState(false);
  const [sceneView, setSceneView] = useState<SceneViewState | null>(null);

  const sceneStore = useScene;
  const viewerStore = useViewer;

  const displayWalls = useMemo(() => (parsedPlan ? getDisplayWalls(parsedPlan) : []), [parsedPlan]);
  const selectedWall = selectedEntity?.type === "wall" ? displayWalls.find((wall) => wall.id === selectedEntity.id) ?? null : null;
  const selectedOpening =
    selectedEntity?.type === "opening" ? parsedPlan?.openings.find((opening) => opening.id === selectedEntity.id) ?? null : null;

  useEffect(() => {
    const viewer = viewerStore.getState();
    viewer.setTheme("light");
    viewer.setWallMode("cutaway");
    viewer.setLevelMode("solo");
    viewer.setShowGrid(true);
  }, [viewerStore]);

  useEffect(() => {
    return () => {
      if (plan) {
        URL.revokeObjectURL(plan.src);
      }
    };
  }, [plan]);

  useEffect(() => {
    if (!plan || !parsedPlan || !pixelsPerMeter) {
      return;
    }

    if (!isParsedPlanRenderable(parsedPlan, plan)) {
      sceneStore.getState().clearScene();
      viewerStore.getState().resetSelection();
      setSceneView(null);
      return;
    }

    const scene = buildPascalScene({
      imageHeight: plan.height,
      parsedPlan,
      pixelsPerMeter,
      wallHeight,
      wallThickness,
    });

    sceneStore.getState().setScene(scene.nodes, scene.rootNodeIds);
    viewerStore.getState().setSelection({
      buildingId: scene.buildingId,
      levelId: scene.levelId,
      zoneId: null,
      selectedIds: [],
    });
    setSceneView({
      center: scene.center,
      radius: scene.radius,
      revision: Date.now(),
      roomCount: scene.roomCount,
      openingCount: scene.openingCount,
    });
  }, [parsedPlan, pixelsPerMeter, plan, sceneStore, viewerStore, wallHeight, wallThickness]);

  useEffect(() => {
    if (!dragState || !plan) {
      return;
    }

    const onMouseMove = (event: MouseEvent) => {
      const nextPoint = getClientSvgPoint(event.clientX, event.clientY, svgRef.current, plan);
      if (!nextPoint) {
        return;
      }

      setParsedPlan((current) => {
        if (!current) {
          return current;
        }

        if (dragState.type === "outline-point") {
          return {
            ...current,
            outline: {
              ...current.outline,
              points: current.outline.points.map((point, index) => (index === dragState.index ? nextPoint : point)),
            },
          };
        }

        return {
          ...current,
          walls: current.walls.map((wall) => {
            if (wall.id !== dragState.wallId) {
              return wall;
            }

            return {
              ...wall,
              start: dragState.type === "wall-start" ? nextPoint : wall.start,
              end: dragState.type === "wall-end" ? nextPoint : wall.end,
            };
          }),
        };
      });
    };

    const onMouseUp = () => setDragState(null);

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragState, plan]);

  function onPickPlan() {
    fileInputRef.current?.click();
  }

  function resetAll(nextPlan?: UploadedPlan | null) {
    if (plan && plan.src !== nextPlan?.src) {
      URL.revokeObjectURL(plan.src);
    }

    setPlan(nextPlan ?? null);
    setParsedPlan(null);
    setMode("detection");
    setCreationTool("none");
    setPendingWallPoint(null);
    setSelectedEntity(null);
    setDragState(null);
    setCalibrationPoints([]);
    setRealDistanceMeters(1);
    setPixelsPerMeter(null);
    setWallHeight(DEFAULT_WALL_HEIGHT);
    setWallThickness(DEFAULT_WALL_THICKNESS);
    setSceneView(null);
    setStatus("Sube un plano y la app intentará detectar automáticamente la geometría.");
    sceneStore.getState().clearScene();
    viewerStore.getState().resetSelection();
  }

  async function onPlanSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const src = URL.createObjectURL(file);
    const dimensions = await getImageDimensions(src);
    const nextPlan = {
      src,
      width: dimensions.width,
      height: dimensions.height,
      name: file.name,
    };

    resetAll(nextPlan);
    setStatus("Plano cargado. Analizando geometría...");
    await runAutoDetection(nextPlan, file);
    event.target.value = "";
  }

  async function runAutoDetection(targetPlan = plan, sourceFile?: File) {
    if (!targetPlan) {
      return;
    }

    setIsParsing(true);
    setStatus(`Detectando geometría automáticamente con el backend en ${getBackendUrl()}...`);

    try {
      let detected: ParsedPlan;

      if (sourceFile) {
        detected = await analyzePlanWithBackend(sourceFile);
      } else {
        const file = await fileFromObjectUrl(targetPlan.src, targetPlan.name);
        detected = await analyzePlanWithBackend(file);
      }

      const autoPixelsPerMeter = detected.scale.pixelsPerMeter ?? estimatePixelsPerMeter(detected);
      setParsedPlan({
        ...detected,
        scale: {
          source: detected.scale.source ?? "auto",
          pixelsPerMeter: autoPixelsPerMeter,
        },
      });
      setPixelsPerMeter((current) => current ?? autoPixelsPerMeter);
      if (isParsedPlanRenderable(detected, targetPlan)) {
        setStatus(
          `Detección lista. Contorno ${detected.outline.points.length} puntos, ${detected.walls.length} muros internos, ${detected.rooms.length} ambientes, confianza ${formatPercent(detected.confidence)}.`,
        );
      } else {
        setStatus(
          "El backend respondió, pero la geometría devuelta no es renderizable todavía. Revisa el contorno y la red de muros antes de generar escena.",
        );
      }
    } catch (error) {
      console.error("Backend detection failed, falling back to local parser.", error);

      try {
        const fallbackDetected = await autoDetectPlanGeometry(targetPlan.src);
        const fallbackPixelsPerMeter = estimatePixelsPerMeter(fallbackDetected);
        setParsedPlan({
          ...fallbackDetected,
          scale: {
            source: "auto",
            pixelsPerMeter: fallbackPixelsPerMeter,
          },
        });
        setPixelsPerMeter((current) => current ?? fallbackPixelsPerMeter);
        setStatus(
          "El backend no respondió. Se usó el parser local de respaldo; la precisión será menor que con el servicio Python.",
        );
      } catch (fallbackError) {
        console.error(fallbackError);
        setStatus("No pude detectar la geometría automáticamente con este plano. Necesita revisión manual.");
      }
    } finally {
      setIsParsing(false);
    }
  }

  function onCanvasClick(event: React.MouseEvent<SVGSVGElement>) {
    if (!plan) {
      return;
    }

    const point = getSvgPoint(event);
    if (!point) {
      return;
    }

    if (mode === "calibration") {
      setCalibrationPoints((current) => (current.length === 2 ? [point] : [...current, point]));
      return;
    }

    if (mode !== "edit" || !parsedPlan) {
      return;
    }

    if (creationTool === "wall") {
      if (!pendingWallPoint) {
        setPendingWallPoint(point);
        setStatus("Selecciona el segundo punto del muro.");
        return;
      }

      if (distanceBetween(pendingWallPoint, point) < 10) {
        setStatus("El nuevo muro es demasiado corto.");
        return;
      }

      setParsedPlan((current) =>
        current
          ? {
              ...current,
              walls: [
                ...current.walls,
                {
                  id: generateId("wall"),
                  kind: "interior",
                  start: pendingWallPoint,
                  end: point,
                  confidence: 1,
                },
              ],
            }
          : current,
      );
      setPendingWallPoint(null);
      setCreationTool("none");
      setStatus("Muro agregado manualmente.");
      return;
    }

    setSelectedEntity(null);
  }

  function onWallClick(wall: DisplayWall, event: React.MouseEvent<SVGLineElement>) {
    event.stopPropagation();
    setSelectedEntity({ type: "wall", id: wall.id });

    if (mode !== "edit" || creationTool === "none") {
      return;
    }

    if (creationTool === "door" || creationTool === "window") {
      const point = getSvgPoint(event);
      if (!point) {
        return;
      }

      const opening = createOpeningFromWall({
        wall,
        clickPoint: point,
        kind: creationTool,
      });

      setParsedPlan((current) => (current ? { ...current, openings: [...current.openings, opening] } : current));
      setSelectedEntity({ type: "opening", id: opening.id });
      setCreationTool("none");
      setStatus(`${creationTool === "door" ? "Puerta" : "Ventana"} agregada manualmente.`);
    }
  }

  function onOpeningClick(openingId: string, event: React.MouseEvent<SVGElement>) {
    event.stopPropagation();
    setSelectedEntity({ type: "opening", id: openingId });
  }

  function onConfirmScale() {
    if (calibrationPoints.length !== 2 || realDistanceMeters <= 0) {
      return;
    }

    const pixelDistance = distanceBetween(calibrationPoints[0], calibrationPoints[1]);
    if (!pixelDistance) {
      return;
    }

    const nextPixelsPerMeter = pixelDistance / realDistanceMeters;
    setPixelsPerMeter(nextPixelsPerMeter);
    setParsedPlan((current) =>
      current
        ? {
            ...current,
            scale: {
              source: "manual",
              pixelsPerMeter: nextPixelsPerMeter,
            },
          }
        : current,
    );
    setStatus(`Escala calibrada manualmente: ${formatNumber(nextPixelsPerMeter)} px/m.`);
  }

  function onGenerateScene() {
    if (!parsedPlan) {
      return;
    }

    const nextPixelsPerMeter = pixelsPerMeter ?? estimatePixelsPerMeter(parsedPlan);
    setPixelsPerMeter(nextPixelsPerMeter);
    setStatus("Escena actualizada con perímetro, muros y openings.");
  }

  function updateSelectedWallKind(kind: PlanWall["kind"]) {
    if (!selectedWall || !parsedPlan || selectedWall.source !== "interior") {
      return;
    }

    setParsedPlan({
      ...parsedPlan,
      walls: parsedPlan.walls.map((wall) => (wall.id === selectedWall.id ? { ...wall, kind } : wall)),
    });
  }

  function updateSelectedOpening(patch: Partial<PlanOpening>) {
    if (!selectedOpening || !parsedPlan) {
      return;
    }

    setParsedPlan({
      ...parsedPlan,
      openings: parsedPlan.openings.map((opening) => (opening.id === selectedOpening.id ? { ...opening, ...patch } : opening)),
    });
  }

  function deleteSelectedEntity() {
    if (!selectedEntity || !parsedPlan) {
      return;
    }

    if (selectedEntity.type === "wall") {
      if (selectedEntity.id.startsWith("outline-wall-")) {
        setStatus("Los muros exteriores se editan moviendo los vértices del perímetro.");
        return;
      }

      setParsedPlan({
        ...parsedPlan,
        walls: parsedPlan.walls.filter((wall) => wall.id !== selectedEntity.id),
        openings: parsedPlan.openings.filter((opening) => opening.wallId !== selectedEntity.id),
      });
      setSelectedEntity(null);
      return;
    }

    setParsedPlan({
      ...parsedPlan,
      openings: parsedPlan.openings.filter((opening) => opening.id !== selectedEntity.id),
    });
    setSelectedEntity(null);
  }

  const canGenerateScene = Boolean(plan && parsedPlan);
  const outlinePoints = parsedPlan?.outline.points.length ?? 0;
  const interiorWalls = parsedPlan?.walls.length ?? 0;
  const totalOpenings = parsedPlan?.openings.length ?? 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">MVP+</p>
              <h1>Plano a 3D</h1>
            </div>
            <button className="secondary-button" onClick={() => resetAll()}>
              Limpiar
            </button>
          </div>

          <p className="panel-copy">
            Detección automática, corrección manual y generación 3D con puertas, ventanas y ambientes detectados.
          </p>

          <div className="actions-row">
            <button className="primary-button" onClick={onPickPlan}>
              Subir plano
            </button>
            <input
              ref={fileInputRef}
              className="hidden-input"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={onPlanSelected}
            />
            <span className="file-name">{plan?.name ?? "Sin archivo"}</span>
          </div>

          <div className="mode-grid">
            <button className={mode === "detection" ? "mode-button active" : "mode-button"} onClick={() => setMode("detection")}>
              Detección
            </button>
            <button className={mode === "calibration" ? "mode-button active" : "mode-button"} onClick={() => setMode("calibration")}>
              Calibración
            </button>
            <button className={mode === "edit" ? "mode-button active" : "mode-button"} onClick={() => setMode("edit")}>
              Edición
            </button>
          </div>

          <div className="mode-grid mode-grid-tools">
            <button
              className={creationTool === "none" ? "mode-button active" : "mode-button"}
              disabled={mode !== "edit"}
              onClick={() => {
                setCreationTool("none");
                setPendingWallPoint(null);
              }}
            >
              Selección
            </button>
            <button
              className={creationTool === "wall" ? "mode-button active" : "mode-button"}
              disabled={mode !== "edit"}
              onClick={() => {
                setCreationTool("wall");
                setPendingWallPoint(null);
              }}
            >
              Muro
            </button>
            <button
              className={creationTool === "door" ? "mode-button active" : "mode-button"}
              disabled={mode !== "edit"}
              onClick={() => setCreationTool("door")}
            >
              Puerta
            </button>
            <button
              className={creationTool === "window" ? "mode-button active" : "mode-button"}
              disabled={mode !== "edit"}
              onClick={() => setCreationTool("window")}
            >
              Ventana
            </button>
          </div>

          <div className="field-grid">
            <label className="field">
              <span>Distancia real (m)</span>
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={realDistanceMeters}
                onChange={(event) => setRealDistanceMeters(Number(event.target.value))}
              />
            </label>

            <label className="field">
              <span>Altura de muro (m)</span>
              <input
                type="number"
                min="2"
                max="4"
                step="0.1"
                value={wallHeight}
                onChange={(event) => setWallHeight(Number(event.target.value))}
              />
            </label>

            <label className="field">
              <span>Espesor de muro (m)</span>
              <input
                type="number"
                min="0.08"
                max="0.5"
                step="0.01"
                value={wallThickness}
                onChange={(event) => setWallThickness(Number(event.target.value))}
              />
            </label>
          </div>

          {selectedWall && (
            <div className="selection-panel">
              <p className="eyebrow">Muro seleccionado</p>
              <label className="field">
                <span>Tipo</span>
                <select value={selectedWall.kind} onChange={(event) => updateSelectedWallKind(event.target.value as PlanWall["kind"])}>
                  <option value="exterior">Exterior</option>
                  <option value="interior">Interior</option>
                </select>
              </label>
              <button className="secondary-button" onClick={deleteSelectedEntity}>
                Eliminar muro
              </button>
            </div>
          )}

          {selectedOpening && (
            <div className="selection-panel">
              <p className="eyebrow">{selectedOpening.kind === "door" ? "Puerta" : "Ventana"} seleccionada</p>
              <label className="field">
                <span>Ancho (m)</span>
                <input
                  type="number"
                  min="0.4"
                  max="4"
                  step="0.05"
                  value={selectedOpening.widthMeters}
                  onChange={(event) => updateSelectedOpening({ widthMeters: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span>Alto (m)</span>
                <input
                  type="number"
                  min="0.4"
                  max="3"
                  step="0.05"
                  value={selectedOpening.heightMeters}
                  onChange={(event) => updateSelectedOpening({ heightMeters: Number(event.target.value) })}
                />
              </label>
              {selectedOpening.kind === "window" && (
                <label className="field">
                  <span>Antepecho (m)</span>
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.05"
                    value={selectedOpening.sillHeightMeters}
                    onChange={(event) => updateSelectedOpening({ sillHeightMeters: Number(event.target.value) })}
                  />
                </label>
              )}
              <button className="secondary-button" onClick={deleteSelectedEntity}>
                Eliminar opening
              </button>
            </div>
          )}

          <div className="actions-row">
            <button className="secondary-button" disabled={calibrationPoints.length !== 2} onClick={onConfirmScale}>
              Confirmar escala
            </button>
            <button className="secondary-button" disabled={!parsedPlan || isParsing} onClick={() => setCalibrationPoints([])}>
              Limpiar escala
            </button>
            <button className="primary-button" disabled={!canGenerateScene || isParsing} onClick={onGenerateScene}>
              Generar escena
            </button>
          </div>

          <div className="actions-row">
            <button className="secondary-button" disabled={!plan || isParsing} onClick={() => void runAutoDetection()}>
              Redetectar
            </button>
            <button
              className="secondary-button"
              disabled={!pendingWallPoint}
              onClick={() => {
                setPendingWallPoint(null);
                setCreationTool("none");
              }}
            >
              Cancelar herramienta
            </button>
          </div>

          <div className="stats-card">
            <div>
              <span className="stat-label">Escala</span>
              <strong>{pixelsPerMeter ? `${formatNumber(pixelsPerMeter)} px/m` : "Pendiente"}</strong>
            </div>
            <div>
              <span className="stat-label">Contorno</span>
              <strong>{outlinePoints} puntos</strong>
            </div>
            <div>
              <span className="stat-label">Muros</span>
              <strong>{interiorWalls}</strong>
            </div>
            <div>
              <span className="stat-label">Openings</span>
              <strong>{totalOpenings}</strong>
            </div>
          </div>

          <p className="status-copy">{status}</p>
        </div>
      </aside>

      <main className="workspace">
        <section className="surface plan-surface">
          <div className="surface-header">
            <div>
              <p className="eyebrow">Entrada</p>
              <h2>Parseo 2D</h2>
            </div>
            <p className="hint">
              Modo actual: <strong>{modeLabel(mode)}</strong>
            </p>
          </div>

          {plan ? (
            <div className="plan-canvas-wrap">
              <svg ref={svgRef} className="plan-canvas" viewBox={`0 0 ${plan.width} ${plan.height}`} onClick={onCanvasClick}>
                <image href={plan.src} x="0" y="0" width={plan.width} height={plan.height} preserveAspectRatio="none" />

                {parsedPlan && (
                  <>
                    <polygon
                      className="perimeter-fill"
                      points={parsedPlan.outline.points.map((point) => `${point.x},${point.y}`).join(" ")}
                    />

                    {displayWalls.map((wall) => (
                      <line
                        key={wall.id}
                        className={[
                          "wall-line",
                          wall.kind === "exterior" ? "perimeter" : "interior",
                          selectedWall?.id === wall.id ? "selected" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        x1={wall.start.x}
                        y1={wall.start.y}
                        x2={wall.end.x}
                        y2={wall.end.y}
                        onClick={(event) => onWallClick(wall, event)}
                      />
                    ))}

                    {parsedPlan.outline.points.map((point, index) => (
                      <circle
                        key={`outline-${index}`}
                        className="edit-handle outline"
                        cx={point.x}
                        cy={point.y}
                        r="6"
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          if (mode === "edit") {
                            setDragState({ type: "outline-point", index });
                          }
                        }}
                      />
                    ))}

                    {parsedPlan.walls.flatMap((wall) => [
                      <circle
                        key={`${wall.id}-start`}
                        className="edit-handle wall"
                        cx={wall.start.x}
                        cy={wall.start.y}
                        r="5"
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          if (mode === "edit") {
                            setDragState({ type: "wall-start", wallId: wall.id });
                          }
                        }}
                      />,
                      <circle
                        key={`${wall.id}-end`}
                        className="edit-handle wall"
                        cx={wall.end.x}
                        cy={wall.end.y}
                        r="5"
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          if (mode === "edit") {
                            setDragState({ type: "wall-end", wallId: wall.id });
                          }
                        }}
                      />,
                    ])}

                    {parsedPlan.openings.map((opening) => {
                      const wall = displayWalls.find((candidate) => candidate.id === opening.wallId);
                      if (!wall) {
                        return null;
                      }

                      const marker = getOpeningMarker(wall, opening, pixelsPerMeter);
                      return (
                        <g key={opening.id} onClick={(event) => onOpeningClick(opening.id, event)}>
                          <rect
                            className={[
                              "opening-marker",
                              opening.kind,
                              selectedOpening?.id === opening.id ? "selected" : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            x={marker.x}
                            y={marker.y}
                            width={marker.width}
                            height={marker.height}
                            transform={`rotate(${marker.angle} ${marker.center.x} ${marker.center.y})`}
                            rx="4"
                            ry="4"
                          />
                          <circle className="opening-center" cx={marker.center.x} cy={marker.center.y} r="3" />
                        </g>
                      );
                    })}
                  </>
                )}

                {pendingWallPoint && <circle className="pending-point" cx={pendingWallPoint.x} cy={pendingWallPoint.y} r="7" />}

                {calibrationPoints.map((point, index) => (
                  <circle key={`calibration-${index}`} className="calibration-point" cx={point.x} cy={point.y} r="8" />
                ))}
                {calibrationPoints.length === 2 && (
                  <line
                    className="calibration-line"
                    x1={calibrationPoints[0].x}
                    y1={calibrationPoints[0].y}
                    x2={calibrationPoints[1].x}
                    y2={calibrationPoints[1].y}
                  />
                )}
              </svg>
            </div>
          ) : (
            <div className="empty-state">
              <p>Sube una imagen para probar el pipeline automático.</p>
            </div>
          )}
        </section>

        <section className="surface viewer-surface">
          <div className="surface-header">
            <div>
              <p className="eyebrow">Salida</p>
              <h2>Escena Pascal</h2>
            </div>
            <p className="hint">
              Ambientes: <strong>{sceneView?.roomCount ?? 0}</strong> · Openings: <strong>{sceneView?.openingCount ?? 0}</strong>
            </p>
          </div>

          <div className="viewer-wrap">
            <Viewer>
              <SceneViewportControls sceneView={sceneView} />
            </Viewer>
          </div>
        </section>
      </main>
    </div>
  );
}

function SceneViewportControls({ sceneView }: { sceneView: SceneViewState | null }) {
  const { camera } = useThree();

  useEffect(() => {
    if (!sceneView) {
      return;
    }

    const distance = Math.max(sceneView.radius * 2.1, 8);
    camera.position.set(sceneView.center.x + distance, distance * 0.85, sceneView.center.z + distance);
    camera.lookAt(sceneView.center.x, 0, sceneView.center.z);
    camera.updateProjectionMatrix();
  }, [camera, sceneView]);

  return (
    <OrbitControls
      enableDamping
      dampingFactor={0.08}
      makeDefault
      maxDistance={200}
      minDistance={1}
      target={[sceneView?.center.x ?? 0, 0, sceneView?.center.z ?? 0]}
    />
  );
}

function getDisplayWalls(parsedPlan: ParsedPlan): DisplayWall[] {
  const outlineWalls = getOutlineWalls(parsedPlan).map((wall) => ({
    ...wall,
    source: "outline" as const,
  }));

  return [
    ...outlineWalls,
    ...getCleanInteriorWalls(parsedPlan).map((wall) => ({
      ...wall,
      source: "interior" as const,
    })),
  ];
}

function isParsedPlanRenderable(parsedPlan: ParsedPlan, plan: UploadedPlan) {
  if (parsedPlan.outline.points.length < 4) {
    return false;
  }

  const bounds = getPointBounds(parsedPlan.outline.points);
  const outlineWidth = bounds.maxX - bounds.minX;
  const outlineHeight = bounds.maxY - bounds.minY;
  if (outlineWidth <= 8 || outlineHeight <= 8) {
    return false;
  }

  const outlineArea = polygonArea(parsedPlan.outline.points);
  const imageArea = Math.max(plan.width * plan.height, 1);
  const areaRatio = outlineArea / imageArea;
  if (areaRatio <= 0.015 || areaRatio >= 0.96) {
    return false;
  }

  if (parsedPlan.walls.length === 0) {
    return false;
  }

  return true;
}

function getSvgPoint(event: React.MouseEvent<SVGSVGElement | SVGLineElement>) {
  const svg = event.currentTarget.ownerSVGElement ?? (event.currentTarget as SVGSVGElement);
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;

  if (!rect.width || !rect.height) {
    return null;
  }

  return {
    x: ((event.clientX - rect.left) / rect.width) * viewBox.width + viewBox.x,
    y: ((event.clientY - rect.top) / rect.height) * viewBox.height + viewBox.y,
  };
}

function getClientSvgPoint(clientX: number, clientY: number, svg: SVGSVGElement | null, plan: UploadedPlan) {
  if (!svg) {
    return null;
  }

  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return null;
  }

  return {
    x: clamp(((clientX - rect.left) / rect.width) * plan.width, 0, plan.width),
    y: clamp(((clientY - rect.top) / rect.height) * plan.height, 0, plan.height),
  };
}

function createOpeningFromWall({
  wall,
  clickPoint,
  kind,
}: {
  wall: DisplayWall;
  clickPoint: Point;
  kind: OpeningKind;
}): PlanOpening {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const lengthSquared = dx * dx + dy * dy || 1;
  const projection = ((clickPoint.x - wall.start.x) * dx + (clickPoint.y - wall.start.y) * dy) / lengthSquared;

  return {
    id: generateId("opening"),
    wallId: wall.id,
    kind,
    offsetRatio: clamp(projection, 0.08, 0.92),
    widthMeters: kind === "door" ? 0.9 : 1.4,
    heightMeters: kind === "door" ? 2.1 : 1.2,
    sillHeightMeters: kind === "door" ? 0 : 0.9,
    confidence: 1,
  };
}

function getOpeningMarker(wall: DisplayWall, opening: PlanOpening, pixelsPerMeter: number | null) {
  const center = {
    x: wall.start.x + (wall.end.x - wall.start.x) * opening.offsetRatio,
    y: wall.start.y + (wall.end.y - wall.start.y) * opening.offsetRatio,
  };
  const angle = (Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x) * 180) / Math.PI;
  const width = clamp((opening.widthMeters * (pixelsPerMeter ?? 45)) / 2.5, 18, 72);
  const height = opening.kind === "door" ? 12 : 16;

  return {
    center,
    angle,
    width,
    height,
    x: center.x - width / 2,
    y: center.y - height / 2,
  };
}

function distanceBetween(start: Point, end: Point) {
  return Math.hypot(end.x - start.x, end.y - start.y);
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

function polygonArea(points: Point[]) {
  let area = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }

  return Math.abs(area) / 2;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function modeLabel(mode: UiMode) {
  if (mode === "detection") {
    return "Detección";
  }

  if (mode === "calibration") {
    return "Calibración";
  }

  return "Edición";
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(value);
}

function formatPercent(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

async function getImageDimensions(src: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.width, height: image.height });
    image.onerror = reject;
    image.src = src;
  });
}

async function fileFromObjectUrl(url: string, filename: string) {
  const response = await fetch(url);
  const blob = await response.blob();
  return new File([blob], filename, { type: blob.type || "application/octet-stream" });
}

export default App;
