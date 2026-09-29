import type { SimulationResult, StationMetrics } from "../types";
import { useLayout } from "../context/LayoutContext";
import { getUtilizationColor } from "../utils/visualization";

export interface MetricsPanelProps {
  simulationResult: SimulationResult | null;
  onSelectStation: (id: string) => void;
}

/**
 * Sorts station metrics by utilization in descending order.
 * Exported for property-based testing.
 */
export function sortByUtilization(stations: StationMetrics[]): StationMetrics[] {
  return [...stations].sort((a, b) => b.utilization - a.utilization);
}

/**
 * MetricsPanel displays simulation results including overall throughput,
 * a ranked list of stations sorted by utilization, and average queue lengths.
 * Clicking a station row highlights and centers it on the canvas.
 */
export function MetricsPanel({ simulationResult, onSelectStation }: MetricsPanelProps) {
  const { layout } = useLayout();

  if (!simulationResult) {
    return (
      <div className="metrics-panel">
        <p>Run a simulation to see metrics</p>
      </div>
    );
  }

  const sortedStations = sortByUtilization(simulationResult.stations);

  function getStationName(stationId: string): string {
    const station = layout.stations.find((s) => s.id === stationId);
    return station ? station.name : stationId;
  }

  return (
    <div className="metrics-panel">
      <h3>Simulation Metrics</h3>

      <div className="metrics-throughput">
        <span className="metrics-label">Overall Throughput</span>
        <span className="metrics-value">
          {simulationResult.throughput.toFixed(1)} units/hr
        </span>
      </div>

      <h4>Stations by Utilization</h4>
      <div className="metrics-station-list" role="list">
        {sortedStations.map((stationMetrics) => (
          <div
            key={stationMetrics.station_id}
            className="metrics-station-row"
            role="listitem"
            onClick={() => onSelectStation(stationMetrics.station_id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectStation(stationMetrics.station_id);
              }
            }}
            tabIndex={0}
            aria-label={`${getStationName(stationMetrics.station_id)}: ${stationMetrics.utilization.toFixed(1)}% utilization, queue length ${stationMetrics.avg_queue_length.toFixed(1)}`}
          >
            <span className="metrics-station-name">
              {getStationName(stationMetrics.station_id)}
            </span>
            <span
              className="metrics-station-utilization"
              style={{ color: getUtilizationColor(stationMetrics.utilization) }}
            >
              {stationMetrics.utilization.toFixed(1)}%
            </span>
            <span className="metrics-station-queue">
              Queue: {stationMetrics.avg_queue_length.toFixed(1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
