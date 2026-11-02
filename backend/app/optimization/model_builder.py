"""Pure MILP builder data containers for Auto-Optimize.

This module defines the solver-agnostic data structures that bridge the real
Layout and the MILP solver. Both dataclasses are PURE: they hold plain Python
values only, carry no solver objects, and import nothing from PuLP, Gurobi, or
FastAPI. This keeps them serializable and testable in isolation, and lets the
same OptModel feed any solver backend.

The field set mirrors the MILP formulation documented at
suite/optimization/line_optimization_formulation.ipynb (sets, parameters,
variables), which is the single source of truth for the math.

This module follows the project rule that no em dashes or en dashes appear
anywhere. Only ASCII hyphens are used, in prose, code, comments, and strings.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from ..simulation.lines import line_effective_takt, resolve_lines
from ..simulation.models import Layout, Operation, SimulationConfig, Station

# Default takt in seconds per unit, used only as a last resort when neither the
# line, the layout, nor the simulation config supplies a takt or target. Keeps
# the builder total so a solve is always possible rather than dividing by zero.
_DEFAULT_TAKT_SECONDS = 3600.0

# Seconds in one hour, used to convert a target throughput (units/hr) to takt.
_SECONDS_PER_HOUR = 3600.0


@dataclass(frozen=True)
class OptModel:
    """A solver-agnostic MILP instance built from a Layout and constraints.

    Carries the sets, parameters, and derived structures the solver needs and
    nothing else, so the same instance can be handed to any SolverBackend and
    compared or serialized freely in tests. All collections use stable,
    hashable keys (operation keys, station ids, line ids).

    Attributes:
        operations: O, the ordered list of stable operation keys.
        stations: S, the list of station ids.
        lines: L, the list of line ids (one member for the single-line case).
        ops_of_line: O_line, line id -> operations that belong to that line.
        stations_of_line: S_line, line id -> stations that serve that line.
        t: t_o, operation key -> cycle time in seconds (from Operation.cycle_time).
        r: r_o, operation key -> operators required (from Operation.operators_required).
        takt: T_line, line id -> takt in seconds per unit.
        rho: rho_s, station id -> availability in (0, 1] (Station.reliability / 100).
        is_machine_paced: station id -> True when a machine performs the work
            (has_machine), so its throughput capacity scales with MACHINES; False
            for a manual station, whose capacity scales with OPERATORS instead.
            The takt constraint uses machines for machine-paced stations and
            operators for manual ones, matching how the real line actually runs.
        n_max: N_max_s, station id -> per-station machine upper bound.
        n_min: N_min_s, station id -> per-station machine lower bound (floor),
            normally 1 so the optimizer may reduce an idle station's machines.
            The utilization ceiling keeps any reduction healthy and the service
            re-simulates and rejects a proposal that regresses throughput, so a
            reduction is both safe and the intended behavior.
        station_pos: pi(s), station id -> ordering position along its line.
        precedence: P, pairs (i, j) meaning operation i precedes operation j.
        locks: Lock pairs (o, s) pinning operation o to station s.
        operator_cap: K_op, the maximum total operators across the model.
        machine_cap: K_mc, the maximum total machines across the model.
        c_op: operator objective weight.
        c_mc: machine objective weight.
        big_m: M, the big-M constant for used-station linking.
        utilization_ceiling: the healthy load ceiling as a fraction in (0, 1]. A
            station may be loaded to at most this share of its takt capacity, so
            the takt constraint is sum t_o x_{o,s} <= ceiling * rho_s * T_line *
            m_s. Below 1.0 this reserves slack for variability and prevents the
            optimizer from driving a station to a bottleneck when trimming
            resources; 1.0 allows full-takt loading.
    """

    operations: list[str]
    stations: list[str]
    lines: list[str]
    ops_of_line: dict[str, list[str]]
    stations_of_line: dict[str, list[str]]
    t: dict[str, float]
    r: dict[str, int]
    takt: dict[str, float]
    rho: dict[str, float]
    n_max: dict[str, int]
    n_min: dict[str, int]
    is_machine_paced: dict[str, bool]
    station_pos: dict[str, int]
    precedence: list[tuple[str, str]]
    locks: list[tuple[str, str]]
    operator_cap: int
    machine_cap: int
    c_op: float
    c_mc: float
    big_m: int
    utilization_ceiling: float


@dataclass(frozen=True)
class SolveResult:
    """The outcome of solving an OptModel, independent of the solver used.

    Holds the status, the objective and optimality gap, and the decision
    variable values read back from the solver. It carries no solver objects so
    the service and the pure translation can consume it without any solver
    dependency.

    The status vocabulary is exactly:
        optimal             proven optimal within the time limit (gap_pct 0.00)
        feasible_timeout    time limit reached with a feasible incumbent
        infeasible          proven infeasible
        no_feasible_timeout time limit reached with no feasible solution found

    Attributes:
        status: one of the four status strings above.
        objective: the objective value, or None when no solution exists.
        gap_pct: the relative optimality gap as a percentage in [0.00, 100.00],
            or None when not applicable.
        x: assignment, (operation key, station id) -> 1 when assigned else 0.
        n: station id -> operators assigned at that station.
        m: station id -> parallel machines at that station.
        y: station id -> 1 when the station is used else 0.
    """

    status: str
    objective: Optional[float]
    gap_pct: Optional[float]
    x: dict[tuple[str, str], int] = field(default_factory=dict)
    n: dict[str, int] = field(default_factory=dict)
    m: dict[str, int] = field(default_factory=dict)
    y: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class ChangeListItem:
    """One plain-language difference between the current and proposed Layout.

    This is the pure, solver-agnostic and Pydantic-free data record produced by
    build_change_list. Its field names and the ``kind`` vocabulary match the
    OptimizeResponse ChangeListItem Pydantic model defined on the router exactly,
    so the service can hand these records straight across the API boundary with
    no remapping. It carries no I/O, no solver, and no FastAPI dependency.

    The ``kind`` vocabulary is exactly:
        operation_move  an operation whose owning station changed
        operator_delta  a station whose operator count changed
        machine_delta   a station whose machine count changed

    Attributes:
        kind: one of the three kind strings above.
        station_id: the station the change lands on. For operation_move this is
            the destination (to) station; for the deltas it is the station whose
            count changed.
        station_name: the display name of station_id.
        operation_name: the moved operation's name, set only for operation_move.
        from_station_id: the source station id, set only for operation_move.
        from_station_name: the source station's display name, for operation_move.
        delta: the signed change (new minus old), set only for the delta kinds.
        description: a plain-language one-line summary of the change.
    """

    kind: str
    station_id: str
    station_name: str
    description: str
    operation_name: Optional[str] = None
    from_station_id: Optional[str] = None
    from_station_name: Optional[str] = None
    delta: Optional[int] = None


# -----------------------------------------------------------------------
# LAYOUT -> OPTMODEL MAPPING (build_model)
# -----------------------------------------------------------------------

def _op_key(station_id: str, index: int) -> str:
    """Return the stable operation key of the form ``station_id index``.

    The key pairs the owning station id with the operation's position in that
    station's ordered operations list, so two operations that share a name never
    collide. Position zero is used for a station's synthetic fallback operation.
    """
    return f"{station_id} {index}"


def _collect_station_operations(station: Station) -> list[tuple[str, float, int]]:
    """Return (op_key, cycle_time, operators_required) for one station's operations.

    A station with a non-empty operations list contributes one entry per
    operation, keyed by position. A station with an empty operations list
    contributes a single synthetic operation built from the station's flat
    ``cycle_time`` and ``operators_required``, mirroring
    simulation/line_balancer._collect_operations so work content is conserved.
    """
    if station.operations:
        return [
            (_op_key(station.id, index), float(op.cycle_time), int(op.operators_required))
            for index, op in enumerate(station.operations)
        ]
    # Backward-compatible fallback: represent the flat station as one operation.
    return [(_op_key(station.id, 0), float(station.cycle_time), int(station.operators_required))]


def _resolve_takt(
    layout: Layout,
    assignment: Any,
    config: SimulationConfig,
) -> dict[str, float]:
    """Resolve the takt in seconds per unit for every resolved line.

    Priority per line, matching the app's existing takt definition: the line's
    own takt_time, else a takt derived from the line's target throughput, else
    the global SimulationConfig.takt_time, else a takt derived from
    SimulationConfig.target_throughput, else a safe default so the builder stays
    total. All derived values guard against a non-positive divisor.
    """
    global_target = config.target_throughput
    takt: dict[str, float] = {}
    for line in assignment.lines:
        # LineInfo.takt_time, else derived from the line/global target throughput.
        resolved = line_effective_takt(line, global_target)
        if resolved is None or resolved <= 0:
            # Fall back to the global config takt, then its target, then default.
            if config.takt_time is not None and config.takt_time > 0:
                resolved = float(config.takt_time)
            elif global_target is not None and global_target > 0:
                resolved = _SECONDS_PER_HOUR / float(global_target)
            else:
                resolved = _DEFAULT_TAKT_SECONDS
        takt[line.line_id] = float(resolved)
    return takt


def _station_positions(layout: Layout, station_ids: list[str]) -> dict[str, int]:
    """Return pi(s), each station's ordering position along the flow.

    Positions follow a topological order of the stations derived from the
    layout connections: an edge from station a to station b (directly, or
    through non-station flow elements such as buffers) places a before b. When
    no order can be derived, or when a cycle leaves stations unresolved, the
    stations list order is used as a stable fallback (notebook 7.3).
    """
    station_set = set(station_ids)
    list_pos = {sid: index for index, sid in enumerate(station_ids)}

    # Build a station-to-station adjacency by following connections through any
    # intervening non-station flow elements (sources, buffers, sinks).
    outgoing: dict[str, list[str]] = {}
    for conn in layout.connections:
        outgoing.setdefault(conn.source_id, []).append(conn.target_id)

    def _downstream_stations(start: str) -> list[str]:
        """Stations directly reachable from ``start`` without passing a station."""
        reached: list[str] = []
        seen: set[str] = set()
        stack = list(outgoing.get(start, []))
        while stack:
            node = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            if node in station_set:
                reached.append(node)
            else:
                stack.extend(outgoing.get(node, []))
        return reached

    adjacency: dict[str, set[str]] = {sid: set() for sid in station_ids}
    indegree: dict[str, int] = {sid: 0 for sid in station_ids}
    for sid in station_ids:
        for target in _downstream_stations(sid):
            if target in station_set and target not in adjacency[sid]:
                adjacency[sid].add(target)

    for sid in station_ids:
        for target in adjacency[sid]:
            indegree[target] += 1

    # Kahn's algorithm, breaking ties by the stations list order for stability.
    ready = sorted(
        (sid for sid in station_ids if indegree[sid] == 0),
        key=lambda s: list_pos[s],
    )
    order: list[str] = []
    indegree_work = dict(indegree)
    while ready:
        node = ready.pop(0)
        order.append(node)
        next_ready: list[str] = []
        for target in sorted(adjacency[node], key=lambda s: list_pos[s]):
            indegree_work[target] -= 1
            if indegree_work[target] == 0:
                next_ready.append(target)
        # Keep the ready frontier ordered by the stations list order.
        ready = sorted(ready + next_ready, key=lambda s: list_pos[s])

    if len(order) != len(station_ids):
        # A cycle or an underivable order: fall back to the stations list order.
        return dict(list_pos)

    return {sid: index for index, sid in enumerate(order)}


def _default_precedence(
    operations: list[str],
    op_station: dict[str, str],
    station_pos: dict[str, int],
) -> list[tuple[str, str]]:
    """Return the default precedence pairs from the current operation order.

    The default order follows the stations' flow positions (pi) and, within a
    station, the operations' list order. Each consecutive pair (i, j) in that
    global order becomes a precedence pair so that the current ordering is
    reproduced when the user supplies no edits (Req 2.2).
    """
    ordered = sorted(
        operations,
        key=lambda key: (station_pos.get(op_station[key], 0), key),
    )
    return [(ordered[i], ordered[i + 1]) for i in range(len(ordered) - 1)]


def build_model(layout: Layout, constraints: Any, config: SimulationConfig) -> OptModel:
    """Map a Layout plus optimize constraints into a pure, solver-agnostic OptModel.

    This is a pure function: given the same Layout, constraints, and config it
    returns the same OptModel, with no I/O and no solver dependency. It mirrors
    the MILP formulation documented at
    suite/optimization/line_optimization_formulation.ipynb (sets and parameters,
    notebook sections 2 and 3) and the design mapping list.

    Args:
        layout: the current Layout (stations, operations, lines, connections).
        constraints: the optimize constraints, a duck-typed object exposing
            precedence, locks, operator_cap, machine_cap,
            per_station_machine_limit, allow_add_machines, operator_weight, and
            machine_weight. Missing fields fall back to current-layout defaults.
        config: the SimulationConfig used to resolve takt when the line and
            layout do not supply one.

    Returns:
        An OptModel carrying the sets O, S, L, the per-line memberships, the
        parameters (t, r, takt, rho, n_max, station_pos), the precedence and
        lock pairs, the resource caps and objective weights, and the big-M.

    Raises:
        ValueError: when zero valid lines resolve from the layout.
    """
    assignment = resolve_lines(layout)

    # L, the set of lines. resolve_lines returns the degenerate single line for
    # a connected layout with no explicit lines. Zero resolved lines means there
    # is nothing to optimize against a takt.
    lines = [line.line_id for line in assignment.lines]
    if not lines:
        raise ValueError("At least one Line is required")

    # S, the set of stations, in layout order.
    stations = [station.id for station in layout.stations]
    station_by_id = {station.id: station for station in layout.stations}

    # O, the set of operations, with stable keys. Record each operation's cycle
    # time, operator requirement, and owning station.
    operations: list[str] = []
    t: dict[str, float] = {}
    r: dict[str, int] = {}
    op_station: dict[str, str] = {}
    station_ops: dict[str, list[str]] = {sid: [] for sid in stations}
    for station in layout.stations:
        for op_key, cycle_time, operators_required in _collect_station_operations(station):
            operations.append(op_key)
            t[op_key] = cycle_time
            r[op_key] = operators_required
            op_station[op_key] = station.id
            station_ops[station.id].append(op_key)

    # O_line and S_line from the resolved membership. This is where the general
    # single-line and multi-line formulation (Req 11.1) and shared-station
    # handling (Req 11.3, 11.4) are realized on the real Layout:
    #
    #   - Single-line degenerate case (Req 11.1): resolve_lines returns exactly
    #     one line for a connected layout with no explicit lines, so L has one
    #     member and every station lands in that single S_line. The multi-line
    #     mapping below produces the dedicated single-line model unchanged.
    #   - Shared_Station (Req 11.3): a station whose resolved line set has two or
    #     more lines (len(element_lines[sid]) >= 2) is added to S_line for every
    #     line it serves, so the solver writes one takt-capacity constraint per
    #     served line. Its operations are counted against each served line's
    #     takt (added to that line's O_line).
    #   - Dedicated station (Req 11.4): a station that serves exactly one line
    #     appears in exactly one S_line, so no combined shared-station constraint
    #     is generated for it; its single per-line takt constraint is the only
    #     capacity constraint it gets.
    #
    # Membership is de-duplicated per line so a station never appears twice in a
    # single S_line even if its declared line_ids repeats a line id, which would
    # otherwise double-count its work against that one line's takt.
    element_lines = assignment.element_lines
    stations_of_line: dict[str, list[str]] = {lid: [] for lid in lines}
    ops_of_line: dict[str, list[str]] = {lid: [] for lid in lines}
    for sid in stations:
        seen_lines: set[str] = set()
        for lid in element_lines.get(sid, []):
            if lid not in stations_of_line or lid in seen_lines:
                # Skip a line id outside the resolved set (kept well-formed by
                # resolve_lines) and skip a repeated line id for this station.
                continue
            seen_lines.add(lid)
            stations_of_line[lid].append(sid)
            ops_of_line[lid].extend(station_ops[sid])
        if not seen_lines and len(lines) == 1:
            # Defensive: a station that resolved to no line in a single-line
            # layout still belongs to the one degenerate line, so its takt
            # constraint is never silently dropped (Req 11.1).
            only_line = lines[0]
            stations_of_line[only_line].append(sid)
            ops_of_line[only_line].extend(station_ops[sid])

    # takt per line.
    takt = _resolve_takt(layout, assignment, config)

    # rho_s, station availability in (0, 1] from reliability percent.
    rho: dict[str, float] = {
        sid: station_by_id[sid].reliability / 100.0 for sid in stations
    }

    # Constraint inputs with current-layout defaults.
    current_operators = sum(
        station.total_operators_required for station in layout.stations
    )
    current_machines = sum(station.num_machines for station in layout.stations)

    # Operator and machine caps are OPTIONAL facility limits. A value of 0 (the
    # default) means "no artificial cap": the data and the utilization ceiling
    # decide how many resources the line needs, which is the user's point that
    # the facility reality, not a guessed ceiling, should drive the answer. When
    # the user does set a positive cap (a real hard limit such as payroll or
    # floor space), it is honored but never allowed below the current total, so
    # an existing line is never made infeasible by its own cap.
    _no_limit = max(current_operators, current_machines, 1) * 100 + 1000
    raw_operator_cap = int(getattr(constraints, "operator_cap", 0) or 0)
    raw_machine_cap = int(getattr(constraints, "machine_cap", 0) or 0)
    operator_cap = max(raw_operator_cap, int(current_operators), 1) if raw_operator_cap > 0 else max(int(current_operators), 1, _no_limit)
    machine_cap = max(raw_machine_cap, int(current_machines), 1) if raw_machine_cap > 0 else max(int(current_machines), 1, _no_limit)
    c_op = float(getattr(constraints, "operator_weight", 1.0))
    c_mc = float(getattr(constraints, "machine_weight", 1.0))
    # Healthy utilization ceiling (fraction of takt capacity). Clamped to a sane
    # (0, 1] range; a missing or out-of-range value falls back to 0.85.
    raw_ceiling = getattr(constraints, "utilization_ceiling", None)
    try:
        utilization_ceiling = float(raw_ceiling) if raw_ceiling is not None else 0.85
    except (TypeError, ValueError):
        utilization_ceiling = 0.85
    if not (0.0 < utilization_ceiling <= 1.0):
        utilization_ceiling = 0.85
    allow_add_machines = bool(getattr(constraints, "allow_add_machines", False))
    per_station_limit = getattr(constraints, "per_station_machine_limit", None)

    # Per-station machine bounds and the station TYPE, inferred from the data.
    # Three real station types, from has_machine plus the operator requirement
    # of the station's own operations:
    #
    #   - Manual (has_machine False): people do the work. Throughput scales with
    #     OPERATORS; machines do not drive it, so they are frozen at the current
    #     count (nothing to add or remove). No machine floor is imposed.
    #   - Automated (has_machine True, needs 0 operators): a machine runs the
    #     work unattended. Throughput scales with MACHINES. It must keep at least
    #     one machine to run (floor 1).
    #   - Hybrid (has_machine True, needs >= 1 operator): a machine does the work
    #     but an operator must tend it. Throughput scales with MACHINES, it keeps
    #     a machine floor of 1 ("must have a machine to run"), AND the staffing
    #     constraint (n_s >= sum r_o) forces enough operators to tend it. So a
    #     hybrid station genuinely needs BOTH a machine and operators, which the
    #     old binary model missed.
    #
    # is_machine_paced records whether capacity scales with machines (automated
    # and hybrid) or operators (manual); the solver's takt constraint reads it.
    safe_machine_bound = max(machine_cap, current_machines, 1)
    n_max: dict[str, int] = {}
    n_min: dict[str, int] = {}
    is_machine_paced: dict[str, bool] = {}
    for sid in stations:
        st = station_by_id[sid]
        current = max(1, st.num_machines)
        has_machine = bool(getattr(st, "has_machine", True))
        # Operator requirement of this station's own operations (the work that
        # starts here), used only to tell automated from hybrid.
        station_op_need = sum(int(r.get(key, 0)) for key in station_ops.get(sid, []))

        if not has_machine:
            # Manual: operator-paced, machines frozen.
            is_machine_paced[sid] = False
            n_min[sid] = current
            n_max[sid] = current
            continue

        # Automated or hybrid: machine-paced, must keep at least one machine to
        # run (floor 1). Hybrid additionally needs operators, which the staffing
        # constraint already enforces; recording station_op_need here documents
        # the distinction even though both share the same machine bounds.
        is_machine_paced[sid] = True
        _is_hybrid = station_op_need > 0  # noqa: F841  (documents the type)
        n_min[sid] = 1
        if not allow_add_machines:
            n_max[sid] = current
        elif per_station_limit is not None:
            n_max[sid] = max(current, int(per_station_limit))
        else:
            n_max[sid] = max(current, safe_machine_bound)

    # pi(s), station position along the flow.
    station_pos = _station_positions(layout, stations)

    # Precedence: default to the current operation order along pi(s), overridden
    # by the constraints' edited rules when supplied (Req 2.2, 2.12).
    edited_precedence = getattr(constraints, "precedence", None) or []
    if edited_precedence:
        precedence: list[tuple[str, str]] = [
            (getattr(rule, "before"), getattr(rule, "after")) for rule in edited_precedence
        ]
    else:
        precedence = _default_precedence(operations, op_station, station_pos)

    # Locks: empty by default, else from the constraints' Station_Locks
    # (Req 2.3, 2.12). Each lock pins an operation key to a station id.
    edited_locks = getattr(constraints, "locks", None) or []
    locks: list[tuple[str, str]] = [
        (getattr(lock, "operation"), getattr(lock, "station_id")) for lock in edited_locks
    ]

    # big-M for used-station linking: an upper bound on operators at any station,
    # safely the operator cap.
    big_m = max(operator_cap, 1)

    return OptModel(
        operations=operations,
        stations=stations,
        lines=lines,
        ops_of_line=ops_of_line,
        stations_of_line=stations_of_line,
        t=t,
        r=r,
        takt=takt,
        rho=rho,
        n_max=n_max,
        n_min=n_min,
        is_machine_paced=is_machine_paced,
        station_pos=station_pos,
        precedence=precedence,
        locks=locks,
        operator_cap=operator_cap,
        machine_cap=machine_cap,
        c_op=c_op,
        c_mc=c_mc,
        big_m=big_m,
        utilization_ceiling=utilization_ceiling,
    )


# -----------------------------------------------------------------------
# SOLUTION -> LAYOUT TRANSLATION (translate_solution)
# -----------------------------------------------------------------------

def _operation_by_key(layout: Layout) -> dict[str, Operation]:
    """Return a map from each stable operation key to its Operation object.

    The keys match exactly what build_model produced via _collect_station_operations:
    a station with a non-empty operations list contributes one Operation per
    position, keyed "station_id index"; a station with an empty operations list
    contributes a single synthetic Operation keyed "station_id 0", built from the
    station's flat cycle_time and operators_required. Real Operation objects are
    carried by identity (a deep copy) so cycle_time and operators_required are
    conserved exactly, mirroring how the APPLY_BALANCE reducer conserves
    Operation objects. Synthetic operations are materialized from the flat
    station fields, named after the station, matching
    simulation/line_balancer._collect_operations.
    """
    by_key: dict[str, Operation] = {}
    for station in layout.stations:
        if station.operations:
            for index, op in enumerate(station.operations):
                # Carry the real Operation object by identity (deep copy) so its
                # name, cycle_time, and operators_required are conserved.
                by_key[_op_key(station.id, index)] = op.model_copy(deep=True)
        else:
            # Synthetic fallback operation for an empty station, built from the
            # flat station fields so work content is conserved end to end.
            by_key[_op_key(station.id, 0)] = Operation(
                name=station.name,
                cycle_time=station.cycle_time,
                operators_required=station.operators_required,
            )
    return by_key


def translate_solution(
    layout: Layout,
    model: OptModel,
    solve_result: SolveResult,
) -> Layout:
    """Translate a SolveResult into a NEW proposed Layout, leaving the input intact.

    This is a pure function. It starts from a deep copy of the current layout so
    every field the optimizer does not decide is preserved exactly: station
    names, x and y positions, line_ids, connections, sources, sinks, buffers,
    operator pools, and all line settings (Req 9.4, 9.5). It never writes or
    recomputes x or y, and it does not mutate the input layout.

    The function rewrites only the three things the MILP decides:

      - Station contents: each operation is reassigned to the station s where
        x_{o,s} == 1, carrying its Operation object by identity matched on the
        stable operation key so cycle_time and operators_required are conserved
        (mirrors APPLY_BALANCE).
      - Operator counts: each station's flat operators_required is set to the
        solver's station operator allotment n_s.
      - Machine counts: each station's num_machines is set to the solver's m_s.

    An operation with no assigned station in the solution (no x_{o,s} == 1) stays
    on its original owning station, so no work content is ever dropped.

    Args:
        layout: the current Layout to translate from (never mutated).
        model: the OptModel whose operation keys and station ids the solution
            indexes; used to enumerate operations and stations deterministically.
        solve_result: the SolveResult holding the assignment x and the per-station
            operator counts n and machine counts m.

    Returns:
        A new Layout reflecting the optimized assignment and counts, with every
        unrelated field and all x and y coordinates preserved from the input.
    """
    proposed = layout.model_copy(deep=True)

    # Index the proposed stations by id for in-place content and count updates.
    station_by_id = {station.id: station for station in proposed.stations}

    # The Operation object (by key) to place, sourced from the ORIGINAL layout so
    # identity and work content are conserved regardless of how the proposed copy
    # is rewritten below.
    operation_by_key = _operation_by_key(layout)

    # The original owning station of each operation key, used as a stable
    # fallback when the solution does not assign the operation anywhere.
    original_station_of: dict[str, str] = {}
    for op_key in model.operations:
        station_id, _, position = op_key.rpartition(" ")
        original_station_of[op_key] = station_id

    # Rebuild each proposed station's operations list from the assignment. Start
    # every station empty, then append operations in the OptModel's stable
    # operation order so the result is deterministic.
    new_operations: dict[str, list[Operation]] = {sid: [] for sid in station_by_id}
    for op_key in model.operations:
        assigned_station: Optional[str] = None
        for station_id in model.stations:
            if solve_result.x.get((op_key, station_id), 0) == 1:
                assigned_station = station_id
                break
        if assigned_station is None:
            # No assignment in the solution: keep the operation on its original
            # station so its work content is never lost.
            assigned_station = original_station_of.get(op_key)
        if assigned_station is None or assigned_station not in new_operations:
            # Defensive: an operation that maps to no known station is dropped
            # rather than crashing; this cannot happen for a feasible solution.
            continue
        op = operation_by_key.get(op_key)
        if op is not None:
            new_operations[assigned_station].append(op)

    for station in proposed.stations:
        # Operation contents: the reassigned, identity-conserved Operation list.
        station.operations = new_operations.get(station.id, [])
        # Machine count: the solver's m_s, clamped to the model's floor of one.
        machines = solve_result.m.get(station.id)
        if machines is not None:
            station.num_machines = max(1, int(machines))
        # Operator count: the solver's station operator allotment n_s. This is the
        # station-level staffing; per-operation operators_required are preserved
        # on the moved Operation objects themselves.
        operators = solve_result.n.get(station.id)
        if operators is not None:
            station.operators_required = max(0, int(operators))

    return proposed


# -----------------------------------------------------------------------
# CHANGE-LIST DIFF (build_change_list)
# -----------------------------------------------------------------------

def _operation_station_map(layout: Layout) -> dict[tuple[str, float, int, int], str]:
    """Map each operation instance to the id of the station that holds it.

    An operation instance is keyed by its content tuple plus an occurrence index
    so duplicate operations that share a name, cycle time, and operator
    requirement are matched one-for-one across the current and proposed layouts
    rather than collapsing into a single entry. The occurrence index counts how
    many identical operations have already been seen, scanning stations in
    layout order and operations in list order, so the same physical operation
    lands under the same key in both layouts and a genuine move is detected.

    A station with an empty operations list contributes its synthetic operation,
    built from the flat ``cycle_time`` and ``operators_required`` and named after
    the station, matching how build_model and translate_solution treat flat
    stations so a move to or from a flat station is still diffed faithfully.
    """
    seen: dict[tuple[str, float, int], int] = {}
    mapping: dict[tuple[str, float, int, int], str] = {}
    for station in layout.stations:
        if station.operations:
            instances = [
                (op.name, float(op.cycle_time), int(op.operators_required))
                for op in station.operations
            ]
        else:
            instances = [
                (station.name, float(station.cycle_time), int(station.operators_required))
            ]
        for content in instances:
            occurrence = seen.get(content, 0)
            seen[content] = occurrence + 1
            mapping[(content[0], content[1], content[2], occurrence)] = station.id
    return mapping


def build_change_list(
    current_layout: Layout,
    proposed_layout: Layout,
) -> list[ChangeListItem]:
    """Diff a proposed Layout against the current Layout into ChangeListItem records.

    This is a pure function with no I/O, no solver, and no FastAPI dependency. It
    compares the two layouts and reports exactly the differences the optimizer is
    allowed to make (Req 7.2, 7.3, 7.4):

      - operation_move: one record for every operation whose owning station
        differs between the current and proposed layouts, naming the operation,
        the from-station, and the to-station (Req 7.2).
      - operator_delta: one record for every station whose operator count changed,
        carrying the signed delta of new minus old (Req 7.3).
      - machine_delta: one record for every station whose num_machines changed,
        carrying the signed delta of new minus old (Req 7.4).

    When the proposed layout is equivalent to the current layout, no difference is
    found and an empty list is returned so the service can state that no changes
    are proposed (Req 7.5).

    The station operator count compared here is the station's effective staffing,
    the sum of its operations' operators_required (falling back to the flat
    operators_required for a station with no operations), which is the count the
    canvas and the simulation use.

    Args:
        current_layout: the Layout before optimization (the baseline).
        proposed_layout: the Layout produced by translate_solution.

    Returns:
        The list of ChangeListItem records, in a deterministic order:
        operation moves first (by operation occurrence), then operator deltas,
        then machine deltas, both deltas in current-layout station order.
    """
    current_station_by_id = {s.id: s for s in current_layout.stations}
    proposed_station_by_id = {s.id: s for s in proposed_layout.stations}

    def _station_name(station_id: str) -> str:
        """Return a display name for a station id, preferring the proposed layout."""
        station = proposed_station_by_id.get(station_id) or current_station_by_id.get(station_id)
        return station.name if station is not None else station_id

    changes: list[ChangeListItem] = []

    # Operation moves: match each operation instance across the two layouts by its
    # content-plus-occurrence key and report the ones whose station changed.
    current_ops = _operation_station_map(current_layout)
    proposed_ops = _operation_station_map(proposed_layout)
    for key, from_station_id in current_ops.items():
        to_station_id = proposed_ops.get(key)
        if to_station_id is None or to_station_id == from_station_id:
            # The operation stayed put (or vanished, which a faithful solve never
            # does because translate_solution conserves every operation).
            continue
        operation_name = key[0]
        from_name = _station_name(from_station_id)
        to_name = _station_name(to_station_id)
        changes.append(
            ChangeListItem(
                kind="operation_move",
                station_id=to_station_id,
                station_name=to_name,
                operation_name=operation_name,
                from_station_id=from_station_id,
                from_station_name=from_name,
                description=f"Move operation '{operation_name}' from {from_name} to {to_name}",
            )
        )

    # Operator and machine deltas: compare each station present in both layouts,
    # in current-layout order for a stable, deterministic result.
    for station in current_layout.stations:
        proposed_station = proposed_station_by_id.get(station.id)
        if proposed_station is None:
            continue

        old_operators = station.total_operators_required
        new_operators = proposed_station.total_operators_required
        if new_operators != old_operators:
            delta = new_operators - old_operators
            sign = "+" if delta > 0 else ""
            changes.append(
                ChangeListItem(
                    kind="operator_delta",
                    station_id=station.id,
                    station_name=proposed_station.name,
                    delta=delta,
                    description=(
                        f"Change operators at {proposed_station.name} by {sign}{delta} "
                        f"(from {old_operators} to {new_operators})"
                    ),
                )
            )

        old_machines = station.num_machines
        new_machines = proposed_station.num_machines
        if new_machines != old_machines:
            delta = new_machines - old_machines
            sign = "+" if delta > 0 else ""
            changes.append(
                ChangeListItem(
                    kind="machine_delta",
                    station_id=station.id,
                    station_name=proposed_station.name,
                    delta=delta,
                    description=(
                        f"Change machines at {proposed_station.name} by {sign}{delta} "
                        f"(from {old_machines} to {new_machines})"
                    ),
                )
            )

    return changes
