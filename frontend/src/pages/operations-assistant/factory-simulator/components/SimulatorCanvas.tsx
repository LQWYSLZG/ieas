/**
 * SimulatorCanvas: Main Konva canvas for the Factory Floor Simulator.
 *
 * Renders all element types (Source, Station, Buffer, Sink, Operator Pool)
 * with distinct shapes and colors. Supports drag-and-drop, selection,
 * connection drawing, and simulation result visualization.
 */

import type { CSSProperties } from "react";
import { useEffect, useRef, useState, useCallback } from "react";
import { Stage, Layer, Image as KonvaImage, Rect, Group, Text, Circle, Arrow, Line } from "react-konva";
import type Konva from "konva";
import { useLayout } from "../context/LayoutContext";
import { isPdfDataUrl, pdfToImageDataUrl } from "../utils/pdfToImage";
import { getUtilizationColor, getLineThickness } from "../utils/visualization";
import type { SimulationResult, CanvasElement, Connection, StationMetrics } from "../types";

const MIN_WIDTH = 1200;
const MIN_HEIGHT = 800;

// Board (pannable floor) dimensions: large so panning has room to roam.
const BOARD_WIDTH = 4000;
const BOARD_HEIGHT = 3000;

// Element dimensions
const ELEMENT_WIDTH = 120;
const ELEMENT_HEIGHT = 70;

// Connection port dimensions. The visible dot is PORT_RADIUS; the (invisible)
// clickable/droppable area is PORT_HIT_RADIUS, larger and centered on the dot
// so connections are easy to start and land on the dot's center.
const PORT_RADIUS = 8;
const PORT_HIT_RADIUS = 18;

// Zoom limits
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;
const SCALE_BY = 1.08;

// Default stage size before the wrapper is measured.
const DEFAULT_STAGE_WIDTH = 800;
const DEFAULT_STAGE_HEIGHT = 780;

// Shared style for the zoom-control buttons (dark steel-blue theme).
const zoomBtnStyle: CSSProperties = {
  width: "26px",
  height: "26px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#2d5a8e",
  color: "#fff",
  border: "1px solid #3d6aa0",
  borderRadius: "5px",
  fontSize: "1rem",
  fontWeight: 700,
  lineHeight: 1,
  cursor: "pointer",
  fontFamily: "inherit",
  padding: 0,
};

export interface SimulatorCanvasProps {
  isSimulating: boolean;
  simulationResults: SimulationResult | null;
  selectedElementId: string | null;
  onSelectElement: (id: string | null) => void;
  targetThroughput: number;
}

export default function SimulatorCanvas({
  isSimulating,
  simulationResults,
  selectedElementId,
  onSelectElement,
  targetThroughput,
}: SimulatorCanvasProps) {
  const { layout, dispatch } = useLayout();
  const [floorPlanImage, setFloorPlanImage] = useState<HTMLImageElement | null>(null);
  const [isDrawingConnection, setIsDrawingConnection] = useState(false);
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(null);
  const [drawingLinePoints, setDrawingLinePoints] = useState<number[]>([]);
  const stageRef = useRef<Konva.Stage>(null);

  // ─── Pan & Zoom state ──────────────────────────────────────────
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>({
    width: DEFAULT_STAGE_WIDTH,
    height: DEFAULT_STAGE_HEIGHT,
  });
  const [stagePos, setStagePos] = useState<Konva.Vector2d>({ x: 0, y: 0 });
  const [stageScale, setStageScale] = useState(1);
  // True while the stage itself is being dragged (panning) so we can suppress
  // the background click that would otherwise clear the selection.
  const isPanningRef = useRef(false);

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Load floor plan
  useEffect(() => {
    if (layout.floor_plan?.data_url) {
      const dataUrl = layout.floor_plan.data_url;
      if (isPdfDataUrl(dataUrl)) {
        pdfToImageDataUrl(dataUrl, MIN_WIDTH, MIN_HEIGHT)
          .then((png) => {
            const img = new window.Image();
            img.onload = () => setFloorPlanImage(img);
            img.src = png;
          })
          .catch(() => setFloorPlanImage(null));
      } else {
        const img = new window.Image();
        img.onload = () => setFloorPlanImage(img);
        img.onerror = () => setFloorPlanImage(null);
        img.src = dataUrl;
      }
    } else {
      setFloorPlanImage(null);
    }
  }, [layout.floor_plan]);

  // Ensures the initial view is centered on the working area only once, so
  // zoom in/out feels anchored to the middle rather than drifting to a corner.
  const didInitCenterRef = useRef(false);

  // Panning uses the middle mouse button (button 1). Left-drag on empty
  // background is reserved for marquee (rectangle) multi-select, which is the
  // natural, expected gesture. (Space is already bound to "duplicate", so we
  // intentionally avoid Space-to-pan.)

  // ─── Measure wrapper to size the Stage (infinite-canvas fill) ──
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const measure = () => {
      const rect = wrapper.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setStageSize((prev) =>
          prev.width === rect.width && prev.height === rect.height
            ? prev
            : { width: rect.width, height: rect.height }
        );

        // One-time initial centering so the content sits in the MIDDLE of the
        // viewport at 100% zoom. Centering on the actual element centroid (or a
        // sensible work origin when empty) means zoom in/out pivots on what the
        // user sees as the center, instead of appearing to drift to a corner.
        if (!didInitCenterRef.current) {
          didInitCenterRef.current = true;
          const els = elementMapRef.current;
          let focusX = 500; // fallback: center of the initial work area
          let focusY = 380;
          if (els.size > 0) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            els.forEach((el) => {
              minX = Math.min(minX, el.x);
              minY = Math.min(minY, el.y);
              maxX = Math.max(maxX, el.x + ELEMENT_WIDTH);
              maxY = Math.max(maxY, el.y + ELEMENT_HEIGHT);
            });
            focusX = (minX + maxX) / 2;
            focusY = (minY + maxY) / 2;
          }
          setStagePos({
            x: rect.width / 2 - focusX,
            y: rect.height / 2 - focusY,
          });
        }
      }
    };

    measure();

    // ResizeObserver may be absent in some environments (e.g. jsdom test runs);
    // fall back to the initial measurement in that case.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  // Memoize element list and map to avoid recreating on every render
  const allElements = useCallback((): CanvasElement[] => [
    ...layout.sources,
    ...layout.stations,
    ...layout.buffers,
    ...layout.sinks,
    ...layout.operator_pools,
  ], [layout.sources, layout.stations, layout.buffers, layout.sinks, layout.operator_pools]);

  const elements = allElements();
  const elementMapRef = useRef<Map<string, CanvasElement>>(new Map());
  elementMapRef.current = new Map(elements.map((e) => [e.id, e]));
  const elementMap = elementMapRef.current;

  const getStationMetrics = useCallback(
    (stationId: string): StationMetrics | undefined =>
      simulationResults?.stations.find((s) => s.station_id === stationId),
    [simulationResults]
  );

  // ─── Keyboard Shortcuts ────────────────────────────────────────
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't fire shortcuts if user is typing in any form element
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable) return;

      const hasSelection = selectedIds.size > 0 || selectedElementId;

      // Space = Duplicate selected
      if (e.code === "Space" && hasSelection) {
        e.preventDefault();
        const ids = selectedIds.size > 0 ? selectedIds : new Set(selectedElementId ? [selectedElementId] : []);
        ids.forEach((id) => {
          const el = elementMapRef.current.get(id);
          if (!el) return;
          const newId = crypto.randomUUID();
          const offset = 40;
          if (el.element_type === "source") {
            dispatch({ type: "ADD_SOURCE", source: { ...el, id: newId, name: el.name + " copy", x: el.x + offset, y: el.y + offset } });
          } else if (el.element_type === "station") {
            dispatch({ type: "ADD_STATION", station: { ...el, id: newId, name: el.name + " copy", x: el.x + offset, y: el.y + offset } });
          } else if (el.element_type === "buffer") {
            dispatch({ type: "ADD_BUFFER", buffer: { ...el, id: newId, name: el.name + " copy", x: el.x + offset, y: el.y + offset } });
          } else if (el.element_type === "sink") {
            dispatch({ type: "ADD_SINK", sink: { ...el, id: newId, name: el.name + " copy", x: el.x + offset, y: el.y + offset } });
          }
        });
      }

      // Delete key only (NOT Backspace) = Delete selected
      if (e.code === "Delete" && hasSelection) {
        e.preventDefault();
        const ids = selectedIds.size > 0 ? selectedIds : new Set(selectedElementId ? [selectedElementId] : []);
        ids.forEach((id) => dispatch({ type: "DELETE_ELEMENT", id }));
        setSelectedIds(new Set());
        onSelectElement(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIds, selectedElementId, dispatch, onSelectElement]);

  // ─── Event Handlers ────────────────────────────────────────────

  // Track if a drag-select just happened to prevent click from clearing it
  const didDragSelect = useRef(false);

  const handleStageClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
    // Don't clear selection on right-click (context menu)
    if (e.evt.button === 2) return;

    setContextMenu(null);

    // If we just finished panning, don't treat it as a background click.
    if (isPanningRef.current) {
      isPanningRef.current = false;
      return;
    }

    // If we just finished a drag-select, don't clear
    if (didDragSelect.current) {
      didDragSelect.current = false;
      return;
    }

    if (e.target === e.target.getStage() || e.target.attrs.id === "canvas-bg") {
      onSelectElement(null);
      setSelectedIds(new Set());
      if (isDrawingConnection) {
        setIsDrawingConnection(false);
        setConnectionSourceId(null);
        setDrawingLinePoints([]);
      }
    }
  };

  const handleElementClick = (id: string, e?: MouseEvent) => {
    if (isSimulating) return;
    setContextMenu(null);

    if (isDrawingConnection && connectionSourceId) {
      if (id !== connectionSourceId) {
        dispatch({
          type: "ADD_CONNECTION",
          connection: {
            id: crypto.randomUUID(),
            source_id: connectionSourceId,
            target_id: id,
            transport_time: 0,
            transport_mode: "none",
            distance: 0,
          },
        });
      }
      setIsDrawingConnection(false);
      setConnectionSourceId(null);
      setDrawingLinePoints([]);
      return;
    }

    // Ctrl+click for multi-select (LEFT click)
    if (e?.ctrlKey || e?.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    } else {
      setSelectedIds(new Set([id]));
      onSelectElement(id);
    }
  };

  const handleDragEnd = (id: string, x: number, y: number) => {
    // If this element is part of multi-selection, move all selected elements
    if (selectedIds.has(id) && selectedIds.size > 1) {
      const draggedEl = elementMap.get(id);
      if (!draggedEl) return;
      const dx = x - draggedEl.x;
      const dy = y - draggedEl.y;
      selectedIds.forEach((selectedId) => {
        const el = elementMap.get(selectedId);
        if (el) {
          dispatch({ type: "MOVE_ELEMENT", id: selectedId, x: el.x + dx, y: el.y + dy });
        }
      });
    } else {
      dispatch({ type: "MOVE_ELEMENT", id, x, y });
    }
  };

  const handleStartConnection = (id: string) => {
    if (isSimulating) return;
    const el = elementMap.get(id);
    if (!el) return;
    setIsDrawingConnection(true);
    setConnectionSourceId(id);
    const startX = el.x + ELEMENT_WIDTH;
    const startY = el.y + ELEMENT_HEIGHT / 2;
    setDrawingLinePoints([startX, startY, startX, startY]);
  };

  // ─── Pan & Zoom helpers ────────────────────────────────────────

  // Convert a raw pointer (screen) position into canvas (un-transformed)
  // coordinates using the inverse of the stage transform. This keeps pointer
  // math consistent with element x/y once the stage is scaled/translated.
  const toCanvasCoords = useCallback((pointer: Konva.Vector2d): Konva.Vector2d => {
    const stage = stageRef.current;
    if (!stage) return pointer;
    const transform = stage.getAbsoluteTransform().copy().invert();
    return transform.point(pointer);
  }, []);

  const clampScale = (scale: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));

  // Zoom about the CENTER of the canvas viewport. Used by both the wheel and
  // the +/- buttons so zooming always grows/shrinks from the middle of the
  // canvas session rather than drifting toward a corner or the cursor.
  const zoomToCenter = (nextScale: number) => {
    const newScale = clampScale(nextScale);
    const oldScale = stageScale;
    if (newScale === oldScale) return;
    const center = { x: stageSize.width / 2, y: stageSize.height / 2 };
    const pointTo = {
      x: (center.x - stagePos.x) / oldScale,
      y: (center.y - stagePos.y) / oldScale,
    };
    setStageScale(newScale);
    setStagePos({
      x: center.x - pointTo.x * newScale,
      y: center.y - pointTo.y * newScale,
    });
  };

  // Mouse-wheel zoom: pivots about the viewport center (consistent with the
  // zoom buttons) so the canvas grows/shrinks from the middle.
  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    zoomToCenter(direction > 0 ? stageScale * SCALE_BY : stageScale / SCALE_BY);
  };

  const handleZoomIn = () => zoomToCenter(stageScale * 1.2);
  const handleZoomOut = () => zoomToCenter(stageScale / 1.2);

  // Fit: frame all elements within the viewport (with padding), or reset when
  // the board is empty.
  const handleFit = () => {
    if (elements.length === 0) {
      // Empty board: reset to 100% and center the working area in the viewport
      // (not the board corner), matching the initial centered view.
      setStageScale(1);
      setStagePos({
        x: stageSize.width / 2 - 500,
        y: stageSize.height / 2 - 380,
      });
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    elements.forEach((el) => {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + ELEMENT_WIDTH);
      maxY = Math.max(maxY, el.y + ELEMENT_HEIGHT);
    });

    const padding = 60;
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    const viewW = stageSize.width;
    const viewH = stageSize.height;

    const scale = clampScale(
      Math.min((viewW - padding * 2) / contentW, (viewH - padding * 2) / contentH)
    );

    // Center the bounding box in the viewport.
    const centerX = minX + contentW / 2;
    const centerY = minY + contentH / 2;
    setStageScale(scale);
    setStagePos({
      x: viewW / 2 - centerX * scale,
      y: viewH / 2 - centerY * scale,
    });
  };

  // Throttle ref to avoid excessive re-renders on mouse move
  const lastMoveTime = useRef(0);

  const handleMouseMove = (_e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;

    // Only process if actively drawing or selecting
    if (!isDrawingConnection && !isSelecting) return;

    // Throttle to ~30fps (33ms between updates)
    const now = performance.now();
    if (now - lastMoveTime.current < 33) return;
    lastMoveTime.current = now;

    const rawPointer = stage.getPointerPosition();
    if (!rawPointer) return;
    // Convert screen coords → canvas coords so they line up with element x/y
    // once the stage is scaled/translated.
    const pointer = toCanvasCoords(rawPointer);

    // Handle connection drawing
    if (isDrawingConnection && connectionSourceId) {
      const el = elementMap.get(connectionSourceId);
      if (!el) return;
      const startX = el.x + ELEMENT_WIDTH;
      const startY = el.y + ELEMENT_HEIGHT / 2;
      setDrawingLinePoints([startX, startY, pointer.x, pointer.y]);
    }

    // Handle selection rectangle drawing
    if (isSelecting && selectionStart) {
      setSelectionRect({
        x: selectionStart.x,
        y: selectionStart.y,
        width: pointer.x - selectionStart.x,
        height: pointer.y - selectionStart.y,
      });
    }
  };

  const handleDeleteConnection = (id: string) => {
    dispatch({ type: "DELETE_CONNECTION", id });
  };

  // ─── Render Element Shape ──────────────────────────────────────

  function renderElement(element: CanvasElement) {
    const isSelected = selectedElementId === element.id || selectedIds.has(element.id);
    const metrics = element.element_type === "station" ? getStationMetrics(element.id) : undefined;

    let fillColor: string;
    let label: string = element.name;
    let sublabel: string = "";

    switch (element.element_type) {
      case "source": {
        fillColor = "#d4edda";
        // arrival_rate of 0 means "auto-match Target Throughput". A positive
        // value is a manual override the user set in Advanced.
        const liveRate = element.arrival_rate > 0 ? element.arrival_rate : Math.round(targetThroughput);
        sublabel = `${liveRate} units/hr`;
        break;
      }
      case "station":
        fillColor = metrics ? getUtilizationColor(metrics.utilization) : "#e3f2fd";
        sublabel = `CT: ${element.cycle_time}s`;
        if (metrics) sublabel = `${metrics.utilization.toFixed(0)}% util`;
        break;
      case "buffer":
        fillColor = "#fff3cd";
        sublabel = `Cap: ${element.capacity}`;
        break;
      case "sink":
        fillColor = "#f8d7da";
        sublabel = "Exit";
        break;
      case "operator_pool":
        fillColor = "#e8daef";
        sublabel = `${element.count} operators`;
        break;
      default:
        fillColor = "#e9ecef";
    }

    return (
      <Group
        key={element.id}
        x={element.x}
        y={element.y}
        draggable={!isSimulating}
        onClick={(e) => {
          // Only handle left-click for selection
          if (e.evt.button === 0) {
            handleElementClick(element.id, e.evt);
          }
        }}
        onTap={() => handleElementClick(element.id)}
        onDragMove={(e) => {
          const node = e.target;
          const dx = node.x() - element.x;
          const dy = node.y() - element.y;
          const stage = stageRef.current;
          if (!stage) return;
          const layers = stage.getLayers();
          const connLayer = layers[1]; // connections layer

          // Move sibling elements if multi-selected
          if (selectedIds.has(element.id) && selectedIds.size > 1) {
            const elemLayer = node.getLayer();
            if (elemLayer) {
              selectedIds.forEach((sid) => {
                if (sid === element.id) return;
                const el = elementMap.get(sid);
                if (!el) return;
                const siblingNode = elemLayer.findOne(`#group-${sid}`);
                if (siblingNode) {
                  siblingNode.position({ x: el.x + dx, y: el.y + dy });
                }
              });
              elemLayer.batchDraw();
            }
          }

          // Update connection arrows in real-time
          if (connLayer) {
            layout.connections.forEach((conn) => {
              const isSourceMoving = conn.source_id === element.id || (selectedIds.has(element.id) && selectedIds.has(conn.source_id));
              const isTargetMoving = conn.target_id === element.id || (selectedIds.has(element.id) && selectedIds.has(conn.target_id));
              if (!isSourceMoving && !isTargetMoving) return;

              const arrow = connLayer.findOne(`#${conn.id}`);
              if (!arrow) return;

              const srcEl = elementMap.get(conn.source_id);
              const tgtEl = elementMap.get(conn.target_id);
              if (!srcEl || !tgtEl) return;

              const srcOffX = (conn.source_id === element.id || (selectedIds.size > 1 && selectedIds.has(conn.source_id))) ? dx : 0;
              const srcOffY = (conn.source_id === element.id || (selectedIds.size > 1 && selectedIds.has(conn.source_id))) ? dy : 0;
              const tgtOffX = (conn.target_id === element.id || (selectedIds.size > 1 && selectedIds.has(conn.target_id))) ? dx : 0;
              const tgtOffY = (conn.target_id === element.id || (selectedIds.size > 1 && selectedIds.has(conn.target_id))) ? dy : 0;

              (arrow as any).points([
                srcEl.x + ELEMENT_WIDTH + srcOffX,
                srcEl.y + ELEMENT_HEIGHT / 2 + srcOffY,
                tgtEl.x + tgtOffX,
                tgtEl.y + ELEMENT_HEIGHT / 2 + tgtOffY,
              ]);
            });
            connLayer.batchDraw();
          }
        }}
        onDragEnd={(e) => handleDragEnd(element.id, e.target.x(), e.target.y())}
        id={`group-${element.id}`}
      >
        {/* Main shape */}
        <Rect
          width={ELEMENT_WIDTH}
          height={ELEMENT_HEIGHT}
          fill={fillColor}
          stroke={isSelected ? "#0d6efd" : "#6c757d"}
          strokeWidth={isSelected ? 3 : 1}
          cornerRadius={6}
          perfectDrawEnabled={false}
        />

        {/* Type indicator (colored top border - flush with top edge) */}
        <Rect
          x={0}
          y={0}
          width={ELEMENT_WIDTH}
          height={5}
          fill={
            element.element_type === "source" ? "#28a745" :
            element.element_type === "station" ? "#4dabf7" :
            element.element_type === "buffer" ? "#ffc107" :
            element.element_type === "sink" ? "#dc3545" :
            "#9b59b6"
          }
          cornerRadius={[6, 6, 0, 0]}
          listening={false}
          perfectDrawEnabled={false}
        />

        {/* Name label */}
        <Text
          text={label}
          width={ELEMENT_WIDTH}
          y={12}
          align="center"
          fontSize={11}
          fontStyle="bold"
          fill="#212529"
          ellipsis={true}
          wrap="none"
          padding={4}
          listening={false}
          perfectDrawEnabled={false}
        />

        {/* Sub-label */}
        <Text
          text={sublabel}
          width={ELEMENT_WIDTH}
          y={32}
          align="center"
          fontSize={10}
          fill="#6c757d"
          ellipsis={true}
          wrap="none"
          padding={4}
          listening={false}
          perfectDrawEnabled={false}
        />

        {/* Bottleneck indicator */}
        {metrics?.is_bottleneck && (
          <Text
            text="⚠ BOTTLENECK"
            width={ELEMENT_WIDTH}
            y={48}
            align="center"
            fontSize={9}
            fontStyle="bold"
            fill="#dc3545"
            listening={false}
            perfectDrawEnabled={false}
          />
        )}

        {/* Input port (left). A large transparent hit circle centered on the
            dot makes it easy to aim at; completing a connection here snaps the
            line to the dot's center. */}
        <Circle
          x={0}
          y={ELEMENT_HEIGHT / 2}
          radius={PORT_HIT_RADIUS}
          fill="transparent"
          onMouseUp={(e) => {
            if (isDrawingConnection && connectionSourceId && connectionSourceId !== element.id) {
              e.cancelBubble = true;
              handleElementClick(element.id);
            }
          }}
          onClick={(e) => {
            if (isDrawingConnection && connectionSourceId && connectionSourceId !== element.id) {
              e.cancelBubble = true;
              handleElementClick(element.id);
            }
          }}
        />
        <Circle
          x={0}
          y={ELEMENT_HEIGHT / 2}
          radius={PORT_RADIUS}
          fill="#6c757d"
          stroke="#495057"
          strokeWidth={1}
          listening={false}
        />

        {/* Output port (right). Large transparent hit circle centered on the
            dot so it is easy to grab; press starts a connection from the
            dot's center. */}
        <Circle
          x={ELEMENT_WIDTH}
          y={ELEMENT_HEIGHT / 2}
          radius={PORT_HIT_RADIUS}
          fill="transparent"
          onMouseDown={(e) => {
            e.cancelBubble = true;
            handleStartConnection(element.id);
          }}
        />
        <Circle
          x={ELEMENT_WIDTH}
          y={ELEMENT_HEIGHT / 2}
          radius={PORT_RADIUS}
          fill="#0d6efd"
          stroke="#0a58ca"
          strokeWidth={1}
          listening={false}
        />
      </Group>
    );
  }

  // ─── Render Connections ────────────────────────────────────────

  function renderConnection(conn: Connection) {
    const source = elementMap.get(conn.source_id);
    const target = elementMap.get(conn.target_id);
    if (!source || !target) return null;
    if (conn.source_id === conn.target_id) return null;

    const startX = source.x + ELEMENT_WIDTH;
    const startY = source.y + ELEMENT_HEIGHT / 2;
    const endX = target.x;
    const endY = target.y + ELEMENT_HEIGHT / 2;

    // Line thickness visualizes WIP (queue) building up, but only for flow
    // BETWEEN process steps (station/buffer → station). A source feeds material
    // in continuously, so its outgoing link isn't a real WIP queue, keep it thin
    // so the source → first-station line doesn't look misleadingly bold.
    const targetMetrics = getStationMetrics(conn.target_id);
    const sourceIsFeed = source.element_type === "source";
    const thickness = targetMetrics && !sourceIsFeed
      ? getLineThickness(targetMetrics.avg_queue_length)
      : 2;

    return (
      <Arrow
        key={conn.id}
        id={conn.id}
        points={[startX, startY, endX, endY]}
        pointerLength={8}
        pointerWidth={6}
        stroke={selectedElementId === conn.id ? "#ffc107" : "#4dabf7"}
        fill={selectedElementId === conn.id ? "#ffc107" : "#4dabf7"}
        strokeWidth={thickness}
        hitStrokeWidth={12}
        onClick={(e: Konva.KonvaEventObject<MouseEvent>) => {
          // Only respond to left-click (button 0)
          if (e.evt.button !== 0) return;
          // If already selected (yellow), delete it. Otherwise select it.
          if (selectedElementId === conn.id) {
            handleDeleteConnection(conn.id);
          } else {
            onSelectElement(conn.id);
          }
        }}
        listening={!isSimulating}
      />
    );
  }

  // Panning: the Stage is always draggable; a plain left-drag on empty
  // background pans, while onDragStart cancels the drag for non-pan gestures.
  // isPanningRef tracks an in-progress pan so the follow-up click doesn't clear
  // the selection.

  return (
    <>
    <div
      ref={wrapperRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        // The frame (border + rounded corners) lives on the wrapper and clips
        // its contents, so the square canvas board never pokes past the rounded
        // corners regardless of zoom/pan. The wrapper background matches the
        // board fill (#f8f9fa) so the whole canvas session reads as one seamless
        // white surface: the board edges are invisible, so any off-center of
        // the board is imperceptible.
        border: "1px solid #dee2e6",
        borderRadius: "8px",
        overflow: "hidden",
        background: "#f8f9fa",
      }}
    >
    <Stage
      ref={stageRef}
      width={stageSize.width}
      height={stageSize.height}
      x={stagePos.x}
      y={stagePos.y}
      scaleX={stageScale}
      scaleY={stageScale}
      // The Stage is always draggable for reliable panning; onDragStart cancels
      // the drag unless it began on empty background as a pan gesture. Element
      // groups have their own draggable, so their drags don't move the Stage.
      draggable
      onDragStart={(e: Konva.KonvaEventObject<DragEvent>) => {
        if (e.target !== e.target.getStage()) return; // element group drag
        // Panning only happens when Space is held or the middle mouse button is
        // used. Otherwise a plain empty-background drag is a marquee select, so
        // cancel the stage drag. Also cancel while drawing a connection.
        const evt = e.evt as unknown as { button?: number };
        const isPanGesture = evt.button === 1; // middle mouse button
        if (!isPanGesture || isSelecting || isDrawingConnection) {
          e.target.stopDrag();
          return;
        }
        isPanningRef.current = true;
      }}
      onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) => {
        // Only the Stage itself panning updates stagePos (element/group drags
        // are handled by their own onDragEnd handlers).
        if (e.target === e.target.getStage()) {
          setStagePos({ x: e.target.x(), y: e.target.y() });
        }
      }}
      onWheel={handleWheel}
      onClick={handleStageClick}
      onTap={handleStageClick}
      onMouseMove={handleMouseMove}
      onContextMenu={(e: Konva.KonvaEventObject<PointerEvent>) => {
        e.evt.preventDefault();
        // Right-click ONLY shows context menu: never changes selection
        if (selectedIds.size > 0 || selectedElementId) {
          setContextMenu({ x: e.evt.clientX, y: e.evt.clientY });
        } else {
          // If nothing selected but right-clicking on an element, select it first
          const target = e.target;
          if (target !== target.getStage() && target.attrs.id !== "canvas-bg") {
            // Find parent group with element id
            let node: Konva.Node | null = target;
            while (node && !elementMap.has(node.attrs?.id)) {
              node = node.parent;
            }
          }
        }
      }}
      onMouseDown={(e: Konva.KonvaEventObject<MouseEvent>) => {
        // Only react to left-button presses that land on empty background.
        if (e.evt.button !== 0 || isDrawingConnection) return;
        const target = e.target;
        const onBackground = target === target.getStage() || target.attrs.id === "canvas-bg";
        if (!onBackground) return;

        const stage = stageRef.current;
        if (!stage) return;

        setContextMenu(null);

        // Plain left-drag on empty background → marquee (rectangle) multi-select
        // (the natural, expected gesture). Panning uses the middle mouse button,
        // handled by the always-on Stage drag + onDragStart gating.
        if (!isSimulating) {
          const raw = stage.getPointerPosition();
          if (raw) {
            const pos = toCanvasCoords(raw);
            setIsSelecting(true);
            setSelectionStart({ x: pos.x, y: pos.y });
            setSelectionRect({ x: pos.x, y: pos.y, width: 0, height: 0 });
          }
        }
      }}
      onMouseUp={(_e: Konva.KonvaEventObject<MouseEvent>) => {
        if (isSelecting && selectionRect && (Math.abs(selectionRect.width) > 5 || Math.abs(selectionRect.height) > 5)) {
          // Find all elements inside the selection rectangle
          const selected = new Set<string>();
          const rect = {
            x: Math.min(selectionRect.x, selectionRect.x + selectionRect.width),
            y: Math.min(selectionRect.y, selectionRect.y + selectionRect.height),
            w: Math.abs(selectionRect.width),
            h: Math.abs(selectionRect.height),
          };
          elements.forEach((el) => {
            if (el.x >= rect.x && el.x <= rect.x + rect.w && el.y >= rect.y && el.y <= rect.y + rect.h) {
              selected.add(el.id);
            }
          });
          setSelectedIds(selected);
          if (selected.size > 0) {
            didDragSelect.current = true;
          }
        }
        setIsSelecting(false);
        setSelectionRect(null);
        setSelectionStart(null);
      }}
      style={{
        cursor: isDrawingConnection
          ? "crosshair"
          : isSimulating
          ? "not-allowed"
          : "grab",
      }}
    >
      {/* Background layer: large board so panning has a floor. */}
      <Layer>
        <Rect id="canvas-bg" x={0} y={0} width={BOARD_WIDTH} height={BOARD_HEIGHT} fill="#f8f9fa" />
        {floorPlanImage && (
          <KonvaImage image={floorPlanImage} x={0} y={0} width={MIN_WIDTH} height={MIN_HEIGHT} listening={false} />
        )}
      </Layer>

      {/* Connections layer */}
      <Layer>
        {layout.connections.map(renderConnection)}
        {isDrawingConnection && drawingLinePoints.length === 4 && (
          <Line points={drawingLinePoints} stroke="#0d6efd" strokeWidth={2} dash={[8, 4]} listening={false} />
        )}
      </Layer>

      {/* Elements layer */}
      <Layer>
        {elements.map(renderElement)}
      </Layer>

      {/* Selection rectangle layer */}
      {selectionRect && (
        <Layer>
          <Rect
            x={selectionRect.x}
            y={selectionRect.y}
            width={selectionRect.width}
            height={selectionRect.height}
            fill="rgba(77, 171, 247, 0.1)"
            stroke="#4dabf7"
            strokeWidth={1}
            dash={[4, 4]}
            listening={false}
          />
        </Layer>
      )}
    </Stage>

    {/* Zoom controls overlay (bottom-right, dark steel-blue theme) */}
    <div
      style={{
        position: "absolute",
        bottom: 12,
        right: 12,
        display: "flex",
        alignItems: "center",
        gap: "6px",
        background: "#1a2a3a",
        border: "1px solid #2d5a8e",
        borderRadius: "8px",
        padding: "6px 8px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
        zIndex: 20,
        userSelect: "none",
      }}
    >
      <button
        type="button"
        title="Zoom out"
        onClick={handleZoomOut}
        style={zoomBtnStyle}
      >
        −
      </button>
      <span
        style={{
          minWidth: "48px",
          textAlign: "center",
          color: "#d4a017",
          fontSize: "0.8rem",
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {Math.round(stageScale * 100)}%
      </span>
      <button
        type="button"
        title="Zoom in"
        onClick={handleZoomIn}
        style={zoomBtnStyle}
      >
        +
      </button>
      <button
        type="button"
        title="Fit to content"
        onClick={handleFit}
        style={{ ...zoomBtnStyle, width: "auto", padding: "0 10px", fontSize: "0.78rem" }}
      >
        Fit
      </button>
    </div>
    </div>

    {/* Right-click context menu */}
    {contextMenu && selectedIds.size > 0 && (
      <div
        style={{
          position: "fixed",
          top: contextMenu.y,
          left: contextMenu.x,
          background: "#1a2a3a",
          border: "1px solid #3d4aae",
          borderRadius: "6px",
          padding: "4px 0",
          zIndex: 9999,
          boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          minWidth: "160px",
        }}
        onMouseLeave={() => setContextMenu(null)}
      >
        <button
          onClick={() => {
            selectedIds.forEach((id) => {
              const el = elementMap.get(id);
              if (!el) return;
              const newId = crypto.randomUUID();
              const offset = 40;
              if (el.element_type === "source") {
                dispatch({ type: "ADD_SOURCE", source: { ...el, id: newId, name: el.name + " copy", x: el.x + offset, y: el.y + offset } });
              } else if (el.element_type === "station") {
                dispatch({ type: "ADD_STATION", station: { ...el, id: newId, name: el.name + " copy", x: el.x + offset, y: el.y + offset } });
              } else if (el.element_type === "buffer") {
                dispatch({ type: "ADD_BUFFER", buffer: { ...el, id: newId, name: el.name + " copy", x: el.x + offset, y: el.y + offset } });
              } else if (el.element_type === "sink") {
                dispatch({ type: "ADD_SINK", sink: { ...el, id: newId, name: el.name + " copy", x: el.x + offset, y: el.y + offset } });
              }
            });
            setContextMenu(null);
          }}
          style={{ display: "block", width: "100%", padding: "7px 14px", background: "none", border: "none", color: "#e0e8f0", fontSize: "0.82rem", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(77,171,247,0.1)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
        >
          Duplicate ({selectedIds.size})
        </button>
        <button
          onClick={() => {
            selectedIds.forEach((id) => dispatch({ type: "DELETE_ELEMENT", id }));
            setSelectedIds(new Set());
            setContextMenu(null);
            onSelectElement(null);
          }}
          style={{ display: "block", width: "100%", padding: "7px 14px", background: "none", border: "none", color: "#e0e8f0", fontSize: "0.82rem", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,107,122,0.1)"; e.currentTarget.style.color = "#ff6b7a"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#e0e8f0"; }}
        >
          Delete ({selectedIds.size})
        </button>
      </div>
    )}
    </>
  );
}
