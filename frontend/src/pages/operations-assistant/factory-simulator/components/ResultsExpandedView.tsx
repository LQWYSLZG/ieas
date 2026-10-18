/**
 * ResultsExpandedView - the expanded Results overlay content.
 *
 * Top: a guided "Root Cause Analysis" section that walks the user from the line
 * down to the constraint station down to its slowest operation, one step at a
 * time. Below it: the existing ResultsPanel, unchanged, serving as the overall
 * reference view. The only difference from the compact panel is
 * showTimeSplitLegend, which labels each station's time split inline.
 *
 * Everything is client-side; no backend request is issued. The compact
 * Simulate-tab panel is unchanged (it renders neither the Root Cause Analysis
 * section nor the time-split legend).
 *
 * Project rule: no em dashes or en dashes anywhere. Only ASCII hyphens.
 */

import type { SimulationResult } from "../types";
import { ResultsPanel } from "./ResultsPanel";
import { RootCauseAnalysis } from "./RootCauseAnalysis";
import { scopesOf } from "../charts/chartData";
import { selectConstraintStation } from "../diagnosis";
import type { Recommendation } from "../types";
import "./ExpandedView.css";

export interface ResultsExpandedViewProps {
  result: SimulationResult;
  targetThroughput: number;
}

const panelHeadingStyle: React.CSSProperties = {
  color: "#d4a017",
  fontSize: "1rem",
  fontWeight: 700,
  letterSpacing: "0.3px",
  margin: "0 0 10px 0",
};

const sectionHeadingStyle: React.CSSProperties = {
  color: "#d4a017",
  fontSize: "1rem",
  fontWeight: 700,
  letterSpacing: "0.3px",
  margin: "0 0 10px 0",
};

const lineSubheadingStyle: React.CSSProperties = {
  color: "#8fb0d6",
  fontSize: "0.82rem",
  fontWeight: 700,
  margin: "12px 0 6px 0",
};

const dividerStyle: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid rgba(45, 90, 142, 0.5)",
  margin: "18px 0",
};

/**
 * Count the flagged issues on a line that are NOT the primary constraint we
 * walk through in the guided flow. Recommendations whose element_id matches the
 * constraint station are the root cause itself, so they are excluded; the rest
 * are the "other issues" the closing note points to.
 */
function otherIssueCountFor(
  recommendations: Recommendation[],
  constraintStationId: string | null
): number {
  return recommendations.filter(
    (rec) => !constraintStationId || rec.element_id !== constraintStationId
  ).length;
}

export function ResultsExpandedView({
  result,
  targetThroughput,
}: ResultsExpandedViewProps) {
  const scopes = scopesOf(result);
  const multiLine = scopes.length > 1;

  return (
    <div className="expanded-view-content">
      {/* Guided root-cause drill-down, one guided flow per line scope. */}
      <section>
        <h2 style={sectionHeadingStyle}>Root Cause Analysis</h2>
        {scopes.map((scope) => {
          // The recommendations for this scope: per-line for a multi-line
          // result, otherwise the top-level list.
          const scopeRecs =
            multiLine
              ? (result.lines?.find((l) => l.line_id === scope.lineId)?.recommendations ?? [])
              : result.recommendations;
          const constraint = selectConstraintStation(scope.stations);
          const otherIssues = otherIssueCountFor(scopeRecs, constraint?.station_id ?? null);
          return (
            <div key={scope.lineId}>
              {multiLine && <div style={lineSubheadingStyle}>{scope.lineName}</div>}
              <RootCauseAnalysis
                scope={scope}
                targetThroughput={targetThroughput}
                otherIssueCount={otherIssues}
              />
            </div>
          );
        })}
      </section>

      <hr style={dividerStyle} />

      {/* Overall results: the full panel, unchanged, as the reference view. */}
      <section>
        <h2 style={panelHeadingStyle}>Results</h2>
        <ResultsPanel
          result={result}
          targetThroughput={targetThroughput}
          onViewRecommendations={() => {}}
          showFixButton={false}
          showTimeSplitLegend={true}
        />
      </section>
    </div>
  );
}

export default ResultsExpandedView;