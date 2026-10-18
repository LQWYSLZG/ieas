/**
 * chartData.ts - pure, chart-ready data types for the Factory Floor Simulator
 * expanded views.
 *
 * This module is the single, side-effect-free data layer that the expanded
 * Results and Recommendations charts build on. Task 1.1 defines only the
 * chart-ready TypeScript types; the pure mapper and selector implementations
 * (scopesOf, effectiveTargetFor, timeSplitSeries, and the rest) arrive in
 * later tasks.
 *
 * Purity rules this module holds to (and later tasks must preserve):
 *   - no React import
 *   - no api client import
 *   - no side effects
 * Every shape here is derived only from Result_Data fields already present on
 * the factory-simulator types; no new source field is introduced.
 *
 * Project rule: no em dashes or en dashes anywhere in this file. Only ASCII
 * hyphens are used.
 */

import type {
  SimulationResult,
  StationMetrics,
  LineBalanceMetrics,
  OperatorMetrics,
  BufferMetrics,
  Recommendation,
} from "../types";
import { sortByImpact } from "../components/RecommendationsPanel";

// ---------------------------------------------------------------------------
// Chart-ready data points and series
// ---------------------------------------------------------------------------

/**
 * A single labeled, numeric data point.
 *
 * category is the human label shown as text (non-color encoding).
 * value is the numeric value shown as text.
 * unit is an optional unit label such as "%", "/hr", or "operators".
 * lineId attributes a point to exactly one line in multi-line results; it is
 * absent for aggregate single-line points.
 */
export interface ChartDatum {
  category: string;
  value: number;
  unit?: string;
  lineId?: string;
}

/**
 * One named series of data points, consumed by both a chart and its text
 * alternative table.
 */
export interface ChartSeries {
  seriesName: string;
  points: ChartDatum[];
}

/**
 * A chart's data result. When a required field is missing or a mapping cannot
 * be produced, a mapper returns an "unavailable" marker rather than throwing,
 * so one failing chart never aborts the rest of the overlay.
 */
export type ChartData =
  | { kind: "ok"; series: ChartSeries[] }
  | { kind: "unavailable"; reason: string };

// ---------------------------------------------------------------------------
// Time split categories
// ---------------------------------------------------------------------------

/**
 * The five mutually exclusive time categories reported for a station. The five
 * values sum to 100 percent within tolerance, where idle is the non-negative
 * remainder after busy, starved, blocked, and down.
 */
export type TimeSplitCategory = "busy" | "starved" | "blocked" | "down" | "idle";

// ---------------------------------------------------------------------------
// Recommendation problem labels
// ---------------------------------------------------------------------------

/**
 * The four known recommendation problem keys. Any other value is treated as
 * unknown and flagged, never dropped.
 */
export type KnownProblem =
  | "defect_waste"
  | "setup_waste"
  | "operation_move"
  | "labor_constraint";

/**
 * The display outcome of mapping a recommendation problem key.
 *
 * raw is the original problem string from the recommendation.
 * display is the human label shown to the user, for example "Defect waste".
 * known is false when raw is not one of the four KnownProblem keys, in which
 * case the chart renders an "unrecognized" indication.
 */
export interface ProblemLabelInfo {
  raw: string;
  display: string;
  known: boolean;
}

// ---------------------------------------------------------------------------
// Projected before and after
// ---------------------------------------------------------------------------

/**
 * A before-and-after projection derived only from Result_Data.
 *
 * before is the starting throughput.
 * after equals before * (1 + gainPct / 100).
 * gainPct is the gain percentage clamped to the range 0 to 100.
 */
export interface BeforeAfter {
  before: number;
  after: number;
  gainPct: number;
}

// ---------------------------------------------------------------------------
// Line scope view
// ---------------------------------------------------------------------------

/**
 * The view shape a single scope presents to the selectors and mappers. Both
 * the whole-factory aggregate (from SimulationResult) and a single line (from
 * PerLineResult) are projected onto this one shape, so scopesOf can return a
 * uniform list and every mapper can read one scope without caring whether it
 * came from the aggregate or a line.
 *
 * Fields mirror exactly what the compact ResultsPanel reads for a scope, plus
 * the per-line effective-target inputs the shared selector needs:
 *
 *   lineId / lineName    identify the scope; lineId is used to attribute
 *                        per-station chart points in multi-line results.
 *   throughput           the scope's producing-now throughput.
 *   line_balance         carries slowest_station_cycle (for the line ceiling)
 *                        and takt_time (for the effective takt fallback).
 *   stations             the scope's stations, shared ones flagged is_shared.
 *   buffers              the scope's buffers (kept for parity with the panel).
 *   total_operators      staffed operator count for the labor fallback.
 *   labor_utilization    hands-on time percentage, carried for parity.
 *   operators_needed /   per-line operator counts used by the labor series when
 *   operators_supplied   present.
 *   operators            per-pool operator detail, the aggregate-only fallback
 *                        source for labor when per-line counts are absent.
 *   target_throughput    the scope's own target when set; the shared selector
 *                        falls back to the global target otherwise.
 *   takt_time            the scope's own takt when set; the shared selector
 *                        falls back to the balance takt otherwise.
 *   throughput_gap_pct   carried for parity with the compact panel verdict.
 *   isSingleLine         true for the aggregate single-line scope, false for a
 *                        per-line scope in a multi-line result.
 */
export interface LineScopeView {
  lineId: string;
  lineName: string;
  throughput: number;
  line_balance: LineBalanceMetrics;
  stations: StationMetrics[];
  buffers: BufferMetrics[];
  total_operators: number;
  labor_utilization: number;
  operators_needed?: number;
  operators_supplied?: number;
  operators?: OperatorMetrics[];
  target_throughput?: number | null;
  takt_time?: number | null;
  throughput_gap_pct?: number | null;
  isSingleLine: boolean;
}

// ---------------------------------------------------------------------------
// Scope selection and the shared effective target and takt selector
// ---------------------------------------------------------------------------

/**
 * Build the list of scopes to render for a result, mirroring exactly the
 * single-line-versus-multi-line branch in the compact ResultsPanel.
 *
 * ResultsPanel treats lines.length <= 1 (lines absent, empty, or length 1) as
 * a single aggregate scope that reads like the panel does today, and
 * lines.length >= 2 as one scope per line. scopesOf reproduces that rule:
 *
 *   - Single-line result: one aggregate LineScopeView projected from the
 *     SimulationResult itself. isSingleLine is true. The aggregate carries no
 *     per-line target override, so target_throughput comes from the result's
 *     own target_throughput (null when unset) and takt_time is left undefined
 *     so the selector falls back to line_balance.takt_time, which is precisely
 *     what the compact single-line path uses (result.line_balance.takt_time).
 *
 *   - Multi-line result: one LineScopeView per line, projected from each
 *     PerLineResult exactly as the compact panel's per-line LineSection reads
 *     it (throughput, line_balance, stations, buffers, operator counts, the
 *     per-line target_throughput and takt_time). isSingleLine is false.
 *
 * Pure: it reads the input and returns fresh view objects without mutating the
 * input or performing any side effect.
 */
export function scopesOf(result: SimulationResult): LineScopeView[] {
  const lines = result.lines ?? [];

  // No-regression: no per-line results OR exactly one line is a single
  // aggregate scope, matching ResultsPanel's `singleLine = lines.length <= 1`.
  if (lines.length <= 1) {
    return [
      {
        lineId: "aggregate",
        lineName: "All",
        throughput: result.throughput,
        line_balance: result.line_balance,
        stations: result.stations,
        buffers: result.buffers,
        total_operators: result.total_operators,
        labor_utilization: result.labor_utilization,
        operators: result.operators,
        target_throughput: result.target_throughput,
        // takt_time intentionally left undefined so effectiveTaktFor falls back
        // to line_balance.takt_time, matching the compact single-line path.
        throughput_gap_pct: result.throughput_gap_pct,
        isSingleLine: true,
      },
    ];
  }

  // Multi-line: one scope per line, read exactly as the compact per-line
  // LineSection reads it.
  return lines.map((line) => ({
    lineId: line.line_id,
    lineName: line.line_name,
    throughput: line.throughput,
    line_balance: line.line_balance,
    stations: line.stations,
    buffers: line.buffers,
    total_operators: line.total_operators ?? 0,
    labor_utilization: line.labor_utilization ?? 0,
    operators_needed: line.operators_needed,
    operators_supplied: line.operators_supplied,
    target_throughput: line.target_throughput,
    takt_time: line.takt_time,
    throughput_gap_pct: line.throughput_gap_pct,
    isSingleLine: false,
  }));
}

/**
 * The effective target throughput a scope is judged against: its own
 * target_throughput when set, else the fallback global target. This is the
 * same choice the compact panel makes (its private effectiveTarget returns
 * line.target_throughput ?? fallbackTarget, and the single-line path passes the
 * global target directly, which equals fallback when the scope target is
 * null). Pure: no side effects, no input mutation.
 */
export function effectiveTargetFor(scope: LineScopeView, fallback: number): number {
  return scope.target_throughput ?? fallback;
}

/**
 * The effective takt a scope is judged against: its own takt_time when set,
 * else the scope's balance takt (line_balance.takt_time), else null. This
 * matches the compact panel exactly: its private effectiveTakt returns
 * line.takt_time ?? line.line_balance.takt_time ?? null, and the single-line
 * path uses result.line_balance.takt_time ?? null (the aggregate scope carries
 * no own takt_time, so it falls through to the balance takt). Pure: no side
 * effects, no input mutation.
 */
export function effectiveTaktFor(scope: LineScopeView): number | null {
  return scope.takt_time ?? scope.line_balance.takt_time ?? null;
}

// ---------------------------------------------------------------------------
// Results-side mappers
// ---------------------------------------------------------------------------

/**
 * Build the five-category time split for one station, matching the exact
 * stacked bar the compact ResultsPanel draws today.
 *
 * The compact panel computes each width as:
 *   busy    = max(0, min(100, utilization))
 *   starved = max(0, min(100, starved_pct))
 *   blocked = max(0, min(100, blocked_pct))
 *   down    = max(0, min(100, down_pct))
 *   idle    = max(0, 100 - busy - starved - blocked - down)
 * so the five values are each clamped to 0..100 and, with idle as the
 * non-negative remainder, cover the whole station (they sum to 100 within a
 * small tolerance; idle absorbs any rounding slack and the clamps guard
 * against malformed or out-of-range inputs).
 *
 * This mapper reproduces that formula exactly so the chart and the compact bar
 * agree. The four busy, starved, blocked, and down inputs come from the
 * StationMetrics fields utilization, starved_pct, blocked_pct, and down_pct.
 * When any of those required fields is absent (not a finite number), the mapper
 * returns an "unavailable" marker rather than throwing, so one station with
 * missing data never aborts the rest of the overlay.
 *
 * Pure: it reads the station and returns a fresh ChartData value without
 * mutating the input or performing any side effect.
 */
export function timeSplitSeries(station: StationMetrics): ChartData {
  // Required fields for the split. idle is derived, not read, so only these
  // four need to be present and finite.
  const required: Array<[string, unknown]> = [
    ["utilization", station.utilization],
    ["starved_pct", station.starved_pct],
    ["blocked_pct", station.blocked_pct],
    ["down_pct", station.down_pct],
  ];
  for (const [name, raw] of required) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return {
        kind: "unavailable",
        reason: `Station ${station.station_id} is missing ${name} for the time split.`,
      };
    }
  }

  const clamp = (n: number): number => Math.max(0, Math.min(100, n));

  const busy = clamp(station.utilization);
  const starved = clamp(station.starved_pct);
  const blocked = clamp(station.blocked_pct);
  const down = clamp(station.down_pct);
  const idle = Math.max(0, 100 - busy - starved - blocked - down);

  const series: ChartSeries[] = [
    {
      seriesName: station.station_name,
      points: [
        { category: "busy", value: busy, unit: "%" },
        { category: "starved", value: starved, unit: "%" },
        { category: "blocked", value: blocked, unit: "%" },
        { category: "down", value: down, unit: "%" },
        { category: "idle", value: idle, unit: "%" },
      ],
    },
  ];

  return { kind: "ok", series };
}

/**
 * Build the throughput comparison for one scope: producing now, demand needed,
 * and line ceiling, each expressed in the same throughput unit (units per
 * hour), matching the exact three values the compact ResultsPanel reports in
 * its capacity snapshot.
 *
 * The three values are:
 *   producing now = scope.throughput (the capacity snapshot "Producing now")
 *   demand needed = effectiveTarget, the effective target the shared selector
 *                   returns for this scope (the panel's "Demand needs"), passed
 *                   in by the caller so the chart judges the scope against the
 *                   identical target the compact panel uses.
 *   line ceiling  = 3600 / line_balance.slowest_station_cycle when that slowest
 *                   cycle is positive, else 0. This is the exact formula the
 *                   compact panel computes for its "Line ceiling"
 *                   (theoreticalMax = slowest > 0 ? 3600 / slowest : 0).
 *
 * All three are clamped to non-negative so a malformed or out-of-range input
 * never produces a negative bar. The producing-now value is required and must
 * be a finite number; when it or the slowest-cycle field is absent (not a
 * finite number), the mapper returns an "unavailable" marker rather than
 * throwing, so one scope with missing data never aborts the rest of the
 * overlay. effectiveTarget is supplied by the caller from the shared selector,
 * which always yields a finite number (the scope target or the fallback), so it
 * is used directly and only clamped to non-negative.
 *
 * Pure: it reads the scope and the supplied target and returns a fresh
 * ChartData value without mutating either input or performing any side effect.
 */
export function throughputComparisonSeries(
  scope: LineScopeView,
  effectiveTarget: number
): ChartData {
  // Required numeric fields for the comparison. The line ceiling is derived
  // from slowest_station_cycle, so that field must be present and finite; a
  // non-positive slowest cycle is valid and yields a ceiling of 0.
  const required: Array<[string, unknown]> = [
    ["throughput", scope.throughput],
    ["slowest_station_cycle", scope.line_balance.slowest_station_cycle],
  ];
  for (const [name, raw] of required) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return {
        kind: "unavailable",
        reason: `Scope ${scope.lineName} is missing ${name} for the throughput comparison.`,
      };
    }
  }

  const nonNegative = (n: number): number => Math.max(0, n);

  const producingNow = nonNegative(scope.throughput);
  const demandNeeded = nonNegative(effectiveTarget);
  const slowest = scope.line_balance.slowest_station_cycle;
  // Same ceiling formula the compact panel uses: a line can never run faster
  // than its slowest station (3600 seconds divided by the slowest cycle). A
  // non-positive slowest cycle means no ceiling is defined, so it reads 0.
  const lineCeiling = slowest > 0 ? nonNegative(3600 / slowest) : 0;

  const series: ChartSeries[] = [
    {
      seriesName: scope.lineName,
      points: [
        { category: "producing now", value: producingNow, unit: "/hr" },
        { category: "demand needed", value: demandNeeded, unit: "/hr" },
        { category: "line ceiling", value: lineCeiling, unit: "/hr" },
      ],
    },
  ];

  return { kind: "ok", series };
}

/**
 * Build the labor comparison for one scope: operators needed versus operators
 * supplied, both on the same operator-count scale, matching the exact two
 * values the compact ResultsPanel reports in its Labor section.
 *
 * Two source shapes feed this one comparison, mirroring the compact panel:
 *
 *   1. Per-line scope (a PerLineResult in a multi-line result). The panel reads
 *      scope.operators_needed and scope.operators_supplied directly ("Operators
 *      needed vs supplied"). When both are present and finite, those two values
 *      are used as-is, needed against supplied.
 *
 *   2. Aggregate single-line scope (projected from the SimulationResult). That
 *      scope carries no per-line operators_needed or operators_supplied, so the
 *      panel falls back to the whole-factory picture: total_operators is the
 *      staffed (supplied) count, and the per-pool operators[] detail reports
 *      each pool's required versus supplied. This mapper sums the pools so that
 *      needed = sum of each pool's required and supplied = sum of each pool's
 *      supplied, which reconciles with total_operators while staying on the
 *      same operator-count scale as the needed figure.
 *
 * Both values are clamped to non-negative so a malformed or out-of-range input
 * never produces a negative bar. When neither source is present (no finite
 * per-line pair and no usable operators[] pool detail), the mapper returns an
 * "unavailable" marker rather than throwing, so one scope with missing labor
 * data never aborts the rest of the overlay.
 *
 * Pure: it reads the scope and returns a fresh ChartData value without mutating
 * the input or performing any side effect.
 */
export function laborSeries(scope: LineScopeView): ChartData {
  const nonNegative = (n: number): number => Math.max(0, n);
  const isFinite = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n);

  let needed: number | null = null;
  let supplied: number | null = null;

  // Source 1: per-line counts carried directly on the scope (PerLineResult).
  if (isFinite(scope.operators_needed) && isFinite(scope.operators_supplied)) {
    needed = scope.operators_needed as number;
    supplied = scope.operators_supplied as number;
  } else if (scope.operators && scope.operators.length > 0) {
    // Source 2: aggregate fallback. Sum the per-pool required versus supplied
    // from operators[], the same per-pool detail the compact panel reads on the
    // aggregate/single-line path. Only count pools whose required and supplied
    // are both finite numbers.
    let requiredSum = 0;
    let suppliedSum = 0;
    let counted = 0;
    for (const op of scope.operators) {
      if (isFinite(op.required) && isFinite(op.supplied)) {
        requiredSum += op.required;
        suppliedSum += op.supplied;
        counted += 1;
      }
    }
    if (counted > 0) {
      needed = requiredSum;
      supplied = suppliedSum;
    }
  }

  if (needed === null || supplied === null) {
    return {
      kind: "unavailable",
      reason: `Scope ${scope.lineName} is missing operator counts for the labor comparison.`,
    };
  }

  const series: ChartSeries[] = [
    {
      seriesName: scope.lineName,
      points: [
        { category: "operators needed", value: nonNegative(needed), unit: "operators" },
        { category: "operators supplied", value: nonNegative(supplied), unit: "operators" },
      ],
    },
  ];

  return { kind: "ok", series };
}

/**
 * Build the scrap-and-setup contributions across a list of stations, matching
 * exactly the positive predicate the compact ResultsPanel uses to decide which
 * stations show a scrap or setup note.
 *
 * The compact panel renders a station's scrap note only when
 * scrap_pct != null and scrap_pct > 0, and its setup note only when
 * setup_impact != null and setup_impact > 0. This mapper applies the same rule
 * at the station level: a station is included when its scrap_pct is greater
 * than 0 OR its setup_impact is greater than 0, and is omitted when both are 0
 * (or absent). Absent or non-finite values are treated as 0, so an unset field
 * never counts as a positive contribution and never includes a station on its
 * own.
 *
 * Each included station contributes one series named for the station, holding
 * two separately identifiable points: its scrap contribution (scrap_pct, unit
 * "%") and its setup contribution (setup_impact, unit "x cycle time"). A value
 * that is absent or non-finite is reported as 0 for that point, so a station
 * included for a positive scrap shows a 0 setup contribution and vice versa.
 * Both contributions are clamped to non-negative so a malformed or out-of-range
 * input never produces a negative bar.
 *
 * This mapper always returns an "ok" result (never "unavailable" and never a
 * throw). When no station satisfies the positive predicate, it returns an ok
 * result with an empty series list, which the chart renders as an empty-but-ok
 * scrap-and-setup visualization per the design's error-handling rules.
 *
 * Pure: it reads the stations and returns a fresh ChartData value without
 * mutating the input or performing any side effect.
 */
export function scrapSetupSeries(stations: StationMetrics[]): ChartData {
  const nonNegative = (n: number): number => Math.max(0, n);
  // Read a station field as a finite number, treating absent or non-finite
  // values (null, undefined, NaN, Infinity) as 0 so they never register as a
  // positive contribution.
  const asNumber = (raw: unknown): number =>
    typeof raw === "number" && Number.isFinite(raw) ? raw : 0;

  const series: ChartSeries[] = [];

  for (const station of stations) {
    const scrap = asNumber(station.scrap_pct);
    const setup = asNumber(station.setup_impact);

    // Positive predicate: include the station only when scrap or setup is
    // greater than 0; omit it when both are 0 (or absent).
    if (scrap <= 0 && setup <= 0) {
      continue;
    }

    series.push({
      seriesName: station.station_name,
      points: [
        { category: "scrap", value: nonNegative(scrap), unit: "%" },
        { category: "setup", value: nonNegative(setup), unit: "x cycle time" },
      ],
    });
  }

  return { kind: "ok", series };
}

// ---------------------------------------------------------------------------
// Recommendations-side mappers
// ---------------------------------------------------------------------------

/**
 * Build the recommendation-gain series: one point per recommendation holding
 * its estimated throughput gain, clamped to the range 0.00 to 100.00 percent,
 * and ordered from the highest gain to the lowest.
 *
 * The ordering reuses sortByImpact from RecommendationsPanel, the single source
 * of truth the compact Optimize stage uses to rank recommendations by
 * estimated_throughput_gain_pct descending. Clamping is applied to the value
 * each point reports (not to the sort key) so a malformed or out-of-range gain,
 * for example a negative value or one above 100, never produces a bar outside
 * 0..100. Because the clamp is monotonic on this range and sortByImpact ranks
 * by the raw gain descending, the emitted values are also non-increasing.
 *
 * This mapper always returns an "ok" result (never "unavailable" and never a
 * throw). For an empty recommendation list it returns an ok result with a
 * single series whose points list is empty, so no recommendation is ever
 * dropped and the count of points equals the count of input recommendations.
 *
 * Pure: it reads the recommendations and returns a fresh ChartData value
 * without mutating the input (sortByImpact sorts a copy) or performing any side
 * effect.
 */
export function recommendationGainSeries(recs: Recommendation[]): ChartData {
  const clampPct = (n: number): number => {
    // Treat an absent or non-finite gain as 0 so it never produces a broken
    // bar, then clamp into the 0.00..100.00 range.
    const value = typeof n === "number" && Number.isFinite(n) ? n : 0;
    return Math.max(0, Math.min(100, value));
  };

  // Order highest-to-lowest by the exact rule the compact Optimize stage uses.
  const ordered = sortByImpact(recs);

  const points: ChartDatum[] = ordered.map((rec) => ({
    category: rec.element_name,
    value: clampPct(rec.estimated_throughput_gain_pct),
    unit: "%",
  }));

  return {
    kind: "ok",
    series: [{ seriesName: "Estimated throughput gain", points }],
  };
}

/**
 * The four known recommendation problem keys mapped to their human display
 * label. These are the only four values the Recommendations chart set presents
 * as recognized problem labels; any other value is flagged as unrecognized.
 */
const KNOWN_PROBLEM_DISPLAY: Record<KnownProblem, string> = {
  defect_waste: "Defect waste",
  setup_waste: "Setup waste",
  operation_move: "Operation move",
  labor_constraint: "Labor constraint",
};

/**
 * Map a recommendation problem key to its display information.
 *
 * When problem is one of the four known keys (defect_waste, setup_waste,
 * operation_move, labor_constraint), the result carries known true and the
 * matching display label, for example "Defect waste". Any other value is
 * flagged with known false so the chart renders an "unrecognized" indication,
 * and it is never dropped. The unknown display is a reasonable, readable
 * rendering of the raw value: underscores become spaces and the first letter is
 * capitalized, with an empty or whitespace-only value shown as "Unknown".
 *
 * Pure: it reads the problem string and returns a fresh ProblemLabelInfo value
 * without mutating any input or performing any side effect.
 */
export function problemLabelInfo(problem: string): ProblemLabelInfo {
  const raw = problem;

  if (Object.prototype.hasOwnProperty.call(KNOWN_PROBLEM_DISPLAY, raw)) {
    return {
      raw,
      display: KNOWN_PROBLEM_DISPLAY[raw as KnownProblem],
      known: true,
    };
  }

  // Unknown: build a readable display without claiming it is recognized.
  const spaced = (raw ?? "").replace(/_/g, " ").trim();
  const display =
    spaced.length > 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "Unknown";

  return { raw, display, known: false };
}

/**
 * Build a projected before-and-after comparison derived only from its two
 * inputs.
 *
 * gainPct is clamped to the range 0 to 100 so a malformed or out-of-range gain,
 * for example a negative value or one above 100, never distorts the projection.
 * after equals before * (1 + clampedGain / 100), so for a non-negative clamped
 * gain after is always greater than or equal to before. No value outside the
 * two inputs is introduced. An absent or non-finite before or gainPct is
 * treated as 0 so the result stays finite.
 *
 * Pure: it reads the two numbers and returns a fresh BeforeAfter value without
 * mutating any input or performing any side effect.
 */
export function projectedBeforeAfter(before: number, gainPct: number): BeforeAfter {
  const safeBefore =
    typeof before === "number" && Number.isFinite(before) ? before : 0;
  const safeGain =
    typeof gainPct === "number" && Number.isFinite(gainPct) ? gainPct : 0;

  const clampedGain = Math.max(0, Math.min(100, safeGain));
  const after = safeBefore * (1 + clampedGain / 100);

  return { before: safeBefore, after, gainPct: clampedGain };
}

// ---------------------------------------------------------------------------
// Multi-line attribution and shared-station split
// ---------------------------------------------------------------------------

/**
 * Attribute a per-station chart point to exactly one line.
 *
 * In a multi-line result every per-station value must carry the lineId of the
 * single line it belongs to, so no point is unattributed or double-attributed
 * (Req 8.3). This small helper stamps a lineId onto a datum, returning a fresh
 * datum (the input is never mutated) so callers can build attributed points
 * without touching the source value.
 *
 * Pure: it reads the datum and the lineId and returns a fresh ChartDatum
 * without mutating any input or performing any side effect.
 */
export function attributeToLine(datum: ChartDatum, lineId: string): ChartDatum {
  return { ...datum, lineId };
}

/**
 * Attribute every point of a station's time-split series to one line.
 *
 * Given the ok time-split ChartData for a single station and the lineId of the
 * line that station belongs to in a multi-line result, this returns a fresh
 * ChartData whose every point carries exactly that one lineId (Req 8.3). An
 * "unavailable" input is passed through unchanged, so a station with missing
 * data never aborts the rest of the overlay. The source is never mutated; fresh
 * series and point objects are produced.
 *
 * Pure: it reads the ChartData and the lineId and returns a fresh ChartData
 * without mutating any input or performing any side effect.
 */
export function attributeStationSeries(data: ChartData, lineId: string): ChartData {
  if (data.kind !== "ok") {
    return data;
  }
  const series: ChartSeries[] = data.series.map((ser) => ({
    seriesName: ser.seriesName,
    points: ser.points.map((p) => attributeToLine(p, lineId)),
  }));
  return { kind: "ok", series };
}

/**
 * Build the per-line busy split for a station that is shared across two or more
 * lines, reading each line's portion from the station's line_shares.
 *
 * A shared station carries a line_shares array (LineTimeShare[]), one entry per
 * line it serves, each holding that line's busy_pct at the station. The station
 * busy total is the station's own utilization (its busy share). For the
 * requested lineIds, this mapper emits one point per line, valued at that line's
 * busy_pct from the matching line_shares entry and attributed to that line via
 * lineId, so the per-line busy portions sum to the station busy total within a
 * tolerance of 0.01 (Req 8.4). The backend populates line_shares so the sum
 * reconciles with the station busy total; this mapper does not rescale, it
 * reports the backend's split verbatim.
 *
 * When line_shares is absent or empty, or when it is missing an entry for one
 * or more of the requested lineIds, the mapper returns an "unavailable" marker
 * for the whole split rather than fabricating a portion, so the affected lines
 * show the split is unavailable while every other result still renders
 * (Req 8.6). It never throws.
 *
 * Pure: it reads the station and the requested lineIds and returns a fresh
 * ChartData value without mutating either input or performing any side effect.
 */
export function sharedStationSplit(
  station: StationMetrics,
  lineIds: string[]
): ChartData {
  const shares = station.line_shares;
  if (!shares || shares.length === 0) {
    return {
      kind: "unavailable",
      reason: `Station ${station.station_id} has no line_shares for the shared split.`,
    };
  }

  // Index the per-line shares by line_id for an exact lookup. Do not fabricate a
  // portion for a line that has no entry.
  const byLine = new Map<string, number>();
  for (const share of shares) {
    if (typeof share.busy_pct === "number" && Number.isFinite(share.busy_pct)) {
      byLine.set(share.line_id, share.busy_pct);
    }
  }

  const points: ChartDatum[] = [];
  for (const lineId of lineIds) {
    const busy = byLine.get(lineId);
    if (busy === undefined) {
      // One or more requested lines are missing a line_shares entry: the split
      // is unavailable for the affected lines, so the whole split is reported
      // unavailable rather than partially fabricated.
      return {
        kind: "unavailable",
        reason: `Station ${station.station_id} is missing a line_shares entry for line ${lineId}.`,
      };
    }
    points.push({
      category: lineId,
      value: Math.max(0, busy),
      unit: "%",
      lineId,
    });
  }

  const series: ChartSeries[] = [
    {
      seriesName: station.station_name,
      points,
    },
  ];

  return { kind: "ok", series };
}

// ---------------------------------------------------------------------------
// Text alternative
// ---------------------------------------------------------------------------

/**
 * Build the text-alternative rows for a chart series.
 *
 * The text alternative conveys the same information a chart conveys visually,
 * so understanding never depends on seeing the graphic or distinguishing
 * colors (Req 9.1, 9.7). This mapper flattens one ChartSeries into exactly one
 * row per data point, in the same order the points appear, each row carrying
 * the identical category label and numeric value as the point it represents.
 * The optional unit and lineId are carried through unchanged so a renderer can
 * present the paired label, value, and unit as readable text.
 *
 * The result length always equals series.points.length (one row per point, no
 * row added and none dropped), so every data point is conveyed. Each returned
 * row is a fresh ChartDatum object, so the output can be rendered or mutated
 * without touching the source series.
 *
 * Pure: it reads the series and returns a fresh array of fresh rows without
 * mutating the input or performing any side effect.
 */
export function toTextAlternativeRows(series: ChartSeries): ChartDatum[] {
  return series.points.map((point) => {
    const row: ChartDatum = {
      category: point.category,
      value: point.value,
    };
    if (point.unit !== undefined) {
      row.unit = point.unit;
    }
    if (point.lineId !== undefined) {
      row.lineId = point.lineId;
    }
    return row;
  });
}
