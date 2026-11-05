import { useEffect } from "react";
import { Link } from "react-router-dom";
import { AssistantHeader } from "../../components/AssistantHeader";
import { warmUpBackend } from "../../lib/warmup";

export default function OperationsAssistant() {
  useEffect(() => { warmUpBackend(); }, []);
  return <div className="assistant-page assistant-operations">
    <AssistantHeader icon="/icons/operations-assistant.png" title="Manufacturing Operations Assistant" />
    <section aria-labelledby="operations-tools">
      <div className="assistant-section-heading"><h2 id="operations-tools">YOUR FACTORY WORKSPACE</h2></div>
      <div className="assistant-tool-grid">
        <Link className="assistant-tool simulator-tool" to="/operations-assistant/factory-simulator" aria-label="Open Factory Floor Simulator">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21V10l6 3V8l6 3V3h4l2 18z M7 17h2m3 0h2m3 0h1" /></svg>
          <span className="simulator-launch">OPEN SIMULATOR</span>
          <h3>Factory Floor Simulator</h3>
          <p>Design factory layouts, run discrete event simulations, identify bottlenecks, and receive optimization recommendations.</p>
        </Link>
      </div>
    </section>
    <footer className="assistant-footer">© 2026 FORGEYI · Industrial Engineering Assistant Suite</footer>
  </div>;
}
