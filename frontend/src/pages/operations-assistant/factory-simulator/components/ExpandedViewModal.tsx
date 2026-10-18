/**
 * ExpandedViewModal - the generic, content-agnostic overlay shell for the
 * Factory Floor Simulator expanded views.
 *
 * This component owns the overlay shell, the Close_Control, Escape handling,
 * the focus trap, and focus restore. It knows nothing about charts or results;
 * it renders whatever panel is handed to it as children (Reqs 1, 2, 9).
 *
 * Behavior implemented here:
 *   - role="dialog" aria-modal="true" container with aria-labelledby pointing
 *     at the title (Req 1.5).
 *   - a keyboard-focusable Close_Control whose accessible name names the close
 *     action (Reqs 2.1, 9.6).
 *   - Escape key handling that calls onClose (Reqs 2.3, 9.5).
 *   - a focus trap that wraps Tab and Shift+Tab at the edges so focus stays
 *     inside the overlay until it is closed (Req 9.4).
 *   - initial focus to the first interactive element on open (Req 9.3).
 *   - focus restore to triggerElement on close, with the overlay-owner
 *     container fallback when the trigger is gone (Reqs 2.2, 2.5).
 *   - a vertical scroll region for tall content (Req 4.4).
 *   - backdrop activation dismisses (per design).
 *
 * The pattern mirrors the hand-rolled restart confirmation dialog already in
 * FactorySimulatorPage.tsx (role="dialog" aria-modal="true"), avoiding a new
 * dependency.
 *
 * Project rule: no em dashes or en dashes anywhere, only ASCII hyphens.
 */

import { useCallback, useEffect, useId, useRef } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import "./ExpandedView.css";

export interface ExpandedViewModalProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  triggerElement: HTMLElement | null;
  children: ReactNode;
}

// Selector for the elements that can hold keyboard focus inside the overlay.
// Used by the focus trap and the initial-focus logic.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  // Keep elements that are not explicitly hidden. We deliberately avoid a
  // layout-dimension check (offsetWidth / getClientRects) because that is
  // unreliable in jsdom, where elements report zero size, and it is not needed:
  // the disabled, hidden, and aria-hidden filters cover the real cases.
  return Array.from(nodes).filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    // Skip elements inside a hidden ancestor (the hidden attribute or
    // display:none). closest("[hidden]") catches the attribute case.
    if (el.closest("[hidden]")) return false;
    return true;
  });
}

export function ExpandedViewModal({
  isOpen,
  title,
  onClose,
  triggerElement,
  children,
}: ExpandedViewModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  // Restore focus to the trigger on close, falling back to the dialog-owner
  // container when the trigger is no longer in the document (Reqs 2.2, 2.5).
  const restoreFocus = useCallback(() => {
    if (triggerElement && triggerElement.isConnected) {
      triggerElement.focus();
      return;
    }
    // Trigger is gone: fall back to the overlay-owner container so focus is
    // never lost (Req 2.5). The dialog container carries tabIndex={-1} so it
    // can receive programmatic focus.
    const dialog = dialogRef.current;
    if (dialog && dialog.isConnected) {
      dialog.focus();
    }
  }, [triggerElement]);

  // Move initial focus to the first interactive element on open (Req 9.3).
  useEffect(() => {
    if (!isOpen) return;
    const focusables = getFocusable(dialogRef.current);
    const first = focusables[0] ?? closeButtonRef.current;
    if (first) {
      first.focus();
    } else if (dialogRef.current) {
      dialogRef.current.focus();
    }
    // We intentionally run this only when the overlay opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  // Close the overlay and restore focus. Shared by the Close_Control, Escape,
  // and backdrop activation.
  const handleClose = () => {
    restoreFocus();
    onClose();
  };

  // Escape dismisses (Reqs 2.3, 9.5). Tab / Shift+Tab wrap at the edges so
  // focus stays inside the overlay (Req 9.4).
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      handleClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusables = getFocusable(dialogRef.current);
    if (focusables.length === 0) {
      // Nothing focusable other than the container: keep focus on the dialog.
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey) {
      // Shift+Tab from the first element wraps to the last.
      if (active === first || !dialogRef.current?.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else {
      // Tab from the last element wraps to the first.
      if (active === last || !dialogRef.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  // Backdrop activation dismisses (per design). Only a direct click on the
  // overlay backdrop (not a bubbled click from inside the dialog) closes it.
  const handleOverlayMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      handleClose();
    }
  };

  return (
    <div
      className="expanded-view-overlay"
      onMouseDown={handleOverlayMouseDown}
    >
      <div
        ref={dialogRef}
        className="expanded-view-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="expanded-view-header">
          <h2 id={titleId} className="expanded-view-title">
            {title}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="expanded-view-close"
            aria-label="Close expanded view"
            onClick={handleClose}
          >
            <span aria-hidden="true">x</span>
            <span>Close</span>
          </button>
        </div>
        <div className="expanded-view-scroll">
          <div className="expanded-view-content">{children}</div>
        </div>
      </div>
    </div>
  );
}

export default ExpandedViewModal;
