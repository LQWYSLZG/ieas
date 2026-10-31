/**
 * RecommendationsList - the shared recommendation list.
 *
 * Single source of truth for how recommendations render in the Optimize stage,
 * used by BOTH the compact Optimize panel and the expanded overlay so they stay
 * consistent.
 *
 * Presentation:
 *   - Multi-line results group under each line (a <details> per line), exactly
 *     as before. Single-line renders one flat group.
 *   - Within a group, recommendations are organized by SEVERITY (High, then
 *     Medium, then Low), each severity in its own labeled section with a colored
 *     header and a count.
 *   - Within a severity section, recommendations are grouped by PROBLEM TYPE
 *     (all bottlenecks together, all labor issues together, and so on), each
 *     problem type introduced by a small subheading, and sorted by estimated
 *     gain (highest first).
 *   - Each card shows a severity stripe, a problem chip, the element name, a
 *     bold estimated-gain badge, the action, and a small "Why?" toggle that
 *     reveals the longer description. This makes the list scannable instead of
 *     a flat top-down wall.
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

type Severity = "high" | "medium" | "low";

// Per-severity visual treatment (color + readable label).
const SEVERITY_META: Record<Severity, { label: string; color: string; bg: string; text: string }> = {
  high: { label: "High priority", color: "#dc3545", bg: "rgba(220,53,69,0.14)", text: "#ff6b7a" },
  medium: { label: "Medium priority", color: "#ffc107", bg: "rgba(255,193,7,0.14)", text: "#ffc107" },
  low: { label: "Low priority", color: "#8ba3c0", bg: "rgba(139,163,192,0.14)", text: "#b0c8e0" },
};

const SEVERITY_ORDER: Severity[] = ["high", "medium", "low"];

/**
 * A single recommendation card: severity stripe, problem chip, element name, a
 * bold estimated-gain badge, the action, and a "Why?" toggle revealing the
 * longer description.
 */
export function RecommendationCard({ rec }: { rec: Recommendation }) {
  const meta = SEVERITY_META[rec.severity as Severity] ?? SEVERITY_META.low;
  return (
    <div
      style={{
        padding: "8px 10px",
        marginBottom: "6px",
        background: "rgba(255,255,255,0.03)",
        borderRadius: "6px",
        borderLeft: `3px solid ${meta.color}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px", gap: "6px" }}>
        <span style={{ fontSize: "0.72rem", fontWeight: 700, padding: "1px 7px", borderRadius: "10px", background: meta.bg, color: meta.text }}>
          {problemLabel(rec.problem)}
        </span>
        {rec.estimated_throughput_gain_pct > 0 && (
          <span style={{ fontSize: "0.68rem", fontWeight: 700, color: "#28a745", whiteSpace: "nowrap", background: "rgba(40,167,69,0.14)", padding: "1px 7px", borderRadius: "10px" }}>
            up to +{rec.estimated_throughput_gain_pct.toFixed(0)}%
          </span>
        )}
      </div>
      <div style={{ fontSize: "0.74rem", fontWeight: 600, color: "#fff", marginBottom: "2px" }}>{rec.element_name}</div>
      <p style={{ fontSize: "0.72rem", color: "#a8b8e8", margin: "0 0 4px 0", lineHeight: 1.35 }}>{rec.action}</p>
      {rec.description && (
        <details>
          <summary style={{ fontSize: "0.68rem", color: "#8fb0d6", cursor: "pointer", listStyle: "none", fontWeight: 600 }}>
            Why?
          </summary>
          <p style={{ fontSize: "0.7rem", color: "#9fb2d6", margin: "4px 0 0 0", lineHeight: 1.4 }}>{rec.description}</p>
        </details>
      )}
    </div>
  );
}

/**
 * Render one group's recommendations organized by severity, then by problem
 * type within each severity, sorted by estimated gain within each problem type.
 */
function SeverityGroupedRecommendations({ recommendations }: { recommendations: Recommendation[] }) {
  return (
    <>
      {SEVERITY_ORDER.map((sev) => {
        const inSeverity = recommendations.filter((r) => r.severity === sev);
        if (inSeverity.length === 0) return null;
        const meta = SEVERITY_META[sev];

        // Group by problem type within this severity, preserving first-seen order.
        const byProblem = new Map<string, Recommendation[]>();
        for (const rec of inSeverity) {
          const list = byProblem.get(rec.problem) ?? [];
          list.push(rec);
          byProblem.set(rec.problem, list);
        }

        return (
          <div key={sev} style={{ marginBottom: "10px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                margin: "0 0 6px 0",
                padding: "3px 8px",
                borderRadius: "6px",
                background: meta.bg,
              }}
            >
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: meta.color, flexShrink: 0 }} />
              <span style={{ fontSize: "0.74rem", fontWeight: 700, color: meta.text }}>{meta.label}</span>
              <span style={{ fontSize: "0.68rem", color: "#8fb0d6" }}>({inSeverity.length})</span>
            </div>

            {Array.from(byProblem.entries()).map(([problem, recs]) => {
              const sorted = [...recs].sort(
                (a, b) => b.estimated_throughput_gain_pct - a.estimated_throughput_gain_pct
              );
              return (
                <div key={problem} style={{ marginBottom: "8px", paddingLeft: "6px" }}>
                  <div style={{ fontSize: "0.66rem", fontWeight: 600, color: "#8ba3c0", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 4px 0" }}>
                    {problemLabel(problem)}
                  </div>
                  {sorted.map((rec, i) => (
                    <RecommendationCard key={`${rec.element_id}-${i}`} rec={rec} />
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

export interface RecommendationsListProps {
  result: SimulationResult;
}

/**
 * The recommendation body: multi-line results group cards under each line's
 * subheading (lines with none show a short "running efficiently" note), and a
 * single-line result renders one flat severity-grouped block or one empty-state
 * note. Within any group, recommendations are organized by severity then
 * problem type.
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
              <SeverityGroupedRecommendations recommendations={line.recommendations} />
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

  return <SeverityGroupedRecommendations recommendations={result.recommendations} />;
}

export default RecommendationsList;