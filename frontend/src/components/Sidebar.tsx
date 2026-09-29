/**
 * Sidebar — Navigation panel for the IE Suite.
 * Uses appRegistry for consistent naming across the app.
 */

import { NavLink, useLocation } from "react-router-dom";
import {
  appRegistry,
  getSortedRegistry,
} from "../config/appRegistry";
import { asset } from "../lib/asset";

export interface SidebarProps {
  onNavigate: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  const location = useLocation();
  const sortedModules = getSortedRegistry(appRegistry);

  const activeModules = sortedModules.filter((m) => m.status === "active");
  const plannedModules = sortedModules.filter((m) => m.status === "planned");

  return (
    <>
      {/* Suite icon — clickable, navigates to home */}
      <div className="sidebar-icon-home">
        <NavLink to="/" onClick={onNavigate}>
          <img
            src={asset("/icons/suite-icon.png")}
            alt="IE Suite Home"
            className="sidebar-suite-icon"
          />
        </NavLink>
      </div>

      {/* Section: APP MENU */}
      <div className="sidebar-section-label">APP MENU</div>

      {activeModules.map((module) => (
        <NavLink
          key={module.id}
          to={module.routePath}
          className={`sidebar-nav-link ${
            location.pathname.startsWith(module.routePath)
              ? "sidebar-nav-link--current"
              : ""
          }`}
          onClick={onNavigate}
        >
          <img
            src={asset(module.icon)}
            alt=""
            className="sidebar-link-icon"
          />
          {module.displayName.replace(" Assistant", "")}
        </NavLink>
      ))}

      <hr className="sidebar-separator" />

      {/* Section: Coming Soon */}
      <div className="sidebar-section-label">Coming Soon</div>

      {plannedModules.map((module) => (
        <div className="sidebar-coming-item" key={module.id}>
          🔒 {module.displayName.replace(" Assistant", "")}
        </div>
      ))}

      {/* Footer */}
      <div className="sidebar-footer">© 2026 FORGEYI</div>
    </>
  );
}

export default Sidebar;
