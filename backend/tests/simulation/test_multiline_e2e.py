"""End to end multi-line integration test.

Feature: multi-line-simulation, Task 26.

Builds a layout with TWO lines that SHARE ONE station, runs the simulation
through the real /run HTTP route with FastAPI's TestClient, and asserts the
per-line breakdown: two PerLineResult entries, the shared station flagged in
each line with both line ids, its line_shares summing to its aggregate totals,
and the rollup throughput equal to the sum of per-line throughput.

Requirements traced: 5.1, 5.7, 6.5, 8.7
"""

from fastapi.testclient import TestClient

from app.main import app


RUN_URL = "/api/v1/operations-assistant/simulator/run"

LINE_A_ID = "line-a"
LINE_B_ID = "line-b"
SHARED_STATION_ID = "shared-station"


def _build_shared_station_layout() -> dict:
    """Build a two line layout that shares one station.

    Line A: Source1 to SharedStation to Sink1.
    Line B: Source2 to SharedStation to Sink2.

    The shared station carries both line ids explicitly, has two machines and a
    sensible cycle time, and layout.lines declares the two lines. Sources and
    sinks carry a distinct explicit line_id each so the resolver keeps the two
    lines distinct while flagging the station as shared.
    """
    return {
        "schema_version": 4,
        "sources": [
            {
                "id": "src-a",
                "name": "Source A",
                "element_type": "source",
                "x": 0.0,
                "y": 0.0,
                "arrival_rate": 120.0,
                "line_id": LINE_A_ID,
            },
            {
                "id": "src-b",
                "name": "Source B",
                "element_type": "source",
                "x": 0.0,
                "y": 100.0,
                "arrival_rate": 120.0,
                "line_id": LINE_B_ID,
            },
        ],
        "stations": [
            {
                "id": SHARED_STATION_ID,
                "name": "Shared Station",
                "element_type": "station",
                "x": 100.0,
                "y": 50.0,
                "cycle_time": 20.0,
                "num_machines": 2,
                "operators_required": 0,
                "line_ids": [LINE_A_ID, LINE_B_ID],
            },
        ],
        "buffers": [],
        "sinks": [
            {
                "id": "sink-a",
                "name": "Sink A",
                "element_type": "sink",
                "x": 200.0,
                "y": 0.0,
                "line_id": LINE_A_ID,
            },
            {
                "id": "sink-b",
                "name": "Sink B",
                "element_type": "sink",
                "x": 200.0,
                "y": 100.0,
                "line_id": LINE_B_ID,
            },
        ],
        "operator_pools": [],
        "connections": [
            {
                "id": "c1",
                "source_id": "src-a",
                "target_id": SHARED_STATION_ID,
            },
            {
                "id": "c2",
                "source_id": SHARED_STATION_ID,
                "target_id": "sink-a",
            },
            {
                "id": "c3",
                "source_id": "src-b",
                "target_id": SHARED_STATION_ID,
            },
            {
                "id": "c4",
                "source_id": SHARED_STATION_ID,
                "target_id": "sink-b",
            },
        ],
        "lines": [
            {"id": LINE_A_ID, "name": "Line A"},
            {"id": LINE_B_ID, "name": "Line B"},
        ],
    }


def _find_station(line: dict, station_id: str) -> dict:
    """Return the station metrics with the given id from a line's stations."""
    for sm in line["stations"]:
        if sm["station_id"] == station_id:
            return sm
    raise AssertionError(
        f"station {station_id} not found in line {line['line_id']}"
    )


def test_shared_station_two_line_end_to_end():
    """Two lines sharing one station report a conserved per-line breakdown."""
    layout = _build_shared_station_layout()
    body = {
        "layout": layout,
        "config": {"duration_seconds": 3600, "warmup_seconds": 300},
    }

    client = TestClient(app)
    response = client.post(RUN_URL, json=body)

    assert response.status_code == 200, response.text
    result = response.json()

    # Assertion 1: exactly two PerLineResult entries.
    assert len(result["lines"]) == 2

    # Assertion 2: the shared station is flagged in EACH line, and its line_ids
    # contains both line ids.
    for line in result["lines"]:
        station = _find_station(line, SHARED_STATION_ID)
        assert station["is_shared"] is True
        assert LINE_A_ID in station["line_ids"]
        assert LINE_B_ID in station["line_ids"]

    # Assertion 3: the shared station's line_shares reconstruct its aggregate.
    # Use the shared station as it appears in the first line (the aggregate
    # utilization and throughput are identical copies in each served line).
    shared_in_line = _find_station(result["lines"][0], SHARED_STATION_ID)
    line_shares = shared_in_line["line_shares"]

    # Per-line busy percentages sum to the station's aggregate utilization
    # within the 1 point rounding tolerance.
    busy_sum = sum(share["busy_pct"] for share in line_shares)
    assert abs(busy_sum - shared_in_line["utilization"]) <= 1.0

    # Per-line throughput (unit counts) sums exactly to the station throughput.
    throughput_sum = sum(share["throughput"] for share in line_shares)
    assert throughput_sum == shared_in_line["throughput"]

    # Assertion 4: rollup throughput equals the sum of per-line throughput
    # within a small tolerance for rounding.
    per_line_throughput = sum(line["throughput"] for line in result["lines"])
    assert abs(result["throughput"] - per_line_throughput) <= 2.0
