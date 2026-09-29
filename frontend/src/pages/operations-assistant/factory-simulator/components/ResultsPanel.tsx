/**
 * ResultsPanel - Shop-owner-focused simulation results.
 *
 * Goal: tell the owner, in plain language, WHERE the problem is (line, station,
 * labor) and WHAT it means, using the metrics the engine already returns.
 *
 * Structure of a single line section:
 *   1. Headline verdict (meet demand? what's the single constraint?)
 *   2. Capacity snapshot (actual vs needed vs best-possible)
 *   3. Per-station diagnosis (each station tagged with its problem + a
 *      busy/starved/blocked/idle time split bar)
 *   4. Labor (supplied vs needed, over/understaffed)
 *   5. Lean metrics (secondary, collapsed by default)
 *   6. Navigate to recommendations
 *
 * Multi-line layouts (result.lines.length >= 2) wrap one section per line, add a
 * Shared Resources View, and an optional whole-factory rollup. A single-line or
 * lines-less result renders EXACTLY ONE section that reads like the panel does
 * today, with no extra chrome. This preserves the single-line experience.
 */

import type {
  SimulationResult,
  PerLineResult,
  StationMetrics,
  BufferMetrics,
  LineBalanceMetrics,
  OperatorMetrics,
  TransportMetrics,
} from "../types";
import { HelpIcon } from "./HelpIcon";

export interface ResultsPanelProps {
  result: SimulationResult;
  targetThroughput: number;
  onViewRecommendations: () => void;
}

type StationProblem = {
  tag: string;
  color: string;
  explain: string;
};

/**
 * The subset of fields a single line section needs to render. Both the
 * whole-factory aggregate (SimulationResult) and a PerLineResult satisfy this
 * shape, so the same block renders either one. Fields that only the aggregate
 * carries (operators, transport) are passed separately and are omitted for
 * per-line scopes, which do not carry them.
 */
interface LineScope {
  throughput: number;
  avg_lead_time: number;
  wip_total: number;
  value_added_ratio: number;
  total_operators: number;
  labor_utilization: number;
  stations: StationMetrics[];
  buffers: BufferMetrics[];
  line_balance: LineBalanceMetrics;
  throughput_gap_pct?: number | null;
  operators_needed?: number;
  operators_supplied?: number;
}

const cardStyle = { padding: "10px 12px", background: "rgba(45, 90, 142, 0.15)", borderRadius: "6px", border: "1px solid rgba(45, 90, 142, 0.3)", marginBottom: "10px" };
const metricRow = { display: "flex", justifyContent: "space-between", fontSize: "0.8rem", padding: "3px 0" };
const labelStyle = { color: "#b0c8e0", display: "flex", alignItems: "center" };
const valueStyle = { color: "#fff", fontWeight: 600 as const };
const sectionTitle = { color: "#d4a017", fontSize: "0.78rem", cursor: "pointer", marginTop: "10px", marginBottom: "6px", fontWeight: 600 as const };
const subSectionTitle = { color: "#8fb0d6", fontSize: "0.68rem", fontWeight: 600 as const, textTransform: "uppercase" as const, letterSpacing: "0.06em", cursor: "pointer", marginTop: "8px", marginBottom: "4px", paddingLeft: "10px", borderLeft: "2px solid rgba(93, 173, 226, 0.5)", listStyle: "none" as const };
const sharedBadgeStyle = { fontSize: "0.6rem", fontWeight: 700, padding: "1px 6px", borderRadius: "10px", background: "rgba(93, 173, 226, 0.2)", color: "#5dade2", border: "1px solid rgba(93, 173, 226, 0.5)", marginLeft: "6px" };

/**
 * Classify a station's primary problem from the time split the engine reports.
 * In plain language a shop owner can act on. Priority order matters: a station
 * that is over takt is the true constraint; otherwise starving/blocking/idle
 * point to the real cause of lost time.
 */
function diagnoseStation(sm: StationMetrics, taktTime: number | null): StationProblem {
  // Over takt: the station simply can't keep pace with demand, the real bottleneck.
  if (taktTime && sm.effective_cycle_time > taktTime + 0.5) {
    return {
      tag: "Over takt",
      color: "#dc3545",
      explain: `Takes ${sm.effective_cycle_time.toFixed(0)}s per unit but only ${taktTime.toFixed(0)}s is allowed. This station sets the pace of the whole line.`,
    };
  }
  if (sm.down_pct >= 10) {
    return {
      tag: "Machine down",
      color: "#c0392b",
      explain: `The machine is down ${sm.down_pct.toFixed(0)}% of the time for breakdowns or repair. Preventive maintenance or a backup machine would recover this lost time.`,
    };
  }
  if (sm.blocked_pct >= 15) {
    return {
      tag: "Blocked",
      color: "#e07b39",
      explain: `Finished units can't move on ${sm.blocked_pct.toFixed(0)}% of the time. The next station or buffer is full, so fix what's downstream.`,
    };
  }
  if (sm.starved_pct >= 15) {
    return {
      tag: "Starved",
      color: "#ffc107",
      explain: `Waiting for parts ${sm.starved_pct.toFixed(0)}% of the time. An upstream step can't feed it fast enough.`,
    };
  }
  if (sm.overstaffed && sm.utilization < 50) {
    return {
      tag: "Overstaffed",
      color: "#9b59b6",
      explain: `Busy only ${sm.utilization.toFixed(0)}% of the time with operators assigned. Consider moving people to a busier station.`,
    };
  }
  if (sm.utilization >= 85) {
    return {
      tag: "At capacity",
      color: "#dc3545",
      explain: `Running ${sm.utilization.toFixed(0)}% of the time with very little slack. Any hiccup here will slow the line.`,
    };
  }
  return {
    tag: "Healthy",
    color: "#28a745",
    explain: `Running ${sm.utilization.toFixed(0)}% of the time with room to spare.`,
  };
}

/**
 * Plain explanation of WHY a station is the bottleneck, so the owner
 * understands the mark instead of just seeing it.
 */
function bottleneckReason(sm: StationMetrics, taktTime: number | null): string {
  if (taktTime && sm.effective_cycle_time > taktTime + 0.5) {
    return `It is the slowest step on the line: ${sm.effective_cycle_time.toFixed(0)}s per unit against a ${taktTime.toFixed(0)}s target, so it sets the pace everything else waits on.`;
  }
  if (sm.down_pct >= 10) {
    return `Machine downtime here (${sm.down_pct.toFixed(0)}% of the time) drops its real output below the other stations, making it the constraint.`;
  }
  if (sm.blocked_pct >= 15) {
    return `It is busy the most but loses ${sm.blocked_pct.toFixed(0)}% of its time blocked, so it cannot pass work along fast enough.`;
  }
  return `It runs the highest share of the time (${sm.utilization.toFixed(0)}%), so it has the least spare capacity and limits the whole line.`;
}

/**
 * Render a single line's (or the whole-factory aggregate's) results: verdict,
 * capacity snapshot, per-station diagnosis, labor, and lean metrics. This is the
 * reusable block that keeps the single-line experience identical to before.
 *
 * @param scope        the line-shaped or aggregate metrics to render
 * @param targetThroughput the effective target this scope is judged against
 * @param takt         the effective takt this scope is judged against
 * @param operators    per-pool operator detail (aggregate only; omit per line)
 * @param transport    transport-waste metrics (aggregate only; omit per line)
 * @param defaultOpen  whether the "Where the problems are" and "Labor"
 *                     sub-sections start expanded. True (the default) keeps the
 *                     single-line reading experience unchanged; false collapses
 *                     them for multi-line layouts so expanding a line does not
 *                     dump everything at once. "Lean metrics" always stays
 *                     collapsed regardless.
 */
function LineSection({
  scope,
  targetThroughput,
  takt,
  operators,
  transport,
  defaultOpen = true,
}: {
  scope: LineScope;
  targetThroughput: number;
  takt: number | null;
  operators?: OperatorMetrics[];
  transport?: TransportMetrics;
  defaultOpen?: boolean;
}) {
  const meetsTarget = scope.throughput >= targetThroughput * 0.98;
  const gapPct = scope.throughput_gap_pct ?? 0;

  // The single most-limiting station: prefer the engine's bottleneck flag,
  // else the highest-utilization station.
  const sortedByUtil = scope.stations.slice().sort((a, b) => b.utilization - a.utilization);
  const constraint = scope.stations.find((s) => s.is_bottleneck) ?? sortedByUtil[0];
  const constraintDiag = constraint ? diagnoseStation(constraint, takt) : null;

  // Best-possible throughput if the slowest station were the only limit
  // (units/hr = 3600 / slowest effective cycle time).
  const slowest = scope.line_balance.slowest_station_cycle;
  const theoreticalMax = slowest > 0 ? 3600 / slowest : 0;

  // Verdict
  let verdict: string;
  let verdictColor: string;
  if (meetsTarget) {
    verdict = "This line can meet your demand.";
    verdictColor = "#28a745";
  } else if (constraint && constraintDiag) {
    verdict = `This line falls about ${gapPct.toFixed(0)}% short of demand. The hold-up is ${constraint.station_name} (${constraintDiag.tag.toLowerCase()}).`;
    verdictColor = "#dc3545";
  } else {
    verdict = `This line falls about ${gapPct.toFixed(0)}% short of demand.`;
    verdictColor = "#dc3545";
  }

  // Whether reliability/quality data is meaningful (OEE only shown if a station
  // has real downtime or scrap; otherwise it just reads 100% and misleads).
  const showOee = scope.stations.some((s) => s.oee < 99.5);

  return (
    <div>
      {/* 1. Headline verdict */}
      <div style={{ padding: "12px", borderRadius: "8px", background: `${verdictColor}22`, border: `1px solid ${verdictColor}66`, marginBottom: "12px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginBottom: "4px" }}>
          <span style={{ fontSize: "1.4rem", fontWeight: 700, color: verdictColor }}>{scope.throughput.toFixed(0)}</span>
          <span style={{ fontSize: "0.8rem", color: "#b0c8e0" }}>/ {targetThroughput.toFixed(0)} units/hr needed</span>
        </div>
        <p style={{ fontSize: "0.75rem", color: "#e0e8f0", margin: 0, lineHeight: 1.4 }}>{verdict}</p>
      </div>

      {/* 2. Capacity snapshot */}
      <div style={cardStyle}>
        <div style={metricRow}>
          <span style={labelStyle}>Producing now <HelpIcon text="Units per hour this line actually finishes in the simulation." /></span>
          <span style={valueStyle}>{scope.throughput.toFixed(0)} /hr</span>
        </div>
        <div style={metricRow}>
          <span style={labelStyle}>Demand needs <HelpIcon text="Units per hour required to meet your daily demand at the takt pace." /></span>
          <span style={valueStyle}>{targetThroughput.toFixed(0)} /hr</span>
        </div>
        {theoreticalMax > 0 && (
          <div style={metricRow}>
            <span style={labelStyle}>Line ceiling <HelpIcon text="The fastest this line could ever run, set by its slowest station. A line can never produce faster than its slowest step, so this is the upper limit (3600 seconds divided by the slowest station's time per unit). If this number is already below what demand needs, then rebalancing or moving operators will not be enough on its own. You would have to make the slowest station faster or add a second one." /></span>
            <span style={{ ...valueStyle, color: theoreticalMax >= targetThroughput ? "#28a745" : "#dc3545" }}>{theoreticalMax.toFixed(0)} /hr</span>
          </div>
        )}
        <div style={metricRow}>
          <span style={labelStyle}>Takt (pace target) <HelpIcon text="Seconds allowed per unit at each station to keep up with demand." /></span>
          <span style={valueStyle}>{takt?.toFixed(0) ?? "-"}s</span>
        </div>
      </div>

      {/* 3. Per-station diagnosis */}
      <details open={defaultOpen}>
        <summary style={subSectionTitle}>{"\u25B8 "}Where the problems are</summary>
        <div style={{ ...cardStyle, padding: "8px 10px" }}>
          {sortedByUtil.map((sm) => {
            const diag = diagnoseStation(sm, takt);
            // Time split (should sum to ~100). Clamp for the bar widths.
            const busy = Math.max(0, Math.min(100, sm.utilization));
            const starved = Math.max(0, Math.min(100, sm.starved_pct));
            const blocked = Math.max(0, Math.min(100, sm.blocked_pct));
            const down = Math.max(0, Math.min(100, sm.down_pct));
            const idle = Math.max(0, 100 - busy - starved - blocked - down);
            return (
              <div key={sm.station_id} style={{ padding: "7px 0", borderBottom: "1px solid rgba(45,90,142,0.3)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                  <span style={{ fontSize: "0.8rem", color: "#fff", fontWeight: sm.is_bottleneck ? 700 : 500 }}>
                    {sm.is_bottleneck && (
                      <span style={{ color: "#dc3545" }} title={`Bottleneck: ${bottleneckReason(sm, takt)}`}>⚠ </span>
                    )}
                    {sm.station_name}
                    {sm.is_shared && (
                      <span style={sharedBadgeStyle} title="This station serves more than one line.">Shared</span>
                    )}
                  </span>
                  <span style={{ fontSize: "0.66rem", fontWeight: 700, padding: "1px 7px", borderRadius: "10px", background: `${diag.color}22`, color: diag.color, border: `1px solid ${diag.color}66` }}>
                    {diag.tag}
                  </span>
                </div>

                {/* Busy / starved / blocked / idle split bar */}
                <div style={{ display: "flex", height: "7px", borderRadius: "4px", overflow: "hidden", marginBottom: "4px", background: "#0f1a26" }} title={`Working ${busy.toFixed(0)}%, Starved ${starved.toFixed(0)}%, Blocked ${blocked.toFixed(0)}%, Down ${down.toFixed(0)}%, Idle ${idle.toFixed(0)}%`}>
                  {busy > 0 && <div style={{ width: `${busy}%`, background: "#28a745" }} />}
                  {starved > 0 && <div style={{ width: `${starved}%`, background: "#ffc107" }} />}
                  {blocked > 0 && <div style={{ width: `${blocked}%`, background: "#e07b39" }} />}
                  {down > 0 && <div style={{ width: `${down}%`, background: "#c0392b" }} />}
                  {idle > 0 && <div style={{ width: `${idle}%`, background: "#3a4a6a" }} />}
                </div>

                <p style={{ fontSize: "0.7rem", color: "#a8b8e8", margin: "0 0 4px 0", lineHeight: 1.35 }}>{diag.explain}</p>

                {/* For a shared station the split bar above shows the whole
                    station (all lines combined). This compact note shows how
                    that busy time divides across the lines it serves, so the
                    owner can see this line's slice within the shared total. */}
                {sm.is_shared && sm.line_shares && sm.line_shares.length > 0 && (
                  <p style={{ fontSize: "0.66rem", color: "#8898c8", margin: "0 0 4px 0", lineHeight: 1.35 }}>
                    Whole station shown above. Line split: {sm.line_shares.map((ls) => `${ls.line_name} ${ls.busy_pct.toFixed(0)}% busy`).join(", ")}
                  </p>
                )}

                {/* Scrap (defect waste): shown only when the engine measured
                    a positive scrap rate for this station. */}
                {sm.scrap_pct != null && sm.scrap_pct > 0 && (
                  <p style={{ fontSize: "0.66rem", color: "#e0a37b", margin: "0 0 4px 0", lineHeight: 1.35 }}>
                    Scrap: {sm.scrap_pct.toFixed(1)} percent of units scrapped.
                  </p>
                )}

                {/* Setup impact: one-time setup as modeled, shown only when
                    the station carries setup time. */}
                {sm.setup_impact != null && sm.setup_impact > 0 && (
                  <p style={{ fontSize: "0.66rem", color: "#c9a6e0", margin: "0 0 4px 0", lineHeight: 1.35 }}>
                    Setup impact: {sm.setup_impact.toFixed(1)} times cycle time (one-time setup as modeled).
                  </p>
                )}

                {sm.is_bottleneck && (
                  <p style={{ fontSize: "0.7rem", color: "#ff9aa2", margin: "0 0 4px 0", lineHeight: 1.35 }}>
                    <strong style={{ color: "#dc3545" }}>Why it's the bottleneck:</strong> {bottleneckReason(sm, takt)}
                  </p>
                )}

                {/* Per-operation breakdown: shows which step on this station is
                    the slowest, so the owner knows exactly what to speed up. */}
                {sm.operations && sm.operations.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", marginTop: "2px" }}>
                    {sm.operations.map((op, i) => (
                      <span key={i} style={{ fontSize: "0.66rem", color: op.is_slowest ? "#ffd479" : "#8898c8" }}>
                        {op.is_slowest && sm.operations.length > 1 ? "★ " : ""}{op.name} {op.avg_cycle_time.toFixed(0)}s
                        {op.operators_required > 0 ? ` · ${op.operators_required} op` : " · auto"}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {/* Legend */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", fontSize: "0.64rem", color: "#8898c8", marginTop: "8px" }}>
            <span><span style={{ color: "#28a745" }}>■</span> Working</span>
            <span><span style={{ color: "#ffc107" }}>■</span> Starved</span>
            <span><span style={{ color: "#e07b39" }}>■</span> Blocked</span>
            <span><span style={{ color: "#c0392b" }}>■</span> Machine down</span>
            <span><span style={{ color: "#3a4a6a" }}>■</span> Idle</span>
          </div>
        </div>
      </details>

      {/* 4. Labor */}
      {scope.total_operators > 0 && (
        <details open={defaultOpen}>
          <summary style={subSectionTitle}>{"\u25B8 "}Labor</summary>
          <div style={cardStyle}>
            <div style={metricRow}>
              <span style={labelStyle}>Operators on the line <HelpIcon text="Total workers staffed across all stations." /></span>
              <span style={valueStyle}>{scope.total_operators}</span>
            </div>
            <div style={metricRow}>
              <span style={labelStyle}>Hands-on time <HelpIcon text="Average share of paid time operators spend actually working. Very high means they're maxed out; very low means they're often idle." /></span>
              <span style={{ ...valueStyle, color: scope.labor_utilization > 90 ? "#dc3545" : scope.labor_utilization < 40 ? "#ffc107" : "#28a745" }}>{scope.labor_utilization}%</span>
            </div>
            {/* Per-line labor: operators this line needs versus its share of
                the supplied pool. Only present on per-line scopes (the aggregate
                does not carry these fields, so it is skipped there). */}
            {scope.operators_needed != null && scope.operators_supplied != null && (
              <div style={metricRow}>
                <span style={labelStyle}>Operators needed vs supplied <HelpIcon text="Operators this line needs, from its work content, versus its share of the supplied pool." /></span>
                <span style={{ ...valueStyle, color: scope.operators_needed > scope.operators_supplied ? "#dc3545" : "#28a745" }}>
                  {scope.operators_needed.toFixed(1)} vs {scope.operators_supplied.toFixed(1)}
                </span>
              </div>
            )}
            {/* Per-pool operator detail is aggregate-only: PerLineResult does not
                carry operators[], so this appears on the aggregate/single-line
                path exactly as before and is skipped for per-line sections. */}
            {operators?.map((op) => {
              const under = op.required > op.supplied;
              const over = op.overstaffed;
              if (!under && !over) return null;
              return (
                <p key={op.pool_id} style={{ fontSize: "0.7rem", margin: "4px 0 0 0", lineHeight: 1.35, color: under ? "#ff8a94" : "#c9a6e0" }}>
                  {under
                    ? `Understaffed: needs ${op.required} operators but only ${op.supplied} supplied, so operations wait for a free worker and output is capped.`
                    : `Overstaffed: ${op.supplied} supplied versus ${op.required} needed, so workers are idle part of the time.`}
                </p>
              );
            })}

            {/* Per-station labor: which stations carry the labor and how busy
                they are, so the owner can see where people are tight or idle.
                Include a station whose recorded operations need operators OR
                whose reported throughput is 0 with operators (a station that
                never ran still belongs in the labor list, so it isn't silently
                dropped, that was the "only some stations show" confusion). */}
            {(() => {
              const mannedStations = scope.stations.filter(
                (s) => s.operations.some((o) => o.operators_required > 0) || s.throughput === 0
              );
              if (mannedStations.length === 0) return null;
              return (
                <div style={{ marginTop: "8px", borderTop: "1px solid rgba(45,90,142,0.3)", paddingTop: "6px" }}>
                  <div style={{ fontSize: "0.7rem", color: "#8ba3c0", marginBottom: "4px" }}>By station</div>
                  {mannedStations.map((s) => {
                    const need = s.operations.reduce((a, o) => a + o.operators_required, 0);
                    const mannedOps = s.operations.filter((o) => o.operators_required > 0);
                    const neverRan = s.throughput === 0;
                    const busyColor = s.utilization > 90 ? "#dc3545" : s.utilization < 40 ? "#ffc107" : "#28a745";
                    return (
                      <div key={s.station_id} style={{ padding: "3px 0" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem" }}>
                          <span style={{ color: "#dbe6f2" }}>
                            {s.station_name}
                            {s.is_shared && (
                              <span style={sharedBadgeStyle} title="This station serves more than one line.">Shared</span>
                            )}
                          </span>
                          {neverRan ? (
                            <span style={{ color: "#ff9aa2" }}>never ran</span>
                          ) : (
                            <span style={{ color: "#b0c8e0" }}>
                              {need} {need === 1 ? "operator" : "operators"} · <span style={{ color: busyColor, fontWeight: 600 }}>{s.utilization.toFixed(0)}% busy</span>
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: "0.64rem", color: "#8898c8" }}>
                          {neverRan
                            ? "Processed 0 units. Check that this station is connected into the flow."
                            : mannedOps.map((o) => `${o.name} (${o.operators_required})`).join(" · ")}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </details>
      )}

      {/* 5. Lean metrics, secondary, collapsed by default */}
      <details>
        <summary style={subSectionTitle}>{"\u25B8 "}Lean metrics (advanced)</summary>
        <div style={cardStyle}>
          <div style={metricRow}>
            <span style={labelStyle}>Lead Time <HelpIcon text="Average time for one unit to travel from entry to exit, including waiting and transport." /></span>
            <span style={valueStyle}>{scope.avg_lead_time}s</span>
          </div>
          <div style={metricRow}>
            <span style={labelStyle}>Work In Progress <HelpIcon text="Average number of units sitting in the line at any time. Lower is leaner." /></span>
            <span style={valueStyle}>{scope.wip_total} units</span>
          </div>
          <div style={metricRow}>
            <span style={labelStyle}>Value-Added Ratio <HelpIcon text="Share of lead time spent actually processing vs waiting/moving. Higher = less waste." /></span>
            <span style={{ ...valueStyle, color: scope.value_added_ratio >= 60 ? "#28a745" : "#ffc107" }}>{scope.value_added_ratio}%</span>
          </div>
          <div style={metricRow}>
            <span style={labelStyle}>Line Balance <HelpIcon text="How evenly work is distributed across stations. 100% = perfectly balanced." /></span>
            <span style={{ ...valueStyle, color: scope.line_balance.balance_efficiency >= 75 ? "#28a745" : "#ffc107" }}>{scope.line_balance.balance_efficiency}%</span>
          </div>
          {/* Transport waste is aggregate-only: PerLineResult does not carry
              transport, so this row shows on the aggregate/single-line path
              exactly as before and is skipped for per-line sections. */}
          {transport && (
            <div style={metricRow}>
              <span style={labelStyle}>Transport Waste <HelpIcon text="Share of lead time spent moving material instead of processing it." /></span>
              <span style={{ ...valueStyle, color: transport.transport_waste_pct <= 10 ? "#28a745" : "#ffc107" }}>{transport.transport_waste_pct}%</span>
            </div>
          )}
          {showOee && (
            <div style={metricRow}>
              <span style={labelStyle}>Avg Station OEE <HelpIcon text="Overall Equipment Effectiveness = uptime × speed × quality. Only meaningful when you've entered machine reliability or scrap rates." /></span>
              <span style={valueStyle}>
                {(scope.stations.reduce((a, s) => a + s.oee, 0) / Math.max(1, scope.stations.length)).toFixed(0)}%
              </span>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

/**
 * The effective target throughput a line is judged against: its own
 * target_throughput when set, else the panel's global target prop.
 */
function effectiveTarget(line: PerLineResult, fallbackTarget: number): number {
  return line.target_throughput ?? fallbackTarget;
}

/**
 * The effective takt a line is judged against: its own takt_time when set, else
 * the line's own balance takt.
 */
function effectiveTakt(line: PerLineResult): number | null {
  return line.takt_time ?? line.line_balance.takt_time ?? null;
}

/**
 * Shared Resources View: lists shared stations across lines. The backend now
 * populates line_shares with the exact per-line split for every shared station,
 * so each one shows its exact per-line busy % and units processed. The
 * empty-array branch is kept as a defensive fallback (it should rarely show now
 * that shared stations always carry line_shares).
 */
function SharedResourcesView({ lines }: { lines: PerLineResult[] }) {
  // Collect shared stations once each (a shared station appears in every served
  // line, so de-duplicate by station_id, keeping the first occurrence).
  const seen = new Set<string>();
  const sharedStations: StationMetrics[] = [];
  for (const line of lines) {
    for (const sm of line.stations) {
      if (sm.is_shared && !seen.has(sm.station_id)) {
        seen.add(sm.station_id);
        sharedStations.push(sm);
      }
    }
  }
  if (sharedStations.length === 0) return null;

  // Map a line_id to its display name for the "served by" hint.
  const nameById = new Map(lines.map((l) => [l.line_id, l.line_name]));

  return (
    <details>
      <summary style={sectionTitle}>Shared Resources View</summary>
      <div style={cardStyle}>
        <p style={{ fontSize: "0.7rem", color: "#a8b8e8", margin: "0 0 8px 0", lineHeight: 1.35 }}>
          These stations serve more than one line, so their time is split across lines.
        </p>
        {sharedStations.map((sm) => {
          const servedNames = (sm.line_ids ?? []).map((id) => nameById.get(id) ?? id);
          return (
            <div key={sm.station_id} style={{ padding: "6px 0", borderBottom: "1px solid rgba(45,90,142,0.3)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3px" }}>
                <span style={{ fontSize: "0.78rem", color: "#fff", fontWeight: 600 }}>
                  {sm.station_name}
                  <span style={sharedBadgeStyle}>Shared</span>
                </span>
                <span style={{ fontSize: "0.7rem", color: "#b0c8e0" }}>{sm.utilization.toFixed(0)}% busy</span>
              </div>
              {servedNames.length > 0 && (
                <div style={{ fontSize: "0.66rem", color: "#8898c8", marginBottom: "3px" }}>
                  Serves: {servedNames.join(", ")}
                </div>
              )}
              {sm.line_shares && sm.line_shares.length > 0 ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
                  {sm.line_shares.map((ls) => (
                    <span key={ls.line_id} style={{ fontSize: "0.66rem", color: "#a8b8e8" }}>
                      {ls.line_name}: {ls.busy_pct.toFixed(0)}% busy, {ls.throughput.toFixed(0)} units
                    </span>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: "0.66rem", color: "#8898c8", fontStyle: "italic" }}>
                  Per-line split not available.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

/**
 * Whole-factory rollup: the top-level aggregate result fields, shown collapsed
 * for multi-line layouts so the owner can still see blended totals.
 */
function WholeFactoryRollup({ result }: { result: SimulationResult }) {
  return (
    <details>
      <summary style={sectionTitle}>Whole-factory rollup</summary>
      <div style={cardStyle}>
        <div style={metricRow}>
          <span style={labelStyle}>Total throughput <HelpIcon text="Units per hour finished across every line combined." /></span>
          <span style={valueStyle}>{result.throughput.toFixed(0)} /hr</span>
        </div>
        <div style={metricRow}>
          <span style={labelStyle}>Lead Time <HelpIcon text="Average time for one unit to travel from entry to exit, blended across lines." /></span>
          <span style={valueStyle}>{result.avg_lead_time}s</span>
        </div>
        <div style={metricRow}>
          <span style={labelStyle}>Work In Progress <HelpIcon text="Average units sitting across the whole factory at any time." /></span>
          <span style={valueStyle}>{result.wip_total} units</span>
        </div>
        <div style={metricRow}>
          <span style={labelStyle}>Value-Added Ratio <HelpIcon text="Share of lead time spent processing vs waiting/moving, blended." /></span>
          <span style={{ ...valueStyle, color: result.value_added_ratio >= 60 ? "#28a745" : "#ffc107" }}>{result.value_added_ratio}%</span>
        </div>
        {result.total_operators > 0 && (
          <div style={metricRow}>
            <span style={labelStyle}>Operators <HelpIcon text="Total workers staffed across the whole factory." /></span>
            <span style={valueStyle}>{result.total_operators}</span>
          </div>
        )}
        {result.total_operators > 0 && (
          <div style={metricRow}>
            <span style={labelStyle}>Hands-on time <HelpIcon text="Average share of paid time operators spend working, blended." /></span>
            <span style={{ ...valueStyle, color: result.labor_utilization > 90 ? "#dc3545" : result.labor_utilization < 40 ? "#ffc107" : "#28a745" }}>{result.labor_utilization}%</span>
          </div>
        )}
        <div style={metricRow}>
          <span style={labelStyle}>Transport Waste <HelpIcon text="Share of lead time spent moving material instead of processing it." /></span>
          <span style={{ ...valueStyle, color: result.transport.transport_waste_pct <= 10 ? "#28a745" : "#ffc107" }}>{result.transport.transport_waste_pct}%</span>
        </div>
      </div>
    </details>
  );
}

export function ResultsPanel({ result, targetThroughput, onViewRecommendations }: ResultsPanelProps) {
  const lines = result.lines ?? [];

  // No-regression: when there are no per-line results OR exactly one line,
  // render EXACTLY ONE section that reads like the panel does today, with no
  // multi-line chrome (no rollup, no shared-resources view). The aggregate is
  // the scope, and it keeps showing operators and transport exactly as before.
  const singleLine = lines.length <= 1;

  const fixButton = (
    <button
      type="button"
      onClick={onViewRecommendations}
      style={{ marginTop: "8px", width: "100%", padding: "9px", background: "#2d5a8e", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: 600, fontSize: "0.82rem" }}
    >
      See how to fix it →
    </button>
  );

  if (singleLine) {
    const takt = result.line_balance.takt_time ?? null;
    return (
      <div>
        <LineSection
          scope={result}
          targetThroughput={targetThroughput}
          takt={takt}
          operators={result.operators}
          transport={result.transport}
        />
        {fixButton}
      </div>
    );
  }

  // Multi-line: one collapsible section per line (judged against that line's own
  // target/takt), then the shared-resources view and the whole-factory rollup.
  return (
    <div>
      {lines.map((line) => (
        <details key={line.line_id}>
          <summary style={{ ...sectionTitle, fontSize: "0.9rem", marginTop: "14px", borderBottom: "1px solid rgba(212, 160, 23, 0.3)", paddingBottom: "4px" }}>
            {line.line_name}
          </summary>
          <div style={{ marginTop: "8px" }}>
            <LineSection
              scope={{
                throughput: line.throughput,
                avg_lead_time: line.avg_lead_time,
                wip_total: line.wip_total,
                value_added_ratio: line.value_added_ratio,
                total_operators: line.total_operators ?? 0,
                labor_utilization: line.labor_utilization ?? 0,
                stations: line.stations,
                buffers: line.buffers,
                line_balance: line.line_balance,
                throughput_gap_pct: line.throughput_gap_pct,
                operators_needed: line.operators_needed,
                operators_supplied: line.operators_supplied,
              }}
              targetThroughput={effectiveTarget(line, targetThroughput)}
              takt={effectiveTakt(line)}
              defaultOpen={false}
            />
          </div>
        </details>
      ))}

      <SharedResourcesView lines={lines} />

      <WholeFactoryRollup result={result} />

      {fixButton}
    </div>
  );
}
