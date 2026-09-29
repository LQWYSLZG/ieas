/**
 * LayoutContext: State management for the Factory Floor Simulator.
 *
 * Manages the complete layout (sources, stations, buffers, sinks, operator pools,
 * connections) and scenarios via useReducer + Context.
 */

import React, { createContext, useContext, useReducer } from "react";
import type { Layout, LayoutAction, Operation, Scenario } from "../types";

const MAX_SCENARIOS = 10;

const initialLayout: Layout = {
  schema_version: 3,
  sources: [],
  stations: [],
  buffers: [],
  sinks: [],
  operator_pools: [],
  connections: [],
  floor_plan: undefined,
};

interface LayoutState {
  layout: Layout;
  scenarios: Scenario[];
}

const initialState: LayoutState = {
  layout: initialLayout,
  scenarios: [],
};

interface LayoutContextValue {
  layout: Layout;
  scenarios: Scenario[];
  dispatch: React.Dispatch<LayoutAction>;
}

const LayoutContext = createContext<LayoutContextValue | undefined>(undefined);

function layoutReducer(state: LayoutState, action: LayoutAction): LayoutState {
  const { layout } = state;

  switch (action.type) {
    case "ADD_SOURCE":
      return { ...state, layout: { ...layout, sources: [...layout.sources, action.source] } };

    case "ADD_STATION":
      return { ...state, layout: { ...layout, stations: [...layout.stations, action.station] } };

    case "ADD_BUFFER":
      return { ...state, layout: { ...layout, buffers: [...layout.buffers, action.buffer] } };

    case "ADD_SINK":
      return { ...state, layout: { ...layout, sinks: [...layout.sinks, action.sink] } };

    case "ADD_OPERATOR_POOL":
      return { ...state, layout: { ...layout, operator_pools: [...layout.operator_pools, action.pool] } };

    case "MOVE_ELEMENT": {
      const { id, x, y } = action;
      return {
        ...state,
        layout: {
          ...layout,
          sources: layout.sources.map((s) => (s.id === id ? { ...s, x, y } as any : s)),
          stations: layout.stations.map((s) => (s.id === id ? { ...s, x, y } as any : s)),
          buffers: layout.buffers.map((b) => (b.id === id ? { ...b, x, y } as any : b)),
          sinks: layout.sinks.map((s) => (s.id === id ? { ...s, x, y } as any : s)),
          operator_pools: layout.operator_pools.map((p) => (p.id === id ? { ...p, x, y } as any : p)),
        },
      };
    }

    case "UPDATE_ELEMENT": {
      const { id, updates } = action;
      return {
        ...state,
        layout: {
          ...layout,
          sources: layout.sources.map((s) => (s.id === id ? { ...s, ...updates } as any : s)),
          stations: layout.stations.map((s) => (s.id === id ? { ...s, ...updates } as any : s)),
          buffers: layout.buffers.map((b) => (b.id === id ? { ...b, ...updates } as any : b)),
          sinks: layout.sinks.map((s) => (s.id === id ? { ...s, ...updates } as any : s)),
          operator_pools: layout.operator_pools.map((p) => (p.id === id ? { ...p, ...updates } as any : p)),
        },
      };
    }

    case "DELETE_ELEMENT": {
      const { id } = action;
      const isStation = layout.stations.some((s) => s.id === id);

      // Atomic station deletion with rollback (Req 2.5, 2.7):
      // When deleting a Station, station removal AND connection removal must
      // both succeed, or the layout is left entirely unchanged. Guard the
      // construction of the next layout so that we can never end up with the
      // station removed but its connections still present (or vice versa).
      if (isStation) {
        try {
          const nextStations = layout.stations.filter((s) => s.id !== id);
          const nextConnections = layout.connections.filter(
            (c) => c.source_id !== id && c.target_id !== id
          );

          // Only commit once BOTH arrays are successfully constructed.
          const nextLayout: Layout = {
            ...layout,
            stations: nextStations,
            connections: nextConnections,
          };
          return { ...state, layout: nextLayout };
        } catch (err) {
          // On any failure, leave the layout unchanged (no partial deletion).
          // eslint-disable-next-line no-console
          console.error("Atomic station deletion failed; layout unchanged:", err);
          return state;
        }
      }

      // Non-station elements keep the existing cascade-delete behavior.
      return {
        ...state,
        layout: {
          ...layout,
          sources: layout.sources.filter((s) => s.id !== id),
          buffers: layout.buffers.filter((b) => b.id !== id),
          sinks: layout.sinks.filter((s) => s.id !== id),
          operator_pools: layout.operator_pools.filter((p) => p.id !== id),
          // Cascade-delete connections referencing deleted element
          connections: layout.connections.filter(
            (c) => c.source_id !== id && c.target_id !== id
          ),
        },
      };
    }

    case "ADD_OPERATION": {
      const { stationId, operation } = action;
      return {
        ...state,
        layout: {
          ...layout,
          stations: layout.stations.map((s) =>
            s.id === stationId
              ? { ...s, operations: [...s.operations, operation] }
              : s
          ),
        },
      };
    }

    case "UPDATE_OPERATION": {
      const { stationId, index, updates } = action;
      return {
        ...state,
        layout: {
          ...layout,
          stations: layout.stations.map((s) => {
            if (s.id !== stationId) return s;
            if (index < 0 || index >= s.operations.length) return s;
            return {
              ...s,
              operations: s.operations.map((op, i) =>
                i === index ? { ...op, ...updates } : op
              ),
            };
          }),
        },
      };
    }

    case "REORDER_OPERATION": {
      const { stationId, from, to } = action;
      return {
        ...state,
        layout: {
          ...layout,
          stations: layout.stations.map((s) => {
            if (s.id !== stationId) return s;
            const len = s.operations.length;
            if (from < 0 || from >= len || to < 0 || to >= len || from === to) return s;
            const operations = [...s.operations];
            const [moved] = operations.splice(from, 1);
            operations.splice(to, 0, moved);
            return { ...s, operations };
          }),
        },
      };
    }

    case "REMOVE_OPERATION": {
      const { stationId, index } = action;
      return {
        ...state,
        layout: {
          ...layout,
          stations: layout.stations.map((s) => {
            if (s.id !== stationId) return s;
            if (index < 0 || index >= s.operations.length) return s;
            return {
              ...s,
              operations: s.operations.filter((_, i) => i !== index),
            };
          }),
        },
      };
    }

    case "MOVE_OPERATION": {
      // Move an Operation from one Workstation to another (Req 16.1, 16.2, 16.6).
      // Removing operations[index] from the source and appending it to the
      // target immutably. Effective cycle time and total operators required for
      // both stations are derived (via effectiveCycleTime/totalOperatorsRequired
      // in utils/operations.ts) from these arrays, so they recalculate for free.
      const { fromStationId, toStationId, index } = action;

      // No-op on same-station moves.
      if (fromStationId === toStationId) return state;

      const source = layout.stations.find((s) => s.id === fromStationId);
      const target = layout.stations.find((s) => s.id === toStationId);

      // No-op when either station is missing or the index is out of bounds.
      if (!source || !target) return state;
      if (index < 0 || index >= source.operations.length) return state;

      const moved = source.operations[index];
      const nextSourceOps = source.operations.filter((_, i) => i !== index);
      const nextTargetOps = [...target.operations, moved];

      return {
        ...state,
        layout: {
          ...layout,
          stations: layout.stations.map((s) => {
            if (s.id === fromStationId) return { ...s, operations: nextSourceOps };
            if (s.id === toStationId) return { ...s, operations: nextTargetOps };
            return s;
          }),
        },
      };
    }

    case "APPLY_BALANCE": {
      // Apply a Line_Balancer proposal (Req 16.6). The assignment maps a
      // Workstation NAME to an ordered list of Operation names. Rebuild each
      // affected station's operations to match, conserving Operation objects by
      // matching name against the current pool gathered across all stations.
      const { assignment } = action;

      // Build a pool of available Operation objects keyed by name. Duplicate
      // names are queued so repeated names are consumed in order.
      const pool = new Map<string, Operation[]>();
      for (const s of layout.stations) {
        for (const op of s.operations) {
          const bucket = pool.get(op.name);
          if (bucket) bucket.push(op);
          else pool.set(op.name, [op]);
        }
      }

      const takeFromPool = (name: string): Operation | undefined => {
        const bucket = pool.get(name);
        if (bucket && bucket.length > 0) return bucket.shift();
        return undefined;
      };

      return {
        ...state,
        layout: {
          ...layout,
          stations: layout.stations.map((s) => {
            // Stations not present in the assignment keep their operations.
            if (!Object.prototype.hasOwnProperty.call(assignment, s.name)) {
              return s;
            }
            const names = assignment[s.name] ?? [];
            const operations: Operation[] = [];
            for (const name of names) {
              const op = takeFromPool(name);
              // Skip gracefully when an assigned name isn't in the pool.
              if (op) operations.push(op);
            }
            return { ...s, operations };
          }),
        },
      };
    }

    case "IMPORT_TIME_STUDY": {
      // Import an auto-generated, operations-aware layout from the time-study
      // importer (Req 15.8, 15.9, 15.10). This replaces the layout with the
      // populated, editable one, effectively RESETTING an already-complete
      // canvas to the freshly populated state while leaving the user free to
      // then draw Source/Sink/Buffer/Connection to finish the layout. Manual
      // creation remains fully supported (add actions are unaffected).
      //
      // We preserve the imported layout's own schema_version rather than
      // forcing it. The backend now emits schema_version 4 for multi-line
      // imports (with lines and per-station line_ids), so spreading the
      // imported layout as-is lets that multi-line schema 4 data (lines and
      // line_ids) survive instead of being downgraded to 3.
      const imported = action.layout;
      return { ...state, layout: { ...imported } };
    }

    case "ADD_CONNECTION":
      return { ...state, layout: { ...layout, connections: [...layout.connections, action.connection] } };

    case "UPDATE_CONNECTION": {
      const { id, updates } = action;
      return {
        ...state,
        layout: {
          ...layout,
          connections: layout.connections.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        },
      };
    }

    case "DELETE_CONNECTION":
      return {
        ...state,
        layout: { ...layout, connections: layout.connections.filter((c) => c.id !== action.id) },
      };

    case "SET_FLOOR_PLAN":
      return { ...state, layout: { ...layout, floor_plan: action.floorPlan } };

    case "REMOVE_FLOOR_PLAN":
      return { ...state, layout: { ...layout, floor_plan: undefined } };

    case "LOAD_LAYOUT":
      return { ...state, layout: action.layout };

    case "CLEAR":
      // Full reset: clear the layout (elements, connections, floor plan) AND any
      // saved scenarios so the tool returns to a completely fresh state.
      return { ...state, layout: initialLayout, scenarios: [] };

    case "SAVE_SCENARIO": {
      if (state.scenarios.length >= MAX_SCENARIOS) return state;
      const newScenario: Scenario = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        layout: JSON.parse(JSON.stringify(state.layout)),
        result: action.result,
      };
      return { ...state, scenarios: [...state.scenarios, newScenario] };
    }

    case "DELETE_SCENARIO":
      return { ...state, scenarios: state.scenarios.filter((s) => s.id !== action.id) };

    case "ASSIGN_ELEMENT_LINES": {
      // Set a Workstation's line_ids array (Req 1.6, 3.3). Only a station may
      // serve multiple lines; 2+ lines mark it shared. Mirrors UPDATE_ELEMENT's
      // map-and-merge over stations, matching by id.
      const { id, line_ids } = action;
      return {
        ...state,
        layout: {
          ...layout,
          stations: layout.stations.map((s) => (s.id === id ? { ...s, line_ids } : s)),
        },
      };
    }

    case "SET_ELEMENT_LINE": {
      // Set a Source/Buffer/Sink's single line_id (Req 1.5, 1.6). A non-station
      // element belongs to at most one line; null clears the assignment for
      // connectivity auto-resolution. Map over sources, buffers, and sinks.
      const { id, line_id } = action;
      return {
        ...state,
        layout: {
          ...layout,
          sources: layout.sources.map((s) => (s.id === id ? { ...s, line_id } : s)),
          buffers: layout.buffers.map((b) => (b.id === id ? { ...b, line_id } : b)),
          sinks: layout.sinks.map((s) => (s.id === id ? { ...s, line_id } : s)),
        },
      };
    }

    case "RENAME_LINE": {
      // Rename a LineInfo in layout.lines, keeping all element assignments
      // unchanged (Req 7.1). Treat an undefined layout.lines as empty.
      const { line_id, name } = action;
      const lines = (layout.lines ?? []).map((l) => (l.id === line_id ? { ...l, name } : l));
      return { ...state, layout: { ...layout, lines } };
    }

    case "SET_LINE_TARGET": {
      // Update a LineInfo's target_throughput and/or takt_time (Req 4.1). Only
      // apply the fields present on the action so callers can set either or
      // both. Treat an undefined layout.lines as empty.
      const { line_id, target_throughput, takt_time } = action;
      const lines = (layout.lines ?? []).map((l) => {
        if (l.id !== line_id) return l;
        const next = { ...l };
        if ("target_throughput" in action) next.target_throughput = target_throughput;
        if ("takt_time" in action) next.takt_time = takt_time;
        return next;
      });
      return { ...state, layout: { ...layout, lines } };
    }

    case "SET_SHARED_SCHEDULE": {
      // Set a Workstation's shared_schedule preset (Req 7.1): how a shared
      // station orders work across lines. Map over stations, matching by id.
      const { station_id, schedule } = action;
      return {
        ...state,
        layout: {
          ...layout,
          stations: layout.stations.map((s) => (s.id === station_id ? { ...s, shared_schedule: schedule } : s)),
        },
      };
    }

    default:
      return state;
  }
}

export function LayoutProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(layoutReducer, initialState);

  return (
    <LayoutContext.Provider value={{ layout: state.layout, scenarios: state.scenarios, dispatch }}>
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayout(): LayoutContextValue {
  const context = useContext(LayoutContext);
  if (context === undefined) {
    throw new Error("useLayout must be used within a LayoutProvider");
  }
  return context;
}
