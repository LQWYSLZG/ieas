"""Measured WIP must count units in service, not just queued units.

A producing line with no buffer and no backlog still holds its in-service units,
so by Little's Law (WIP = throughput * lead time) its WIP must be greater than
zero. This pins the fix that adds in-service units to the measured WIP so a
smoothly flowing line never falsely reports 0 WIP.
"""

import app.simulation.engine as engine
from app.simulation.engine import run_simulation
from app.simulation.models import Layout, Source, Station, Sink, Connection, SimulationConfig


def _line_layout() -> Layout:
    """A simple Source -> Station -> Sink line, no buffer."""
    return Layout(
        schema_version=1,
        sources=[Source(id="src", name="Source", element_type="source", x=0, y=0, arrival_rate=60, batch_size=1, variability=0.0)],
        stations=[Station(id="st", name="Press", element_type="station", x=1, y=0, cycle_time=40, num_machines=1, operators_required=0, reliability=100, scrap_rate=0, setup_time=0, variability=0.0, operations=[])],
        buffers=[],
        sinks=[Sink(id="snk", name="Sink", element_type="sink", x=2, y=0)],
        operator_pools=[],
        connections=[
            Connection(id="c1", source_id="src", target_id="st", transport_time=0, transport_mode="none", distance=0),
            Connection(id="c2", source_id="st", target_id="snk", transport_time=0, transport_mode="none", distance=0),
        ],
    )


def test_wip_counts_in_service_units_on_flowing_line():
    engine.SIMULATION_SEED = 42
    try:
        layout = _line_layout()
        config = SimulationConfig(duration_seconds=3600, warmup_seconds=120, target_throughput=90, takt_time=40)
        result = run_simulation(layout, config)
    finally:
        engine.SIMULATION_SEED = None

    # The line produces, so lead time and throughput are positive.
    assert result.throughput > 0
    assert result.avg_lead_time > 0

    # Measured WIP must be greater than zero: at least the in-service unit(s).
    assert result.wip_total > 0, f"WIP should be > 0 on a producing line, got {result.wip_total}"

    # And it should be in the right ballpark of Little's Law (throughput per
    # second * lead time). Allow a generous band since the sim is stochastic and
    # the integral excludes the final tail interval.
    littles_law_wip = (result.throughput / 3600.0) * result.avg_lead_time
    assert littles_law_wip > 0
    # Measured and Little's Law WIP should agree to within a wide tolerance.
    assert abs(result.wip_total - littles_law_wip) <= max(1.0, littles_law_wip)