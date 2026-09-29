import { useState } from "react";
import { Group, Rect, Text, Circle, Label, Tag } from "react-konva";
import type { Station } from "../types";
import { getUtilizationColor } from "../utils/visualization";

export interface StationNodeProps {
  /** The station data to render */
  station: Station;
  /** Whether this station is currently selected */
  isSelected: boolean;
  /** When true (simulating), disable drag interactions */
  isDisabled: boolean;
  /** If present, color-code the station and show utilization label */
  utilization?: number;
  /** Average queue length for tooltip display */
  avgQueueLength?: number;
  /** Called when user clicks the station */
  onSelect: (id: string) => void;
  /** Called when user finishes dragging the station */
  onDragEnd: (id: string, x: number, y: number) => void;
  /** Called when user starts dragging from the output port */
  onStartConnection: (stationId: string) => void;
}

/** Dimensions for the station rectangle body */
const STATION_WIDTH = 120;
const STATION_HEIGHT = 80;

/** Port indicator radius */
const PORT_RADIUS = 6;

/** Default fill color when no utilization data is available */
const DEFAULT_FILL = "#e9ecef";

/** Selected border stroke color */
const SELECTED_STROKE = "#0d6efd";

/** Default border stroke color */
const DEFAULT_STROKE = "#6c757d";

/**
 * StationNode renders a single station on the Konva canvas.
 * It displays as a rectangle with the station name, input/output port indicators,
 * utilization color-coding when simulation data is available, and a tooltip on hover.
 */
export function StationNode({
  station,
  isSelected,
  isDisabled,
  utilization,
  avgQueueLength,
  onSelect,
  onDragEnd,
  onStartConnection,
}: StationNodeProps) {
  const [isHovered, setIsHovered] = useState(false);

  const hasUtilization = utilization !== undefined;
  const fillColor = hasUtilization ? getUtilizationColor(utilization) : DEFAULT_FILL;
  const strokeColor = isSelected ? SELECTED_STROKE : DEFAULT_STROKE;
  const strokeWidth = isSelected ? 3 : 1.5;

  function handleClick() {
    onSelect(station.id);
  }

  function handleDragEnd(e: any) {
    const x = e.target.x();
    const y = e.target.y();
    onDragEnd(station.id, x, y);
  }

  function handleOutputPortMouseDown(e: any) {
    e.cancelBubble = true;
    onStartConnection(station.id);
  }

  function handleMouseEnter() {
    setIsHovered(true);
  }

  function handleMouseLeave() {
    setIsHovered(false);
  }

  return (
    <Group
      x={station.x}
      y={station.y}
      draggable={!isDisabled}
      onClick={handleClick}
      onTap={handleClick}
      onDragEnd={handleDragEnd}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Station body rectangle */}
      <Rect
        width={STATION_WIDTH}
        height={STATION_HEIGHT}
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        cornerRadius={4}
        shadowColor="rgba(0,0,0,0.1)"
        shadowBlur={4}
        shadowOffsetY={2}
      />

      {/* Station name label */}
      <Text
        text={station.name}
        width={STATION_WIDTH}
        height={hasUtilization ? STATION_HEIGHT * 0.5 : STATION_HEIGHT}
        y={hasUtilization ? 8 : 0}
        align="center"
        verticalAlign={hasUtilization ? "top" : "middle"}
        fontSize={13}
        fontFamily="sans-serif"
        fill="#212529"
        ellipsis={true}
        wrap="none"
        padding={8}
      />

      {/* Utilization percentage label (shown when data available) */}
      {hasUtilization && (
        <Text
          text={`${Math.round(utilization)}%`}
          width={STATION_WIDTH}
          y={STATION_HEIGHT * 0.55}
          align="center"
          fontSize={14}
          fontStyle="bold"
          fontFamily="sans-serif"
          fill="#212529"
        />
      )}

      {/* Input port indicator (left side) */}
      <Circle
        x={0}
        y={STATION_HEIGHT / 2}
        radius={PORT_RADIUS}
        fill="#6c757d"
        stroke="#495057"
        strokeWidth={1}
      />

      {/* Output port indicator (right side) */}
      <Circle
        x={STATION_WIDTH}
        y={STATION_HEIGHT / 2}
        radius={PORT_RADIUS}
        fill="#0d6efd"
        stroke="#0a58ca"
        strokeWidth={1}
        onMouseDown={handleOutputPortMouseDown}
        onTouchStart={handleOutputPortMouseDown}
      />

      {/* Tooltip shown on hover when simulation data available */}
      {isHovered && hasUtilization && (
        <Label x={STATION_WIDTH / 2} y={-10} offsetX={60}>
          <Tag
            fill="rgba(33, 37, 41, 0.92)"
            cornerRadius={4}
            pointerDirection="down"
            pointerWidth={8}
            pointerHeight={6}
          />
          <Text
            text={[
              `Utilization: ${Math.round(utilization)}%`,
              avgQueueLength !== undefined
                ? `Avg Queue: ${avgQueueLength.toFixed(1)}`
                : null,
              `Cycle Time: ${station.cycle_time}s`,
            ]
              .filter(Boolean)
              .join("\n")}
            fontSize={11}
            fontFamily="sans-serif"
            fill="#ffffff"
            padding={6}
          />
        </Label>
      )}
    </Group>
  );
}
