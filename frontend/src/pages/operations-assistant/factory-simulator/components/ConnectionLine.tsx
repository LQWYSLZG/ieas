/**
 * ConnectionLine: Konva Arrow component rendering a directed connection
 * between two stations on the factory floor canvas.
 *
 * Draws an arrow from the source station's output port (right side) to the
 * target station's input port (left side). Supports selection highlighting,
 * queue-length-based thickness, and deletion via double-click.
 */

import { Arrow } from "react-konva";
import type { Connection, Station } from "../types";
import { getLineThickness } from "../utils/visualization";

/** Station dimensions matching StationNode (width=120, height=80). */
const STATION_WIDTH = 120;
const STATION_HEIGHT = 80;

/** Arrow styling defaults. */
const DEFAULT_STROKE = "#4dabf7";
const SELECTED_STROKE = "#ffc107";
const POINTER_LENGTH = 10;
const POINTER_WIDTH = 8;
const DEFAULT_STROKE_WIDTH = 2;

export interface ConnectionLineProps {
  /** The connection data object. */
  connection: Connection;
  /** Source station (for computing output port position). */
  sourceStation: Station;
  /** Target station (for computing input port position). */
  targetStation: Station;
  /** Whether this connection is currently selected. */
  isSelected: boolean;
  /** When true (during simulation), interaction is disabled. */
  isDisabled: boolean;
  /** Average queue length at downstream station; varies line thickness. */
  avgQueueLength?: number;
  /** Callback invoked on click to select this connection. */
  onSelect: (id: string) => void;
  /** Callback invoked to delete this connection (double-click when selected). */
  onDelete: (id: string) => void;
}

/**
 * Renders a Konva Arrow representing a directed connection between two stations.
 * Does not render if source and target are the same station (defensive guard).
 */
export default function ConnectionLine({
  connection,
  sourceStation,
  targetStation,
  isSelected,
  isDisabled,
  avgQueueLength,
  onSelect,
  onDelete,
}: ConnectionLineProps) {
  // Defensive: prevent rendering self-connections
  if (connection.source_id === connection.target_id) {
    return null;
  }

  // Calculate output port: right side of source station, vertically centered
  const startX = sourceStation.x + STATION_WIDTH;
  const startY = sourceStation.y + STATION_HEIGHT / 2;

  // Calculate input port: left side of target station, vertically centered
  const endX = targetStation.x;
  const endY = targetStation.y + STATION_HEIGHT / 2;

  // Determine stroke width based on queue length
  const strokeWidth =
    avgQueueLength !== undefined
      ? getLineThickness(avgQueueLength)
      : DEFAULT_STROKE_WIDTH;

  // Stroke color changes when selected
  const stroke = isSelected ? SELECTED_STROKE : DEFAULT_STROKE;

  const handleClick = () => {
    if (!isDisabled) {
      onSelect(connection.id);
    }
  };

  const handleDblClick = () => {
    if (!isDisabled && isSelected) {
      onDelete(connection.id);
    }
  };

  return (
    <Arrow
      points={[startX, startY, endX, endY]}
      pointerLength={POINTER_LENGTH}
      pointerWidth={POINTER_WIDTH}
      stroke={stroke}
      fill={stroke}
      strokeWidth={strokeWidth}
      hitStrokeWidth={Math.max(strokeWidth, 10)}
      listening={!isDisabled}
      onClick={handleClick}
      onTap={handleClick}
      onDblClick={handleDblClick}
      onDblTap={handleDblClick}
    />
  );
}
