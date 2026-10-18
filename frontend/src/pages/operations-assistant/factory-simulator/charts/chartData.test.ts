/**
 * chartData.test.ts - property-based tests for the pure chart-data mappers.
 *
 * These tests pin the mapper numeric behavior with fast-check, running many
 * generated inputs per property so the invariants hold across the input space
 * rather than only for a few hand-picked examples.
 *
 * Project rule: no em dashes or en dashes anywhere in this file. Only ASCII
 * hyphens are used.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type {
  StationMetrics,
  LineBalanceMetrics,
  Recommendation,
  SimulationResult,
  PerLineResult,
  LineTimeShare,
} from "../types";
import {
  timeSplitSeries,
  throughputComparisonSeries,
  effectiveTargetFor,
  effectiveTaktFor,
  laborSeries,
  scrapSetupSeries,
  recommendationGainSeries,
  problemLabelInfo,
  projectedBeforeAfter,
  scopesOf,
  sharedStationSplit,
  attributeStationSeries,
  toTextAlternativeRows,
} from "./chartData";
import type { ChartData, ChartSeries, LineScopeView } from "./chartData";

/**
 * Generate a complete, valid StationMetrics. The four time-split fields
 * (utilization, starved_pct, blocked_pct, down_pct) are the mutually exclusive
 * time shares a real station reports: each is non-negative and the four
 * together never exceed 100, which is the valid input space the engine
 * produces (idle is whatever time is left over). The generator draws four
 * non-negative weights and scales them so their total lands anywhere in
 * 0..100, covering the full range from an idle-heavy station (small total, so
 * idle is large) to a fully accounted station (total near 100, so idle is near
 * 0). The remaining fields carry fixed, valid values since timeSplitSeries does
 * not read them.
 */
const arbStationMetrics: fc.Arbitrary<StationMetrics> = fc
  .record({
    weights: fc.tuple(
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
    ),
    total: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ weights, total }) => {
    const [w0, w1, w2, w3] = weights;
    const weightSum = w0 + w1 + w2 + w3;
    // Scale the four weights so they sum to `total` (which is at most 100).
    // When every weight is 0, leave all four shares at 0 (a fully idle
    // station), which is still a valid input.
    const scale = weightSum > 0 ? total / weightSum : 0;
    // Guard against a non-finite scaled share: when weightSum is extremely
    // small relative to total, the product can overflow to Infinity or NaN.
    // Clamp any such value to 0 so every required share stays finite, keeping
    // this a valid "all fields present" station and removing a latent source
    // of flakiness in the generator.
    const finiteOrZero = (v: number): number => (Number.isFinite(v) ? v : 0);
    return {
      utilization: finiteOrZero(w0 * scale),
      starved_pct: finiteOrZero(w1 * scale),
      blocked_pct: finiteOrZero(w2 * scale),
      down_pct: finiteOrZero(w3 * scale),
    };
  })
  .map((split) => ({
    station_id: "s1",
    station_name: "Station 1",
    utilization: split.utilization,
    avg_queue_length: 0,
    max_queue_length: 0,
    throughput: 0,
    avg_cycle_time: 0,
    effective_cycle_time: 0,
    blocked_pct: split.blocked_pct,
    starved_pct: split.starved_pct,
    idle_pct: 0,
    down_pct: split.down_pct,
    oee: 100,
    is_bottleneck: false,
    overstaffed: false,
    operations: [],
  }));

/**
 * Feature: results-visualization-expand, Property 1: Time split covers the
 * whole station.
 *
 * For any StationMetrics, the five time categories busy, starved, blocked,
 * down, and idle produced by timeSplitSeries are each in the range 0 to 100 and
 * sum to 100 within a tolerance of 0.1, where idle is the non-negative
 * remainder after busy, starved, blocked, and down.
 *
 * Validates: Requirements 6.2
 */
describe("Feature: results-visualization-expand, Property 1: Time split covers the whole station", () => {
  it("produces five categories each in 0..100 that sum to 100 within 0.1", () => {
    fc.assert(
      fc.property(arbStationMetrics, (station) => {
        const result: ChartData = timeSplitSeries(station);

        // With all four required fields present and finite, the mapper is ok.
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;

        const points = result.series[0].points;
        const categories = points.map((p) => p.category);
        expect(categories).toEqual(["busy", "starved", "blocked", "down", "idle"]);

        let sum = 0;
        for (const p of points) {
          expect(p.value).toBeGreaterThanOrEqual(0);
          expect(p.value).toBeLessThanOrEqual(100);
          sum += p.value;
        }

        expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.1);
      }),
      { numRuns: 200 }
    );
  });
});

/**
 * Generate a LineScopeView for the throughput comparison. The three inputs the
 * comparison reads are the scope throughput, the slowest station cycle (which
 * drives the line ceiling), and the effective target passed in by the caller.
 *
 * throughput is drawn across a wide non-negative range. slowest_station_cycle
 * is drawn to include 0 explicitly (the ceiling edge, where the line ceiling
 * must read 0) as well as a spread of positive cycle times. target_throughput
 * is drawn as either a set per-scope target or null (so the shared selector
 * falls back to the global target). The remaining LineScopeView fields carry
 * fixed valid values since throughputComparisonSeries does not read them.
 */
const arbScope: fc.Arbitrary<LineScopeView> = fc
  .record({
    throughput: fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true }),
    // Include 0 for the ceiling edge, plus a spread of positive cycle times.
    slowest: fc.oneof(
      fc.constant(0),
      fc.double({ min: 0.0001, max: 600, noNaN: true, noDefaultInfinity: true })
    ),
    target_throughput: fc.oneof(
      fc.constant(null),
      fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true })
    ),
  })
  .map(({ throughput, slowest, target_throughput }) => {
    const line_balance: LineBalanceMetrics = {
      balance_efficiency: 0,
      takt_time: null,
      fastest_station_cycle: 0,
      slowest_station_cycle: slowest,
      cycle_time_spread: 0,
    };
    const scope: LineScopeView = {
      lineId: "aggregate",
      lineName: "All",
      throughput,
      line_balance,
      stations: [],
      buffers: [],
      total_operators: 0,
      labor_utilization: 0,
      target_throughput,
      isSingleLine: true,
    };
    return scope;
  });

/**
 * Feature: results-visualization-expand, Property 2: Throughput comparison is
 * non-negative and uses the ceiling formula.
 *
 * For any scope, throughputComparisonSeries produces exactly three non-negative
 * values (producing now, demand needed, line ceiling), where line ceiling
 * equals 3600 / slowest_station_cycle when the slowest cycle is positive and
 * equals 0 otherwise, and demand needed equals the effective target returned by
 * the shared selector.
 *
 * Validates: Requirements 6.3, 8.5
 */
describe("Feature: results-visualization-expand, Property 2: Throughput comparison is non-negative and uses the ceiling formula", () => {
  it("produces three non-negative values using the ceiling and demand formulas", () => {
    fc.assert(
      fc.property(
        arbScope,
        fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true }),
        (scope, fallback) => {
          // The effective target the shared selector returns for this scope.
          const effectiveTarget = effectiveTargetFor(scope, fallback);
          const result: ChartData = throughputComparisonSeries(scope, effectiveTarget);

          // All required fields are present and finite, so the mapper is ok.
          expect(result.kind).toBe("ok");
          if (result.kind !== "ok") return;

          const points = result.series[0].points;

          // Exactly three values, in order, each non-negative.
          const categories = points.map((p) => p.category);
          expect(categories).toEqual(["producing now", "demand needed", "line ceiling"]);
          for (const p of points) {
            expect(p.value).toBeGreaterThanOrEqual(0);
          }

          const [producingNow, demandNeeded, lineCeiling] = points.map((p) => p.value);

          // Producing now = scope throughput (already non-negative).
          expect(producingNow).toBe(scope.throughput);

          // Demand needed = the effective target from the shared selector.
          expect(demandNeeded).toBe(effectiveTarget);

          // Line ceiling = 3600 / slowest when positive, else 0.
          const slowest = scope.line_balance.slowest_station_cycle;
          const expectedCeiling = slowest > 0 ? 3600 / slowest : 0;
          expect(lineCeiling).toBe(expectedCeiling);
        }
      ),
      { numRuns: 200 }
    );
  });
});

/**
 * Generate a LineScopeView that carries the two per-line operator counts the
 * labor series reads directly. operators_needed and operators_supplied are the
 * two inputs the comparison reports, drawn across a wide non-negative range
 * (including 0) so the property holds from an unstaffed line to a heavily
 * staffed one. The remaining LineScopeView fields carry fixed valid values
 * since laborSeries does not read them on this per-line path.
 */
const arbLaborScope: fc.Arbitrary<LineScopeView> = fc
  .record({
    operators_needed: fc.double({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
    operators_supplied: fc.double({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ operators_needed, operators_supplied }) => {
    const line_balance: LineBalanceMetrics = {
      balance_efficiency: 0,
      takt_time: null,
      fastest_station_cycle: 0,
      slowest_station_cycle: 0,
      cycle_time_spread: 0,
    };
    const scope: LineScopeView = {
      lineId: "line-1",
      lineName: "Line 1",
      throughput: 0,
      line_balance,
      stations: [],
      buffers: [],
      total_operators: 0,
      labor_utilization: 0,
      operators_needed,
      operators_supplied,
      target_throughput: null,
      isSingleLine: false,
    };
    return scope;
  });

/**
 * Feature: results-visualization-expand, Property 3: Labor series reflects the
 * two operator counts.
 *
 * For any scope that carries operators needed and operators supplied,
 * laborSeries produces exactly two non-negative values equal to those two
 * inputs on the same operator-count scale.
 *
 * Validates: Requirements 6.4
 */
describe("Feature: results-visualization-expand, Property 3: Labor series reflects the two operator counts", () => {
  it("produces exactly two non-negative values equal to the two operator inputs", () => {
    fc.assert(
      fc.property(arbLaborScope, (scope) => {
        const result: ChartData = laborSeries(scope);

        // Both per-line counts are present and finite, so the mapper is ok.
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;

        const points = result.series[0].points;

        // Exactly two values, in order, on the same operator-count scale.
        const categories = points.map((p) => p.category);
        expect(categories).toEqual(["operators needed", "operators supplied"]);

        const units = points.map((p) => p.unit);
        expect(units).toEqual(["operators", "operators"]);

        const [needed, supplied] = points.map((p) => p.value);

        // Each value is non-negative and equals its input (both inputs are
        // generated non-negative, so no clamping alters them).
        expect(needed).toBeGreaterThanOrEqual(0);
        expect(supplied).toBeGreaterThanOrEqual(0);
        expect(needed).toBe(scope.operators_needed);
        expect(supplied).toBe(scope.operators_supplied);
      }),
      { numRuns: 200 }
    );
  });
});

/**
 * Generate a StationMetrics carrying a scrap_pct and a setup_impact for the
 * scrap-and-setup membership property. Each station draws:
 *
 *   scrap_pct    one of: exactly 0, a positive value, or absent (undefined).
 *   setup_impact one of: exactly 0, a positive value, or absent (undefined).
 *
 * Mixing exact zeros, positive values, and absent fields covers the full
 * predicate space: stations that qualify on scrap alone, on setup alone, on
 * both, and stations that qualify on neither (both zero, both absent, or a mix
 * of zero and absent). Each station gets a distinct station_name so the
 * included set can be identified unambiguously by name. The remaining fields
 * carry fixed valid values since scrapSetupSeries does not read them.
 */
const arbScrapSetupStation = (index: number): fc.Arbitrary<StationMetrics> =>
  fc
    .record({
      scrap_pct: fc.oneof(
        fc.constant<number | undefined>(0),
        fc.constant<number | undefined>(undefined),
        fc.double({ min: 0.0001, max: 100, noNaN: true, noDefaultInfinity: true })
      ),
      setup_impact: fc.oneof(
        fc.constant<number | undefined>(0),
        fc.constant<number | undefined>(undefined),
        fc.double({ min: 0.0001, max: 999, noNaN: true, noDefaultInfinity: true })
      ),
    })
    .map(({ scrap_pct, setup_impact }) => {
      const station: StationMetrics = {
        station_id: `s${index}`,
        station_name: `Station ${index}`,
        utilization: 0,
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
        is_bottleneck: false,
        overstaffed: false,
        operations: [],
        scrap_pct,
        setup_impact,
      };
      return station;
    });

/**
 * Generate a list of 0 to 8 scrap-and-setup stations, each with a distinct
 * name so the included set can be compared by name.
 */
const arbScrapSetupStations: fc.Arbitrary<StationMetrics[]> = fc
  .array(fc.integer({ min: 0, max: 7 }), { minLength: 0, maxLength: 8 })
  .chain((indices) =>
    indices.length === 0
      ? fc.constant<StationMetrics[]>([])
      : fc.tuple(...indices.map((_, i) => arbScrapSetupStation(i)))
  );

/**
 * Feature: results-visualization-expand, Property 4: Scrap and setup
 * membership matches the positive predicate.
 *
 * For any list of stations, the scrap and setup series produced by
 * scrapSetupSeries includes exactly those stations whose scrap_pct is greater
 * than 0 or whose setup_impact is greater than 0, and omits every station whose
 * scrap_pct equals 0 and setup_impact equals 0.
 *
 * Validates: Requirements 6.5, 6.6
 */
describe("Feature: results-visualization-expand, Property 4: Scrap and setup membership matches the positive predicate", () => {
  it("includes exactly the stations with scrap_pct > 0 or setup_impact > 0", () => {
    fc.assert(
      fc.property(arbScrapSetupStations, (stations) => {
        const result: ChartData = scrapSetupSeries(stations);

        // The mapper never returns unavailable; an empty included set is still
        // an ok result with an empty series list.
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;

        // The positive predicate, treating absent or non-finite values as 0.
        const positive = (raw: number | undefined): boolean =>
          typeof raw === "number" && Number.isFinite(raw) && raw > 0;
        const qualifies = (s: StationMetrics): boolean =>
          positive(s.scrap_pct) || positive(s.setup_impact);

        const expectedNames = stations.filter(qualifies).map((s) => s.station_name);
        const includedNames = result.series.map((ser) => ser.seriesName);

        // Included set equals exactly the stations that satisfy the predicate,
        // in the same order (membership and no reordering).
        expect(includedNames).toEqual(expectedNames);

        // Every omitted station fails the predicate; no qualifying station is
        // dropped.
        const omitted = stations.filter((s) => !includedNames.includes(s.station_name));
        for (const s of omitted) {
          expect(qualifies(s)).toBe(false);
        }

        // Each included series exposes the scrap and setup contributions as two
        // separately identifiable points.
        for (const ser of result.series) {
          expect(ser.points.map((p) => p.category)).toEqual(["scrap", "setup"]);
        }
      }),
      { numRuns: 200 }
    );
  });
});

/**
 * The four known problem keys, used both to build known recommendations and to
 * assert their display labels.
 */
const KNOWN_PROBLEMS = [
  "defect_waste",
  "setup_waste",
  "operation_move",
  "labor_constraint",
] as const;

const KNOWN_PROBLEM_DISPLAY: Record<(typeof KNOWN_PROBLEMS)[number], string> = {
  defect_waste: "Defect waste",
  setup_waste: "Setup waste",
  operation_move: "Operation move",
  labor_constraint: "Labor constraint",
};

/**
 * Generate a single Recommendation. The problem string is drawn from the four
 * known keys plus a spread of arbitrary strings (including ones that are not
 * known keys), and estimated_throughput_gain_pct is drawn across a wide range
 * that deliberately spans negative values and values above 100, so the clamping
 * and ordering behavior is exercised across the full input space. The remaining
 * fields carry fixed valid values.
 */
const arbRecommendation: fc.Arbitrary<Recommendation> = fc
  .record({
    element_name: fc.string({ minLength: 1, maxLength: 12 }),
    problem: fc.oneof(
      fc.constantFrom(...KNOWN_PROBLEMS),
      fc.string({ maxLength: 20 })
    ),
    severity: fc.constantFrom<"high" | "medium" | "low">("high", "medium", "low"),
    // Deliberately include out-of-range and negative gains.
    gain: fc.double({ min: -200, max: 300, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ element_name, problem, severity, gain }) => {
    const rec: Recommendation = {
      element_id: "e1",
      element_name,
      problem,
      severity,
      action: "do the thing",
      description: "because reasons",
      estimated_throughput_gain_pct: gain,
    };
    return rec;
  });

/**
 * Feature: results-visualization-expand, Property 5: Recommendation gains are
 * clamped and sorted descending.
 *
 * For any array of recommendations, every value produced by
 * recommendationGainSeries lies in the range 0.00 to 100.00, and the produced
 * sequence is ordered by estimated throughput gain from highest to lowest.
 *
 * Validates: Requirements 7.2
 */
describe("Feature: results-visualization-expand, Property 5: Recommendation gains are clamped and sorted descending", () => {
  it("clamps every gain to 0.00..100.00 and orders them descending", () => {
    fc.assert(
      fc.property(
        fc.array(arbRecommendation, { minLength: 0, maxLength: 12 }),
        (recs) => {
          const result: ChartData = recommendationGainSeries(recs);

          // Always ok: no recommendation is ever dropped and an empty input
          // yields an ok series with an empty points list.
          expect(result.kind).toBe("ok");
          if (result.kind !== "ok") return;

          const points = result.series[0].points;

          // Count is preserved: one point per input recommendation.
          expect(points.length).toBe(recs.length);

          // Every value is clamped into 0.00..100.00.
          for (const p of points) {
            expect(p.value).toBeGreaterThanOrEqual(0);
            expect(p.value).toBeLessThanOrEqual(100);
          }

          // The produced sequence is non-increasing (highest to lowest).
          for (let i = 1; i < points.length; i += 1) {
            expect(points[i - 1].value).toBeGreaterThanOrEqual(points[i].value);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

/**
 * Feature: results-visualization-expand, Property 6: Known problem labels map
 * to their display label.
 *
 * For any recommendation whose problem is one of defect_waste, setup_waste,
 * operation_move, or labor_constraint, problemLabelInfo returns known true and
 * the matching display label for that problem.
 *
 * Validates: Requirements 7.3
 */
describe("Feature: results-visualization-expand, Property 6: Known problem labels map to their display label", () => {
  it("maps each known problem key to known true and its display label", () => {
    fc.assert(
      fc.property(fc.constantFrom(...KNOWN_PROBLEMS), (problem) => {
        const info = problemLabelInfo(problem);

        expect(info.raw).toBe(problem);
        expect(info.known).toBe(true);
        expect(info.display).toBe(KNOWN_PROBLEM_DISPLAY[problem]);
      }),
      { numRuns: 200 }
    );
  });
});

/**
 * Feature: results-visualization-expand, Property 7: Unknown problem labels are
 * flagged and never drop recommendations.
 *
 * For any array of recommendations mixing known and unknown problem values, the
 * mapper flags every unknown problem with known false and an unrecognized
 * indication, and the number of rendered recommendations equals the number of
 * input recommendations.
 *
 * Validates: Requirements 7.4
 */
describe("Feature: results-visualization-expand, Property 7: Unknown problem labels are flagged and never drop recommendations", () => {
  it("flags unknown problems as known false and preserves the recommendation count", () => {
    const knownSet = new Set<string>(KNOWN_PROBLEMS);
    fc.assert(
      fc.property(
        fc.array(arbRecommendation, { minLength: 0, maxLength: 12 }),
        (recs) => {
          // Count is preserved by the gain series mapper regardless of problem.
          const gainResult: ChartData = recommendationGainSeries(recs);
          expect(gainResult.kind).toBe("ok");
          if (gainResult.kind !== "ok") return;
          expect(gainResult.series[0].points.length).toBe(recs.length);

          // Every problem label is classified; unknown ones are flagged false
          // and still produce a readable display. No recommendation is dropped.
          const infos = recs.map((rec) => problemLabelInfo(rec.problem));
          expect(infos.length).toBe(recs.length);

          for (let i = 0; i < recs.length; i += 1) {
            const info = infos[i];
            const isKnown = knownSet.has(recs[i].problem);
            expect(info.known).toBe(isKnown);
            // A readable display is always produced, known or not.
            expect(typeof info.display).toBe("string");
            expect(info.display.length).toBeGreaterThan(0);
            if (!isKnown) {
              // Unknown labels are not presented as one of the known displays.
              expect(Object.values(KNOWN_PROBLEM_DISPLAY)).not.toContain(info.display);
            }
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

/**
 * Feature: results-visualization-expand, Property 8: Projection uses only
 * supplied numbers and never decreases for non-negative gain.
 *
 * For any before throughput and any gain percentage, projectedBeforeAfter
 * returns gainPct clamped to 0 to 100 and after equal to before * (1 +
 * clampedGain / 100), so after is greater than or equal to before whenever the
 * clamped gain is non-negative, using no value outside its inputs.
 *
 * Validates: Requirements 7.5
 */
describe("Feature: results-visualization-expand, Property 8: Projection uses only supplied numbers and never decreases for non-negative gain", () => {
  it("clamps the gain to 0..100 and computes after from before and the clamped gain", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100000, noNaN: true, noDefaultInfinity: true }),
        // Include negative and above-100 gains to exercise the clamp.
        fc.double({ min: -200, max: 300, noNaN: true, noDefaultInfinity: true }),
        (before, gainPct) => {
          const result = projectedBeforeAfter(before, gainPct);

          // gainPct is clamped into 0..100.
          expect(result.gainPct).toBeGreaterThanOrEqual(0);
          expect(result.gainPct).toBeLessThanOrEqual(100);
          expect(result.gainPct).toBe(Math.max(0, Math.min(100, gainPct)));

          // before is carried through unchanged (it is already non-negative).
          expect(result.before).toBe(before);

          // after equals before * (1 + clampedGain / 100), derived only from
          // the two inputs.
          const expectedAfter = before * (1 + result.gainPct / 100);
          expect(result.after).toBe(expectedAfter);

          // For a non-negative clamped gain and a non-negative before, after is
          // greater than or equal to before.
          expect(result.after).toBeGreaterThanOrEqual(result.before);
        }
      ),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Multi-line generators and properties (Properties 9 through 12)
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid LineBalanceMetrics with an optional own takt. The
 * takt_time is the balance takt the effective-takt selector falls back to when
 * a scope carries no own takt.
 */
const makeLineBalance = (takt: number | null): LineBalanceMetrics => ({
  balance_efficiency: 0,
  takt_time: takt,
  fastest_station_cycle: 0,
  slowest_station_cycle: 0,
  cycle_time_spread: 0,
});

/**
 * Build a plain, valid StationMetrics with the given id and name and the four
 * time-split fields left at 0. Used to populate per-line station lists so the
 * attribution property has real per-station points to check.
 */
const makeStation = (id: string, name: string): StationMetrics => ({
  station_id: id,
  station_name: name,
  utilization: 0,
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
  is_bottleneck: false,
  overstaffed: false,
  operations: [],
});

/**
 * Build a minimal valid PerLineResult for a line. Each line gets one or more
 * stations so the multi-line attribution property has per-station points to
 * attribute. target_throughput and takt_time are drawn so the effective-target
 * and effective-takt selectors are exercised against both own-value and
 * fallback paths.
 */
const arbPerLineResult = (index: number): fc.Arbitrary<PerLineResult> =>
  fc
    .record({
      throughput: fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true }),
      stationCount: fc.integer({ min: 1, max: 3 }),
      target_throughput: fc.oneof(
        fc.constant<number | null>(null),
        fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true })
      ),
      takt_time: fc.oneof(
        fc.constant<number | null>(null),
        fc.double({ min: 0.0001, max: 600, noNaN: true, noDefaultInfinity: true })
      ),
      balanceTakt: fc.oneof(
        fc.constant<number | null>(null),
        fc.double({ min: 0.0001, max: 600, noNaN: true, noDefaultInfinity: true })
      ),
    })
    .map(({ throughput, stationCount, target_throughput, takt_time, balanceTakt }) => {
      const lineId = `line-${index}`;
      const stations: StationMetrics[] = [];
      for (let i = 0; i < stationCount; i += 1) {
        stations.push(makeStation(`${lineId}-s${i}`, `${lineId} Station ${i}`));
      }
      const line: PerLineResult = {
        line_id: lineId,
        line_name: `Line ${index}`,
        throughput,
        avg_lead_time: 0,
        wip_total: 0,
        value_added_ratio: 0,
        total_operators: 0,
        labor_utilization: 0,
        stations,
        buffers: [],
        line_balance: makeLineBalance(balanceTakt),
        recommendations: [],
        target_throughput,
        takt_time,
      };
      return line;
    });

/**
 * Build a SimulationResult with a lines array of a chosen length. Length 0, 1,
 * 2, and more are all generated so the scope-count rule is exercised across the
 * single-line branch (absent-effectively, empty, length 1) and the multi-line
 * branch (length 2 or more). The top-level aggregate fields carry fixed valid
 * values; the scope-count rule reads only the lines array length.
 */
const arbSimulationResult: fc.Arbitrary<SimulationResult> = fc
  .integer({ min: 0, max: 5 })
  .chain((lineCount) => {
    const base: SimulationResult = {
      throughput: 0,
      avg_lead_time: 0,
      wip_total: 0,
      value_added_ratio: 0,
      total_operators: 0,
      labor_utilization: 0,
      stations: [],
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
    };
    if (lineCount === 0) {
      return fc.constant<SimulationResult>({ ...base, lines: [] });
    }
    const lineArbs = Array.from({ length: lineCount }, (_, i) => arbPerLineResult(i));
    return fc.tuple(...lineArbs).map((lines) => ({ ...base, lines }));
  });

/**
 * Feature: results-visualization-expand, Property 9: Scope count matches the
 * line count rule.
 *
 * For any SimulationResult, scopesOf returns exactly one scope when lines is
 * absent, empty, or of length 1, and returns a number of scopes equal to the
 * length of lines when lines has length 2 or more.
 *
 * Validates: Requirements 8.1, 8.2
 */
describe("Feature: results-visualization-expand, Property 9: Scope count matches the line count rule", () => {
  it("returns one scope for 0 or 1 lines and lines.length scopes for 2 or more", () => {
    fc.assert(
      fc.property(arbSimulationResult, (result) => {
        const scopes = scopesOf(result);
        const lineCount = (result.lines ?? []).length;

        if (lineCount <= 1) {
          expect(scopes.length).toBe(1);
          // The single scope is the aggregate scope.
          expect(scopes[0].isSingleLine).toBe(true);
        } else {
          expect(scopes.length).toBe(lineCount);
          // Each scope is a per-line scope matching a line in the array.
          const lineIds = (result.lines ?? []).map((l) => l.line_id);
          for (const scope of scopes) {
            expect(scope.isSingleLine).toBe(false);
            expect(lineIds).toContain(scope.lineId);
          }
        }
      }),
      { numRuns: 200 }
    );
  });
});

/**
 * Feature: results-visualization-expand, Property 10: Every per-station point
 * is attributed to exactly one line.
 *
 * For any multi-line SimulationResult, each per-station chart point produced for
 * the Results chart set carries exactly one lineId, and that lineId matches a
 * line present in the lines array.
 *
 * Validates: Requirements 8.3
 */
describe("Feature: results-visualization-expand, Property 10: Every per-station point is attributed to exactly one line", () => {
  it("stamps each per-station point with exactly one lineId matching a present line", () => {
    // Only multi-line results carry per-line attribution, so restrict to
    // lines.length >= 2.
    const arbMultiLine = arbSimulationResult.filter(
      (result) => (result.lines ?? []).length >= 2
    );

    fc.assert(
      fc.property(arbMultiLine, (result) => {
        const scopes = scopesOf(result);
        const presentLineIds = new Set((result.lines ?? []).map((l) => l.line_id));

        // Mirror how the Results chart set attributes per-station time-split
        // points: one series per station, every point stamped with the scope's
        // lineId.
        for (const scope of scopes) {
          for (const station of scope.stations) {
            const attributed = attributeStationSeries(
              timeSplitSeries(station),
              scope.lineId
            );
            // The station has valid time-split fields, so the result is ok.
            expect(attributed.kind).toBe("ok");
            if (attributed.kind !== "ok") return;

            for (const ser of attributed.series) {
              for (const point of ser.points) {
                // Exactly one lineId, present on the point, matching a real line.
                expect(point.lineId).toBeDefined();
                expect(point.lineId).toBe(scope.lineId);
                expect(presentLineIds.has(point.lineId as string)).toBe(true);
              }
            }
          }
        }
      }),
      { numRuns: 200 }
    );
  });
});

/**
 * Build a shared StationMetrics whose line_shares cover a set of served lines,
 * with per-line busy_pct values that sum to the station's utilization (its busy
 * total). The generator draws a set of non-negative busy weights for the served
 * lines and scales them so their sum lands anywhere in 0..100, then sets the
 * station utilization to that same sum, so the shared split partitions the
 * station busy total exactly (the mapper reports the backend split verbatim and
 * does not rescale).
 */
const arbSharedStation: fc.Arbitrary<{
  station: StationMetrics;
  lineIds: string[];
}> = fc
  .integer({ min: 2, max: 5 })
  .chain((lineCount) =>
    fc.record({
      weights: fc.array(
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        { minLength: lineCount, maxLength: lineCount }
      ),
      total: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
    })
  )
  .map(({ weights, total }) => {
    const weightSum = weights.reduce((a, b) => a + b, 0);
    // Scale the weights so they sum to `total`. Guard against a scale that is
    // not a finite number (for example a vanishingly small weightSum paired
    // with a large total), which would otherwise yield non-finite portions;
    // fall back to 0 for every portion in that case (a fully idle shared
    // station, still a valid partition of a 0 busy total).
    const rawScale = weightSum > 0 ? total / weightSum : 0;
    const scale = Number.isFinite(rawScale) ? rawScale : 0;
    const busyPortions = weights.map((w) => {
      const portion = w * scale;
      return Number.isFinite(portion) ? portion : 0;
    });
    // Utilization (the station busy total) equals the sum of the per-line busy
    // portions, so the split partitions it exactly.
    const utilization = busyPortions.reduce((a, b) => a + b, 0);

    const lineIds = busyPortions.map((_, i) => `line-${i}`);
    const line_shares: LineTimeShare[] = busyPortions.map((busy, i) => ({
      line_id: `line-${i}`,
      line_name: `Line ${i}`,
      busy_pct: busy,
      blocked_pct: 0,
      starved_pct: 0,
      down_pct: 0,
      idle_pct: 0,
      throughput: 0,
    }));

    const station: StationMetrics = {
      ...makeStation("shared-1", "Shared Station"),
      utilization,
      is_shared: true,
      line_ids: lineIds,
      line_shares,
    };

    return { station, lineIds };
  });

/**
 * Feature: results-visualization-expand, Property 11: Shared station per-line
 * portions partition the station total.
 *
 * For any shared station whose line_shares cover all of its served lines, the
 * per-line busy portions produced by sharedStationSplit sum to the station busy
 * total within a tolerance of 0.01.
 *
 * Validates: Requirements 8.4
 */
describe("Feature: results-visualization-expand, Property 11: Shared station per-line portions partition the station total", () => {
  it("per-line busy portions sum to the station busy total within 0.01", () => {
    fc.assert(
      fc.property(arbSharedStation, ({ station, lineIds }) => {
        const result: ChartData = sharedStationSplit(station, lineIds);

        // line_shares cover every requested line, so the mapper is ok.
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") return;

        const points = result.series[0].points;

        // One point per requested line, each attributed to that one line.
        expect(points.length).toBe(lineIds.length);
        for (let i = 0; i < points.length; i += 1) {
          expect(points[i].lineId).toBe(lineIds[i]);
          expect(points[i].value).toBeGreaterThanOrEqual(0);
        }

        // The per-line busy portions sum to the station busy total (its
        // utilization) within 0.01.
        const sum = points.reduce((acc, p) => acc + p.value, 0);
        expect(Math.abs(sum - station.utilization)).toBeLessThanOrEqual(0.01);
      }),
      { numRuns: 200 }
    );
  });
});

/**
 * Build a LineScopeView plus the fallback target used to probe the effective
 * target and takt selectors. target_throughput and takt_time are each drawn as
 * either a set value or null/undefined so both the own-value and the fallback
 * paths are exercised. balanceTakt is the scope's balance takt the takt
 * selector falls back to when the scope carries no own takt.
 */
const arbParityScope: fc.Arbitrary<{ scope: LineScopeView; fallback: number }> = fc
  .record({
    target_throughput: fc.oneof(
      fc.constant<number | null | undefined>(null),
      fc.constant<number | null | undefined>(undefined),
      fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true })
    ),
    takt_time: fc.oneof(
      fc.constant<number | null | undefined>(null),
      fc.constant<number | null | undefined>(undefined),
      fc.double({ min: 0.0001, max: 600, noNaN: true, noDefaultInfinity: true })
    ),
    balanceTakt: fc.oneof(
      fc.constant<number | null>(null),
      fc.double({ min: 0.0001, max: 600, noNaN: true, noDefaultInfinity: true })
    ),
    fallback: fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ target_throughput, takt_time, balanceTakt, fallback }) => {
    const scope: LineScopeView = {
      lineId: "line-0",
      lineName: "Line 0",
      throughput: 0,
      line_balance: makeLineBalance(balanceTakt),
      stations: [],
      buffers: [],
      total_operators: 0,
      labor_utilization: 0,
      target_throughput,
      takt_time,
      isSingleLine: false,
    };
    return { scope, fallback };
  });

/**
 * Feature: results-visualization-expand, Property 12: Effective target and takt
 * match the compact selector.
 *
 * For any line, the effective target returned by the shared selector equals the
 * line's own target_throughput when set and the fallback target otherwise, and
 * the effective takt equals the line's own takt_time when set and the line's
 * balance takt otherwise, which is identical to what the compact panel selects
 * for that scope.
 *
 * Validates: Requirements 8.5
 */
describe("Feature: results-visualization-expand, Property 12: Effective target and takt match the compact selector", () => {
  it("matches own-value-else-fallback for target and own-else-balance-else-null for takt", () => {
    fc.assert(
      fc.property(arbParityScope, ({ scope, fallback }) => {
        const target = effectiveTargetFor(scope, fallback);
        const takt = effectiveTaktFor(scope);

        // Target: own target_throughput when set, else the fallback. This is
        // exactly the compact panel's `line.target_throughput ?? fallback`.
        const expectedTarget = scope.target_throughput ?? fallback;
        expect(target).toBe(expectedTarget);

        // Takt: own takt_time when set, else the balance takt, else null. This
        // is exactly the compact panel's
        // `line.takt_time ?? line.line_balance.takt_time ?? null`.
        const expectedTakt =
          scope.takt_time ?? scope.line_balance.takt_time ?? null;
        expect(takt).toBe(expectedTakt);
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting mapper properties (Properties 13 through 15)
// ---------------------------------------------------------------------------

/**
 * Build a StationMetrics in which one of the four time-split required fields
 * (utilization, starved_pct, blocked_pct, down_pct) is missing (non-finite),
 * so timeSplitSeries must return an unavailable marker rather than throwing.
 * The field is corrupted by setting it to one of the non-finite sentinels the
 * mapper guards against (NaN, Infinity, -Infinity) or by casting undefined onto
 * it, covering the "field required by the chart is absent" case.
 */
const arbStationMissingTimeSplitField: fc.Arbitrary<StationMetrics> = fc
  .record({
    whichField: fc.constantFrom<
      "utilization" | "starved_pct" | "blocked_pct" | "down_pct"
    >("utilization", "starved_pct", "blocked_pct", "down_pct"),
    badValue: fc.constantFrom<number>(NaN, Infinity, -Infinity),
    useUndefined: fc.boolean(),
  })
  .map(({ whichField, badValue, useUndefined }) => {
    const station = makeStation("missing-1", "Missing Field Station");
    // Absent field: either a non-finite number, or undefined cast onto the
    // required slot. Both are "not a finite number" from the mapper's view.
    const absent = useUndefined
      ? (undefined as unknown as number)
      : badValue;
    (station as unknown as Record<string, unknown>)[whichField] = absent;
    return station;
  });

/**
 * Build a shared StationMetrics that is MISSING a line_shares entry for one or
 * more of its served lines, so sharedStationSplit must return an unavailable
 * marker for the whole split (Req 8.6) while never throwing. The station serves
 * two or more lines but line_shares is either empty or covers only a strict
 * subset of the requested line ids.
 */
const arbSharedStationMissingShare: fc.Arbitrary<{
  station: StationMetrics;
  lineIds: string[];
}> = fc
  .integer({ min: 2, max: 5 })
  .chain((served) =>
    fc.record({
      served: fc.constant(served),
      // How many of the served lines actually get a line_shares entry: always
      // fewer than `served`, so at least one requested line is missing.
      covered: fc.integer({ min: 0, max: served - 1 }),
    })
  )
  .map(({ served, covered }) => {
    const lineIds = Array.from({ length: served }, (_, i) => `line-${i}`);
    const line_shares: LineTimeShare[] = lineIds.slice(0, covered).map((id, i) => ({
      line_id: id,
      line_name: `Line ${i}`,
      busy_pct: 1,
      blocked_pct: 0,
      starved_pct: 0,
      down_pct: 0,
      idle_pct: 0,
      throughput: 0,
    }));
    const station: StationMetrics = {
      ...makeStation("shared-missing-1", "Shared Missing Station"),
      utilization: 10,
      is_shared: true,
      line_ids: lineIds,
      line_shares,
    };
    return { station, lineIds };
  });

/**
 * Feature: results-visualization-expand, Property 13: Missing required data
 * yields an unavailable marker, never a throw.
 *
 * For any Result_Data in which a field required by a given chart is absent
 * (including a shared station missing one or more line_shares entries), the
 * corresponding mapper returns an unavailable result and does not throw, while
 * mappers whose required fields are all present still return ok results.
 *
 * Validates: Requirements 4.7, 5.5, 5.7, 8.6
 */

/**
 * Build a StationMetrics whose four time-split required fields (utilization,
 * starved_pct, blocked_pct, down_pct) are guaranteed finite and non-negative,
 * so timeSplitSeries must return ok. Each share is drawn as a plain finite
 * double in 0..25 (four shares sum to at most 100, a valid station), so the
 * "all fields present" assertion in Property 13 is always valid. This local
 * generator is used instead of the shared arbStationMetrics, whose weight
 * scaling can occasionally emit a non-finite required field.
 */
const arbGoodStation: fc.Arbitrary<StationMetrics> = fc
  .record({
    utilization: fc.double({ min: 0, max: 25, noNaN: true, noDefaultInfinity: true }),
    starved_pct: fc.double({ min: 0, max: 25, noNaN: true, noDefaultInfinity: true }),
    blocked_pct: fc.double({ min: 0, max: 25, noNaN: true, noDefaultInfinity: true }),
    down_pct: fc.double({ min: 0, max: 25, noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ utilization, starved_pct, blocked_pct, down_pct }) => ({
    ...makeStation("good-1", "Good Station"),
    utilization,
    starved_pct,
    blocked_pct,
    down_pct,
  }));

/**
 * Build a LineScopeView whose throughput-comparison required fields are
 * guaranteed finite, so throughputComparisonSeries must return ok. throughput
 * and slowest_station_cycle are drawn as finite doubles. The scope carries
 * neither operators_needed/supplied nor an operators[] pool, so laborSeries
 * still correctly returns unavailable for it. This local generator is used
 * instead of the shared arbScope, whose fields could otherwise be non-finite.
 */
const arbGoodScope: fc.Arbitrary<LineScopeView> = fc
  .record({
    throughput: fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true }),
    slowest: fc.oneof(
      fc.constant(0),
      fc.double({ min: 0.0001, max: 600, noNaN: true, noDefaultInfinity: true })
    ),
    target_throughput: fc.oneof(
      fc.constant<number | null>(null),
      fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true })
    ),
  })
  .map(({ throughput, slowest, target_throughput }) => {
    const line_balance: LineBalanceMetrics = {
      balance_efficiency: 0,
      takt_time: null,
      fastest_station_cycle: 0,
      slowest_station_cycle: slowest,
      cycle_time_spread: 0,
    };
    const scope: LineScopeView = {
      lineId: "good-scope",
      lineName: "Good Scope",
      throughput,
      line_balance,
      stations: [],
      buffers: [],
      total_operators: 0,
      labor_utilization: 0,
      target_throughput,
      isSingleLine: true,
    };
    return scope;
  });

describe("Feature: results-visualization-expand, Property 13: Missing required data yields an unavailable marker, never a throw", () => {
  it("returns unavailable (never throws) when a required field is absent, and ok when all present", () => {
    fc.assert(
      fc.property(
        arbStationMissingTimeSplitField,
        arbSharedStationMissingShare,
        arbGoodStation,
        arbGoodScope,
        fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true }),
        (missingStation, missingShared, goodStation, goodScope, fallback) => {
          // A missing time-split field yields an unavailable marker, no throw.
          let timeSplitResult: ChartData | undefined;
          expect(() => {
            timeSplitResult = timeSplitSeries(missingStation);
          }).not.toThrow();
          expect(timeSplitResult?.kind).toBe("unavailable");

          // A shared station missing a line_shares entry for one or more served
          // lines yields an unavailable marker, no throw.
          let sharedResult: ChartData | undefined;
          expect(() => {
            sharedResult = sharedStationSplit(
              missingShared.station,
              missingShared.lineIds
            );
          }).not.toThrow();
          expect(sharedResult?.kind).toBe("unavailable");

          // A scope missing operator counts yields an unavailable labor marker,
          // no throw. goodScope carries neither operators_needed/supplied nor an
          // operators[] pool list, so the labor mapper has no source.
          let laborResult: ChartData | undefined;
          expect(() => {
            laborResult = laborSeries(goodScope);
          }).not.toThrow();
          expect(laborResult?.kind).toBe("unavailable");

          // Mappers whose required fields are all present still return ok.
          const goodTimeSplit = timeSplitSeries(goodStation);
          expect(goodTimeSplit.kind).toBe("ok");

          const effectiveTarget = effectiveTargetFor(goodScope, fallback);
          const goodThroughput = throughputComparisonSeries(goodScope, effectiveTarget);
          expect(goodThroughput.kind).toBe("ok");
        }
      ),
      { numRuns: 200 }
    );
  });
});

/**
 * A single operator-pool generator so a scope can carry a usable operators[]
 * fallback for the labor mapper in the determinism property.
 */
const arbScopeForDeterminism: fc.Arbitrary<LineScopeView> = fc
  .record({
    throughput: fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true }),
    slowest: fc.oneof(
      fc.constant(0),
      fc.double({ min: 0.0001, max: 600, noNaN: true, noDefaultInfinity: true })
    ),
    needed: fc.double({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
    supplied: fc.double({ min: 0, max: 500, noNaN: true, noDefaultInfinity: true }),
    target_throughput: fc.oneof(
      fc.constant<number | null>(null),
      fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true })
    ),
  })
  .map(({ throughput, slowest, needed, supplied, target_throughput }) => {
    const scope: LineScopeView = {
      lineId: "line-det",
      lineName: "Line Det",
      throughput,
      line_balance: {
        balance_efficiency: 0,
        takt_time: null,
        fastest_station_cycle: 0,
        slowest_station_cycle: slowest,
        cycle_time_spread: 0,
      },
      stations: [],
      buffers: [],
      total_operators: 0,
      labor_utilization: 0,
      operators_needed: needed,
      operators_supplied: supplied,
      target_throughput,
      isSingleLine: false,
    };
    return scope;
  });

/**
 * Feature: results-visualization-expand, Property 14: Mappers are deterministic
 * and do not mutate inputs.
 *
 * For any Result_Data, calling any mapper twice on the same input yields deeply
 * equal output and leaves the input value unchanged.
 *
 * Validates: Requirements 5.1, 5.3
 */
describe("Feature: results-visualization-expand, Property 14: Mappers are deterministic and do not mutate inputs", () => {
  it("returns deeply equal output on repeated calls and never mutates the input", () => {
    fc.assert(
      fc.property(
        arbStationMetrics,
        arbScopeForDeterminism,
        arbScrapSetupStations,
        fc.array(arbRecommendation, { minLength: 0, maxLength: 12 }),
        arbSimulationResult,
        fc.double({ min: 0, max: 5000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -200, max: 300, noNaN: true, noDefaultInfinity: true }),
        (station, scope, stations, recs, result, fallback, gainPct) => {
          // Deep-clone each input up front so we can assert the mapper left the
          // original untouched (structural equality to the snapshot).
          const stationSnapshot = structuredClone(station);
          const scopeSnapshot = structuredClone(scope);
          const stationsSnapshot = structuredClone(stations);
          const recsSnapshot = structuredClone(recs);
          const resultSnapshot = structuredClone(result);

          const effectiveTarget = effectiveTargetFor(scope, fallback);

          // Each mapper: call twice, assert deeply equal output.
          expect(timeSplitSeries(station)).toEqual(timeSplitSeries(station));
          expect(throughputComparisonSeries(scope, effectiveTarget)).toEqual(
            throughputComparisonSeries(scope, effectiveTarget)
          );
          expect(laborSeries(scope)).toEqual(laborSeries(scope));
          expect(scrapSetupSeries(stations)).toEqual(scrapSetupSeries(stations));
          expect(recommendationGainSeries(recs)).toEqual(
            recommendationGainSeries(recs)
          );
          expect(projectedBeforeAfter(scope.throughput, gainPct)).toEqual(
            projectedBeforeAfter(scope.throughput, gainPct)
          );
          expect(scopesOf(result)).toEqual(scopesOf(result));
          expect(effectiveTargetFor(scope, fallback)).toBe(
            effectiveTargetFor(scope, fallback)
          );
          expect(effectiveTaktFor(scope)).toBe(effectiveTaktFor(scope));

          // No mapper mutated its input: each input still deeply equals the
          // snapshot taken before any mapper ran.
          expect(station).toEqual(stationSnapshot);
          expect(scope).toEqual(scopeSnapshot);
          expect(stations).toEqual(stationsSnapshot);
          expect(recs).toEqual(recsSnapshot);
          expect(result).toEqual(resultSnapshot);
        }
      ),
      { numRuns: 200 }
    );
  });
});

/**
 * Build an arbitrary ChartSeries for the text-alternative parity property. The
 * series carries 0 to 10 points, each with an arbitrary category label, an
 * arbitrary finite numeric value (including negatives and zero so the mapper is
 * exercised across the full value space), and an optional unit and lineId so
 * both the present and absent paths of those optional fields are covered.
 */
const arbChartSeries: fc.Arbitrary<ChartSeries> = fc.record({
  seriesName: fc.string({ maxLength: 20 }),
  points: fc.array(
    fc.record({
      category: fc.string({ maxLength: 20 }),
      value: fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
      unit: fc.option(fc.constantFrom("%", "/hr", "operators", "x cycle time"), {
        nil: undefined,
      }),
      lineId: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
    }),
    { minLength: 0, maxLength: 10 }
  ),
});

/**
 * Feature: results-visualization-expand, Property 15: Text alternative conveys
 * every data point.
 *
 * For any ChartSeries, the text alternative produced by toTextAlternativeRows
 * contains exactly one row per data point, and each row carries the same
 * category label and the same numeric value as the point it represents.
 *
 * Validates: Requirements 9.1, 9.7
 */
describe("Feature: results-visualization-expand, Property 15: Text alternative conveys every data point", () => {
  it("produces exactly one row per point with matching category and numeric value", () => {
    fc.assert(
      fc.property(arbChartSeries, (series) => {
        const rows = toTextAlternativeRows(series);

        // Exactly one row per data point: no point dropped, none added.
        expect(rows.length).toBe(series.points.length);

        // Each row carries the same category label and numeric value, in order,
        // as the point it represents.
        for (let i = 0; i < series.points.length; i += 1) {
          expect(rows[i].category).toBe(series.points[i].category);
          expect(rows[i].value).toBe(series.points[i].value);
          // Optional unit and lineId are carried through unchanged.
          expect(rows[i].unit).toBe(series.points[i].unit);
          expect(rows[i].lineId).toBe(series.points[i].lineId);
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Unit (example) tests for mapper boundary cases (sub-task 4.5)
// ---------------------------------------------------------------------------

describe("mapper boundary cases", () => {
  it("scrapSetupSeries omits a station at exactly scrap_pct 0 and setup_impact 0 and includes a small positive one", () => {
    const zeroStation: StationMetrics = {
      ...makeStation("z1", "Zero Station"),
      scrap_pct: 0,
      setup_impact: 0,
    };
    const positiveStation: StationMetrics = {
      ...makeStation("p1", "Positive Station"),
      scrap_pct: 0.0001,
      setup_impact: 0,
    };

    const result = scrapSetupSeries([zeroStation, positiveStation]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const names = result.series.map((s) => s.seriesName);
    // The at-zero station is omitted; the small positive one is included.
    expect(names).toEqual(["Positive Station"]);
    expect(result.series[0].points.map((p) => p.category)).toEqual([
      "scrap",
      "setup",
    ]);
  });

  it("throughputComparisonSeries yields line ceiling 0 when slowest_station_cycle is 0", () => {
    const scope: LineScopeView = {
      lineId: "aggregate",
      lineName: "All",
      throughput: 120,
      line_balance: {
        balance_efficiency: 0,
        takt_time: null,
        fastest_station_cycle: 0,
        slowest_station_cycle: 0,
        cycle_time_spread: 0,
      },
      stations: [],
      buffers: [],
      total_operators: 0,
      labor_utilization: 0,
      target_throughput: null,
      isSingleLine: true,
    };

    const result = throughputComparisonSeries(scope, 150);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const values = result.series[0].points.map((p) => p.value);
    // producing now = throughput, demand needed = effective target, ceiling = 0.
    expect(values).toEqual([120, 150, 0]);
  });

  it("problemLabelInfo returns the exact display strings for the four known labels and flags a representative unknown", () => {
    expect(problemLabelInfo("defect_waste")).toEqual({
      raw: "defect_waste",
      display: "Defect waste",
      known: true,
    });
    expect(problemLabelInfo("setup_waste")).toEqual({
      raw: "setup_waste",
      display: "Setup waste",
      known: true,
    });
    expect(problemLabelInfo("operation_move")).toEqual({
      raw: "operation_move",
      display: "Operation move",
      known: true,
    });
    expect(problemLabelInfo("labor_constraint")).toEqual({
      raw: "labor_constraint",
      display: "Labor constraint",
      known: true,
    });

    // A representative unknown is flagged known false, never dropped, and still
    // produces a readable display.
    const unknown = problemLabelInfo("mystery_problem");
    expect(unknown.known).toBe(false);
    expect(unknown.raw).toBe("mystery_problem");
    expect(unknown.display).toBe("Mystery problem");
  });

  it("recommendationGainSeries on an empty array yields an empty ok series", () => {
    const result = recommendationGainSeries([]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    // One series, zero points: no empty-chart container of points is produced.
    expect(result.series.length).toBe(1);
    expect(result.series[0].points).toEqual([]);
  });
});
