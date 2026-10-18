/**
 * diagnosis.ts - pure station and operation diagnosis helpers.
 *
 * Single source of truth for how a station is classified, why it is the
 * bottleneck, which station is the line constraint, and which operation is the
 * slowest. Both the compact ResultsPanel and the guided Root Cause Analysis
 * flow import from here so they always agree. No React, no side effects.
 *
 * Project rule: no em dashes or en dashes anywhere. Only ASCII hyphens.
 */

import type { StationMetrics, OperationMetrics } from "./types";

export type StationProblem = {
  tag: string;
  color: string;
  explain: string;
};

/**
 * Classify a station's primary problem from the time split the engine reports,
 * in plain language a shop owner can act on. Priority order matters: a station
 * that is over takt is the true constraint; otherwise down/blocked/starved point
 * to the real cause of lost time.
 */
export function diagnoseStation(sm: StationMetrics, taktTime: number | null): StationProblem {
  // Over takt: the station simply can't keep pace with demand, the real bottleneck.
  if (taktTime && sm.effective_cycle_time > taktTime + 0.5) {
    return {
      tag: "Over takt",
      color: "#dc3545",
      explain: `Takes ${sm.effective_cycle_time.toFixed(0)}s per unit but only ${taktTime.toFixed(0)}s is allowed. This station sets the pace of the whole line.`,
    };
  }
  if (sm.down_pct >= 10) {
    return {
      tag: "Machine down",
      color: "#c0392b",
      explain: `The machine is down ${sm.down_pct.toFixed(0)}% of the time for breakdowns or repair. Preventive maintenance or a backup machine would recover this lost time.`,
    };
  }
  if (sm.blocked_pct >= 15) {
    return {
      tag: "Blocked",
      color: "#e07b39",
      explain: `Finished units can't move on ${sm.blocked_pct.toFixed(0)}% of the time. The next station or buffer is full, so fix what's downstream.`,
    };
  }
  if (sm.starved_pct >= 15) {
    return {
      tag: "Starved",
      color: "#ffc107",
      explain: `Waiting for parts ${sm.starved_pct.toFixed(0)}% of the time. An upstream step can't feed it fast enough.`,
    };
  }
  if (sm.overstaffed && sm.utilization < 50) {
    return {
      tag: "Overstaffed",
      color: "#9b59b6",
      explain: `Busy only ${sm.utilization.toFixed(0)}% of the time with operators assigned. Consider moving people to a busier station.`,
    };
  }
  if (sm.utilization >= 85) {
    return {
      tag: "At capacity",
      color: "#dc3545",
      explain: `Running ${sm.utilization.toFixed(0)}% of the time with very little slack. Any hiccup here will slow the line.`,
    };
  }
  return {
    tag: "Healthy",
    color: "#28a745",
    explain: `Running ${sm.utilization.toFixed(0)}% of the time with room to spare.`,
  };
}

/**
 * Plain explanation of WHY a station is the bottleneck, so the owner
 * understands the mark instead of just seeing it.
 */
export function bottleneckReason(sm: StationMetrics, taktTime: number | null): string {
  if (taktTime && sm.effective_cycle_time > taktTime + 0.5) {
    return `It is the slowest step on the line: ${sm.effective_cycle_time.toFixed(0)}s per unit against a ${taktTime.toFixed(0)}s target, so it sets the pace everything else waits on.`;
  }
  if (sm.down_pct >= 10) {
    return `Machine downtime here (${sm.down_pct.toFixed(0)}% of the time) drops its real output below the other stations, making it the constraint.`;
  }
  if (sm.blocked_pct >= 15) {
    return `It is busy the most but loses ${sm.blocked_pct.toFixed(0)}% of its time blocked, so it cannot pass work along fast enough.`;
  }
  return `It runs the highest share of the time (${sm.utilization.toFixed(0)}%), so it has the least spare capacity and limits the whole line.`;
}

/**
 * The single line constraint: the engine's bottleneck-flagged station when
 * present, else the highest-utilization station. Returns null for an empty
 * station list. This matches the selection the compact panel uses.
 */
export function selectConstraintStation(stations: StationMetrics[]): StationMetrics | null {
  if (stations.length === 0) {
    return null;
  }
  const flagged = stations.find((s) => s.is_bottleneck);
  if (flagged) {
    return flagged;
  }
  const sortedByUtil = stations.slice().sort((a, b) => b.utilization - a.utilization);
  return sortedByUtil[0] ?? null;
}

/**
 * The slowest operation on a station: the one flagged is_slowest when present,
 * else the operation with the greatest avg_cycle_time, else null when the
 * station has no operations.
 */
export function slowestOperation(station: StationMetrics): OperationMetrics | null {
  const ops = station.operations ?? [];
  if (ops.length === 0) {
    return null;
  }
  const flagged = ops.find((o) => o.is_slowest);
  if (flagged) {
    return flagged;
  }
  let slowest = ops[0];
  for (const op of ops) {
    if (op.avg_cycle_time > slowest.avg_cycle_time) {
      slowest = op;
    }
  }
  return slowest;
}