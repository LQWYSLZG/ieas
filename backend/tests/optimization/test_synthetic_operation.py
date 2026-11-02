"""Unit tests for the synthetic-operation case in the MILP builder.

Feature: auto-optimize, Task 2.4.

A Station with an empty operations list must contribute exactly one synthetic
operation built from its flat cycle_time and operators_required, so that no
station is dropped and its work content is conserved in the OptModel. This
mirrors simulation/line_balancer._collect_operations, which does the same
conservation in the simulation layer.

These tests follow the project rule that no em dashes or en dashes appear
anywhere. Only ASCII hyphens are used.
"""

from app.optimization.model_builder import (
    _collect_station_operations,
    build_model,
)
from app.simulation.line_balancer import _collect_operations
from app.simulation.models import Layout, Operation, SimulationConfig, Station


def _flat_station() -> Station:
    """A station with no operations and a flat cycle_time / operators_required."""
    return Station(
        id="st-flat",
        name="Flat Station",
        x=100.0,
        y=50.0,
        cycle_time=12.5,
        operators_required=3,
    )


def _ops_station() -> Station:
    """A station with an explicit ordered operations list."""
    return Station(
        id="st-ops",
        name="Ops Station",
        x=200.0,
        y=50.0,
        cycle_time=1.0,
        operations=[
            Operation(name="drill", cycle_time=4.0, operators_required=1),
            Operation(name="press", cycle_time=6.0, operators_required=2),
        ],
    )


def test_empty_operations_yields_one_synthetic_operation():
    """An empty station contributes exactly one synthetic operation."""
    station = _flat_station()
    collected = _collect_station_operations(station)

    assert len(collected) == 1
    op_key, cycle_time, operators_required = collected[0]
    # Keyed at position zero for the station's synthetic fallback operation.
    assert op_key == "st-flat 0"
    # Work content and staffing are taken from the station's flat fields.
    assert cycle_time == 12.5
    assert operators_required == 3


def test_synthetic_operation_conserves_flat_work_like_line_balancer():
    """The builder and the line balancer agree on the conserved flat work."""
    station = _flat_station()

    # The builder's synthetic operation.
    _, builder_ct, builder_ops = _collect_station_operations(station)[0]

    # The simulation layer's synthetic operation for the same station.
    layout = Layout(stations=[station])
    balancer_ops = _collect_operations(layout)
    assert len(balancer_ops) == 1
    balancer_op = balancer_ops[0]

    # Both layers conserve the same cycle time and operator requirement, so the
    # optimizer and the simulation see identical work content for the station.
    assert builder_ct == balancer_op.cycle_time
    assert builder_ops == balancer_op.operators_required


def test_non_empty_operations_are_not_synthesized():
    """A station with operations contributes one entry per operation, in order."""
    station = _ops_station()
    collected = _collect_station_operations(station)

    assert [key for key, _, _ in collected] == ["st-ops 0", "st-ops 1"]
    assert [ct for _, ct, _ in collected] == [4.0, 6.0]
    assert [ops for _, _, ops in collected] == [1, 2]


def test_build_model_keeps_empty_station_and_its_work():
    """build_model represents an empty station by one synthetic operation.

    The station is not dropped: its id appears in S, its synthetic operation key
    appears in O, and the cycle time and operator requirement map to the flat
    station values so work content is conserved end to end.
    """
    flat = _flat_station()
    ops = _ops_station()
    layout = Layout(stations=[flat, ops])

    model = build_model(layout, constraints=object(), config=SimulationConfig())

    # Both stations survive into S.
    assert "st-flat" in model.stations
    # The empty station contributes exactly one synthetic operation into O.
    flat_keys = [key for key in model.operations if key.startswith("st-flat ")]
    assert flat_keys == ["st-flat 0"]
    # Its conserved work content and staffing are the station's flat values.
    assert model.t["st-flat 0"] == 12.5
    assert model.r["st-flat 0"] == 3
