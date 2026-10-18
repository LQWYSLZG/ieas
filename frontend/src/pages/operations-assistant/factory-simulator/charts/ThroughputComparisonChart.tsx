/**
 * ThroughputComparisonChart.tsx - the Results throughput comparison chart.
 *
 * This is one of the four Results charts (Req 6.1). It renders a grouped
 * comparison bar for a single scope showing the three throughput values the
 * compact ResultsPanel reports in its capacity snapshot: producing now, demand
 * needed, and line ceiling, each expressed in the same throughput unit (units
 * per hour). The three values come from the pure mapper
 * throughputComparisonSeries(scope, effectiveTarget) in chartData.ts, so this
 * component introduces no data value of its own (Req 5.3) and computes entirely
 * client-side (Req 5.1, 5.4).
 *
 * Accessibility (Reqs 9.1, 9.2, 9.7): every category is distinguished by at
 * least one non-color means. Each bar carries a visible text label (the
 * category name), a fill pattern (diagonal hatch, dots, or cross-hatch) layered
 * over its fill color, and a direct numeric text value printed next to the bar.
 * A grayscale viewer can tell the three bars apart by label, pattern, and
 * number alone. The ChartTextAlternative table repeats the same series name,
 * category labels, and numeric values as readable text, so understanding never
 * depends on seeing the bars.
 *
 * Error handling (Reqs 5.5, 5.7, per the design's Error Handling section):
 *   - When the mapper returns an "unavailable" marker (a required field is
 *     absent), the chart renders a short "data unavailable" message in place of
 *     the bars and renders no text-alternative table, so one scope with missing
 *     data never aborts the rest of the overlay.
 *   - The mapper call is wrapped so an unexpected throw is caught and rendered
 *     as a "chart cannot be displayed" state, preserving the surrounding
 *     overlay and never aborting the remaining charts.
 *
 * Styling matches the dark-panel inline-style conventions of the sibling
 * Results and Recommendations panels. Pure SVG and CSS, no new dependency.
 *
 * Project rule: no em dashes or en dashes anywhere in this file. Only ASCII
 * hyphens are used.
 */

import type { ChartData, ChartSeries, LineScopeView } from "./chartData";
import { throughputComparisonSeries } from "./chartData";
import { ChartTextAlternative } from "./ChartTextAlternative";

export interface ThroughputComparisonChartProps {
  /** The scope (aggregate single-line, or one line of a multi-line result). */
  scope: LineScopeView;
  /**
   * The effective target throughput this scope is judged against, from the
   * shared selector (effectiveTargetFor), so the chart uses the identical
   * target the compact panel selects for the scope (Req 8.5).
   */
  effectiveTarget: number;
}

// ---------------------------------------------------------------------------
// Inline styles, matching the dark-panel conventions of the sibling panels.
// Color is never the only signal: each bar also carries a text label, a fill
// pattern, and a numeric text value.
// ---------------------------------------------------------------------------

const wrapperStyle: React.CSSProperties = {
  padding: "10px 12px",
  background: "rgba(45, 90, 142, 0.15)",
  borderRadius: "6px",
  border: "1px solid rgba(45, 90, 142, 0.3)",
  marginBottom: "10px",
};

const messageStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "#a8b8e8",
  lineHeight: 1.4,
  margin: 0,
};

const barRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  marginBottom: "8px",
};

const barLabelStyle: React.CSSProperties = {
  flex: "0 0 110px",
  fontSize: "0.72rem",
  color: "#e6ecff",
};

const barTrackStyle: React.CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  height: "18px",
  background: "#0f1a26",
  borderRadius: "4px",
  overflow: "hidden",
};

const barValueStyle: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: "0.72rem",
  fontWeight: 600,
  color: "#fff",
  fontVariantNumeric: "tabular-nums",
  minWidth: "64px",
  textAlign: "right",
};

const textAltWrapperStyle: React.CSSProperties = {
  marginTop: "10px",
};

// A fill color and a distinct SVG fill pattern per category, so each of the
// three bars is identifiable in grayscale by its pattern (not color) alone, in
// addition to its text label and numeric value.
type BarStyle = { color: string; patternId: string };

const CATEGORY_STYLES: Record<string, BarStyle> = {
  "producing now": { color: "#28a745", patternId: "tc-pattern-solid" },
  "demand needed": { color: "#d4a017", patternId: "tc-pattern-diagonal" },
  "line ceiling": { color: "#5dade2", patternId: "tc-pattern-dots" },
};

const FALLBACK_BAR_STYLE: BarStyle = {
  color: "#8898c8",
  patternId: "tc-pattern-solid",
};

/**
 * Format a numeric value as readable text. Non-finite values show a plain dash
 * so a malformed value never renders as "NaN". A whole number keeps no
 * decimals; otherwise up to two decimals are shown.
 */
function formatValue(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * The SVG pattern definitions shared by the bars. Each pattern paints the
 * category color as a background and overlays a distinct, color-independent
 * texture (diagonal lines, dots) so grayscale viewers can tell bars apart.
 * Rendered once per chart inside a zero-size svg.
 */
function PatternDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        {/* Solid: flat fill, used for producing now. */}
        <pattern id="tc-pattern-solid" width="8" height="8" patternUnits="userSpaceOnUse">
          <rect width="8" height="8" fill="currentColor" />
        </pattern>
        {/* Diagonal hatch, used for demand needed. */}
        <pattern id="tc-pattern-diagonal" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="currentColor" />
          <path d="M0,6 L6,0" stroke="#0f1a26" strokeWidth="1.5" />
        </pattern>
        {/* Dots, used for line ceiling. */}
        <pattern id="tc-pattern-dots" width="8" height="8" patternUnits="userSpaceOnUse">
          <rect width="8" height="8" fill="currentColor" />
          <circle cx="4" cy="4" r="1.6" fill="#0f1a26" />
        </pattern>
      </defs>
    </svg>
  );
}

/**
 * Render a single comparison bar: a text label, a filled-and-patterned track
 * scaled to the value against the series maximum, and the numeric value as
 * readable text with its unit.
 */
function ComparisonBar({
  category,
  value,
  unit,
  maxValue,
}: {
  category: string;
  value: number;
  unit?: string;
  maxValue: number;
}) {
  const barStyle = CATEGORY_STYLES[category] ?? FALLBACK_BAR_STYLE;
  // Scale width against the series maximum. When every value is 0 (maxValue is
  // 0), the bars stay empty rather than dividing by zero.
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  const widthPct = maxValue > 0 ? Math.min(100, (safeValue / maxValue) * 100) : 0;
  const valueText = unit ? `${formatValue(value)} ${unit}` : formatValue(value);

  return (
    <div style={barRowStyle}>
      <span style={barLabelStyle}>{category}</span>
      <div
        style={barTrackStyle}
        role="img"
        aria-label={`${category}: ${valueText}`}
      >
        <svg
          width="100%"
          height="100%"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
          style={{ display: "block", color: barStyle.color }}
        >
          <rect
            x="0"
            y="0"
            width={`${widthPct}%`}
            height="100%"
            fill={`url(#${barStyle.patternId})`}
          />
        </svg>
      </div>
      <span style={barValueStyle}>{valueText}</span>
    </div>
  );
}

/**
 * Render the grouped comparison bars for an ok series. The three bars share one
 * scale so they are directly comparable, and the series name labels the group.
 */
function ComparisonBars({ series }: { series: ChartSeries }) {
  const maxValue = series.points.reduce((max, point) => {
    const v = Number.isFinite(point.value) ? Math.max(0, point.value) : 0;
    return v > max ? v : max;
  }, 0);

  return (
    <div>
      <PatternDefs />
      {series.points.map((point, index) => (
        <ComparisonBar
          key={`${point.category}-${index}`}
          category={point.category}
          value={point.value}
          unit={point.unit}
          maxValue={maxValue}
        />
      ))}
    </div>
  );
}

export function ThroughputComparisonChart({
  scope,
  effectiveTarget,
}: ThroughputComparisonChartProps) {
  // Wrap the mapper call so a missing required field renders an "unavailable"
  // message and an unexpected throw renders a "chart cannot be displayed"
  // state, never aborting the rest of the overlay (Reqs 5.5, 5.7).
  let data: ChartData;
  try {
    data = throughputComparisonSeries(scope, effectiveTarget);
  } catch {
    return (
      <div style={wrapperStyle}>
        <p style={messageStyle}>This chart cannot be displayed.</p>
      </div>
    );
  }

  if (data.kind === "unavailable") {
    return (
      <div style={wrapperStyle}>
        <p style={messageStyle}>Throughput comparison data is unavailable.</p>
      </div>
    );
  }

  // The mapper produces exactly one series (producing now, demand needed, line
  // ceiling) for the scope.
  const series = data.series[0];
  if (!series) {
    return (
      <div style={wrapperStyle}>
        <p style={messageStyle}>Throughput comparison data is unavailable.</p>
      </div>
    );
  }

  return (
    <div style={wrapperStyle}>
      <ComparisonBars series={series} />
      <div style={textAltWrapperStyle}>
        <ChartTextAlternative
          series={series}
          caption={`Throughput comparison for ${series.seriesName} as text`}
        />
      </div>
    </div>
  );
}

export default ThroughputComparisonChart;
