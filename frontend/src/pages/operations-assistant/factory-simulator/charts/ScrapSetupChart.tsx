/**
 * ScrapSetupChart.tsx - the scrap-and-setup contributions chart for the
 * expanded Results view.
 *
 * For each station that carries a positive scrap or setup contribution, this
 * chart shows that station's scrap contribution and its setup contribution as
 * two separately identifiable values (Reqs 6.5, 6.6). Every value is shown as
 * readable text paired with its category label, and the chart is paired with
 * the shared ChartTextAlternative table so understanding never depends on
 * seeing the bars or distinguishing colors (Reqs 9.1, 9.2, 9.7). Each category
 * is distinguished by at least one non-color means: a visible text label, a
 * distinct fill pattern, and a direct numeric text value, so the two
 * contributions are identifiable in grayscale.
 *
 * Data comes from the pure scrapSetupSeries mapper. The mapper already applies
 * the positive predicate (a station is included only when its scrap_pct is
 * greater than 0 or its setup_impact is greater than 0) and never throws, but
 * this component still follows the design's error-handling contract so one
 * failing chart never aborts the rest of the overlay (Reqs 5.5, 5.7):
 *   - an "unavailable" marker renders a short "data unavailable" message in
 *     place of the bars, with no text-alternative table;
 *   - an unexpected thrown error is caught and rendered as a "chart cannot be
 *     displayed" empty state;
 *   - an ok result with no qualifying station renders a sensible empty state
 *     (no station has a scrap or setup contribution), not an empty chart frame.
 *
 * This is a pure presentational component: props in, markup out. It holds no
 * state, performs no I/O, and reads nothing beyond its props. It matches the
 * dark-panel inline-style conventions of the sibling Results and
 * Recommendations panels and uses only SVG and CSS, adding no dependency.
 *
 * Project rule: no em dashes or en dashes anywhere in this file. Only ASCII
 * hyphens are used.
 */

import type { StationMetrics } from "../types";
import type { ChartData, ChartSeries, ChartDatum } from "./chartData";
import { scrapSetupSeries } from "./chartData";
import { ChartTextAlternative } from "./ChartTextAlternative";

export interface ScrapSetupChartProps {
  /**
   * The stations whose scrap and setup contributions are charted. For a
   * single-line result this is the aggregate station list; for a multi-line
   * result the caller passes one line's stations per rendered section.
   */
  stations: StationMetrics[];
  /**
   * An optional title shown above the chart and used as the text-alternative
   * caption. Defaults to a generic label.
   */
  title?: string;
}

// Inline styles matching the dark-panel conventions of the sibling panels.
// Color is never the only signal: every bar carries a text label and a numeric
// text value, and the two contributions use distinct fill patterns so they are
// identifiable in grayscale.
const wrapperStyle: React.CSSProperties = {
  padding: "10px 12px",
  background: "rgba(45, 90, 142, 0.15)",
  borderRadius: "6px",
  border: "1px solid rgba(45, 90, 142, 0.3)",
  marginBottom: "10px",
};

const titleStyle: React.CSSProperties = {
  color: "#d4a017",
  fontSize: "0.78rem",
  fontWeight: 600,
  marginBottom: "8px",
};

const stationBlockStyle: React.CSSProperties = {
  marginBottom: "10px",
};

const stationNameStyle: React.CSSProperties = {
  color: "#fff",
  fontSize: "0.74rem",
  fontWeight: 600,
  marginBottom: "4px",
};

const barRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  margin: "3px 0",
};

const barLabelStyle: React.CSSProperties = {
  color: "#b0c8e0",
  fontSize: "0.72rem",
  width: "56px",
  flexShrink: 0,
};

const barTrackStyle: React.CSSProperties = {
  flex: 1,
  height: "12px",
  borderRadius: "4px",
  overflow: "hidden",
  background: "#0f1a26",
  border: "1px solid rgba(255,255,255,0.08)",
};

const barValueStyle: React.CSSProperties = {
  color: "#e6ecff",
  fontSize: "0.72rem",
  fontVariantNumeric: "tabular-nums",
  width: "96px",
  flexShrink: 0,
  textAlign: "right",
};

const messageStyle: React.CSSProperties = {
  color: "#b0c8e0",
  fontSize: "0.76rem",
  fontStyle: "italic",
  padding: "6px 0",
};

const textAltWrapStyle: React.CSSProperties = {
  marginTop: "8px",
};

// Per-category fill patterns. The scrap bar uses a solid fill, the setup bar a
// diagonal-stripe pattern, so the two categories differ by pattern as well as
// by color and never rely on color alone.
const CATEGORY_FILL: Record<string, string> = {
  scrap: "#c0392b",
  setup: "#5dade2",
};

const SETUP_STRIPE =
  "repeating-linear-gradient(45deg, #5dade2 0, #5dade2 4px, #2d5a8e 4px, #2d5a8e 8px)";

/**
 * Format a numeric value as readable text, mirroring the text-alternative
 * formatting so the visible value and the table value match. A non-finite
 * value shows a plain dash; a whole number keeps no decimals; otherwise up to
 * two decimals are shown.
 */
function formatValue(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * The readable value text pairing a numeric value with its unit, for example
 * "3.5 %" or "1.20 x cycle time".
 */
function valueText(point: ChartDatum): string {
  const text = formatValue(point.value);
  return point.unit ? `${text} ${point.unit}` : text;
}

/**
 * The largest value across all points, used to scale the bar widths so the
 * biggest contribution fills the track and the rest are proportional. Scrap
 * (percent) and setup (ratio) live on different units, so each bar is scaled
 * against the shared maximum only for a readable relative width; the exact
 * numeric value is always shown as text alongside.
 */
function maxValue(seriesList: ChartSeries[]): number {
  let max = 0;
  for (const series of seriesList) {
    for (const point of series.points) {
      if (Number.isFinite(point.value) && point.value > max) {
        max = point.value;
      }
    }
  }
  return max;
}

/**
 * The bar width as a percentage of the track, proportional to the shared
 * maximum. A zero or non-positive maximum yields a zero-width bar.
 */
function barWidthPct(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (value / max) * 100));
}

export function ScrapSetupChart({ stations, title }: ScrapSetupChartProps) {
  const chartTitle = title ?? "Scrap and setup contributions";

  // Wrap the mapper call so an unexpected throw becomes the "chart cannot be
  // displayed" state rather than aborting the surrounding overlay (Req 5.7).
  let data: ChartData;
  try {
    data = scrapSetupSeries(stations);
  } catch {
    return (
      <div style={wrapperStyle}>
        <div style={titleStyle}>{chartTitle}</div>
        <div style={messageStyle}>This chart cannot be displayed.</div>
      </div>
    );
  }

  // Required data absent: render a short unavailable message, no table (Req 5.5).
  if (data.kind === "unavailable") {
    return (
      <div style={wrapperStyle}>
        <div style={titleStyle}>{chartTitle}</div>
        <div style={messageStyle}>Scrap and setup data is unavailable.</div>
      </div>
    );
  }

  const seriesList = data.series;

  // Sensible empty state: no station carries a positive scrap or setup
  // contribution, so there is nothing to chart (Reqs 6.5, 6.6).
  if (seriesList.length === 0) {
    return (
      <div style={wrapperStyle}>
        <div style={titleStyle}>{chartTitle}</div>
        <div style={messageStyle}>
          No station has a scrap or setup contribution to show.
        </div>
      </div>
    );
  }

  const max = maxValue(seriesList);

  return (
    <div style={wrapperStyle}>
      <div style={titleStyle}>{chartTitle}</div>

      {seriesList.map((series, seriesIndex) => (
        <div key={`station-${seriesIndex}`} style={stationBlockStyle}>
          <div style={stationNameStyle}>{series.seriesName}</div>
          {series.points.map((point, pointIndex) => {
            const width = barWidthPct(point.value, max);
            const fill =
              point.category === "setup"
                ? SETUP_STRIPE
                : CATEGORY_FILL[point.category] ?? "#8fb0d6";
            return (
              <div
                key={`station-${seriesIndex}-point-${pointIndex}`}
                style={barRowStyle}
              >
                <span style={barLabelStyle}>{point.category}</span>
                <span
                  style={barTrackStyle}
                  role="img"
                  aria-label={`${point.category} ${valueText(point)}`}
                >
                  <span
                    style={{
                      display: "block",
                      height: "100%",
                      width: `${width}%`,
                      background: fill,
                    }}
                  />
                </span>
                <span style={barValueStyle}>{valueText(point)}</span>
              </div>
            );
          })}
        </div>
      ))}

      <div style={textAltWrapStyle}>
        <ChartTextAlternative series={seriesList} caption={chartTitle} />
      </div>
    </div>
  );
}

export default ScrapSetupChart;
