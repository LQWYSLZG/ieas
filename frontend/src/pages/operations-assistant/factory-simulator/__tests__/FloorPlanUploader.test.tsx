import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { FloorPlanUploader } from "../components/FloorPlanUploader";
import { LayoutProvider, useLayout } from "../context/LayoutContext";

function renderWithProvider(ui: React.ReactElement) {
  return render(<LayoutProvider>{ui}</LayoutProvider>);
}

/** Helper to create a File object. */
function createFile(name: string, sizeBytes: number, type: string): File {
  const content = new Uint8Array(sizeBytes);
  return new File([content], name, { type });
}

/** The floor plan file input is a hidden, aria-hidden <input type="file">. */
function getFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  return input as HTMLInputElement;
}

describe("FloorPlanUploader", () => {
  it("renders a file input accepting image + PDF formats", () => {
    const { container } = renderWithProvider(<FloorPlanUploader />);
    const input = getFileInput(container);
    expect(input).toBeInTheDocument();
    expect(input.type).toBe("file");
    expect(input.accept).toBe(".png,.jpg,.jpeg,.svg,.pdf");
  });

  it("does not show Remove Background button when no floor plan loaded", () => {
    renderWithProvider(<FloorPlanUploader />);
    expect(screen.queryByText("Remove Background")).not.toBeInTheDocument();
  });

  it("shows error for invalid file type", () => {
    const { container } = renderWithProvider(<FloorPlanUploader />);
    const input = getFileInput(container);
    const file = createFile("document.gif", 1024, "image/gif");

    fireEvent.change(input, { target: { files: [file] } });

    expect(
      screen.getByText("Invalid file type. Accepted formats: PNG, JPG, JPEG, SVG, PDF.")
    ).toBeInTheDocument();
  });

  it("shows error for file exceeding 10 MB", () => {
    const { container } = renderWithProvider(<FloorPlanUploader />);
    const input = getFileInput(container);
    const largeFile = createFile("big.png", 11 * 1024 * 1024, "image/png");

    fireEvent.change(input, { target: { files: [largeFile] } });

    expect(
      screen.getByText("File exceeds maximum size of 10 MB.")
    ).toBeInTheDocument();
  });

  it("dispatches SET_FLOOR_PLAN for valid file upload", async () => {
    // We'll use a wrapper that exposes layout state to verify dispatch.
    function TestHarness() {
      const { layout } = useLayout();
      return (
        <div>
          <FloorPlanUploader />
          {layout.floor_plan && (
            <span data-testid="floor-plan-name">{layout.floor_plan.filename}</span>
          )}
        </div>
      );
    }

    const { container } = render(
      <LayoutProvider>
        <TestHarness />
      </LayoutProvider>
    );

    const input = getFileInput(container);
    const validFile = createFile("factory.png", 5000, "image/png");

    // Mock FileReader
    const mockReadAsDataURL = vi.fn();
    const mockFileReader = {
      readAsDataURL: mockReadAsDataURL,
      result: "data:image/png;base64,abc123",
      onload: null as (() => void) | null,
    };
    vi.spyOn(globalThis, "FileReader").mockImplementation(
      () => mockFileReader as unknown as FileReader
    );

    fireEvent.change(input, { target: { files: [validFile] } });

    // Trigger the onload callback
    expect(mockReadAsDataURL).toHaveBeenCalledWith(validFile);
    mockFileReader.onload!();

    await waitFor(() => {
      expect(screen.getByTestId("floor-plan-name")).toHaveTextContent("factory.png");
    });

    vi.restoreAllMocks();
  });

  it("shows Remove Background button when floor plan is loaded and removes on click", async () => {
    function TestHarness() {
      const { layout, dispatch } = useLayout();
      return (
        <div>
          <FloorPlanUploader />
          <button
            data-testid="load-plan"
            onClick={() =>
              dispatch({
                type: "SET_FLOOR_PLAN",
                floorPlan: { filename: "test.png", data_url: "data:image/png;base64,x" },
              })
            }
          >
            Load
          </button>
          {layout.floor_plan && <span data-testid="has-plan">yes</span>}
        </div>
      );
    }

    render(
      <LayoutProvider>
        <TestHarness />
      </LayoutProvider>
    );

    // Initially no remove button
    expect(screen.queryByText("Remove Background")).not.toBeInTheDocument();

    // Simulate loading a floor plan
    fireEvent.click(screen.getByTestId("load-plan"));

    // Now remove button should appear
    await waitFor(() => {
      expect(screen.getByText("Remove Background")).toBeInTheDocument();
    });

    // Click remove
    fireEvent.click(screen.getByText("Remove Background"));

    await waitFor(() => {
      expect(screen.queryByText("Remove Background")).not.toBeInTheDocument();
      expect(screen.queryByTestId("has-plan")).not.toBeInTheDocument();
    });
  });

  it("clears error when a new file is selected", () => {
    const { container } = renderWithProvider(<FloorPlanUploader />);
    const input = getFileInput(container);

    // First upload invalid file
    const invalidFile = createFile("doc.txt", 100, "text/plain");
    fireEvent.change(input, { target: { files: [invalidFile] } });
    expect(
      screen.getByText("Invalid file type. Accepted formats: PNG, JPG, JPEG, SVG, PDF.")
    ).toBeInTheDocument();

    // Upload another file (valid or not) clears the old error
    const anotherInvalid = createFile("large.png", 11 * 1024 * 1024, "image/png");
    fireEvent.change(input, { target: { files: [anotherInvalid] } });

    // The old error is gone, new error appears
    expect(
      screen.queryByText("Invalid file type. Accepted formats: PNG, JPG, JPEG, SVG, PDF.")
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("File exceeds maximum size of 10 MB.")
    ).toBeInTheDocument();
  });
});
