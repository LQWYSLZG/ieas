/**
 * ChangeList: the plain-language list of what an Auto-Optimize proposal would
 * change, rendered for review in the Optimize stage.
 *
 * It takes the change_list (ChangeListItem[]) straight off the OptimizeResponse
 * and renders each difference between the current layout and the proposed
 * configuration in shop-owner-readable language, grouped by kind so the reader
 * can scan all operation moves, then all operator changes, then all machine
 * changes (Req 7.1 to 7.4):
 *
 *   - operation_move: names the operation and that it moves from its current
 *     station to the destination station (Req 7.2).
 *   - operator_delta: names the station and the signed operator change, for
 *     example "+2 operators" or "-1 operator" (Req 7.3).
 *   - machine_delta: names the station and the signed machine change (Req 7.4).
 *
 * Each item already carries a backend-composed `description` string. The
 * grouped rows here compose readable text from the structured fields for a
 * consistent look, and the raw description is kept available as a hover title
 * so nothing is lost.
 *
 * When the change list is empty the proposal is identical to the current
 * layout, so a single "no changes are proposed" line is shown (Req 7.5).
 *
 * Signed deltas use ASCII "+" and "-" prefixes. This file follows the project
 * rule that no em dashes or en dashes appear anywhere; only ASCII hyphens are
 * used, in code, comments, and strings. Box-drawing dividers (U+2550) match the
 * suite house style.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5.
 */

import type { ChangeListItem } from "../types";

export interface ChangeListProps {
  /** The proposed differences from the current layout, off the response. */
  items: ChangeListItem[];
}

// The three kinds, in the order they are presented. Operation moves first
// (the biggest structural change), then operator counts, then machine counts.
type ChangeKind = ChangeListItem["kind"];

const KIND_ORDER: ChangeKind[] = ["operation_move", "operator_delta", "machine_delta"];

const KIND_META: Record<ChangeKind, { label: string; color: string; bg: string; text: string }> = {
  operation_move: {
    label: "Operation moves",
    color: "#2d8ecf",
    bg: "rgba(45,142,207,0.14)",
    text: "#7fc1f0",
  },
  operator_delta: {
    label: "Operator changes",
    color: "#d4a017",
    bg: "rgba(212,160,23,0.14)",
    text: "#e8c35a",
  },
  machine_delta: {
    label: "Machine changes",
    color: "#28a745",
    bg: "rgba(40,167,69,0.14)",
    text: "#5fce7f",
  },
};

/**
 * Format a signed count change in plain language, for example "+2 operators",
 * "-1 operator", "+3 machines". The noun is singular when the magnitude is 1.
 * Zero is not expected (a delta row is only emitted for a real change) but is
 * rendered defensively as "no change" rather than a bare "0".
 */
function formatDelta(delta: number, nounSingular: string, nounPlural: string): string {
  if (delta === 0) {
    return "no change";
  }
  const sign = delta > 0 ? "+" : "-";
  const magnitude = Math.abs(delta);
  const noun = magnitude === 1 ? nounSingular : nounPlural;
  return `${sign}${magnitude} ${noun}`;
}

/**
 * Compose the readable headline for one change item from its structured fields.
 * Falls back to the backend-provided description when a field a kind needs is
 * missing, so a row always renders something meaningful.
 */
function headlineOf(item: ChangeListItem): string {
  switch (item.kind) {
    case "operation_move": {
      const op = item.operation_name ?? "An operation";
      const from = item.from_station_name ?? item.from_station_id ?? "its current station";
      const to = item.station_name;
      return `Move ${op} from ${from} to ${to}`;
    }
    case "operator_delta": {
      const change = formatDelta(item.delta ?? 0, "operator", "operators");
      return `${item.station_name}: ${change}`;
    }
    case "machine_delta": {
      const change = formatDelta(item.delta ?? 0, "machine", "machines");
      return `${item.station_name}: ${change}`;
    }
    default:
      return item.description;
  }
}

/** A single change row: a readable headline with the raw description on hover. */
function ChangeRow({ item, color }: { item: ChangeListItem; color: string }) {
  const headline = headlineOf(item);
  return (
    <li
      title={item.description}
      style={{
        padding: "6px 10px",
        marginBottom: "5px",
        background: "rgba(255,255,255,0.03)",
        borderRadius: "6px",
        borderLeft: `3px solid ${color}`,
        fontSize: "0.88rem",
        color: "#dce7f5",
        lineHeight: 1.4,
      }}
    >
      {headline}
    </li>
  );
}

/** One kind's section: a labeled header with a count, then its rows. */
function KindSection({ kind, items }: { kind: ChangeKind; items: ChangeListItem[] }) {
  if (items.length === 0) {
    return null;
  }
  const meta = KIND_META[kind];
  return (
    <div style={{ marginBottom: "12px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          margin: "0 0 6px 0",
          padding: "3px 8px",
          borderRadius: "6px",
          background: meta.bg,
        }}
      >
        <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: meta.color, flexShrink: 0 }} />
        <span style={{ fontSize: "0.86rem", fontWeight: 700, color: meta.text }}>{meta.label}</span>
        <span style={{ fontSize: "0.78rem", color: "#8fb0d6" }}>({items.length})</span>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {items.map((item, index) => (
          <ChangeRow key={`${item.kind}-${item.station_id}-${index}`} item={item} color={meta.color} />
        ))}
      </ul>
    </div>
  );
}

/**
 * The change list body. Renders the proposed changes grouped by kind in a fixed
 * order (Req 7.1 to 7.4), or a single "no changes are proposed" line when the
 * proposal matches the current layout (Req 7.5).
 */
export function ChangeList({ items }: ChangeListProps) {
  if (items.length === 0) {
    return (
      <p style={{ color: "#a8b8e8", fontSize: "0.82rem", margin: 0 }}>
        No changes are proposed. The optimized configuration matches your current layout.
      </p>
    );
  }

  return (
    <div className="change-list">
      {KIND_ORDER.map((kind) => (
        <KindSection
          key={kind}
          kind={kind}
          items={items.filter((item) => item.kind === kind)}
        />
      ))}
    </div>
  );
}

export default ChangeList;
