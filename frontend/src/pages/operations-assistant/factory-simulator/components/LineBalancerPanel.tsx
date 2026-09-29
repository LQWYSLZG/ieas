/**
 * LineBalancerPanel: Line balancing UI for the Factory Floor Simulator.
 *
 * Lets the user enter a Takt_Time (seconds), request a balance proposal from the
 * backend (`POST /operations-assistant/simulator/balance`), preview the proposed
 * assignment of Operations to Workstations (each with its Effective_Cycle_Time and
 * percentage of Takt, flagging over-Takt Workstations), and apply the proposal by
 * dispatching `APPLY_BALANCE` with the proposal's assignment.
 *
 * The APPLY_BALANCE reducer behavior itself is implemented separately (task 19.4);
 * this panel only dispatches the action.
 *
 * Requirements: 16.3, 16.4, 16.6.
 */

import { useState } from "react";
import { useLayout } from "../context/LayoutContext";
import { balanceLine } from "../utils/simulatorApi";
import { isApiError } from "../../../../lib/apiClient";
import type { LineBalanceProposal } from "../types";

const OVER_TAKT_COLOR = "#dc3545";
const WITHIN_TAKT_COLOR = "#28a745";

export function LineBalancerPanel() {
  const { layout, dispatch } = useLayout();
  const [taktTime, setTaktTime] = useState<number>(60);
  const [proposal, setProposal] = useState<LineBalanceProposal | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const taktValid = Number.isFinite(taktTime) && taktTime > 0;

  async function handleBalance() {
    if (!taktValid) {
      setError("Takt time must be a positive number of seconds.");
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const result = await balanceLine(layout, taktTime);
      setProposal(result);
    } catch (err: unknown) {
      const message = isApiError(err)
        ? err.message
        : "Failed to balance the line. Please try again.";
      setError(message);
      setProposal(null);
    } finally {
      setIsLoading(false);
    }
  }

  function handleApply() {
    if (!proposal) return;
    dispatch({ type: "APPLY_BALANCE", assignment: proposal.assignment });
  }

  return (
    <div className="line-balancer-panel">
      <div style={{ display: "flex", alignItems: "flex-end", gap: "8px", marginBottom: "12px" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1 }}>
          <span style={{ fontSize: "0.78rem", color: "#a8b8e8" }}>Takt Time (seconds)</span>
          <input
            type="number"
            min={0}
            step="any"
            value={Number.isFinite(taktTime) ? taktTime : ""}
            onChange={(e) => setTaktTime(parseFloat(e.target.value))}
            style={{
              padding: "6px 8px",
              borderRadius: "4px",
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(255,255,255,0.05)",
              color: "#fff",
              fontSize: "0.85rem",
            }}
          />
        </label>
        <button
          type="button"
          onClick={handleBalance}
          disabled={!taktValid || isLoading}
          style={{
            padding: "7px 14px",
            borderRadius: "4px",
            border: "none",
            background: !taktValid || isLoading ? "rgba(255,255,255,0.12)" : "#3d5afe",
            color: "#fff",
            fontSize: "0.82rem",
            fontWeight: 600,
            cursor: !taktValid || isLoading ? "not-allowed" : "pointer",
          }}
        >
          {isLoading ? "Balancing…" : "Balance Line"}
        </button>
      </div>

      {error && (
        <p style={{ color: "#ff6b7a", fontSize: "0.8rem", margin: "0 0 12px" }}>{error}</p>
      )}

      {proposal && (
        <div className="line-balancer-preview">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "8px",
            }}
          >
            <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "#fff" }}>
              Balance efficiency: {proposal.balance_efficiency.toFixed(1)}%
            </span>
            <span style={{ fontSize: "0.75rem", color: "#a8b8e8" }}>
              Takt {proposal.takt_time.toFixed(1)}s
            </span>
          </div>

          {proposal.best_effort && (
            <p
              style={{
                fontSize: "0.78rem",
                color: "#ffc107",
                background: "rgba(255,193,7,0.1)",
                borderRadius: "4px",
                padding: "8px",
                margin: "0 0 10px",
                lineHeight: 1.4,
              }}
            >
              {proposal.message}
            </p>
          )}

          {proposal.workstations.length === 0 ? (
            <p style={{ color: "#a8b8e8", fontSize: "0.8rem" }}>
              No operations available to balance.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {proposal.workstations.map((ws) => (
                <li
                  key={ws.workstation_name}
                  style={{
                    padding: "10px 12px",
                    marginBottom: "6px",
                    background: "rgba(255,255,255,0.03)",
                    borderRadius: "6px",
                    borderLeft: `3px solid ${ws.over_takt ? OVER_TAKT_COLOR : WITHIN_TAKT_COLOR}`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "#fff" }}>
                      {ws.workstation_name}
                    </span>
                    <span
                      style={{
                        fontSize: "0.72rem",
                        padding: "1px 6px",
                        borderRadius: "3px",
                        background: ws.over_takt
                          ? "rgba(220,53,69,0.2)"
                          : "rgba(40,167,69,0.15)",
                        color: ws.over_takt ? "#ff6b7a" : "#4ade80",
                      }}
                    >
                      {ws.pct_of_takt.toFixed(0)}% of Takt
                      {ws.over_takt ? " · over Takt" : ""}
                    </span>
                  </div>
                  <span style={{ fontSize: "0.76rem", color: "#a8b8e8" }}>
                    Effective cycle time: {ws.effective_cycle_time.toFixed(1)}s
                  </span>
                  {proposal.assignment[ws.workstation_name] && (
                    <p style={{ fontSize: "0.74rem", color: "#8090c0", margin: "4px 0 0", lineHeight: 1.4 }}>
                      {proposal.assignment[ws.workstation_name].join(", ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={handleApply}
            style={{
              marginTop: "8px",
              padding: "7px 14px",
              borderRadius: "4px",
              border: "none",
              background: "#28a745",
              color: "#fff",
              fontSize: "0.82rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
