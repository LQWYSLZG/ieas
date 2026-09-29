"""Recommendation engine for the Factory Floor Simulator.

Analyzes simulation results to produce ranked, actionable improvement suggestions.

This module is deliberately aligned with the frontend ResultsPanel diagnosis so
that whenever the results view flags a problem (over-takt, blocked, starved,
machine-down, understaffed, overstaffed, at-capacity, or a line ceiling below
demand), the Optimize step produces at least one plain-language, shop-owner
friendly recommendation for it. It also keeps the existing WIP/buffer,
transport-waste, and line-imbalance recommendations so they co-exist.

The core diagnosis is factored into a scope-agnostic helper so it can run
against the whole factory or against a single line's stations, buffers, and
target/takt. The public API exposes both ``generate_recommendations`` (the
whole-factory rollup, backward compatible) and ``generate_line_recommendations``
(one line's scoped recommendations).
"""

from .models import (
    Buffer,
    BufferMetrics,
    Layout,
    LineBalanceMetrics,
    OperationMetrics,
    OperatorMetrics,
    PerLineResult,
    Recommendation,
    SimulationResult,
    StationMetrics,
)
from typing import Optional


# Sensitive thresholds, kept in step with the frontend ResultsPanel diagnosis.
OVER_TAKT_MARGIN = 0.5
BLOCKED_THRESHOLD = 15.0
STARVED_THRESHOLD = 15.0
DOWN_THRESHOLD = 10.0
DOWN_HIGH_THRESHOLD = 25.0
AT_CAPACITY_THRESHOLD = 85.0
OVERSTAFFED_UTIL_THRESHOLD = 50.0

# Retained thresholds for the existing WIP / transport / balance rules.
HIGH_WIP_THRESHOLD = 10.0
TRANSPORT_WASTE_THRESHOLD = 10.0
BALANCE_THRESHOLD = 70.0

# New waste-diagnosis thresholds (diagnosis-depth-extension).
SCRAP_THRESHOLD = 10.0          # Scrap_Pct >= this emits defect_waste (Req 4.4)
SCRAP_HIGH_THRESHOLD = 25.0     # severity high at/above this, else medium
SETUP_RATIO_THRESHOLD = 0.5     # setup_impact >= this emits setup_waste (Req 5.4)


def _pick_movable_operation(sm: StationMetrics) -> Optional[OperationMetrics]:
    """Pick the operation to move off a station, or None when none is eligible.

    Shared-station operations are excluded (Req 3.5). Among manual operations
    (operators_required > 0) the slowest by avg_cycle_time is chosen; ties fall
    to the first in the station's ordered operations list for determinism.
    """
    if sm.is_shared:
        return None  # shared-station operations are excluded (Req 3.5)
    eligible = [op for op in sm.operations if op.operators_required > 0]
    if not eligible:
        return None
    max_ct = max(op.avg_cycle_time for op in eligible)
    for op in sm.operations:               # ordered list => deterministic tie-break
        if op.operators_required > 0 and op.avg_cycle_time == max_ct:
            return op
    return None


def _least_loaded_same_line_station(
    sm: StationMetrics, stations: list[StationMetrics]
) -> Optional[StationMetrics]:
    """Return the least-loaded other station on the same scope, or None.

    Returns None for a single-station line (Req 3.4, 10.5). Otherwise the station
    with the smallest (utilization, station_id) is chosen for determinism.
    """
    others = [s for s in stations if s.station_id != sm.station_id]
    if not others:                          # single-station line (Req 3.4, 10.5)
        return None
    return min(others, key=lambda s: (s.utilization, s.station_id))


def _diagnose(
    stations: list[StationMetrics],
    buffers: list[BufferMetrics],
    operators: list[OperatorMetrics],
    line_balance: LineBalanceMetrics,
    target_throughput: Optional[float],
    layout: Layout,
    takt: Optional[float],
    operators_needed: Optional[float] = None,
    operators_supplied: Optional[float] = None,
    line_id: Optional[str] = None,
    line_name: Optional[str] = None,
) -> list[Recommendation]:
    """Run the diagnosis against one scope (whole factory or a single line).

    Produces at least one actionable recommendation for each problem the results
    view would flag within this scope, then adds the WIP/buffer and line-balance
    recommendations for the scope's own stations/buffers/balance. Deduplicates by
    (element_id, problem) and sorts by estimated throughput gain descending.

    ``layout`` supplies static element definitions (station and buffer records);
    ``stations``, ``buffers``, ``operators``, ``line_balance``, ``target_throughput``,
    and ``takt`` define the scope. Transport waste is a whole-factory concern and
    is handled only by the whole-factory caller, so it is intentionally omitted here.
    """
    recommendations: list[Recommendation] = []
    station_map = {s.id: s for s in layout.stations}
    buffer_map = {b.id: b for b in layout.buffers}

    # Per-station diagnosis (mirrors the ResultsPanel).
    for sm in stations:
        station = station_map.get(sm.station_id)
        name = sm.station_name
        ect = sm.effective_cycle_time
        util = sm.utilization

        over_takt_flagged = False

        # OVER TAKT: the station can't keep pace with demand, the real bottleneck.
        if takt and ect > takt + OVER_TAKT_MARGIN:
            over_takt_flagged = True
            overage = (ect - takt) / takt if takt > 0 else 0.0
            gain = min(overage * 100.0, 40.0)
            recommendations.append(Recommendation(
                element_id=sm.station_id,
                element_name=name,
                problem="bottleneck",
                severity="high",
                action=f"Speed up '{name}' or add a second machine: it takes {ect:.0f}s "
                       f"per unit but only {takt:.0f}s is allowed.",
                description=f"'{name}' runs at {ect:.0f}s per unit against a {takt:.0f}s takt, "
                            f"so it can't keep pace with demand and paces the whole line.",
                estimated_throughput_gain_pct=round(gain, 1),
            ))

            # OPERATION MOVE: name the operation to shift off this over-takt station.
            dest = _least_loaded_same_line_station(sm, stations)
            if dest is not None:
                move_gain = round(min(((ect - takt) / takt) * 100.0, 40.0), 1) if takt > 0 else 0.0
                op = _pick_movable_operation(sm)
                if op is not None:
                    recommendations.append(Recommendation(
                        element_id=sm.station_id,
                        element_name=name,
                        problem="operation_move",
                        severity="high",
                        action=f"Move operation {op.name} ({op.avg_cycle_time:.0f}s) off {name} to "
                               f"{dest.station_name} on the same line to bring {name} to or below the "
                               f"{takt:.0f}s takt.",
                        description=f"{name} runs {ect:.0f}s against a {takt:.0f}s takt. Its slowest "
                                    f"task is {op.name}. Shifting it to {dest.station_name} rebalances "
                                    f"the line.",
                        estimated_throughput_gain_pct=move_gain,
                    ))
                else:
                    recommendations.append(Recommendation(
                        element_id=sm.station_id,
                        element_name=name,
                        problem="operation_move",
                        severity="medium",
                        action=f"{name} is over takt but its work cannot be moved: its tasks are "
                               f"automated or it is shared across lines. Add capacity or speed the "
                               f"step instead.",
                        description=f"{name} exceeds takt, and no eligible manual, single-line "
                                    f"operation is available to shift, so a move is not proposed.",
                        estimated_throughput_gain_pct=0.0,
                    ))

        # BLOCKED: finishes work but can't hand it off.
        if sm.blocked_pct >= BLOCKED_THRESHOLD:
            recommendations.append(Recommendation(
                element_id=sm.station_id,
                element_name=name,
                problem="blocking",
                severity="high" if sm.blocked_pct >= 30 else "medium",
                action=f"Fix the step after '{name}': it finishes work but can't pass it on "
                       f"{sm.blocked_pct:.0f}% of the time. Add buffer space or speed up the "
                       f"downstream station.",
                description=f"'{name}' is blocked {sm.blocked_pct:.0f}% of the time. Completed units "
                            f"have nowhere to go because the next step is full or too slow.",
                estimated_throughput_gain_pct=round(min(sm.blocked_pct * 0.4, 25.0), 1),
            ))

        # STARVED: waits for parts from upstream.
        if sm.starved_pct >= STARVED_THRESHOLD:
            recommendations.append(Recommendation(
                element_id=sm.station_id,
                element_name=name,
                problem="starvation",
                severity="high" if sm.starved_pct >= 30 else "medium",
                action=f"Feed '{name}' faster: it waits for parts {sm.starved_pct:.0f}% of the time. "
                       f"Speed up or unblock the upstream step.",
                description=f"'{name}' sits starved {sm.starved_pct:.0f}% of the time. An upstream "
                            f"step can't feed it fast enough.",
                estimated_throughput_gain_pct=round(min(sm.starved_pct * 0.4, 25.0), 1),
            ))

        # MACHINE DOWN: breakdown/repair time.
        if sm.down_pct >= DOWN_THRESHOLD:
            recommendations.append(Recommendation(
                element_id=sm.station_id,
                element_name=name,
                problem="machine_downtime",
                severity="high" if sm.down_pct >= DOWN_HIGH_THRESHOLD else "medium",
                action=f"Improve reliability of '{name}': the machine is down {sm.down_pct:.0f}% of "
                       f"the time for breakdowns/repair. Consider preventive maintenance or a backup "
                       f"machine.",
                description=f"'{name}' loses {sm.down_pct:.0f}% of its time to breakdowns and repair, "
                            f"cutting into everything it could otherwise produce.",
                estimated_throughput_gain_pct=round(min(sm.down_pct * 0.4, 25.0), 1),
            ))

        # AT CAPACITY: high utilization, not already flagged over-takt.
        elif util >= AT_CAPACITY_THRESHOLD and not over_takt_flagged:
            recommendations.append(Recommendation(
                element_id=sm.station_id,
                element_name=name,
                problem="bottleneck",
                severity="medium",
                action=f"'{name}' runs at {util:.0f}% with little slack. Add capacity or offload "
                       f"work to keep the line stable.",
                description=f"'{name}' is at {util:.0f}% utilization. It has almost no headroom, so any "
                            f"hiccup upstream or downstream will stall the line.",
                estimated_throughput_gain_pct=round(min((util - AT_CAPACITY_THRESHOLD) * 0.5, 15.0), 1),
            ))

        # OVERSTAFFED: operators assigned but the station is barely busy.
        if sm.overstaffed and util < OVERSTAFFED_UTIL_THRESHOLD:
            recommendations.append(Recommendation(
                element_id=sm.station_id,
                element_name=name,
                problem="overstaffed",
                severity="low",
                action=f"'{name}' has operators but is busy only {util:.0f}% of the time. Move an "
                       f"operator to a busier station.",
                description=f"'{name}' carries labor it doesn't need. It's idle {100 - util:.0f}% of "
                            f"the time while operators stand ready.",
                estimated_throughput_gain_pct=0.0,
            ))

        # DEFECT WASTE: the station scraps a meaningful fraction of its output.
        if sm.scrap_pct >= SCRAP_THRESHOLD:
            sev = "high" if sm.scrap_pct >= SCRAP_HIGH_THRESHOLD else "medium"
            recommendations.append(Recommendation(
                element_id=sm.station_id,
                element_name=name,
                problem="defect_waste",
                severity=sev,
                action=f"Cut scrap at {name}: {sm.scrap_pct:.1f} percent of its units are scrapped. "
                       f"Check fixtures, materials, and inspection at this step.",
                description=f"{name} scraps {sm.scrap_pct:.1f} percent of what it makes, so real "
                            f"capacity and material are lost to defects.",
                estimated_throughput_gain_pct=round(min(sm.scrap_pct * 0.4, 25.0), 1),
            ))

        # SETUP WASTE: a one-time setup that is large against the cycle time.
        if station and station.setup_time > 0 and sm.setup_impact >= SETUP_RATIO_THRESHOLD:
            recommendations.append(Recommendation(
                element_id=sm.station_id,
                element_name=name,
                problem="setup_waste",
                severity="medium",
                action=f"Reduce changeover at {name}: setup is {station.setup_time:.0f}s, about "
                       f"{sm.setup_impact:.1f} times its cycle time. Apply quick-changeover methods.",
                description=f"{name} carries {station.setup_time:.0f}s of setup, a ratio of "
                            f"{sm.setup_impact:.1f} against its cycle time. This reflects a one-time "
                            f"setup as modeled, not a recurring per-unit loss.",
                estimated_throughput_gain_pct=round(min(sm.setup_impact * 5.0, 20.0), 1),
            ))

    # Per-line labor: this line needs more operators than it is supplied.
    if operators_needed is not None and operators_supplied is not None:
        if operators_needed > operators_supplied:
            _line_label = line_name or line_id or "Line"
            recommendations.append(Recommendation(
                element_id=f"line_labor:{line_id}",
                element_name=_line_label,
                problem="labor_constraint",
                severity="high",
                action=f"Add operators to line {_line_label}: it needs {operators_needed:.1f} "
                       f"but only {operators_supplied:.1f} are supplied, so work waits for a "
                       f"free worker.",
                description=f"Line {_line_label} is short-handed: {operators_needed:.1f} operators "
                            f"are needed but only {operators_supplied:.1f} are supplied, capping "
                            f"output.",
                estimated_throughput_gain_pct=round(min((operators_needed - operators_supplied) * 8.0, 30.0), 1),
            ))

    # Labor level: understaffed operator pools.
    for op in operators:
        if op.required > op.supplied:
            recommendations.append(Recommendation(
                element_id=op.pool_id,
                element_name=op.pool_name,
                problem="labor_constraint",
                severity="high",
                action=f"Add operators: the line needs {op.required} but only {op.supplied} are "
                       f"supplied, so work waits for a free worker.",
                description=f"'{op.pool_name}' is short-handed: {op.required} operators are needed but "
                            f"only {op.supplied} are supplied, capping output while operations queue for "
                            f"labor.",
                estimated_throughput_gain_pct=round(min((op.required - op.supplied) * 8.0, 30.0), 1),
            ))

    # Line ceiling below demand.
    slowest = line_balance.slowest_station_cycle
    if slowest > 0:
        ceiling = 3600.0 / slowest
        target = target_throughput
        if target and ceiling < target * 0.98:
            gap_pct = (target - ceiling) / target * 100.0 if target > 0 else 0.0
            recommendations.append(Recommendation(
                element_id="line_ceiling",
                element_name="Line Ceiling",
                problem="low_throughput",
                severity="high",
                action=f"The slowest station caps this line at ~{ceiling:.0f}/hr, below the "
                       f"{target:.0f}/hr you need. Rebalancing alone won't be enough, so make the slowest "
                       f"station faster or add one.",
                description=f"With the slowest step at {slowest:.0f}s per unit, the line can't exceed "
                            f"~{ceiling:.0f}/hr no matter how work is shuffled, short of the {target:.0f}/hr "
                            f"target.",
                estimated_throughput_gain_pct=round(min(gap_pct, 40.0), 1),
            ))

    # Existing WIP / buffer recommendations.
    for bm in buffers:
        buf = buffer_map.get(bm.buffer_id)
        if not buf:
            continue
        if bm.avg_level > buf.capacity * 0.8 or bm.overflow_count > 0:
            recommendations.append(Recommendation(
                element_id=buf.id,
                element_name=buf.name,
                problem="wip_explosion",
                severity="high" if bm.overflow_count > 0 else "medium",
                action=f"Investigate why WIP is accumulating at '{buf.name}': downstream may be too "
                       f"slow or buffer too small.",
                description=f"Buffer '{buf.name}' averages {bm.avg_level:.0f}/{buf.capacity} units. "
                            f"Overflowed {bm.overflow_count} times (causing upstream blocking).",
                estimated_throughput_gain_pct=round(min(bm.overflow_count * 2, 20.0), 1),
            ))

    # Existing line imbalance recommendation.
    if line_balance.balance_efficiency < BALANCE_THRESHOLD:
        spread = line_balance.cycle_time_spread
        recommendations.append(Recommendation(
            element_id="line_balance",
            element_name="Line Balance",
            problem="line_imbalance",
            severity="medium",
            action=f"Redistribute work between stations: cycle time spread is {spread:.0f}s "
                   f"(fastest: {line_balance.fastest_station_cycle:.0f}s, "
                   f"slowest: {line_balance.slowest_station_cycle:.0f}s).",
            description=f"Line balance efficiency is {line_balance.balance_efficiency:.0f}%. "
                        f"Some stations are overloaded while others are idle.",
            estimated_throughput_gain_pct=round((100 - line_balance.balance_efficiency) * 0.2, 1),
        ))

        # OPERATION MOVE: name a concrete source station, operation, and destination.
        # Guard: need at least two stations, a source with a movable op, and a dest.
        if len(stations) >= 2:
            source = None
            source_op = None
            for cand in sorted(stations, key=lambda s: (-s.effective_cycle_time, s.station_id)):
                cand_op = _pick_movable_operation(cand)
                if cand_op is not None and _least_loaded_same_line_station(cand, stations) is not None:
                    source = cand
                    source_op = cand_op
                    break
            if source is not None and source_op is not None:
                dest = _least_loaded_same_line_station(source, stations)
                recommendations.append(Recommendation(
                    element_id=source.station_id,
                    element_name=source.station_name,
                    problem="operation_move",
                    severity="high",
                    action=f"Move operation {source_op.name} ({source_op.avg_cycle_time:.0f}s) off "
                           f"{source.station_name} to {dest.station_name} on the same line to even "
                           f"out the workload.",
                    description=f"{source.station_name} is the most loaded station at "
                                f"{source.effective_cycle_time:.0f}s. Shifting {source_op.name} to "
                                f"{dest.station_name} rebalances the line.",
                    estimated_throughput_gain_pct=round((100 - line_balance.balance_efficiency) * 0.2, 1),
                ))

    return _dedupe_and_sort(recommendations)


def _dedupe_and_sort(recommendations: list[Recommendation]) -> list[Recommendation]:
    """Deduplicate by (element_id, problem), keeping the first (higher priority as
    emitted) entry, then sort by estimated gain (highest impact first)."""
    deduped: list[Recommendation] = []
    seen: set[tuple[str, str]] = set()
    for rec in recommendations:
        key = (rec.element_id, rec.problem)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(rec)

    deduped.sort(key=lambda r: r.estimated_throughput_gain_pct, reverse=True)
    return deduped


def generate_line_recommendations(layout: Layout, per_line_result: PerLineResult) -> list[Recommendation]:
    """Generate recommendations scoped to a single line.

    Runs the shared diagnosis against this line's stations, buffers, line balance,
    and effective target/takt. Operators are drawn from the whole layout for now
    (per-line operator attribution is a later increment). A shared station appears
    in each served line's ``.stations`` list, so its recommendation naturally
    surfaces under each line it serves (Req 5.4, 5.6).

    Transport waste is a whole-factory concern and is not attributed per line, so
    it is intentionally excluded here.
    """
    # Operators are not yet attributed per line; use the layout-wide requirement
    # picture. Build OperatorMetrics stand-ins from operator pools is out of scope,
    # so no operator pool metrics are available on a PerLineResult; pass an empty
    # list to keep the per-line labor rule quiet until per-line labor lands.
    operators: list[OperatorMetrics] = []
    return _diagnose(
        stations=per_line_result.stations,
        buffers=per_line_result.buffers,
        operators=operators,
        line_balance=per_line_result.line_balance,
        target_throughput=per_line_result.target_throughput,
        layout=layout,
        takt=per_line_result.takt_time,
        operators_needed=per_line_result.operators_needed,
        operators_supplied=per_line_result.operators_supplied,
        line_id=per_line_result.line_id,
        line_name=per_line_result.line_name,
    )


def generate_recommendations(layout: Layout, result: SimulationResult) -> list[Recommendation]:
    """Generate optimization recommendations from simulation results.

    Produces the whole-factory rollup: at least one actionable recommendation for
    each problem the results view would flag, plus the WIP/buffer, transport-waste,
    and line-balance recommendations. Deduplicates by (element_id, problem) and
    sorts by estimated throughput gain descending.

    When ``result.lines`` is present, this also populates each
    ``result.lines[i].recommendations`` by running ``generate_line_recommendations``
    for that line. The returned list remains the whole-factory aggregate (the union
    across the whole layout, deduped) so existing callers keep working. For a
    single-line layout the per-line list matches this aggregate.
    """
    # Whole-factory diagnosis over the full station/buffer/operator scope.
    aggregate = _diagnose(
        stations=result.stations,
        buffers=result.buffers,
        operators=result.operators,
        line_balance=result.line_balance,
        target_throughput=result.target_throughput,
        layout=layout,
        takt=result.line_balance.takt_time,
    )

    # Transport / walking waste is a whole-factory concern, so it is appended to
    # the aggregate only (not attributed to any single line).
    if result.transport.transport_waste_pct > TRANSPORT_WASTE_THRESHOLD:
        aggregate.append(Recommendation(
            element_id="transport",
            element_name="Transport System",
            problem="walking_waste",
            severity="medium",
            action=f"Reduce transport distances: {result.transport.transport_waste_pct:.0f}% of lead "
                   f"time is non-value-added movement. Consider rearranging layout to bring stations "
                   f"closer.",
            description=f"Transport accounts for {result.transport.transport_waste_pct:.0f}% of total lead "
                        f"time. Total distance: {result.transport.total_distance:.0f}m, "
                        f"total transport time: {result.transport.total_transport_time:.0f}s.",
            estimated_throughput_gain_pct=round(result.transport.transport_waste_pct * 0.3, 1),
        ))
        aggregate = _dedupe_and_sort(aggregate)

    # Populate each line's own recommendations when a per-line breakdown exists.
    for per_line in result.lines:
        per_line.recommendations = generate_line_recommendations(layout, per_line)

    return aggregate
