/**
 * TimeSplitChart.tsx - the per-station time-split chart for the expanded
 * Results view.
 *
 * For one station this renders a stacked CSS bar that splits the station's
 * time into the five mutually exclusive categories busy, starved, blocked,
 * down, and idle (Req 6.2), and pairs that bar with the shared
 * ChartTextAlternative table so the same data is available as readable text
 * (Req 9.1, 9.7). Every category carries a visible text label and its numeric
 * percentage value, so understanding never depends on color alone: the labels
 * and numbers identify each category even in grayscale (Req 9.2).
 *
 * The chart owns the two degraded states the design requires (Error Handling):
 *   - When the mapper returns an "unavailable" marker (a required field is
 *     absent), the chart renders a short "data unavailable" message in place of
 *     the bar and renders no text-alternative table, while every other chart
 *     keeps rendering (Req 5.5).
 *   - When the mapper call throws unexpectedly, the chart catches it and
 *     renders a "chart cannot be displayed" state rather than letting the throw
 *     abort the surrounding chart grid (Req 5.7).
 *
 * The visual language matches the sibling dark-panel components: the same
 * five category colors the compact ResultsPanel split bar uses, dark surfaces,
 * and light text. Pure SVG/CSS; no new dependency.
 *
 * Project rule: no em dashes or en dashes anywhere in this file. Only ASCII
 * hyphens are used.
 */

import type { StationMetrics } from "../types";
import type { ChartData, ChartSeries, TimeSplitCategory } from "./chartData";
import { timeSplitSeries } from "./chartData";
import { ChartTextAlternative } from "./ChartTextAlternative";

export interface TimeSplitChartProps {
  /** The station whose time split is charted. */
  station: StationMetrics;
}

// The five category colors, matching the compact ResultsPanel split bar
// exactly so the expanded chart reads the same as the familiar compact bar.
// Color is never the only signal: each segment and each legend row also
// carries a text label and its numeric value.
const CATEGORY_COLOR: Record<TimeSplitCategory, string> = {
  busy: "#28a745",
  starved: "#ffc107",
  blocked: "#e07b39",
  down: "#c0392b",
  idle: "#3a4a6a",
};

// The readable label shown for each category, so the text does not depend on
// the lowercase key alone.
const CATEGORY_LABEL: Record<TimeSplitCategory, string> = {
  busy: "Working",
  starved: "Starved",
  blocked: "Blocked",
  down: "Machine down",
  idle: "Idle",
};

const KNOWN_CATEGORIES: TimeSplitCategory[] = [
  "busy",
  "starved",
  "blocked",
  "down",
  "idle",
];

const containerStyle: React.CSSProperties = {
  background: "#101c2c",
  border: "1px solid rgba(45,90,142,0.3)",
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

const barStyle: React.CSSProperties = {
  display: "flex",
  height: "14px",
  borderRadius: "4px",
  overflow: "hidden",
  marginBottom: "10px",
  background: "#0f1a26",
};

const legendStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px 14px",
  margin: "0 0 12px 0",
  padding: 0,
  listStyle: "none",
  fontSize: "0.72rem",
  color: "#cdd9f5",
};

const legendItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

const swatchBaseStyle: React.CSSProperties = {
  width: "10px",
  height: "10px",
  borderRadius: "2px",
  flex: "0 0 auto",
};

const messageStyle: React.CSSProperties = {
  margin: "8px 0 0 0",
  fontSize: "0.76rem",
  color: "#8898c8",
  fontStyle: "italic",
};

/**
 * Format a percentage for display as readable text. Whole numbers show no
 * decimals; otherwise one decimal is shown. A non-finite value renders as a
 * plain dash so it never reads as "NaN".
 */
function formatPct(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Resolve a segment color for a category, falling back to idle for any
 * unexpected key so a category is never left unstyled. */
function colorFor(category: string): string {
  return CATEGORY_COLOR[category as TimeSplitCategory] ?? CATEGORY_COLOR.idle;
}

/** Resolve the readable label for a category, falling back to the raw key when
 * it is not one of the five known categories. */
function labelFor(category: string): string {
  return CATEGORY_LABEL[category as TimeSplitCategory] ?? category;
}

/**
 * Render the stacked bar and the per-category legend from an ok time-split
 * series. The series holds one entry whose points are the five categories.
 */
function renderBar(series: ChartSeries[]) {
  const points = series[0]?.points ?? [];

  return (
    <>
      <div
        style={barStyle}
        title={points
          .map((p) => `${labelFor(p.category)} ${formatPct(p.value)}%`)
          .join(", ")}
      >
        {points.map((point) =>
          point.value > 0 ? (
            <div
              key={point.category}
              style={{
                width: `${point.value}%`,
                background: colorFor(point.category),
              }}
            />
          ) : null
        )}
      </div>

      {/* Legend: a text label and numeric value for every category, in a fixed
          order so the whole split is always visible even when a category is 0
          and therefore absent from the bar above. This is the non-color
          encoding that keeps the chart readable in grayscale. */}
      <ul style={legendStyle}>
        {KNOWN_CATEGORIES.map((category) => {
          const point = points.find((p) => p.category === category);
          const value = point ? point.value : 0;
          return (
            <li key={category} style={legendItemStyle}>
              <span
                aria-hidden="true"
                style={{ ...swatchBaseStyle, background: CATEGORY_COLOR[category] }}
              />
              <span>
                {CATEGORY_LABEL[category]} {formatPct(value)}%
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function TimeSplitChart({ station }: TimeSplitChartProps) {
  const title = `Time split - ${station?.station_name ?? "station"}`;

  // Wrap the mapper call so an unexpected throw becomes a "chart cannot be
  // displayed" state rather than aborting the surrounding chart grid (Req 5.7).
  let data: ChartData;
  try {
    data = timeSplitSeries(station);
  } catch {
    return (
      <section style={containerStyle} aria-label={title}>
        <h4 style={titleStyle}>{title}</h4>
        <p style={messageStyle}>This chart cannot be displayed.</p>
      </section>
    );
  }

  // A required field was absent: show a short "data unavailable" message in
  // place of the bar and render no text-alternative table (Req 5.5).
  if (data.kind === "unavailable") {
    return (
      <section style={containerStyle} aria-label={title}>
        <h4 style={titleStyle}>{title}</h4>
        <p style={messageStyle}>Data unavailable for this time split.</p>
      </section>
    );
  }

  return (
    <section style={containerStyle} aria-label={title}>
      <h4 style={titleStyle}>{title}</h4>
      {renderBar(data.series)}
      <ChartTextAlternative
        series={data.series}
        caption={`${title} as text`}
      />
    </section>
  );
}

export default TimeSplitChart;
