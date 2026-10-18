/**
 * RootCauseAnalysis.test.tsx - component tests for the guided drill-down.
 *
 * Project rule: no em dashes or en dashes anywhere. Only ASCII hyphens.
 */

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect } from "vitest";
import { RootCauseAnalysis } from "./RootCauseAnalysis";
import type { LineScopeView } from "../charts/chartData";
import type { StationMetrics, LineBalanceMetrics } from "../types";

afterEach(() => cleanup());

const balance: LineBalanceMetrics = {
  balance_efficiency: 0,
  takt_time: 60,
  fastest_station_cycle: 0,
  slowest_station_cycle: 90,
  cycle_time_spread: 0,
};

function station(over: boolean): StationMetrics {
  return {
    station_id: "press",
    station_name: "Press",
    utilization: 92,
    avg_queue_length: 0,
    max_queue_length: 0,
    throughput: 0,
    avg_cycle_time: 0,
    effective_cycle_time: over ? 90 : 40,
    blocked_pct: 0,
    starved_pct: 0,
    idle_pct: 0,
    down_pct: 0,
    oee: 100,
    is_bottleneck: true,
    overstaffed: false,
    operations: [
      { name: "stamp", avg_cycle_time: 30, operators_required: 1, is_slowest: false },
      { name: "form", avg_cycle_time: 90, operators_required: 1, is_slowest: true },
    ],
  };
}

function scope(throughput: number, over: boolean): LineScopeView {
  return {
    lineId: "aggregate",
    lineName: "All",
    throughput,
    line_balance: balance,
    stations: [station(over)],
    buffers: [],
    total_operators: 2,
    labor_utilization: 80,
    target_throughput: 100,
    isSingleLine: true,
  };
}

describe("RootCauseAnalysis guided drill-down", () => {
  it("reveals one step at a time: line -> station -> operation", () => {
    render(<RootCauseAnalysis scope={scope(70, true)} targetThroughput={100} />);

    // Step 1 is visible with the verdict and the Examine button.
    expect(screen.getByText(/Step 1 of 3/i)).toBeInTheDocument();
    const examine = screen.getByRole("button", { name: /Examine Press/i });
    expect(examine).toBeInTheDocument();
    // Step 2 not yet shown.
    expect(screen.queryByText(/Step 2 of 3/i)).not.toBeInTheDocument();

    fireEvent.click(examine);
    expect(screen.getByText(/Step 2 of 3/i)).toBeInTheDocument();
    const look = screen.getByRole("button", { name: /Look at form/i });
    expect(look).toBeInTheDocument();
    expect(screen.queryByText(/Step 3 of 3/i)).not.toBeInTheDocument();

    fireEvent.click(look);
    expect(screen.getByText(/Step 3 of 3/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Root cause$/i })).toBeInTheDocument();
  });

  it("renders Step 1 for a line that meets demand without crashing", () => {
    render(<RootCauseAnalysis scope={scope(100, false)} targetThroughput={100} />);
    expect(screen.getByText(/Step 1 of 3/i)).toBeInTheDocument();
    expect(screen.getByText(/meets demand/i)).toBeInTheDocument();
  });
});