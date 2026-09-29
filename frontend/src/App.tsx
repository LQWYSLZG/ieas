/**
 * Suite_Shell — Top-level layout for the IE Suite.
 *
 * Uses a full-width layout with a sliding overlay sidebar panel
 * (hidden by default, slides in from the left edge via a small tab toggle).
 * Matches the original Streamlit app's visual design.
 */

import { useState, useCallback, useRef } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import "./styles/theme.css";

export function SuiteShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const mainRef = useRef<HTMLElement>(null);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      setAnnouncement(next ? "Navigation expanded" : "Navigation collapsed");
      return next;
    });
  }, []);

  const handleSkipNav = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement> | React.KeyboardEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      mainRef.current?.focus();
    },
    []
  );

  return (
    <div className="suite-shell">
      {/* Skip-navigation link */}
      <a
        href="#main-content"
        className="suite-skip-nav"
        onClick={handleSkipNav}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSkipNav(e);
        }}
      >
        Skip to main content
      </a>

      {/* ARIA live region */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="suite-sr-only"
        role="status"
      >
        {announcement}
      </div>

      {/* Sidebar tab toggle — always visible on left edge */}
      <button
        className={`sidebar-tab ${sidebarOpen ? "sidebar-tab--open" : ""}`}
        onClick={toggleSidebar}
        aria-expanded={sidebarOpen}
        aria-controls="suite-sidebar"
        aria-label={sidebarOpen ? "Close navigation" : "Open navigation"}
        type="button"
      >
        ☰
      </button>

      {/* Sliding sidebar panel */}
      <nav
        id="suite-sidebar"
        className={`sidebar-panel ${sidebarOpen ? "sidebar-panel--open" : ""}`}
        aria-label="Suite navigation"
      >
        <Sidebar onNavigate={() => setSidebarOpen(false)} />
      </nav>

      {/* Main content — full width */}
      <main
        id="main-content"
        ref={mainRef}
        className="suite-main"
        tabIndex={-1}
      >
        <Outlet />
      </main>
    </div>
  );
}

export default SuiteShell;
