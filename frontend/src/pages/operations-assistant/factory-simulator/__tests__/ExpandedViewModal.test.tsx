/**
 * Component tests for ExpandedViewModal (task 9.3).
 *
 * Using @testing-library/react with the existing jsdom setup, these assert the
 * primary overlay behavior:
 *   - the Close_Control dismisses and restores focus to the trigger (Reqs 2.1, 2.2);
 *   - Escape dismisses and restores focus to the trigger (Reqs 2.3, 9.5);
 *   - backdrop activation dismisses (per design);
 *   - focus moves to the first interactive element on open (Req 9.3);
 *   - Tab and Shift+Tab stay inside the overlay (Req 9.4);
 *   - the container fallback receives focus when the trigger is gone (Req 2.5);
 *   - the Close_Control exposes an accessible name that names the action (Reqs 2.1, 9.6).
 *
 * Project rule: no em dashes or en dashes anywhere, only ASCII hyphens.
 */

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import React from "react";
import { ExpandedViewModal } from "../components/ExpandedViewModal";

afterEach(() => {
  cleanup();
});

/**
 * Render the modal with a real trigger button mounted in the document so focus
 * restore can target it. Returns the trigger element and the onClose spy.
 */
function renderModal(
  props: Partial<React.ComponentProps<typeof ExpandedViewModal>> = {}
) {
  const onClose = props.onClose ?? vi.fn();

  // A real trigger button outside the overlay. It is the element focus should
  // return to on close (Reqs 2.2, 9.5).
  const trigger = document.createElement("button");
  trigger.textContent = "Expand";
  trigger.setAttribute("data-testid", "trigger");
  document.body.appendChild(trigger);

  const utils = render(
    <ExpandedViewModal
      isOpen={props.isOpen ?? true}
      title={props.title ?? "Results, expanded view"}
      onClose={onClose}
      triggerElement={props.triggerElement ?? trigger}
    >
      {props.children ?? (
        <div>
          <button type="button">First inner</button>
          <a href="#link">A link</a>
          <button type="button">Last inner</button>
        </div>
      )}
    </ExpandedViewModal>
  );

  return { ...utils, onClose, trigger };
}

describe("ExpandedViewModal", () => {
  it("renders a dialog labelled by the title", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Results, expanded view");
  });

  it("renders nothing when isOpen is false", () => {
    renderModal({ isOpen: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("exposes a Close_Control with an accessible name naming the action", () => {
    renderModal();
    const close = screen.getByRole("button", { name: /close expanded view/i });
    expect(close).toBeInTheDocument();
    // The close control is keyboard focusable (a native button).
    close.focus();
    expect(close).toHaveFocus();
  });

  it("moves focus to the first interactive element on open", () => {
    renderModal();
    // The first interactive element in DOM order is the Close_Control in the
    // sticky header (it precedes the scrollable content), so focus lands there
    // on open (Req 9.3). This keeps the close affordance reachable immediately.
    const close = screen.getByRole("button", { name: /close expanded view/i });
    expect(close).toHaveFocus();
  });

  it("falls back to the Close_Control for initial focus when no other interactive element exists", () => {
    renderModal({ children: <p>No interactive content here</p> });
    const close = screen.getByRole("button", { name: /close expanded view/i });
    expect(close).toHaveFocus();
  });

  it("dismisses and restores focus to the trigger when the Close_Control is activated", () => {
    const { onClose, trigger } = renderModal();
    const close = screen.getByRole("button", { name: /close expanded view/i });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });

  it("dismisses and restores focus to the trigger when Escape is pressed", () => {
    const { onClose, trigger } = renderModal();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });

  it("dismisses when the backdrop is activated", () => {
    const { onClose } = renderModal();
    const dialog = screen.getByRole("dialog");
    // The overlay backdrop is the parent of the dialog container.
    const overlay = dialog.parentElement as HTMLElement;
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss when a mousedown originates inside the dialog", () => {
    const { onClose } = renderModal();
    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("wraps Tab from the last focusable element back to the first", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    const last = screen.getByRole("button", { name: "Last inner" });
    last.focus();
    expect(last).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Tab" });

    const close = screen.getByRole("button", { name: /close expanded view/i });
    // The first focusable element is the Close_Control in the header.
    expect(close).toHaveFocus();
  });

  it("wraps Shift+Tab from the first focusable element back to the last", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: /close expanded view/i });
    close.focus();
    expect(close).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });

    const last = screen.getByRole("button", { name: "Last inner" });
    expect(last).toHaveFocus();
  });

  it("moves focus to the dialog container fallback when the trigger is gone on close", () => {
    const onClose = vi.fn();

    // A trigger that we will remove from the document before closing (Req 2.5).
    const trigger = document.createElement("button");
    trigger.textContent = "Expand";
    document.body.appendChild(trigger);

    render(
      <ExpandedViewModal
        isOpen
        title="Results, expanded view"
        onClose={onClose}
        triggerElement={trigger}
      >
        <button type="button">Inner</button>
      </ExpandedViewModal>
    );

    // Simulate the trigger leaving the document (for example a stage change).
    trigger.remove();

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    // Focus is not lost: it lands on the overlay-owner dialog container.
    expect(dialog).toHaveFocus();
  });
});
