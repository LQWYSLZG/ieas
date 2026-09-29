/**
 * RecommendationsPanel: Displays optimization recommendations.
 * Updated to use the new Recommendation model with element_id and estimated_throughput_gain_pct.
 */

import type { Recommendation } from "../types";

export interface RecommendationsPanelProps {
  recommendations: Recommendation[];
  onApply?: (recommendation: Recommendation) => void;
}

/**
 * Sorts recommendations by estimated_throughput_gain_pct descending.
 */
export function sortByImpact(recommendations: Recommendation[]): Recommendation[] {
  return [...recommendations].sort(
    (a, b) => b.estimated_throughput_gain_pct - a.estimated_throughput_gain_pct
  );
}

export function RecommendationsPanel({ recommendations, onApply: _onApply }: RecommendationsPanelProps) {
  if (recommendations.length === 0) {
    return (
      <div className="recommendations-panel">
        <p style={{ color: "#a8b8e8", fontSize: "0.85rem" }}>
          No recommendations available. Run a simulation to get optimization suggestions.
        </p>
      </div>
    );
  }

  return (
    <div className="recommendations-panel">
      <ul className="recommendations-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {recommendations.map((rec, index) => (
          <li
            key={`${rec.element_id}-${index}`}
            style={{
              padding: "12px",
              marginBottom: "8px",
              background: "rgba(255,255,255,0.03)",
              borderRadius: "6px",
              borderLeft: `3px solid ${rec.severity === "high" ? "#dc3545" : rec.severity === "medium" ? "#ffc107" : "#28a745"}`,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "#fff" }}>
                {rec.element_name}
              </span>
              <span style={{
                fontSize: "0.7rem",
                padding: "1px 6px",
                borderRadius: "3px",
                background: rec.severity === "high" ? "rgba(220,53,69,0.2)" : "rgba(255,193,7,0.2)",
                color: rec.severity === "high" ? "#ff6b7a" : "#ffc107",
              }}>
                {rec.problem.replace(/_/g, " ")}
              </span>
            </div>
            <p style={{ fontSize: "0.78rem", color: "#a8b8e8", margin: "4px 0", lineHeight: 1.4 }}>
              {rec.action}
            </p>
            <span style={{ fontSize: "0.72rem", color: "#28a745" }}>
              +{rec.estimated_throughput_gain_pct.toFixed(1)}% est. improvement
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
