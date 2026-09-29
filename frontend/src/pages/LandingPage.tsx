/**
 * LandingPage — Exact match to the old Streamlit home page.
 * Buttons are OUTSIDE and BELOW the cards (separate elements), same as the old app.
 */

import { Link } from "react-router-dom";
import { appRegistry, getSortedRegistry, AppModuleConfig } from "../config/appRegistry";
import { asset } from "../lib/asset";

export function LandingPage() {
  const apps = getSortedRegistry(appRegistry);

  return (
    <div className="landing-page">
      {/* Header — gradient with icon + title on same line */}
      <header className="landing-header">
        <div className="landing-header-row">
          <img
            className="landing-header-icon"
            src={asset("/icons/suite-icon.png")}
            alt="Industrial Engineering Assistant Suite icon"
          />
          <h1 className="landing-title">Industrial Engineering Assistant Suite</h1>
        </div>
        <p className="landing-tagline">
          INVENTORY · PRODUCTION · OPERATIONS · QUALITY
        </p>
        <p className="landing-subtitle">BUILT FOR ENGINEERS</p>
      </header>

      {/* Hierarchy Bar */}
      <div className="landing-hierarchy-bar">
        Each assistant targets a different layer of your operation. Select where you need it most to get started.
      </div>

      {/* 4-column Card Grid */}
      <div className="landing-grid">
        {apps.map((app) =>
          app.status === "active" ? (
            <ActiveCardWithButton key={app.id} app={app} />
          ) : (
            <PlannedCardSlot key={app.id} app={app} />
          )
        )}
      </div>

      {/* Footer */}
      <footer className="landing-footer">
        © 2026 FORGEYI · Industrial Engineering Assistant Suite · Data is not stored or shared
      </footer>
    </div>
  );
}

/** Active card + button below it (button is outside the card) */
function ActiveCardWithButton({ app }: { app: AppModuleConfig }) {
  return (
    <div className="landing-card-slot">
      <article className="landing-card landing-card--active">
        <h3 className="landing-card-name">
          <img
            className="landing-card-title-icon"
            src={asset(app.icon)}
            alt=""
          />
          {app.displayName}
        </h3>
        <p className="landing-card-tagline">{app.tagline}</p>
        <p className="landing-card-features-text">
          {app.features.map((feature, i) => (
            <span key={i}>✦ {feature}<br /></span>
          ))}
        </p>
      </article>
      <div className="landing-card-btn-wrapper">
        <Link to={app.routePath} className="landing-card-nav-btn">
          Open {app.displayName} →
        </Link>
      </div>
    </div>
  );
}

/** Planned card (no button) */
function PlannedCardSlot({ app }: { app: AppModuleConfig }) {
  return (
    <div className="landing-card-slot">
      <article className="landing-card landing-card--planned">
        <h3 className="landing-card-name">🔒 {app.displayName}</h3>
        <span className="landing-card-badge">COMING SOON</span>
      </article>
    </div>
  );
}
