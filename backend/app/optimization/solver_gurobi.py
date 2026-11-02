"""Gurobi solver backend for the Auto-Optimize MILP (LOCAL STUDY ONLY).

This module is a local-study alternative to the production PuLP/CBC backend.
The user has a temporary Gurobi student account and may want to run the same
MILP through Gurobi locally to compare solve quality and speed. It is NOT part
of the deployed application and must never be imported on a production code
path.

How the no-Gurobi-in-production guarantee is kept:

  - get_solver in solver.py defaults to the PuLP/CBC backend and imports this
    module lazily, only when name == "gurobi". The service always calls
    get_solver() with the default, so production never reaches this module.
  - gurobipy is imported only INSIDE GurobiSolver.solve, never at module top
    level. Importing this file as source therefore never touches gurobipy and
    never fails when gurobipy is absent (gurobipy is not installed in the
    backend venv, which is fine). The clear error is raised only when a caller
    actually instantiates GurobiSolver and calls solve without gurobipy present.

The MILP assembled here mirrors the production PulpCbcSolver term for term, and
both mirror the formulation documented at
suite/optimization/line_optimization_formulation.ipynb (variables section 5,
objective section 6, constraints sections 7.1 through 7.7), which is the single
source of truth for the math. The SolveResult status vocabulary and the gap
semantics match PulpCbcSolver exactly: optimal (gap 0.00), feasible_timeout
(relative gap clamped to [0.00, 100.00]), infeasible, no_feasible_timeout.

This module follows the project rule that no em dashes or en dashes appear
anywhere. Only ASCII hyphens are used, in prose, code, comments, and strings.
"""

from __future__ import annotations

from typing import Optional

from .model_builder import OptModel, SolveResult

# The four SolveResult status strings, kept identical to the production solver
# so both backends classify into one shared vocabulary (Req 5.2, 5.4).
_STATUS_OPTIMAL = "optimal"
_STATUS_FEASIBLE_TIMEOUT = "feasible_timeout"
_STATUS_INFEASIBLE = "infeasible"
_STATUS_NO_FEASIBLE_TIMEOUT = "no_feasible_timeout"

# A clear, actionable message raised only when GurobiSolver is actually used
# without gurobipy installed. Importing this module as source never triggers it.
_MISSING_GUROBIPY_MESSAGE = (
    "GurobiSolver requires the gurobipy package, which is not installed. "
    "GurobiSolver is a local-study-only backend and is never used by the "
    "deployed application; the production solver is PuLP/CBC via "
    'get_solver("pulp"). To run the Gurobi backend locally, install gurobipy '
    "and a valid Gurobi license, then call get_solver(\"gurobi\")."
)


class GurobiSolver:
    """Local-study solver backend built on gurobipy (not used in production).

    Builds the SAME MILP as PulpCbcSolver from the same pure OptModel, using the
    gurobipy modeling API, and returns a pure SolveResult with the identical
    status vocabulary and gap semantics. gurobipy is imported lazily inside
    solve, so constructing this object is cheap and importing the module never
    requires gurobipy. The missing-dependency error surfaces only when solve is
    called without gurobipy present.
    """

    def solve(
        self,
        model: OptModel,
        time_limit_s: float,
        warm_start: Optional[dict] = None,
    ) -> SolveResult:
        """Solve the OptModel with Gurobi under a wall-clock time limit.

        Matches the SolverBackend protocol contract exactly (same signature and
        return type as PulpCbcSolver.solve). The model built here follows
        notebook sections 5 (variables), 6 (objective), and 7.1 through 7.7
        (constraints) term for term, identical to the production PuLP model.

        Args:
            model: the OptModel to solve (never mutated).
            time_limit_s: the wall-clock solve limit in seconds.
            warm_start: an optional starting point with keys "x"
                (mapping (operation, station) -> 0/1), "n" (station -> operators),
                and "m" (station -> machines). Missing keys or an absent warm
                start are ignored; a warm start only seeds the search.

        Returns:
            A pure SolveResult carrying the status, objective, relative gap, and
            the decision variable values.

        Raises:
            RuntimeError: when gurobipy is not installed. This is raised only on
                actual use, never on import, so the module imports cleanly as
                source in an environment without gurobipy.
        """
        # Import gurobipy lazily and guard it so that a missing package produces
        # a clear, actionable error only at the point of use, never at import.
        try:
            import gurobipy as gp
            from gurobipy import GRB
        except ImportError as exc:  # gurobipy absent: local-study-only backend.
            raise RuntimeError(_MISSING_GUROBIPY_MESSAGE) from exc

        operations = model.operations
        stations = model.stations

        gp_model = gp.Model("auto_optimize")
        # Keep Gurobi quiet, matching the production solver's msg=0.
        gp_model.setParam("OutputFlag", 0)
        # Wall-clock time limit (Req 5.1), the same bound the PuLP backend sets.
        gp_model.setParam("TimeLimit", max(1.0, float(time_limit_s)))

        # ----------------------------------------------------------------
        # VARIABLES (notebook section 5)
        # ----------------------------------------------------------------
        # x_{o,s} in {0, 1}: 1 when operation o is assigned to station s.
        x = {
            (o, s): gp_model.addVar(vtype=GRB.BINARY, name=f"x_{_safe(o)}__{_safe(s)}")
            for o in operations
            for s in stations
        }
        # n_s integer >= 0: operators at station s.
        n = {
            s: gp_model.addVar(lb=0, vtype=GRB.INTEGER, name=f"n_{_safe(s)}")
            for s in stations
        }
        # m_s integer, 1 <= m_s <= N_max_s: parallel machines at station s. The
        # per-station bound 1 <= m_s <= N_max_s from constraint 7.6 is applied on
        # the variable bounds, exactly as the PuLP backend does.
        m = {
            s: gp_model.addVar(
                lb=max(1, int(model.n_min.get(s, 1))),
                ub=max(1, int(model.n_max.get(s, 1)), int(model.n_min.get(s, 1))),
                vtype=GRB.INTEGER,
                name=f"m_{_safe(s)}",
            )
            for s in stations
        }
        # y_s in {0, 1}: 1 when station s is used (holds at least one operation).
        y = {
            s: gp_model.addVar(vtype=GRB.BINARY, name=f"y_{_safe(s)}")
            for s in stations
        }
        gp_model.update()

        # ----------------------------------------------------------------
        # OBJECTIVE (notebook section 6)
        # ----------------------------------------------------------------
        # Minimize c_op * sum_s n_s + c_mc * sum_s m_s. Pure resource-count
        # minimization, no money (Req 12.3), identical to the PuLP objective.
        gp_model.setObjective(
            model.c_op * gp.quicksum(n[s] for s in stations)
            + model.c_mc * gp.quicksum(m[s] for s in stations),
            GRB.MINIMIZE,
        )

        # ----------------------------------------------------------------
        # CONSTRAINTS (notebook section 7)
        # ----------------------------------------------------------------

        # 7.1 Each operation assigned exactly once (Req 3.1).
        for o in operations:
            gp_model.addConstr(
                gp.quicksum(x[(o, s)] for s in stations) == 1,
                name=f"assign_once_{_safe(o)}",
            )

        # 7.2 Station capacity under takt, one constraint per (line, station in
        # S_line): sum over O_line of t_o x_{o,s} <= rho_s T_line m_s
        # (Req 3.2, 11.3). A shared station lands in S_line for each line it
        # serves, so it gets one such constraint per served line; a dedicated
        # station gets exactly one (Req 11.4).
        # ONE combined-load constraint per station across every line it serves,
        # mirroring the PuLP backend (see its 7.2 comment for the derivation).
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
            # Machines for a machine-paced station, operators for a manual one
            # (mirrors the PuLP backend).
            capacity_units = m[s] if model.is_machine_paced.get(s, True) else n[s]
            gp_model.addConstr(
                gp.quicksum(terms) <= ceiling * rho * capacity_units,
                name=f"takt_cap_{_safe(s)}",
            )

        # 7.3 Precedence by station position: for (i, j) in P, the position of
        # j's station is at or downstream of i's station (Req 3.5).
        #   sum_s pi(s) x_{j,s} >= sum_s pi(s) x_{i,s}
        for index, (i, j) in enumerate(model.precedence):
            if i not in model.t or j not in model.t:
                # Skip a precedence pair that references an unknown operation key
                # rather than crashing the whole solve on a stale rule, matching
                # the PuLP backend.
                continue
            pos_j = gp.quicksum(model.station_pos.get(s, 0) * x[(j, s)] for s in stations)
            pos_i = gp.quicksum(model.station_pos.get(s, 0) * x[(i, s)] for s in stations)
            gp_model.addConstr(pos_j >= pos_i, name=f"precedence_{index}")

        # 7.4 Station locks: x_{o,s} = 1 for every lock pair (Req 3.6).
        for index, (o, s) in enumerate(model.locks):
            if (o, s) in x:
                gp_model.addConstr(x[(o, s)] == 1, name=f"lock_{index}")

        # 7.5 Operators meet assigned need: n_s >= sum_o r_o x_{o,s} (Req 3.3).
        for s in stations:
            gp_model.addConstr(
                n[s] >= gp.quicksum(model.r[o] * x[(o, s)] for o in operations),
                name=f"staffing_{_safe(s)}",
            )

        # 7.6 Resource caps: sum_s n_s <= K_op, sum_s m_s <= K_mc. The per-station
        # bound 1 <= m_s <= N_max_s is applied on the m_s variable bounds above
        # (Req 3.7, 2.11).
        gp_model.addConstr(
            gp.quicksum(n[s] for s in stations) <= model.operator_cap,
            name="operator_cap",
        )
        gp_model.addConstr(
            gp.quicksum(m[s] for s in stations) <= model.machine_cap,
            name="machine_cap",
        )

        # 7.7 Used-station linking and feasibility (Req 3.3):
        #   x_{o,s} <= y_s for all o, s   (a station holding work is used)
        #   n_s <= M y_s for all s        (only a used station carries operators)
        for o in operations:
            for s in stations:
                gp_model.addConstr(x[(o, s)] <= y[s], name=f"use_link_{_safe(o)}__{_safe(s)}")
        for s in stations:
            gp_model.addConstr(n[s] <= model.big_m * y[s], name=f"use_staff_{_safe(s)}")

        # ----------------------------------------------------------------
        # WARM START (optional, seeds the search only)
        # ----------------------------------------------------------------
        self._apply_warm_start(warm_start, x, n, m, y, model)

        # ----------------------------------------------------------------
        # SOLVE under the wall-clock time limit (Req 5.1)
        # ----------------------------------------------------------------
        gp_model.optimize()

        # ----------------------------------------------------------------
        # READ BACK the status, objective, gap, and variable values
        # ----------------------------------------------------------------
        return self._build_result(gp_model, GRB, model, x, n, m, y)

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
        """Seed variable start values from a warm start when one is provided.

        Mirrors PulpCbcSolver._apply_warm_start: the warm start only hands the
        solver an early incumbent via each variable's Start attribute and never
        alters the feasible region. A missing warm start, or any key absent from
        it, leaves variables unseeded. Operator and machine starts are clamped to
        the variable bounds so an out-of-range seed never rejects the start.
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
                seed = int(round(value))
                var.Start = seed
                if seed == 1:
                    used.add(s)
        for s, var in n.items():
            value = ws_n.get(s)
            if value is not None:
                var.Start = max(0, int(round(value)))
        for s, var in m.items():
            value = ws_m.get(s)
            if value is not None:
                lo = 1
                hi = max(1, int(model.n_max.get(s, 1)))
                var.Start = min(hi, max(lo, int(round(value))))
        # y_s follows from whether the station holds any started operation.
        for s, var in y.items():
            var.Start = 1 if s in used else 0

    @classmethod
    def _build_result(
        cls,
        gp_model,
        GRB,
        model: OptModel,
        x: dict,
        n: dict,
        m: dict,
        y: dict,
    ) -> SolveResult:
        """Read the solved Gurobi model into a pure SolveResult (Req 5.2, 5.4).

        Classifies the solve into the exact four-value status vocabulary and
        fills gap_pct to match the production backend:

          - optimal             -> gap_pct 0.00
          - feasible_timeout    -> the relative gap clamped to [0.00, 100.00]
          - infeasible          -> gap_pct None
          - no_feasible_timeout -> gap_pct None

        The classification keys off Gurobi's model Status together with the
        count of stored solutions (SolCount), which is the Gurobi analogue of
        the PuLP sol_status plus has_solution pair: Status OPTIMAL is a proven
        optimum; Status TIME_LIMIT with SolCount > 0 is a feasible incumbent at
        the limit; Status INFEASIBLE is a proven infeasibility; Status
        TIME_LIMIT with SolCount == 0 is a timeout with no incumbent.
        """
        sol_count = int(getattr(gp_model, "SolCount", 0) or 0)
        has_solution = sol_count > 0
        status_code = int(getattr(gp_model, "Status", 0) or 0)

        objective: Optional[float] = None
        if has_solution:
            # Catch AttributeError plus gurobipy's own error raised when an
            # attribute is read in a state that does not define it.
            read_errors = (AttributeError,) + gp_model_error_types()
            try:
                objective = float(gp_model.ObjVal)
            except read_errors:
                objective = None

        status = cls._classify_status(status_code, GRB, has_solution)

        if status == _STATUS_OPTIMAL:
            # Proven optimal within the limit: the incumbent equals the bound, so
            # the gap is zero by definition (Req 5.2 proven-optimal case).
            gap_pct: Optional[float] = 0.0
        elif status == _STATUS_FEASIBLE_TIMEOUT:
            # Time limit reached with a feasible incumbent: report the relative
            # gap from Gurobi's MIPGap attribute, clamped to [0.00, 100.00]
            # (Req 5.2 timeout-with-incumbent case). MIPGap is a fraction, so
            # multiply by 100 to express it as a percentage.
            gap_pct = cls._relative_gap_pct(gp_model)
        else:
            # infeasible or no_feasible_timeout: no meaningful gap to report.
            gap_pct = None

        # Read back variable values only when a solution exists; otherwise fill
        # zeros so the SolveResult stays well-formed, matching the PuLP backend.
        if has_solution:
            x_values = {(o, s): _as_int(var.X) for (o, s), var in x.items()}
            n_values = {s: _as_int(var.X) for s, var in n.items()}
            m_values = {s: max(1, _as_int(var.X)) for s, var in m.items()}
            y_values = {s: _as_int(var.X) for s, var in y.items()}
        else:
            x_values = {(o, s): 0 for (o, s) in x}
            n_values = {s: 0 for s in n}
            m_values = {s: 1 for s in m}
            y_values = {s: 0 for s in y}

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
    def _relative_gap_pct(gp_model) -> Optional[float]:
        """Return Gurobi's relative optimality gap as a percentage in [0, 100].

        Gurobi exposes MIPGap as a relative gap fraction (0.02 means two
        percent). Convert it to a percentage and clamp to [0.00, 100.00] to
        match the feasible_timeout contract (Req 5.2). When the attribute is
        unavailable, return None so the service reports an unknown gap rather
        than a false precise one.
        """
        try:
            gap_fraction = float(gp_model.MIPGap)
        except (AttributeError, TypeError, ValueError):
            return None
        return max(0.0, min(100.0, gap_fraction * 100.0))

    @staticmethod
    def _classify_status(status_code, GRB, has_solution: bool) -> str:
        """Map Gurobi's model Status to the exact SolveResult vocabulary.

        Implements the shared status mapping term for term (Req 5.2, 5.4),
        identical in outcome to PulpCbcSolver._classify_status:

          - Status OPTIMAL                     -> optimal
          - Status TIME_LIMIT with a solution  -> feasible_timeout
          - Status INFEASIBLE                  -> infeasible
          - Status TIME_LIMIT with no solution -> no_feasible_timeout

        The has_solution flag, read from SolCount, acts as a safety net so a
        stored incumbent is never discarded on an unexpected status code, and an
        empty solution is never presented as feasible. A status such as
        INF_OR_UNBD or UNBOUNDED with no solution is treated as infeasible,
        mirroring how the production backend treats a proven no-solution case.
        """
        if status_code == GRB.OPTIMAL and has_solution:
            # Proven optimal within the limit.
            return _STATUS_OPTIMAL
        if status_code == GRB.TIME_LIMIT:
            # Stopped at the time limit: feasible if an incumbent was stored,
            # otherwise no feasible solution was found in time.
            return _STATUS_FEASIBLE_TIMEOUT if has_solution else _STATUS_NO_FEASIBLE_TIMEOUT
        if status_code in (GRB.INFEASIBLE, GRB.INF_OR_UNBD, GRB.UNBOUNDED) and not has_solution:
            # Proven infeasible (or unbounded with no usable incumbent).
            return _STATUS_INFEASIBLE

        # Safety net for any other terminal code: trust the presence of an actual
        # stored solution. A populated incumbent not marked optimal is a
        # feasible-but-unproven result; an empty one means no feasible solution
        # was produced within the limit.
        if has_solution:
            return _STATUS_FEASIBLE_TIMEOUT if status_code != GRB.OPTIMAL else _STATUS_OPTIMAL
        return _STATUS_NO_FEASIBLE_TIMEOUT


def gp_model_error_types() -> tuple:
    """Return the gurobipy error type to catch when reading solved attributes.

    gurobipy raises gurobipy.GurobiError when an attribute is read in a state
    that does not define it (for example ObjVal with no solution). This resolves
    that type lazily so the module never imports gurobipy at top level; it is
    only called from inside solve, after gurobipy has been imported. When the
    type cannot be resolved, an empty tuple is returned so only AttributeError is
    caught.
    """
    try:
        import gurobipy as gp

        return (gp.GurobiError,)
    except ImportError:
        return tuple()


def _as_int(value) -> int:
    """Round a solver variable value to the nearest integer, treating None as 0.

    Gurobi returns floating point values for integer variables (for example
    0.9999 or 2.0001); rounding recovers the intended integer. A None value
    becomes 0. This matches PulpCbcSolver._as_int so both backends read values
    back identically.
    """
    if value is None:
        return 0
    return int(round(value))


def _station_to_lines(model) -> dict:
    """Return each station id mapped to the list of lines it serves.

    Inverts model.stations_of_line so the combined-load takt constraint can sum
    a shared station's demand across every line it serves. Mirrors the helper in
    the PuLP backend.
    """
    mapping: dict = {}
    for line, station_ids in model.stations_of_line.items():
        for sid in station_ids:
            mapping.setdefault(sid, [])
            if line not in mapping[sid]:
                mapping[sid].append(line)
    return mapping


def _safe(key: str) -> str:
    """Return a key sanitized for use inside a Gurobi variable or constraint name.

    Gurobi rejects spaces and several punctuation characters in names. The stable
    operation keys use a space (for example "station_1 0"), so replace characters
    the solver dislikes with underscores. This affects only the internal solver
    name, never the OptModel keys read back into the SolveResult. Matches
    PulpCbcSolver._safe so the two backends name variables the same way.
    """
    out = []
    for ch in str(key):
        if ch.isalnum() or ch == "_":
            out.append(ch)
        else:
            out.append("_")
    return "".join(out)
