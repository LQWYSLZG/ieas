/**
 * RecommendationsList - the shared recommendation card list.
 *
 * This is the single source of truth for how recommendations render in the
 * Optimize stage: the friendly problem labels, the severity-colored cards, and
 * the single-line (flat list) versus multi-line (grouped per line) layout, plus
 * the "no issues found" empty states. Both the compact Optimize panel and the
 * expanded Recommendations overlay render this exact body, so the expanded view
 * is just a larger, more readable version of the compact content.
 *
 * It renders ONLY the recommendation body. Page chrome (the Recommendations
 * header, the Expand control, the "Modify Layout" button) stays in the page and
 * is not part of this component.
 *
 * Project rule: no em dashes or en dashes anywhere. Only ASCII hyphens.
 */

import type { Recommendation, SimulationResult } from "../types";

// Friendly, shop-owner-readable titles for recommendation problem keys.
export const PROBLEM_LABELS: Record<string, string> = {
  bottleneck: "Bottleneck",
  blocking: "Blocked Flow",
  starvation: "Starved for Parts",
  machine_downtime: "Machine Downtime",
  labor_constraint: "Not Enough Operators",
  overstaffed: "Too Many Operators",
  low_throughput: "Line Capacity",
  wip_explosion: "Too Much WIP",
  walking_waste: "Transport Waste",
  line_imbalance: "Unbalanced Line",
  defect_waste: "Scrap and Defects",
  setup_waste: "Setup and Changeover",
  operation_move: "Move an Operation",
};

export function problemLabel(problem: string): string {
  return (
    PROBLEM_LABELS[problem] ??
    problem.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * A single recommendation card. Severity drives the left border and the problem
 * pill colors; the estimated gain shows when positive.
 */
export function RecommendationCard({ rec }: { rec: Recommendation }) {
  const sevColor = rec.severity === "high" ? "#dc3545" : rec.severity === "medium" ? "#ffc107" : "#8ba3c0";
  const sevBg = rec.severity === "high" ? "rgba(220,53,69,0.2)" : rec.severity === "medium" ? "rgba(255,193,7,0.2)" : "rgba(139,163,192,0.2)";
  const sevText = rec.severity === "high" ? "#ff6b7a" : rec.severity === "medium" ? "#ffc107" : "#b0c8e0";
  return (
    <div style={{ padding: "8px 10px", marginBottom: "6px", background: "rgba(255,255,255,0.03)", borderRadius: "6px", borderLeft: `3px solid ${sevColor}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px", gap: "6px" }}>
        <span style={{ fontSize: "0.72rem", fontWeight: 700, padding: "1px 7px", borderRadius: "10px", background: sevBg, color: sevText }}>
          {problemLabel(rec.problem)}
        </span>
        {rec.estimated_throughput_gain_pct > 0 && (
          <span style={{ fontSize: "0.66rem", color: "#28a745", fontWeight: 600, whiteSpace: "nowrap" }}>
            up to +{rec.estimated_throughput_gain_pct.toFixed(0)}%
          </span>
        )}
      </div>
      <div style={{ fontSize: "0.74rem", fontWeight: 600, color: "#fff", marginBottom: "2px" }}>{rec.element_name}</div>
      <p style={{ fontSize: "0.72rem", color: "#a8b8e8", margin: 0, lineHeight: 1.35 }}>{rec.action}</p>
    </div>
  );
}

export interface RecommendationsListProps {
  result: SimulationResult;
}

/**
 * The recommendation body: multi-line results group cards under each line's
 * subheading (lines with none show a short "running efficiently" note); a
 * single-line result renders a flat card list or one empty-state note.
 */
export function RecommendationsList({ result }: RecommendationsListProps) {
  const isMultiLine = (result.lines?.length ?? 0) >= 2;

  if (isMultiLine) {
    return (
      <>
        {result.lines!.map((line) => (
          <details key={line.line_id} style={{ marginBottom: "12px" }}>
            <summary style={{ color: "#d4a017", fontSize: "0.9rem", cursor: "pointer", marginTop: "14px", marginBottom: "6px", fontWeight: 600, borderBottom: "1px solid rgba(212, 160, 23, 0.3)", paddingBottom: "4px" }}>{line.line_name}</summary>
            {line.recommendations.length === 0 ? (
              <p style={{ color: "#a8b8e8", fontSize: "0.78rem", margin: 0 }}>No issues found. This line is running efficiently.</p>
            ) : (
              line.recommendations.map((rec, i) => <RecommendationCard key={i} rec={rec} />)
            )}
          </details>
        ))}
      </>
    );
  }

  if (result.recommendations.length === 0) {
    return (
      <p style={{ color: "#a8b8e8", fontSize: "0.82rem" }}>No issues found. This line is running efficiently.</p>
    );
  }

  return (
    <>
      {result.recommendations.map((rec, i) => <RecommendationCard key={i} rec={rec} />)}
    </>
  );
}

export default RecommendationsList;