"""Factory Floor Simulator - Auto-Optimize Package.

This package contains the mixed-integer linear program (MILP) builder, the
solver abstraction, the service orchestrator, and the infeasibility diagnosis
for the Auto-Optimize feature of the Factory Floor Simulator.

Modules:
    model_builder - Pure Layout-to-OptModel mapping and solution-to-layout translation
    solver        - Solver-agnostic backend protocol and the PuLP/CBC implementation
    service       - End-to-end optimize orchestrator (validate, build, solve, simulate)
    diagnosis     - Bounded infeasibility diagnosis naming one binding category

The model_builder dataclasses are pure Python data containers. They carry no
solver objects and import nothing from PuLP, Gurobi, or FastAPI, so they stay
serializable and testable in isolation.
"""
