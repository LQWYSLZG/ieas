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
import type { SimulationResult, Recommendation } from "../types";
import "./FactorySimulatorPage.css";

type WorkflowStage = "Setup" | "Simulate" | "Optimize";

const STAGES: WorkflowStage[] = ["Setup", "Simulate", "Optimize"];

// Friendly, shop-owner-readable titles for recommendation problem keys.
const PROBLEM_LABELS: Record<string, string> = {
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

function problemLabel(problem: string): string {
  return PROBLEM_LABELS[problem] ?? problem.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// A single recommendation card. Extracted so the Optimize view can render both
// the flat single-line list and the per-line grouped list with identical
// markup, severity colors, and problem labels.
function RecommendationCard({ rec }: { rec: Recommendation }) {
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

function FactorySimulatorContent() {
  const [stage, setStage] = useState<WorkflowStage>("Setup");
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);

  // "Server waking up" hint: when a run has not resolved within a few seconds
  // it is likely a Render free-tier cold start, so we show a small non-blocking
  // note near the Run button. The timeout id is kept in a ref so it can be
  // cleared reliably in the finally block.
  const [isWakingServer, setIsWakingServer] = useState(false);
  const wakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restart flow: confirmation dialog + post-restart success toast.
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [showRestartDone, setShowRestartDone] = useState(false);

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

  return (
    <div className="factory-simulator-page">
      {/* Header row */}
      <header className="factory-simulator-header">
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <Link to="/operations-assistant" className="factory-simulator-back-link">← Back</Link>
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

              <label style={{ fontSize: "0.78rem", color: "#a8b8e8", display: "flex", alignItems: "center" }}>
                Shifts per Day <HelpIcon text="Number of production shifts per day (1, 2, or 3)." />
              </label>
              <input type="number" value={shiftsPerDay} min={1} max={3} onChange={(e) => setShiftsPerDay(Number(e.target.value) || 1)} style={{ width: "100%", padding: "5px 8px", background: "#1a2a3a", border: "1px solid #2d5a8e", borderRadius: "4px", color: "#fff", fontSize: "0.8rem" }} />
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
            <p style={{ color: "#b0c8e0", fontSize: "0.75rem", margin: "0 0 10px 0", lineHeight: 1.3 }}>
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
            <ResultsPanel
              result={simulationResult}
              targetThroughput={targetThroughput}
              onViewRecommendations={() => setStage("Optimize")}
            />
          )}

          {stage === "Optimize" && simulationResult && (
            <div>
              <h3 style={{ color: "#d4a017", margin: "0 0 12px 0", fontSize: "0.9rem" }}>Recommendations</h3>
              {(simulationResult.lines?.length ?? 0) >= 2 ? (
                // Multi-line: group recommendations under each line's subheading,
                // reading each PerLineResult.recommendations. Lines with no
                // recommendations show a short "running efficiently" note.
                simulationResult.lines!.map((line) => (
                  <details key={line.line_id} style={{ marginBottom: "12px" }}>
                    <summary style={{ color: "#d4a017", fontSize: "0.9rem", cursor: "pointer", marginTop: "14px", marginBottom: "6px", fontWeight: 600, borderBottom: "1px solid rgba(212, 160, 23, 0.3)", paddingBottom: "4px" }}>{line.line_name}</summary>
                    {line.recommendations.length === 0 ? (
                      <p style={{ color: "#a8b8e8", fontSize: "0.78rem", margin: 0 }}>No issues found. This line is running efficiently.</p>
                    ) : (
                      line.recommendations.map((rec, i) => <RecommendationCard key={i} rec={rec} />)
                    )}
                  </details>
                ))
              ) : simulationResult.recommendations.length === 0 ? (
                <p style={{ color: "#a8b8e8", fontSize: "0.82rem" }}>No issues found. This line is running efficiently.</p>
              ) : (
                simulationResult.recommendations.map((rec, i) => <RecommendationCard key={i} rec={rec} />)
              )}
              <button type="button" onClick={() => setStage("Setup")} style={{ marginTop: "14px", width: "100%", padding: "8px", background: "#1a2a3a", color: "#a8b8e8", border: "1px solid #2d5a8e", borderRadius: "6px", cursor: "pointer", fontSize: "0.8rem" }}>
                ← Modify Layout
              </button>
            </div>
          )}
        </aside>
      </div>

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
