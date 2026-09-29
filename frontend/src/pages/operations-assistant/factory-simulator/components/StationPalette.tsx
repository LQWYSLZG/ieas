/**
 * ElementPalette: Sidebar with factory floor elements.
 */

import { useLayout } from "../context/LayoutContext";
import { HelpIcon } from "./HelpIcon";
import type { Source, Station, Buffer, Sink } from "../types";
import "./StationPalette.css";

interface ElementTemplate {
  type: "source" | "station" | "buffer" | "sink";
  label: string;
  icon: string;
  color: string;
  help: string;
}

const ELEMENT_TEMPLATES: ElementTemplate[] = [
  { type: "source", label: "Material Input", icon: "▶", color: "#28a745", help: "Where raw material enters the line. Set the arrival rate to control how fast units flow in." },
  { type: "station", label: "Workstation", icon: "⚙", color: "#4dabf7", help: "A processing step where work happens. Configure cycle time, number of machines, operators, and reliability." },
  { type: "buffer", label: "Buffer Zone", icon: "◆", color: "#ffc107", help: "A waiting area between workstations where WIP accumulates. Set capacity to limit queue size." },
  { type: "sink", label: "Finished Goods", icon: "⬛", color: "#dc3545", help: "The exit point where completed products leave the line. Measures total throughput." },
];

export function StationPalette() {
  const { layout, dispatch } = useLayout();

  const totalElements =
    layout.sources.length +
    layout.stations.length +
    layout.buffers.length +
    layout.sinks.length +
    layout.operator_pools.length;

  function getNextPosition() {
    const offset = totalElements * 30;
    return {
      x: 150 + (offset % 400),
      y: 150 + Math.floor(offset / 400) * 120,
    };
  }

  function handleAdd(template: ElementTemplate) {
    const pos = getNextPosition();
    const id = crypto.randomUUID();

    switch (template.type) {
      case "source": {
        const source: Source = {
          id, name: `Material Input ${layout.sources.length + 1}`, element_type: "source",
          x: pos.x, y: pos.y, arrival_rate: 0, batch_size: 1, variability: 0,
        };
        dispatch({ type: "ADD_SOURCE", source });
        break;
      }
      case "station": {
        const station: Station = {
          id, name: `Workstation ${layout.stations.length + 1}`, element_type: "station",
          x: pos.x, y: pos.y, cycle_time: 30, num_machines: 1, operators_required: 1,
          has_machine: true, reliability: 100, scrap_rate: 0, setup_time: 0, variability: 0.1,
          operations: [],
        };
        dispatch({ type: "ADD_STATION", station });
        break;
      }
      case "buffer": {
        const buffer: Buffer = {
          id, name: `Buffer Zone ${layout.buffers.length + 1}`, element_type: "buffer",
          x: pos.x, y: pos.y, capacity: 20,
        };
        dispatch({ type: "ADD_BUFFER", buffer });
        break;
      }
      case "sink": {
        const sink: Sink = {
          id, name: `Finished Goods ${layout.sinks.length + 1}`, element_type: "sink",
          x: pos.x, y: pos.y,
        };
        dispatch({ type: "ADD_SINK", sink });
        break;
      }
    }
  }

  return (
    <div className="element-palette">
      <h3 className="element-palette__title" style={{ marginBottom: "8px" }}>Floor Elements</h3>
      <ul className="element-palette__list">
        {ELEMENT_TEMPLATES.map((template) => (
          <li key={template.type} className="element-palette__item" style={{ display: "flex", alignItems: "center", gap: "2px" }}>
            <button
              className="element-palette__btn"
              onClick={() => handleAdd(template)}
              aria-label={`Add ${template.label}`}
              style={{ borderLeftColor: template.color }}
            >
              <span className="element-palette__icon" style={{ color: template.color }}>
                {template.icon}
              </span>
              <span className="element-palette__label">{template.label}</span>
            </button>
            <HelpIcon text={template.help} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default StationPalette;
