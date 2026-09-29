"""Line_Balancer for the Factory Floor Simulator.

Mirrors app2's ``calc_takt_time`` / ``compute_line_balance`` / ``detect_all_bottlenecks``
logic, adapted to the operations-aware Workstation model. Proposes an assignment of
Operations to Workstations balanced against a Takt_Time using greedy
longest-processing-time-first (LPT) bin packing, where each Workstation is a "bin"
whose capacity is the Takt_Time.

Design reference: design.md "Line_Balancer Design" and "Time Study & Line Balancer Models".
"""

from dataclasses import dataclass

from .models import Layout, LineBalanceProposal, Operation, WorkstationBalance


# ═══════════════════════════════════════════════════════════════════════
# TAKT TIME (mirrors app2 calc_takt_time)
# ═══════════════════════════════════════════════════════════════════════

def calc_takt_time(available_seconds: float, demand_units: float) -> float | None:
    """Takt time = available production time / customer demand.

    Returns ``None`` when demand is non-positive (mirrors app2).
    """
    if demand_units <= 0:
        return None
    return available_seconds / demand_units


# ═══════════════════════════════════════════════════════════════════════
# INTERNAL HELPERS
# ═══════════════════════════════════════════════════════════════════════

@dataclass
class _Bin:
    """A proposed Workstation bin holding assigned operations."""
    name: str
    operations: list[Operation]

    @property
    def running_ect(self) -> float:
        return sum(op.cycle_time for op in self.operations)


def _collect_operations(layout: Layout) -> list[Operation]:
    """Collect all Operations across the layout's Workstations, preserving identity.

    A Workstation with an empty operations list contributes a single synthetic
    Operation built from its flat ``cycle_time`` / ``operators_required`` fallback,
    so that its work content is conserved during balancing.
    """
    ops: list[Operation] = []
    for station in layout.stations:
        if station.operations:
            for op in station.operations:
                # Preserve operation identity (name + cycle_time + operators_required).
                ops.append(op.model_copy(deep=True))
        else:
            # Backward-compatible fallback: represent the flat station as one operation.
            ops.append(Operation(
                name=station.name,
                cycle_time=station.cycle_time,
                operators_required=station.operators_required,
            ))
    return ops


# ═══════════════════════════════════════════════════════════════════════
# LINE BALANCING (greedy LPT bin-packing against Takt)
# ═══════════════════════════════════════════════════════════════════════

def balance_line(layout: Layout, takt_time: float) -> LineBalanceProposal:
    """Propose an assignment of Operations to Workstations balanced against ``takt_time``.

    Uses greedy longest-processing-time-first bin packing: operations are sorted by
    cycle_time descending and each is placed into the first Workstation whose running
    Effective_Cycle_Time + operation cycle_time <= takt_time, opening a new Workstation
    when none fits. Operations are conserved exactly (none lost or duplicated).

    ``best_effort`` is set True (with an explanatory message) when any single Operation's
    cycle_time exceeds ``takt_time`` (an indivisible operation cannot fit) OR when the
    packing cannot keep every Workstation within Takt.

    Design reference: design.md "Line_Balancer Design".
    """
    if takt_time <= 0:
        raise ValueError("takt_time must be positive")

    operations = _collect_operations(layout)

    # No operations to balance: return an empty, fully-efficient-by-vacuity proposal.
    if not operations:
        return LineBalanceProposal(
            takt_time=takt_time,
            workstations=[],
            assignment={},
            balance_efficiency=0.0,
            best_effort=False,
            message="No operations available to balance.",
        )

    # Detect indivisible operations that cannot ever fit within a single Takt bin.
    oversized = [op for op in operations if op.cycle_time > takt_time]

    # Greedy longest-processing-time-first: sort operations by cycle_time descending.
    # Stable ordering on ties keeps behavior deterministic.
    ordered = sorted(operations, key=lambda op: op.cycle_time, reverse=True)

    bins: list[_Bin] = []
    for op in ordered:
        placed = False
        # Place into the first Workstation whose running ECT + op fits within Takt.
        for b in bins:
            if b.running_ect + op.cycle_time <= takt_time:
                b.operations.append(op)
                placed = True
                break
        if not placed:
            # Open a new Workstation. An oversized operation gets its own bin.
            new_bin = _Bin(name=f"Workstation {len(bins) + 1}", operations=[op])
            bins.append(new_bin)

    # Build per-Workstation balance results and the assignment map.
    workstations: list[WorkstationBalance] = []
    assignment: dict[str, list[str]] = {}
    total_ect = 0.0
    any_over_takt = False

    for b in bins:
        ect = b.running_ect
        total_ect += ect
        over = ect > takt_time
        any_over_takt = any_over_takt or over
        pct = (ect / takt_time * 100) if takt_time > 0 else 0.0
        workstations.append(WorkstationBalance(
            workstation_name=b.name,
            effective_cycle_time=ect,
            pct_of_takt=pct,
            over_takt=over,
        ))
        assignment[b.name] = [op.name for op in b.operations]

    n_workstations = len(bins)
    balance_efficiency = (
        total_ect / (n_workstations * takt_time) * 100
        if n_workstations > 0 and takt_time > 0 else 0.0
    )

    # A fully balanced solution requires every Workstation within Takt and no
    # indivisible (oversized) operation.
    best_effort = bool(oversized) or any_over_takt

    if oversized:
        names = ", ".join(sorted({op.name for op in oversized}))
        message = (
            f"Best-effort proposal: operation(s) [{names}] exceed the Takt time of "
            f"{takt_time:g}s and cannot fit within a single Workstation. These operations "
            f"were placed alone; consider splitting them or increasing Takt time."
        )
    elif any_over_takt:
        message = (
            "Best-effort proposal: the packing could not keep every Workstation within "
            f"the Takt time of {takt_time:g}s."
        )
    else:
        message = (
            f"Balanced {len(operations)} operation(s) across {n_workstations} workstation(s) "
            f"within the Takt time of {takt_time:g}s."
        )

    return LineBalanceProposal(
        takt_time=takt_time,
        workstations=workstations,
        assignment=assignment,
        balance_efficiency=balance_efficiency,
        best_effort=best_effort,
        message=message,
    )
