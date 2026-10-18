/**
 * ProjectedBeforeAfterChart.tsx - the before-and-after projection comparison
 * for the Recommendations view.
 *
 * This is the third of the three Recommendations charts. It renders two bars on
 * one shared throughput scale: the "before" value (for example a scope's
 * producing-now throughput) and the projected "after" value once an estimated
 * throughput gain is applied. Both the clamped gain and the after value come
 * from the pure projectedBeforeAfter mapper, so the visual and its text
 * alternative agree exactly and no value is ever introduced that is not derived
 * from the two supplied inputs, which themselves come only from Result_Data
 * (Req 7.5). No new backend call is made; the projection is pure client-side
 * arithmetic over values the frontend already holds.
 *
 * Accessibility (Reqs 9.1, 9.2, 9.7): understanding never depends on seeing the
 * bars or distinguishing color. Each bar carries a visible text label (before,
 * after) and a direct numeric text value next to it, the applied gain is shown
 * as readable text, and the shared ChartTextAlternative table conveys the same
 * series name, category labels, and numeric values as readable text. Color is
 * only ever a secondary signal layered on top of the text labels and numbers.
 *
 * Error handling (Reqs 5.5, 5.7): the mapper call is wrapped so that an
 * "unavailable" marker renders a short "data unavailable" message instead of
 * bars, and an unexpected throw is caught and rendered as a "chart cannot be
 * displayed" state. Neither case aborts the rest of the overlay; this one chart
 * degrades on its own while every other chart keeps its last rendered state.
 * The before value and gain are validated up front: when either is absent or
 * non-finite, the chart shows the "data unavailable" state rather than drawing
 * a broken bar.
 *
 * This is a pure presentational component: props in, markup out. It holds no
 * state, performs no I/O, and reads nothing beyond its props.
 *
 * Project rule: no em dashes or en dashes anywhere in this file. Only ASCII
 * hyphens are used.
 */

import type { BeforeAfter, ChartSeries } from "./chartData";
import { projectedBeforeAfter } from "./chartData";
import ChartTextAlternative from "./ChartTextAlternative";

export interface ProjectedBeforeAfterChartProps {
  /**
   * The starting value the projection builds on, for example a scope's
   * producing-now throughput, derived only from Result_Data. This is passed
   * straight to projectedBeforeAfter as the before value.
   */
  before: number;
  /**
   * The estimated throughput gain percentage to apply. The mapper clamps it to
   * the range 0 to 100, so an out-of-range or negative value never distorts the
   * projection.
   */
  gainPct: number;
  /**
   * An optional unit label for the two values, for example "/hr". Shown next to
   * the numeric text and carried into the text alternative.
   */
  unit?: string;
  /**
   * An optional chart title shown above the bars and used as the text
   * alternative caption. Defaults to a descriptive label.
   */
  title?: string;
}

// Shared inline styles, matching the dark-panel conventions of the sibling
// RecommendationGainChart and the ChartTextAlternative table. Color is never
// the only signal: every bar is paired with a visible text label and a numeric
// text value.
const containerStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  borderRadius: "8px",
  padding: "12px 14px",
  color: "#e6ecff",
};

const titleStyle: React.CSSProperties = {
  margin: "0 0 10px 0",
  fontSize: "0.82rem",
  fontWeight: 600,
  color: "#fff",
};

const messageStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.8rem",
  color: "#a8b8e8",
  lineHeight: 1.4,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  marginBottom: "8px",
};

const labelStyle: React.CSSProperties = {
  flex: "0 0 30%",
  minWidth: 0,
  fontSize: "0.76rem",
  color: "#e6ecff",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const trackStyle: React.CSSProperties = {
  flex: "1 1 auto",
  height: "16px",
  background: "rgba(255,255,255,0.06)",
  borderRadius: "4px",
  overflow: "hidden",
};

// The two bars use distinct fills, but color is only a secondary signal: the
// text label and the numeric value carry the meaning on their own.
const beforeFillStyle: React.CSSProperties = {
  height: "100%",
  background: "#6b7aa8",
  borderRadius: "4px",
};

const afterFillStyle: React.CSSProperties = {
  height: "100%",
  background: "#4f8cff",
  borderRadius: "4px",
};

const valueStyle: React.CSSProperties = {
  flex: "0 0 auto",
  minWidth: "72px",
  textAlign: "right",
  fontSize: "0.76rem",
  fontVariantNumeric: "tabular-nums",
  color: "#e6ecff",
};

const gainNoteStyle: React.CSSProperties = {
  margin: "4px 0 0 0",
  fontSize: "0.74rem",
  color: "#a8b8e8",
};

const textAlternativeWrapStyle: React.CSSProperties = {
  marginTop: "12px",
};

const DEFAULT_TITLE = "Projected before and after";

/**
 * Format a numeric value as readable text. A whole number keeps no decimals;
 * otherwise up to two decimals are shown, so the text and the bar agree. A
 * non-finite value is shown as a plain dash rather than "NaN".
 */
function formatValue(value: number, unit?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return unit ? `${text} ${unit}` : text;
}

/**
 * Format a bounded gain percentage as readable text. The mapper has already
 * clamped it to 0..100.
 */
function formatPct(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return `${text} %`;
}

/**
 * Render the two comparison bars and the text alternative for a projection.
 * Both bars share one scale: the larger of before and after sets the full
 * track width, so the two bar widths read directly against each other. A zero
 * maximum (both values zero) renders empty tracks rather than dividing by zero.
 */
function ComparisonBars({
  projection,
  series,
  unit,
  caption,
}: {
  projection: BeforeAfter;
  series: ChartSeries;
  unit?: string;
  caption: string;
}) {
  const { before, after, gainPct } = projection;
  const max = Math.max(before, after, 0);
  const widthOf = (value: number): number =>
    max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;

  const bars: Array<{ label: string; value: number; fill: React.CSSProperties }> = [
    { label: "before", value: before, fill: beforeFillStyle },
    { label: "after", value: after, fill: afterFillStyle },
  ];

  return (
    <div>
      <div
        role="img"
        aria-label={`${series.seriesName}, before and after on one scale`}
      >
        {bars.map((bar, index) => (
          <div style={rowStyle} key={`before-after-row-${index}`}>
            <span style={labelStyle} title={bar.label}>
              {bar.label}
            </span>
            <span style={trackStyle} aria-hidden="true">
              <span style={{ ...bar.fill, display: "block", width: `${widthOf(bar.value)}%` }} />
            </span>
            <span style={valueStyle}>{formatValue(bar.value, unit)}</span>
          </div>
        ))}
      </div>
      <p style={gainNoteStyle}>Applied gain: {formatPct(gainPct)}</p>
      <div style={textAlternativeWrapStyle}>
        <ChartTextAlternative series={series} caption={caption} />
      </div>
    </div>
  );
}

export function ProjectedBeforeAfterChart({
  before,
  gainPct,
  unit,
  title,
}: ProjectedBeforeAfterChartProps) {
  const chartTitle = title ?? DEFAULT_TITLE;

  // Validate the required inputs up front. A before value or gain that is
  // absent or non-finite yields the "data unavailable" state rather than a
  // broken bar, mirroring the unavailable posture the mapper uses elsewhere.
  const beforeOk = typeof before === "number" && Number.isFinite(before);
  const gainOk = typeof gainPct === "number" && Number.isFinite(gainPct);
  if (!beforeOk || !gainOk) {
    return (
      <div style={containerStyle}>
        <h3 style={titleStyle}>{chartTitle}</h3>
        <p style={messageStyle}>Data unavailable for this chart.</p>
      </div>
    );
  }

  // Compute the projection behind a try/catch so a thrown error renders the
  // "chart cannot be displayed" state rather than aborting the overlay.
  let projection: BeforeAfter;
  try {
    projection = projectedBeforeAfter(before, gainPct);
  } catch {
    return (
      <div style={containerStyle}>
        <h3 style={titleStyle}>{chartTitle}</h3>
        <p style={messageStyle}>This chart cannot be displayed.</p>
      </div>
    );
  }

  // Build the one series that both the bars and the text alternative read from,
  // so the visual and the table convey the identical category labels and
  // numeric values (Reqs 9.1, 9.7).
  const series: ChartSeries = {
    seriesName: chartTitle,
    points: [
      { category: "before", value: projection.before, unit },
      { category: "after", value: projection.after, unit },
    ],
  };

  return (
    <div style={containerStyle}>
      <h3 style={titleStyle}>{chartTitle}</h3>
      <ComparisonBars
        projection={projection}
        series={series}
        unit={unit}
        caption={chartTitle}
      />
    </div>
  );
}

export default ProjectedBeforeAfterChart;
