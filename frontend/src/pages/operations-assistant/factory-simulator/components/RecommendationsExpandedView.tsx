/**
 * RecommendationsExpandedView - the expanded Recommendations overlay content.
 *
 * This simply presents the same recommendation content as the compact Optimize
 * panel, in the wide overlay layout: the shared RecommendationsList (friendly
 * problem labels, severity-colored cards, per-line grouping for multi-line
 * results, and the "no issues found" empty states). No charts or tables, since
 * they only repeated and complicated the content.
 *
 * Everything is client-side; no backend request is issued (Req 5.1). The
 * compact Optimize panel renders the identical list, so the expanded view is a
 * larger, more readable version of what the user already sees.
 *
 * Project rule: no em dashes or en dashes anywhere. Only ASCII hyphens.
 */

import type { SimulationResult } from "../types";
import { RecommendationsList } from "./RecommendationsList";
import "./ExpandedView.css";

export interface RecommendationsExpandedViewProps {
  result: SimulationResult;
  targetThroughput: number;
}

const headingStyle: React.CSSProperties = {
  color: "#d4a017",
  fontSize: "1rem",
  fontWeight: 700,
  letterSpacing: "0.3px",
  margin: "0 0 10px 0",
};

export function RecommendationsExpandedView({
  result,
}: RecommendationsExpandedViewProps) {
  return (
    <div className="expanded-view-content">
      <h2 style={headingStyle}>Recommendations</h2>
      <RecommendationsList result={result} />
    </div>
  );
}

export default RecommendationsExpandedView;