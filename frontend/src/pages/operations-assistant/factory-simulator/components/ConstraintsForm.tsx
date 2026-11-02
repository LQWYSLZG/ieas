/**
 * ConstraintsForm: the user-editable constraints for an Auto-Optimize run.
 *
 * Lives in the Optimize stage alongside the recommendations. It takes the
 * current Layout, derives sensible defaults from it, holds the resulting
 * OptimizeConstraints in local state, and reports every change up to its parent
 * via onChange. The actual trigger / submit lives in FactorySimulatorPage (task
 * 13); this component only renders the fields and manages the constraints value.
 *
 * Defaults are derived so a zero-edit run reproduces the current-layout baseline
 * (Req 2.1, 2.4):
 *   - Precedence_Rules default to the current operation order (Req 2.2).
 *   - Station_Locks default to none, so every operation is movable (Req 2.3).
 *   - Operator_Cap defaults to the current total operators across all stations.
 *   - Machine_Cap (and the optional per-station limit) default to the current
 *     total machines across all stations.
 *   - Machine_Toggle (allow_add_machines) defaults to disabled (Req 2.4).
 *   - Objective_Weights operator_weight and machine_weight default to 1 and 1.
 *
 * Operation keys use the exact backend form "station_id index" (see
 * optimization/model_builder._op_key) so the precedence and lock values cross
 * the request boundary with no remapping.
 *
 * The numeric inputs (operator cap, machine cap, per-station limit, weights) are
 * wired so the pure validators added in task 12.2 (validateOperatorCap,
 * validateMachineCap, validateWeight) can be slotted in to reject out-of-range
 * or wrong-type input and retain the previous accepted value. Those validators
 * are NOT implemented here; this task only renders the fields and manages the
 * constraints value.
 *
 * This file follows the project rule that no em dashes or en dashes appear
 * anywhere. Only ASCII hyphens are used, in code, comments, and strings.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4.
 */

import { useMemo, useState } from "react";
import { totalOperatorsRequired } from "../utils/operations";
import { HelpIcon } from "./HelpIcon";
import type {
  Layout,
  OptimizeConstraints,
  PrecedenceRule,
  Station,
  StationLock,
} from "../types";

export interface ConstraintsFormProps {
  /** The current layout the defaults are derived from. */
  layout: Layout;
  /** Called with the current constraints whenever any field changes. */
  onChange?: (constraints: OptimizeConstraints) => void;
}

// ─── Pure validators (exported for property testing, task 12.3) ─────────────
//
// Each validator is a pure function with no React or component-state
// dependency. It takes a raw user-entered value, decides whether it is
// accepted, and returns a small discriminated-union result. On an accepted
// value the caller commits result.value; on a rejected value the caller keeps
// the previous accepted value and shows result.message near the field
// (Req 2.6, 2.8, 2.10).

/** Result of validating one numeric constraint field. */
export type ValidationResult =
  | { ok: true; value: number }
  | { ok: false; message: string };

/**
 * Parse a raw input into a finite number, treating blank, non-numeric, and
 * non-finite (NaN, Infinity) input as a failure. Number("") is 0 and
 * Number("  ") is 0 in JS, so a blank string is rejected explicitly first.
 */
function parseFiniteNumber(raw: string): number | null {
  if (raw.trim() === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Operator_Cap: an integer in [1, 999] inclusive (Req 2.5, 2.6). Rejects
 * non-integers, out-of-range values, and wrong-type input (blank, NaN,
 * non-numeric), retaining the previous accepted value at the call site.
 */
export function validateOperatorCap(raw: string): ValidationResult {
  const message = "Enter an integer from 1 to 999.";
  const value = parseFiniteNumber(raw);
  if (value === null || !Number.isInteger(value) || value < 1 || value > 999) {
    return { ok: false, message };
  }
  return { ok: true, value };
}

/**
 * Machine_Cap and the per-station machine limit: an integer in [0, 999]
 * inclusive (Req 2.7, 2.8). Rejects non-integers, out-of-range values, and
 * wrong-type input. The per-station limit is optional and handled as a blank
 * clearing the value before this validator runs.
 */
export function validateMachineCap(raw: string): ValidationResult {
  const message = "Enter an integer from 0 to 999.";
  const value = parseFiniteNumber(raw);
  if (value === null || !Number.isInteger(value) || value < 0 || value > 999) {
    return { ok: false, message };
  }
  return { ok: true, value };
}

/**
 * Objective weight: a numeric value in [0, 1000] inclusive (Req 2.9, 2.10).
 * Non-integers are allowed. Rejects out-of-range and wrong-type input (blank,
 * NaN, non-numeric).
 */
export function validateWeight(raw: string): ValidationResult {
  const message = "Enter a number from 0 to 1000.";
  const value = parseFiniteNumber(raw);
  if (value === null || value < 0 || value > 1000) {
    return { ok: false, message };
  }
  return { ok: true, value };
}

// ─── Shared styles (module-level so they aren't recreated each render) ──────
const inputStyle = {
  width: "100%",
  padding: "5px 8px",
  background: "#1a2a3a",
  border: "1px solid #2d5a8e",
  borderRadius: "4px",
  color: "#fff",
  fontSize: "0.9rem",
  boxSizing: "border-box" as const,
} as const;

const sectionTitleStyle = {
  fontSize: "0.95rem",
  color: "#d4a017",
  fontWeight: 600,
  margin: "0 0 8px 0",
} as const;

const helpTextStyle = {
  margin: "4px 0 0 0",
  fontSize: "0.78rem",
  color: "#8ba3c0",
  lineHeight: 1.35,
} as const;

const errorTextStyle = {
  margin: "4px 0 0 0",
  fontSize: "0.8rem",
  color: "#f08a8a",
  lineHeight: 1.35,
} as const;

// A bordered group that visually separates each cluster of related settings so
// the form reads as a few clear sections rather than one dense wall of fields.
const groupStyle = {
  marginBottom: "16px",
  padding: "12px 14px",
  background: "rgba(45, 90, 142, 0.10)",
  border: "1px solid rgba(45, 90, 142, 0.35)",
  borderRadius: "8px",
} as const;

// The small gold heading that titles each group.
const groupTitleStyle = {
  display: "flex" as const,
  alignItems: "center" as const,
  fontSize: "0.9rem",
  fontWeight: 700,
  color: "#d4a017",
  margin: "0 0 10px 0",
};

// A responsive two-up row for paired numeric fields (caps, weights). It wraps to
// one column on a narrow container via flexBasis, so nothing is squeezed.
const twoColStyle = {
  display: "flex" as const,
  flexWrap: "wrap" as const,
  gap: "12px",
} as const;

// A label that sits on its own row with its HelpIcon trailing the text, so the
// explanation lives next to the name instead of as a caption under the field.
const labelRowStyle = {
  display: "flex" as const,
  alignItems: "center" as const,
  fontSize: "0.85rem",
  color: "#b0c8e0",
  marginBottom: "4px",
};

// An inline checkbox row: checkbox, label text, and a trailing HelpIcon on one
// line. Used by the optional facility-limits toggle.
const checkRowStyleLocal = {
  display: "flex" as const,
  alignItems: "center" as const,
  gap: "8px",
  fontSize: "0.85rem",
  color: "#b0c8e0",
};


// A segmented-style button used for the yes/no machine choice and the focus
// choice. Selected buttons are filled gold; unselected are a muted outline, so
// the current choice reads at a glance without a separate label.
function toggleButtonStyle(selected: boolean) {
  return {
    flex: "1 1 auto" as const,
    padding: "8px 10px",
    borderRadius: "6px",
    border: selected ? "1px solid #d4a017" : "1px solid #2d5a8e",
    background: selected ? "#d4a017" : "transparent",
    color: selected ? "#1a2a3a" : "#b0c8e0",
    fontSize: "0.82rem",
    fontWeight: 600,
    cursor: "pointer" as const,
    textAlign: "center" as const,
  } as const;
}

// The focus choice reuses the same selected/unselected treatment as the machine
// toggle so the two segmented controls look consistent.
function focusButtonStyle(selected: boolean) {
  return toggleButtonStyle(selected);
}

// Header cell for the station-locks table.
const lockThStyle = {
  padding: "0 8px 6px 0",
  fontSize: "0.72rem",
  fontWeight: 700,
  textTransform: "uppercase" as const,
  letterSpacing: "0.4px",
} as const;

// Body cell for the station-locks table.
const lockTdStyle = {
  padding: "7px 8px 7px 0",
  fontSize: "0.84rem",
  color: "#dce7f5",
  verticalAlign: "middle" as const,
  overflow: "hidden" as const,
  textOverflow: "ellipsis" as const,
  whiteSpace: "nowrap" as const,
  maxWidth: "150px",
} as const;

// A small pill button for the Free-to-move / Lock-here choice. Selected is a
// filled accent; unselected is a muted outline, matching the segmented controls.
function lockPillStyle(selected: boolean) {
  return {
    padding: "5px 10px",
    borderRadius: "999px",
    border: selected ? "1px solid #d4a017" : "1px solid #2d5a8e",
    background: selected ? "#d4a017" : "transparent",
    color: selected ? "#1a2a3a" : "#b0c8e0",
    fontSize: "0.76rem",
    fontWeight: 600,
    cursor: "pointer" as const,
    whiteSpace: "nowrap" as const,
  } as const;
}

// ─── Operation-key helpers (mirror backend optimization/model_builder._op_key) ──

/** The stable operation key of the form "station_id index". */
function opKey(stationId: string, index: number): string {
  return `${stationId} ${index}`;
}

/** One operation entry: its stable key plus a human-readable label. */
interface OperationEntry {
  key: string;
  label: string;        // "Station Name - Operation Name" (used by precedence list)
  opName: string;       // the operation name on its own
  stationId: string;
  stationName: string;  // the current owning station name
}

/**
 * Enumerate every operation in the layout in flow order, producing the same
 * stable keys the backend builder produces. A station with a non-empty
 * operations list contributes one entry per position ("station_id index"); a
 * station with an empty operations list contributes a single synthetic entry
 * ("station_id 0") built from its flat fields, matching the backend fallback.
 */
function collectOperations(layout: Layout): OperationEntry[] {
  const entries: OperationEntry[] = [];
  for (const station of layout.stations) {
    const ops = station.operations ?? [];
    if (ops.length > 0) {
      ops.forEach((op, index) => {
        entries.push({
          key: opKey(station.id, index),
          label: `${station.name} - ${op.name}`,
          opName: op.name,
          stationId: station.id,
          stationName: station.name,
        });
      });
    } else {
      entries.push({
        key: opKey(station.id, 0),
        label: station.name,
        opName: station.name,
        stationId: station.id,
        stationName: station.name,
      });
    }
  }
  return entries;
}

/**
 * Default precedence rules: the current operation order (Req 2.2). Each
 * consecutive pair of operations in flow order becomes one before -> after
 * edge, so the current order is reproduced when nothing is edited.
 */
function defaultPrecedence(operations: OperationEntry[]): PrecedenceRule[] {
  const rules: PrecedenceRule[] = [];
  for (let i = 0; i < operations.length - 1; i++) {
    rules.push({ before: operations[i].key, after: operations[i + 1].key });
  }
  return rules;
}

/** Current total operators across all stations (Operator_Cap default). */
function currentOperatorTotal(layout: Layout): number {
  return layout.stations.reduce(
    (sum, s) => sum + totalOperatorsRequired(s as Station),
    0,
  );
}

/** Current total machines across all stations (Machine_Cap default). */
function currentMachineTotal(layout: Layout): number {
  return layout.stations.reduce((sum, s) => sum + (s.num_machines ?? 0), 0);
}

/** Build the baseline constraints from the current layout (Req 2.1 to 2.4). */
function defaultConstraints(
  layout: Layout,
  operations: OperationEntry[],
): OptimizeConstraints {
  return {
    precedence: defaultPrecedence(operations),   // current operation order (Req 2.2)
    // Every operation defaults to Lock here, pinned to its current station, so
    // a zero-edit run keeps the current assignment and only tunes machines and
    // operators. The user unlocks an operation to let the optimizer move it.
    locks: operations.map((op) => ({ operation: op.key, station_id: op.stationId })),
    operator_cap: currentOperatorTotal(layout),   // current operator total (Req 2.4)
    machine_cap: currentMachineTotal(layout),     // current machine total (Req 2.4)
    per_station_machine_limit: null,              // optional, off by default
    allow_add_machines: true,                     // data + ceiling govern machine safety
    operator_weight: 1,                           // default 1 (Req 2.4, 2.9)
    machine_weight: 1,                            // default 1 (Req 2.4, 2.9)
    utilization_ceiling: 0.85,                    // healthy load ceiling default
  };
}

export function ConstraintsForm({ layout, onChange }: ConstraintsFormProps) {
  // Enumerate operations once per layout identity so keys and labels are stable
  // across re-renders. The dependency is the layout object the parent holds.
  const operations = useMemo(() => collectOperations(layout), [layout]);

  // The constraints value, seeded from the current-layout baseline. Seeding
  // lazily (via the initializer) means the defaults are computed once when the
  // form first opens for this layout (Req 2.2 to 2.4).
  const [constraints, setConstraints] = useState<OptimizeConstraints>(() =>
    defaultConstraints(layout, operations),
  );

  // Raw text for the numeric fields, so a half-typed value does not have to be
  // a valid number mid-edit. Task 12.2 slots its validators into the commit
  // helpers below: on an accepted value, update the constraints; on a rejected
  // value, keep the previous accepted value and surface a range message.
  const [operatorCapText, setOperatorCapText] = useState<string>(
    String(constraints.operator_cap),
  );
  const [machineCapText, setMachineCapText] = useState<string>(
    String(constraints.machine_cap),
  );
  const [perStationLimitText, setPerStationLimitText] = useState<string>(
    constraints.per_station_machine_limit != null
      ? String(constraints.per_station_machine_limit)
      : "",
  );

  // Per-field validation messages. A field maps to a message string while its
  // last committed value was rejected, or to null while it is accepted. The
  // message is rendered near the field (Req 2.6, 2.8, 2.10).
  const [operatorCapError, setOperatorCapError] = useState<string | null>(null);
  const [machineCapError, setMachineCapError] = useState<string | null>(null);
  const [perStationLimitError, setPerStationLimitError] = useState<string | null>(null);

  // Single place that both updates local state and reports the change upward,
  // so the parent always holds the latest constraints value. The caps are only
  // real when the user opted into facility limits; otherwise they are sent as 0
  // (the backend "no artificial limit" sentinel) and the per-station limit as
  // null, so an un-set limit can never bind. The input fields keep their own
  // display values in state regardless, so toggling the section does not lose
  // what the user typed.
  function emit(next: OptimizeConstraints, advanced: boolean) {
    const effective: OptimizeConstraints = advanced
      ? next
      : { ...next, operator_cap: 0, machine_cap: 0, per_station_machine_limit: null };
    onChange?.(effective);
  }

  function commit(next: OptimizeConstraints) {
    setConstraints(next);
    emit(next, showAdvancedLimits);
  }

  // ─── Numeric commit helpers (wired to the pure validators) ────────────────
  // Each helper runs its pure validator on the raw text. On an accepted value
  // it commits the value and clears the field's error, and resets the raw text
  // to the canonical accepted value. On a rejected value it retains the
  // previous accepted value (no commit), restores the input text to that
  // previous value, and shows the validator's range message (Req 2.6, 2.8,
  // 2.10).

  function commitOperatorCap(raw: string) {
    const result = validateOperatorCap(raw);
    if (result.ok) {
      setOperatorCapError(null);
      setOperatorCapText(String(result.value));
      commit({ ...constraints, operator_cap: result.value });
    } else {
      setOperatorCapError(result.message);
      setOperatorCapText(String(constraints.operator_cap));
    }
  }

  function commitMachineCap(raw: string) {
    const result = validateMachineCap(raw);
    if (result.ok) {
      setMachineCapError(null);
      setMachineCapText(String(result.value));
      commit({ ...constraints, machine_cap: result.value });
    } else {
      setMachineCapError(result.message);
      setMachineCapText(String(constraints.machine_cap));
    }
  }

  function commitPerStationLimit(raw: string) {
    // The per-station limit is optional: a blank value clears it to null and is
    // always valid. A non-blank value is validated with validateMachineCap.
    if (raw.trim() === "") {
      setPerStationLimitError(null);
      setPerStationLimitText("");
      commit({ ...constraints, per_station_machine_limit: null });
      return;
    }
    const result = validateMachineCap(raw);
    if (result.ok) {
      setPerStationLimitError(null);
      setPerStationLimitText(String(result.value));
      commit({ ...constraints, per_station_machine_limit: result.value });
    } else {
      setPerStationLimitError(result.message);
      setPerStationLimitText(
        constraints.per_station_machine_limit != null
          ? String(constraints.per_station_machine_limit)
          : "",
      );
    }
  }

  // ─── Resource focus (maps a single choice onto the objective weights) ──
  // The optimizer minimizes c_op * operators + c_mc * machines. Rather than ask
  // the user for two raw weights, we expose one choice: balance both, prefer
  // fewer operators, or prefer fewer machines. The choice maps onto the weights
  // so the backend and the MILP are unchanged. A preferred resource gets the
  // heavier weight; the other stays at 1.
  const FOCUS_WEIGHT = 3;

  type ResourceFocus = "balanced" | "operators" | "machines";

  function currentFocus(): ResourceFocus {
    if (constraints.operator_weight > constraints.machine_weight) return "operators";
    if (constraints.machine_weight > constraints.operator_weight) return "machines";
    return "balanced";
  }

  function setFocus(focus: ResourceFocus) {
    let operator_weight = 1;
    let machine_weight = 1;
    if (focus === "operators") operator_weight = FOCUS_WEIGHT;
    if (focus === "machines") machine_weight = FOCUS_WEIGHT;
    commit({ ...constraints, operator_weight, machine_weight });
  }

  const FOCUS_OPTIONS: { value: ResourceFocus; label: string; hint: string }[] = [
    { value: "balanced", label: "Balance both", hint: "Cut operators and machines evenly." },
    { value: "operators", label: "Fewer operators", hint: "Prefer cutting operators first." },
    { value: "machines", label: "Fewer machines", hint: "Prefer cutting machines first." },
  ];

  // ─── Station locks (per-operation, default none) ──────────────────────────
  // A lock pins one operation key to one station id. Selecting "Unlocked" for
  // an operation removes its lock; selecting a station adds or replaces it.
  function lockedStationOf(operationKey: string): string {
    const lock = constraints.locks.find((l) => l.operation === operationKey);
    return lock ? lock.station_id : "";
  }

  function setLock(operationKey: string, stationId: string) {
    const without = constraints.locks.filter((l) => l.operation !== operationKey);
    const next: StationLock[] =
      stationId === ""
        ? without
        : [...without, { operation: operationKey, station_id: stationId }];
    commit({ ...constraints, locks: next });
  }

  // --- Precedence editing (add / remove A-before-B rules) -------------------
  // The list is seeded with the current build order. Removing a rule relaxes
  // precedence so the optimizer may resequence; adding a rule imposes a new
  // ordering. Note: the backend treats an empty list as "fall back to the
  // current order", so clearing every rule reverts to the default rather than
  // dropping precedence entirely; the note under the list says so.
  const [draftBefore, setDraftBefore] = useState<string>("");
  const [draftAfter, setDraftAfter] = useState<string>("");
  // A message shown when an add is rejected (duplicate, or a conflicting rule
  // that would create a loop in the before/after ordering).
  const [precedenceError, setPrecedenceError] = useState<string | null>(null);
  // Optional facility caps are hidden behind this toggle; most users never set
  // them, and the data plus the utilization ceiling decide the resource need.
  const [showAdvancedLimits, setShowAdvancedLimits] = useState<boolean>(false);

  function removePrecedence(index: number) {
    const next = constraints.precedence.filter((_, i) => i !== index);
    commit({ ...constraints, precedence: next });
    // Removing a rule can only relax the ordering, so clear any stale conflict
    // message.
    setPrecedenceError(null);
  }

  // Would adding "before -> after" create a cycle? Precedence is a strict
  // "must come before" order, so it must stay acyclic. A new edge closes a loop
  // exactly when "after" can already reach "before" through the existing rules
  // (then before -> after would complete the cycle). A self edge is also a
  // trivial cycle. This is a depth-first reachability walk over the rule graph.
  function wouldCreateCycle(before: string, after: string, rules: PrecedenceRule[]): boolean {
    if (before === after) return true;
    const adjacency = new Map<string, string[]>();
    for (const r of rules) {
      const list = adjacency.get(r.before) ?? [];
      list.push(r.after);
      adjacency.set(r.before, list);
    }
    // Can we reach "before" starting from "after" using existing edges?
    const seen = new Set<string>();
    const stack = [after];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (node === before) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const next of adjacency.get(node) ?? []) {
        stack.push(next);
      }
    }
    return false;
  }

  function addPrecedence() {
    // Both operations chosen and not the same operation.
    if (draftBefore === "" || draftAfter === "" || draftBefore === draftAfter) {
      return;
    }
    // Reject an exact duplicate rule.
    const exists = constraints.precedence.some(
      (r) => r.before === draftBefore && r.after === draftAfter,
    );
    if (exists) {
      setPrecedenceError("That rule is already in the list.");
      return;
    }
    // Reject a rule that would conflict with the existing ones by closing a
    // loop (for example B before A when A before B already exists, or any
    // longer chain back to the start). Such a rule can never be satisfied as a
    // real ordering, so it is blocked before it reaches the optimizer.
    if (wouldCreateCycle(draftBefore, draftAfter, constraints.precedence)) {
      const beforeName = operations.find((o) => o.key === draftBefore)?.opName ?? draftBefore;
      const afterName = operations.find((o) => o.key === draftAfter)?.opName ?? draftAfter;
      setPrecedenceError(
        "Cannot add " + beforeName + " before " + afterName +
        ": it conflicts with the existing rules and would create a loop.",
      );
      return;
    }
    const next: PrecedenceRule[] = [
      ...constraints.precedence,
      { before: draftBefore, after: draftAfter },
    ];
    commit({ ...constraints, precedence: next });
    setDraftBefore("");
    setDraftAfter("");
    setPrecedenceError(null);
  }

  const hasOperations = operations.length > 0;

  return (
    <div className="constraints-form">
      <h3 style={sectionTitleStyle}>
        Optimization Settings
        <HelpIcon text="These settings start from your current layout and a safe, conservative baseline: every operation stays on its station and the optimizer only right-sizes machines and operators within a healthy utilization ceiling. Relax the settings below to give it more room, for example by unlocking operations it may move." />
      </h3>

      {/* Resources */}
      <div style={groupStyle}>
        <div style={groupTitleStyle}>Resources</div>

        <label style={labelRowStyle} htmlFor="constraints-util-ceiling">
          Healthy utilization ceiling
          <HelpIcon text="No station may run busier than this share of its takt. It leaves slack so the optimizer never trims resources to the point of creating a bottleneck. Lower is more conservative (more buffer for variability); higher reclaims more resources but leaves less room. 85 percent is a common lean default. The optimizer decides operators and machines per station from your data and this ceiling; machine-only stations tune machines, people-only stations tune operators." />
        </label>
        <select
          id="constraints-util-ceiling"
          value={String(Math.round(constraints.utilization_ceiling * 100))}
          onChange={(e) =>
            commit({ ...constraints, utilization_ceiling: Number(e.target.value) / 100 })
          }
          style={{ ...inputStyle, maxWidth: "260px" }}
        >
          <option value="80">80% (most conservative)</option>
          <option value="85">85% (recommended)</option>
          <option value="90">90%</option>
          <option value="95">95% (most aggressive)</option>
        </select>

        {/* Optional facility caps, hidden by default. These are hard ceilings
            the facility imposes (payroll, floor space), not optimization goals,
            so most runs leave them off and let the data decide. */}
        <label style={{ ...checkRowStyleLocal, marginTop: "14px" }}>
          <input
            type="checkbox"
            checked={showAdvancedLimits}
            onChange={(e) => {
              const on = e.target.checked;
              setShowAdvancedLimits(on);
              // Re-send with the caps now applying (on) or suppressed (off), so
              // toggling the section immediately reflects whether limits bind.
              emit(constraints, on);
            }}
            style={{ width: "auto", margin: 0 }}
          />
          Set facility limits (optional)
          <HelpIcon text="Optional hard caps your facility imposes, such as the most operators you can roster or the most machines you have room for. Off by default, which means no artificial limit: the optimizer uses only what the work and the utilization ceiling require." />
        </label>

        {showAdvancedLimits && (
          <div style={{ marginTop: "12px" }}>
            <div style={twoColStyle}>
              <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                <label style={labelRowStyle} htmlFor="constraints-operator-cap">
                  Max operators
                  <HelpIcon text="A hard limit on total operators across the line, for example the most you can roster. The optimizer will not exceed it. Leave it at or above your current total; it is only a ceiling, not a target." />
                </label>
                <input
                  id="constraints-operator-cap"
                  type="number"
                  min={1}
                  max={999}
                  step={1}
                  value={operatorCapText}
                  onChange={(e) => setOperatorCapText(e.target.value)}
                  onBlur={() => commitOperatorCap(operatorCapText)}
                  aria-invalid={operatorCapError != null}
                  style={inputStyle}
                />
                {operatorCapError && (
                  <p role="alert" style={errorTextStyle}>{operatorCapError}</p>
                )}
              </div>
              <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                <label style={labelRowStyle} htmlFor="constraints-machine-cap">
                  Max machines
                  <HelpIcon text="A hard limit on total machines across the line, for example the most you have floor space for. The optimizer will not exceed it. Leave it at or above your current total; it is only a ceiling, not a target." />
                </label>
                <input
                  id="constraints-machine-cap"
                  type="number"
                  min={0}
                  max={999}
                  step={1}
                  value={machineCapText}
                  onChange={(e) => setMachineCapText(e.target.value)}
                  onBlur={() => commitMachineCap(machineCapText)}
                  aria-invalid={machineCapError != null}
                  style={inputStyle}
                />
                {machineCapError && (
                  <p role="alert" style={errorTextStyle}>{machineCapError}</p>
                )}
              </div>
            </div>

            <div style={{ marginTop: "10px" }}>
              <label style={labelRowStyle} htmlFor="constraints-per-station-limit">
                Per-station machine limit
                <HelpIcon text="A hard limit on machines at any one station, for machine or hybrid stations. Leave blank for no per-station limit (only the total machine limit applies). People-only stations are unaffected since they run on operators." />
              </label>
              <input
                id="constraints-per-station-limit"
                type="number"
                min={0}
                max={999}
                step={1}
                placeholder="No per-station limit"
                value={perStationLimitText}
                onChange={(e) => setPerStationLimitText(e.target.value)}
                onBlur={() => commitPerStationLimit(perStationLimitText)}
                aria-invalid={perStationLimitError != null}
                style={{ ...inputStyle, maxWidth: "220px" }}
              />
              {perStationLimitError && (
                <p role="alert" style={errorTextStyle}>{perStationLimitError}</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* What to focus on */}
      <div style={groupStyle}>
        <div style={groupTitleStyle}>
          What should the optimizer focus on?
          <HelpIcon text="When the optimizer cannot cut both, this tells it which resource to save first. Balance both treats operators and machines equally. Each station is tuned on the resource that actually paces it (machines for machine stations, operators for people stations), and any facility limits you set are always respected." />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }} role="group" aria-label="What should the optimizer focus on">
          {FOCUS_OPTIONS.map((opt) => {
            const selected = currentFocus() === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFocus(opt.value)}
                aria-pressed={selected}
                title={opt.hint}
                style={{ ...focusButtonStyle(selected), flex: "1 1 120px" }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <p style={{ ...helpTextStyle, marginTop: "8px" }}>
          {FOCUS_OPTIONS.find((o) => o.value === currentFocus())?.hint}
        </p>
      </div>

      {/* Station locks */}
      <div style={groupStyle}>
        <div style={groupTitleStyle}>
          Station locks
          <HelpIcon text="By default every operation is Locked to its current station, so a no-edit run keeps your current assignment and only right-sizes machines and operators. Switch an operation to Free to move to let the optimizer reassign it to a better station (or pick a specific station to pin it to)." />
        </div>
        {!hasOperations ? (
          <p style={helpTextStyle}>No operations to lock yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "28%" }} />
              <col style={{ width: "30%" }} />
              <col style={{ width: "42%" }} />
            </colgroup>
            <thead>
              <tr style={{ color: "#8fb0d6" }}>
                <th style={{ ...lockThStyle, textAlign: "left" }}>Operation</th>
                <th style={{ ...lockThStyle, textAlign: "center" }}>Current station</th>
                <th style={{ ...lockThStyle, textAlign: "center" }}>Lock</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((op) => {
                const lockedTo = lockedStationOf(op.key);
                const isLocked = lockedTo !== "";
                // "Lock here" pins to the chosen station when one is already
                // selected, otherwise to the operation's current station.
                const lockTarget = isLocked ? lockedTo : op.stationId;
                return (
                  <tr key={op.key} style={{ borderTop: "1px solid rgba(45, 90, 142, 0.25)" }}>
                    <td style={lockTdStyle} title={op.opName}>{op.opName}</td>
                    <td style={{ ...lockTdStyle, color: "#8fb0d6", textAlign: "center" }} title={op.stationName}>
                      {op.stationName}
                    </td>
                    <td style={{ ...lockTdStyle, textAlign: "center", maxWidth: "none", whiteSpace: "nowrap" }}>
                      <div style={{ display: "inline-flex", gap: "6px", alignItems: "center", justifyContent: "center" }}>
                        <button
                          type="button"
                          onClick={() => setLock(op.key, "")}
                          aria-pressed={!isLocked}
                          style={lockPillStyle(!isLocked)}
                        >
                          Free to move
                        </button>
                        <button
                          type="button"
                          onClick={() => setLock(op.key, lockTarget)}
                          aria-pressed={isLocked}
                          style={lockPillStyle(isLocked)}
                        >
                          Lock here
                        </button>
                        {isLocked && (
                          <select
                            aria-label={"Station to lock " + op.opName + " to"}
                            value={lockedTo}
                            onChange={(e) => setLock(op.key, e.target.value)}
                            style={{ ...inputStyle, width: "auto", minWidth: "120px", padding: "4px 6px" }}
                          >
                            {layout.stations.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Precedence (editable) */}
      <div style={groupStyle}>
        <div style={groupTitleStyle}>
          Precedence
          <HelpIcon text="Rules of the form A must come before B, so the optimizer only proposes a buildable sequence. This starts from your current operation order. Remove a rule if two operations can actually run in either order, so the optimizer has more freedom. Add a rule to enforce a real ordering it should never break." />
        </div>

        {constraints.precedence.length === 0 ? (
          <p style={helpTextStyle}>
            No precedence rules. The optimizer keeps your current operation order as the default buildable sequence.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 10px 0", display: "flex", flexDirection: "column", gap: "6px" }}>
            {constraints.precedence.map((rule, index) => {
              const beforeName = operations.find((o) => o.key === rule.before)?.opName ?? rule.before;
              const afterName = operations.find((o) => o.key === rule.after)?.opName ?? rule.after;
              return (
                <li
                  key={String(rule.before) + "->" + String(rule.after) + "-" + String(index)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                    padding: "5px 8px",
                    background: "rgba(45, 90, 142, 0.12)",
                    border: "1px solid rgba(45, 90, 142, 0.3)",
                    borderRadius: "6px",
                    fontSize: "0.82rem",
                    color: "#dce7f5",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {beforeName} <span style={{ color: "#5fce7f", fontWeight: 700 }}>before</span> {afterName}
                  </span>
                  <button
                    type="button"
                    aria-label={"Remove rule " + beforeName + " before " + afterName}
                    onClick={() => removePrecedence(index)}
                    style={{
                      flex: "0 0 auto",
                      width: "22px",
                      height: "22px",
                      borderRadius: "50%",
                      border: "1px solid #2d5a8e",
                      background: "transparent",
                      color: "#b0c8e0",
                      cursor: "pointer",
                      fontSize: "0.9rem",
                      lineHeight: 1,
                    }}
                  >
                    x
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Add a rule */}
        {hasOperations && (
          <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
            <select
              aria-label="Operation that must come first"
              value={draftBefore}
              onChange={(e) => setDraftBefore(e.target.value)}
              style={{ ...inputStyle, width: "auto", flex: "1 1 120px", minWidth: 0, padding: "5px 6px" }}
            >
              <option value="">Operation...</option>
              {operations.map((op) => (
                <option key={op.key} value={op.key}>{op.opName}</option>
              ))}
            </select>
            <span style={{ color: "#5fce7f", fontWeight: 700, fontSize: "0.82rem" }}>before</span>
            <select
              aria-label="Operation that must come after"
              value={draftAfter}
              onChange={(e) => setDraftAfter(e.target.value)}
              style={{ ...inputStyle, width: "auto", flex: "1 1 120px", minWidth: 0, padding: "5px 6px" }}
            >
              <option value="">Operation...</option>
              {operations.map((op) => (
                <option key={op.key} value={op.key}>{op.opName}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={addPrecedence}
              disabled={draftBefore === "" || draftAfter === "" || draftBefore === draftAfter}
              style={{
                flex: "0 0 auto",
                padding: "6px 12px",
                borderRadius: "6px",
                border: "none",
                background: draftBefore !== "" && draftAfter !== "" && draftBefore !== draftAfter ? "#2d5a8e" : "#1a2a3a",
                color: draftBefore !== "" && draftAfter !== "" && draftBefore !== draftAfter ? "#fff" : "#6c757d",
                cursor: draftBefore !== "" && draftAfter !== "" && draftBefore !== draftAfter ? "pointer" : "not-allowed",
                fontSize: "0.8rem",
                fontWeight: 600,
              }}
            >
              Add rule
            </button>
          </div>
          {precedenceError && (
            <p role="alert" style={{ ...errorTextStyle, marginTop: "8px" }}>{precedenceError}</p>
          )}
          </>
        )}
      </div>
    </div>
  );
}
