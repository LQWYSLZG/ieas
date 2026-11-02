"""Service helpers for the Auto-Optimize pipeline.

This module holds the orchestration-side helpers that glue the pure MILP builder
(model_builder.py) and the solver (solver.py) to the existing simulation
building blocks. Task 6.1 adds the warm start: a feasible starting point for the
solver derived from the existing line balancer (simulation/line_balancer.py).

The warm start only SEEDS the search. It hands the solver an early incumbent so
CBC can improve its first bound under the 30 second limit. It never changes the
feasible region: every value it produces is a hint the solver is free to keep or
discard. If the balancer output cannot be mapped cleanly onto the OptModel's
station ids, the helper degrades gracefully and returns a partial seed (or no
seed at all) rather than a malformed or infeasible one.

The line balancer is reused unchanged. This module imports balance_line and
reads its proposal; it never modifies line_balancer.py.

This module follows the project rule that no em dashes or en dashes appear
anywhere. Only ASCII hyphens are used, in prose, code, comments, and strings.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Optional

from ..simulation.engine import run_simulation
from ..simulation.line_balancer import balance_line
from ..simulation.lines import resolve_lines
from ..simulation.models import (
    Layout,
    Operation,
    SimulationConfig,
    SimulationResult,
    Station,
)
from .diagnosis import diagnose_infeasibility
from .model_builder import (
    ChangeListItem,
    OptModel,
    build_change_list,
    build_model,
    translate_solution,
)
from .solver import get_solver

# The hard wall-clock solve limit handed to the solver on every run (Req 5.1).
# The whole optimize request stays within 60 seconds (Req 5.5): a 30 second
# solve plus two short simulations plus bounded diagnosis all fit comfortably,
# and nothing below adds an unbounded step.
_SOLVER_TIME_LIMIT_S = 30.0

# The five status strings run_optimize can return. The first four come straight
# from the solver (via SolveResult.status); validation_failed is added here when
# the AFTER simulation rejects the proposed layout (Req 4.3).
_STATUS_OPTIMAL = "optimal"
_STATUS_FEASIBLE_TIMEOUT = "feasible_timeout"
_STATUS_INFEASIBLE = "infeasible"
_STATUS_NO_FEASIBLE_TIMEOUT = "no_feasible_timeout"
_STATUS_VALIDATION_FAILED = "validation_failed"
# Returned when the MILP finds a feasible plan but the real simulation scores it
# no better than (or worse than) the current layout. The MILP capacity model is
# a simplification and can propose changes the simulation does not reward, so the
# simulation is the final arbiter: a proposal that does not genuinely help is not
# presented as an optimization (see the guardrail in run_optimize).
_STATUS_NO_IMPROVEMENT = "no_improvement"

# Throughput tolerance for the guardrail. The proposed layout must simulate to a
# throughput at least this fraction of the current layout's throughput to be
# offered; otherwise the current layout is kept. A tiny slack absorbs the
# simulation's run-to-run noise so an essentially-equal plan is not rejected on
# rounding alone, while any real regression is caught.
_THROUGHPUT_KEEP_FRACTION = 0.995

# A fixed RNG seed used for BOTH the before and after simulations so the review
# comparison is deterministic and apples-to-apples. Any constant works; the
# point is that the two runs share it, so identical layouts simulate identically
# (true zero delta) and only real layout changes move the numbers.
_COMPARISON_SEED = 12345


# The warm start dict shape the solver already accepts. The keys are:
#   "x": {(operation_key, station_id): 0 or 1}  assignment seed
#   "n": {station_id: operators}                operators-per-station seed
#   "m": {station_id: machines}                 machines-per-station seed
# PulpCbcSolver._apply_warm_start reads exactly these keys and ignores anything
# missing, so a partial seed is always safe.
WarmStart = dict


def build_warm_start(
    layout: Layout,
    model: OptModel,
) -> Optional[WarmStart]:
    """Build a solver warm start from the line balancer, or None when none applies.

    For a single line (the degenerate one-line case) the balancer runs once over
    that line's operations with the line's takt. For multiple lines the balancer
    runs PER LINE over just that line's operations, each with that line's own
    takt, so a shared operation space is never balanced against the wrong takt.

    The balancer proposes NEW workstation bins keyed by name, not the OptModel's
    existing station ids. This helper maps those logical bins onto the line's
    real station ids in order: bin 1 seeds the line's first station, bin 2 the
    second, and so on. The mapping is only a hint, so when there are more bins
    than stations on a line the extra bins are packed onto the last station; the
    solver is free to move operations afterward.

    From each station's seeded operations the helper derives:
      - x: 1 for (operation_key, station_id) when that operation is seeded onto
        that station, else the assignment is simply left unseeded (absent).
      - n: the sum of operators_required across the operations seeded onto the
        station, so staffing meets the seeded need (mirrors constraint 7.5).
      - m: the machines needed to hold the seeded work within takt, a ceil of
        work over (rho_s * takt), clamped to the model's [1, N_max_s] bound, so
        the seed respects the takt-capacity and machine-bound constraints.

    Args:
        layout: the current Layout the OptModel was built from. Used to recover
            each operation's Operation object by its stable operation key.
        model: the OptModel whose operation keys, station ids, per-line
            memberships, takt, rho, and n_max bounds the seed must line up with.

    Returns:
        A warm start dict with keys "x", "n", and "m", or None when no usable
        seed could be produced (for example a line whose balancer output is
        best-effort, which signals that no feasible within-takt start exists).
    """
    # Recover each stable operation key's Operation object from the model and
    # the layout, so the per-line balancer can be run over real operations and
    # the seeded operators_required is the genuine per-operation requirement.
    op_object = _operations_by_key(layout, model)

    seed_x: dict[tuple[str, str], int] = {}
    seed_n: dict[str, int] = {}
    seed_m: dict[str, int] = {}

    produced_any = False

    for line in model.lines:
        takt = model.takt.get(line, 0.0)
        line_stations = model.stations_of_line.get(line, [])
        line_ops = model.ops_of_line.get(line, [])
        if takt <= 0 or not line_stations or not line_ops:
            # Nothing to seed for a line with no takt, no station, or no work.
            continue

        # Build a throwaway single-station layout holding this line's operations
        # so balance_line packs them against this line's takt. The balancer only
        # reads station.operations (and the flat fallback), so one carrier
        # station is enough and conserves every operation's work content.
        carrier_ops = [op_object[key] for key in line_ops if key in op_object]
        if not carrier_ops:
            continue
        carrier_layout = _carrier_layout(carrier_ops)

        proposal = balance_line(carrier_layout, takt)
        if proposal.best_effort or not proposal.assignment:
            # best_effort means an operation exceeds takt, so no feasible
            # within-takt start exists for this line. Skip it and let the solver
            # (and later the diagnosis) handle the hard case; seeding a bin that
            # overruns takt would be a malformed, misleading hint.
            continue

        # Map the balancer's name-keyed bins onto this line's real station ids in
        # order. Operation names can repeat, so match by consuming operations in
        # the model's stable key order per name, keeping the seed one-for-one.
        line_seeded = _seed_line(
            proposal_assignment=proposal.assignment,
            line_ops=line_ops,
            line_stations=line_stations,
            op_object=op_object,
            takt=takt,
            model=model,
            seed_x=seed_x,
            seed_n=seed_n,
            seed_m=seed_m,
        )
        produced_any = produced_any or line_seeded

    if not produced_any:
        return None
    return {"x": seed_x, "n": seed_n, "m": seed_m}


def _operations_by_key(layout: Layout, model: OptModel) -> dict[str, Operation]:
    """Return a map from each stable operation key to its Operation object.

    Mirrors model_builder's own key scheme: a station with a non-empty
    operations list contributes one Operation per position keyed
    "station_id index"; a station with an empty operations list contributes a
    single synthetic Operation keyed "station_id 0", built from the station's
    flat cycle_time and operators_required. Only keys present in the model are
    returned, so a stale layout never seeds an unknown key.
    """
    by_key: dict[str, Operation] = {}
    for station in layout.stations:
        if station.operations:
            for index, op in enumerate(station.operations):
                by_key[f"{station.id} {index}"] = op.model_copy(deep=True)
        else:
            by_key[f"{station.id} 0"] = Operation(
                name=station.name,
                cycle_time=station.cycle_time,
                operators_required=station.operators_required,
            )
    model_keys = set(model.operations)
    return {key: op for key, op in by_key.items() if key in model_keys}


def _carrier_layout(operations: list[Operation]) -> Layout:
    """Wrap operations in a one-station Layout for the balancer to pack.

    The carrier station exists only to carry the operations into balance_line,
    which reads station.operations and repacks them into its own bins. The
    carrier's own fields never reach the warm start.
    """
    carrier = Station(
        id="warm_start_carrier",
        name="warm_start_carrier",
        x=0.0,
        y=0.0,
        cycle_time=1.0,
        num_machines=1,
        operators_required=0,
        operations=[op.model_copy(deep=True) for op in operations],
    )
    return Layout(stations=[carrier])


def _seed_line(
    proposal_assignment: dict[str, list[str]],
    line_ops: list[str],
    line_stations: list[str],
    op_object: dict[str, Operation],
    takt: float,
    model: OptModel,
    seed_x: dict[tuple[str, str], int],
    seed_n: dict[str, int],
    seed_m: dict[str, int],
) -> bool:
    """Seed one line's x, n, and m from a balancer proposal. Returns True on use.

    Walks the balancer's bins in insertion order, mapping bin i onto the line's
    i-th station id. Extra bins beyond the station count fold onto the last
    station so no operation is dropped from the seed. Operation names are matched
    to the model's stable keys one-for-one, in the model's key order, so
    duplicate names seed distinct operations. The resulting per-station x, n, and
    m are written into the shared seed dicts and reported as used.
    """
    if not line_stations:
        return False

    # Pre-group this line's operation keys by operation name, in model key order,
    # so each name maps to its ordered list of keys for one-for-one consumption.
    keys_by_name: dict[str, list[str]] = {}
    for key in line_ops:
        op = op_object.get(key)
        if op is None:
            continue
        keys_by_name.setdefault(op.name, []).append(key)
    consumed: dict[str, int] = {name: 0 for name in keys_by_name}

    # station_id -> list of operation keys seeded onto it.
    station_keys: dict[str, list[str]] = {sid: [] for sid in line_stations}

    bins = list(proposal_assignment.values())
    for bin_index, op_names in enumerate(bins):
        # Fold any overflow bins onto the last real station on this line.
        station_slot = min(bin_index, len(line_stations) - 1)
        station_id = line_stations[station_slot]
        for name in op_names:
            available = keys_by_name.get(name, [])
            used = consumed.get(name, 0)
            if used >= len(available):
                # The proposal named an operation the model does not carry on
                # this line (a stale or duplicate name). Skip it rather than seed
                # a key that does not exist, keeping the seed well-formed.
                continue
            key = available[used]
            consumed[name] = used + 1
            station_keys[station_id].append(key)

    seeded_any = False
    for station_id, keys in station_keys.items():
        if not keys:
            continue
        seeded_any = True
        # x: assign each seeded operation onto this station.
        for key in keys:
            seed_x[(key, station_id)] = 1
        # n: operators needed is the sum of the seeded operations' requirements,
        # so staffing meets the seeded assignment (mirrors constraint 7.5).
        operators = sum(int(op_object[key].operators_required) for key in keys)
        seed_n[station_id] = operators
        # m: machines needed to hold the seeded work within takt, clamped to the
        # model's [1, N_max_s] bound so the seed respects the machine bound and
        # the takt-capacity constraint.
        work = sum(float(op_object[key].cycle_time) for key in keys)
        rho = model.rho.get(station_id, 1.0)
        capacity_per_machine = rho * takt
        if capacity_per_machine > 0:
            needed = max(1, math.ceil(work / capacity_per_machine))
        else:
            needed = 1
        floor = max(1, int(model.n_min.get(station_id, 1)))
        upper = max(floor, int(model.n_max.get(station_id, 1)))
        # Seed at least the machine floor so the start respects the lower bound,
        # and never above the ceiling.
        seed_m[station_id] = min(upper, max(floor, needed))

    return seeded_any


# -----------------------------------------------------------------------
# SERVICE ORCHESTRATOR (run_optimize)
# -----------------------------------------------------------------------

@dataclass(frozen=True)
class OptimizeResult:
    """The end-to-end outcome of an Auto-Optimize run, ready to wrap in Pydantic.

    This is the pure, solver-free and FastAPI-free return value of run_optimize.
    Its field names match the OptimizeResponse Pydantic model (design Data
    Models) exactly, so the router's response model can wrap an OptimizeResult
    with no remapping: status, proposed_layout, before_metrics, after_metrics,
    change_list, optimality_gap_pct, binding_category, and message.

    Only the fields that apply to a given status are populated:

      - optimal: before_metrics, after_metrics, proposed_layout, change_list,
        and optimality_gap_pct 0.00.
      - feasible_timeout: the same as optimal, with optimality_gap_pct carrying
        the reported gap in [0.00, 100.00].
      - infeasible: binding_category and message only; no proposed_layout and no
        after_metrics (Req 6.5). before_metrics is still carried so the caller
        has the baseline it already computed.
      - no_feasible_timeout: message only; no proposed_layout and no after
        metrics (Req 5.4). before_metrics is still carried.
      - validation_failed: message only; no after_metrics presented as success
        (Req 4.3). before_metrics and the proposed_layout are carried so the
        caller can show what was attempted without claiming validation passed.

    Attributes:
        status: one of optimal, feasible_timeout, infeasible,
            no_feasible_timeout, validation_failed.
        proposed_layout: the optimized Layout, or None when no proposal applies.
        before_metrics: the simulated metrics of the current layout (Req 4.2).
        after_metrics: the simulated metrics of the proposed layout, present only
            when validation of the proposal succeeded (Req 4.1, 4.3).
        change_list: the plain-language diff from current to proposed (Req 7).
        optimality_gap_pct: the gap as a percentage in [0.00, 100.00], present
            for optimal (0.00) and feasible_timeout (Req 5.2).
        binding_category: the one binding constraint category, present only for
            infeasible (Req 6.2).
        message: a plain-language message, set for the non-success statuses.
    """

    status: str
    proposed_layout: Optional[Layout] = None
    before_metrics: Optional[SimulationResult] = None
    after_metrics: Optional[SimulationResult] = None
    change_list: list[ChangeListItem] = field(default_factory=list)
    optimality_gap_pct: Optional[float] = None
    binding_category: Optional[str] = None
    message: str = ""


def run_optimize(
    layout: Layout,
    constraints: Any,
    config: SimulationConfig,
) -> OptimizeResult:
    """Run the Auto-Optimize pipeline end to end and return a reviewable result.

    This is the single orchestration point for Auto-Optimize. It is the only
    place that calls the solver, the line balancer (via build_warm_start), and
    the simulation, keeping the router thin. The steps run in the exact order
    the design gives (design Service Orchestrator):

      1. Resolve lines and takt, raising ValueError when zero lines resolve
         (Req 11.5). build_model performs the same line check; this early mirror
         keeps the failure cheap and before any simulation runs.
      2. Compute the BEFORE metrics by simulating the current layout (Req 4.2).
      3. Build the pure OptModel from the layout plus constraints.
      4. Produce a warm start from the line balancer (seeds the solver only).
      5. Solve with a hard 30 second wall-clock limit (Req 5.1).
      6. Branch on the solve status:
           - optimal / feasible_timeout: translate the solution into a proposed
             layout, simulate it for the AFTER metrics (Req 4.1), diff it into a
             change list, and return it with the gap when feasible_timeout.
           - infeasible: diagnose one binding category and return it with no
             proposed layout and no after metrics (Req 6.1 to 6.5).
           - no_feasible_timeout: return that status with a message and no layout
             (Req 5.4).
      7. If the AFTER simulation rejects the proposed layout (run_simulation
         raises ValueError), return validation_failed WITHOUT presenting after
         metrics as a success (Req 4.3).

    The whole request stays within 60 seconds (Req 5.5): a bounded 30 second
    solve plus two short simulations plus bounded diagnosis, with no unbounded
    step added here.

    Args:
        layout: the current Layout to optimize (never mutated).
        constraints: the optimize constraints (duck-typed; passed to build_model).
        config: the SimulationConfig used for both simulations and for takt
            resolution when a line does not supply one.

    Returns:
        An OptimizeResult whose status and populated fields match the design
        OptimizeResponse shape, ready to wrap in the Pydantic response model.

    Raises:
        ValueError: when zero valid lines resolve from the layout (Req 11.5).
            The router maps this to a 422 response.
    """
    # 1. Resolve lines and takt. Zero lines means there is nothing to optimize
    #    against a takt, so reject before any heavier work (Req 11.5). This
    #    mirrors the line check build_model performs with the same message.
    assignment = resolve_lines(layout)
    if not assignment.lines:
        raise ValueError("At least one Line is required")

    # 2. BEFORE metrics from the current layout (Req 4.2). run_simulation itself
    #    validates the layout and raises ValueError on an invalid one, which the
    #    router maps to a 422, matching the existing /run behavior.
    #
    #    The before and after simulations share one FIXED seed so the comparison
    #    is apples-to-apples. The simulation is otherwise non-deterministic, so
    #    two runs of the SAME layout would differ by random noise; seeding both
    #    runs identically means an unchanged layout shows a true zero delta and a
    #    changed layout shows only the real difference, never phantom noise. The
    #    seed lives on a copy so the caller's config is untouched.
    sim_config = config.model_copy(update={"seed": _COMPARISON_SEED})
    before_metrics = run_simulation(layout, sim_config)

    # 3. Build the pure OptModel. build_model also re-checks for zero lines and
    #    raises the same ValueError, so the contract holds even if resolution
    #    somehow differs.
    model = build_model(layout, constraints, config)

    # 4. Warm start from the line balancer. This only seeds the solver's search;
    #    None is fine and simply means CBC starts cold.
    warm_start = build_warm_start(layout, model)

    # 5. Solve with the hard 30 second limit (Req 5.1). get_solver() defaults to
    #    the PuLP/CBC backend, so the production path never imports gurobipy.
    solve_result = get_solver().solve(
        model,
        time_limit_s=_SOLVER_TIME_LIMIT_S,
        warm_start=warm_start,
    )

    # 6. Branch on the solve status.
    status = solve_result.status

    if status in (_STATUS_OPTIMAL, _STATUS_FEASIBLE_TIMEOUT):
        # Translate the solution into a proposed layout, preserving x and y and
        # all unrelated data (translate_solution is pure and starts from a deep
        # copy). Then simulate the proposal for the AFTER metrics (Req 4.1).
        proposed_layout = translate_solution(layout, model, solve_result)

        try:
            after_metrics = run_simulation(proposed_layout, sim_config)
        except ValueError as exc:
            # 7. The proposed layout failed validation inside the engine. Report
            #    that validation did not complete and do NOT present after
            #    metrics as a success (Req 4.3). The proposed layout and the
            #    before metrics are carried so the caller can show what was
            #    attempted without claiming the proposal was validated.
            return OptimizeResult(
                status=_STATUS_VALIDATION_FAILED,
                proposed_layout=proposed_layout,
                before_metrics=before_metrics,
                after_metrics=None,
                change_list=[],
                message=(
                    "The proposed configuration could not be validated by the "
                    f"simulation: {exc}"
                ),
            )

        # GUARDRAIL: the simulation is the final arbiter. The MILP capacity
        # model is a simplification, so a plan it calls optimal can still simulate
        # worse than the current line (for example by consolidating work onto
        # fewer stations). If the proposed layout does not simulate to at least
        # the current throughput (within a small noise tolerance), do NOT present
        # it as an optimization: keep the current layout and report that no
        # improvement was found. This prevents the tool from ever proposing a
        # layout that makes the line worse.
        before_tp = before_metrics.throughput if before_metrics is not None else 0.0
        after_tp = after_metrics.throughput if after_metrics is not None else 0.0
        if before_tp > 0.0 and after_tp < before_tp * _THROUGHPUT_KEEP_FRACTION:
            return OptimizeResult(
                status=_STATUS_NO_IMPROVEMENT,
                proposed_layout=None,
                before_metrics=before_metrics,
                after_metrics=None,
                change_list=[],
                message=(
                    "No improvement was found that keeps your current output. The "
                    "best configuration the optimizer could build would lower "
                    f"throughput from {before_tp:.1f} to {after_tp:.1f} units per "
                    "hour, so your current layout is kept unchanged. Try allowing "
                    "the optimizer to add machines, or relaxing the operator or "
                    "machine caps, to give it more room."
                ),
            )

        # The proposal simulated cleanly and holds up against the current line.
        # Build the plain-language change list and report the gap.
        change_list = build_change_list(layout, proposed_layout)
        if status == _STATUS_FEASIBLE_TIMEOUT:
            gap_pct = solve_result.gap_pct
            message = (
                "The time limit was reached with a feasible solution. The "
                "optimality gap is reported as a percentage."
            )
        else:
            gap_pct = 0.0
            message = (
                "No changes are proposed; the current configuration is already "
                "optimal for these constraints."
                if not change_list
                else "An optimized configuration was found."
            )

        return OptimizeResult(
            status=status,
            proposed_layout=proposed_layout,
            before_metrics=before_metrics,
            after_metrics=after_metrics,
            change_list=change_list,
            optimality_gap_pct=gap_pct,
            message=message,
        )

    if status == _STATUS_INFEASIBLE:
        # Name exactly one binding category from the fixed set and return it with
        # no proposed layout and no after metrics (Req 6.1 to 6.5). Diagnosis is
        # bounded and never raises.
        diagnosis = diagnose_infeasibility(model)
        return OptimizeResult(
            status=_STATUS_INFEASIBLE,
            before_metrics=before_metrics,
            binding_category=diagnosis.binding_category,
            message=diagnosis.message,
        )

    # The only remaining status is no_feasible_timeout: the solver hit the limit
    # with no feasible solution found. Return that status with a message and no
    # layout (Req 5.4).
    return OptimizeResult(
        status=_STATUS_NO_FEASIBLE_TIMEOUT,
        before_metrics=before_metrics,
        message=(
            "No feasible configuration was found within the time limit. "
            "Consider relaxing the constraints and trying again."
        ),
    )
