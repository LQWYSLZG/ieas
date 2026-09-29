import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import React from "react";
import { LayoutProvider, useLayout } from "../context/LayoutContext";
import { PropertiesPanel } from "../components/PropertiesPanel";
import type { Station } from "../types";

/** Build a valid Station literal for the current (schema v3) model. */
function makeStation(overrides: Partial<Station> = {}): Station {
  return {
    id: "s1",
    name: "Test Station",
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

function renderWithProvider(ui: React.ReactElement) {
  return render(<LayoutProvider>{ui}</LayoutProvider>);
}

/** Helper to render panel with a pre-populated station in context. */
function renderPanelWithStation(
  station: Station,
  selectedElementId: string | null
) {
  function TestWrapper() {
    const { dispatch } = useLayout();
    React.useEffect(() => {
      dispatch({ type: "ADD_STATION", station });
    }, []);
    return <PropertiesPanel selectedElementId={selectedElementId} />;
  }
  return render(
    <LayoutProvider>
      <TestWrapper />
    </LayoutProvider>
  );
}

describe("PropertiesPanel", () => {
  it("shows the quick guide when no element is selected", () => {
    renderWithProvider(<PropertiesPanel selectedElementId={null} />);
    expect(screen.getByText("Quick Guide")).toBeInTheDocument();
  });

  it("shows the quick guide when selectedElementId does not match any element", () => {
    renderWithProvider(<PropertiesPanel selectedElementId="nonexistent" />);
    expect(screen.getByText("Quick Guide")).toBeInTheDocument();
  });

  it("displays station fields when a station is selected", () => {
    const station = makeStation({ name: "CNC Mill", cycle_time: 45, num_machines: 3 });
    renderPanelWithStation(station, "s1");

    // Fields are rendered but the <input> elements aren't associated to their
    // <label> via htmlFor, so match on the pre-populated display values.
    expect(screen.getByDisplayValue("CNC Mill")).toBeInTheDocument();
    expect(screen.getByDisplayValue("45")).toBeInTheDocument();
    expect(screen.getByDisplayValue("3")).toBeInTheDocument();
  });

  it("renders a Save and Delete button for a selected station", () => {
    renderPanelWithStation(makeStation(), "s1");
    expect(screen.getByText("Save")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("dispatches UPDATE_ELEMENT on save", () => {
    function TestComponent() {
      const { layout, dispatch } = useLayout();
      React.useEffect(() => {
        dispatch({ type: "ADD_STATION", station: makeStation({ id: "s1", name: "Old" }) });
      }, []);
      return (
        <>
          <PropertiesPanel selectedElementId="s1" />
          <span data-testid="station-name">{layout.stations[0]?.name}</span>
        </>
      );
    }

    render(
      <LayoutProvider>
        <TestComponent />
      </LayoutProvider>
    );

    const nameInput = screen.getByDisplayValue("Old");
    fireEvent.change(nameInput, { target: { value: "Updated" } });
    fireEvent.click(screen.getByText("Save"));

    expect(screen.getByTestId("station-name")).toHaveTextContent("Updated");
  });

  it("updates a numeric station field on save", () => {
    function TestComponent() {
      const { layout, dispatch } = useLayout();
      React.useEffect(() => {
        dispatch({ type: "ADD_STATION", station: makeStation({ id: "s1", cycle_time: 30 }) });
      }, []);
      return (
        <>
          <PropertiesPanel selectedElementId="s1" />
          <span data-testid="cycle-time">{layout.stations[0]?.cycle_time}</span>
        </>
      );
    }

    render(
      <LayoutProvider>
        <TestComponent />
      </LayoutProvider>
    );

    // cycle_time is the only field with the value 30 on the default station.
    const cycleInput = screen.getByDisplayValue("30");
    fireEvent.change(cycleInput, { target: { value: "45" } });
    fireEvent.click(screen.getByText("Save"));

    expect(screen.getByTestId("cycle-time")).toHaveTextContent("45");
  });

  it("dispatches DELETE_ELEMENT on delete", () => {
    function TestComponent() {
      const { layout, dispatch } = useLayout();
      React.useEffect(() => {
        dispatch({ type: "ADD_STATION", station: makeStation({ id: "s1" }) });
      }, []);
      return (
        <>
          <PropertiesPanel selectedElementId="s1" />
          <span data-testid="station-count">{layout.stations.length}</span>
        </>
      );
    }

    render(
      <LayoutProvider>
        <TestComponent />
      </LayoutProvider>
    );

    fireEvent.click(screen.getByText("Delete"));
    expect(screen.getByTestId("station-count")).toHaveTextContent("0");
  });
});
