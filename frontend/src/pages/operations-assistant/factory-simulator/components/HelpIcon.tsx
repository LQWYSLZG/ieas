/**
 * HelpIcon: Reusable help tooltip component.
 * Shows a small circled "?" that displays a tooltip on hover.
 * Uses fixed positioning so tooltip is never clipped.
 * Clicking does nothing (events are stopped from propagating).
 */

import { useState } from "react";

export function HelpTooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  function handleEnter(e: React.MouseEvent<HTMLSpanElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    // Position above the icon, but check if too close to top of viewport
    let topPos = rect.top - 8;
    if (topPos < 100) {
      // Show below instead
      topPos = rect.bottom + 8;
    }
    setPos({ x: rect.left + rect.width / 2, y: topPos });
    setShow(true);
  }

  function handleClick(e: React.MouseEvent) {
    // Prevent click from doing anything (don't trigger parent buttons)
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <span
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={handleEnter}
      onMouseLeave={() => setShow(false)}
      onClick={handleClick}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
      {show && (
        <span style={{
          position: "fixed",
          top: pos.y < 100 ? pos.y : undefined,
          bottom: pos.y >= 100 ? `calc(100vh - ${pos.y}px)` : undefined,
          left: Math.min(pos.x, window.innerWidth - 240),
          transform: pos.y < 100 ? "translateX(-50%)" : "translate(-50%, 0)",
          background: "#0e1428",
          border: "1px solid #3d4aae",
          borderRadius: "6px",
          padding: "8px 10px",
          fontSize: "0.75rem",
          fontFamily: "'Segoe UI', sans-serif",
          fontWeight: 400,
          fontStyle: "normal",
          textTransform: "none" as const,
          letterSpacing: "normal",
          color: "#e0e8f0",
          lineHeight: 1.4,
          width: "210px",
          zIndex: 99999,
          boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
          pointerEvents: "none" as const,
        }}>
          {text}
        </span>
      )}
    </span>
  );
}

export function HelpIcon({ text }: { text: string }) {
  return (
    <HelpTooltip text={text}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "13px",
          height: "13px",
          borderRadius: "50%",
          background: "rgba(168, 184, 232, 0.12)",
          border: "1px solid rgba(168, 184, 232, 0.25)",
          color: "#8898c8",
          fontSize: "0.55rem",
          fontWeight: 700,
          cursor: "help",
          marginLeft: "4px",
          flexShrink: 0,
          userSelect: "none",
        }}
      >?</span>
    </HelpTooltip>
  );
}
