"""End to end multi-line diagnosis-depth integration test.

Feature: diagnosis-depth-extension, Task 6 (committed, non-optional).

Builds a layout with TWO lines that SHARE ONE station and gives each line its
own dedicated stations. One dedicated station carries a nonzero scrap_rate so
defect_waste fires, one carries a large setup_time so setup_waste fires, the
dedicated stations run over takt with two or more manual operations so
operation_move can fire, and config.operator_count is set low so a line is
understaffed and labor_constraint (line_labor) can fire.

The layout is posted through the real /run HTTP route with FastAPI's
TestClient. The test then asserts the new StationMetrics fields (scrap_pct,
setup_impact) are present on every station, the new PerLineResult labor fields
(operators_needed, operators_supplied) are present on every line and that the
per-line supplied operators sum to the configured operator_count within a
rounding tolerance, and that the new recommendations (defect_waste,
setup_waste, and at least one of labor_constraint or operation_move) appear in
the combined recommendation set.

Determinism is guaranteed by the harness pinning SIMULATION_SEED=42 via
tests/conftest.py.

Requirements traced: 4.7, 5.5, 6.1, 6.2, 7.1, 8.3
"""

from fastapi.testclient import TestClient

from app.main import app


RUN_URL = "/api/v1/operations-assistant/simulator/run"

LINE_A_ID = "line-a"
LINE_B_ID = "line-b"

SHARED_STATION_ID = "shared-station"

# Line A dedicated stations. SCRAP_STATION_A carries the scrap rate; both A
# stations run over takt with two manual operations each so an operation move
# is available on the line.
SCRAP_STATION_A = "a-scrap-station"
SECOND_STATION_A = "a-second-station"

# Line B dedicated stations. SETUP_STATION_B carries the large setup time.
SETUP_STATION_B = "b-setup-station"
SECOND_STATION_B = "b-second-station"

# Config operator count. Set low so at least one line needs more operators than
# it is supplied, which drives the per-line labor_constraint recommendation.
OPERATOR_COUNT = 2


def _build_diagnosis_layout() -> dict:
    """Build a two line layout that shares one station and triggers new diagnoses.

    Line A: Source A to A-scrap-station to A-second-station to SharedStation to Sink A.
    Line B: Source B to B-setup-station to B-second-station to SharedStation to Sink B.

    The shared station carries both line ids. Each dedicated station has two
    manual operations (operators_required >= 1) whose cycle times sum well above
    takt so the station is over takt and holds a movable operation. One line A
    station carries scrap_rate 15 (so scrap_pct >= 10) and one line B station
    carries setup_time 12 against a 20s cycle time (so setup_impact >= 0.5).
    Every station has a positive cycle_time and each Source to Sink path is
    connected so the layout validates.
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
                "y": 200.0,
                "arrival_rate": 120.0,
                "line_id": LINE_B_ID,
            },
        ],
        "stations": [
            {
                "id": SCRAP_STATION_A,
                "name": "A Scrap Station",
                "element_type": "station",
                "x": 100.0,
                "y": 0.0,
                "cycle_time": 40.0,
                "num_machines": 1,
                "scrap_rate": 15.0,
                "line_ids": [LINE_A_ID],
                "operations": [
                    {"name": "A op one", "cycle_time": 22.0, "operators_required": 1},
                    {"name": "A op two", "cycle_time": 18.0, "operators_required": 1},
                ],
            },
            {
                "id": SECOND_STATION_A,
                "name": "A Second Station",
                "element_type": "station",
                "x": 150.0,
                "y": 0.0,
                "cycle_time": 36.0,
                "num_machines": 1,
                "line_ids": [LINE_A_ID],
                "operations": [
                    {"name": "A op three", "cycle_time": 20.0, "operators_required": 1},
                    {"name": "A op four", "cycle_time": 16.0, "operators_required": 1},
                ],
            },
            {
                "id": SETUP_STATION_B,
                "name": "B Setup Station",
                "element_type": "station",
                "x": 100.0,
                "y": 200.0,
                # Effective cycle time is the sum of its operations: 12 + 8 = 20s.
                # setup_time 12 against a 20s cycle time gives setup_impact 0.6,
                # at or above the 0.5 threshold that drives setup_waste.
                "cycle_time": 20.0,
                "num_machines": 1,
                "setup_time": 12.0,
                "line_ids": [LINE_B_ID],
                "operations": [
                    {"name": "B op one", "cycle_time": 12.0, "operators_required": 1},
                    {"name": "B op two", "cycle_time": 8.0, "operators_required": 1},
                ],
            },
            {
                "id": SECOND_STATION_B,
                "name": "B Second Station",
                "element_type": "station",
                "x": 150.0,
                "y": 200.0,
                "cycle_time": 44.0,
                "num_machines": 1,
                "line_ids": [LINE_B_ID],
                "operations": [
                    {"name": "B op three", "cycle_time": 24.0, "operators_required": 1},
                    {"name": "B op four", "cycle_time": 20.0, "operators_required": 1},
                ],
            },
            {
                "id": SHARED_STATION_ID,
                "name": "Shared Station",
                "element_type": "station",
                "x": 250.0,
                "y": 100.0,
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
                "x": 350.0,
                "y": 0.0,
                "line_id": LINE_A_ID,
            },
            {
                "id": "sink-b",
                "name": "Sink B",
                "element_type": "sink",
                "x": 350.0,
                "y": 200.0,
                "line_id": LINE_B_ID,
            },
        ],
        "operator_pools": [],
        "connections": [
            {"id": "c1", "source_id": "src-a", "target_id": SCRAP_STATION_A},
            {"id": "c2", "source_id": SCRAP_STATION_A, "target_id": SECOND_STATION_A},
            {"id": "c3", "source_id": SECOND_STATION_A, "target_id": SHARED_STATION_ID},
            {"id": "c4", "source_id": SHARED_STATION_ID, "target_id": "sink-a"},
            {"id": "c5", "source_id": "src-b", "target_id": SETUP_STATION_B},
            {"id": "c6", "source_id": SETUP_STATION_B, "target_id": SECOND_STATION_B},
            {"id": "c7", "source_id": SECOND_STATION_B, "target_id": SHARED_STATION_ID},
            {"id": "c8", "source_id": SHARED_STATION_ID, "target_id": "sink-b"},
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


def _collect_problems(result: dict) -> set:
    """Collect every recommendation problem string from the rollup and each line."""
    problems = set()
    for rec in result["recommendations"]:
        problems.add(rec["problem"])
    for line in result["lines"]:
        for rec in line["recommendations"]:
            problems.add(rec["problem"])
    return problems


def test_diagnosis_depth_two_line_end_to_end():
    """Two lines with a shared station surface the new waste and labor diagnoses."""
    layout = _build_diagnosis_layout()
    body = {
        "layout": layout,
        "config": {
            "duration_seconds": 3600,
            "warmup_seconds": 300,
            "target_throughput": 120,
            "takt_time": 30,
            "operator_count": OPERATOR_COUNT,
        },
    }

    client = TestClient(app)
    response = client.post(RUN_URL, json=body)

    assert response.status_code == 200, response.text
    result = response.json()

    # There are two lines in the breakdown.
    assert len(result["lines"]) == 2, (
        f"expected two per-line results, got {len(result['lines'])}"
    )

    # New StationMetrics fields are present on every station in every line.
    for line in result["lines"]:
        for station in line["stations"]:
            assert "scrap_pct" in station, (
                f"scrap_pct missing on station {station['station_id']}"
            )
            assert "setup_impact" in station, (
                f"setup_impact missing on station {station['station_id']}"
            )

    # The scrap station reports scrap_pct at or above the defect_waste threshold.
    scrap_station = _find_station(result["lines"][0], SCRAP_STATION_A)
    if scrap_station["scrap_pct"] < 10.0:
        # The scrap station lives on line A; if line A is not the first entry,
        # look it up on line B's copy instead.
        scrap_station = _find_station(result["lines"][1], SCRAP_STATION_A)
    assert scrap_station["scrap_pct"] >= 10.0, (
        f"scrap station scrap_pct {scrap_station['scrap_pct']} below 10.0"
    )

    # The setup station reports setup_impact at or above the setup_waste threshold.
    setup_station = None
    for line in result["lines"]:
        for station in line["stations"]:
            if station["station_id"] == SETUP_STATION_B:
                setup_station = station
                break
        if setup_station is not None:
            break
    assert setup_station is not None, "setup station not found in any line"
    assert setup_station["setup_impact"] >= 0.5, (
        f"setup station setup_impact {setup_station['setup_impact']} below 0.5"
    )

    # New PerLineResult labor fields are present and non-negative on every line.
    supplied_sum = 0.0
    for line in result["lines"]:
        assert "operators_needed" in line, (
            f"operators_needed missing on line {line['line_id']}"
        )
        assert "operators_supplied" in line, (
            f"operators_supplied missing on line {line['line_id']}"
        )
        assert isinstance(line["operators_needed"], (int, float)), (
            "operators_needed is not a number"
        )
        assert isinstance(line["operators_supplied"], (int, float)), (
            "operators_supplied is not a number"
        )
        assert line["operators_needed"] >= 0, "operators_needed is negative"
        assert line["operators_supplied"] >= 0, "operators_supplied is negative"
        supplied_sum += line["operators_supplied"]

    # The per-line supplied operators split the configured operator_count and
    # sum back to it within a small rounding tolerance.
    assert abs(supplied_sum - OPERATOR_COUNT) <= 0.3, (
        f"per-line operators_supplied sum {supplied_sum} not within 0.3 of "
        f"configured operator_count {OPERATOR_COUNT}"
    )

    # The new recommendations appear in the combined set of rollup plus per-line
    # recommendations.
    problems = _collect_problems(result)
    assert "defect_waste" in problems, (
        f"defect_waste not found in recommendation problems: {sorted(problems)}"
    )
    assert "setup_waste" in problems, (
        f"setup_waste not found in recommendation problems: {sorted(problems)}"
    )
    assert ("labor_constraint" in problems) or ("operation_move" in problems), (
        f"neither labor_constraint nor operation_move found in recommendation "
        f"problems: {sorted(problems)}"
    )
