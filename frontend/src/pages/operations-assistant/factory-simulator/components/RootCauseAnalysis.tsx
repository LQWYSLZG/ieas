/**
 * RootCauseAnalysis - the guided, step-by-step diagnosis for one line scope.
 *
 * Walks the user from the whole line down to the constraint station down to its
 * slowest operation, revealing one step at a time (each step names the next),
 * so the root cause is reached deliberately. It reuses the shared diagnosis
 * helpers so its findings always agree with the overall results below it. All
 * values come from the scope the frontend already holds; no backend call.
 *
 * Project rule: no em dashes or en dashes anywhere. Only ASCII hyphens.
 */

import { useState } from "react";
import type { LineScopeView } from "../charts/chartData";
import { effectiveTargetFor, effectiveTaktFor } from "../charts/chartData";
import {
  diagnoseStation,
  bottleneckReason,
  selectConstraintStation,
  slowestOperation,
} from "../diagnosis";

export interface RootCauseAnalysisProps {
  scope: LineScopeView;
  targetThroughput: number;
  /**
   * Count of other flagged issues on this line that are not the primary
   * constraint walked through above. When greater than 0, a closing note
   * points the user to the Recommendations tab for the rest. Defaults to 0.
   */
  otherIssueCount?: number;
}

const cardStyle: React.CSSProperties = {
  padding: "12px 14px",
  background: "rgba(45, 90, 142, 0.15)",
  borderRadius: "8px",
  border: "1px solid rgba(45, 90, 142, 0.3)",
  marginBottom: "10px",
};

const stepLabelStyle: React.CSSProperties = {
  fontSize: "0.66rem",
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#8fb0d6",
  marginBottom: "4px",
};

const stepTitleStyle: React.CSSProperties = {
  fontSize: "0.9rem",
  fontWeight: 700,
  color: "#fff",
  margin: "0 0 6px 0",
};

const bodyTextStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  color: "#dbe6f2",
  lineHeight: 1.45,
  margin: "0 0 8px 0",
};

const nextButtonStyle: React.CSSProperties = {
  marginTop: "4px",
  padding: "7px 12px",
  background: "#2d5a8e",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: "0.78rem",
};

/** Format a percentage to a readable integer-ish string. */
function pct(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0";
  return n.toFixed(0);
}

export function RootCauseAnalysis({ scope, targetThroughput, otherIssueCount = 0 }: RootCauseAnalysisProps) {
  // Steps reveal one at a time: 1 = line only, 2 = + station, 3 = + operation.
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const target = effectiveTargetFor(scope, targetThroughput);
  const takt = effectiveTaktFor(scope);
  const meetsTarget = scope.throughput >= target * 0.98;
  const gapPct = Math.max(0, target > 0 ? ((target - scope.throughput) / target) * 100 : 0);

  const constraint = selectConstraintStation(scope.stations);

  // No stations at all: nothing to diagnose. State it plainly.
  if (!constraint) {
    return (
      <div style={cardStyle}>
        <div style={stepLabelStyle}>Step 1 of 3 - Line</div>
        <p style={bodyTextStyle}>
          This line has no stations to diagnose yet. Add stations and run the
          simulation to trace a root cause.
        </p>
      </div>
    );
  }

  const diag = diagnoseStation(constraint, takt);
  const reason = bottleneckReason(constraint, takt);
  const slowOp = slowestOperation(constraint);

  // Step 1 verdict line.
  const lineVerdict = meetsTarget
    ? `This line meets demand: producing ${pct(scope.throughput)} of ${pct(target)} units/hr needed. The busiest station is ${constraint.station_name}, which you can still examine.`
    : `This line produces ${pct(scope.throughput)} of ${pct(target)} units/hr needed, about ${pct(gapPct)}% short. The main hold-up is ${constraint.station_name}.`;

  return (
    <div>
      {/* Step 1 - Line */}
      <div style={cardStyle}>
        <div style={stepLabelStyle}>Step 1 of 3 - Line</div>
        <h4 style={stepTitleStyle}>Where the line stands</h4>
        <p style={bodyTextStyle}>{lineVerdict}</p>
        {step === 1 && (
          <button type="button" style={nextButtonStyle} onClick={() => setStep(2)}>
            Examine {constraint.station_name} &#8594;
          </button>
        )}
      </div>

      {/* Step 2 - Station */}
      {step >= 2 && (
        <div style={cardStyle}>
          <div style={stepLabelStyle}>Step 2 of 3 - Station</div>
          <h4 style={stepTitleStyle}>
            {constraint.station_name}: {diag.tag}
          </h4>
          <p style={bodyTextStyle}>{reason}</p>
          <p style={{ ...bodyTextStyle, color: "#a8b8e8", fontSize: "0.72rem" }}>
            Time split: Working {pct(constraint.utilization)}%, Starved {pct(constraint.starved_pct)}%,
            Blocked {pct(constraint.blocked_pct)}%, Machine down {pct(constraint.down_pct)}%, Idle{" "}
            {pct(Math.max(0, 100 - constraint.utilization - constraint.starved_pct - constraint.blocked_pct - constraint.down_pct))}%.
          </p>
          <p style={bodyTextStyle}>
            {slowOp
              ? `The slowest step on this station is ${slowOp.name}.`
              : "This station has no recorded operations to break down."}
          </p>
          {step === 2 && (
            <button type="button" style={nextButtonStyle} onClick={() => setStep(3)}>
              {slowOp ? `Look at ${slowOp.name} ` : "See operation detail "}
              &#8594;
            </button>
          )}
        </div>
      )}

      {/* Step 3 - Operation */}
      {step >= 3 && (
        <div style={cardStyle}>
          <div style={stepLabelStyle}>Step 3 of 3 - Operation</div>
          <h4 style={stepTitleStyle}>Root cause</h4>
          {slowOp ? (
            <>
              <p style={bodyTextStyle}>
                {slowOp.name} takes {slowOp.avg_cycle_time.toFixed(0)}s per unit
                {slowOp.operators_required > 0
                  ? ` with ${slowOp.operators_required} operator${slowOp.operators_required === 1 ? "" : "s"} assigned`
                  : " and runs automatically"}
                . This is the step driving {constraint.station_name}, so it is the
                root cause to address first.
              </p>
              <p style={{ ...bodyTextStyle, color: "#a8b8e8", fontSize: "0.72rem", margin: 0 }}>
                All operations on {constraint.station_name}:{" "}
                {(constraint.operations ?? [])
                  .map(
                    (op) =>
                      `${op.is_slowest ? "slowest: " : ""}${op.name} ${op.avg_cycle_time.toFixed(0)}s`
                  )
                  .join(", ") || "none recorded"}
                .
              </p>
            </>
          ) : (
            <p style={bodyTextStyle}>
              {constraint.station_name} has no per-operation breakdown, so the
              root cause sits at the station level: {diag.tag.toLowerCase()}.
              {" "}
              {reason}
            </p>
          )}
        </div>
      )}

      {/* Closing note: the guided flow names the single primary constraint;
          other flagged issues on this line live in the Recommendations tab. */}
      {step >= 3 && otherIssueCount > 0 && (
        <p style={{ ...bodyTextStyle, color: "#a8b8e8", fontSize: "0.74rem", margin: "0 0 10px 0" }}>
          This line also has {otherIssueCount} other flagged{" "}
          {otherIssueCount === 1 ? "issue" : "issues"}. See the Recommendations
          tab for each one and how to fix it.
        </p>
      )}
    </div>
  );
}

export default RootCauseAnalysis;