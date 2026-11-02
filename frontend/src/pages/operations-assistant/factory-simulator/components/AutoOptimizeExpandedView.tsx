/**
 * AutoOptimizeExpandedView - the full Auto-Optimize workflow, shown inside the
 * Optimize step's expanded overlay.
 *
 * Layout: the overlay is wide, so the workflow uses a two-column grid. The left
 * column holds the setup (intro, Run control, in-progress / error, and the
 * constraints form). The right column holds the review-then-apply surface. When
 * there is no proposal under review yet, the setup column spans the full width.
 *
 * This component owns no state. The page remains the single source of truth.
 *
 * Project rule: no em dashes or en dashes anywhere. Only ASCII hyphens.
 */

import type { Layout, OptimizeConstraints, OptimizeResponse, SimulationResult } from "../types";
import { RecommendationsList } from "./RecommendationsList";
import { ConstraintsForm } from "./ConstraintsForm";
import { OptimizeReviewPanel } from "./OptimizeReviewPanel";
import "./ExpandedView.css";

/** The optimize trigger state, mirrored from the page's state machine. */
export type OptimizeState = "idle" | "running" | "review" | "error";

export interface AutoOptimizeExpandedViewProps {
  result: SimulationResult;
  layout: Layout;
  optimizeState: OptimizeState;
  optimizeResponse: OptimizeResponse | null;
  optimizeError: string | null;
  showConstraints: boolean;
  onToggleConstraints: () => void;
  onConstraintsChange: (constraints: OptimizeConstraints) => void;
  onRun: () => void;
  onApply: () => void;
  onDiscard: () => void;
}

const sectionHeadingStyle: React.CSSProperties = {
  color: "#d4a017",
  fontSize: "1.15rem",
  fontWeight: 700,
  letterSpacing: "0.3px",
  margin: "0 0 10px 0",
};

export function AutoOptimizeExpandedView({
  result,
  layout,
  optimizeState,
  optimizeResponse,
  optimizeError,
  showConstraints,
  onToggleConstraints,
  onConstraintsChange,
  onRun,
  onApply,
  onDiscard,
}: AutoOptimizeExpandedViewProps) {
  const isRunning = optimizeState === "running";
  const hasReview = optimizeState === "review" && optimizeResponse !== null;

  return (
    <div className="ao-expanded">
      <section className="ao-expanded__recommendations">
        <h2 style={sectionHeadingStyle}>Recommendations</h2>
        <RecommendationsList result={result} />
      </section>

      <hr className="ao-expanded__divider" />

      <section className="ao-expanded__workflow">
        <div className="ao-expanded__setup">
          <h2 style={sectionHeadingStyle}>Auto-Optimize</h2>
          <p className="ao-expanded__intro">
            Use advanced models to search for a better station assignment and staffing settings
            automatically, then review a current state and after state comparison before applying any
            changes on your simulation canva.
          </p>

          <button
            type="button"
            className="ao-expanded__toggle"
            onClick={onToggleConstraints}
            disabled={isRunning}
          >
            {showConstraints ? "Hide Auto-Optimize" : "Get Started with Settings"}
          </button>

          {isRunning && (
            <div className="ao-expanded__status" role="status" aria-live="polite">
              <span aria-hidden="true" className="factory-simulator-optimize-spinner" />
              Auto-Optimize is running. This can take up to 30 seconds.
            </div>
          )}

          {optimizeError && (
            <p className="ao-expanded__error" role="alert">
              {optimizeError}
            </p>
          )}

          {showConstraints && (
            <div className="ao-expanded__form">
              <ConstraintsForm layout={layout} onChange={onConstraintsChange} />
              <button
                type="button"
                className="ao-expanded__run"
                onClick={onRun}
                disabled={isRunning}
              >
                {isRunning ? "Optimizing..." : "Run Auto-Optimize"}
              </button>
            </div>
          )}

          {hasReview && (
            <div className="ao-expanded__review">
              <OptimizeReviewPanel
                response={optimizeResponse}
                currentLayout={layout}
                onApply={onApply}
                onDiscard={onDiscard}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export default AutoOptimizeExpandedView;
