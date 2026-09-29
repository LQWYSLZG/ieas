"""Per-line results assembly for the Factory Floor Simulator.

This module groups an already-computed whole-factory simulation result into one
``PerLineResult`` per resolved production line. It is a pure, deterministic
function: it consumes the ``LineAssignment`` from ``resolve_lines`` and the
metrics the engine has already produced (the per-station and per-buffer metric
lists plus the aggregate scalars), and returns the per-line breakdown. The
engine keeps its aggregate ``SimulationResult`` fields exactly as they are (the
Whole_Factory_Rollup); this assembly only ADDS the ``lines`` list.

Increment A was MEMBERSHIP-BASED: it groups stations and buffers by their
resolved line and scopes the line balance, bottleneck, and target/takt/gap to
each line's own elements. Increment B (Task 21) now threads the engine's per-
unit attribution (the per-line raw bucket seconds on each station, plus the
sink's per-line completed counts and lead-time lists) into this assembly, so
the multi-line per-line throughput, lead time, and WIP are EXACT tag-based
values and ``line_shares`` carries each served line's split of every station's
time and output. When those raw inputs are absent (older callers), the code
falls back to the Increment A approximation so nothing breaks.

The no-regression path is exact: when a layout resolves to a single line, that
line mirrors the aggregate on every summary field and ``is_single_line`` is True,
so a single-line layout reads and computes exactly as it does today.
"""

from typing import Optional

from .models import (
    Layout, SimulationConfig,
    StationMetrics, BufferMetrics, LineBalanceMetrics, LineTimeShare,
    PerLineResult,
)
from .lines import (
    LineAssignment, ResolvedLine,
    line_effective_target, line_effective_takt, line_throughput_gap,
)


# The same real-load gate the engine uses to decide whether to flag a
# bottleneck at all: a line is only meaningfully loaded when its busiest station
# reaches this utilization. Below it, no station is flagged (an underfed line
# has no true constraint).
_BOTTLENECK_UTILIZATION_THRESHOLD = 70.0


def _line_balance_for(stations: list[StationMetrics], takt_time: Optional[float]) -> LineBalanceMetrics:
    """Compute line balance scoped to a line's stations, mirroring the engine.

    Uses each station's ``effective_cycle_time`` exactly as the engine does
    globally: fastest/slowest/spread and balance efficiency
    ``sum / (n * slowest) * 100``. An empty station set yields a neutral 100%
    balance with zero cycle metrics (no division by zero).
    """
    cycle_times = [s.effective_cycle_time for s in stations]
    if cycle_times:
        fastest = min(cycle_times)
        slowest = max(cycle_times)
        n_stations = len(cycle_times)
        balance_eff = (sum(cycle_times) / (n_stations * slowest)) * 100 if slowest > 0 else 100.0
    else:
        fastest = slowest = 0.0
        balance_eff = 100.0

    return LineBalanceMetrics(
        balance_efficiency=round(balance_eff, 1),
        takt_time=round(takt_time, 1) if takt_time else None,
        fastest_station_cycle=fastest,
        slowest_station_cycle=slowest,
        cycle_time_spread=round(slowest - fastest, 1),
    )


def _apply_bottleneck(stations: list[StationMetrics]) -> None:
    """Flag the bottleneck among a line's stations, scoped to the line.

    Reuses the engine's exact rule: the candidate is the station with the
    greatest ``effective_cycle_time`` (first wins ties in list order), and it is
    flagged only when the line's own maximum utilization reaches the 70%
    real-load gate. Mutates the passed ``StationMetrics`` copies in place; these
    are per-line copies, so the aggregate list is untouched.
    """
    candidate_id = ""
    candidate_ect = -1.0
    max_util = 0.0
    for sm in stations:
        if sm.utilization > max_util:
            max_util = sm.utilization
        if sm.effective_cycle_time > candidate_ect:
            candidate_ect = sm.effective_cycle_time
            candidate_id = sm.station_id

    real_bottleneck = (
        candidate_id
        if (candidate_id != "" and max_util >= _BOTTLENECK_UTILIZATION_THRESHOLD)
        else ""
    )
    for sm in stations:
        sm.is_bottleneck = (real_bottleneck != "" and sm.station_id == real_bottleneck)


def _largest_remainder_round(values: list[float], target_total: float) -> list[float]:
    """Round each value to 1 decimal so the rounded values sum to target_total.

    This is a deterministic largest-remainder (Hamilton) apportionment on a
    1-decimal grid. Each raw value is floored to its nearest lower 0.1 step; the
    leftover units (the difference between the rounded target total and the sum
    of floored values, measured in 0.1 steps) are handed out one at a time to
    the entries with the largest fractional remainders. Ties break by original
    index (stable), so two seeded runs always produce identical splits.

    The result sums to ``round(target_total, 1)`` exactly (on the 0.1 grid),
    which is what makes the per-line percentages reconstruct the station bucket
    percentage within the tolerance. An empty input returns an empty list; a
    non-positive target with all-zero values returns zeros.
    """
    n = len(values)
    if n == 0:
        return []

    # Work in integer tenths to avoid float drift, then convert back.
    target_tenths = int(round(target_total * 10))
    floors = [int(v * 10) for v in values]  # floor toward zero for non-negatives
    # Remainders are the fractional tenths left after flooring, keyed to index.
    remainders = [(v * 10) - floors[i] for i, v in enumerate(values)]
    base_sum = sum(floors)
    leftover = target_tenths - base_sum

    result_tenths = list(floors)
    if leftover > 0:
        # Hand out the leftover tenths to the largest remainders first; stable
        # tie-break by original index (ascending) via the (-, index) sort key.
        order = sorted(range(n), key=lambda i: (-remainders[i], i))
        for k in range(min(leftover, n)):
            result_tenths[order[k]] += 1
        # If leftover exceeds n (only possible with degenerate inputs), spread
        # any remaining tenths round-robin so the total is still exact.
        extra = leftover - n
        j = 0
        while extra > 0:
            result_tenths[order[j % n]] += 1
            extra -= 1
            j += 1
    elif leftover < 0:
        # Rare: flooring overshot (can happen with float noise). Remove tenths
        # from the SMALLEST remainders first, stable by index.
        order = sorted(range(n), key=lambda i: (remainders[i], i))
        need = -leftover
        k = 0
        while need > 0 and k < n * 2:
            idx = order[k % n]
            if result_tenths[idx] > 0:
                result_tenths[idx] -= 1
                need -= 1
            k += 1

    return [t / 10.0 for t in result_tenths]


def _line_operators_needed(
    line,
    line_stations: list[StationMetrics],
    served_lines_by_station: dict,
    station_line_raw: Optional[dict],
    effective_duration: float,
) -> float:
    """Compute this line's Operators_Needed at 0.1 resolution.

    For each station on the line, its ``work_content`` (operator-seconds) over
    the effective run window gives an operators-equivalent
    (``work_content / effective_duration``): the average number of operators
    concurrently needed at that station. A shared station's contribution is
    scaled by this line's processed share so labor is not double-counted across
    served lines (an even split when the station processed nothing); a dedicated
    station uses a full share of 1.0. Automated stations contribute 0 because
    ``work_content`` only accrues for manned operations. The line total is summed
    and rounded to 0.1. Returns 0.0 when the effective window is non-positive.
    """
    if effective_duration <= 0:
        return 0.0
    total = 0.0
    for sm in line_stations:
        raw = (station_line_raw or {}).get(sm.station_id) or {}
        work_content = raw.get("work_content", 0.0)
        ops_equiv = work_content / effective_duration
        if sm.is_shared:
            served = served_lines_by_station.get(sm.station_id, [line])
            processed = raw.get("processed", {})
            total_proc = sum(processed.get(l.line_id, 0) for l in served)
            if total_proc > 0:
                frac = processed.get(line.line_id, 0) / total_proc
            else:
                frac = (1.0 / len(served)) if served else 0.0
            ops_equiv *= frac
        total += ops_equiv
    return round(total, 1)


def _split_supplied_by_processed(
    supplied_operators: int,
    assignment: LineAssignment,
    station_line_raw: Optional[dict],
) -> dict[str, float]:
    """Split the whole-factory supplied operator pool across lines by processed share.

    Each line's processed total is the sum, over its stations, of that line's
    ``processed_by_line`` count (a shared station contributes only this line's
    slice). The supplied pool is apportioned in proportion to those totals, then
    rounded with ``_largest_remainder_round`` on the 0.1 grid so the per-line
    values sum to the supplied total within 0.1. When the grand total processed
    is 0 the pool is split evenly across lines. Returns a mapping of line_id to
    rounded value in the assignment's stable line order, or an empty dict when
    there are no lines.
    """
    line_ids = [ln.line_id for ln in assignment.lines]
    line_processed: list[float] = []
    for ln in assignment.lines:
        total = 0
        for sid in ln.station_ids:
            raw = (station_line_raw or {}).get(sid) or {}
            total += raw.get("processed", {}).get(ln.line_id, 0)
        line_processed.append(total)
    grand = sum(line_processed)
    if grand > 0:
        raw_supplied = [supplied_operators * p / grand for p in line_processed]
    elif line_ids:
        raw_supplied = [supplied_operators / len(line_ids)] * len(line_ids)
    else:
        return {}
    rounded = _largest_remainder_round(
        raw_supplied, round(float(supplied_operators), 1))
    return {lid: rounded[i] for i, lid in enumerate(line_ids)}


def _build_line_shares(
    station: StationMetrics,
    served_lines: list[ResolvedLine],
    raw: Optional[dict],
) -> list[LineTimeShare]:
    """Build the per-line ``LineTimeShare`` list for one station.

    ``served_lines`` is the ordered list of ResolvedLines this station serves
    (one entry for a dedicated station, one per served line for a shared one).
    ``raw`` is this station's entry from ``station_line_raw`` (or None).

    For each served line we convert its raw bucket seconds to a percentage of
    the STATION's ``max_capacity`` (not the line's), so summing a bucket across
    lines reconstructs the station's aggregate bucket percentage. Per-line idle
    is the residual: the station's aggregate idle seconds are apportioned across
    served lines by each line's processed share (an even split when the station
    processed nothing), then added to that line's own residual so per-line idle
    values sum to the station's aggregate idle. Finally a deterministic largest-
    remainder pass rounds each bucket so the per-line percentages sum to the
    station's aggregate bucket percentage within the 1-point tolerance.

    Per-line throughput is the raw processed count for that line
    (``processed_by_line``), matching StationMetrics.throughput which is a count.
    """
    if raw is None:
        return []

    max_capacity = raw.get("max_capacity", 0.0)
    busy_raw = raw.get("busy", {})
    blocked_raw = raw.get("blocked", {})
    starved_raw = raw.get("starved", {})
    down_raw = raw.get("down", {})
    processed_raw = raw.get("processed", {})

    line_ids = [ln.line_id for ln in served_lines]

    def pct(seconds: float) -> float:
        return (seconds / max_capacity * 100.0) if max_capacity > 0 else 0.0

    # Raw (unrounded) per-line percentages for the four measured buckets.
    busy_p = [pct(busy_raw.get(lid, 0.0)) for lid in line_ids]
    blocked_p = [pct(blocked_raw.get(lid, 0.0)) for lid in line_ids]
    starved_p = [pct(starved_raw.get(lid, 0.0)) for lid in line_ids]
    down_p = [pct(down_raw.get(lid, 0.0)) for lid in line_ids]

    # Station aggregate idle percentage is the residual of the four measured
    # buckets against 100 (floored at 0 for float noise). We apportion this
    # single idle pool across served lines by processed share so that the
    # per-line idle values sum back to the station aggregate idle.
    agg_idle = max(
        0.0,
        100.0 - station.utilization - station.blocked_pct
        - station.starved_pct - station.down_pct,
    )
    processed_counts = [processed_raw.get(lid, 0) for lid in line_ids]
    total_processed = sum(processed_counts)
    n = len(line_ids)
    if total_processed > 0:
        idle_p = [agg_idle * (c / total_processed) for c in processed_counts]
    elif n > 0:
        idle_p = [agg_idle / n] * n
    else:
        idle_p = []

    # Round each bucket with the largest-remainder pass so per-line values sum
    # to the STATION's aggregate rounded bucket within the 1-point tolerance.
    busy_r = _largest_remainder_round(busy_p, station.utilization)
    blocked_r = _largest_remainder_round(blocked_p, station.blocked_pct)
    starved_r = _largest_remainder_round(starved_p, station.starved_pct)
    down_r = _largest_remainder_round(down_p, station.down_pct)
    idle_r = _largest_remainder_round(idle_p, round(agg_idle, 1))

    shares: list[LineTimeShare] = []
    for i, ln in enumerate(served_lines):
        shares.append(LineTimeShare(
            line_id=ln.line_id,
            line_name=ln.name,
            busy_pct=max(0.0, min(busy_r[i], 100.0)),
            blocked_pct=max(0.0, min(blocked_r[i], 100.0)),
            starved_pct=max(0.0, min(starved_r[i], 100.0)),
            down_pct=max(0.0, min(down_r[i], 100.0)),
            idle_pct=max(0.0, min(idle_r[i], 100.0)),
            throughput=float(processed_raw.get(ln.line_id, 0)),
        ))
    return shares


def assemble_per_line_results(
    layout: Layout,
    assignment: LineAssignment,
    station_metrics_list: list[StationMetrics],
    buffer_metrics_list: list[BufferMetrics],
    *,
    throughput: float,
    avg_lead_time: float,
    wip_total: float,
    value_added_ratio: float,
    total_operators: int,
    labor_utilization: float,
    line_balance: LineBalanceMetrics,
    config: SimulationConfig,
    station_line_raw: Optional[dict] = None,
    completed_by_line: Optional[dict] = None,
    lead_times_by_line: Optional[dict] = None,
    hours: float = 0.0,
    effective_duration: float = 0.0,
    supplied_operators: int = 0,
) -> list[PerLineResult]:
    """Assemble one ``PerLineResult`` per resolved line (Increment A).

    Parameters
    ----------
    layout, assignment
        The layout and its resolved ``LineAssignment`` (from ``resolve_lines``).
    station_metrics_list, buffer_metrics_list
        The already-computed aggregate per-station and per-buffer metrics. This
        function copies (never mutates) the entries it groups per line.
    throughput, avg_lead_time, wip_total, value_added_ratio,
    total_operators, labor_utilization, line_balance
        The aggregate summary scalars and the aggregate line balance (the
        Whole_Factory_Rollup). Used verbatim for the single-line no-regression
        path, and as the basis for the multi-line approximation.
    config
        The simulation config, for the global target throughput fallback.
    station_line_raw
        Per-station raw per-line attribution from the engine, keyed by station
        id: ``{sid: {"max_capacity", "busy", "blocked", "starved", "down",
        "processed"}}``. Each bucket is a ``dict[line_id -> seconds]`` (or int
        counts for ``processed``) that sums to the station's aggregate bucket.
        When None, the Increment A approximation is used.
    completed_by_line
        Per-line completed physical-unit counts from the sink
        (``dict[line_id -> int]``). Divided by ``hours`` gives exact per-line
        throughput. When None, the aggregate/n_lines approximation is used.
    lead_times_by_line
        Per-line raw lead-time lists from the sink (``dict[line_id -> list]``).
        The mean is the exact per-line average lead time. When None, the
        aggregate stand-in is used.
    hours
        The post-warmup window in hours (``effective_duration / 3600``), used to
        convert per-line completed counts to units/hr exactly as the aggregate
        does.
    effective_duration
        The post-warmup window in seconds. Used to convert each station's
        ``work_content`` (operator-seconds) into an operators-equivalent so each
        line's ``operators_needed`` can be derived. 0.0 yields 0.0 needed.
    supplied_operators
        The resolved whole-factory operator-pool capacity. Split across lines by
        processed share to populate each line's ``operators_supplied`` so the
        per-line supplied values sum to the whole-factory supply within 0.1.

    Returns
    -------
    list[PerLineResult]
        One entry per resolved line, in the assignment's stable line order. An
        empty layout (no lines) returns an empty list.

    Notes
    -----
    With the Task 21 raw inputs present, multi-line per-line throughput, lead
    time, and WIP are EXACT tag-based values and ``line_shares`` carries each
    served line's split of every station. VA ratio and labor utilization remain
    the aggregate stand-in (out of this task's exact-split scope). Per-line
    ``operators_needed`` (from each station's Work_Content over the effective
    window, scaled by the line's processed share) and ``operators_supplied``
    (the whole-factory supplied pool split by processed share on the 0.1 grid)
    ARE computed here from the new ``effective_duration`` and ``supplied_operators``
    kwargs. Single-line assembly is exact (mirrors the aggregate) and still
    populates ``line_shares`` with each station's own full buckets as one entry
    (exact and harmless); its ``operators_needed``/``operators_supplied`` equal
    the whole-factory operators-equivalent and supplied picture.
    """
    if not assignment.lines:
        return []

    # Fast lookups from the aggregate metric lists.
    station_by_id: dict[str, StationMetrics] = {
        sm.station_id: sm for sm in station_metrics_list
    }
    buffer_by_id: dict[str, BufferMetrics] = {
        bm.buffer_id: bm for bm in buffer_metrics_list
    }

    is_single_line = len(assignment.lines) == 1
    global_target = config.target_throughput
    n_lines = len(assignment.lines)

    # Map station id -> the ordered ResolvedLines it serves, in the assignment's
    # stable line order. A dedicated station serves one line; a shared station
    # serves each line whose station_ids include it. Used to build line_shares
    # in a stable, deterministic order regardless of which line we are emitting.
    served_lines_by_station: dict[str, list[ResolvedLine]] = {}
    for ln in assignment.lines:
        for sid in ln.station_ids:
            served_lines_by_station.setdefault(sid, []).append(ln)

    # Split the whole-factory supplied operator pool across lines ONCE, by each
    # line's processed share, so per-line values sum to the supplied total on the
    # 0.1 grid. Keyed by line_id; looked up per line in the multi-line branch.
    supplied_by_line = _split_supplied_by_processed(
        supplied_operators, assignment, station_line_raw)

    results: list[PerLineResult] = []

    for line in assignment.lines:
        # ─── Stations for this line ──────────────────────────────────
        # A shared station appears in EACH served line's list. We copy the
        # aggregate StationMetrics (model_copy) so flagging is_shared / line_ids
        # / is_bottleneck per line never mutates the shared aggregate entry.
        line_stations: list[StationMetrics] = []
        shared_station_ids: list[str] = []
        for sid in line.station_ids:
            base = station_by_id.get(sid)
            if base is None:
                continue
            is_shared = bool(assignment.shared.get(sid, False))
            # Task 21: build the exact per-line split for this station. For a
            # dedicated station this is one entry (its own full buckets); for a
            # shared station it is one entry per served line, in stable line
            # order. Falls back to an empty list when raw attribution is absent.
            station_raw = station_line_raw.get(sid) if station_line_raw else None
            served_lines = served_lines_by_station.get(sid, [line])
            shares = _build_line_shares(base, served_lines, station_raw)
            sm_copy = base.model_copy(update={
                "is_shared": is_shared,
                "line_ids": list(assignment.element_lines.get(sid, [])),
                "line_shares": shares,
                "scrap_pct": base.scrap_pct,
                "setup_impact": base.setup_impact,
            })
            line_stations.append(sm_copy)
            if is_shared:
                shared_station_ids.append(sid)

        # Scope the bottleneck flag to this line's own stations.
        _apply_bottleneck(line_stations)

        # ─── Buffers for this line ───────────────────────────────────
        # A buffer belongs to exactly one line; its id is in line.element_ids.
        line_buffers: list[BufferMetrics] = []
        for eid in line.element_ids:
            bm = buffer_by_id.get(eid)
            if bm is not None:
                line_buffers.append(bm)

        # ─── Per-line target / takt / gap (task 4 helpers) ───────────
        effective_target = line_effective_target(line, global_target)
        effective_takt = line_effective_takt(line, global_target)

        # ─── Per-line summary scalars ────────────────────────────────
        if is_single_line:
            # No-regression path: the sole line EQUALS the aggregate exactly.
            line_throughput = throughput
            line_avg_lead = avg_lead_time
            line_wip = wip_total
            line_va_ratio = value_added_ratio
            line_operators = total_operators
            line_labor = labor_utilization
            per_line_balance = line_balance
            # The sole line's labor picture equals the aggregate exactly: sum
            # every station's operators-equivalent (work_content / effective
            # window), and take the whole supplied pool. Guard the window.
            if effective_duration > 0:
                line_operators_needed = round(sum(
                    ((station_line_raw or {}).get(sm.station_id) or {}).get(
                        "work_content", 0.0) / effective_duration
                    for sm in line_stations
                ), 1)
            else:
                line_operators_needed = 0.0
            line_operators_supplied = round(float(supplied_operators), 1)
        else:
            # Task 21: EXACT tag-based per-line throughput (units/hr) from the
            # sink's per-line completed count, converted with the SAME hours the
            # aggregate uses (throughput = completed / hours). Falls back to the
            # even-split approximation only when the sink accumulator is absent.
            if completed_by_line is not None and hours > 0:
                line_throughput = round(
                    completed_by_line.get(line.line_id, 0) / hours, 1)
            elif completed_by_line is not None:
                line_throughput = 0.0
            else:
                line_throughput = round(throughput / n_lines, 1) if n_lines > 0 else 0.0

            # EXACT per-line average lead time: the mean of this line's raw lead
            # times recorded at the sink. Empty (no completions) yields 0.0.
            # Falls back to the aggregate stand-in when the accumulator is absent.
            if lead_times_by_line is not None:
                lt = lead_times_by_line.get(line.line_id, [])
                line_avg_lead = round(sum(lt) / len(lt), 1) if lt else 0.0
            else:
                line_avg_lead = avg_lead_time

            # VA ratio stays the aggregate stand-in (a per-unit rate, out of this
            # task's exact-split scope).
            line_va_ratio = value_added_ratio

            # WIP is additive and scoped to this line's own elements: the sum of
            # this line's stations' average queue lengths plus this line's
            # buffers' average levels. A DEDICATED station contributes its full
            # avg_queue_length; a SHARED station's queue is split by this line's
            # processed share (processed_by_line for this station and line over
            # the station's total processed) so it is not double-counted in each
            # served line. When the station processed nothing, the queue is split
            # evenly across the lines it serves. Falls back to the full queue in
            # each line when raw attribution is absent.
            line_wip_stations = 0.0
            for sm in line_stations:
                sid = sm.station_id
                if not sm.is_shared:
                    line_wip_stations += sm.avg_queue_length
                    continue
                raw = station_line_raw.get(sid) if station_line_raw else None
                served = served_lines_by_station.get(sid, [line])
                if raw is not None:
                    processed = raw.get("processed", {})
                    total_proc = sum(processed.get(l.line_id, 0) for l in served)
                    if total_proc > 0:
                        frac = processed.get(line.line_id, 0) / total_proc
                    else:
                        frac = (1.0 / len(served)) if served else 0.0
                    line_wip_stations += sm.avg_queue_length * frac
                else:
                    line_wip_stations += sm.avg_queue_length
            line_wip = round(
                line_wip_stations + sum(bm.avg_level for bm in line_buffers),
                1,
            )
            # Operators: sum this line's stations' operator requirements from the
            # layout. Provisional (a shared station's operators are counted in
            # each served line until Increment B splits by processed_by_line).
            station_layout = {s.id: s for s in layout.stations}
            line_operators = sum(
                station_layout[sid].total_operators_required
                for sid in line.station_ids
                if sid in station_layout
            )
            # Labor utilization: reuse the aggregate as a provisional stand-in
            # (scoping labor to a line needs per-line work content from tags).
            line_labor = labor_utilization
            per_line_balance = _line_balance_for(line_stations, effective_takt)
            # Per-line labor picture: operators-equivalent from Work_Content
            # scaled by this line's processed share, and this line's slice of the
            # supplied pool split once above by processed share.
            line_operators_needed = _line_operators_needed(
                line, line_stations, served_lines_by_station,
                station_line_raw, effective_duration)
            line_operators_supplied = supplied_by_line.get(line.line_id, 0.0)

        # Guard the gap against a missing / non-positive target (helper returns
        # None in that case); round when present.
        raw_gap = line_throughput_gap(line_throughput, effective_target)
        throughput_gap_pct = round(raw_gap, 1) if raw_gap is not None else None

        results.append(PerLineResult(
            line_id=line.line_id,
            line_name=line.name,
            is_single_line=is_single_line,
            throughput=max(0.0, line_throughput),
            avg_lead_time=max(0.0, line_avg_lead),
            wip_total=max(0.0, line_wip),
            value_added_ratio=max(0.0, min(line_va_ratio, 100.0)),
            total_operators=max(0, line_operators),
            labor_utilization=max(0.0, min(line_labor, 100.0)),
            operators_needed=max(0.0, line_operators_needed),
            operators_supplied=max(0.0, line_operators_supplied),
            stations=line_stations,
            buffers=line_buffers,
            line_balance=per_line_balance,
            recommendations=[],  # per-line recs are filled by task 8.
            target_throughput=effective_target,
            takt_time=effective_takt,
            throughput_gap_pct=throughput_gap_pct,
            shared_station_ids=shared_station_ids,
        ))

    return results
