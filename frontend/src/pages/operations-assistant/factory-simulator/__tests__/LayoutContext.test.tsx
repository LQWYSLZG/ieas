import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import React from "react";
import { LayoutProvider, useLayout } from "../context/LayoutContext";
import type { Station, Connection, FloorPlan, Layout } from "../types";

function wrapper({ children }: { children: React.ReactNode }) {
  return <LayoutProvider>{children}</LayoutProvider>;
}

/** Build a valid Station literal for the current (schema v3) model. */
function makeStation(overrides: Partial<Station> = {}): Station {
  return {
    id: "s1",
    name: "Station 1",
    element_type: "station",
    x: 100,
    y: 200,
    cycle_time: 30,
    num_machines: 1,
    operators_required: 1,
    reliability: 100,
    scrap_rate: 0,
    setup_time: 0,
    variability: 0.1,
    operations: [],
    ...overrides,
  };
}

/** Build a valid Connection literal for the current model. */
function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "c1",
    source_id: "s1",
    target_id: "s2",
    transport_time: 0,
    transport_mode: "none",
    distance: 0,
    ...overrides,
  };
}

/** The current initial/empty layout shape (schema v3, all element arrays). */
function emptyLayout(): Layout {
  return {
    schema_version: 3,
    sources: [],
    stations: [],
    buffers: [],
    sinks: [],
    operator_pools: [],
    connections: [],
    floor_plan: undefined,
  };
}

describe("LayoutContext", () => {
  it("provides initial empty layout", () => {
    const { result } = renderHook(() => useLayout(), { wrapper });
    expect(result.current.layout).toEqual(emptyLayout());
  });

  it("throws when useLayout is used outside LayoutProvider", () => {
    expect(() => renderHook(() => useLayout())).toThrow(
      "useLayout must be used within a LayoutProvider"
    );
  });

  describe("ADD_STATION", () => {
    it("adds a station to the layout", () => {
      const { result } = renderHook(() => useLayout(), { wrapper });
      const station = makeStation();

      act(() => {
        result.current.dispatch({ type: "ADD_STATION", station });
      });

      expect(result.current.layout.stations).toHaveLength(1);
      expect(result.current.layout.stations[0]).toEqual(station);
    });
  });

  describe("MOVE_ELEMENT", () => {
    it("updates station x and y by id", () => {
      const { result } = renderHook(() => useLayout(), { wrapper });
      const station = makeStation({ id: "s1", x: 0, y: 0 });

      act(() => {
        result.current.dispatch({ type: "ADD_STATION", station });
      });
      act(() => {
        result.current.dispatch({ type: "MOVE_ELEMENT", id: "s1", x: 50, y: 75 });
      });

      expect(result.current.layout.stations[0].x).toBe(50);
      expect(result.current.layout.stations[0].y).toBe(75);
    });
  });

  describe("UPDATE_ELEMENT", () => {
    it("merges partial updates into station by id", () => {
      const { result } = renderHook(() => useLayout(), { wrapper });
      const station = makeStation({ id: "s1", name: "Old", cycle_time: 10 });

      act(() => {
        result.current.dispatch({ type: "ADD_STATION", station });
      });
      act(() => {
        result.current.dispatch({
          type: "UPDATE_ELEMENT",
          id: "s1",
          updates: { name: "New", num_machines: 3 },
        });
      });

      const updated = result.current.layout.stations[0];
      expect(updated.name).toBe("New");
      expect(updated.num_machines).toBe(3);
      expect(updated.cycle_time).toBe(10); // unchanged
    });
  });

  describe("DELETE_ELEMENT", () => {
    it("removes the station from the layout", () => {
      const { result } = renderHook(() => useLayout(), { wrapper });

      act(() => {
        result.current.dispatch({ type: "ADD_STATION", station: makeStation({ id: "s1" }) });
        result.current.dispatch({ type: "ADD_STATION", station: makeStation({ id: "s2" }) });
      });
      act(() => {
        result.current.dispatch({ type: "DELETE_ELEMENT", id: "s1" });
      });

      expect(result.current.layout.stations).toHaveLength(1);
      expect(result.current.layout.stations[0].id).toBe("s2");
    });

    it("atomically removes a deleted station and its connections", () => {
      const { result } = renderHook(() => useLayout(), { wrapper });

      act(() => {
        result.current.dispatch({ type: "ADD_STATION", station: makeStation({ id: "s1" }) });
        result.current.dispatch({ type: "ADD_STATION", station: makeStation({ id: "s2" }) });
        result.current.dispatch({ type: "ADD_STATION", station: makeStation({ id: "s3" }) });
        result.current.dispatch({
          type: "ADD_CONNECTION",
          connection: makeConnection({ id: "c1", source_id: "s1", target_id: "s2" }),
        });
        result.current.dispatch({
          type: "ADD_CONNECTION",
          connection: makeConnection({ id: "c2", source_id: "s2", target_id: "s3" }),
        });
        result.current.dispatch({
          type: "ADD_CONNECTION",
          connection: makeConnection({ id: "c3", source_id: "s3", target_id: "s1" }),
        });
      });

      act(() => {
        result.current.dispatch({ type: "DELETE_ELEMENT", id: "s1" });
      });

      // Station removed AND its incident connections removed atomically:
      // c1 (source_id=s1) and c3 (target_id=s1) go; c2 (s2->s3) remains.
      expect(result.current.layout.stations.map((s) => s.id)).toEqual(["s2", "s3"]);
      expect(result.current.layout.connections).toHaveLength(1);
      expect(result.current.layout.connections[0].id).toBe("c2");
    });
  });

  describe("ADD_CONNECTION", () => {
    it("adds a connection to the layout", () => {
      const { result } = renderHook(() => useLayout(), { wrapper });
      const connection = makeConnection();

      act(() => {
        result.current.dispatch({ type: "ADD_CONNECTION", connection });
      });

      expect(result.current.layout.connections).toHaveLength(1);
      expect(result.current.layout.connections[0]).toEqual(connection);
    });
  });

  describe("UPDATE_CONNECTION", () => {
    it("merges partial updates into a connection by id", () => {
      const { result } = renderHook(() => useLayout(), { wrapper });

      act(() => {
        result.current.dispatch({
          type: "ADD_CONNECTION",
          connection: makeConnection({ id: "c1" }),
        });
      });
      act(() => {
        result.current.dispatch({
          type: "UPDATE_CONNECTION",
          id: "c1",
          updates: { transport_time: 12, transport_mode: "conveyor", distance: 5 },
        });
      });

      const updated = result.current.layout.connections[0];
      expect(updated.transport_time).toBe(12);
      expect(updated.transport_mode).toBe("conveyor");
      expect(updated.distance).toBe(5);
    });
  });

  describe("DELETE_CONNECTION", () => {
    it("removes a connection by id", () => {
      const { result } = renderHook(() => useLayout(), { wrapper });

      act(() => {
        result.current.dispatch({
          type: "ADD_CONNECTION",
          connection: makeConnection({ id: "c1" }),
        });
        result.current.dispatch({
          type: "ADD_CONNECTION",
          connection: makeConnection({ id: "c2", source_id: "s2", target_id: "s3" }),
        });
      });
      act(() => {
        result.current.dispatch({ type: "DELETE_CONNECTION", id: "c1" });
      });

      expect(result.current.layout.connections).toHaveLength(1);
      expect(result.current.layout.connections[0].id).toBe("c2");
    });
  });

  describe("SET_FLOOR_PLAN", () => {
    it("sets the floor plan on the layout", () => {
      const { result } = renderHook(() => useLayout(), { wrapper });
      const floorPlan: FloorPlan = { filename: "plan.png", data_url: "data:image/png;base64,abc" };

      act(() => {
        result.current.dispatch({ type: "SET_FLOOR_PLAN", floorPlan });
      });

      expect(result.current.layout.floor_plan).toEqual(floorPlan);
    });
  });

  describe("REMOVE_FLOOR_PLAN", () => {
    it("sets floor_plan to undefined", () => {
      const { result } = renderHook(() => useLayout(), { wrapper });
      const floorPlan: FloorPlan = { filename: "plan.png" };

      act(() => {
        result.current.dispatch({ type: "SET_FLOOR_PLAN", floorPlan });
      });
      act(() => {
        result.current.dispatch({ type: "REMOVE_FLOOR_PLAN" });
      });

      expect(result.current.layout.floor_plan).toBeUndefined();
    });
  });

  describe("LOAD_LAYOUT", () => {
    it("replaces the entire layout", () => {
      const { result } = renderHook(() => useLayout(), { wrapper });
      const newLayout: Layout = {
        ...emptyLayout(),
        stations: [makeStation({ id: "loaded-s1" })],
        connections: [
          makeConnection({ id: "loaded-c1", source_id: "loaded-s1", target_id: "loaded-s2" }),
        ],
        floor_plan: { filename: "loaded.png" },
      };

      act(() => {
        // Add some initial state
        result.current.dispatch({ type: "ADD_STATION", station: makeStation({ id: "old" }) });
      });
      act(() => {
        result.current.dispatch({ type: "LOAD_LAYOUT", layout: newLayout });
      });

      expect(result.current.layout).toEqual(newLayout);
    });
  });

  describe("CLEAR", () => {
    it("resets to initial empty layout state", () => {
      const { result } = renderHook(() => useLayout(), { wrapper });

      act(() => {
        result.current.dispatch({ type: "ADD_STATION", station: makeStation() });
        result.current.dispatch({
          type: "SET_FLOOR_PLAN",
          floorPlan: { filename: "bg.png" },
        });
      });
      act(() => {
        result.current.dispatch({ type: "CLEAR" });
      });

      expect(result.current.layout).toEqual(emptyLayout());
    });
  });
});
