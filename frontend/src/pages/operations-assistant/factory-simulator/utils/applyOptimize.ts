/**
 * applyOptimize: pure helpers that turn an Auto-Optimize proposal into the set
 * of LayoutContext reducer dispatches that apply it to the canvas (Req 9.2 to
 * 9.8).
 *
 * The apply contract, stated once here and relied on by both the page wiring
 * and the required apply tests (task 16.3):
 *
 *   - Only three station fields are ever written: operations (the station
 *     contents / operation-to-station assignment, Req 9.2), operators_required
 *     (the station operator count, Req 9.3), and num_machines (the station
 *     machine count, Req 9.3). Each is carried straight off the matching
 *     station in the proposed layout.
 *   - x and y are NEVER written. Every dispatch is an UPDATE_ELEMENT whose
 *     updates object contains only the three fields above, and UPDATE_ELEMENT
 *     merges updates into the matched element without touching any field not in
 *     the updates object, so station positions are preserved with zero change
 *     in coordinate values (Req 9.4). This is the key mechanism the no-mutation
 *     and position-preservation guarantees rest on.
 *   - Stations are matched BY id between the proposed layout and the current
 *     layout. A proposed station with no matching current station id is skipped
 *     (there is nothing on the canvas to update), so apply never creates or
 *     deletes a box; it only updates existing station contents and counts.
 *   - Everything else is preserved by omission. Station names, reliability,
 *     scrap_rate, setup_time, variability, line_ids, shared_schedule, and every
 *     other station field, as well as connections, lines, sources, sinks,
 *     buffers, and operator pools, are never included in a dispatch, so they are
 *     left exactly as they are on the current canvas (Req 9.5).
 *
 * The flow is deliberately split into a pure planning step (buildApplyActions)
 * and a thin dispatch step (applyOptimizeProposal). Computing the full list of
 * dispatches first lets the caller apply all or none: if planning cannot
 * produce a usable set of actions the caller performs none and leaves the
 * canvas unchanged (Req 9.7). The planning step is pure over its inputs, so the
 * apply tests can assert the exact dispatches and then run them through the real
 * reducer.
 *
 * This file follows the project rule that no em dashes or en dashes appear
 * anywhere; only ASCII hyphens are used, in code, comments, and strings.
 *
 * Requirements: 9.2, 9.3, 9.4, 9.5, 9.6, 9.7.
 */

import type { Layout, LayoutAction, Station } from "../types";

/**
 * The only station fields Apply writes. Deliberately a narrow shape so x and y
 * (and every other station field) can never leak into a dispatched update: the
 * type itself forbids it.
 */
export interface StationApplyUpdates {
  operations: Station["operations"];
  operators_required: Station["operators_required"];
  num_machines: Station["num_machines"];
}

/** An UPDATE_ELEMENT action carrying exactly the three apply fields. */
export type ApplyAction = {
  type: "UPDATE_ELEMENT";
  id: string;
  updates: StationApplyUpdates;
};

/**
 * Build the full, ordered list of UPDATE_ELEMENT dispatches that apply the
 * proposed layout to the current one (Req 9.2, 9.3). Pure: it reads the two
 * layouts and returns actions, dispatching nothing.
 *
 * For each station in the proposed layout that has a matching station id in the
 * current layout, it emits one UPDATE_ELEMENT whose updates object carries only
 * operations, operators_required, and num_machines from the proposed station.
 * x and y are never read and never written, so positions are preserved by the
 * reducer's merge (Req 9.4). A proposed station id absent from the current
 * layout is skipped so apply never adds or removes a box.
 *
 * The Operation objects are carried by reference from the proposed layout's
 * station, which the backend built as a deep copy of the current layout's
 * Operation objects, so cycle_time and operators_required on each operation are
 * conserved exactly (mirrors how APPLY_BALANCE conserves Operation objects).
 */
export function buildApplyActions(
  currentLayout: Layout,
  proposedLayout: Layout,
): ApplyAction[] {
  const currentIds = new Set(currentLayout.stations.map((s) => s.id));
  const actions: ApplyAction[] = [];

  for (const proposed of proposedLayout.stations) {
    // Only update stations that exist on the current canvas. Matching is by id.
    if (!currentIds.has(proposed.id)) continue;

    actions.push({
      type: "UPDATE_ELEMENT",
      id: proposed.id,
      updates: {
        // The station contents (operation-to-station assignment), Req 9.2.
        operations: proposed.operations,
        // The station operator count and machine count, Req 9.3.
        operators_required: proposed.operators_required,
        num_machines: proposed.num_machines,
      },
    });
  }

  return actions;
}

/**
 * Apply an Auto-Optimize proposal to the canvas through the LayoutContext
 * reducer (Req 9.2 to 9.7). It plans the full set of dispatches first, then,
 * only if planning produced a usable result, dispatches them all.
 *
 * Returns true when the proposal was applied (including the valid no-op case
 * where the proposal equals the current layout and there is nothing to change),
 * and false when it could not be applied so the caller must leave the canvas
 * unchanged and show an apply-did-not-complete error (Req 9.7).
 *
 * Transactional intent (Req 9.7): all planning happens before any dispatch. If
 * planning throws, nothing has been dispatched yet, so the canvas is untouched
 * and the function reports failure. There is no partial-apply window: the only
 * dispatches are the UPDATE_ELEMENT actions, each of which merges its three
 * fields independently, and they are only reached once the full plan exists.
 *
 * A missing proposed layout (for example a non-reviewable status) is treated as
 * nothing to apply and reported as a failure so the caller does not close the
 * review as if an apply succeeded.
 */
export function applyOptimizeProposal(
  currentLayout: Layout,
  proposedLayout: Layout | null | undefined,
  dispatch: (action: LayoutAction) => void,
): boolean {
  if (!proposedLayout) return false;

  let actions: ApplyAction[];
  try {
    actions = buildApplyActions(currentLayout, proposedLayout);
  } catch {
    // Planning failed before any dispatch: leave the canvas unchanged (Req 9.7).
    return false;
  }

  // Dispatch the full plan. ApplyAction is structurally a LayoutAction
  // (UPDATE_ELEMENT with a Partial<CanvasElement> updates), so each is a valid
  // reducer action; the narrow StationApplyUpdates shape guarantees x and y are
  // never present in updates.
  for (const action of actions) {
    dispatch(action);
  }

  return true;
}
