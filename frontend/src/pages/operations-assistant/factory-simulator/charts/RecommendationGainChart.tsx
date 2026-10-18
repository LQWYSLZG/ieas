/**
 * RecommendationGainChart.tsx - the horizontal ranked bar for recommendation
 * estimated throughput gains.
 *
 * This is the first of the three Recommendations charts. It renders one
 * horizontal bar per recommendation, ordered from the highest estimated
 * throughput gain to the lowest, with every displayed value bounded to the
 * range 0.00 to 100.00 percent. The ordering and the clamping both come from
 * the pure recommendationGainSeries mapper, so the visual and its text
 * alternative agree exactly and no value is ever introduced that is not derived
 * from Result_Data (Req 7.2).
 *
 * Accessibility (Reqs 9.1, 9.2, 9.7): understanding never depends on seeing the
 * bars or distinguishing color. Each bar carries a visible text label (the
 * recommendation element name) and a direct numeric text value next to it, and
 * the shared ChartTextAlternative table conveys the same series name, category
 * labels, and numeric values as readable text. Color is only ever a secondary
 * signal layered on top of the text labels and numbers.
 *
 * Error handling (Reqs 5.5, 5.7): the mapper call is wrapped so that an
 * "unavailable" marker renders a short "data unavailable" message instead of
 * bars, and an unexpected throw is caught and rendered as a "chart cannot be
 * displayed" state. Neither case aborts the rest of the overlay; this one chart
 * degrades on its own while every other chart keeps its last rendered state.
 *
 * When there are no recommendations at all, the component renders a sensible
 * empty state message rather than an empty chart container or a chart with a
 * zero-length data series (Req 7.6 posture for this chart).
 *
 * This is a pure presentational component: props in, markup out. It holds no
 * state, performs no I/O, and reads nothing beyond its props.
 *
 * Project rule: no em dashes or en dashes anywhere in this file. Only ASCII
 * hyphens are used.
 */

import type { Recommendation } from "../types";
import type { ChartData, ChartSeries } from "./chartData";
import { recommendationGainSeries } from "./chartData";
import ChartTextAlternative from "./ChartTextAlternative";

export interface RecommendationGainChartProps {
  /**
   * The recommendations to rank by estimated throughput gain. Ordering and
   * clamping are delegated to recommendationGainSeries, so this list is passed
   * through as-is.
   */
  recommendations: Recommendation[];
  /**
   * An optional chart title shown above the bars and used as the text
   * alternative caption. Defaults to a descriptive label.
   */
  title?: string;
}

// Shared inline styles, matching the dark-panel conventions of the sibling
// Results and Recommendations panels and the ChartTextAlternative table. Color
// is never the only signal: every bar is paired with a visible text label and a
// numeric text value.
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
  flex: "0 0 38%",
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

const fillStyle: React.CSSProperties = {
  height: "100%",
  background: "#4f8cff",
  borderRadius: "4px",
};

const valueStyle: React.CSSProperties = {
  flex: "0 0 auto",
  minWidth: "52px",
  textAlign: "right",
  fontSize: "0.76rem",
  fontVariantNumeric: "tabular-nums",
  color: "#e6ecff",
};

const textAlternativeWrapStyle: React.CSSProperties = {
  marginTop: "12px",
};

const DEFAULT_TITLE = "Estimated throughput gain";

/**
 * Format a bounded percentage value as readable text. Values are already
 * clamped to 0.00..100.00 by the mapper; a whole number keeps no decimals,
 * otherwise up to two decimals are shown, so the text and the bar agree.
 */
function formatPct(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return `${text} %`;
}

/**
 * Render the ranked bars and the text alternative for an ok series. Values are
 * bounded to 0..100 by the mapper, so the bar width reads directly as a
 * percentage of the track width.
 */
function RankedBars({ series, caption }: { series: ChartSeries; caption: string }) {
  const points = series.points;

  // No recommendations: render a sensible empty state rather than an empty
  // chart container or a zero-length data series.
  if (points.length === 0) {
    return (
      <p style={messageStyle}>
        No recommendations to rank. Run a simulation to get optimization
        suggestions.
      </p>
    );
  }

  return (
    <div>
      <div role="img" aria-label={`${series.seriesName}, ranked highest to lowest`}>
        {points.map((point, index) => {
          const width = Math.max(0, Math.min(100, point.value));
          return (
            <div style={rowStyle} key={`gain-row-${index}`}>
              <span style={labelStyle} title={point.category}>
                {point.category}
              </span>
              <span style={trackStyle} aria-hidden="true">
                <span style={{ ...fillStyle, width: `${width}%` }} />
              </span>
              <span style={valueStyle}>{formatPct(point.value)}</span>
            </div>
          );
        })}
      </div>
      <div style={textAlternativeWrapStyle}>
        <ChartTextAlternative series={series} caption={caption} />
      </div>
    </div>
  );
}

export function RecommendationGainChart({
  recommendations,
  title,
}: RecommendationGainChartProps) {
  const chartTitle = title ?? DEFAULT_TITLE;

  // Empty-state short-circuit before touching the mapper: no recommendations
  // means no chart container and no zero-series chart, just a readable message.
  if (!recommendations || recommendations.length === 0) {
    return (
      <div style={containerStyle}>
        <h3 style={titleStyle}>{chartTitle}</h3>
        <p style={messageStyle}>
          No recommendations to rank. Run a simulation to get optimization
          suggestions.
        </p>
      </div>
    );
  }

  // Compute the series behind a try/catch so a thrown error renders the
  // "chart cannot be displayed" state rather than aborting the overlay.
  let data: ChartData;
  try {
    data = recommendationGainSeries(recommendations);
  } catch {
    return (
      <div style={containerStyle}>
        <h3 style={titleStyle}>{chartTitle}</h3>
        <p style={messageStyle}>This chart cannot be displayed.</p>
      </div>
    );
  }

  // A required value was absent: render the "data unavailable" message in place
  // of the bars while every other chart keeps rendering.
  if (data.kind === "unavailable") {
    return (
      <div style={containerStyle}>
        <h3 style={titleStyle}>{chartTitle}</h3>
        <p style={messageStyle}>Data unavailable for this chart.</p>
      </div>
    );
  }

  // The gain mapper always returns a single series; guard defensively so an
  // unexpected empty series list still reads as a sensible empty state.
  const series = data.series[0];
  if (!series) {
    return (
      <div style={containerStyle}>
        <h3 style={titleStyle}>{chartTitle}</h3>
        <p style={messageStyle}>
          No recommendations to rank. Run a simulation to get optimization
          suggestions.
        </p>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <h3 style={titleStyle}>{chartTitle}</h3>
      <RankedBars series={series} caption={chartTitle} />
    </div>
  );
}

export default RecommendationGainChart;
