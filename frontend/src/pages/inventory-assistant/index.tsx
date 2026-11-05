import { useEffect } from "react";
import { AssistantHeader } from "../../components/AssistantHeader";
import { warmUpBackend } from "../../lib/warmup";

const tools = [
  { name: "ABC Inventory Analysis", description: "Classify inventory items by value contribution to focus resources on high-impact stock.", path: "M4 20V12h4v8m2 0V8h4v12m2 0V4h4v16" },
  { name: "Customer Segmentation", description: "Group customers by purchasing behaviour to tailor inventory strategies per segment.", path: "M9 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6m8 2a3 3 0 1 0 0-6 3 3 0 0 0 0 6M3 21v-5a6 6 0 0 1 12 0v5m2-8q4 0 4 5v3" },
  { name: "Demand Forecast", description: "Predict future demand using historical data to optimise replenishment planning.", path: "M3 3v18h18M6 16l4-5 4 2 6-8m-5 0h5v5" },
  { name: "Demand Health", description: "Monitor demand signal quality and detect anomalies that could distort forecasts.", path: "M2 12h5l3-7 4 14 3-7h5" },
  { name: "Stock Control & Optimisation", description: "Calculate optimal reorder points, safety stock levels, and EOQ to minimise holding costs.", path: "m3 7 9-4 9 4-9 5zM3 7v11l9 4 9-4V7M12 12v10" },
];

export default function InventoryAssistant() {
  useEffect(() => { warmUpBackend(); }, []);
  return <div className="assistant-page assistant-inventory">
    <AssistantHeader icon="/icons/inventory-assistant.png" title="Inventory Management Assistant" />
    <section aria-labelledby="inventory-tools">
      <div className="assistant-section-heading"><h2 id="inventory-tools">YOUR SUPPLY CHAIN TOOLKIT</h2></div>
      <div className="assistant-tool-grid">
        {tools.map(tool => <article className="assistant-tool" key={tool.name}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={tool.path} /></svg>
          <h3>{tool.name}</h3><p>{tool.description}</p>
        </article>)}
      </div>
    </section>
    <footer className="assistant-footer">© 2026 FORGEYI · Industrial Engineering Assistant Suite</footer>
  </div>;
}
