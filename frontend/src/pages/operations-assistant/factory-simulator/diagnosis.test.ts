/**
 * diagnosis.test.ts - unit tests for the pure diagnosis helpers.
 *
 * Project rule: no em dashes or en dashes anywhere. Only ASCII hyphens.
 */

import { describe, it, expect } from "vitest";
import type { StationMetrics, OperationMetrics } from "./types";
import { selectConstraintStation, slowestOperation } from "./diagnosis";

function makeOp(name: string, avg: number, isSlowest = false, ops = 0): OperationMetrics {
  return { name, avg_cycle_time: avg, operators_required: ops, is_slowest: isSlowest };
}

function makeStation(
  id: string,
  utilization: number,
  isBottleneck = false,
  operations: OperationMetrics[] = []
): StationMetrics {
  return {
    station_id: id,
    station_name: id,
    utilization,
    avg_queue_length: 0,
    max_queue_length: 0,
    throughput: 0,
    avg_cycle_time: 0,
    effective_cycle_time: 0,
    blocked_pct: 0,
    starved_pct: 0,
    idle_pct: 0,
    down_pct: 0,
    oee: 100,
    is_bottleneck: isBottleneck,
    overstaffed: false,
    operations,
  };
}

describe("selectConstraintStation", () => {
  it("returns null for an empty list", () => {
    expect(selectConstraintStation([])).toBeNull();
  });

  it("prefers the bottleneck-flagged station over higher utilization", () => {
    const a = makeStation("A", 95, false);
    const b = makeStation("B", 50, true);
    expect(selectConstraintStation([a, b])?.station_id).toBe("B");
  });

  it("falls back to the highest-utilization station when none is flagged", () => {
    const a = makeStation("A", 40);
    const b = makeStation("B", 88);
    const c = makeStation("C", 61);
    expect(selectConstraintStation([a, b, c])?.station_id).toBe("B");
  });
});

describe("slowestOperation", () => {
  it("returns null when the station has no operations", () => {
    expect(slowestOperation(makeStation("A", 50))).toBeNull();
  });

  it("prefers the is_slowest-flagged operation", () => {
    const s = makeStation("A", 50, false, [
      makeOp("drill", 30, false),
      makeOp("weld", 10, true),
    ]);
    expect(slowestOperation(s)?.name).toBe("weld");
  });

  it("falls back to the max avg_cycle_time when none is flagged", () => {
    const s = makeStation("A", 50, false, [
      makeOp("drill", 30, false),
      makeOp("press", 55, false),
      makeOp("weld", 10, false),
    ]);
    expect(slowestOperation(s)?.name).toBe("press");
  });
});