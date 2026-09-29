"""Shared pytest fixtures for the backend test suite.

This is the first backend test harness. It pins simulation determinism so runs
are reproducible: the engine exposes a module level SIMULATION_SEED hook that
run_simulation reads at the top of a run. The autouse fixture below sets that
seed to a fixed value before each test and restores whatever it was after, so
tests never leak a pinned seed into unrelated code.
"""

import pytest

import app.simulation.engine as engine


@pytest.fixture(autouse=True)
def pin_simulation_seed():
    """Pin the engine seed to 42 for the duration of each test.

    Saves the prior SIMULATION_SEED, sets it to 42 so seeded runs are
    reproducible, then restores the prior value after the test finishes.
    """
    prior = engine.SIMULATION_SEED
    engine.SIMULATION_SEED = 42
    try:
        yield
    finally:
        engine.SIMULATION_SEED = prior
