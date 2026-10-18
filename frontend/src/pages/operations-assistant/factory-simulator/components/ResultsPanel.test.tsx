/**
 * ResultsPanel.test.tsx - compact selector parity (task 12.2).
 *
 * ResultsPanel's private effectiveTarget and effectiveTakt helpers now delegate
 * to the shared effectiveTargetFor and effectiveTaktFor selectors in
 * charts/chartData.ts, so the compact panel and the expanded charts judge each
 * scope against one identical definition (Req 8.5).
 *
 * These tests render the compact panel and assert the effective target and
 * takt it actually displays per scope match exactly what the shared selectors
 * return for that scope (built from scopesOf). Covering a single-line result
 * (one aggregate scope, takt falling back to the balance takt) and a multi-line
 * result (one scope per line, with one line carrying its own target and takt
 * and the other falling back to the balance takt) exercises both the own-value
 * and fallback branches of the selectors.
 *
 * Project rule: no em dashes or en dashes anywhere, only ASCII hyphens.
 */

import { render, screen, within, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect } from "vitest";
import { ResultsPanel } from "./ResultsPanel";
import {
  scopesOf,
  effectiveTargetFor,
  effectiveTaktFor,
} from "../charts/chartData";
import type {
  SimulationResult,
  PerLineResult,
  LineBalanceMetrics,
  StationMetrics,
} from "../types";

afterEach(() => {
  cleanup();
});

const makeLineBalance = (takt: number | null): LineBalanceMetrics => ({
  balance_efficiency: 0,
  takt_time: takt,
  fastest_station_cycle: 0,
  slowest_station_cycle: 0,
  cycle_time_spread: 0,
});

const makeStation = (id: string, name: string): StationMetrics => ({
  station_id: id,
  station_name: name,
  utilization: 0,
  avg_queue_length: 0,
  max_queue_length: 0,
  throughput: 1,
  avg_cycle_time: 0,
  effective_cycle_time: 0,
  blocked_pct: 0,
  starved_pct: 0,
  idle_pct: 0,
  down_pct: 0,
  oee: 100,
  is_bottleneck: false,
  overstaffed: false,
  operations: [],
});

const baseResult = (): SimulationResult => ({
  throughput: 100,
  avg_lead_time: 0,
  wip_total: 0,
  value_added_ratio: 0,
  total_operators: 0,
  labor_utilization: 0,
  stations: [makeStation("s0", "Station 0")],
  buffers: [],
  operators: [],
  transport: {
    total_transport_time: 0,
    total_value_added_time: 0,
    transport_waste_pct: 0,
    total_distance: 0,
  },
  line_balance: makeLineBalance(null),
  recommendations: [],
  simulation_duration: 0,
  target_throughput: null,
  throughput_gap_pct: null,
});

/**
 * The compact capacity snapshot renders the effective target as
 * "{target.toFixed(0)} /hr" on the "Demand needs" row and the effective takt as
 * "{takt?.toFixed(0) ?? '-'}s" on the "Takt (pace target)" row. Given a
 * container scoped to one line section, read back the displayed effective
 * target and takt text so it can be compared to the shared selectors.
 */
function readShownTargetAndTakt(scope: HTMLElement): { target: string; takt: string } {
  // Each metric row is <div><span label>Label <HelpIcon/></span><span value>...</span></div>.
  // HelpIcon renders a nested <span>?</span> inside the label span, so a CSS
  // :last-child selector would match that inner "?" span instead of the value.
  // Read the row div's own last direct-child element to get the value span.
  const readValue = (row: HTMLElement): string => {
    const kids = row.children;
    return kids[kids.length - 1]?.textContent ?? "";
  };
  const targetRow = within(scope).getByText(/Demand needs/).closest("div")!;
  const targetValue = readValue(targetRow as HTMLElement);
  const taktRow = within(scope).getByText(/Takt \(pace target\)/).closest("div")!;
  const taktValue = readValue(taktRow as HTMLElement);
  return { target: targetValue.trim(), takt: taktValue.trim() };
}

describe("ResultsPanel compact selector parity (task 12.2, Req 8.5)", () => {
  it("single-line: shown target and takt match the shared selectors", () => {
    // One aggregate scope. The scope carries no own takt, so the effective takt
    // must fall back to line_balance.takt_time (45). target_throughput is unset
    // on the result, so the effective target must be the global target prop.
    const result = baseResult();
    result.line_balance = makeLineBalance(45);
    const targetProp = 120;

    const scopes = scopesOf(result);
    expect(scopes).toHaveLength(1);
    const expectedTarget = effectiveTargetFor(scopes[0], targetProp);
    const expectedTakt = effectiveTaktFor(scopes[0]);

    expect(expectedTarget).toBe(120);
    expect(expectedTakt).toBe(45);

    const { container } = render(
      <ResultsPanel
        result={result}
        targetThroughput={targetProp}
        onViewRecommendations={() => {}}
      />
    );

    const shown = readShownTargetAndTakt(container as unknown as HTMLElement);
    expect(shown.target).toBe(`${expectedTarget.toFixed(0)} /hr`);
    expect(shown.takt).toBe(`${expectedTakt!.toFixed(0)}s`);
  });

  it("multi-line: each line's shown target and takt match the shared selectors", () => {
    // Line A carries its own target (200) and its own takt (30). Line B carries
    // no own target (falls back to the global target prop) and no own takt
    // (falls back to its balance takt of 60). This exercises both the own-value
    // and fallback branches of both selectors.
    const lineA: PerLineResult = {
      line_id: "line-a",
      line_name: "Line A",
      throughput: 180,
      avg_lead_time: 0,
      wip_total: 0,
      value_added_ratio: 0,
      total_operators: 0,
      labor_utilization: 0,
      stations: [makeStation("a-s0", "A Station 0")],
      buffers: [],
      line_balance: makeLineBalance(99),
      recommendations: [],
      target_throughput: 200,
      takt_time: 30,
      throughput_gap_pct: 0,
    };
    const lineB: PerLineResult = {
      line_id: "line-b",
      line_name: "Line B",
      throughput: 90,
      avg_lead_time: 0,
      wip_total: 0,
      value_added_ratio: 0,
      total_operators: 0,
      labor_utilization: 0,
      stations: [makeStation("b-s0", "B Station 0")],
      buffers: [],
      line_balance: makeLineBalance(60),
      recommendations: [],
      target_throughput: null,
      takt_time: null,
      throughput_gap_pct: 0,
    };

    const result = baseResult();
    result.lines = [lineA, lineB];
    const targetProp = 150;

    const scopes = scopesOf(result);
    expect(scopes).toHaveLength(2);

    // Line A: own target and own takt win.
    expect(effectiveTargetFor(scopes[0], targetProp)).toBe(200);
    expect(effectiveTaktFor(scopes[0])).toBe(30);
    // Line B: falls back to the global target and the balance takt.
    expect(effectiveTargetFor(scopes[1], targetProp)).toBe(150);
    expect(effectiveTaktFor(scopes[1])).toBe(60);

    render(
      <ResultsPanel
        result={result}
        targetThroughput={targetProp}
        onViewRecommendations={() => {}}
      />
    );

    // Each line renders inside its own <details> section keyed by line name.
    const sectionA = screen.getByText("Line A").closest("details") as HTMLElement;
    const sectionB = screen.getByText("Line B").closest("details") as HTMLElement;

    const shownA = readShownTargetAndTakt(sectionA);
    expect(shownA.target).toBe(`${effectiveTargetFor(scopes[0], targetProp).toFixed(0)} /hr`);
    expect(shownA.takt).toBe(`${effectiveTaktFor(scopes[0])!.toFixed(0)}s`);

    const shownB = readShownTargetAndTakt(sectionB);
    expect(shownB.target).toBe(`${effectiveTargetFor(scopes[1], targetProp).toFixed(0)} /hr`);
    expect(shownB.takt).toBe(`${effectiveTaktFor(scopes[1])!.toFixed(0)}s`);
  });
});
