/**
 * Pure helper functions for operations-aware Workstations.
 *
 * A Workstation (Station) may hold an ordered list of Operations, each with its
 * own cycle time and operator requirement. When the operations list is
 * non-empty, the Workstation's effective cycle time and total operators
 * required are aggregated from its Operations. When it is empty, the flat
 * Station-level `cycle_time` / `operators_required` values are used as a
 * backward-compatible fallback.
 *
 * The `Operation` interface and the `operations` field on `Station` are added
 * to the shared types module in a later task. To keep these helpers
 * self-contained and type-safe now, we accept a minimal structural type that is
 * compatible with the future `Station` interface.
 */

/** Minimal structural shape of an Operation used by these helpers. */
export interface OperationLike {
  cycle_time: number;
  operators_required: number;
}

/** Minimal structural shape of a Station used by these helpers. */
export interface StationLike {
  cycle_time: number;
  operators_required: number;
  operations?: OperationLike[];
}

/**
 * Effective cycle time of a Workstation.
 *
 * Returns the sum of its Operations' cycle times when the operations list is
 * non-empty; otherwise falls back to the flat Station-level `cycle_time`.
 */
export function effectiveCycleTime(s: StationLike): number {
  const ops = s.operations;
  if (ops && ops.length > 0) {
    return ops.reduce((sum, op) => sum + op.cycle_time, 0);
  }
  return s.cycle_time;
}

/**
 * Total operators required by a Workstation.
 *
 * Returns the sum of its Operations' `operators_required` when the operations
 * list is non-empty; otherwise falls back to the flat Station-level
 * `operators_required`.
 */
export function totalOperatorsRequired(s: StationLike): number {
  const ops = s.operations;
  if (ops && ops.length > 0) {
    return ops.reduce((sum, op) => sum + op.operators_required, 0);
  }
  return s.operators_required;
}
