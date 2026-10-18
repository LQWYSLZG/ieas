/**
 * ProblemLabelChart.tsx - the problem-label visualization for the
 * Recommendations chart set.
 *
 * This is the second of the three Recommendations charts. It presents each
 * recommendation's problem label alongside a small visualization, mapping the
 * raw problem key to its display information through the pure problemLabelInfo
 * mapper. The four known keys render their recognized display labels (Defect
 * waste, Setup waste, Operation move, Labor constraint), and any other value is
 * flagged with an explicit "unrecognized" indication rather than being hidden
 * (Req 7.3, 7.4).
 *
 * Crucially, an unrecognized label never stops the chart: every remaining
 * recommendation keeps rendering even when some labels are unrecognized, so the
 * row count always equals the input recommendation count (Req 7.4).
 *
 * Accessibility (Reqs 9.1, 9.2, 9.7): understanding never depends on seeing the
 * visualization or distinguishing color. Each row carries a visible text label
 * (the recommendation element name), a direct text value (the display label),
 * and a plain-text "unrecognized" marker where applicable, and the shared
 * ChartTextAlternative table conveys the same series name, category labels, and
 * values as readable text. Color is only ever a secondary signal layered on top
 * of the text.
 *
 * Error handling (Reqs 5.5, 5.7): the per-recommendation mapping is wrapped so
 * that an unexpected throw is caught and rendered as a "chart cannot be
 * displayed" state, and when required data is absent the chart renders a short
 * "data unavailable" message instead of the visualization. Neither case aborts
 * the rest of the overlay; this one chart degrades on its own while every other
 * chart keeps its last rendered state.
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
import type { ChartSeries, ProblemLabelInfo } from "./chartData";
import { problemLabelInfo } from "./chartData";
import ChartTextAlternative from "./ChartTextAlternative";

export interface ProblemLabelChartProps {
  /**
   * The recommendations whose problem labels are presented. Each recommendation
   * contributes one row; none is dropped, including those with unrecognized
   * labels.
   */
  recommendations: Recommendation[];
  /**
   * An optional chart title shown above the rows and used as the text
   * alternative caption. Defaults to a descriptive label.
   */
  title?: string;
}

// A single prepared row: the element name shown as the row label, the mapped
// problem-label display info, and a stable key index.
interface LabelRow {
  elementName: string;
  info: ProblemLabelInfo;
}

// Shared inline styles, matching the dark-panel conventions of the sibling
// Results and Recommendations panels and the ChartTextAlternative table. Color
// is never the only signal: every row is paired with a visible text label and a
// text display value, and unrecognized labels carry a plain-text marker.
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

// The problem-label pill reads as a text value first; its background color is a
// secondary signal only. The known and unknown variants differ in text, in the
// explicit marker, and in a non-color border style, so grayscale readers can
// still tell them apart.
const pillBaseStyle: React.CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "0.76rem",
  padding: "4px 10px",
  borderRadius: "999px",
};

const knownPillStyle: React.CSSProperties = {
  ...pillBaseStyle,
  background: "rgba(79,140,255,0.16)",
  border: "1px solid rgba(79,140,255,0.55)",
  color: "#dbe6ff",
};

const unknownPillStyle: React.CSSProperties = {
  ...pillBaseStyle,
  background: "rgba(255,255,255,0.05)",
  border: "1px dashed rgba(255,196,120,0.75)",
  color: "#ffd9a8",
};

const displayTextStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontWeight: 600,
};

const unrecognizedMarkerStyle: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: "0.68rem",
  fontWeight: 600,
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  color: "#ffd9a8",
};

const textAlternativeWrapStyle: React.CSSProperties = {
  marginTop: "12px",
};

const DEFAULT_TITLE = "Problem labels";

/**
 * Build one label row per recommendation, mapping each raw problem key through
 * problemLabelInfo. Every recommendation produces exactly one row, so the row
 * count always equals the input count even when some labels are unrecognized
 * (Req 7.4).
 */
function buildRows(recommendations: Recommendation[]): LabelRow[] {
  return recommendations.map((rec) => ({
    elementName: rec.element_name,
    info: problemLabelInfo(rec.problem),
  }));
}

/**
 * Build the text alternative series from the prepared rows. This chart is
 * categorical rather than numeric, so the readable pairing of each
 * recommendation with its problem label is carried entirely in the category
 * text: "ElementName: Defect waste", with an explicit "(unrecognized)" marker
 * appended for unknown labels. The numeric value is a presence count of 1 so
 * every row is conveyed, and the shared table renders the full label text in
 * the Category column where understanding does not depend on a number
 * (Reqs 9.1, 9.7).
 */
function buildSeries(rows: LabelRow[]): ChartSeries {
  return {
    seriesName: "Problem label by recommendation",
    points: rows.map((row) => {
      const labelText = row.info.known
        ? row.info.display
        : `${row.info.display} (unrecognized)`;
      return {
        category: `${row.elementName}: ${labelText}`,
        value: 1,
      };
    }),
  };
}

export function ProblemLabelChart({ recommendations, title }: ProblemLabelChartProps) {
  const chartTitle = title ?? DEFAULT_TITLE;

  // Empty-state short-circuit before touching the mapper: no recommendations
  // means no chart container and no zero-series chart, just a readable message.
  if (!recommendations || recommendations.length === 0) {
    return (
      <div style={containerStyle}>
        <h3 style={titleStyle}>{chartTitle}</h3>
        <p style={messageStyle}>
          No recommendations to label. Run a simulation to get optimization
          suggestions.
        </p>
      </div>
    );
  }

  // Map every recommendation behind a try/catch so a thrown error renders the
  // "chart cannot be displayed" state rather than aborting the overlay.
  let rows: LabelRow[];
  let series: ChartSeries;
  try {
    rows = buildRows(recommendations);
    series = buildSeries(rows);
  } catch {
    return (
      <div style={containerStyle}>
        <h3 style={titleStyle}>{chartTitle}</h3>
        <p style={messageStyle}>This chart cannot be displayed.</p>
      </div>
    );
  }

  // Defensive guard: if mapping somehow produced no rows, show the "data
  // unavailable" message in place of the visualization while every other chart
  // keeps rendering.
  if (rows.length === 0) {
    return (
      <div style={containerStyle}>
        <h3 style={titleStyle}>{chartTitle}</h3>
        <p style={messageStyle}>Data unavailable for this chart.</p>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <h3 style={titleStyle}>{chartTitle}</h3>
      <div role="img" aria-label={`${series.seriesName}, one row per recommendation`}>
        {rows.map((row, index) => {
          const pillStyle = row.info.known ? knownPillStyle : unknownPillStyle;
          return (
            <div style={rowStyle} key={`problem-row-${index}`}>
              <span style={labelStyle} title={row.elementName}>
                {row.elementName}
              </span>
              <span style={pillStyle}>
                <span style={displayTextStyle} title={row.info.display}>
                  {row.info.display}
                </span>
                {!row.info.known && (
                  <span style={unrecognizedMarkerStyle}>Unrecognized</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div style={textAlternativeWrapStyle}>
        <ChartTextAlternative series={series} caption={chartTitle} />
      </div>
    </div>
  );
}

export default ProblemLabelChart;
