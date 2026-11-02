"""Unit tests for build_warm_start in the optimization service.

Feature: auto-optimize, Task 6.1.

build_warm_start converts the existing line balancer output into an initial
x, n, m seed for the solver. The seed must:
  - have the shape the solver accepts ({"x": ..., "n": ..., "m": ...}),
  - key x by the OptModel's stable operation keys and station ids,
  - run the balancer once for a single line and per line for multiple lines,
  - never break feasibility when handed to the solver,
  - degrade gracefully (partial or no seed) when it cannot map cleanly.

These tests follow the project rule that no em dashes or en dashes appear
anywhere. Only ASCII hyphens are used.
"""

from app.optimization.model_builder import build_model
from app.optimization.service import build_warm_start
from app.optimization.solver import PulpCbcSolver
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
    """Minimal duck-typed constraints object with current-layout defaults."""

    precedence = []
    locks = []
    operator_cap = None
    machine_cap = None
    per_station_machine_limit = None
    allow_add_machines = True
    operator_weight = 1.0
    machine_weight = 1.0


def _single_line_layout() -> Layout:
    """A single line: source -> st-a -> st-b -> sink, with a comfortable takt."""
    return Layout(
        sources=[Source(id="src", name="Source", x=0.0, y=0.0, arrival_rate=60.0)],
        stations=[
            Station(
                id="st-a",
                name="Station A",
                x=100.0,
                y=50.0,
                cycle_time=1.0,
                num_machines=1,
                operators_required=1,
                operations=[
                    Operation(name="drill", cycle_time=4.0, operators_required=1),
                    Operation(name="press", cycle_time=6.0, operators_required=2),
                ],
            ),
            Station(
                id="st-b",
                name="Station B",
                x=200.0,
                y=75.0,
                cycle_time=1.0,
                num_machines=1,
                operators_required=1,
                operations=[
                    Operation(name="weld", cycle_time=5.0, operators_required=1),
                    Operation(name="pack", cycle_time=3.0, operators_required=1),
                ],
            ),
        ],
        sinks=[Sink(id="snk", name="Sink", x=300.0, y=0.0)],
        connections=[
            Connection(id="c1", source_id="src", target_id="st-a"),
            Connection(id="c2", source_id="st-a", target_id="st-b"),
            Connection(id="c3", source_id="st-b", target_id="snk"),
        ],
        lines=[LineInfo(id="L1", name="Line 1", takt_time=20.0)],
    )


def _multi_line_layout() -> Layout:
    """Two explicit lines, each a source -> station -> sink flow.

    Line A: src-a -> st-a1 -> st-a2 -> snk-a with takt 25.
    Line B: src-b -> st-b1 -> snk-b with takt 15.
    """
    return Layout(
        sources=[
            Source(id="src-a", name="Source A", x=0.0, y=0.0, arrival_rate=60.0, line_id="LA"),
            Source(id="src-b", name="Source B", x=0.0, y=200.0, arrival_rate=60.0, line_id="LB"),
        ],
        stations=[
            Station(
                id="st-a1", name="A1", x=100.0, y=0.0, cycle_time=1.0,
                num_machines=1, operators_required=1, line_ids=["LA"],
                operations=[
                    Operation(name="a-drill", cycle_time=10.0, operators_required=1),
                    Operation(name="a-press", cycle_time=8.0, operators_required=1),
                ],
            ),
            Station(
                id="st-a2", name="A2", x=200.0, y=0.0, cycle_time=1.0,
                num_machines=1, operators_required=1, line_ids=["LA"],
                operations=[
                    Operation(name="a-weld", cycle_time=12.0, operators_required=2),
                ],
            ),
            Station(
                id="st-b1", name="B1", x=100.0, y=200.0, cycle_time=1.0,
                num_machines=1, operators_required=1, line_ids=["LB"],
                operations=[
                    Operation(name="b-cut", cycle_time=6.0, operators_required=1),
                    Operation(name="b-pack", cycle_time=5.0, operators_required=1),
                ],
            ),
        ],
        sinks=[
            Sink(id="snk-a", name="Sink A", x=300.0, y=0.0, line_id="LA"),
            Sink(id="snk-b", name="Sink B", x=300.0, y=200.0, line_id="LB"),
        ],
        connections=[
            Connection(id="ca1", source_id="src-a", target_id="st-a1"),
            Connection(id="ca2", source_id="st-a1", target_id="st-a2"),
            Connection(id="ca3", source_id="st-a2", target_id="snk-a"),
            Connection(id="cb1", source_id="src-b", target_id="st-b1"),
            Connection(id="cb2", source_id="st-b1", target_id="snk-b"),
        ],
        lines=[
            LineInfo(id="LA", name="Line A", takt_time=25.0),
            LineInfo(id="LB", name="Line B", takt_time=15.0),
        ],
    )


def _assert_well_formed(warm_start, model):
    """A warm start must have the solver's shape and key only known ids."""
    assert warm_start is not None
    assert set(warm_start.keys()) == {"x", "n", "m"}

    model_ops = set(model.operations)
    model_stations = set(model.stations)

    for (op_key, station_id), value in warm_start["x"].items():
        assert op_key in model_ops
        assert station_id in model_stations
        assert value in (0, 1)
    for station_id, operators in warm_start["n"].items():
        assert station_id in model_stations
        assert operators >= 0
    for station_id, machines in warm_start["m"].items():
        assert station_id in model_stations
        # m must respect the model's [1, N_max_s] bound so it never widens the
        # feasible region.
        assert 1 <= machines <= max(1, model.n_max.get(station_id, 1))


def test_single_line_warm_start_is_well_formed():
    """A single-line layout produces a well-formed seed keyed by model ids."""
    layout = _single_line_layout()
    model = build_model(layout, _Constraints(), SimulationConfig())

    warm_start = build_warm_start(layout, model)

    _assert_well_formed(warm_start, model)
    # Every operation on the line is seeded to exactly one station.
    assigned = {op for (op, _s), v in warm_start["x"].items() if v == 1}
    assert assigned == set(model.operations)


def test_multi_line_warm_start_is_well_formed():
    """A multi-line layout seeds each line against its own takt and station set."""
    layout = _multi_line_layout()
    model = build_model(layout, _Constraints(), SimulationConfig())

    warm_start = build_warm_start(layout, model)

    _assert_well_formed(warm_start, model)
    # Each seeded operation sits on a station that genuinely serves its line.
    for (op_key, station_id), value in warm_start["x"].items():
        if value != 1:
            continue
        owning_line = next(
            line for line, ops in model.ops_of_line.items() if op_key in ops
        )
        assert station_id in model.stations_of_line[owning_line]


def test_single_line_warm_start_keeps_solve_feasible():
    """Feeding the single-line seed to the solver still yields a feasible solve."""
    layout = _single_line_layout()
    model = build_model(layout, _Constraints(), SimulationConfig())
    warm_start = build_warm_start(layout, model)

    result = PulpCbcSolver().solve(model, time_limit_s=10, warm_start=warm_start)

    assert result.status in ("optimal", "feasible_timeout")
    # Every operation is assigned exactly once (feasibility sanity check).
    for op_key in model.operations:
        assigned = sum(result.x.get((op_key, s), 0) for s in model.stations)
        assert assigned == 1


def test_multi_line_warm_start_keeps_solve_feasible():
    """Feeding the multi-line seed to the solver still yields a feasible solve."""
    layout = _multi_line_layout()
    model = build_model(layout, _Constraints(), SimulationConfig())
    warm_start = build_warm_start(layout, model)

    result = PulpCbcSolver().solve(model, time_limit_s=10, warm_start=warm_start)

    assert result.status in ("optimal", "feasible_timeout")
    for op_key in model.operations:
        assigned = sum(result.x.get((op_key, s), 0) for s in model.stations)
        assert assigned == 1


def test_warm_start_matches_unseeded_solve_objective():
    """The seed only hints; a seeded and unseeded solve reach the same optimum."""
    layout = _single_line_layout()
    model = build_model(layout, _Constraints(), SimulationConfig())
    warm_start = build_warm_start(layout, model)

    seeded = PulpCbcSolver().solve(model, time_limit_s=10, warm_start=warm_start)
    unseeded = PulpCbcSolver().solve(model, time_limit_s=10, warm_start=None)

    assert seeded.status == "optimal"
    assert unseeded.status == "optimal"
    # The warm start never changes the feasible region, so the proven optimum is
    # identical with or without it.
    assert seeded.objective == unseeded.objective


def test_best_effort_balance_yields_no_seed():
    """An operation that cannot fit the takt yields no seed, not a bad one."""
    # The single operation's cycle time exceeds the takt, so the balancer returns
    # best_effort and no feasible within-takt start exists.
    layout = Layout(
        stations=[
            Station(
                id="st-x", name="Station X", x=0.0, y=0.0, cycle_time=1.0,
                num_machines=1, operators_required=1, line_ids=["L1"],
                operations=[Operation(name="huge", cycle_time=100.0, operators_required=1)],
            ),
        ],
        lines=[LineInfo(id="L1", name="Line 1", takt_time=10.0)],
    )
    model = build_model(layout, _Constraints(), SimulationConfig())

    warm_start = build_warm_start(layout, model)

    assert warm_start is None
