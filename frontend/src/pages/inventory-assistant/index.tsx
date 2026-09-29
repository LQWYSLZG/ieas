/**
 * Inventory Management Assistant
 *
 * Tools dashboard for supply chain optimisation including demand forecasting,
 * inventory analysis, customer segmentation, and stock control.
 */

import { useEffect } from "react";
import { asset } from "../../lib/asset";
import { warmUpBackend } from "../../lib/warmup";

export default function InventoryAssistant() {
  // Wake-on-entry: start warming the Render free-tier backend when this
  // assistant is opened. Throttled and fire-and-forget, so it never blocks
  // or breaks the UI.
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
          src={asset("/icons/inventory-assistant.png")}
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
            Inventory Management Assistant
          </h1>
          <p
            style={{
              fontSize: "1rem",
              color: "var(--color-text-secondary, #b0b8c9)",
              margin: "6px 0 0 0",
              lineHeight: 1.5,
            }}
          >
            Forecast demand, optimise stock levels, and reduce waste across your supply chain.
          </p>
        </div>
      </header>

      {/* Spacer between header and tools */}
      <hr
        style={{
          border: "none",
          borderTop: "2px solid #2d6a4f",
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
          {/* ABC Inventory Analysis */}
          <div
            style={{
              padding: "1.8rem",
              background: "var(--color-surface, #1e2a3a)",
              borderRadius: "12px",
              border: "1px solid #2d6a4f", borderTop: "3px solid #2d6a4f",
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
              📊 ABC Inventory Analysis
            </h3>
            <p
              style={{
                color: "var(--color-text-secondary, #b0b8c9)",
                fontSize: "0.95rem",
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              Classify inventory items by value contribution to focus resources on high-impact stock.
            </p>
          </div>

          {/* Customer Segmentation */}
          <div
            style={{
              padding: "1.8rem",
              background: "var(--color-surface, #1e2a3a)",
              borderRadius: "12px",
              border: "1px solid #2d6a4f", borderTop: "3px solid #2d6a4f",
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
              👥 Customer Segmentation
            </h3>
            <p
              style={{
                color: "var(--color-text-secondary, #b0b8c9)",
                fontSize: "0.95rem",
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              Group customers by purchasing behaviour to tailor inventory strategies per segment.
            </p>
          </div>

          {/* Demand Forecast */}
          <div
            style={{
              padding: "1.8rem",
              background: "var(--color-surface, #1e2a3a)",
              borderRadius: "12px",
              border: "1px solid #2d6a4f", borderTop: "3px solid #2d6a4f",
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
              📈 Demand Forecast
            </h3>
            <p
              style={{
                color: "var(--color-text-secondary, #b0b8c9)",
                fontSize: "0.95rem",
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              Predict future demand using historical data to optimise replenishment planning.
            </p>
          </div>

          {/* Demand Health */}
          <div
            style={{
              padding: "1.8rem",
              background: "var(--color-surface, #1e2a3a)",
              borderRadius: "12px",
              border: "1px solid #2d6a4f", borderTop: "3px solid #2d6a4f",
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
              🩺 Demand Health
            </h3>
            <p
              style={{
                color: "var(--color-text-secondary, #b0b8c9)",
                fontSize: "0.95rem",
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              Monitor demand signal quality and detect anomalies that could distort forecasts.
            </p>
          </div>

          {/* Stock Control & Optimisation */}
          <div
            style={{
              padding: "1.8rem",
              background: "var(--color-surface, #1e2a3a)",
              borderRadius: "12px",
              border: "1px solid #2d6a4f", borderTop: "3px solid #2d6a4f",
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
              📦 Stock Control & Optimisation
            </h3>
            <p
              style={{
                color: "var(--color-text-secondary, #b0b8c9)",
                fontSize: "0.95rem",
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              Calculate optimal reorder points, safety stock levels, and EOQ to minimise holding costs.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
