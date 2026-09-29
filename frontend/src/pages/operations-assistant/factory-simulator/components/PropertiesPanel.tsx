/**
 * PropertiesPanel: Edit properties of the selected element or connection.
 */

import { useState, useEffect } from "react";
import { useLayout } from "../context/LayoutContext";
import { HelpIcon } from "./HelpIcon";
import { OperationsEditor } from "./OperationsEditor";
import { effectiveCycleTime, totalOperatorsRequired } from "../utils/operations";
import type { CanvasElement, LineInfo, Station } from "../types";

export interface PropertiesPanelProps {
  selectedElementId: string | null;
  autoArrivalRate?: number;
}

// Shared styles (module-level so they aren't recreated each render)
const inputStyle = { width: "100%", padding: "5px 8px", background: "#1a2a3a", border: "1px solid #2d5a8e", borderRadius: "4px", color: "#fff", fontSize: "0.8rem" } as const;
const labelStyle = { display: "block" as const, fontSize: "0.75rem", color: "#b0c8e0", marginBottom: "2px" };
const fieldWrap = { marginBottom: "8px" } as const;

/**
 * Stable, module-level form field components. Defining these OUTSIDE the parent
 * component keeps their identity constant across re-renders, so the input keeps
 * focus while typing (previously they were redefined inside renderFields on every
 * keystroke, which unmounted/remounted the input and dropped focus after one char).
 */
interface SimpleFieldProps {
  label: string;
  fieldKey: string;
  type: "text" | "number";
  helpText: string;
  min?: number;
  value: string;
  onChange: (field: string, value: string) => void;
  onSave: () => void;
}

function SimpleField({ label, fieldKey, type, helpText, min, value, onChange, onSave }: SimpleFieldProps) {
  return (
    <div style={fieldWrap}>
      <label style={{ ...labelStyle, display: "flex", alignItems: "center" }}>{label} <HelpIcon text={helpText} /></label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(fieldKey, e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onSave(); }}
        min={min}
        style={inputStyle}
      />
    </div>
  );
}

interface PresetFieldProps {
  label: string;
  fieldKey: string;
  presets: { label: string; value: string }[];
  helpText: string;
  value: string;
  onChange: (field: string, value: string) => void;
  onSave: () => void;
}

function PresetField({ label, fieldKey, presets, helpText, value, onChange, onSave }: PresetFieldProps) {
  return (
    <div style={fieldWrap}>
      <label style={{ ...labelStyle, display: "flex", alignItems: "center" }}>{label} <HelpIcon text={helpText} /></label>
      <div style={{ display: "flex", gap: "4px" }}>
        <select
          value={presets.find((p) => p.value === value)?.value ?? "custom"}
          onChange={(e) => { if (e.target.value !== "custom") onChange(fieldKey, e.target.value); }}
          style={{ ...inputStyle, flex: "0 0 auto", width: "auto", minWidth: "90px" }}
        >
          {presets.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          <option value="custom">Custom</option>
        </select>
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSave(); }}
          style={{ ...inputStyle, flex: 1 }}
        />
      </div>
    </div>
  );
}

/**
 * StationLinesField - chip control that assigns a Workstation to one or more
 * lines. Toggling a chip adds or removes that line id; assigning 2+ lines marks
 * the station shared. Available lines come from layout.lines (may be empty).
 */
interface StationLinesFieldProps {
  lines: LineInfo[];
  lineIds: string[];
  onToggle: (lineId: string) => void;
}

function StationLinesField({ lines, lineIds, onToggle }: StationLinesFieldProps) {
  const isShared = lineIds.length >= 2;
  return (
    <div style={{ ...fieldWrap, padding: "8px", background: "rgba(45, 90, 142, 0.1)", borderRadius: "4px", border: "1px solid rgba(45, 90, 142, 0.3)" }}>
      <label style={{ ...labelStyle, display: "flex", alignItems: "center", marginBottom: "6px" }}>
        Lines <HelpIcon text="Assign this workstation to one or more lines. Assigning 2 or more lines marks it a shared station. Leave all unselected to auto-resolve by connectivity." />
        {isShared && (
          <span style={{ marginLeft: "6px", padding: "1px 6px", borderRadius: "8px", fontSize: "0.62rem", fontWeight: 600, background: "#d4a017", color: "#1a2a3a" }}>Shared</span>
        )}
      </label>
      {lines.length === 0 ? (
        <p style={{ margin: 0, fontSize: "0.68rem", color: "#8ba3c0", lineHeight: 1.35 }}>
          No lines defined yet. Lines auto-resolve by connectivity, or define them from an import with a Line column.
        </p>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
          {lines.map((l) => {
            const on = lineIds.includes(l.id);
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => onToggle(l.id)}
                style={{
                  padding: "3px 9px",
                  borderRadius: "12px",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  background: on ? "#2d5a8e" : "#1a2a3a",
                  color: on ? "#fff" : "#b0c8e0",
                  border: on ? "1px solid #4dabf7" : "1px solid #2d5a8e",
                }}
              >
                {l.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * ElementLineField - single-line select for a Source/Buffer/Sink. A non-station
 * element belongs to at most one line; the Auto option maps to null so the line
 * is resolved by connectivity.
 */
interface ElementLineFieldProps {
  lines: LineInfo[];
  lineId: string | null;
  onChange: (lineId: string | null) => void;
}

function ElementLineField({ lines, lineId, onChange }: ElementLineFieldProps) {
  return (
    <div style={fieldWrap}>
      <label style={{ ...labelStyle, display: "flex", alignItems: "center" }}>
        Line <HelpIcon text="Assign this element to a single line, or leave on Auto to resolve it by connectivity." />
      </label>
      {lines.length === 0 ? (
        <p style={{ margin: 0, fontSize: "0.68rem", color: "#8ba3c0", lineHeight: 1.35 }}>
          No lines defined yet. This element auto-resolves by connectivity.
        </p>
      ) : (
        <select
          value={lineId ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          style={inputStyle}
        >
          <option value="">Auto (by connectivity)</option>
          {lines.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}

/**
 * LinesEditor - rename lines and set each line's target throughput. Names are
 * committed on blur or Enter, targets on change. A blank target maps to null so
 * the line falls back to the global target.
 */
interface LinesEditorProps {
  lines: LineInfo[];
  onRename: (lineId: string, name: string) => void;
  onSetTarget: (lineId: string, target: number | null) => void;
}

function LinesEditor({ lines, onRename, onSetTarget }: LinesEditorProps) {
  if (lines.length === 0) return null;
  return (
    <details style={{ marginTop: "8px", borderTop: "1px solid #2d5a8e", paddingTop: "8px" }}>
      <summary style={{ fontSize: "0.75rem", color: "#d4a017", cursor: "pointer", marginBottom: "6px" }}>Line Settings</summary>
      {lines.map((l) => (
        <div key={l.id} style={{ ...fieldWrap, padding: "8px", background: "rgba(45, 90, 142, 0.08)", borderRadius: "4px" }}>
          <label style={{ ...labelStyle }}>Line Name</label>
          <input
            type="text"
            defaultValue={l.name}
            onBlur={(e) => { if (e.target.value !== l.name) onRename(l.id, e.target.value); }}
            onKeyDown={(e) => { if (e.key === "Enter") onRename(l.id, (e.target as HTMLInputElement).value); }}
            style={{ ...inputStyle, marginBottom: "6px" }}
          />
          <label style={{ ...labelStyle, display: "flex", alignItems: "center" }}>
            Target Throughput (units/hr) <HelpIcon text="This line's own demand target. Leave blank to fall back to the global target throughput." />
          </label>
          <input
            type="number"
            min={1}
            defaultValue={l.target_throughput != null ? String(l.target_throughput) : ""}
            onChange={(e) => { const v = e.target.value.trim(); onSetTarget(l.id, v === "" ? null : (Number(v) || null)); }}
            style={inputStyle}
          />
        </div>
      ))}
    </details>
  );
}

export function PropertiesPanel({ selectedElementId, autoArrivalRate }: PropertiesPanelProps) {
  const { layout, dispatch } = useLayout();

  // Find the selected element across all types
  const allElements: CanvasElement[] = [
    ...layout.sources,
    ...layout.stations,
    ...layout.buffers,
    ...layout.sinks,
    ...layout.operator_pools,
  ];

  const element = selectedElementId
    ? allElements.find((e) => e.id === selectedElementId)
    : undefined;

  // Check if it's a connection
  const connection = selectedElementId
    ? layout.connections.find((c) => c.id === selectedElementId)
    : undefined;

  // Local form state
  const [formValues, setFormValues] = useState<Record<string, string>>({});

  // "Saved" confirmation flag, shows briefly after a successful save
  const [showSaved, setShowSaved] = useState(false);

  // Sync form when selection changes
  useEffect(() => {
    if (element) {
      const values: Record<string, string> = {};
      for (const [key, val] of Object.entries(element)) {
        if (key !== "id" && key !== "element_type" && key !== "x" && key !== "y") {
          // Source arrival_rate of 0 means "auto-match Target Throughput":
          // show it as blank so the override field isn't pre-filled with a number.
          if (key === "arrival_rate" && element.element_type === "source" && Number(val) <= 0) {
            values[key] = "";
          } else if (key === "has_machine") {
            // The select works in "yes"/"no"; the model stores a boolean.
            values[key] = val === false ? "no" : "yes";
          } else {
            values[key] = String(val);
          }
        }
      }
      setFormValues(values);
    } else if (connection) {
      setFormValues({
        transport_time: String(connection.transport_time),
        distance: String(connection.distance),
        transport_mode: connection.transport_mode,
      });
    } else {
      setFormValues({});
    }
    // Reset the saved confirmation whenever the selected element changes
    setShowSaved(false);
  }, [selectedElementId, element?.id, connection?.id]);

  // Auto-dismiss the "Saved" confirmation after a short delay
  useEffect(() => {
    if (!showSaved) return;
    const timer = setTimeout(() => setShowSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [showSaved]);

  if (!selectedElementId || (!element && !connection)) {
    return (
      <div className="properties-panel">
        <div style={{ padding: "10px 12px", background: "rgba(45, 90, 142, 0.15)", borderRadius: "6px", border: "1px solid rgba(45, 90, 142, 0.3)" }}>
          <h3 style={{ color: "#d4a017", fontSize: "0.82rem", margin: "0 0 8px 0", fontWeight: 600 }}>Quick Guide</h3>
          <ol style={{ color: "#b0c8e0", fontSize: "0.75rem", margin: 0, padding: "0 0 0 16px", lineHeight: 1.7 }}>
            <li>Adjust Line Settings for target demand</li>
            <li>Upload factory data file(s) to auto-populate the layout for you and skip the manual steps below</li>
            <li>Add elements from Floor Elements</li>
            <li>Connect elements by pressing the blue dot on one element and then drag connection line to the grey dot of a target element</li>
            <li>Customize properties of elements by clicking them</li>
            <li>Click Run Simulation to see results</li>
          </ol>
        </div>
      </div>
    );
  }

  // ─── Connection Properties ─────────────────────────────────────
  if (connection && !element) {
    return (
      <div className="properties-panel">
        <h3 style={{ color: "#d4a017", fontSize: "0.82rem", margin: "0 0 4px 0" }}>Properties</h3>
        <div style={{ display: "inline-block", padding: "2px 8px", borderRadius: "4px", fontSize: "0.72rem", fontWeight: 600, background: "#4dabf7", color: "#fff", marginBottom: "12px" }}>
          Connection
        </div>

        <div style={{ marginBottom: "10px" }}>
          <label style={{ display: "flex", alignItems: "center", fontSize: "0.78rem", color: "#b0c8e0", marginBottom: "3px" }}>
            Transport Time (sec) <HelpIcon text="Time to move material between these two elements. Set to 0 if they are adjacent with no delay." />
          </label>
          <input type="number" value={formValues.transport_time ?? "0"} min={0} onChange={(e) => setFormValues({ ...formValues, transport_time: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { dispatch({ type: "UPDATE_CONNECTION", id: connection.id, updates: { transport_time: Number(formValues.transport_time) || 0 } }); setShowSaved(true); } }} style={{ width: "100%", padding: "6px 8px", background: "#1a2a3a", border: "1px solid #2d5a8e", borderRadius: "4px", color: "#fff", fontSize: "0.82rem" }} />
        </div>

        <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
          <button type="button" onClick={() => { dispatch({ type: "UPDATE_CONNECTION", id: connection.id, updates: { transport_time: Number(formValues.transport_time) || 0 } }); setShowSaved(true); }} style={{ flex: 1, padding: "8px", background: "#2d5a8e", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: 600, fontSize: "0.82rem" }}>Save</button>
          <button type="button" onClick={() => dispatch({ type: "DELETE_CONNECTION", id: connection.id })} style={{ padding: "8px 12px", background: "rgba(220, 53, 69, 0.2)", color: "#ff6b7a", border: "1px solid rgba(220, 53, 69, 0.4)", borderRadius: "4px", cursor: "pointer", fontSize: "0.82rem" }}>Delete</button>
        </div>

        {showSaved && (
          <p style={{ margin: "8px 0 0 0", fontSize: "0.75rem", color: "#28a745", display: "flex", alignItems: "center", gap: "4px" }}>
            ✓ Changes saved
          </p>
        )}
      </div>
    );
  }

  function handleChange(field: string, value: string) {
    setFormValues((prev) => ({ ...prev, [field]: value }));
  }

  function handleSave() {
    if (!element) return;
    const updates: Record<string, any> = {};
    for (const [key, val] of Object.entries(formValues)) {
      if (key === "name") {
        updates[key] = val;
      } else if (key === "split_mode") {
        updates[key] = val === "all" ? "all" : "either";
      } else if (key === "has_machine") {
        updates[key] = val !== "no";
      } else if (key === "arrival_rate") {
        // Blank override = 0 = auto-match Target Throughput at run time.
        updates[key] = val.trim() === "" ? 0 : (Number(val) || 0);
      } else if (["batch_size", "variability", "cycle_time", "num_machines",
                  "operators_required", "reliability", "scrap_rate", "setup_time",
                  "capacity", "count", "walking_speed"].includes(key)) {
        const num = Number(val);
        if (!isNaN(num)) updates[key] = num;
      }
    }
    dispatch({ type: "UPDATE_ELEMENT", id: element.id, updates });
    setShowSaved(true);
  }

  function handleDelete() {
    if (!element) return;
    dispatch({ type: "DELETE_ELEMENT", id: element.id });
  }

  // Render fields based on element type: Simple + Advanced structure
  function renderFields() {
    if (!element) return null;

    const fv = (key: string) => formValues[key] ?? "";

    // Available lines for assignment controls. layout.lines may be undefined.
    const lines = layout.lines ?? [];

    // Toggle a line id on/off for a station, then dispatch the full array.
    // 2+ lines mark the station shared (handled by the reducer/backend).
    const toggleStationLine = (lineId: string) => {
      const current = (element as Station).line_ids ?? [];
      const next = current.includes(lineId)
        ? current.filter((id) => id !== lineId)
        : [...current, lineId];
      dispatch({ type: "ASSIGN_ELEMENT_LINES", id: element.id, line_ids: next });
    };

    // Count outgoing connections for the selected element. The split-mode
    // control only makes sense when an element feeds 2+ downstream paths.
    const outgoingCount = element
      ? layout.connections.filter((c) => c.source_id === element.id).length
      : 0;
    const showSplit = outgoingCount >= 2 && (element.element_type === "source" || element.element_type === "station");

    return (
      <>
        <SimpleField label="Name" fieldKey="name" type="text" helpText="Display name for this element on the canvas" value={fv("name")} onChange={handleChange} onSave={handleSave} />

        {showSplit && (
          <div style={{ ...fieldWrap, padding: "8px", background: "rgba(212, 160, 23, 0.08)", borderRadius: "4px", border: "1px solid rgba(212, 160, 23, 0.25)" }}>
            <label style={{ ...labelStyle, display: "flex", alignItems: "center", marginBottom: "4px" }}>
              This element splits to {outgoingCount} paths
              <HelpIcon text="Choose how a unit flows when this element connects to more than one downstream element. 'Either path' sends each unit to just one path (the least busy), like two machines doing the same job. 'All paths' sends each unit through every path (parallel operations that all must happen); a downstream merge waits for all paths to finish." />
            </label>
            <select
              value={(formValues.split_mode as string) || "either"}
              onChange={(e) => { handleChange("split_mode", e.target.value); }}
              style={inputStyle}
            >
              <option value="either">Either path (route to one, whichever is free)</option>
              <option value="all">All paths (unit must go through every path)</option>
            </select>
          </div>
        )}

        {element.element_type === "source" && (
          <>
            <ElementLineField
              lines={lines}
              lineId={(element as any).line_id ?? null}
              onChange={(lineId) => dispatch({ type: "SET_ELEMENT_LINE", id: element.id, line_id: lineId })}
            />
            <div style={{ ...fieldWrap, padding: "8px", background: "rgba(45, 90, 142, 0.1)", borderRadius: "4px" }}>
              <span style={{ fontSize: "0.7rem", color: "#b0c8e0" }}>
                Material arrives at your Target Throughput rate
                {autoArrivalRate ? ` (${autoArrivalRate} units/hr)` : ""} by default. Use Advanced to simulate a limited supply.
              </span>
            </div>
            <details style={{ marginTop: "6px" }}>
              <summary style={{ fontSize: "0.75rem", color: "#d4a017", cursor: "pointer", marginBottom: "6px" }}>Advanced</summary>
              <SimpleField label="Arrival Rate Override (units/hr)" fieldKey="arrival_rate" type="number" helpText={`Leave blank to auto-match Target Throughput (${autoArrivalRate ?? "auto"} units/hr). Set a value only to test limited supply.`} min={1} value={fv("arrival_rate")} onChange={handleChange} onSave={handleSave} />
              <SimpleField label="Batch Size" fieldKey="batch_size" type="number" helpText="Number of units that arrive together each time (1 = single piece flow)" min={1} value={fv("batch_size")} onChange={handleChange} onSave={handleSave} />
            </details>
          </>
        )}

        {element.element_type === "station" && (
          <>
            <StationLinesField
              lines={lines}
              lineIds={(element as Station).line_ids ?? []}
              onToggle={toggleStationLine}
            />

            {/* Shared stations serve 2+ lines, so how they order work across
                those lines matters. The schedule select is revealed only for a
                shared station (line_ids.length >= 2) and is omitted entirely
                otherwise. Read the current value, defaulting to "fcfs". */}
            {(((element as Station).line_ids ?? []).length >= 2) && (
              <div style={{ ...fieldWrap, padding: "8px", background: "rgba(212, 160, 23, 0.08)", borderRadius: "4px", border: "1px solid rgba(212, 160, 23, 0.25)" }}>
                <label style={{ ...labelStyle, display: "flex", alignItems: "center" }}>
                  Shared Schedule <HelpIcon text="How this shared station orders work across the lines it serves. Priority order per line is set in Line Settings below: the line with the lower priority number is served first." />
                </label>
                <select
                  value={(element as Station).shared_schedule ?? "fcfs"}
                  onChange={(e) => dispatch({ type: "SET_SHARED_SCHEDULE", station_id: element.id, schedule: e.target.value as "fcfs" | "round_robin" | "priority" })}
                  style={inputStyle}
                >
                  <option value="fcfs">First come first served (FCFS)</option>
                  <option value="round_robin">Round robin (cycle lines fairly)</option>
                  <option value="priority">Priority by line</option>
                </select>
                <p style={{ margin: "5px 0 0 0", fontSize: "0.66rem", color: "#8ba3c0", lineHeight: 1.35 }}>
                  Line priority order is set per line in Line Settings below. For Priority by line, the line with the lower priority number is served first.
                </p>
              </div>
            )}

            {/* Cycle Time and Operators are the "simple mode" for a station with
                NO operations. Once operations are defined, they DRIVE the
                station's cycle time and operator count, so we hide the flat
                fields and show a read-only summary instead, otherwise it looks
                like you must set operators in two places. Parallel Capacity and
                the machine toggle always apply. */}
            {(element as Station).operations && (element as Station).operations.length > 0 ? (
              <div style={{ ...fieldWrap, padding: "8px 10px", background: "rgba(45, 90, 142, 0.12)", borderRadius: "4px", border: "1px solid rgba(45, 90, 142, 0.3)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", marginBottom: "3px" }}>
                  <span style={{ color: "#b0c8e0", display: "flex", alignItems: "center" }}>Cycle Time <HelpIcon text="Set by the operations below (sum of their cycle times). Edit the operations to change it." /></span>
                  <span style={{ color: "#fff", fontWeight: 600 }}>{effectiveCycleTime(element as Station).toFixed(0)}s</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem" }}>
                  <span style={{ color: "#b0c8e0", display: "flex", alignItems: "center" }}>Operators <HelpIcon text="Set by the operations below (sum of the operators each operation needs). Edit an operation's operators to change it." /></span>
                  <span style={{ color: "#fff", fontWeight: 600 }}>{totalOperatorsRequired(element as Station)}</span>
                </div>
                <p style={{ fontSize: "0.66rem", color: "#8ba3c0", margin: "5px 0 0 0", lineHeight: 1.35 }}>
                  Driven by the operations below. Assign operators per operation there.
                </p>
              </div>
            ) : (
              <>
                <SimpleField label="Cycle Time (seconds)" fieldKey="cycle_time" type="number" helpText="How long it takes to process one unit at this station. Or break the work into named operations below and this is set automatically." min={1} value={fv("cycle_time")} onChange={handleChange} onSave={handleSave} />
                <SimpleField label="Operators" fieldKey="operators_required" type="number" helpText="Number of workers needed to run this station (0 = fully automated by machine). Or assign operators per operation below." min={0} value={fv("operators_required")} onChange={handleChange} onSave={handleSave} />
              </>
            )}
            <SimpleField label="Parallel Capacity" fieldKey="num_machines" type="number" helpText="How many units can be worked on at the same time (1 = one at a time)" min={1} value={fv("num_machines")} onChange={handleChange} onSave={handleSave} />

            {/* Machine settings shown as normal fields (not hidden in Advanced)
                so it's clear the simulation supports machines. Persists
                has_machine: a station does work only if it has a machine OR at
                least one operator. */}
            <div style={fieldWrap}>
              <label style={{ ...labelStyle, display: "flex", alignItems: "center" }}>Has Machines <HelpIcon text="Select Yes if a machine does the work here. If No, the station relies on operators. A station with no machine AND no operators can't do any work, so the simulation will ask you to fix it." /></label>
              <select
                value={formValues.has_machine === "no" ? "no" : "yes"}
                onChange={(e) => {
                  if (e.target.value === "no") {
                    handleChange("has_machine", "no");
                    handleChange("reliability", "100");
                  } else {
                    handleChange("has_machine", "yes");
                  }
                }}
                style={inputStyle}
              >
                <option value="yes">Yes</option>
                <option value="no">No (operators do the work)</option>
              </select>
            </div>

            {formValues.has_machine !== "no" && (
              <PresetField
                label="Machine Reliability"
                fieldKey="reliability"
                presets={[
                  { label: "Never breaks", value: "100" },
                  { label: "Rarely", value: "95" },
                  { label: "Sometimes", value: "85" },
                  { label: "Often", value: "70" },
                ]}
                helpText="Percentage of time machines are running vs broken down (100% = never breaks)"
                value={fv("reliability")}
                onChange={handleChange}
                onSave={handleSave}
              />
            )}

            {/* Advanced fields */}
            <details style={{ marginTop: "8px", borderTop: "1px solid #2d5a8e", paddingTop: "8px" }}>
              <summary style={{ fontSize: "0.75rem", color: "#d4a017", cursor: "pointer", marginBottom: "6px" }}>Advanced</summary>

              <PresetField
                label="Scrap Rate (%)"
                fieldKey="scrap_rate"
                presets={[
                  { label: "None", value: "0" },
                  { label: "Low", value: "2" },
                  { label: "Moderate", value: "5" },
                  { label: "High", value: "10" },
                ]}
                helpText="Percentage of units that fail quality checks and get discarded"
                value={fv("scrap_rate")}
                onChange={handleChange}
                onSave={handleSave}
              />

              <SimpleField label="Setup Time (sec)" fieldKey="setup_time" type="number" helpText="Time needed to switch between different products or batches" min={0} value={fv("setup_time")} onChange={handleChange} onSave={handleSave} />

              <PresetField
                label="Variability"
                fieldKey="variability"
                presets={[
                  { label: "Consistent", value: "0" },
                  { label: "Moderate", value: "0.3" },
                  { label: "Variable", value: "0.7" },
                ]}
                helpText="How much the cycle time varies from unit to unit (0 = always the same)"
                value={fv("variability")}
                onChange={handleChange}
                onSave={handleSave}
              />
            </details>

            {/*
              Operations editor is ALWAYS rendered for a selected Workstation,
              regardless of validation state (zero operations, blank/invalid
              cycle times, etc.). Field-level errors are shown inline inside the
              editor without unmounting it. The flat cycle_time / operators
              fields above remain as the fallback UI.
            */}
            <OperationsEditor stationId={element.id} />

            <LinesEditor
              lines={lines}
              onRename={(lineId, name) => dispatch({ type: "RENAME_LINE", line_id: lineId, name })}
              onSetTarget={(lineId, target) => dispatch({ type: "SET_LINE_TARGET", line_id: lineId, target_throughput: target })}
            />
          </>
        )}

        {element.element_type === "buffer" && (
          <>
            <ElementLineField
              lines={lines}
              lineId={(element as any).line_id ?? null}
              onChange={(lineId) => dispatch({ type: "SET_ELEMENT_LINE", id: element.id, line_id: lineId })}
            />
            <SimpleField label="Capacity (units)" fieldKey="capacity" type="number" helpText="Maximum units that can wait here. When full, upstream stations get blocked." min={1} value={fv("capacity")} onChange={handleChange} onSave={handleSave} />
          </>
        )}

        {element.element_type === "sink" && (
          <ElementLineField
            lines={lines}
            lineId={(element as any).line_id ?? null}
            onChange={(lineId) => dispatch({ type: "SET_ELEMENT_LINE", id: element.id, line_id: lineId })}
          />
        )}
      </>
    );
  }

  const typeColors: Record<string, string> = {
    source: "#28a745",
    station: "#4dabf7",
    buffer: "#ffc107",
    sink: "#dc3545",
    operator_pool: "#9b59b6",
  };

  const typeLabels: Record<string, string> = {
    source: "Material Input",
    station: "Workstation",
    buffer: "Buffer Zone",
    sink: "Finished Goods",
    operator_pool: "Operators",
  };

  // By this point the early returns above have handled the no-selection and
  // connection-only cases, so a defined element is guaranteed. This guard makes
  // that explicit for the type checker.
  if (!element) return null;

  return (
    <div className="properties-panel">
      <h3 style={{ color: "#d4a017", fontSize: "0.82rem", margin: "0 0 4px 0" }}>Properties</h3>
      <div style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "0.72rem",
        fontWeight: 600,
        background: typeColors[element.element_type] || "#6c757d",
        color: "#fff",
        marginBottom: "12px",
      }}>
        {typeLabels[element.element_type] || element.element_type}
      </div>

      {renderFields()}

      <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
        <button
          type="button"
          onClick={handleSave}
          style={{
            flex: 1,
            padding: "8px",
            background: "#2d5a8e",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontWeight: 600,
            fontSize: "0.82rem",
          }}
        >
          Save
        </button>
        <button
          type="button"
          onClick={handleDelete}
          style={{
            padding: "8px 12px",
            background: "rgba(220, 53, 69, 0.2)",
            color: "#ff6b7a",
            border: "1px solid rgba(220, 53, 69, 0.4)",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "0.82rem",
          }}
        >
          Delete
        </button>
      </div>

      {showSaved && (
        <p style={{ margin: "8px 0 0 0", fontSize: "0.75rem", color: "#28a745", display: "flex", alignItems: "center", gap: "4px" }}>
          ✓ Changes saved
        </p>
      )}
    </div>
  );
}
