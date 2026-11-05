import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { appRegistry, getSortedRegistry } from "../config/appRegistry";
import { warmUpBackend } from "../lib/warmup";

import { gsap } from "gsap";
import { CategoryPlate } from "./CategoryPlate";

import { CircuitBoard } from "../components/CircuitBoard";
import { asset } from "../lib/asset";
const categories: Record<string, { summary: string }> = {
  "inventory-assistant": { summary: "Manage stock and demand across your supply chain." },
  "operations-assistant": { summary: "Understand and improve how your factory floor runs." },
  "production-assistant": { summary: "Coordinate production schedules, capacity, and materials." },
  "quality-assistant": { summary: "Assess product quality and process consistency." },
};

export function LandingPage() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const motion = gsap.matchMedia();
    motion.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from(".plate-object", { y: 7, duration: .42, stagger: .06, ease: "power2.out" });
    }, root);
    return () => motion.revert();
  }, []);
  useEffect(() => { warmUpBackend(); }, []);

  return (
    <div className="suite-home" ref={root}>
      <CircuitBoard />
      <section className="directory" aria-labelledby="directory-title">
        <header className="directory-heading">
          <h1 id="directory-title">Industrial Engineering Assistant Suite</h1>
          <p>BUILT FOR ENGINEERS</p>
        </header>
        <div className="directory-grid">
          {getSortedRegistry(appRegistry).map(app => {
            const category = categories[app.id];
            const title = app.displayName.replace(/ Assistant$/, "");
            const active = app.status === "active";
            const content = <>
              <div className="plate-wrap"><CategoryPlate id={app.id} /></div>
              <h2><img src={asset(app.icon)} alt="" />{title}</h2>
              <p>{category?.summary ?? app.description}</p>
              <span className="directory-action">{active ? "OPEN APP" : "COMING SOON"}</span>
            </>;
            return active
              ? <Link className="directory-card" key={app.id} to={app.routePath} aria-label={`Open ${title}`}>{content}</Link>
              : <article key={app.id} className="directory-card planned">{content}</article>;
          })}
        </div>
      </section>
      <footer className="exhibit-footer">© 2026 FORGEYI · Industrial Engineering Assistant Suite · Data is not stored or shared</footer>
    </div>
  );
}
