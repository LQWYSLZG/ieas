/**
 * FactorySimulatorPage - Top-level page for the Factory Floor Simulator.
 *
 * Uses the same 3-panel layout for all stages:
 * - Left: Elements palette (greyed out when not in Setup)
 * - Center: Canvas
 * - Right: Properties (Setup) / Results (Simulate) / Recommendations (Optimize)
 */

import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { LayoutProvider, useLayout } from "../context/LayoutContext";
import { isApiError } from "../../../../lib/apiClient";
import { warmUpBackend } from "../../../../lib/warmup";
import SimulatorCanvas from "./SimulatorCanvas";
import { StationPalette } from "./StationPalette";
import { PropertiesPanel } from "./PropertiesPanel";
import { ResultsPanel } from "./ResultsPanel";
import { TimeStudyImporter } from "./TimeStudyImporter";
import { HelpIcon } from "./HelpIcon";
import { ExpandedViewModal } from "./ExpandedViewModal";
import { ResultsExpandedView } from "./ResultsExpandedView";
import { RecommendationsList } from "./RecommendationsList";
import { AutoOptimizeExpandedView } from "./AutoOptimizeExpandedView";
import type { Layout, OptimizeConstraints, OptimizeResponse, SimulationResult } from "../types";
import { applyOptimizeProposal } from "../utils/applyOptimize";
import "./FactorySimulatorPage.css";

// Auto-Optimize trigger state machine (task 13). "idle" before any run,
// "running" while a request is in flight, "review" once a response is stored,
// and "error" when a required-input check or the request itself fails. Task
// 13.2 fills in the in-progress, timeout, and failure UI on top of this.
type OptimizeState = "idle" | "running" | "review" | "error";

/**
 * Required-input check for an Auto-Optimize run (Req 1.5). Returns the plain
 * names of every missing required input so the caller can name each one in a
 * single message without starting the run:
 *   - Takt_Time: a usable positive takt derived from the Line Settings.
 *   - Operations: at least one operation present in the layout. A station with
 *     a non-empty operations list counts; a station with an empty list but a
 *     positive flat cycle_time contributes a synthetic operation on the backend
 *     and so counts as well (mirrors the backend builder fallback).
 * Returns an empty array when nothing is missing.
 */
export function checkRequiredInputs(layout: Layout, taktTime: number): string[] {
  const missing: string[] = [];
  if (!(taktTime > 0)) {
    missing.push("Takt Time");
  }
  const hasOperation = layout.stations.some(
    (s) => (s.operations?.length ?? 0) > 0 || s.cycle_time > 0,
  );
  if (!hasOperation) {
    missing.push("Operations");
  }
  return missing;
}

/** Build the "missing required inputs" message naming each item (Req 1.5). */
function namedMissingMessage(missing: string[]): string {
  const names = missing.join(" and ");
  return `Cannot optimize yet. Add the following before running: ${names}.`;
}

/**
 * Turn a caught error from the optimize request into the message shown in the
 * Optimize stage, distinguishing the two terminal outcomes the task 13.2
 * requirements call out:
 *
 *   - Client timeout (Req 1.6): the apiClient aborts the request at the 30000
 *     ms client timeout and throws an ApiError with isNetworkError true and
 *     message "Request timed out". That specific signal maps to a
 *     "did not complete in time" message so the user knows the run was stopped
 *     for taking too long rather than failing outright.
 *   - Any other failure (Req 1.7): a 4xx/5xx response (ApiError with a status
 *     and an optional body.detail) or a real network error. We prefer the
 *     backend-provided detail when present (the same body.detail shape
 *     handleRunSimulation extracts), falling back to a generic failed message.
 *
 * Either way the caller leaves the layout unchanged and returns the state to a
 * non-running value so the action is enabled again for a retry (Req 1.6, 1.7).
 * This is a pure function of the error so it can be unit tested directly
 * (task 13.3).
 */
export function optimizeErrorMessage(err: unknown): string {
  if (isApiError(err)) {
    // A client-side AbortController timeout surfaces as a network error whose
    // message indicates a timeout. Treat that as the Req 1.6 case.
    const timedOut =
      err.status === null &&
      err.isNetworkError &&
      /timed out|timeout/i.test(err.message);
    if (timedOut) {
      return "The Auto-Optimize run did not complete in time (30 seconds). Your layout is unchanged. Please try again.";
    }

    // A real network failure (not the timeout abort): no response arrived.
    if (err.status === null && err.isNetworkError) {
      return "The Auto-Optimize run failed: the server could not be reached. Your layout is unchanged. Please try again.";
    }

    // An HTTP error (4xx/5xx). Prefer the backend detail when present, the same
    // way handleRunSimulation surfaces body.detail.
    if (err.body && typeof err.body === "object") {
      const body = err.body as Record<string, unknown>;
      if (typeof body.detail === "string") {
        return `The Auto-Optimize run failed: ${body.detail} Your layout is unchanged.`;
      }
      if (Array.isArray(body.detail)) {
        const firstErr = body.detail[0];
        if (firstErr && typeof firstErr === "object" && "msg" in firstErr) {
          return `The Auto-Optimize run failed: ${String(
            (firstErr as { msg: string }).msg,
          )} Your layout is unchanged.`;
        }
      }
    }
    return `The Auto-Optimize run failed: ${err.message}. Your layout is unchanged. Please try again.`;
  }

  return "The Auto-Optimize run failed. Your layout is unchanged. Please try again.";
}

/**
 * Baseline constraints derived from the current layout, used when the user runs
 * Auto-Optimize without editing any field. ConstraintsForm only reports changes
 * through onChange, so on a zero-edit run the parent still holds null; this
 * fallback reproduces the same current-layout baseline the form seeds itself
 * with (operator and machine totals, no locks, no precedence edits, machine
 * toggle off, weights of 1), so a no-edit run sends the baseline (Req 1.2).
 */
export function defaultOptimizeConstraints(layout: Layout): OptimizeConstraints {
  // Caps default to 0, the "no artificial limit" sentinel the backend reads:
  // the data and the utilization ceiling decide the resource need. The user
  // only sets a real cap by opting into facility limits in the form.
  // Default every operation to locked at its current station, using the same
  // stable "station_id index" key scheme the backend and ConstraintsForm use
  // (a station with no operations contributes one synthetic op at index 0). A
  // zero-edit run then keeps the current assignment and only tunes resources.
  const locks = layout.stations.flatMap((s) => {
    const ops = s.operations ?? [];
    if (ops.length > 0) {
      return ops.map((_op, index) => ({ operation: `${s.id} ${index}`, station_id: s.id }));
    }
    return [{ operation: `${s.id} 0`, station_id: s.id }];
  });
  return {
    precedence: [],
    locks,
    operator_cap: 0,
    machine_cap: 0,
    per_station_machine_limit: null,
    allow_add_machines: true,
    operator_weight: 1,
    machine_weight: 1,
    utilization_ceiling: 0.85,
  };
}

type WorkflowStage = "Setup" | "Simulate" | "Optimize";

const STAGES: WorkflowStage[] = ["Setup", "Simulate", "Optimize"];

function FactorySimulatorContent() {
  const [stage, setStage] = useState<WorkflowStage>("Setup");
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);

  // Auto-Optimize state (task 13). optimizeState drives the Optimize-stage UI
  // (idle -> running -> review, or -> error); optimizeResponse holds the stored
  // OptimizeResponse once a run returns; optimizeError holds the message shown
  // on a required-input failure or a request failure. optimizeConstraints is
  // fed by ConstraintsForm's onChange and sent with the request. showConstraints
  // toggles the ConstraintsForm open from the Auto-Optimize action (Req 1.1,
  // 1.2). Task 13.2 adds the in-progress indicator, the 30s timeout message, and
  // the failure/re-enable handling on top of this state.
  const [optimizeState, setOptimizeState] = useState<OptimizeState>("idle");
  const [optimizeResponse, setOptimizeResponse] = useState<OptimizeResponse | null>(null);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [optimizeConstraints, setOptimizeConstraints] = useState<OptimizeConstraints | null>(null);
  const [showConstraints, setShowConstraints] = useState(false);

  // Expanded-view overlay state. null means the overlay is closed and only the
  // compact panels render. "results" or "recommendations" names which view is
  // expanded. This is pure client state; opening the overlay issues no backend
  // request (Req 1.6). triggerRef records the Expand_Control element that opened
  // the overlay so focus can be restored to it on close (Reqs 2.2, 2.3, 9.5).
  const [expandedView, setExpandedView] = useState<null | "results" | "recommendations">(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // "Server waking up" hint: when a run has not resolved within a few seconds
  // it is likely a Render free-tier cold start, so we show a small non-blocking
  // note near the Run button. The timeout id is kept in a ref so it can be
  // cleared reliably in the finally block.
  const [isWakingServer, setIsWakingServer] = useState(false);
  const wakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restart flow: confirmation dialog + post-restart success toast.
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [showRestartDone, setShowRestartDone] = useState(false);

  // Auto-Optimize apply success toast: confirms the proposal was applied to the
  // canvas, since the review simply closes otherwise and it is not obvious the
  // change landed.
  const [showApplyDone, setShowApplyDone] = useState(false);

  // Line Settings state - user inputs
  const [shiftsPerDay, setShiftsPerDay] = useState(1);
  const [hoursPerShift, setHoursPerShift] = useState(8);
  const [breakMinutes, setBreakMinutes] = useState(30);
  const [dailyDemand, setDailyDemand] = useState(400);

  // Calculated values
  const netSecondsPerDay = shiftsPerDay * ((hoursPerShift * 3600) - (breakMinutes * 60));
  const taktTime = netSecondsPerDay > 0 && dailyDemand > 0 ? netSecondsPerDay / dailyDemand : 60;
  const targetThroughput = taktTime > 0 ? 3600 / taktTime : 60;
  const shiftDuration = hoursPerShift - (breakMinutes / 60);

  const { layout, dispatch } = useLayout();

  // Full restart: wipe the layout (elements, connections, uploaded floor plan /
  // time study), scenarios, results, selection, and any errors, and return to
  // the Setup stage. A confirmation dialog gates it since it is destructive,
  // and a success toast confirms completion afterward.
  function performRestart() {
    dispatch({ type: "CLEAR" });
    setSimulationResult(null);
    setSimulationError(null);
    setSelectedElementId(null);
    setIsSimulating(false);
    // Clear the expanded overlay and any Auto-Optimize review so neither can
    // linger and reappear after the reset.
    setExpandedView(null);
    resetOptimizeReview();
    setStage("Setup");
    setShowRestartConfirm(false);
    setShowRestartDone(true);
  }

  // Auto-dismiss the "restarted" toast after a short delay.
  useEffect(() => {
    if (!showRestartDone) return;
    const t = setTimeout(() => setShowRestartDone(false), 2600);
    return () => clearTimeout(t);
  }, [showRestartDone]);

  // Auto-dismiss the "applied" toast after a short delay.
  useEffect(() => {
    if (!showApplyDone) return;
    const t = setTimeout(() => setShowApplyDone(false), 4000);
    return () => clearTimeout(t);
  }, [showApplyDone]);

  // Wake-on-entry: start warming the Render free-tier backend when this page
  // mounts to hide the cold start. Throttled and fire-and-forget, so it never
  // blocks or breaks the UI.
  useEffect(() => {
    warmUpBackend();
  }, []);

  async function handleRunSimulation() {
    setIsSimulating(true);
    setSimulationError(null);
    setIsWakingServer(false);
    // Clear any stale prior result and selection before a fresh run so
    // re-running after edits never shows leftover state from the last run.
    setSimulationResult(null);
    setSelectedElementId(null);

    // If the request has not resolved within 4 seconds, assume the backend is
    // waking up from idle and show a small non-blocking note.
    wakingTimerRef.current = setTimeout(() => setIsWakingServer(true), 4000);

    try {
      const { apiRequest } = await import("../../../../lib/apiClient");
      const result = await apiRequest<SimulationResult>(
        "POST",
        "/operations-assistant/simulator/run",
        {
          body: {
            layout: {
              ...layout,
              sources: layout.sources.map((s) => ({
                ...s,
                // arrival_rate 0 = auto-match Target Throughput.
                // A positive value is a manual override set in Advanced.
                arrival_rate: s.arrival_rate > 0 ? s.arrival_rate : targetThroughput,
              })),
            },
            config: {
              duration_seconds: shiftDuration * 3600,
              warmup_seconds: 300,
              target_throughput: targetThroughput,
              takt_time: taktTime,
            },
          },
          // Long timeout so the first run after a Render free-tier cold start
          // (about 50 to 60 seconds to wake) does not abort as a false network error.
          timeout: 90_000,
        }
      );
      setSimulationResult(result);
      setStage("Simulate");
    } catch (err: unknown) {
      // Network/timeout failures are most likely a cold start still waking up,
      // so we soften the message and invite a retry. Real 4xx/validation errors
      // keep their specific detail below.
      if (isApiError(err) && (err.isNetworkError || err.status === null)) {
        setSimulationError(
          "The server did not respond in time. It may be waking up from idle, please try again in a moment."
        );
      } else if (err && typeof err === "object" && "message" in err) {
        const apiErr = err as { message: string; body?: unknown };
        let detail = "Simulation failed.";
        if (apiErr.body && typeof apiErr.body === "object") {
          const body = apiErr.body as Record<string, unknown>;
          if (typeof body.detail === "string") {
            detail = body.detail;
          } else if (Array.isArray(body.detail)) {
            const firstErr = body.detail[0];
            if (firstErr && typeof firstErr === "object" && "msg" in firstErr) {
              detail = String((firstErr as { msg: string }).msg);
            }
          } else {
            detail = apiErr.message;
          }
        } else {
          detail = apiErr.message;
        }
        setSimulationError(detail);
      } else {
        setSimulationError("Simulation failed. Ensure Source → Station → Sink are connected.");
      }
    } finally {
      if (wakingTimerRef.current !== null) {
        clearTimeout(wakingTimerRef.current);
        wakingTimerRef.current = null;
      }
      setIsWakingServer(false);
      setIsSimulating(false);
    }
  }

  // Auto-Optimize trigger flow (task 13.1, Req 1.3, 1.5, 1.6, 12.4).
  //
  // First it runs the required-input check (Req 1.5): if Takt_Time or any
  // Operation is missing it shows a message naming each missing input and does
  // NOT start the run. Otherwise it POSTs the OptimizeRequest body
  // { layout, constraints, config } to the optimize endpoint through the shared
  // apiClient, matching handleRunSimulation (dynamic import of apiRequest, a
  // body plus a bounded client timeout). The client timeout is 30000 ms so the
  // client stops waiting at 30 seconds (Req 1.6). On success it stores the
  // OptimizeResponse and moves to "review".
  //
  // Seam for task 13.2: the in-progress indicator, the 30-second did-not-
  // complete-in-time message, and the specific failure handling with the action
  // re-enabled are added by 13.2. Here the catch records a minimal error and
  // moves to "error" so the trigger is complete and safe; 13.2 refines the
  // messages (timeout vs failure) and the re-enable behavior.
  //
  // No-silent-mutation guarantee (Req 9.8), audited for task 16.2: running the
  // optimizer never changes the canvas. Every state change in this function is a
  // React local-state setter (setOptimizeError, setOptimizeResponse,
  // setOptimizeState); none of them is dispatch. The request reads `layout` into
  // the POST body but never writes it back. On success the response is stored
  // and the flow moves to "review" WITHOUT dispatching any layout action, so the
  // proposal only sits in local state awaiting an explicit Apply. On a missing-
  // input, timeout, or failure outcome the flow moves to "error", again with no
  // dispatch, so the Current_Layout is left unchanged (Req 1.4, 1.6, 1.7). The
  // sole path in the whole Auto-Optimize flow that dispatches a layout-mutating
  // action is handleApplyOptimize -> applyOptimizeProposal.
  async function handleOptimize(constraints: OptimizeConstraints) {
    // Req 1.5: validate required inputs first and name each missing one.
    const missing = checkRequiredInputs(layout, taktTime);
    if (missing.length > 0) {
      setOptimizeError(namedMissingMessage(missing));
      setOptimizeState("error");
      return;
    }

    setOptimizeError(null);
    setOptimizeResponse(null);
    setOptimizeState("running");

    try {
      const { apiRequest } = await import("../../../../lib/apiClient");
      const res = await apiRequest<OptimizeResponse>(
        "POST",
        "/operations-assistant/simulator/optimize",
        {
          // The OptimizeRequest body: the current layout, the constraints from
          // the ConstraintsForm, and the same config handleRunSimulation builds
          // (duration, warmup, target throughput, takt). Sources are left as-is;
          // the backend resolves arrival defaults.
          body: {
            layout,
            constraints,
            config: {
              duration_seconds: shiftDuration * 3600,
              warmup_seconds: 300,
              target_throughput: targetThroughput,
              takt_time: taktTime,
            },
          },
          // Client stops waiting at 30 seconds (Req 1.3, 1.6, 12.4).
          timeout: 30_000,
        }
      );
      setOptimizeResponse(res);
      setOptimizeState("review");
    } catch (err: unknown) {
      // Terminal-outcome handling (task 13.2). optimizeErrorMessage picks the
      // Req 1.6 "did not complete in time" message when the apiClient aborted
      // at the 30000 ms client timeout (isNetworkError with a timeout message),
      // otherwise the Req 1.7 failed message, preferring the backend detail.
      // Moving to "error" removes the running indicator and re-enables the
      // action (both are keyed on optimizeState === "running") so the user can
      // retry. No layout dispatch happens here, so the Current_Layout is left
      // unchanged on either outcome (Req 1.4, 1.6, 1.7).
      setOptimizeError(optimizeErrorMessage(err));
      setOptimizeState("error");
    }
  }

  /**
   * Close the Auto-Optimize review and return the flow to idle (task 16.1,
   * 16.2). It touches only local review state: it clears the stored response,
   * resets optimizeState to "idle", clears any stale error, and closes the
   * ConstraintsForm so the Optimize stage shows only the recommendations and the
   * Auto-Optimize action again.
   *
   * No-silent-mutation guarantee (Req 9.8): this function dispatches NO reducer
   * action. The four setters below are all React local-state updates; none of
   * them calls dispatch, so no station contents, operator count, machine count,
   * spatial position (x or y), or any other user-entered data on the canvas is
   * changed. This is deliberately the only place that tears down the review, and
   * it is layout-neutral by construction. It is shared by two callers:
   *   - handleDiscardOptimize, which is the Discard / Dismiss handler, and
   *   - handleApplyOptimize's success path, which closes the review only AFTER
   *     applyOptimizeProposal has already dispatched the apply updates.
   * Keeping the teardown layout-neutral is what lets Discard leave the canvas
   * untouched (Req 10.2) while Apply remains the only path that mutates it.
   */
  function resetOptimizeReview() {
    setOptimizeResponse(null);
    setOptimizeState("idle");
    setOptimizeError(null);
    setShowConstraints(false);
  }

  /**
   * Discard handler for an Auto-Optimize proposal (task 16.2, Req 10.2, 9.8).
   *
   * This is the single handler wired to both the Discard control on a reviewable
   * proposal and the Dismiss control on a non-reviewable status (infeasible,
   * no_feasible_timeout, validation_failed). In every case the user is rejecting
   * the proposal, so the only thing to do is dismiss it and return to idle.
   *
   * Crucially it dispatches NO layout-mutating action. It delegates entirely to
   * resetOptimizeReview, which only updates local review state, so Discard
   * leaves the Current_Layout exactly as it was: no station contents, operator
   * count, machine count, spatial position, or user-entered data changes
   * (Req 10.2, and the before-apply case of Req 9.8). Apply is the only path
   * that ever dispatches a layout change (see handleApplyOptimize below); Discard
   * is a pure no-op on the canvas.
   */
  function handleDiscardOptimize() {
    resetOptimizeReview();
  }

  /**
   * Apply handler for an Auto-Optimize proposal (task 16.1, Req 9.2 to 9.7).
   *
   * It reads optimizeResponse.proposed_layout and applies it through the real
   * LayoutContext reducer via applyOptimizeProposal, which plans the full set of
   * per-station UPDATE_ELEMENT dispatches first and then dispatches them. Each
   * dispatch carries only operations, operators_required, and num_machines for a
   * station matched by id, so station contents and counts are updated to match
   * the proposal (Req 9.2, 9.3) while x and y are never written and all
   * unrelated data (names, connections, lines, sources, sinks, buffers, operator
   * pools, and other station fields) is preserved by omission (Req 9.4, 9.5).
   *
   * Apply is all-or-nothing: applyOptimizeProposal plans before it dispatches,
   * so if it cannot produce a usable plan it dispatches nothing and returns
   * false, in which case the canvas is left unchanged and an apply-did-not-
   * complete error is shown without closing the review (Req 9.7). On success the
   * review is closed (Req 9.6).
   */
  function handleApplyOptimize() {
    const proposed = optimizeResponse?.proposed_layout ?? null;
    const applied = applyOptimizeProposal(layout, proposed, dispatch);
    if (!applied) {
      setOptimizeError(
        "The proposal could not be applied, so your layout is unchanged. Please try again.",
      );
      return;
    }
    // Success: close the review, clear the now-stale pre-apply simulation
    // result, return to Setup so the user can see and adjust the applied layout
    // on the canvas, and show a confirmation toast so it is clear the change
    // landed (otherwise the panel just disappears, which is confusing).
    resetOptimizeReview();
    // Close the expanded overlay too. It only renders while a simulationResult
    // exists, so a stale expandedView left set to "recommendations" would pop
    // the Auto-Optimize window back open the next time the user runs the
    // simulation. Clearing it here prevents that.
    setExpandedView(null);
    setSimulationResult(null);
    setSelectedElementId(null);
    setStage("Setup");
    setShowApplyDone(true);
  }

  return (
    <div className="factory-simulator-page">
      {/* Header row */}
      <header className="factory-simulator-header">
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <Link to="/operations-assistant" className="factory-simulator-back-link" aria-label="Back to Manufacturing Operations" title="Back to Manufacturing Operations">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M20 12H4m7-7-7 7 7 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <h1 className="factory-simulator-title">Factory Floor Simulator</h1>
        </div>
      </header>

      {/* Top row: the Time Study import panel (left) and the 3-step tabs (right)
          on the same horizon above the canvas. The tabs block is fixed to the
          width of the right-side panel below it so their right edges align; the
          import slot fills the remaining width. The importer only appears during
          Setup (it rebuilds the layout); when hidden, the tabs stay right. */}
      <div className="factory-simulator-top-row">
        {/* Left slot: the importer during Setup, otherwise an empty spacer that
            holds the space so the tabs stay pinned to the right (matching the
            panel width below) across all stages. */}
        <div className="factory-simulator-import-slot">
          {stage === "Setup" && <TimeStudyImporter />}
        </div>

        {/* Restart - sits between the import panel and the 3-step tabs. Wipes
            everything and returns to Setup. */}
        <button
          type="button"
          className="factory-simulator-restart"
          onClick={() => setShowRestartConfirm(true)}
          title="Restart: clear all elements, connections, uploaded files, results and scenarios"
        >
          <span aria-hidden="true">↻</span>
          <span className="factory-simulator-restart-label">Restart</span>
        </button>

        <nav className="factory-simulator-stages">
          <ol className="factory-simulator-stage-list" role="tablist">
            {STAGES.map((s, index) => (
              <li key={s} role="presentation">
                <button
                  role="tab"
                  aria-selected={stage === s}
                  className={`factory-simulator-stage-tab ${stage === s ? "factory-simulator-stage-tab--active" : ""}`}
                  onClick={() => setStage(s)}
                  type="button"
                >
                  <span className="factory-simulator-stage-number">{index + 1}</span>
                  {s}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </div>

      {/* 3-panel layout - same structure for all stages */}
      <div className="factory-simulator-setup-layout">
        {/* Left panel: Line Settings + Floor Elements */}
        <aside className="factory-simulator-palette" style={{ opacity: stage !== "Setup" ? 0.5 : 1, pointerEvents: stage !== "Setup" ? "none" : "auto" }}>
          {/* Line Settings */}
          <div style={{ marginBottom: "12px", paddingBottom: "12px", borderBottom: "1px solid #2d5a8e" }}>
            <h3 style={{ color: "#d4a017", fontSize: "0.82rem", fontWeight: 600, letterSpacing: "0.5px", marginBottom: "8px" }}>Line Settings</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "0.78rem", color: "#a8b8e8", display: "flex", alignItems: "center" }}>
                Shifts per Day <HelpIcon text="Number of production shifts per day (1, 2, or 3)." />
              </label>
              <input type="number" value={shiftsPerDay} min={1} max={3} onChange={(e) => setShiftsPerDay(Number(e.target.value) || 1)} style={{ width: "100%", padding: "5px 8px", background: "#1a2a3a", border: "1px solid #2d5a8e", borderRadius: "4px", color: "#fff", fontSize: "0.8rem" }} />
              <label style={{ fontSize: "0.78rem", color: "#a8b8e8", display: "flex", alignItems: "center" }}>
                Hours per Shift <HelpIcon text="Scheduled length of each shift including breaks." />
              </label>
              <input type="number" value={hoursPerShift} min={1} max={24} step={0.5} onChange={(e) => setHoursPerShift(Number(e.target.value) || 8)} style={{ width: "100%", padding: "5px 8px", background: "#1a2a3a", border: "1px solid #2d5a8e", borderRadius: "4px", color: "#fff", fontSize: "0.8rem" }} />

              <label style={{ fontSize: "0.78rem", color: "#a8b8e8", display: "flex", alignItems: "center" }}>
                Breaks per Shift (min) <HelpIcon text="Total break time in minutes. Subtracted from shift hours to get productive time." />
              </label>
              <input type="number" value={breakMinutes} min={0} max={120} step={5} onChange={(e) => setBreakMinutes(Number(e.target.value) || 0)} style={{ width: "100%", padding: "5px 8px", background: "#1a2a3a", border: "1px solid #2d5a8e", borderRadius: "4px", color: "#fff", fontSize: "0.8rem" }} />

              <label style={{ fontSize: "0.78rem", color: "#a8b8e8", display: "flex", alignItems: "center" }}>
                Daily Demand (units) <HelpIcon text="Total units customers need per day. This drives your takt time." />
              </label>
              <input type="number" value={dailyDemand} min={1} onChange={(e) => setDailyDemand(Number(e.target.value) || 400)} style={{ width: "100%", padding: "5px 8px", background: "#1a2a3a", border: "1px solid #2d5a8e", borderRadius: "4px", color: "#fff", fontSize: "0.8rem" }} />
            </div>

            {/* Calculated metrics */}
            <div style={{ marginTop: "10px", padding: "8px", background: "rgba(45, 90, 142, 0.15)", borderRadius: "6px", border: "1px solid rgba(45, 90, 142, 0.3)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.73rem", marginBottom: "4px" }}>
                <span style={{ color: "#b0c8e0" }}>Takt Time</span>
                <span style={{ color: "#d4a017", fontWeight: 600 }}>{taktTime.toFixed(1)}s</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.73rem", marginBottom: "4px" }}>
                <span style={{ color: "#b0c8e0" }}>Throughput Target</span>
                <span style={{ color: "#d4a017", fontWeight: 600 }}>{targetThroughput.toFixed(1)} u/hr</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.73rem" }}>
                <span style={{ color: "#b0c8e0" }}>Net Productive Time</span>
                <span style={{ color: "#d4a017", fontWeight: 600 }}>{shiftDuration.toFixed(1)} hrs</span>
              </div>
            </div>
          </div>

          {/* Floor Elements */}
          <StationPalette />
        </aside>

        {/* Center: Canvas */}
        <section className="factory-simulator-canvas-area">
          <SimulatorCanvas
            isSimulating={isSimulating}
            simulationResults={stage !== "Setup" ? simulationResult : null}
            selectedElementId={selectedElementId}
            onSelectElement={setSelectedElementId}
            targetThroughput={targetThroughput}
          />
        </section>

        {/* Right panel: changes based on stage */}
        <aside className="factory-simulator-properties">
          {/* Run Simulation button - always visible above panel content */}
          <button
            type="button"
            onClick={handleRunSimulation}
            disabled={isSimulating || stage !== "Setup"}
            style={{ width: "100%", padding: "9px", marginBottom: "10px", background: stage === "Setup" ? "#2d5a8e" : "#1a2a3a", color: stage === "Setup" ? "#fff" : "#6c757d", border: stage === "Setup" ? "none" : "1px solid #2d5a8e", borderRadius: "6px", cursor: stage === "Setup" && !isSimulating ? "pointer" : "not-allowed", fontWeight: 600, fontSize: "0.82rem", opacity: stage !== "Setup" ? 0.5 : 1 }}
          >
            {isSimulating ? "Simulating..." : "▶ Run Simulation"}
          </button>
          {isWakingServer && (
            <p style={{ color: "#ff6b7a", fontSize: "0.75rem", margin: "0 0 10px 0", lineHeight: 1.3 }}>
              Starting the simulation server. The first run after a quiet period can take up to a minute, please wait.
            </p>
          )}
          {simulationError && (
            <p style={{ color: "#ff6b7a", fontSize: "0.75rem", margin: "0 0 10px 0", lineHeight: 1.3 }}>{simulationError}</p>
          )}
          {stage === "Setup" && (
            <PropertiesPanel selectedElementId={selectedElementId} autoArrivalRate={Math.round(targetThroughput)} />
          )}

          {stage === "Simulate" && simulationResult && (
            <>
              {/* Results header: an additive Expand_Control that opens the
                  near full-screen Results overlay. Shown only when a
                  simulationResult is present (Reqs 1.1, 1.7). It records the
                  trigger element for focus restore and sets the expanded view;
                  it issues no backend request (Req 1.6). The compact
                  ResultsPanel body below stays unchanged (Reqs 3.1, 3.3). */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", gap: "8px" }}>
                <h3 style={{ color: "#d4a017", margin: 0, fontSize: "0.9rem" }}>Results</h3>
                <button
                  type="button"
                  aria-label="Expand results to full screen"
                  onClick={(e) => {
                    triggerRef.current = e.currentTarget;
                    setExpandedView("results");
                  }}
                  style={{ padding: "5px 10px", background: "#1a2a3a", color: "#a8b8e8", border: "1px solid #2d5a8e", borderRadius: "6px", cursor: "pointer", fontSize: "0.78rem", fontWeight: 600 }}
                >
                  <span aria-hidden="true">⤢ </span>Expand
                </button>
              </div>
              <p style={{ color: "#8ba3c0", fontSize: "0.72rem", fontStyle: "italic", margin: "0 0 10px 0", lineHeight: 1.3 }}>
                Tip: Click the 'Expand' button for detailed root cause analysis.
              </p>
              <ResultsPanel
                result={simulationResult}
                targetThroughput={targetThroughput}
                onViewRecommendations={() => setStage("Optimize")}
              />
            </>
          )}

          {stage === "Optimize" && simulationResult && (
            <div>
              {/* Compact Optimize panel: the Recommendations header with an
                  Expand control, a tip pointing to the expanded view, and the
                  Recommendations list. The full Auto-Optimize workflow now
                  lives inside the expanded overlay (AutoOptimizeExpandedView),
                  mirroring how Root Cause Analysis lives in the expanded
                  Results view for the Simulate step. The Expand control is
                  always available in the Optimize step, since the overlay hosts
                  Auto-Optimize even when there are no recommendations. */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0 0 8px 0", gap: "8px" }}>
                <h3 style={{ color: "#d4a017", margin: 0, fontSize: "0.9rem" }}>Recommendations</h3>
                <button
                  type="button"
                  aria-label="Expand recommendations and Auto-Optimize to full screen"
                  onClick={(e) => {
                    triggerRef.current = e.currentTarget;
                    setExpandedView("recommendations");
                  }}
                  style={{ padding: "5px 10px", background: "#1a2a3a", color: "#a8b8e8", border: "1px solid #2d5a8e", borderRadius: "6px", cursor: "pointer", fontSize: "0.78rem", fontWeight: 600 }}
                >
                  <span aria-hidden="true">⤢ </span>Expand
                </button>
              </div>
              <p style={{ color: "#8ba3c0", fontSize: "0.72rem", fontStyle: "italic", margin: "0 0 10px 0", lineHeight: 1.3 }}>
                Tip: Click the 'Expand' button for Auto-Optimize feature.
              </p>
              <RecommendationsList result={simulationResult} />

              <button type="button" onClick={() => setStage("Setup")} style={{ marginTop: "14px", width: "100%", padding: "9px", background: "#2d5a8e", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: 600, fontSize: "0.82rem" }}>
                ← Modify Layout
              </button>
            </div>
          )}
        </aside>
      </div>

      {/* Expanded-view overlay. Rendered only when an expanded view is active
          and a simulationResult is present. The generic ExpandedViewModal owns
          the overlay shell, Close_Control, Escape handling, focus trap, and
          focus restore; it receives the Expand_Control element that opened it
          via triggerElement so focus returns there on close (Reqs 2.2, 2.3,
          9.5). Closing resets expandedView to null, which unmounts the overlay
          and restores the compact panel to its prior content and interaction
          state with no loss of user entered data (Reqs 2.4, 3.5).

          The current simulationResult and targetThroughput are passed straight
          through, so if a new run completes while the overlay is open React
          re-renders the wrapped view from the updated Result_Data without any
          special code path (Reqs 1.3, 1.4, 1.5, 4.6, 5.6). */}
      {expandedView !== null && simulationResult && (
        <ExpandedViewModal
          isOpen={expandedView !== null}
          title={expandedView === "results" ? "Root Cause Analysis and Results" : "Recommendations and Auto-Optimize"}
          onClose={() => setExpandedView(null)}
          triggerElement={triggerRef.current}
        >
          {expandedView === "results" ? (
            <ResultsExpandedView
              result={simulationResult}
              targetThroughput={targetThroughput}
            />
          ) : (
            <AutoOptimizeExpandedView
              result={simulationResult}
              layout={layout}
              optimizeState={optimizeState}
              optimizeResponse={optimizeResponse}
              optimizeError={optimizeError}
              showConstraints={showConstraints}
              onToggleConstraints={() => setShowConstraints((open) => !open)}
              onConstraintsChange={setOptimizeConstraints}
              onRun={() => handleOptimize(optimizeConstraints ?? defaultOptimizeConstraints(layout))}
              onApply={handleApplyOptimize}
              onDiscard={handleDiscardOptimize}
            />
          )}
        </ExpandedViewModal>
      )}

      {/* Restart confirmation dialog */}
      {showRestartConfirm && (
        <div className="factory-simulator-modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm restart">
          <div className="factory-simulator-modal">
            <div className="factory-simulator-modal-icon" aria-hidden="true">↻</div>
            <h3 className="factory-simulator-modal-title">Restart simulator?</h3>
            <p className="factory-simulator-modal-text">
              This clears everything: all elements, connections, uploaded files,
              simulation results, and saved scenarios, then returns you to Setup.
              This can’t be undone.
            </p>
            <div className="factory-simulator-modal-actions">
              <button
                type="button"
                className="factory-simulator-modal-btn factory-simulator-modal-btn--ghost"
                onClick={() => setShowRestartConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="factory-simulator-modal-btn factory-simulator-modal-btn--danger"
                onClick={performRestart}
              >
                Restart everything
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-Optimize apply success toast */}
      {showApplyDone && (
        <div className="factory-simulator-toast" role="status">
          <span className="factory-simulator-toast-icon" aria-hidden="true">✓</span>
          Changes applied to your layout. You are back in Setup: review the canvas and run the simulation again to see the updated results.
        </div>
      )}

      {/* Post-restart success toast */}
      {showRestartDone && (
        <div className="factory-simulator-toast" role="status">
          <span className="factory-simulator-toast-icon" aria-hidden="true">✓</span>
          Everything has been restarted. You’re back to a clean Setup.
        </div>
      )}
    </div>
  );
}

export default function FactorySimulatorPage() {
  return (
    <LayoutProvider>
      <FactorySimulatorContent />
    </LayoutProvider>
  );
}
