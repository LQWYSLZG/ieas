/**
 * OptimizeReviewPanel: the review-then-apply surface for an Auto-Optimize run.
 *
 * It is shown when the optimize flow has entered its review step and the
 * backend returned a reviewable proposal (status "optimal" or
 * "feasible_timeout"). For a reviewable proposal it renders, top to bottom:
 *
 *   - the ChangeList built from response.change_list (Req 7.1 to 7.5, via the
 *     ChangeList component),
 *   - the optimality gap as a percentage when the solve stopped at its time
 *     limit (status "feasible_timeout"). The value is read directly from the
 *     already-received response (response.optimality_gap_pct), so it appears
 *     immediately with no extra request, well within the 2-second budget
 *     (Req 5.3). A proven-optimal solve (status "optimal") is a zero gap by
 *     definition, so it is noted as optimal rather than shown as a gap,
 *   - the reused ComparisonView, fed a before scenario built from the current
 *     layout and response.before_metrics and an after scenario built from
 *     response.proposed_layout and response.after_metrics, so the deltas read
 *     before -> after (Req 8.1 to 8.3). ComparisonView is reused unchanged,
 *   - an enabled Apply control that is visually distinct from the Discard
 *     control (Req 9.1, 10.1). Apply is the primary action; Discard is the
 *     secondary action. This panel only invokes the onApply / onDiscard
 *     callbacks; wiring Apply and Discard into the LayoutContext reducer is a
 *     later task.
 *
 * The non-reviewable statuses each render a plain-language message and no
 * proposal, since there is no valid configuration to apply:
 *
 *   - infeasible (Req 6.2 to 6.5): names exactly one binding constraint
 *     category from response.binding_category (takt_capacity, operator_cap,
 *     machine_cap, or locks), maps it to a plain-language explanation and the
 *     lever the user can relax, and presents no proposal (no ChangeList, no
 *     ComparisonView, no Apply),
 *   - no_feasible_timeout (Req 5.4): states that no feasible configuration was
 *     found within the time limit, presents no before/after as success and no
 *     proposal,
 *   - validation_failed (Req 4.3): states that validation did not complete and
 *     does not present after metrics as a success or a proposal as applicable.
 *
 * All three offer only a single Dismiss control (via onDiscard), since there is
 * nothing to apply.
 *
 * This file follows the project rule that no em dashes or en dashes appear
 * anywhere; only ASCII hyphens are used, in code, comments, and strings.
 * Box-drawing dividers (U+2550) match the suite house style.
 *
 * Requirements: 4.3, 5.3, 5.4, 6.2, 6.3, 6.4, 6.5, 8.1, 8.2, 8.3, 9.1, 10.1.
 */

import type { ReactNode } from "react";
import type { Layout, OptimizeResponse, Scenario, SimulationResult } from "../types";
import { ChangeList } from "./ChangeList";
import { ComparisonView } from "./ComparisonView";

export interface OptimizeReviewPanelProps {
  /** The response received from the optimize endpoint, under review. */
  response: OptimizeResponse;
  /** The layout currently on the canvas, used as the before scenario. */
  currentLayout: Layout;
  /** Invoked when the user applies the proposal. Reducer wiring is a later task. */
  onApply: () => void;
  /** Invoked when the user discards the proposal, leaving the layout unchanged. */
  onDiscard: () => void;
}

// A labeled subsection inside the review body, giving the change list and the
// comparison each a clear heading so the panel reads as distinct steps rather
// than one dense block.
const reviewSubsectionStyle: React.CSSProperties = {
  marginTop: "16px",
};

const reviewSubheadingStyle: React.CSSProperties = {
  fontSize: "0.9rem",
  fontWeight: 700,
  color: "#d4a017",
  margin: "0 0 8px 0",
};

/**
 * Build a Scenario wrapper for ComparisonView from a layout and its simulated
 * result. ComparisonView takes a full Scenario, so a synthetic id and timestamp
 * are supplied; neither is rendered by ComparisonView, which only reads
 * scenario.result for metrics and the layout context for station names.
 */
function buildScenario(id: string, layout: Layout, result: SimulationResult): Scenario {
  return {
    id,
    timestamp: Date.now(),
    layout,
    result,
  };
}

/**
 * The gap banner shown for a feasible_timeout solve. The value comes straight
 * off the response so it renders immediately (Req 5.3). It is clamped defensively
 * to the documented 0.00 to 100.00 percentage range and shown to two decimals.
 */
function GapBanner({ gapPct }: { gapPct: number }) {
  const clamped = Math.min(100, Math.max(0, gapPct));
  return (
    <div
      className="optimize-gap-banner"
      role="status"
      style={{
        padding: "8px 12px",
        marginBottom: "12px",
        borderRadius: "6px",
        background: "rgba(212,160,23,0.14)",
        borderLeft: "3px solid #d4a017",
        fontSize: "0.78rem",
        color: "#e8c35a",
        lineHeight: 1.4,
      }}
    >
      Stopped at the time limit with the best feasible configuration found.
      Optimality gap: {clamped.toFixed(2)}%. A smaller gap means the proposal is
      closer to the best possible result.
    </div>
  );
}

/** A short note that a proven-optimal solve has no remaining gap. */
function OptimalBanner() {
  return (
    <div
      className="optimize-optimal-banner"
      role="status"
      style={{
        padding: "8px 12px",
        marginBottom: "12px",
        borderRadius: "6px",
        background: "rgba(40,167,69,0.14)",
        borderLeft: "3px solid #28a745",
        fontSize: "0.78rem",
        color: "#5fce7f",
        lineHeight: 1.4,
      }}
    >
      Solved to the best possible configuration. Optimality gap: 0.00%.
    </div>
  );
}

/**
 * The Apply and Discard controls. Apply is the primary action and is visually
 * distinct from the secondary Discard control (Req 9.1, 10.1). Apply is always
 * enabled while a reviewable proposal is shown.
 */
function ReviewActions({ onApply, onDiscard }: { onApply: () => void; onDiscard: () => void }) {
  return (
    <div
      className="optimize-review-actions"
      style={{ display: "flex", gap: "10px", marginTop: "14px", justifyContent: "flex-end" }}
    >
      <button
        type="button"
        className="optimize-discard-button"
        onClick={onDiscard}
        style={{
          padding: "8px 16px",
          borderRadius: "6px",
          border: "1px solid #3a4b68",
          background: "transparent",
          color: "#a8b8e8",
          fontSize: "0.8rem",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Discard
      </button>
      <button
        type="button"
        className="optimize-apply-button"
        onClick={onApply}
        style={{
          padding: "8px 16px",
          borderRadius: "6px",
          border: "1px solid #2d8ecf",
          background: "#2d8ecf",
          color: "#ffffff",
          fontSize: "0.8rem",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Apply
      </button>
    </div>
  );
}

/**
 * The reviewable-proposal body, shared by the optimal and feasible_timeout
 * statuses. It renders the change list, the gap or optimal note, the reused
 * comparison, and the Apply and Discard controls.
 */
function ReviewBody({
  response,
  currentLayout,
  onApply,
  onDiscard,
}: OptimizeReviewPanelProps) {
  // before_metrics, after_metrics, and proposed_layout are present for a
  // reviewable proposal. Guard defensively so a malformed response renders a
  // message rather than crashing.
  const beforeMetrics = response.before_metrics ?? null;
  const afterMetrics = response.after_metrics ?? null;
  const proposedLayout = response.proposed_layout ?? null;

  const isTimeout = response.status === "feasible_timeout";
  const gapPct = response.optimality_gap_pct ?? null;

  const beforeScenario =
    beforeMetrics !== null ? buildScenario("before", currentLayout, beforeMetrics) : null;
  const afterScenario =
    afterMetrics !== null && proposedLayout !== null
      ? buildScenario("after", proposedLayout, afterMetrics)
      : null;

  const hasChanges = response.change_list.length > 0;

  return (
    <div className="optimize-review-panel">
      <h3 style={{ margin: "0 0 4px 0", fontSize: "1.05rem", fontWeight: 700, color: "#d4a017" }}>
        Proposed configuration
      </h3>
      <p style={{ margin: "0 0 12px 0", fontSize: "0.82rem", color: "#8ba3c0", lineHeight: 1.45 }}>
        Review the proposed changes and the before and after comparison below. Nothing is applied to
        your canvas until you choose Apply.
      </p>

      {isTimeout && gapPct !== null ? <GapBanner gapPct={gapPct} /> : null}
      {response.status === "optimal" ? <OptimalBanner /> : null}

      <div style={reviewSubsectionStyle}>
        <div style={reviewSubheadingStyle}>
          {hasChanges ? "What would change" : "Changes"}
        </div>
        <ChangeList items={response.change_list} />
      </div>

      <div style={reviewSubsectionStyle}>
        <div style={reviewSubheadingStyle}>Current state vs after state</div>
        <ComparisonView scenarioA={beforeScenario} scenarioB={afterScenario} />
      </div>

      <ReviewActions onApply={onApply} onDiscard={onDiscard} />
    </div>
  );
}

/**
 * The single Dismiss control shown for the non-reviewable statuses. There is no
 * proposal to apply, so only a secondary Dismiss action is offered; it reuses
 * the onDiscard callback that leaves the layout unchanged (Req 10.2).
 */
function DismissAction({ onDiscard }: { onDiscard: () => void }) {
  return (
    <div
      className="optimize-review-actions"
      style={{ display: "flex", gap: "10px", marginTop: "14px", justifyContent: "flex-end" }}
    >
      <button
        type="button"
        className="optimize-discard-button"
        onClick={onDiscard}
        style={{
          padding: "8px 16px",
          borderRadius: "6px",
          border: "1px solid #3a4b68",
          background: "transparent",
          color: "#a8b8e8",
          fontSize: "0.8rem",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * A status message block shared by the non-reviewable statuses. It carries a
 * heading, an accent color, and the plain-language body, and is visually
 * consistent with the review panel's banners. It never renders a proposal.
 */
function StatusMessage({
  heading,
  accent,
  background,
  color,
  children,
}: {
  heading: string;
  accent: string;
  background: string;
  color: string;
  children: ReactNode;
}) {
  return (
    <div className="optimize-review-panel">
      <h3 style={{ margin: "0 0 10px 0", fontSize: "0.95rem", color: "#dce7f5" }}>{heading}</h3>
      <div
        role="status"
        style={{
          padding: "10px 12px",
          borderRadius: "6px",
          background,
          borderLeft: `3px solid ${accent}`,
          fontSize: "0.8rem",
          color,
          lineHeight: 1.5,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Map each infeasibility binding category to a plain-language explanation and
 * the lever the user can relax (Req 6.2 to 6.5). The category comes from
 * response.binding_category; exactly one is named so the user has a single clear
 * thing to change. An unknown or missing category falls back to a safe generic
 * note so the panel never crashes on a malformed response.
 */
function describeBindingCategory(
  category: OptimizeResponse["binding_category"],
): { label: string; explanation: string } {
  switch (category) {
    case "takt_capacity":
      return {
        label: "Takt capacity",
        explanation:
          "The work assigned to a line cannot fit within its takt time with the machines allowed. Relax the takt target (allow a slower pace), enable adding machines, or raise the machine cap so stations gain capacity.",
      };
    case "operator_cap":
      return {
        label: "Operator cap",
        explanation:
          "There are not enough operators allowed to staff a feasible configuration. Raise the operator cap so the optimizer can assign the operators the work needs.",
      };
    case "machine_cap":
      return {
        label: "Machine cap",
        explanation:
          "There are not enough machines allowed to meet takt at every station. Raise the machine cap (or the per-station machine limit), or enable adding machines.",
      };
    case "locks":
      return {
        label: "Locks",
        explanation:
          "The locked operation assignments leave no feasible configuration. Remove or loosen one or more station locks so the optimizer can move the pinned operations.",
      };
    default:
      return {
        label: "Constraints",
        explanation:
          "The current constraints leave no feasible configuration. Relax the takt target, the operator cap, the machine cap, or the station locks and try again.",
      };
  }
}

/**
 * The infeasible branch (Req 6.2 to 6.5). It names exactly one binding
 * constraint category and explains the lever the user can relax. It also shows
 * the backend-provided response.message when present. It renders no proposal:
 * no ChangeList, no ComparisonView, and no Apply.
 */
function InfeasibleMessage({ response, onDiscard }: OptimizeReviewPanelProps) {
  const { label, explanation } = describeBindingCategory(response.binding_category);
  const backendMessage = response.message?.trim() ?? "";

  return (
    <StatusMessage
      heading="No feasible configuration"
      accent="#d9534f"
      background="rgba(217,83,79,0.14)"
      color="#f0a6a3"
    >
      <p style={{ margin: "0 0 6px 0" }}>
        The constraints cannot be satisfied, so no configuration can be proposed. The most likely
        binding constraint is: <strong>{label}</strong>.
      </p>
      <p style={{ margin: "0 0 6px 0" }}>{explanation}</p>
      {backendMessage.length > 0 ? (
        <p style={{ margin: "6px 0 0 0", color: "#d7c3c2" }}>{backendMessage}</p>
      ) : null}
      <DismissAction onDiscard={onDiscard} />
    </StatusMessage>
  );
}

/**
 * The no_feasible_timeout branch (Req 5.4). No feasible configuration was found
 * within the time limit, so there is no before/after success and no proposal.
 * It shows the backend message when present, otherwise a clear default.
 */
function NoFeasibleTimeoutMessage({ response, onDiscard }: OptimizeReviewPanelProps) {
  const backendMessage = response.message?.trim() ?? "";
  const body =
    backendMessage.length > 0
      ? backendMessage
      : "No feasible configuration was found within the time limit. Try relaxing the constraints, enabling added machines, or raising the operator or machine caps, then run again.";

  return (
    <StatusMessage
      heading="No result within the time limit"
      accent="#d4a017"
      background="rgba(212,160,23,0.14)"
      color="#e8c35a"
    >
      <p style={{ margin: 0 }}>{body}</p>
      <DismissAction onDiscard={onDiscard} />
    </StatusMessage>
  );
}

/**
 * The validation_failed branch (Req 4.3). Validating the proposed configuration
 * through the simulation did not complete, so after metrics are not presented
 * as a success and no proposal is presented as applicable. It shows the backend
 * message when present, otherwise a clear default.
 */
function ValidationFailedMessage({ response, onDiscard }: OptimizeReviewPanelProps) {
  const backendMessage = response.message?.trim() ?? "";
  const body =
    backendMessage.length > 0
      ? backendMessage
      : "Validation of the proposed configuration did not complete, so the before and after metrics cannot be shown as a result. Your current layout is unchanged.";

  return (
    <StatusMessage
      heading="Validation did not complete"
      accent="#d9534f"
      background="rgba(217,83,79,0.14)"
      color="#f0a6a3"
    >
      <p style={{ margin: 0 }}>{body}</p>
      <DismissAction onDiscard={onDiscard} />
    </StatusMessage>
  );
}

/**
 * The no_improvement branch. The optimizer found a feasible plan, but the real
 * simulation scored it no better than the current layout, so the service kept
 * the current layout rather than propose a worse one. No proposal is shown; the
 * backend message explains the throughput that would have been lost and suggests
 * giving the optimizer more room.
 */
function NoImprovementMessage({ response, onDiscard }: OptimizeReviewPanelProps) {
  const backendMessage = response.message?.trim() ?? "";
  const body =
    backendMessage.length > 0
      ? backendMessage
      : "No improvement was found that keeps your current output, so your current layout is kept unchanged.";

  return (
    <StatusMessage
      heading="No improvement found"
      accent="#d4a017"
      background="rgba(212,160,23,0.14)"
      color="#e8c35a"
    >
      <p style={{ margin: 0 }}>{body}</p>
      <DismissAction onDiscard={onDiscard} />
    </StatusMessage>
  );
}

/**
 * OptimizeReviewPanel routes on the response status. The reviewable statuses
 * (optimal, feasible_timeout) render the full review body with Apply and
 * Discard. The non-reviewable statuses (infeasible, no_feasible_timeout,
 * validation_failed) each render a plain-language message and a single Dismiss
 * control, and present no proposal.
 */
export function OptimizeReviewPanel(props: OptimizeReviewPanelProps) {
  const { response } = props;

  switch (response.status) {
    case "optimal":
    case "feasible_timeout":
      return <ReviewBody {...props} />;

    case "infeasible":
      return <InfeasibleMessage {...props} />;

    case "no_feasible_timeout":
      return <NoFeasibleTimeoutMessage {...props} />;

    case "validation_failed":
      return <ValidationFailedMessage {...props} />;

    case "no_improvement":
      return <NoImprovementMessage {...props} />;

    default:
      return null;
  }
}

export default OptimizeReviewPanel;
