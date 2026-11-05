import { useEffect, useRef } from "react";

export function CircuitBoard() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const board = ref.current;
    const host = board?.parentElement;
    if (!board || !host) return;
    const motion = window.matchMedia("(prefers-reduced-motion: no-preference)");
    function energize(event: PointerEvent) {
      if (!board || !motion.matches) return;
      const bounds = board.getBoundingClientRect();
      board.style.setProperty("--circuit-x", (event.clientX - bounds.left) + "px");
      board.style.setProperty("--circuit-y", (event.clientY - bounds.top) + "px");
      board.dataset.powered = "true";
    }
    function rest() { board?.removeAttribute("data-powered"); }
    host.addEventListener("pointermove", energize, { passive: true });
    host.addEventListener("pointerdown", energize, { passive: true });
    host.addEventListener("pointerleave", rest);
    host.addEventListener("pointercancel", rest);
    return () => {
      host.removeEventListener("pointermove", energize);
      host.removeEventListener("pointerdown", energize);
      host.removeEventListener("pointerleave", rest);
      host.removeEventListener("pointercancel", rest);
    };
  }, []);
  return <div ref={ref} className="circuit-board" aria-hidden="true"><i /></div>;
}
