import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { SaveLoadLayout } from "../components/SaveLoadLayout";
import { LayoutProvider, useLayout } from "../context/LayoutContext";
import type { Station } from "../types";

function renderWithProvider(ui: React.ReactElement) {
  return render(<LayoutProvider>{ui}</LayoutProvider>);
}

/** Build a valid Station literal for the current (schema v3) model. */
function makeStation(overrides: Partial<Station> = {}): Station {
  return {
    id: "s1",
    name: "Station A",
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

/** Build a full, valid serialized layout object (schema v3, all arrays). */
function makeLayoutJson(stations: Station[]) {
  return JSON.stringify({
    schema_version: 3,
    sources: [],
    stations,
    buffers: [],
    sinks: [],
    operator_pools: [],
    connections: [],
  });
}

describe("SaveLoadLayout", () => {
  it("renders Save Layout and Load Layout buttons", () => {
    renderWithProvider(<SaveLoadLayout />);
    expect(screen.getByText("Save Layout")).toBeInTheDocument();
    expect(screen.getByText("Load Layout")).toBeInTheDocument();
  });

  it("does not display an error message initially", () => {
    renderWithProvider(<SaveLoadLayout />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("triggers a file download on Save Layout click", () => {
    // Mock URL.createObjectURL and revokeObjectURL
    const mockCreateObjectURL = vi.fn(() => "blob:http://localhost/mock");
    const mockRevokeObjectURL = vi.fn();
    globalThis.URL.createObjectURL = mockCreateObjectURL;
    globalThis.URL.revokeObjectURL = mockRevokeObjectURL;

    // Track clicks on dynamically created anchor elements
    const originalCreateElement = document.createElement.bind(document);
    const clickSpy = vi.fn();
    vi.spyOn(document, "createElement").mockImplementation((tag: string, options?: any) => {
      const el = originalCreateElement(tag, options);
      if (tag === "a") {
        el.click = clickSpy;
      }
      return el;
    });

    renderWithProvider(<SaveLoadLayout />);
    fireEvent.click(screen.getByText("Save Layout"));

    expect(mockCreateObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/mock");

    vi.restoreAllMocks();
  });

  it("opens file input when Load Layout is clicked", () => {
    renderWithProvider(<SaveLoadLayout />);
    const fileInput = screen.getByLabelText("Load layout file") as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, "click");

    fireEvent.click(screen.getByText("Load Layout"));

    expect(clickSpy).toHaveBeenCalled();
  });

  it("loads a valid layout file and dispatches LOAD_LAYOUT", async () => {
    function TestHarness() {
      const { layout } = useLayout();
      return (
        <div>
          <SaveLoadLayout />
          {layout.stations.length > 0 && (
            <span data-testid="station-name">{layout.stations[0].name}</span>
          )}
        </div>
      );
    }

    render(
      <LayoutProvider>
        <TestHarness />
      </LayoutProvider>
    );

    const fileInput = screen.getByLabelText("Load layout file") as HTMLInputElement;
    const file = new File(
      [makeLayoutJson([makeStation({ id: "s1", name: "Station A" })])],
      "layout.json",
      { type: "application/json" }
    );

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByTestId("station-name")).toHaveTextContent("Station A");
    });
  });

  it("shows error message for an unsupported schema_version", async () => {
    renderWithProvider(<SaveLoadLayout />);

    const fileInput = screen.getByLabelText("Load layout file") as HTMLInputElement;
    // schema_version 1 is no longer supported by the current parser.
    const unsupported = JSON.stringify({ schema_version: 1, stations: [], connections: [] });
    const file = new File([unsupported], "bad.json", {
      type: "application/json",
    });

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("shows error for non-JSON content", async () => {
    renderWithProvider(<SaveLoadLayout />);

    const fileInput = screen.getByLabelText("Load layout file") as HTMLInputElement;
    const file = new File(["not json at all"], "broken.json", {
      type: "application/json",
    });

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Invalid JSON syntax");
    });
  });

  it("preserves current layout when load fails", async () => {
    function TestHarness() {
      const { layout, dispatch } = useLayout();
      return (
        <div>
          <SaveLoadLayout />
          <button
            data-testid="add-station"
            onClick={() =>
              dispatch({
                type: "ADD_STATION",
                station: makeStation({ id: "existing", name: "Existing" }),
              })
            }
          >
            Add
          </button>
          <span data-testid="station-count">{layout.stations.length}</span>
        </div>
      );
    }

    render(
      <LayoutProvider>
        <TestHarness />
      </LayoutProvider>
    );

    // Add a station to existing layout
    fireEvent.click(screen.getByTestId("add-station"));
    expect(screen.getByTestId("station-count")).toHaveTextContent("1");

    // Attempt to load an invalid file (missing schema_version)
    const fileInput = screen.getByLabelText("Load layout file") as HTMLInputElement;
    const file = new File(["{}"], "invalid.json", { type: "application/json" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // Layout should still have the existing station
    expect(screen.getByTestId("station-count")).toHaveTextContent("1");
  });

  it("clears error on successful load after previous failure", async () => {
    renderWithProvider(<SaveLoadLayout />);

    const fileInput = screen.getByLabelText("Load layout file") as HTMLInputElement;

    // First: invalid file
    const invalidFile = new File(["bad"], "bad.json", { type: "application/json" });
    fireEvent.change(fileInput, { target: { files: [invalidFile] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    // Second: valid file
    const validFile = new File(
      [makeLayoutJson([makeStation({ id: "s1", name: "Mill", x: 10, y: 20, cycle_time: 5 })])],
      "good.json",
      { type: "application/json" }
    );
    fireEvent.change(fileInput, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});
