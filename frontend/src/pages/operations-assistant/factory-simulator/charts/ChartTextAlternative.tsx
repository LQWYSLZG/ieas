/**
 * ChartTextAlternative.tsx - the shared text alternative for every chart.
 *
 * Every chart in the expanded views pairs its visual bars with this table so
 * understanding never depends on seeing the graphic or distinguishing colors
 * (Req 9.1, 9.2, 9.7). The table conveys the same series names, category
 * labels, and numeric values the chart conveys visually: each numeric value is
 * shown as readable text paired with its category label and unit, and each
 * series is named. Nothing here relies on color; every data item is plain text
 * in a labeled cell.
 *
 * This is a pure presentational component: props in, a table out. It takes a
 * single ChartSeries or a ChartSeries[] and flattens each series through
 * toTextAlternativeRows (the single source of truth that produces exactly one
 * row per data point). It has no state, performs no I/O, and reads nothing
 * beyond its props.
 *
 * Project rule: no em dashes or en dashes anywhere in this file. Only ASCII
 * hyphens are used.
 */

import type { ChartSeries } from "./chartData";
import { toTextAlternativeRows } from "./chartData";

export interface ChartTextAlternativeProps {
  /**
   * The chart data to describe as text. A single series or a list of series;
   * each series contributes its own labeled group of rows.
   */
  series: ChartSeries | ChartSeries[];
  /**
   * An optional caption naming what the table describes, exposed to assistive
   * technology as the table's accessible name. Defaults to a generic label.
   */
  caption?: string;
}

// Shared inline styles, matching the dark-panel conventions of the sibling
// Results and Recommendations panels. Color is never the only signal here: the
// table header text, the row labels, and the numeric text carry all meaning.
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.78rem",
  color: "#e6ecff",
};

const captionStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: "0.78rem",
  fontWeight: 600,
  color: "#a8b8e8",
  padding: "0 0 6px 0",
};

const headCellStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: "0.72rem",
  fontWeight: 600,
  color: "#a8b8e8",
  padding: "4px 8px",
  borderBottom: "1px solid rgba(255,255,255,0.12)",
};

const numericHeadCellStyle: React.CSSProperties = {
  ...headCellStyle,
  textAlign: "right",
};

const seriesCellStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 600,
  color: "#fff",
  padding: "6px 8px 2px 8px",
};

const labelCellStyle: React.CSSProperties = {
  padding: "3px 8px",
  color: "#e6ecff",
};

const valueCellStyle: React.CSSProperties = {
  padding: "3px 8px",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  color: "#e6ecff",
};

/**
 * Format a numeric value as readable text. Non-finite values are shown as a
 * plain dash so a malformed value never renders as "NaN" or an empty cell. A
 * whole number keeps no decimals; otherwise up to two decimals are shown.
 */
function formatValue(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * Render the readable text pairing of a category label with its numeric value
 * and optional unit, for example "42" or "42 %".
 */
function renderValueText(value: number, unit?: string): string {
  const text = formatValue(value);
  return unit ? `${text} ${unit}` : text;
}

export function ChartTextAlternative({ series, caption }: ChartTextAlternativeProps) {
  const seriesList = Array.isArray(series) ? series : [series];
  const tableCaption = caption ?? "Chart data as text";

  return (
    <table style={tableStyle}>
      <caption style={captionStyle}>{tableCaption}</caption>
      <thead>
        <tr>
          <th scope="col" style={headCellStyle}>
            Category
          </th>
          <th scope="col" style={numericHeadCellStyle}>
            Value
          </th>
        </tr>
      </thead>
      {seriesList.map((oneSeries, seriesIndex) => {
        const rows = toTextAlternativeRows(oneSeries);
        return (
          <tbody key={`series-${seriesIndex}`}>
            <tr>
              <th scope="colgroup" colSpan={2} style={seriesCellStyle}>
                {oneSeries.seriesName}
              </th>
            </tr>
            {rows.map((row, rowIndex) => (
              <tr key={`series-${seriesIndex}-row-${rowIndex}`}>
                <th scope="row" style={labelCellStyle}>
                  {row.category}
                </th>
                <td style={valueCellStyle}>
                  {renderValueText(row.value, row.unit)}
                </td>
              </tr>
            ))}
          </tbody>
        );
      })}
    </table>
  );
}

export default ChartTextAlternative;
