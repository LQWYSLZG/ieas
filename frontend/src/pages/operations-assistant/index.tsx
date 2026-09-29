/**
 * Manufacturing Operations Assistant
 *
 * Tools dashboard for shop-floor optimisation including line balancing,
 * machine diagnostics, and discrete event simulation.
 */

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { asset } from "../../lib/asset";
import { warmUpBackend } from "../../lib/warmup";

export default function OperationsAssistant() {
  // Wake-on-entry: start warming the Render free-tier backend when the
  // operations area is opened so it is ready before the simulator is used.
  // Throttled and fire-and-forget, so it never blocks or breaks the UI.
  useEffect(() => {
    warmUpBackend();
  }, []);

  return (
    <div
      style={{
        padding: "2.5rem",
        color: "var(--color-text-primary, #fff)",
        fontFamily: "var(--font-family, 'Segoe UI', sans-serif)",
        maxWidth: "1200px",
      }}
    >
      {/* App header with icon and name */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1.2rem",
          marginBottom: "0.75rem",
        }}
      >
        <img
          src={asset("/icons/operations-assistant.png")}
          alt=""
          style={{
            width: "56px",
            height: "56px",
            borderRadius: "12px",
          }}
        />
        <div>
          <h1
            style={{
              color: "var(--color-accent, #d4a017)",
              fontSize: "2rem",
              fontWeight: 700,
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            Manufacturing Operations Assistant
          </h1>
          <p
            style={{
              fontSize: "1rem",
              color: "var(--color-text-secondary, #b0b8c9)",
              margin: "6px 0 0 0",
              lineHeight: 1.5,
            }}
          >
            Balance lines, diagnose machines, and eliminate bottlenecks on the shop floor.
          </p>
        </div>
      </header>

      {/* Spacer between header and tools */}
      <hr
        style={{
          border: "none",
          borderTop: "2px solid #2d5a8e",
          margin: "2rem 0 2.5rem 0",
        }}
      />

      {/* Tools section */}
      <section>
        <h2
          style={{
            fontSize: "1.3rem",
            color: "var(--color-text-primary, #fff)",
            marginBottom: "1.2rem",
            fontWeight: 600,
          }}
        >
          Tools
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: "1.2rem",
          }}
        >
          {/* Factory Floor Simulator card */}
          <Link
            to="/operations-assistant/factory-simulator"
            style={{
              display: "block",
              padding: "1.8rem",
              background: "var(--color-surface, #1e2a3a)",
              borderRadius: "12px",
              border: "1px solid #2d5a8e",
              borderTop: "3px solid #2d5a8e",
              textDecoration: "none",
              transition: "border-color 0.2s, transform 0.15s, box-shadow 0.2s",
            }}
            aria-label="Open Factory Floor Simulator"
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--color-accent, #d4a017)";
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--color-border, #2d3b4e)";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            <h3
              style={{
                color: "var(--color-accent, #d4a017)",
                fontSize: "1.15rem",
                fontWeight: 600,
                marginBottom: "0.6rem",
              }}
            >
              🏭 Factory Floor Simulator
            </h3>
            <p
              style={{
                color: "var(--color-text-secondary, #b0b8c9)",
                fontSize: "0.95rem",
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              Design factory layouts, run discrete event simulations, identify
              bottlenecks, and receive optimization recommendations.
            </p>
          </Link>
        </div>
      </section>
    </div>
  );
}
