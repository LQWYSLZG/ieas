import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React from "react";
import SimulatorCanvas from "../components/SimulatorCanvas";
import { LayoutProvider, useLayout } from "../context/LayoutContext";
import type { Station } from "../types";

// Mock react-konva since it requires a canvas rendering context not available in jsdom.
vi.mock("react-konva", () => {
  const Stage = ({
    children,
    width,
    height,
    onClick,
    style,
  }: {
    children?: React.ReactNode;
    width?: number;
    height?: number;
    onClick?: (e: unknown) => void;
    onTap?: (e: unknown) => void;
    style?: React.CSSProperties;
    [key: string]: unknown;
  }) => (
    <div
      data-testid="konva-stage"
      data-width={width}
      data-height={height}
      style={style}
      onClick={() => {
        if (onClick) {
          // Simulate clicking on the stage itself (empty area). The handler
          // checks `e.target === e.target.getStage()` and `e.evt.button`.
          const fakeTarget = { attrs: { id: "stage" }, getStage: () => fakeTarget };
          onClick({ target: fakeTarget, evt: { button: 0 } });
        }
      }}
    >
      {children}
    </div>
  );

  const Layer = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="konva-layer">{children}</div>
  );

  const Rect = (props: Record<string, unknown>) => (
    <div
      data-testid="konva-rect"
      data-id={props.id as string}
      data-width={props.width as number}
      data-height={props.height as number}
    />
  );

  const Group = (props: Record<string, unknown>) => (
    <div
      data-testid="konva-group"
      data-id={props.id as string}
      data-draggable={String(props.draggable)}
      onClick={() => {
        if (typeof props.onClick === "function") {
          // Left-click on the element group.
          (props.onClick as (e: unknown) => void)({ evt: { button: 0 } });
        }
      }}
    >
      {props.children as React.ReactNode}
    </div>
  );

  const Circle = (props: Record<string, unknown>) => (
    <div data-testid="konva-circle" data-draggable={String(props.draggable)} />
  );

  const Arrow = () => <div data-testid="konva-arrow" />;
  const Line = () => <div data-testid="konva-line" />;

  const Text = (props: Record<string, unknown>) => (
    <div data-testid="konva-text" data-text={String(props.text)} />
  );

  const Image = () => <div data-testid="konva-image" />;

  return { Stage, Layer, Rect, Group, Circle, Arrow, Line, Text, Image };
});

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

/** Helper component that dispatches a station then renders SimulatorCanvas. */
function CanvasWithStation(props: {
  isSimulating: boolean;
  selectedElementId?: string | null;
  onSelectElement?: (id: string | null) => void;
}) {
  const { dispatch } = useLayout();

  React.useEffect(() => {
    dispatch({ type: "ADD_STATION", station: makeStation({ id: "s1" }) });
  }, [dispatch]);

  return (
    <SimulatorCanvas
      isSimulating={props.isSimulating}
      simulationResults={null}
      selectedElementId={props.selectedElementId ?? null}
      onSelectElement={props.onSelectElement ?? vi.fn()}
      targetThroughput={100}
    />
  );
}

describe("SimulatorCanvas", () => {
  const defaultProps = {
    isSimulating: false,
    simulationResults: null,
    selectedElementId: null,
    onSelectElement: vi.fn(),
    targetThroughput: 100,
  };

  it("sizes the Konva Stage to its container (default before measurement)", () => {
    const { getByTestId } = renderWithProvider(
      <SimulatorCanvas {...defaultProps} />
    );

    // The Stage now fills its wrapper via a ResizeObserver. In jsdom the
    // wrapper has no layout size, so the Stage keeps its default fallback size.
    const stage = getByTestId("konva-stage");
    expect(stage).toHaveAttribute("data-width", "800");
    expect(stage).toHaveAttribute("data-height", "780");
  });

  it("renders the base Konva Layers (background, connections, elements)", () => {
    const { getAllByTestId } = renderWithProvider(
      <SimulatorCanvas {...defaultProps} />
    );

    const layers = getAllByTestId("konva-layer");
    // Background, connections, and elements layers are always present.
    expect(layers.length).toBeGreaterThanOrEqual(3);
  });

  it("renders a background rect for canvas fill", () => {
    const { getAllByTestId } = renderWithProvider(
      <SimulatorCanvas {...defaultProps} />
    );

    const rects = getAllByTestId("konva-rect");
    const bg = rects.find((r) => r.getAttribute("data-id") === "canvas-bg");
    expect(bg).toBeDefined();
    // The background is a large pannable board so the infinite canvas has a floor.
    expect(bg).toHaveAttribute("data-width", "4000");
    expect(bg).toHaveAttribute("data-height", "3000");
  });

  it("calls onSelectElement(null) when clicking on empty stage area", () => {
    const onSelectElement = vi.fn();
    const { getByTestId } = renderWithProvider(
      <SimulatorCanvas {...defaultProps} onSelectElement={onSelectElement} />
    );

    const stage = getByTestId("konva-stage");
    stage.click();

    expect(onSelectElement).toHaveBeenCalledWith(null);
  });

  it("disables element dragging when isSimulating is true", () => {
    const { getAllByTestId } = render(
      <LayoutProvider>
        <CanvasWithStation isSimulating={true} />
      </LayoutProvider>
    );

    const groups = getAllByTestId("konva-group");
    expect(groups.length).toBeGreaterThan(0);
    groups.forEach((group) => {
      expect(group).toHaveAttribute("data-draggable", "false");
    });
  });

  it("enables element dragging when isSimulating is false", () => {
    const { getAllByTestId } = render(
      <LayoutProvider>
        <CanvasWithStation isSimulating={false} />
      </LayoutProvider>
    );

    const groups = getAllByTestId("konva-group");
    expect(groups.length).toBeGreaterThan(0);
    groups.forEach((group) => {
      expect(group).toHaveAttribute("data-draggable", "true");
    });
  });

  it("does not render floor plan image when no floor_plan is set", () => {
    const { queryByTestId } = renderWithProvider(
      <SimulatorCanvas {...defaultProps} />
    );

    // No konva-image should be rendered since layout has no floor_plan.
    expect(queryByTestId("konva-image")).toBeNull();
  });

  it("prevents element selection when isSimulating is true", () => {
    const onSelectElement = vi.fn();
    const { getAllByTestId } = render(
      <LayoutProvider>
        <CanvasWithStation isSimulating={true} onSelectElement={onSelectElement} />
      </LayoutProvider>
    );

    const groups = getAllByTestId("konva-group");
    groups[0].click();

    // When simulating, the element onClick should not select an element id.
    // It may be called with null via the stage deselect handler, but never with an id.
    const idCalls = onSelectElement.mock.calls.filter(
      (call: unknown[]) => call[0] !== null
    );
    expect(idCalls).toHaveLength(0);
  });

  it("selects an element when clicking on it and not simulating", () => {
    const onSelectElement = vi.fn();
    const { getAllByTestId } = render(
      <LayoutProvider>
        <CanvasWithStation isSimulating={false} onSelectElement={onSelectElement} />
      </LayoutProvider>
    );

    const groups = getAllByTestId("konva-group");
    groups[0].click();

    expect(onSelectElement).toHaveBeenCalledWith("s1");
  });

  it("applies not-allowed cursor style when simulating", () => {
    const { getByTestId } = renderWithProvider(
      <SimulatorCanvas {...{ ...defaultProps, isSimulating: true }} />
    );

    const stage = getByTestId("konva-stage");
    expect(stage.style.cursor).toBe("not-allowed");
  });

  it("applies a grab cursor style when not simulating (pan-ready)", () => {
    const { getByTestId } = renderWithProvider(
      <SimulatorCanvas {...defaultProps} />
    );

    // The empty canvas is now pan-ready, so the idle cursor is the grab hand.
    const stage = getByTestId("konva-stage");
    expect(stage.style.cursor).toBe("grab");
  });
});
