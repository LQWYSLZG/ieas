/**
 * LaborChart.tsx - the Results labor comparison chart (Req 6.4).
 *
 * This chart compares the operators a scope needs against the operators it is
 * supplied, drawing both values as bars on one shared operator-count scale so
 * the two counts are directly comparable (Req 6.4). It derives its values only
 * from the pure laborSeries mapper in chartData.ts, which reads the scope's
 * per-line operators_needed and operators_supplied when present and falls back
 * to the aggregate per-pool operators[] detail otherwise. No new data value is
 * introduced here and no backend call is made; the chart is pure client-side
 * SVG and CSS.
 *
 * Accessibility: every category is identified by at least one non-color means.
 * Each bar carries a visible text label ("operators needed", "operators
 * supplied"), a direct numeric text value, and a distinct fill pattern, so the
 * two bars remain distinguishable in grayscale without relying on color alone
 * (Req 9.2). The chart also renders the shared ChartTextAlternative table,
 * which conveys the same series name, category labels, and numeric values as
 * readable text paired with each category (Reqs 9.1, 9.7).
 *
 * Error handling: the laborSeries call is wrapped so a returned "unavailable"
 * marker renders a short "data unavailable" message in place of the bars, and
 * an unexpected thrown error renders a "chart cannot be displayed" state. In
 * neither case does the chart abort, and every other chart in the grid keeps
 * its own state (Reqs 5.5, 5.7).
 *
 * Styling matches the dark-panel inline-style conventions of the sibling chart
 * and panel components: light text on a translucent dark surface, no external
 * stylesheet dependency, no new runtime dependency.
 *
 * Project rule: no em dashes or en dashes anywhere in this file. Only ASCII
 * hyphens are used.
 */

import type { ChartData, ChartSeries, LineScopeView } from "./chartData";
import { laborSeries } from "./chartData";
import ChartTextAlternative from "./ChartTextAlternative";

export interface LaborChartProps {
  /**
   * The scope to chart. For a multi-line result this is one line's scope; for
   * a single-line result it is the aggregate scope. The chart reads only the
   * operator counts the pure mapper needs.
   */
  scope: LineScopeView;
}

// ---------------------------------------------------------------------------
// Styles - dark-panel inline conventions, matching the sibling components.
// ---------------------------------------------------------------------------

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "14px 16px",
  borderRadius: "10px",
  background: "rgba(14,22,48,0.6)",
  border: "1px solid rgba(255,255,255,0.08)",
  color: "#e6ecff",
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.9rem",
  fontWeight: 600,
  color: "#fff",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 600,
  color: "#a8b8e8",
};

const barsBlockStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "10px",
};

const barRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const barLabelRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: "8px",
  fontSize: "0.78rem",
};

const barCategoryStyle: React.CSSProperties = {
  color: "#e6ecff",
};

const barValueStyle: React.CSSProperties = {
  fontWeight: 600,
  color: "#fff",
  fontVariantNumeric: "tabular-nums",
};

const barTrackStyle: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "18px",
  borderRadius: "4px",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  overflow: "hidden",
};

const messageStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  color: "#a8b8e8",
  fontStyle: "italic",
};

// Two distinct fill patterns so the two bars are distinguishable in grayscale
// without relying on color alone (Req 9.2). "needed" uses diagonal stripes;
// "supplied" uses a solid tone. Each is still paired with a text label and a
// numeric value, so no meaning depends on the pattern alone.
const neededFill =
  "repeating-linear-gradient(45deg, #6f8bff 0, #6f8bff 6px, #4a63c8 6px, #4a63c8 12px)";
const suppliedFill = "#4fd1c5";

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * Format an operator count as readable text. Non-finite values render as a
 * plain dash so a malformed value never shows as "NaN". Whole numbers keep no
 * decimals; otherwise up to two decimals are shown.
 */
function formatCount(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * Render the bars for the single labor series. Both bars share one scale: the
 * widest bar is the larger of the two counts, so the two operator counts are
 * directly comparable on the same operator-count axis (Req 6.4). When both
 * counts are zero, bars render at zero width and the numeric labels still
 * report the values.
 */
function renderBars(series: ChartSeries) {
  const points = series.points;
  const maxValue = points.reduce(
    (max, point) =>
      Number.isFinite(point.value) && point.value > max ? point.value : max,
    0
  );
  const scale = maxValue > 0 ? maxValue : 1;

  return (
    <div style={barsBlockStyle} role="img" aria-label={`${series.seriesName} labor comparison`}>
      {points.map((point, index) => {
        const safeValue =
          Number.isFinite(point.value) && point.value > 0 ? point.value : 0;
        const widthPct = Math.min(100, (safeValue / scale) * 100);
        const isNeeded = index === 0;
        const unitSuffix = point.unit ? ` ${point.unit}` : "";
        return (
          <div key={`${point.category}-${index}`} style={barRowStyle}>
            <div style={barLabelRowStyle}>
              <span style={barCategoryStyle}>{point.category}</span>
              <span style={barValueStyle}>
                {formatCount(point.value)}
                {unitSuffix}
              </span>
            </div>
            <div style={barTrackStyle}>
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  height: "100%",
                  width: `${widthPct}%`,
                  background: isNeeded ? neededFill : suppliedFill,
                  borderRadius: "4px",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LaborChart({ scope }: LaborChartProps) {
  const title = "Labor needed vs supplied";

  // Wrap the mapper call so an unexpected throw becomes a graceful
  // "chart cannot be displayed" state rather than aborting the overlay
  // (Req 5.7). A returned "unavailable" marker is handled below (Req 5.5).
  let data: ChartData;
  try {
    data = laborSeries(scope);
  } catch {
    return (
      <div style={containerStyle}>
        <h3 style={titleStyle}>{title}</h3>
        <p style={messageStyle}>This chart cannot be displayed.</p>
      </div>
    );
  }

  if (data.kind === "unavailable") {
    return (
      <div style={containerStyle}>
        <h3 style={titleStyle}>{title}</h3>
        <p style={messageStyle}>Labor data unavailable. {data.reason}</p>
      </div>
    );
  }

  const series = data.series;

  return (
    <div style={containerStyle}>
      <h3 style={titleStyle}>{title}</h3>
      {series.map((oneSeries, index) => (
        <div key={`labor-series-${index}`} style={barRowStyle}>
          <span style={subtitleStyle}>{oneSeries.seriesName}</span>
          {renderBars(oneSeries)}
        </div>
      ))}
      <ChartTextAlternative
        series={series}
        caption="Operators needed versus supplied, as text"
      />
    </div>
  );
}

export default LaborChart;
