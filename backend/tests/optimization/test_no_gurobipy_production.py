"""Test that gurobipy is NOT imported on the production solve path.

Feature: auto-optimize, Task 7.6.

Requirement 5.7 says the deployed application uses a free open-source solver
(PuLP with the bundled CBC binary) and introduces no Gurobi dependency. The
only place a Gurobi backend may be touched is behind an explicit, lazy import
in get_solver(name="gurobi"); the default production path must never pull in
gurobipy.

This is a required core test, not an optional property test. It guards the
Req 5.7 guarantee at two points:

  1. Importing app.optimization.service and app.optimization.solver (the modules
     the router and orchestrator load) does NOT import gurobipy.
  2. Running a FULL PuLP/CBC solve through run_optimize on a small feasible
     single-line layout leaves gurobipy absent from sys.modules.

Each check first pops "gurobipy" from sys.modules so the assertion reflects only
the work done in that test, not any stray import left by another module.

This file follows the project rule that no em dashes or en dashes appear
anywhere. Only ASCII hyphens are used, in prose, code, comments, and strings.
"""

import importlib
import sys

from app.optimization.model_builder import build_model
from app.optimization.service import run_optimize
from app.simulation.models import (
    Connection,
    Layout,
    LineInfo,
    Operation,
    SimulationConfig,
    Sink,
    Source,
    Station,
)


class _Constraints:
    """Minimal duck-typed constraints object with current-layout defaults.

    Mirrors the shape build_model reads: caps left as None so the builder uses
    safe current-layout defaults, no precedence or locks, machines allowed, and
    unit objective weights. A zero-edit run against a comfortably feasible
    layout, so the solve returns a proposal rather than infeasible.
    """

    operator_cap = None
    machine_cap = None
    per_station_machine_limit = None
    allow_add_machines = True
    precedence = []
    locks = []
    operator_weight = 1.0
    machine_weight = 1.0


def _small_feasible_layout() -> Layout:
    """A small single-line layout: source -> st-a -> st-b -> sink.

    Two light operations against a comfortable 20s takt, so the PuLP/CBC solve
    finds a feasible, buildable proposal quickly. One LineInfo supplies the takt
    so no SimulationConfig fallback is needed.
    """
    return Layout(
        sources=[Source(id="src", name="Source", x=0.0, y=0.0, arrival_rate=60.0, line_id="L1")],
        stations=[
            Station(
                id="st-a",
                name="Station A",
                x=100.0,
                y=50.0,
                cycle_time=1.0,
                num_machines=1,
                operators_required=1,
                line_ids=["L1"],
                operations=[Operation(name="drill", cycle_time=5.0, operators_required=1)],
            ),
            Station(
                id="st-b",
                name="Station B",
                x=200.0,
                y=75.0,
                cycle_time=1.0,
                num_machines=1,
                operators_required=1,
                line_ids=["L1"],
                operations=[Operation(name="weld", cycle_time=5.0, operators_required=1)],
            ),
        ],
        sinks=[Sink(id="snk", name="Sink", x=300.0, y=0.0, line_id="L1")],
        connections=[
            Connection(id="c1", source_id="src", target_id="st-a"),
            Connection(id="c2", source_id="st-a", target_id="st-b"),
            Connection(id="c3", source_id="st-b", target_id="snk"),
        ],
        lines=[LineInfo(id="L1", name="Line 1", takt_time=20.0)],
    )


def test_importing_service_and_solver_does_not_import_gurobipy():
    """Loading the orchestrator and solver modules never pulls in gurobipy.

    get_solver defaults to the PuLP/CBC backend and only lazily imports a Gurobi
    backend when explicitly asked for name == "gurobi". Simply importing (or
    re-importing) the service and solver modules must therefore leave gurobipy
    absent from sys.modules (Req 5.7).
    """
    # Drop any stray import so the assertion reflects this run only.
    sys.modules.pop("gurobipy", None)

    # Re-import the production modules to exercise their import-time code again.
    service = importlib.import_module("app.optimization.service")
    solver = importlib.import_module("app.optimization.solver")
    importlib.reload(solver)
    importlib.reload(service)

    assert "gurobipy" not in sys.modules


def test_full_pulp_solve_does_not_import_gurobipy():
    """A full run_optimize PuLP/CBC solve never imports gurobipy (Req 5.7).

    Builds a small feasible single-line layout, confirms it models cleanly, then
    runs the whole optimize pipeline (build, warm start, PuLP/CBC solve,
    translate, simulate). After the run, gurobipy must still be absent from
    sys.modules: production never touches the Gurobi backend.
    """
    layout = _small_feasible_layout()
    constraints = _Constraints()
    config = SimulationConfig()

    # Sanity check: the model builds and the solve path is the feasible branch,
    # so this test exercises a genuine full PuLP solve rather than an early exit.
    model = build_model(layout, constraints, config)
    assert model.operations

    # Drop any stray import so the assertion reflects only this run.
    sys.modules.pop("gurobipy", None)

    result = run_optimize(layout, constraints, config)

    # The run exercised a real solve (not infeasible, not a zero-line reject).
    assert result.status in ("optimal", "feasible_timeout")
    # The production PuLP/CBC path never imports gurobipy (Req 5.7).
    assert "gurobipy" not in sys.modules
