/**
 * Visualization utility functions for the Factory Floor Simulator.
 *
 * Provides helpers for mapping simulation metrics to visual properties
 * (colors, line thickness, etc.) on the Konva canvas.
 */

/**
 * Maps a utilization percentage (0-100) to a color code.
 * - Green (#28a745) for utilization ≤ 60%
 * - Yellow (#ffc107) for utilization in (60, 85)
 * - Red (#dc3545) for utilization ≥ 85% (at or above 85 marks a bottleneck)
 */
export function getUtilizationColor(utilization: number): string {
  if (utilization <= 60) return "#28a745";
  if (utilization < 85) return "#ffc107";
  return "#dc3545";
}

/**
 * Maps an average queue length to a connection line thickness.
 *
 * Returns a value between MIN_THICKNESS (2) and MAX_THICKNESS (12),
 * proportional to the queue length. A queue length of 0 yields the
 * minimum thickness; a queue length of MAX_QUEUE (10) or above yields
 * the maximum thickness.
 */
export function getLineThickness(avgQueueLength: number): number {
  const MIN_THICKNESS = 2;
  const MAX_THICKNESS = 12;
  const MAX_QUEUE = 10;

  if (avgQueueLength <= 0) return MIN_THICKNESS;
  if (avgQueueLength >= MAX_QUEUE) return MAX_THICKNESS;

  return (
    MIN_THICKNESS +
    (avgQueueLength / MAX_QUEUE) * (MAX_THICKNESS - MIN_THICKNESS)
  );
}
