"""Solver abstraction for the Auto-Optimize MILP.

This module defines the solver boundary for Auto-Optimize. It holds two things:

  - SolverBackend, a Protocol describing the single operation the service needs
    from any solver: take a pure OptModel plus a wall-clock time limit and an
    optional warm start, and return a pure SolveResult.
  - PulpCbcSolver, the production implementation. It imports PuLP only and never
    imports gurobipy, so a production deploy carries no paid-solver dependency
    on its code path (Req 5.7). PuLP ships a prebuilt CBC binary, which keeps
    the free-tier backend light.

The MILP built here mirrors the formulation documented at
suite/optimization/line_optimization_formulation.ipynb (variables section 5,
objective section 6, constraints sections 7.1 through 7.7), which is the single
source of truth for the math. Each variable and constraint below cites the
notebook section it realizes.

This module follows the project rule that no em dashes or en dashes appear
anywhere. Only ASCII hyphens are used, in prose, code, comments, and strings.
"""

from __future__ import annotations

import os
import re
import tempfile
from typing import Optional, Protocol, runtime_checkable

from .model_builder import OptModel, SolveResult

# The four SolveResult status strings, kept in one place so the classification
# and the gap logic refer to a single vocabulary. _classify_status maps a solve
# into exactly one of these (optimal / feasible_timeout / infeasible /
# no_feasible_timeout) per the design status mapping (Req 5.2, 5.4).
_STATUS_OPTIMAL = "optimal"
_STATUS_FEASIBLE_TIMEOUT = "feasible_timeout"
_STATUS_INFEASIBLE = "infeasible"
_STATUS_NO_FEASIBLE_TIMEOUT = "no_feasible_timeout"


@runtime_checkable
class SolverBackend(Protocol):
    """The one operation the service needs from any solver implementation.

    A SolverBackend turns a pure, solver-agnostic OptModel into a pure
    SolveResult under a wall-clock time limit. Implementations must not mutate
    the OptModel and must not leak any solver object into the SolveResult, so the
    service and the pure translation stay free of a solver dependency.

    Args:
        model: the OptModel to solve.
        time_limit_s: the wall-clock solve limit in seconds (Req 5.1 passes 30).
        warm_start: an optional starting point. When given, a dict with keys
            "x" (mapping (operation, station) -> 0/1), "n" (station -> operators),
            and "m" (station -> machines). Missing keys or an absent warm start
            are ignored. A warm start only seeds the search and never changes the
            feasible region.

    Returns:
        A SolveResult carrying the status, objective, relative gap, and the
        decision variable values.
    """

    def solve(
        self,
        model: OptModel,
        time_limit_s: float,
        warm_start: Optional[dict] = None,
    ) -> SolveResult: ...


class PulpCbcSolver:
    """Production solver backend built on PuLP with the bundled CBC binary.

    Imports pulp only and never imports gurobipy, satisfying the no-Gurobi
    production rule (Req 5.7). Builds a single pulp.LpProblem from the OptModel
    exactly per the notebook formulation, sets CBC's wall-clock time limit, and
    reads back the status, objective, relative optimality gap, and every decision
    variable value into a pure SolveResult.
    """

    def solve(
        self,
        model: OptModel,
        time_limit_s: float,
        warm_start: Optional[dict] = None,
    ) -> SolveResult:
        """Solve the OptModel with CBC under a wall-clock time limit.

        See the SolverBackend protocol for the argument and return contract. The
        LpProblem assembled here follows notebook sections 5 (variables), 6
        (objective), and 7.1 through 7.7 (constraints) term for term.
        """
        # Import PuLP lazily inside the method so that merely importing this
        # module stays cheap and so the import site is unambiguous: pulp only,
        # never gurobipy.
        import pulp

        problem = pulp.LpProblem("auto_optimize", pulp.LpMinimize)

        operations = model.operations
        stations = model.stations

        # ----------------------------------------------------------------
        # VARIABLES (notebook section 5)
        # ----------------------------------------------------------------
        # x_{o,s} in {0, 1}: 1 when operation o is assigned to station s.
        x = {
            (o, s): pulp.LpVariable(f"x_{_safe(o)}__{_safe(s)}", cat=pulp.LpBinary)
            for o in operations
            for s in stations
        }
        # n_s integer >= 0: operators at station s.
        n = {
            s: pulp.LpVariable(f"n_{_safe(s)}", lowBound=0, cat=pulp.LpInteger)
            for s in stations
        }
        # m_s integer, N_min_s <= m_s <= N_max_s: parallel machines at station s.
        # The per-station floor N_min_s (the current machine count by default)
        # keeps the solver from proposing fewer machines than the line runs
        # today, which its capacity model cannot prove is safe. Both bounds are
        # applied on the variable itself (constraint 7.6).
        m = {
            s: pulp.LpVariable(
                f"m_{_safe(s)}",
                lowBound=max(1, int(model.n_min.get(s, 1))),
                upBound=max(1, int(model.n_max.get(s, 1)), int(model.n_min.get(s, 1))),
                cat=pulp.LpInteger,
            )
            for s in stations
        }
        # y_s in {0, 1}: 1 when station s is used (holds at least one operation).
        y = {
            s: pulp.LpVariable(f"y_{_safe(s)}", cat=pulp.LpBinary)
            for s in stations
        }

        # ----------------------------------------------------------------
        # OBJECTIVE (notebook section 6)
        # ----------------------------------------------------------------
        # Minimize c_op * sum_s n_s + c_mc * sum_s m_s. Pure resource-count
        # minimization, no money (Req 12.3).
        #
        # Plus a tiny assignment-stability tie-breaker. The resource objective is
        # often indifferent to WHERE operations sit (moving an operation rarely
        # changes the total operator or machine count), so without a tie-breaker
        # the solver is free to pick any of many equal-cost solutions, including
        # degenerate ones that pile every operation onto one station. That looks
        # optimal to the MILP but the real simulation rejects it. A small penalty
        # on moving an operation off its CURRENT station (the key prefix) makes
        # the solver prefer the current, buildable assignment and only move an
        # operation when doing so genuinely lowers the resource objective. The
        # epsilon is far below 1 (the smallest real resource unit), so it can
        # never outweigh a true saving of even a single operator or machine; it
        # only breaks ties.
        _move_epsilon = 1e-4
        move_penalty = pulp.lpSum(
            _move_epsilon * x[(o, s)]
            for o in operations
            for s in stations
            if s != _current_station_of(o)
        )
        problem += (
            model.c_op * pulp.lpSum(n[s] for s in stations)
            + model.c_mc * pulp.lpSum(m[s] for s in stations)
            + move_penalty
        ), "total_resource_cost"

        # ----------------------------------------------------------------
        # CONSTRAINTS (notebook section 7)
        # ----------------------------------------------------------------

        # 7.1 Each operation assigned exactly once (Req 3.1).
        for o in operations:
            problem += (
                pulp.lpSum(x[(o, s)] for s in stations) == 1,
                f"assign_once_{_safe(o)}",
            )

        # 7.2 Station capacity under takt, ONE constraint per station bounding
        # its COMBINED load across every line it serves (Req 3.2, 11.3, 11.4).
        #
        # A station's time demand per unit is t_o for each assigned operation o.
        # For a line with takt T_line, an operation contributes t_o / T_line of a
        # single machine's capacity. A SHARED station serves several lines
        # through the same physical machines, so its real load is the SUM of
        # those per-line fractions, not each line checked on its own. Summing
        # across the lines the station serves and bounding by ceiling * rho * m_s
        # gives the correct combined-load constraint:
        #
        #   sum over served lines L of ( sum over O_L of t_o x_{o,s} / T_L )
        #       <= ceiling * rho_s * m_s
        #
        # For a dedicated station (one line) this reduces to the single-line
        # bound. Using it for every station fixes the prior per-line form, which
        # under-counted a shared station's load and let the solver keep too few
        # machines there.
        ceiling = model.utilization_ceiling
        station_lines = _station_to_lines(model)
        for s in stations:
            rho = model.rho.get(s, 1.0)
            terms = []
            for line in station_lines.get(s, []):
                takt = model.takt.get(line, 0.0)
                if takt <= 0:
                    continue
                for o in model.ops_of_line.get(line, []):
                    terms.append((model.t[o] / takt) * x[(o, s)])
            if not terms:
                continue
            # Capacity scales with the station's parallel servers: MACHINES for a
            # machine-paced station, OPERATORS for a manual one. Using operators
            # for manual stations is what makes the optimizer tune operators (not
            # phantom machines) where people do the work.
            capacity_units = m[s] if model.is_machine_paced.get(s, True) else n[s]
            problem += (
                pulp.lpSum(terms) <= ceiling * rho * capacity_units,
                f"takt_cap_{_safe(s)}",
            )

        # 7.3 Precedence by station position: for (i, j) in P, the position of
        # j's station is at or downstream of i's station (Req 3.5).
        #   sum_s pi(s) x_{j,s} >= sum_s pi(s) x_{i,s}
        for index, (i, j) in enumerate(model.precedence):
            if i not in model.t or j not in model.t:
                # Skip a precedence pair that references an unknown operation key
                # rather than crashing the whole solve on a stale rule.
                continue
            pos_j = pulp.lpSum(model.station_pos.get(s, 0) * x[(j, s)] for s in stations)
            pos_i = pulp.lpSum(model.station_pos.get(s, 0) * x[(i, s)] for s in stations)
            problem += (pos_j >= pos_i, f"precedence_{index}")

        # 7.4 Station locks: x_{o,s} = 1 for every lock pair (Req 3.6).
        for index, (o, s) in enumerate(model.locks):
            if (o, s) in x:
                problem += (x[(o, s)] == 1, f"lock_{index}")

        # 7.5 Operators meet assigned need: n_s >= sum_o r_o x_{o,s} (Req 3.3).
        for s in stations:
            problem += (
                n[s] >= pulp.lpSum(model.r[o] * x[(o, s)] for o in operations),
                f"staffing_{_safe(s)}",
            )

        # 7.6 Resource caps: sum_s n_s <= K_op, sum_s m_s <= K_mc. The per-station
        # bound 1 <= m_s <= N_max_s is applied on the m_s variable above
        # (Req 3.7, 2.11).
        problem += (
            pulp.lpSum(n[s] for s in stations) <= model.operator_cap,
            "operator_cap",
        )
        problem += (
            pulp.lpSum(m[s] for s in stations) <= model.machine_cap,
            "machine_cap",
        )

        # 7.7 Used-station linking and feasibility (Req 3.3):
        #   x_{o,s} <= y_s for all o, s   (a station holding work is used)
        #   n_s <= M y_s for all s        (only a used station carries operators)
        for o in operations:
            for s in stations:
                problem += (x[(o, s)] <= y[s], f"use_link_{_safe(o)}__{_safe(s)}")
        for s in stations:
            problem += (n[s] <= model.big_m * y[s], f"use_staff_{_safe(s)}")

        # ----------------------------------------------------------------
        # WARM START (optional, seeds the search only)
        # ----------------------------------------------------------------
        self._apply_warm_start(warm_start, x, n, m, y, model)

        # ----------------------------------------------------------------
        # SOLVE with a wall-clock time limit (Req 5.1)
        # ----------------------------------------------------------------
        # msg=0 keeps CBC quiet. warmStart lets CBC use any set initial values.
        # logPath routes CBC's run log to a temporary file so the proven lower
        # bound can be read back and turned into the relative optimality gap for
        # a feasible_timeout result (Req 5.2). PuLP does not surface a best bound
        # through its problem object for PULP_CBC_CMD, so the log is the reliable
        # source of the bound. The file is read and removed below.
        log_path = self._new_log_path()
        solver = pulp.PULP_CBC_CMD(
            msg=0,
            timeLimit=max(1, int(round(time_limit_s))),
            warmStart=warm_start is not None,
            logPath=log_path,
        )
        problem.solve(solver)
        log_text = self._read_and_remove(log_path)

        # ----------------------------------------------------------------
        # READ BACK the status, objective, gap, and variable values
        # ----------------------------------------------------------------
        return self._build_result(problem, model, x, n, m, y, log_text)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _apply_warm_start(
        warm_start: Optional[dict],
        x: dict,
        n: dict,
        m: dict,
        y: dict,
        model: OptModel,
    ) -> None:
        """Seed variable initial values from a warm start when one is provided.

        The warm start only hands CBC an early incumbent to improve the first
        bound under the time limit; it never alters the feasible region. A
        missing warm start, or any key absent from it, leaves variables unseeded.
        """
        if not warm_start:
            return
        ws_x = warm_start.get("x") or {}
        ws_n = warm_start.get("n") or {}
        ws_m = warm_start.get("m") or {}
        used: set[str] = set()
        for (o, s), var in x.items():
            value = ws_x.get((o, s))
            if value is not None:
                var.setInitialValue(int(round(value)))
                if int(round(value)) == 1:
                    used.add(s)
        for s, var in n.items():
            value = ws_n.get(s)
            if value is not None:
                var.setInitialValue(max(0, int(round(value))))
        for s, var in m.items():
            value = ws_m.get(s)
            if value is not None:
                lo = 1
                hi = max(1, int(model.n_max.get(s, 1)))
                var.setInitialValue(min(hi, max(lo, int(round(value)))))
        # y_s follows from whether the station holds any started operation.
        for s, var in y.items():
            var.setInitialValue(1 if s in used else 0)

    def _build_result(
        self,
        problem,
        model: OptModel,
        x: dict,
        n: dict,
        m: dict,
        y: dict,
        log_text: str = "",
    ) -> SolveResult:
        """Read the solved problem into a pure SolveResult (Req 5.2, 5.4).

        Classifies the solve into the exact four-value status vocabulary and
        fills gap_pct to match:

          - optimal             -> gap_pct 0.00
          - feasible_timeout    -> the relative gap clamped to [0.00, 100.00]
          - infeasible          -> gap_pct None
          - no_feasible_timeout -> gap_pct None

        The classification reads PuLP's solution status (sol_status), not the
        LpStatus of problem.status. CBC via PuLP reports LpStatus "Optimal" even
        when it only found a feasible incumbent at the time limit, so LpStatus
        alone cannot tell proven-optimal from time-limited-feasible. The
        sol_status field distinguishes them: LpSolutionOptimal means the bound
        was closed and optimality was proven, while LpSolutionIntegerFeasible
        means an incumbent exists but optimality was not proven within the limit.
        """
        import pulp

        sol_status = getattr(problem, "sol_status", None)
        has_solution = self._has_solution(x)

        objective = None
        if has_solution:
            value = pulp.value(problem.objective)
            objective = float(value) if value is not None else None

        status = self._classify_status(sol_status, has_solution)

        if status == _STATUS_OPTIMAL:
            # Proven optimal within the limit: the incumbent equals the bound, so
            # the gap is zero by definition (Req 5.2 proven-optimal case).
            gap_pct: Optional[float] = 0.0
        elif status == _STATUS_FEASIBLE_TIMEOUT:
            # Time limit reached with a feasible incumbent: report the relative
            # gap from the incumbent to the proven lower bound, clamped to
            # [0.00, 100.00] (Req 5.2 timeout-with-incumbent case).
            gap_pct = self._relative_gap_pct(log_text, objective)
        else:
            # infeasible or no_feasible_timeout: no meaningful gap to report.
            gap_pct = None

        x_values: dict[tuple[str, str], int] = {}
        for (o, s), var in x.items():
            x_values[(o, s)] = _as_int(var.value())
        n_values = {s: _as_int(var.value()) for s, var in n.items()}
        m_values = {s: max(1, _as_int(var.value())) for s, var in m.items()}
        y_values = {s: _as_int(var.value()) for s, var in y.items()}

        return SolveResult(
            status=status,
            objective=objective,
            gap_pct=gap_pct,
            x=x_values,
            n=n_values,
            m=m_values,
            y=y_values,
        )

    @staticmethod
    def _has_solution(x: dict) -> bool:
        """Return True when the solver filled in at least one variable value.

        CBC leaves variable values as None when it proves infeasibility or hits
        the time limit with no incumbent, so a populated assignment is the signal
        that a usable solution exists.
        """
        for var in x.values():
            if var.value() is not None:
                return True
        return False

    @classmethod
    def _relative_gap_pct(
        cls, log_text: str, objective: Optional[float]
    ) -> Optional[float]:
        """Return the relative optimality gap as a percentage in [0.00, 100.00].

        The gap is the distance between the feasible incumbent objective and the
        proven lower bound, as a percentage of the incumbent, clamped to the
        [0.00, 100.00] range required for a feasible_timeout result (Req 5.2).

        The lower bound is read from the CBC run log, since PuLP does not expose
        a best bound on the problem object for PULP_CBC_CMD. CBC prints a
        "Lower bound:" line with the proven bound at the end of a time-limited
        solve. When the bound cannot be read, the method falls back to CBC's own
        printed "Gap:" fraction, and if neither is present returns None so the
        service reports an unknown gap rather than a false precise one.

        A value of 0.0 is returned, not None, when the incumbent equals the
        bound, since that is a real gap of zero percent.
        """
        if objective is None:
            return None

        bound = cls._parse_lower_bound(log_text)
        if bound is not None and objective != 0:
            try:
                gap = abs(objective - bound) / abs(objective) * 100.0
            except (TypeError, ValueError, ZeroDivisionError):
                gap = None
            if gap is not None:
                return cls._clamp_gap(gap)

        # Fallback: CBC also prints a "Gap:" line as a fraction (for example
        # 0.02 for two percent). Use it when the explicit bound is unavailable.
        gap_fraction = cls._parse_gap_fraction(log_text)
        if gap_fraction is not None:
            return cls._clamp_gap(gap_fraction * 100.0)

        return None

    @staticmethod
    def _clamp_gap(gap: float) -> float:
        """Clamp a percentage gap to the [0.00, 100.00] range (Req 5.2)."""
        return max(0.0, min(100.0, float(gap)))

    @staticmethod
    def _parse_lower_bound(log_text: str) -> Optional[float]:
        """Parse the proven lower bound from a CBC run log, or None.

        CBC writes a final summary line of the form "Lower bound: <value>" when
        a solve stops at the time limit. Returns the parsed float, or None when
        the line is absent (for example on a solve that proved optimality and
        printed no such summary).
        """
        if not log_text:
            return None
        match = None
        for found in re.finditer(r"lower bound:\s*([-+0-9.eE]+)", log_text, re.IGNORECASE):
            match = found
        if match is None:
            return None
        try:
            return float(match.group(1))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _parse_gap_fraction(log_text: str) -> Optional[float]:
        """Parse CBC's printed relative gap fraction from a run log, or None.

        CBC writes a final "Gap: <fraction>" line, where the value is a relative
        gap as a fraction (0.02 means two percent). Returns the last such value
        found as a float fraction, or None when no gap line is present.
        """
        if not log_text:
            return None
        match = None
        for found in re.finditer(r"^\s*gap:\s*([-+0-9.eE]+)", log_text, re.IGNORECASE | re.MULTILINE):
            match = found
        if match is None:
            return None
        try:
            return float(match.group(1))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _new_log_path() -> str:
        """Return a fresh temporary file path for the CBC run log.

        A unique name per solve keeps concurrent requests from sharing a log
        file. The file itself is created by CBC; this only reserves the path.
        """
        fd, path = tempfile.mkstemp(prefix="auto_optimize_cbc_", suffix=".log")
        os.close(fd)
        return path

    @staticmethod
    def _read_and_remove(path: str) -> str:
        """Read a CBC log file and remove it, returning "" on any failure.

        Reading the log must never break a solve, so any missing file, read
        error, or removal error is swallowed and an empty log is returned. An
        empty log simply means no gap can be parsed, which the gap logic handles.
        """
        text = ""
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                text = handle.read()
        except OSError:
            text = ""
        try:
            os.remove(path)
        except OSError:
            pass
        return text

    @staticmethod
    def _classify_status(sol_status, has_solution: bool) -> str:
        """Map PuLP's solution status to the exact SolveResult vocabulary.

        Implements the design status mapping term for term (Req 5.2, 5.4):

          - Proven optimal within the limit         -> optimal
          - Time limit reached with a feasible
            incumbent                                -> feasible_timeout
          - Proven infeasible                        -> infeasible
          - Time limit reached with no incumbent     -> no_feasible_timeout

        The classification keys off PuLP's sol_status (an LpSolution code), not
        the LpStatus of problem.status. CBC via PuLP reports LpStatus "Optimal"
        even when it only found a feasible incumbent at the time limit, so
        LpStatus alone cannot separate proven-optimal from time-limited-feasible.
        The LpSolution codes make the distinction explicit:

          - LpSolutionOptimal         (1): bound closed, optimality proven.
          - LpSolutionIntegerFeasible (2): an incumbent exists, not proven optimal.
          - LpSolutionInfeasible     (-1): proven infeasible.
          - LpSolutionNoSolutionFound (0): stopped with no incumbent.

        The has_solution flag, read from the decision variable values, is used as
        a safety net so a populated assignment is never discarded when the
        solution code is missing or unexpected, and an empty assignment is never
        presented as feasible.
        """
        import pulp

        if sol_status == pulp.LpSolutionOptimal and has_solution:
            # Proven optimal within the limit.
            return _STATUS_OPTIMAL
        if sol_status == pulp.LpSolutionIntegerFeasible and has_solution:
            # Time limit reached with a feasible incumbent that was not proven
            # optimal.
            return _STATUS_FEASIBLE_TIMEOUT
        if sol_status == pulp.LpSolutionInfeasible:
            # Proven infeasible, regardless of any stray variable values.
            return _STATUS_INFEASIBLE
        if sol_status == pulp.LpSolutionNoSolutionFound and not has_solution:
            # Stopped at the time limit with no incumbent found.
            return _STATUS_NO_FEASIBLE_TIMEOUT

        # Safety net for any code the solver did not set cleanly: trust the
        # presence of an actual assignment. A populated assignment that was not
        # marked optimal is a feasible-but-unproven result; an empty one means no
        # feasible solution was produced within the limit.
        if has_solution:
            return _STATUS_FEASIBLE_TIMEOUT
        return _STATUS_NO_FEASIBLE_TIMEOUT


def get_solver(name: str = "pulp") -> SolverBackend:
    """Return a SolverBackend by name, defaulting to the production PuLP/CBC one.

    Only when name == "gurobi" is a Gurobi backend imported, and then lazily from
    a separate module, so a production deploy that never asks for Gurobi never
    imports gurobipy (Req 5.7). Task 5.3 implements the Gurobi branch; the default
    PuLP branch is complete here.
    """
    if name == "gurobi":
        from .solver_gurobi import GurobiSolver  # local study only, lazy import

        return GurobiSolver()
    return PulpCbcSolver()


def _as_int(value) -> int:
    """Round a solver variable value to the nearest integer, treating None as 0.

    CBC returns floating point values for integer variables (for example 0.9999
    or 2.0001); rounding recovers the intended integer. A None value, which the
    solver leaves when a variable was never assigned, becomes 0.
    """
    if value is None:
        return 0
    return int(round(value))


def _station_to_lines(model) -> dict:
    """Return each station id mapped to the list of lines it serves.

    Inverts model.stations_of_line. Used by the combined-load takt constraint so
    a shared station sums its demand across every line it serves.
    """
    mapping: dict = {}
    for line, station_ids in model.stations_of_line.items():
        for sid in station_ids:
            mapping.setdefault(sid, [])
            if line not in mapping[sid]:
                mapping[sid].append(line)
    return mapping


def _current_station_of(op_key: str) -> str:
    """Return the station id an operation currently sits on, from its key.

    Operation keys use the stable form "station_id index" (see
    model_builder._op_key). The current station is everything before the final
    space. Used only by the assignment-stability tie-breaker to know which
    assignment counts as "no move"; it never affects feasibility.
    """
    return op_key.rpartition(" ")[0] or op_key


def _safe(key: str) -> str:
    """Return a key sanitized for use inside a PuLP variable or constraint name.

    PuLP and CBC reject spaces and several punctuation characters in names. The
    stable operation keys use a space (for example "station_1 0"), so replace
    characters CBC dislikes with underscores. This affects only the internal
    solver name, never the OptModel keys read back into the SolveResult.
    """
    out = []
    for ch in str(key):
        if ch.isalnum() or ch == "_":
            out.append(ch)
        else:
            out.append("_")
    return "".join(out)
