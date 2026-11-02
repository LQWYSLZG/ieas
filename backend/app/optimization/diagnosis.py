"""Bounded infeasibility diagnosis for the Auto-Optimize MILP.

When the main solve proves the MILP infeasible, the user needs one clear reason
to act on rather than a crash or a hang. This module answers that question: it
names exactly ONE likely binding constraint category from the fixed set

    {takt_capacity, operator_cap, machine_cap, locks}

(Req 6.2) and returns a short, plain-language message to show the user.

The diagnosis is BOUNDED. It is guaranteed to terminate well under the 60 second
request budget and it never raises an unhandled exception (Req 6.1). It reaches a
verdict in three stages, cheapest first:

  1. Cheap pre-checks (constant or linear time, no solve). Each pre-check tests
     one category and, when it fires, is conclusive on its own:
       - locks: a lock pattern that cannot hold, or locks that violate precedence
         (Req 6.4).
       - takt_capacity: total line work exceeds the line's maximum capacity even
         with the most machines each station may run (Req 6.3).
       - operator_cap: the minimum operators any feasible assignment needs
         exceeds K_op (Req 6.3).
       - machine_cap: the minimum machines needed to hold the work within takt
         exceeds K_mc (Req 6.3).
  2. Short, bounded relaxation probes, run ONLY when the pre-checks are
     inconclusive. Each probe loosens exactly one category and re-solves with a
     small per-probe time slice, so the total stays far below the request budget.
     The first relaxation that restores feasibility names the binding category.
  3. Tightest-margin fallback. When probes stay inconclusive, the category whose
     pre-check came closest to failing (the smallest slack margin) is reported as
     the single most likely binding category.

The module reuses the pure OptModel from model_builder and the production solver
from solver. It imports no FastAPI and no Gurobi. Being called only on the
already-infeasible path, it adds at most a few short solves to a request that
would otherwise end immediately.

This module follows the project rule that no em dashes or en dashes appear
anywhere. Only ASCII hyphens are used, in prose, code, comments, and strings.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Optional

from .model_builder import OptModel
from .solver import SolverBackend, get_solver

# The fixed category vocabulary, kept in one place so the pre-checks, the probes,
# and the fallback all refer to a single set of strings (Req 6.2).
CATEGORY_TAKT = "takt_capacity"
CATEGORY_OPERATOR = "operator_cap"
CATEGORY_MACHINE = "machine_cap"
CATEGORY_LOCKS = "locks"

# Every category the diagnosis may ever name, in a stable, documented order.
CATEGORIES = (CATEGORY_TAKT, CATEGORY_OPERATOR, CATEGORY_MACHINE, CATEGORY_LOCKS)

# Per-probe wall-clock time slice in seconds. Each relaxation probe is a full but
# SMALL solve. With at most a handful of probes the total probe time is a few
# seconds, so the whole diagnosis stays far under the 60 second request budget
# (Req 6.1). Kept small on purpose: a probe only needs to find ANY feasible point
# of the relaxed model, not prove optimality.
_PROBE_TIME_LIMIT_S = 2.0

# A loose multiplier used to open a cap wide during a relaxation probe. Raising a
# cap by this factor (plus a floor) is enough to clear a binding cap without
# making the probe model trivially unbounded in other dimensions.
_RELAX_FACTOR = 100

# Plain-language messages per category. Each names the one binding category and
# suggests the concrete lever the user can relax, matching Req 6.2 to 6.4.
_MESSAGES = {
    CATEGORY_TAKT: (
        "The line cannot meet its takt time with the machines allowed. "
        "Consider raising the takt time (lower target throughput), allowing more "
        "machines, or splitting work across more stations."
    ),
    CATEGORY_OPERATOR: (
        "The operator cap is too low for the work that must be staffed. "
        "Consider raising the operator cap."
    ),
    CATEGORY_MACHINE: (
        "The machine cap is too low to hold the work within takt. "
        "Consider raising the machine cap or enabling adding machines."
    ),
    CATEGORY_LOCKS: (
        "The station locks leave no feasible assignment. "
        "Consider removing or relaxing one or more station locks."
    ),
}


@dataclass(frozen=True)
class DiagnosisResult:
    """The outcome of an infeasibility diagnosis.

    Holds exactly one binding category from CATEGORIES and a short, plain-language
    message describing it. Pydantic-free and solver-free so the service can hand
    binding_category and message straight into the OptimizeResponse with no
    remapping. The field names match the OptimizeResponse fields
    (binding_category, message) exactly.

    Attributes:
        binding_category: one of takt_capacity, operator_cap, machine_cap, locks.
        message: a one-line, human-readable explanation naming that category and
            the lever the user can relax.
    """

    binding_category: str
    message: str


def diagnose_infeasibility(
    model: OptModel,
    solver: Optional[SolverBackend] = None,
) -> DiagnosisResult:
    """Name the single most likely binding constraint category for an infeasible model.

    Called only when the main solve has already proven the MILP infeasible. It
    runs cheap pre-checks, then at most a few short relaxation probes, then a
    tightest-margin fallback, and always returns one category from CATEGORIES.

    This function NEVER raises. Any unexpected error inside a pre-check or a probe
    is swallowed and the diagnosis continues, degrading to the fallback so the
    caller always receives a usable verdict within the request budget (Req 6.1).

    Args:
        model: the infeasible OptModel to diagnose. Not mutated. Relaxed copies
            are built with dataclasses.replace for the probes.
        solver: the SolverBackend used for the relaxation probes. Defaults to the
            production PuLP/CBC solver via get_solver(). Injectable for tests.

    Returns:
        A DiagnosisResult carrying one binding_category and a plain-language
        message (Req 6.2 to 6.4).
    """
    try:
        margins = _precheck_margins(model)
    except Exception:
        # A pre-check must never break the diagnosis. Fall straight through to a
        # safe default rather than propagating.
        margins = {}

    # 1. Conclusive pre-checks. A negative margin means that category's lower
    #    bound already exceeds its cap (or its locks cannot hold), so it is on its
    #    own a sufficient explanation. Report the most negative (tightest) one so
    #    a single clear reason wins when several pre-checks fire at once. Locks win
    #    ties because a hard lock conflict is the most specific explanation.
    failing = {cat: margin for cat, margin in margins.items() if margin is not None and margin < 0}
    if failing:
        category = _pick_tightest(failing)
        return _result(category)

    # 2. Bounded relaxation probes. Only reached when no pre-check was conclusive.
    #    Each probe loosens one category and re-solves briefly; the first probe
    #    that restores feasibility names the binding category.
    try:
        probed = _run_relaxation_probes(model, solver or get_solver())
    except Exception:
        # A probe failure (solver error, environment issue) must not break the
        # diagnosis. Fall through to the margin-based fallback.
        probed = None
    if probed is not None:
        return _result(probed)

    # 3. Tightest-margin fallback. No probe was conclusive, so report the category
    #    whose pre-check margin is smallest (closest to binding). When no margins
    #    could be computed at all, default to takt_capacity, the most common
    #    structural cause of infeasibility in this model.
    if margins:
        fallback = _pick_tightest({cat: m for cat, m in margins.items() if m is not None})
        if fallback is not None:
            return _result(fallback)
    return _result(CATEGORY_TAKT)


# -----------------------------------------------------------------------
# PRE-CHECKS (cheap, no solve)
# -----------------------------------------------------------------------

def _precheck_margins(model: OptModel) -> dict[str, Optional[float]]:
    """Return a slack margin per category: negative means that category is binding.

    Each margin is a slack value in the natural units of its category. A negative
    margin means the category's demand already exceeds its capacity (or the locks
    cannot hold), so it is conclusively binding. A small non-negative margin means
    the category is close to binding and is a good fallback candidate. None means
    the margin could not be computed for that category.

    Margins:
      - locks: 0.0 when a lock conflict is detected (treated as binding by making
        it negative below via a dedicated conflict flag), else a large positive
        slack so it never wins a fallback unless it genuinely conflicts.
      - takt_capacity: min over lines of (max line capacity - total line work).
      - operator_cap: K_op - minimum operators any assignment needs.
      - machine_cap: K_mc - minimum machines any assignment needs.
    """
    margins: dict[str, Optional[float]] = {}

    # Locks: a hard conflict is reported as a negative margin so it is conclusive.
    # No conflict leaves a large positive slack so locks never win the fallback.
    margins[CATEGORY_LOCKS] = _locks_margin(model)

    # Takt capacity, operators, and machines are per-line structural bounds.
    margins[CATEGORY_TAKT] = _takt_margin(model)
    margins[CATEGORY_OPERATOR] = _operator_margin(model)
    margins[CATEGORY_MACHINE] = _machine_margin(model)

    return margins


def _locks_margin(model: OptModel) -> Optional[float]:
    """Return a negative margin when the locks cannot hold, else a large slack.

    Three lock conflicts are detectable without a solve (Req 6.4):

      - Double-lock: one operation locked to two different stations cannot be
        assigned to exactly one station, so it is infeasible.
      - Over-takt lock: an operation locked to a station whose single-machine
        takt capacity (even at the station's maximum machines) cannot hold the
        operation's own cycle time. The operation can never fit where it is
        pinned.
      - Precedence violation: two locked operations pinned so the earlier
        operation sits strictly downstream of the later one, which no assignment
        can satisfy.

    Returns -1.0 when any conflict is found (conclusively binding), a large
    positive slack when locks exist but no conflict is found, and None when there
    are no locks at all so this category is irrelevant.
    """
    if not model.locks:
        return None

    # Map each locked operation to the set of stations it is pinned to.
    locked_stations: dict[str, set[str]] = {}
    for op, station in model.locks:
        locked_stations.setdefault(op, set()).add(station)

    # Double-lock: any operation pinned to two or more distinct stations.
    for op, stations in locked_stations.items():
        if len(stations) >= 2:
            return -1.0

    # Over-takt lock: a locked operation whose cycle time exceeds the maximum
    # capacity of its pinned station across every line that station serves.
    station_to_lines = _station_to_lines(model)
    for op, stations in locked_stations.items():
        cycle = model.t.get(op)
        if cycle is None:
            continue
        for station in stations:
            max_machines = max(1, int(model.n_max.get(station, 1)))
            rho = model.rho.get(station, 1.0)
            # Capacity on the tightest (smallest takt) line the station serves.
            lines = station_to_lines.get(station, list(model.lines))
            tightest_takt = None
            for line in lines:
                takt = model.takt.get(line)
                if takt is None:
                    continue
                if tightest_takt is None or takt < tightest_takt:
                    tightest_takt = takt
            if tightest_takt is None:
                continue
            capacity = rho * tightest_takt * max_machines
            if cycle > capacity + 1e-9:
                return -1.0

    # Precedence violation among locked operations: a pair (i, j) in precedence
    # whose locked stations put j strictly upstream of i.
    for i, j in model.precedence:
        si = _single_locked_station(locked_stations, i)
        sj = _single_locked_station(locked_stations, j)
        if si is None or sj is None:
            continue
        pos_i = model.station_pos.get(si)
        pos_j = model.station_pos.get(sj)
        if pos_i is None or pos_j is None:
            continue
        if pos_j < pos_i:
            return -1.0

    # Locks exist but none conflict: a large positive slack keeps locks out of the
    # fallback pick unless a genuine conflict was found above.
    return float(_RELAX_FACTOR)


def _takt_margin(model: OptModel) -> Optional[float]:
    """Return the tightest per-line takt-capacity slack: negative means binding.

    For each line the total work is sum over O_line of t_o. The maximum capacity
    the line can offer is sum over S_line of rho_s * T_line * N_max_s, the most
    work its stations can hold when every station runs its maximum machines. The
    line margin is capacity minus work; a negative margin means no assignment can
    fit the work within takt on that line (Req 6.3, takt capacity).

    Returns the smallest line margin (the tightest line), or None when no line
    has both work and capacity defined.
    """
    tightest: Optional[float] = None
    for line in model.lines:
        takt = model.takt.get(line)
        if takt is None or takt <= 0:
            continue
        ops_line = model.ops_of_line.get(line, [])
        stations_line = model.stations_of_line.get(line, [])
        if not ops_line or not stations_line:
            continue
        total_work = sum(model.t.get(o, 0.0) for o in ops_line)
        # Capacity uses the same healthy ceiling the solver enforces, so a line
        # that cannot fit its work within the ceiling (not just within full
        # takt) is correctly flagged as takt-capacity bound.
        ceiling = getattr(model, "utilization_ceiling", 1.0) or 1.0
        capacity = 0.0
        for s in stations_line:
            rho = model.rho.get(s, 1.0)
            max_machines = max(1, int(model.n_max.get(s, 1)))
            capacity += ceiling * rho * takt * max_machines
        margin = capacity - total_work
        if tightest is None or margin < tightest:
            tightest = margin
    return tightest


def _operator_margin(model: OptModel) -> Optional[float]:
    """Return K_op minus the minimum operators any assignment needs.

    Every operation must be staffed wherever it lands, and a station's operator
    count must cover the sum of its assigned operations' operator requirements
    (constraint 7.5). The minimum total operators any feasible assignment can use
    is therefore at least the sum over all operations of r_o, since that labor
    must exist somewhere. When that lower bound exceeds K_op no assignment can
    stay within the operator cap, so the margin is negative (Req 6.3, operator
    cap).

    Returns K_op minus the summed operator requirement, or None when there are no
    operations to staff.
    """
    if not model.operations:
        return None
    min_operators = sum(int(model.r.get(o, 0)) for o in model.operations)
    return float(model.operator_cap) - float(min_operators)


def _machine_margin(model: OptModel) -> Optional[float]:
    """Return K_mc minus the minimum machines any assignment needs.

    Each station runs at least one machine (1 <= m_s), so the model needs at least
    one machine per station that must hold work. Beyond that floor, a line whose
    total work exceeds what one machine per station can hold within takt needs
    extra machines: at least ceil(total_line_work / (rho_avg * T_line)) machines
    across the line. The machine lower bound is the larger of the per-station
    floor and the per-line work-driven need. When that lower bound exceeds K_mc no
    assignment can stay within the machine cap, so the margin is negative (Req
    6.3, machine cap).

    Returns K_mc minus the machine lower bound, or None when no line defines both
    work and takt.
    """
    # Floor: at least one machine per station that carries work on some line.
    stations_with_work: set[str] = set()
    for line in model.lines:
        if model.ops_of_line.get(line):
            for s in model.stations_of_line.get(line, []):
                stations_with_work.add(s)
    floor_machines = len(stations_with_work)

    # Per-line work-driven need, summed across lines for a global lower bound.
    work_driven = 0
    saw_line = False
    for line in model.lines:
        takt = model.takt.get(line)
        if takt is None or takt <= 0:
            continue
        ops_line = model.ops_of_line.get(line, [])
        stations_line = model.stations_of_line.get(line, [])
        if not ops_line or not stations_line:
            continue
        saw_line = True
        total_work = sum(model.t.get(o, 0.0) for o in ops_line)
        # Use the best (largest) availability on the line so the bound stays a
        # true lower bound: more availability means fewer machines are needed.
        best_rho = max((model.rho.get(s, 1.0) for s in stations_line), default=1.0)
        ceiling = getattr(model, "utilization_ceiling", 1.0) or 1.0
        per_machine = ceiling * best_rho * takt
        if per_machine > 0:
            work_driven += max(0, math.ceil(total_work / per_machine))

    if not saw_line and floor_machines == 0:
        return None

    lower_bound = max(floor_machines, work_driven)
    return float(model.machine_cap) - float(lower_bound)


# -----------------------------------------------------------------------
# RELAXATION PROBES (bounded, short solves)
# -----------------------------------------------------------------------

def _run_relaxation_probes(
    model: OptModel,
    solver: SolverBackend,
) -> Optional[str]:
    """Loosen one category at a time and return the first that restores feasibility.

    Probes run in a fixed, documented order so the result is deterministic:
    operator_cap, then machine_cap, then locks, then takt_capacity. Each probe
    builds a relaxed OptModel copy with dataclasses.replace (the input model is
    never mutated) and solves it with a small time slice (_PROBE_TIME_LIMIT_S).
    The first probe whose relaxed model is NOT infeasible names the binding
    category, since loosening exactly that category is what made the model
    solvable.

    A probe that itself times out with no incumbent (no_feasible_timeout) is
    treated as inconclusive, not as feasible, so a slow relaxed solve never
    produces a false positive. Returns the binding category, or None when no
    single-category relaxation restored feasibility within the probe budget.
    """
    probes = (
        (CATEGORY_OPERATOR, _relax_operator_cap),
        (CATEGORY_MACHINE, _relax_machine_cap),
        (CATEGORY_LOCKS, _relax_locks),
        (CATEGORY_TAKT, _relax_takt),
    )
    for category, relax in probes:
        relaxed = relax(model)
        if relaxed is None:
            # Nothing to relax for this category on this model (for example no
            # locks to drop). Skip it rather than run a pointless solve.
            continue
        try:
            result = solver.solve(relaxed, time_limit_s=_PROBE_TIME_LIMIT_S, warm_start=None)
        except Exception:
            # A single probe solver error is non-fatal: skip to the next probe.
            continue
        if result.status in ("optimal", "feasible_timeout"):
            # Loosening this one category made the model feasible, so it is the
            # binding category.
            return category
    return None


def _relax_operator_cap(model: OptModel) -> OptModel:
    """Return a copy of the model with the operator cap opened wide."""
    relaxed_cap = max(model.operator_cap * _RELAX_FACTOR, model.operator_cap + _RELAX_FACTOR)
    return replace(model, operator_cap=relaxed_cap)


def _relax_machine_cap(model: OptModel) -> OptModel:
    """Return a copy with the machine cap and per-station machine bounds opened.

    Both the global machine cap and every per-station N_max_s are raised, since a
    binding machine limit can come from either the total cap or a tight per-station
    bound (for example when the Machine_Toggle is disabled and N_max_s is pinned
    to the current count). Raising both isolates the machine category cleanly.
    """
    relaxed_cap = max(model.machine_cap * _RELAX_FACTOR, model.machine_cap + _RELAX_FACTOR)
    relaxed_n_max = {
        s: max(int(bound) * _RELAX_FACTOR, int(bound) + _RELAX_FACTOR)
        for s, bound in model.n_max.items()
    }
    return replace(model, machine_cap=relaxed_cap, n_max=relaxed_n_max)


def _relax_locks(model: OptModel) -> Optional[OptModel]:
    """Return a copy with all station locks dropped, or None when there are none."""
    if not model.locks:
        return None
    return replace(model, locks=[])


def _relax_takt(model: OptModel) -> OptModel:
    """Return a copy with every line's takt opened wide.

    Multiplying each takt loosens the takt-capacity constraint directly (more
    seconds per unit means each station can hold more work), isolating the takt
    category from the operator and machine caps.
    """
    relaxed_takt = {line: takt * _RELAX_FACTOR for line, takt in model.takt.items()}
    return replace(model, takt=relaxed_takt)


# -----------------------------------------------------------------------
# SMALL HELPERS
# -----------------------------------------------------------------------

def _station_to_lines(model: OptModel) -> dict[str, list[str]]:
    """Return a map from each station id to the list of lines it serves."""
    mapping: dict[str, list[str]] = {}
    for line, stations in model.stations_of_line.items():
        for s in stations:
            mapping.setdefault(s, []).append(line)
    return mapping


def _single_locked_station(
    locked_stations: dict[str, set[str]],
    op: str,
) -> Optional[str]:
    """Return the one station an operation is locked to, or None if not exactly one."""
    stations = locked_stations.get(op)
    if stations is None or len(stations) != 1:
        return None
    return next(iter(stations))


def _pick_tightest(margins: dict[str, float]) -> Optional[str]:
    """Return the category with the smallest (tightest) margin.

    Ties are broken by the CATEGORIES order so the choice is deterministic, with
    locks preferred on a tie because a hard lock conflict is the most specific
    explanation. Returns None only when the input is empty.
    """
    if not margins:
        return None
    tie_order = {cat: index for index, cat in enumerate(CATEGORIES)}
    # Prefer locks on an exact tie by giving it the lowest tie-break rank.
    tie_order[CATEGORY_LOCKS] = -1
    return min(margins, key=lambda cat: (margins[cat], tie_order.get(cat, len(CATEGORIES))))


def _result(category: str) -> DiagnosisResult:
    """Build a DiagnosisResult for a category, falling back to a safe default.

    Guards against an unknown category string by defaulting to takt_capacity, so
    the returned binding_category is always one of CATEGORIES and the message is
    always populated (Req 6.2).
    """
    if category not in _MESSAGES:
        category = CATEGORY_TAKT
    return DiagnosisResult(binding_category=category, message=_MESSAGES[category])
