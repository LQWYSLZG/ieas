/**
 * chartRegistry.ts - the single source of truth for the bounded chart sets.
 *
 * This module enforces the chart-count bounds for the two expanded views:
 *   - the Results chart set holds exactly 4 charts (Req 6.1, 6.7)
 *   - the Recommendations chart set holds exactly 3 charts (Req 7.1, 7.7)
 *
 * The seven chart components (TimeSplitChart, ThroughputComparisonChart,
 * LaborChart, ScrapSetupChart, RecommendationGainChart, ProblemLabelChart,
 * ProjectedBeforeAfterChart) are implemented in later tasks and do not exist
 * yet. To keep this module compilable and to keep the count bound as the single
 * source of truth, the registry does NOT import those component modules.
 * Instead it models each chart as a stable descriptor: a stable id and a human
 * title (plus a typed key equal to the id). A later composition task maps each
 * descriptor id to its actual rendered component, so the component wiring lives
 * outside this count-bounding registry.
 *
 * Keeping the registry as pure descriptor metadata means the chart-count bounds
 * are verifiable in isolation (see the paired registry-bounds unit test) and do
 * not depend on any component being written first.
 *
 * Project rule: no em dashes or en dashes anywhere in this file. Only ASCII
 * hyphens are used.
 */

// ---------------------------------------------------------------------------
// Stable chart ids
// ---------------------------------------------------------------------------

/**
 * The four stable ids of the Results chart set. Each id matches the planned
 * component that renders it (TimeSplitChart, ThroughputComparisonChart,
 * LaborChart, ScrapSetupChart) and is the key a later composition task maps to
 * the actual component.
 */
export type ResultsChartId =
  | "time_split"
  | "throughput_comparison"
  | "labor"
  | "scrap_setup";

/**
 * The three stable ids of the Recommendations chart set. Each id matches the
 * planned component that renders it (RecommendationGainChart, ProblemLabelChart,
 * ProjectedBeforeAfterChart).
 */
export type RecommendationsChartId =
  | "recommendation_gain"
  | "problem_label"
  | "projected_before_after";

/**
 * Every chart id across both sets.
 */
export type ChartId = ResultsChartId | RecommendationsChartId;

// ---------------------------------------------------------------------------
// Chart descriptor
// ---------------------------------------------------------------------------

/**
 * A single chart in a bounded chart set, described by metadata only.
 *
 * id    is the stable identifier a later composition task maps to the actual
 *       chart component; it never changes.
 * key   is the same stable id, typed, kept as a convenience for consumers that
 *       want the narrow literal type when switching on the chart.
 * title is the human-readable chart title shown in the expanded view header.
 *
 * The descriptor deliberately carries no component reference, so this module
 * stays independent of the not-yet-implemented chart component files.
 */
export interface ChartDescriptor<Id extends ChartId = ChartId> {
  id: Id;
  key: Id;
  title: string;
}

// ---------------------------------------------------------------------------
// The two bounded chart sets
// ---------------------------------------------------------------------------

/**
 * The Results chart set: exactly 4 charts (Req 6.1, 6.7). This list, and its
 * length, is the single source of truth for the Results chart-count bound. No
 * chart type may be added beyond these four.
 */
export const RESULTS_CHARTS: ReadonlyArray<ChartDescriptor<ResultsChartId>> = [
  { id: "time_split", key: "time_split", title: "Station time split" },
  {
    id: "throughput_comparison",
    key: "throughput_comparison",
    title: "Throughput comparison",
  },
  { id: "labor", key: "labor", title: "Labor needed vs supplied" },
  { id: "scrap_setup", key: "scrap_setup", title: "Scrap and setup contributions" },
] as const;

/**
 * The Recommendations chart set: exactly 3 charts (Req 7.1, 7.7). This list,
 * and its length, is the single source of truth for the Recommendations
 * chart-count bound. No chart type may be added beyond these three.
 */
export const RECOMMENDATIONS_CHARTS: ReadonlyArray<
  ChartDescriptor<RecommendationsChartId>
> = [
  {
    id: "recommendation_gain",
    key: "recommendation_gain",
    title: "Estimated throughput gain",
  },
  { id: "problem_label", key: "problem_label", title: "Problem labels" },
  {
    id: "projected_before_after",
    key: "projected_before_after",
    title: "Projected before and after",
  },
] as const;

/**
 * The exact number of charts allowed in each set, exported so the bound is
 * stated once and reused by both the registry and its test.
 */
export const RESULTS_CHART_COUNT = 4 as const;
export const RECOMMENDATIONS_CHART_COUNT = 3 as const;
