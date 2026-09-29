import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { StationPalette } from "../components/StationPalette";
import { LayoutProvider, useLayout } from "../context/LayoutContext";

// Mock crypto.randomUUID for deterministic tests.
vi.stubGlobal("crypto", {
  randomUUID: vi.fn(() => "test-uuid-1234"),
});

function renderWithProvider(ui: React.ReactElement) {
  return render(<LayoutProvider>{ui}</LayoutProvider>);
}

describe("ElementPalette (StationPalette)", () => {
  it("renders the palette with the floor element templates", () => {
    renderWithProvider(<StationPalette />);

    expect(screen.getByText("Floor Elements")).toBeInTheDocument();
    expect(screen.getByText("Material Input")).toBeInTheDocument();
    expect(screen.getByText("Workstation")).toBeInTheDocument();
    expect(screen.getByText("Buffer Zone")).toBeInTheDocument();
    expect(screen.getByText("Finished Goods")).toBeInTheDocument();
  });

  it("adds a station to the layout when the Workstation button is clicked", () => {
    function TestHarness() {
      return (
        <LayoutProvider>
          <StationPalette />
          <StationCount />
        </LayoutProvider>
      );
    }

    function StationCount() {
      const { layout } = useLayout();
      return <div data-testid="count">{layout.stations.length}</div>;
    }

    render(<TestHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Add Workstation" }));

    expect(screen.getByTestId("count")).toHaveTextContent("1");
  });

  it("creates a station with the current default properties", () => {
    function TestHarness() {
      return (
        <LayoutProvider>
          <StationPalette />
          <StationDetails />
        </LayoutProvider>
      );
    }

    function StationDetails() {
      const { layout } = useLayout();
      if (layout.stations.length === 0) return <div data-testid="details">none</div>;
      const s = layout.stations[0];
      return (
        <div data-testid="details">
          {s.cycle_time},{s.num_machines},{s.operators_required},{s.element_type},{s.name}
        </div>
      );
    }

    render(<TestHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Add Workstation" }));

    expect(screen.getByTestId("details")).toHaveTextContent("30,1,1,station,Workstation 1");
  });

  it("adds each element type to its own layout array", () => {
    function TestHarness() {
      return (
        <LayoutProvider>
          <StationPalette />
          <Counts />
        </LayoutProvider>
      );
    }

    function Counts() {
      const { layout } = useLayout();
      return (
        <div data-testid="counts">
          {layout.sources.length},{layout.stations.length},{layout.buffers.length},{layout.sinks.length}
        </div>
      );
    }

    render(<TestHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Add Material Input" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Workstation" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Buffer Zone" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Finished Goods" }));

    // one of each: sources, stations, buffers, sinks
    expect(screen.getByTestId("counts")).toHaveTextContent("1,1,1,1");
  });

  it("names sequential workstations incrementally", () => {
    function TestHarness() {
      return (
        <LayoutProvider>
          <StationPalette />
          <StationNames />
        </LayoutProvider>
      );
    }

    function StationNames() {
      const { layout } = useLayout();
      return <div data-testid="names">{layout.stations.map((s) => s.name).join(",")}</div>;
    }

    render(<TestHarness />);

    const addWorkstation = screen.getByRole("button", { name: "Add Workstation" });
    fireEvent.click(addWorkstation);
    fireEvent.click(addWorkstation);

    expect(screen.getByTestId("names")).toHaveTextContent("Workstation 1,Workstation 2");
  });
});
