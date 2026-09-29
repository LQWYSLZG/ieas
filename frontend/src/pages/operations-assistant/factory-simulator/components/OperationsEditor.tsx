/**
 * OperationsEditor: Manage the ordered list of Operations on a Workstation.
 *
 * Lets the user add / edit / reorder / remove Operations. Each row edits the
 * operation's name, cycle time (positive seconds) and operators required
 * (>= 0, where 0 = automated). It dispatches ADD_OPERATION / UPDATE_OPERATION /
 * REORDER_OPERATION / REMOVE_OPERATION and live-displays the Workstation's
 * Effective_Cycle_Time and total operators required via utils/operations.ts.
 *
 * The editor renders regardless of validation state: invalid fields show inline
 * errors but never unmount the row, so the user can always fix them in place.
 */

import { useLayout } from "../context/LayoutContext";
import { HelpIcon } from "./HelpIcon";
import { effectiveCycleTime, totalOperatorsRequired } from "../utils/operations";
import type { Operation, Station } from "../types";

export interface OperationsEditorProps {
  /** The id of the selected Workstation (Station). */
  stationId: string;
}

// ─── Shared styles (module-level so they aren't recreated each render) ──────
const opInputStyle = {
  padding: "4px 6px",
  background: "#1a2a3a",
  border: "1px solid #2d5a8e",
  borderRadius: "4px",
  color: "#fff",
  fontSize: "0.75rem",
  width: "100%",
  boxSizing: "border-box" as const,
} as const;

const invalidInputStyle = { ...opInputStyle, border: "1px solid #dc3545" } as const;

const iconBtnStyle = {
  padding: "2px 6px",
  background: "rgba(45, 90, 142, 0.35)",
  color: "#b0c8e0",
  border: "1px solid #2d5a8e",
  borderRadius: "4px",
  cursor: "pointer",
  fontSize: "0.72rem",
  lineHeight: 1.2,
} as const;

const disabledIconBtnStyle = { ...iconBtnStyle, opacity: 0.35, cursor: "not-allowed" } as const;

const labelSmall = { fontSize: "0.68rem", color: "#8ba3c0", marginBottom: "2px", display: "block" as const };
const errorText = { color: "#ff8a94", fontSize: "0.66rem", margin: "2px 0 0 0" };

function isBlank(v: string | number | undefined | null): boolean {
  return v === undefined || v === null || String(v).trim() === "";
}

export function OperationsEditor({ stationId }: OperationsEditorProps) {
  const { layout, dispatch } = useLayout();
  const station: Station | undefined = layout.stations.find((s) => s.id === stationId);

  if (!station) return null;

  const operations = station.operations ?? [];
  const ect = effectiveCycleTime(station);
  const totalOps = totalOperatorsRequired(station);
  const usingFallback = operations.length === 0;

  function handleAdd() {
    const operation: Operation = {
      name: `Operation ${operations.length + 1}`,
      cycle_time: 10,
      operators_required: 1,
    };
    dispatch({ type: "ADD_OPERATION", stationId, operation });
  }

  function handleUpdate(index: number, updates: Partial<Operation>) {
    dispatch({ type: "UPDATE_OPERATION", stationId, index, updates });
  }

  function handleRemove(index: number) {
    dispatch({ type: "REMOVE_OPERATION", stationId, index });
  }

  function handleReorder(from: number, to: number) {
    if (to < 0 || to >= operations.length) return;
    dispatch({ type: "REORDER_OPERATION", stationId, from, to });
  }

  return (
    <div style={{ marginTop: "10px", paddingTop: "2px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
        <label style={{ display: "flex", alignItems: "center", fontSize: "0.78rem", color: "#d4a017", fontWeight: 600 }}>
          Operations
          <HelpIcon text="Break this workstation into ordered operations. Each operation has its own cycle time and operator count. The workstation's effective cycle time is the sum of its operations." />
        </label>
        <button
          type="button"
          onClick={handleAdd}
          style={{
            padding: "4px 10px",
            background: "#2d5a8e",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "0.74rem",
            fontWeight: 600,
          }}
        >
          + Add Operation
        </button>
      </div>

      {operations.length === 0 && (
        <div style={{ padding: "8px", background: "rgba(45, 90, 142, 0.1)", borderRadius: "4px", marginBottom: "8px" }}>
          <span style={{ fontSize: "0.7rem", color: "#b0c8e0" }}>
            No operations yet. This workstation uses its flat Cycle Time until you add operations.
          </span>
        </div>
      )}

      {operations.map((op, index) => {
        const nameInvalid = isBlank(op.name) || String(op.name).length > 50;
        const ctInvalid = isBlank(op.cycle_time) || !(Number(op.cycle_time) > 0);
        const opsInvalid = isBlank(op.operators_required) || !Number.isFinite(Number(op.operators_required)) || Number(op.operators_required) < 0;

        return (
          <div
            key={index}
            style={{
              padding: "8px",
              marginBottom: "8px",
              background: "rgba(26, 42, 58, 0.6)",
              border: "1px solid #24405e",
              borderRadius: "6px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
              <span style={{ fontSize: "0.7rem", color: "#8ba3c0", fontWeight: 600 }}>#{index + 1}</span>
              <div style={{ display: "flex", gap: "4px" }}>
                <button
                  type="button"
                  title="Move up"
                  onClick={() => handleReorder(index, index - 1)}
                  disabled={index === 0}
                  style={index === 0 ? disabledIconBtnStyle : iconBtnStyle}
                >
                  ↑
                </button>
                <button
                  type="button"
                  title="Move down"
                  onClick={() => handleReorder(index, index + 1)}
                  disabled={index === operations.length - 1}
                  style={index === operations.length - 1 ? disabledIconBtnStyle : iconBtnStyle}
                >
                  ↓
                </button>
                <button
                  type="button"
                  title="Remove operation"
                  onClick={() => handleRemove(index)}
                  style={{ ...iconBtnStyle, background: "rgba(220, 53, 69, 0.2)", color: "#ff6b7a", border: "1px solid rgba(220, 53, 69, 0.4)" }}
                >
                  ✕
                </button>
              </div>
            </div>

            <div style={{ marginBottom: "6px" }}>
              <label style={labelSmall}>Name</label>
              <input
                type="text"
                value={op.name ?? ""}
                onChange={(e) => handleUpdate(index, { name: e.target.value })}
                style={nameInvalid ? invalidInputStyle : opInputStyle}
              />
              {nameInvalid && <p style={errorText}>Name is required (1-50 characters).</p>}
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
              <div style={{ flex: 1 }}>
                <label style={{ ...labelSmall, display: "flex", alignItems: "center" }}>
                  Cycle Time (s)
                  <HelpIcon text="How long this operation takes to process one unit, in seconds. Must be greater than 0." />
                </label>
                <input
                  type="number"
                  min={0.001}
                  step="any"
                  value={op.cycle_time ?? ""}
                  onChange={(e) => handleUpdate(index, { cycle_time: e.target.value === "" ? (NaN as unknown as number) : Number(e.target.value) })}
                  style={ctInvalid ? invalidInputStyle : opInputStyle}
                />
                {ctInvalid && <p style={errorText}>Enter a positive cycle time.</p>}
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ ...labelSmall, display: "flex", alignItems: "center" }}>
                  Operators
                  <HelpIcon text="Number of operators needed to run this operation. Use 0 for a fully automated operation." />
                </label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={op.operators_required ?? ""}
                  onChange={(e) => handleUpdate(index, { operators_required: e.target.value === "" ? (NaN as unknown as number) : Number(e.target.value) })}
                  style={opsInvalid ? invalidInputStyle : opInputStyle}
                />
                {opsInvalid && <p style={errorText}>Enter 0 or more (0 = automated).</p>}
              </div>
            </div>
          </div>
        );
      })}

      {/* Live rollup of Effective_Cycle_Time and total operators required */}
      <div
        style={{
          marginTop: "8px",
          padding: "8px 10px",
          background: "rgba(45, 90, 142, 0.15)",
          border: "1px solid rgba(45, 90, 142, 0.3)",
          borderRadius: "6px",
          display: "flex",
          flexDirection: "column",
          gap: "4px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ display: "flex", alignItems: "center", fontSize: "0.72rem", color: "#b0c8e0" }}>
            Effective Cycle Time
            <HelpIcon text="Sum of all operation cycle times. When there are no operations, the workstation's flat Cycle Time is used instead." />
          </span>
          <span style={{ fontSize: "0.78rem", color: "#fff", fontWeight: 600 }}>{Number.isFinite(ect) ? `${ect} s` : "-"}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ display: "flex", alignItems: "center", fontSize: "0.72rem", color: "#b0c8e0" }}>
            Total Operators Required
            <HelpIcon text="Sum of operators across all operations. When there are no operations, the workstation's flat operator count is used." />
          </span>
          <span style={{ fontSize: "0.78rem", color: "#fff", fontWeight: 600 }}>{Number.isFinite(totalOps) ? totalOps : "-"}</span>
        </div>
        {usingFallback && (
          <span style={{ fontSize: "0.66rem", color: "#8ba3c0", fontStyle: "italic" }}>
            Using flat workstation values (no operations defined).
          </span>
        )}
      </div>
    </div>
  );
}
