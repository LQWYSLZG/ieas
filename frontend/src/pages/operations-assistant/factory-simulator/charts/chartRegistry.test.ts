/**
 * chartRegistry.test.ts - unit test for the chart-count bounds.
 *
 * The registry is the single source of truth that enforces the chart-count
 * bounds. This test pins those bounds: the Results chart set must hold exactly
 * 4 charts (Req 6.1, 6.7) and the Recommendations chart set must hold exactly
 * 3 charts (Req 7.1, 7.7). It also checks the stable ids and that ids are
 * unique within each set, so the bound cannot be satisfied by padding with
 * duplicate entries.
 *
 * Project rule: no em dashes or en dashes anywhere in this file. Only ASCII
 * hyphens are used.
 */

import { describe, it, expect } from "vitest";
import {
  RESULTS_CHARTS,
  RECOMMENDATIONS_CHARTS,
  RESULTS_CHART_COUNT,
  RECOMMENDATIONS_CHART_COUNT,
} from "./chartRegistry";

describe("chartRegistry bounds", () => {
  it("Results chart set has exactly 4 entries", () => {
    expect(RESULTS_CHARTS).toHaveLength(4);
    expect(RESULTS_CHARTS).toHaveLength(RESULTS_CHART_COUNT);
  });

  it("Recommendations chart set has exactly 3 entries", () => {
    expect(RECOMMENDATIONS_CHARTS).toHaveLength(3);
    expect(RECOMMENDATIONS_CHARTS).toHaveLength(RECOMMENDATIONS_CHART_COUNT);
  });

  it("Results chart ids are the four stable planned ids and are unique", () => {
    const ids = RESULTS_CHARTS.map((chart) => chart.id);
    expect(ids).toEqual([
      "time_split",
      "throughput_comparison",
      "labor",
      "scrap_setup",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Recommendations chart ids are the three stable planned ids and are unique", () => {
    const ids = RECOMMENDATIONS_CHARTS.map((chart) => chart.id);
    expect(ids).toEqual([
      "recommendation_gain",
      "problem_label",
      "projected_before_after",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every descriptor carries a matching key and a non-empty title", () => {
    for (const chart of [...RESULTS_CHARTS, ...RECOMMENDATIONS_CHARTS]) {
      expect(chart.key).toBe(chart.id);
      expect(chart.title.trim().length).toBeGreaterThan(0);
    }
  });
});
