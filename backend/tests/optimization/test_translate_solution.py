"""Unit tests for translate_solution in the MILP builder.

Feature: auto-optimize, Task 3.1.

translate_solution is a PURE function that turns a SolveResult into a NEW
proposed Layout. It must:
  - preserve every field the optimizer does not decide (names, x, y, line_ids,
    connections, sources, sinks, buffers, operator pools, line settings),
  - never write or recompute x or y,
  - never mutate the input layout,
  - reassign each operation to the station where x_{o,s} == 1, carrying the
    Operation object by identity so work content is conserved,
  - set each station's num_machines from m_s and operators_required from n_s.

These tests follow the project rule that no em dashes or en dashes appear
anywhere. Only ASCII hyphens are used.
"""

from app.optimization.model_builder import (
    SolveResult,
    build_model,
    translate_solution,
)
from app.simulation.models import (
    Connection,
    Layout,
    LineInfo,
    Operation,
    OperatorPool,
    SimulationConfig,
    Sink,
    Source,
    Station,
)


def _two_station_layout() -> Layout:
    """A simple single-line layout: source -> st-a -> st-b -> sink.

    st-a holds two operations, st-b holds one operation.
    """
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
                num_machines=2,
                operators_required=1,
                operations=[
                    Operation(name="weld", cycle_time=5.0, operators_required=1),
                ],
            ),
        ],
        sinks=[Sink(id="snk", name="Sink", x=300.0, y=0.0)],
        operator_pools=[OperatorPool(id="pool", name="Pool", x=10.0, y=10.0, count=5)],
        connections=[
            Connection(id="c1", source_id="src", target_id="st-a"),
            Connection(id="c2", source_id="st-a", target_id="st-b"),
            Connection(id="c3", source_id="st-b", target_id="snk"),
        ],
        lines=[LineInfo(id="L1", name="Line 1", takt_time=20.0)],
    )


def _identity_solution(model) -> SolveResult:
    """A solution that keeps every operation on its original station.

    Each operation key has the form "station_id index", so the owning station is
    the key's prefix before the position. Counts are left at the current values.
    """
    x: dict[tuple[str, str], int] = {}
    for op_key in model.operations:
        owning = op_key.rpartition(" ")[0]
        for sid in model.stations:
            x[(op_key, sid)] = 1 if sid == owning else 0
    n = {"st-a": 3, "st-b": 1}
    m = {"st-a": 1, "st-b": 2}
    y = {sid: 1 for sid in model.stations}
    return SolveResult(status="optimal", objective=0.0, gap_pct=0.0, x=x, n=n, m=m, y=y)


def test_preserves_positions_and_unrelated_data():
    """x, y, names, connections, sources, sinks, pools, and lines are unchanged."""
    layout = _two_station_layout()
    model = build_model(layout, constraints=object(), config=SimulationConfig())
    result = _identity_solution(model)

    proposed = translate_solution(layout, model, result)

    # Every station keeps its exact x, y, name, and id.
    for original, new in zip(layout.stations, proposed.stations):
        assert new.id == original.id
        assert new.name == original.name
        assert new.x == original.x
        assert new.y == original.y

    # Sources, sinks, operator pools, connections, and lines are identical.
    assert proposed.sources == layout.sources
    assert proposed.sinks == layout.sinks
    assert proposed.operator_pools == layout.operator_pools
    assert proposed.connections == layout.connections
    assert proposed.lines == layout.lines


def test_does_not_mutate_input_layout():
    """The input layout is untouched; a new Layout is returned."""
    layout = _two_station_layout()
    model = build_model(layout, constraints=object(), config=SimulationConfig())
    # A solution that moves every operation to st-b and changes counts.
    x = {(op_key, sid): (1 if sid == "st-b" else 0)
         for op_key in model.operations for sid in model.stations}
    result = SolveResult(
        status="optimal", objective=0.0, gap_pct=0.0,
        x=x, n={"st-a": 0, "st-b": 4}, m={"st-a": 1, "st-b": 3},
        y={"st-a": 0, "st-b": 1},
    )

    before_a_ops = [op.name for op in layout.stations[0].operations]
    before_a_machines = layout.stations[0].num_machines

    proposed = translate_solution(layout, model, result)

    # The original layout keeps its original station A contents and counts.
    assert [op.name for op in layout.stations[0].operations] == before_a_ops
    assert layout.stations[0].num_machines == before_a_machines
    # The returned layout is a distinct object.
    assert proposed is not layout


def test_reassigns_operations_to_solution_station():
    """Operations land on the station where x_{o,s} == 1, conserving work content."""
    layout = _two_station_layout()
    model = build_model(layout, constraints=object(), config=SimulationConfig())
    # Move everything to st-a.
    x = {(op_key, sid): (1 if sid == "st-a" else 0)
         for op_key in model.operations for sid in model.stations}
    result = SolveResult(
        status="optimal", objective=0.0, gap_pct=0.0,
        x=x, n={"st-a": 4, "st-b": 0}, m={"st-a": 1, "st-b": 1},
        y={"st-a": 1, "st-b": 0},
    )

    proposed = translate_solution(layout, model, result)
    by_id = {s.id: s for s in proposed.stations}

    # All three operations are on st-a now, none on st-b.
    assert sorted(op.name for op in by_id["st-a"].operations) == ["drill", "press", "weld"]
    assert by_id["st-b"].operations == []
    # Work content is conserved: per-operation cycle times are carried over.
    ct_by_name = {op.name: op.cycle_time for op in by_id["st-a"].operations}
    assert ct_by_name == {"drill": 4.0, "press": 6.0, "weld": 5.0}


def test_sets_machine_and_operator_counts_from_solution():
    """num_machines comes from m_s and operators_required from n_s."""
    layout = _two_station_layout()
    model = build_model(layout, constraints=object(), config=SimulationConfig())
    result = _identity_solution(model)
    result = SolveResult(
        status="optimal", objective=0.0, gap_pct=0.0,
        x=result.x, n={"st-a": 7, "st-b": 2}, m={"st-a": 3, "st-b": 4},
        y=result.y,
    )

    proposed = translate_solution(layout, model, result)
    by_id = {s.id: s for s in proposed.stations}

    assert by_id["st-a"].num_machines == 3
    assert by_id["st-a"].operators_required == 7
    assert by_id["st-b"].num_machines == 4
    assert by_id["st-b"].operators_required == 2


def test_empty_station_synthetic_operation_is_materialized():
    """A flat (empty operations) station's synthetic op is carried on reassignment."""
    layout = Layout(
        stations=[
            Station(id="st-flat", name="Flat", x=10.0, y=20.0,
                    cycle_time=9.0, operators_required=2),
            Station(id="st-dest", name="Dest", x=30.0, y=40.0,
                    cycle_time=1.0,
                    operations=[Operation(name="keep", cycle_time=2.0)]),
        ],
        lines=[LineInfo(id="L1", name="Line 1", takt_time=50.0)],
    )
    model = build_model(layout, constraints=object(), config=SimulationConfig())
    # Move the flat station's synthetic op to st-dest, keep "keep" on st-dest.
    x: dict[tuple[str, str], int] = {}
    for op_key in model.operations:
        target = "st-dest"
        for sid in model.stations:
            x[(op_key, sid)] = 1 if sid == target else 0
    result = SolveResult(
        status="optimal", objective=0.0, gap_pct=0.0,
        x=x, n={"st-flat": 0, "st-dest": 2}, m={"st-flat": 1, "st-dest": 1},
        y={"st-flat": 0, "st-dest": 1},
    )

    proposed = translate_solution(layout, model, result)
    by_id = {s.id: s for s in proposed.stations}

    # The synthetic operation (named after the flat station) is materialized on
    # st-dest with the flat station's work content conserved.
    dest_ops = {op.name: op.cycle_time for op in by_id["st-dest"].operations}
    assert dest_ops == {"Flat": 9.0, "keep": 2.0}
    assert by_id["st-flat"].operations == []
    # Positions are preserved for both stations.
    assert (by_id["st-flat"].x, by_id["st-flat"].y) == (10.0, 20.0)
    assert (by_id["st-dest"].x, by_id["st-dest"].y) == (30.0, 40.0)
