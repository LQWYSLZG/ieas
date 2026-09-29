import type { Scenario } from "../types";
import { useLayout } from "../context/LayoutContext";

export interface ComparisonViewProps {
  scenarioA: Scenario | null;
  scenarioB: Scenario | null;
}

/** Green: improvement. */
const DELTA_COLOR_IMPROVEMENT = "#28a745";
/** Red: degradation. */
const DELTA_COLOR_DEGRADATION = "#dc3545";
/** Neutral: no change (zero delta). */
const DELTA_COLOR_NEUTRAL = "#212529";

/**
 * Returns the CSS color for a metric delta.
 *
 * The zero case is handled first and always maps to a neutral color, so a
 * delta of exactly zero is never shown as green or red (Req 8.5).
 *
 * By default, a positive delta is treated as an improvement (green) and a
 * negative delta as a degradation (red), correct for Throughput and
 * Utilization deltas (Req 8.3).
 *
 * When `invert` is true, the mapping is reversed so that a decrease (negative
 * delta) is green and an increase (positive delta) is red. This is used for
 * Queue_Length, where a shorter queue is the improvement (Req 8.6).
 *
 * Exported for property-based testing.
 */
export function deltaColor(delta: number, invert = false): string {
  if (delta === 0) return DELTA_COLOR_NEUTRAL;

  const isImprovement = invert ? delta < 0 : delta > 0;
  return isImprovement ? DELTA_COLOR_IMPROVEMENT : DELTA_COLOR_DEGRADATION;
}

/**
 * ComparisonView displays two scenarios side by side, showing throughput,
 * per-station utilization, and per-station queue length differences with
 * color-coded deltas indicating improvement or degradation.
 */
export function ComparisonView({ scenarioA, scenarioB }: ComparisonViewProps) {
  const { layout } = useLayout();

  if (!scenarioA || !scenarioB) {
    return (
      <div className="comparison-view">
        <p>Select two scenarios to compare</p>
      </div>
    );
  }

  const resultA = scenarioA.result;
  const resultB = scenarioB.result;

  const throughputDelta = resultB.throughput - resultA.throughput;

  function getStationName(stationId: string): string {
    const station = layout.stations.find((s) => s.id === stationId);
    return station ? station.name : stationId;
  }

  // Build a combined list of station IDs from both scenarios
  const stationIds = Array.from(
    new Set([
      ...resultA.stations.map((s) => s.station_id),
      ...resultB.stations.map((s) => s.station_id),
    ])
  );

  return (
    <div className="comparison-view">
      <h3>Scenario Comparison</h3>

      <div className="comparison-throughput">
        <span className="comparison-label">Throughput</span>
        <span className="comparison-value-a">
          {resultA.throughput.toFixed(1)} units/hr
        </span>
        <span className="comparison-value-b">
          {resultB.throughput.toFixed(1)} units/hr
        </span>
        <span
          className="comparison-delta"
          style={{ color: deltaColor(throughputDelta) }}
        >
          {throughputDelta >= 0 ? "+" : ""}
          {throughputDelta.toFixed(1)}
        </span>
      </div>

      <h4>Per-Station Utilization</h4>
      <div className="comparison-station-list" role="list">
        {stationIds.map((stationId) => {
          const metricsA = resultA.stations.find(
            (s) => s.station_id === stationId
          );
          const metricsB = resultB.stations.find(
            (s) => s.station_id === stationId
          );

          const utilizationA = metricsA?.utilization ?? 0;
          const utilizationB = metricsB?.utilization ?? 0;
          const utilizationDelta = utilizationB - utilizationA;

          return (
            <div
              key={`util-${stationId}`}
              className="comparison-station-row"
              role="listitem"
            >
              <span className="comparison-station-name">
                {getStationName(stationId)}
              </span>
              <span className="comparison-value-a">
                {utilizationA.toFixed(1)}%
              </span>
              <span className="comparison-value-b">
                {utilizationB.toFixed(1)}%
              </span>
              <span
                className="comparison-delta"
                style={{
                  color: deltaColor(utilizationDelta),
                }}
              >
                {utilizationDelta >= 0 ? "+" : ""}
                {utilizationDelta.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>

      <h4>Per-Station Queue Length</h4>
      <div className="comparison-queue-list" role="list">
        {stationIds.map((stationId) => {
          const metricsA = resultA.stations.find(
            (s) => s.station_id === stationId
          );
          const metricsB = resultB.stations.find(
            (s) => s.station_id === stationId
          );

          const queueA = metricsA?.avg_queue_length ?? 0;
          const queueB = metricsB?.avg_queue_length ?? 0;
          const queueDelta = queueB - queueA;

          return (
            <div
              key={`queue-${stationId}`}
              className="comparison-station-row"
              role="listitem"
            >
              <span className="comparison-station-name">
                {getStationName(stationId)}
              </span>
              <span className="comparison-value-a">{queueA.toFixed(1)}</span>
              <span className="comparison-value-b">{queueB.toFixed(1)}</span>
              <span
                className="comparison-delta"
                style={{ color: deltaColor(queueDelta, /* invert */ true) }}
              >
                {queueDelta >= 0 ? "+" : ""}
                {queueDelta.toFixed(1)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
