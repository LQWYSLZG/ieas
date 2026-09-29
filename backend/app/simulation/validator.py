"""Layout validation for the Factory Floor Simulator.

The Model_Validator checks a Layout for structural and semantic validity before a
simulation run. It accumulates ALL detected issues in a single pass (never returning
early) so the user can correct every problem at once. An empty result means the
Layout is valid and the Simulation_Engine may execute (Requirements 12.9, 12.10).

Checks implemented here (task 15.1):
  - Presence: a Source (12.2), a Sink (12.3), and at least one Station (12.4) are
    required, each with a specific friendly message.
  - Referential integrity: connection endpoints must reference existing elements;
    no self-loops.
  - Effective cycle time: each Station must have a positive Effective_Cycle_Time, no
    blank/non-positive operation cycle times, and a Workstation with zero Operations
    must have a valid flat cycle time to fall back on (12.6, 11.7). Each affected
    Station is named.
  - Orphans: any Source/Station/Sink with neither an incoming nor an outgoing
    connection is named as an Orphan_Element (12.7).

Extension points for later tasks:
  - ``_collect_element_ids`` and ``_build_adjacency`` build the id set and directed
    adjacency map once so Source->Sink reachability (task 15.2) and directed-cycle
    detection (task 15.3) can be appended cleanly and reuse the same well-formed
    graph.
"""

from .models import Layout


def _source_can_reach_sink(
    adjacency: dict[str, list[str]],
    source_ids: set[str],
    sink_ids: set[str],
) -> bool:
    """Return True if any Sink is reachable from any Source via directed edges.

    Runs a single BFS seeded from every Source over the directed adjacency map.
    As soon as a Sink id is discovered, material can flow, so the check passes.
    """
    if not source_ids or not sink_ids:
        return False

    visited: set[str] = set()
    frontier: list[str] = [sid for sid in source_ids if sid in adjacency]
    visited.update(frontier)

    while frontier:
        node = frontier.pop()
        if node in sink_ids:
            return True
        for neighbor in adjacency.get(node, []):
            if neighbor not in visited:
                visited.add(neighbor)
                frontier.append(neighbor)
    return False


def _find_cyclic_nodes(adjacency: dict[str, list[str]]) -> set[str]:
    """Return the set of element ids that participate in a directed cycle.

    Uses Tarjan's strongly connected components algorithm. A node is part of a
    nontrivial cycle when it belongs to an SCC of size > 1, or when it has a
    self-edge (an SCC of size 1 with an edge back to itself).
    """
    index_counter = [0]
    stack: list[str] = []
    on_stack: set[str] = set()
    indices: dict[str, int] = {}
    lowlink: dict[str, int] = {}
    cyclic: set[str] = set()

    def strongconnect(node: str) -> None:
        # Iterative Tarjan to avoid recursion limits on large graphs.
        work: list[tuple[str, int]] = [(node, 0)]
        while work:
            v, pi = work[-1]
            if pi == 0:
                indices[v] = index_counter[0]
                lowlink[v] = index_counter[0]
                index_counter[0] += 1
                stack.append(v)
                on_stack.add(v)
            recursed = False
            neighbors = adjacency.get(v, [])
            for i in range(pi, len(neighbors)):
                w = neighbors[i]
                if w not in indices:
                    work[-1] = (v, i + 1)
                    work.append((w, 0))
                    recursed = True
                    break
                elif w in on_stack:
                    lowlink[v] = min(lowlink[v], indices[w])
            if recursed:
                continue
            if lowlink[v] == indices[v]:
                component: list[str] = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    component.append(w)
                    if w == v:
                        break
                if len(component) > 1:
                    cyclic.update(component)
                else:
                    only = component[0]
                    if only in adjacency.get(only, []):
                        cyclic.add(only)
            work.pop()
            if work:
                parent = work[-1][0]
                lowlink[parent] = min(lowlink[parent], lowlink[v])

    for n in adjacency:
        if n not in indices:
            strongconnect(n)

    return cyclic


def _collect_element_ids(layout: Layout) -> set[str]:
    """Return the set of all element ids present in the layout."""
    all_ids: set[str] = set()
    for s in layout.sources:
        all_ids.add(s.id)
    for s in layout.stations:
        all_ids.add(s.id)
    for b in layout.buffers:
        all_ids.add(b.id)
    for s in layout.sinks:
        all_ids.add(s.id)
    for p in layout.operator_pools:
        all_ids.add(p.id)
    return all_ids


def _build_adjacency(layout: Layout, valid_ids: set[str]) -> dict[str, list[str]]:
    """Build a directed adjacency map (source_id -> [target_id, ...]) over connections.

    Later checks (Source->Sink reachability in task 15.2 and directed-cycle detection
    in task 15.3) reuse this map. Only connections whose endpoints both reference
    existing elements are included, so downstream graph traversals operate on a
    well-formed graph.
    """
    adjacency: dict[str, list[str]] = {eid: [] for eid in valid_ids}
    for conn in layout.connections:
        if conn.source_id in valid_ids and conn.target_id in valid_ids:
            adjacency[conn.source_id].append(conn.target_id)
    return adjacency


def validate_layout(layout: Layout) -> list[str]:
    """Validate a layout for simulation readiness.

    Accumulates all detected issues in a single pass and returns them as a list of
    messages. An empty list means the layout is valid (Requirements 12.9, 12.10).
    """
    errors: list[str] = []

    # Build the id set and adjacency once so presence, referential-integrity, orphan,
    # and (later) reachability/cycle checks share a single well-formed graph.
    all_ids = _collect_element_ids(layout)
    adjacency = _build_adjacency(layout, all_ids)

    # ── Presence checks (Req 12.2, 12.3, 12.4) ──────────────────────────────
    # Specific, friendly messages per design.md's Model_Validator Design.
    if not layout.sources:
        errors.append("A Source is required to introduce material into the layout.")

    if not layout.sinks:
        errors.append("A Sink is required to consume completed material.")

    if not layout.stations:
        errors.append("At least one Station is required to process material.")

    # ── Referential integrity + self-loops (preserved) ──────────────────────
    for conn in layout.connections:
        if conn.source_id not in all_ids:
            errors.append(f"Connection references non-existent element: {conn.source_id}")
        if conn.target_id not in all_ids:
            errors.append(f"Connection references non-existent element: {conn.target_id}")
        if conn.source_id == conn.target_id:
            errors.append(f"Connection cannot loop to same element: {conn.source_id}")

    # ── Effective cycle time (Req 12.6, 11.7) ───────────────────────────────
    # A Station is invalid when its Effective_Cycle_Time is zero/blank/non-positive,
    # when any of its Operations has a blank/non-positive cycle time, or when it is a
    # Workstation with zero Operations AND no valid flat cycle time to fall back on.
    # Each affected Station is named.
    for station in layout.stations:
        invalid_ect = False

        if station.operations:
            # Any operation with a blank/non-positive cycle time makes the station invalid (11.7).
            for op in station.operations:
                if op.cycle_time is None or op.cycle_time <= 0:
                    invalid_ect = True
                    break
        else:
            # Zero operations: must have a valid positive flat cycle_time fallback.
            if station.cycle_time is None or station.cycle_time <= 0:
                invalid_ect = True

        # The aggregated effective cycle time must also be positive.
        if station.effective_cycle_time is None or station.effective_cycle_time <= 0:
            invalid_ect = True

        if invalid_ect:
            errors.append(
                f"Station '{station.name}' has an invalid Effective_Cycle_Time "
                f"(must be a positive number of seconds)."
            )

        # ── Nothing to do the work ──────────────────────────────────────────
        # A station only performs work if a machine does it (has_machine) OR at
        # least one operator is assigned. Zero operators AND no machine means
        # nothing can actually run the station, which would silently "process"
        # units for free: block it with a clear, friendly message.
        if not station.has_machine and station.total_operators_required <= 0:
            errors.append(
                f"Station '{station.name}' has no machine and no operators, so "
                f"nothing can do the work. Add at least one operator or mark it "
                f"as having a machine."
            )

    # ── Non-station multi-line assignment (Req 1.8) ─────────────────────────
    # Only a Workstation may belong to multiple lines. Source, Buffer, and Sink
    # each carry a single Optional line_id in the model, so a well-formed payload
    # cannot hold 2+ lines. Defensively guard against malformed or legacy payloads
    # by also inspecting a possible line_ids attribute (via getattr) and by counting
    # a present single line_id. A non-station assigned to 2+ lines is rejected.
    for element, kind in (
        *((src, "Source") for src in layout.sources),
        *((buf, "Buffer") for buf in layout.buffers),
        *((snk, "Sink") for snk in layout.sinks),
    ):
        assigned: set[str] = set()

        single_line_id = getattr(element, "line_id", None)
        if single_line_id:
            assigned.add(single_line_id)

        multi_line_ids = getattr(element, "line_ids", None)
        if multi_line_ids:
            assigned.update(multi_line_ids)

        if len(assigned) >= 2:
            errors.append(
                f"Only a Workstation may belong to multiple lines; "
                f"'{element.name}' is a {kind}."
            )

    # ── Orphan elements (Req 12.7) ──────────────────────────────────────────
    # A Source/Station/Sink with neither an incoming nor an outgoing connection.
    incoming: set[str] = set()
    outgoing: set[str] = set()
    for conn in layout.connections:
        outgoing.add(conn.source_id)
        incoming.add(conn.target_id)

    for element in (*layout.sources, *layout.stations, *layout.sinks):
        if element.id not in incoming and element.id not in outgoing:
            errors.append(
                f"Orphan element '{element.name}' has no incoming or outgoing connections."
            )

    # ── Source -> Sink reachability (Req 12.5, 12.11) ───────────────────────
    # Run BFS/DFS from every Source over the directed adjacency. If no Sink is
    # reachable from any Source, material cannot flow. When at least one path
    # exists, this check adds nothing (12.11). Only run when at least one Source
    # and one Sink exist so we don't duplicate the presence-check noise (12.2/12.3).
    source_ids = {s.id for s in layout.sources}
    sink_ids = {s.id for s in layout.sinks}
    if source_ids and sink_ids:
        if not _source_can_reach_sink(adjacency, source_ids, sink_ids):
            errors.append("Material cannot flow from a Source to a Sink")

    # ── Directed-cycle detection (Req 12.8) ─────────────────────────────────
    # Detect directed cycles among material-flow elements. Any nontrivial cycle
    # (SCC size > 1, or a node with a self-edge) traps material. Name only the
    # Station-type elements involved; an acyclic layout adds nothing.
    cyclic_ids = _find_cyclic_nodes(adjacency)
    if cyclic_ids:
        cyclic_station_names = [
            station.name for station in layout.stations if station.id in cyclic_ids
        ]
        if cyclic_station_names:
            names = ", ".join(cyclic_station_names)
            errors.append(f"Directed cycle among: {names}")

    return errors
