"""Line resolution for the Factory Floor Simulator.

A Line is a distinct production flow through the layout (typically one product),
judged against its own demand. This module is the single authority for two
questions:

  1. Which lines does each flow element belong to?
  2. Which lines exist?

``resolve_lines`` is a pure, deterministic function over a ``Layout``. Both the
simulation engine and the results assembler consume the returned
``LineAssignment`` so per-line membership, attribution, and results all derive
from one source of truth.

Resolution follows an explicit-wins policy:

  * If any flow element carries an explicit line (a non-None ``line_id`` on a
    Source/Buffer/Sink or a non-empty ``line_ids`` on a Station), or the layout
    has a non-empty ``lines`` list, the layout is treated as (partially)
    explicit. Explicit elements take their labels directly.
  * Elements without an explicit assignment are auto-resolved by connectivity:
    an undirected graph is built over flow elements from the connections, its
    connected components are computed via union-find, and each component with no
    explicit member becomes one auto line named "Line N".
  * An explicitly multi-line (shared) station does not merge the components of
    the lines it serves. Explicit assignment wins, so those lines stay distinct
    even though they share a station.

The function has no side effects and no randomness. All ordering follows layout
order (the order elements appear in the ``Layout`` lists) so results are stable
across runs.
"""

from dataclasses import dataclass, field

from .models import Layout


@dataclass
class ResolvedLine:
    """One resolved production line.

    ``target_throughput`` and ``takt_time`` come from the matching ``LineInfo``
    when present, else None. The global fallback is applied later by the results
    assembly, not here. ``explicit`` is True when any member of the line was
    explicitly assigned, or when the line originated from ``layout.lines``.
    """
    line_id: str
    name: str
    target_throughput: float | None
    takt_time: float | None
    explicit: bool
    element_ids: list[str] = field(default_factory=list)
    station_ids: list[str] = field(default_factory=list)


@dataclass
class LineAssignment:
    """Resolved line membership for a layout (pure, deterministic)."""
    # Ordered list of resolved lines, stable across runs.
    lines: list[ResolvedLine]
    # element_id -> ordered list of line_ids it belongs to.
    # Source/Buffer/Sink map to exactly one; Station maps to one or more.
    element_lines: dict[str, list[str]]
    # station_id -> True when it serves 2+ lines (Shared_Workstation).
    shared: dict[str, bool]


class _UnionFind:
    """Minimal union-find (disjoint set) over string keys, deterministic."""

    def __init__(self) -> None:
        self._parent: dict[str, str] = {}

    def add(self, key: str) -> None:
        if key not in self._parent:
            self._parent[key] = key

    def find(self, key: str) -> str:
        # Iterative find with path compression.
        root = key
        while self._parent[root] != root:
            root = self._parent[root]
        while self._parent[key] != root:
            self._parent[key], key = root, self._parent[key]
        return root

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            # Attach the second root to the first for determinism.
            self._parent[rb] = ra


def _flow_elements(layout: Layout) -> list[tuple[str, str, list[str]]]:
    """Return flow elements in stable layout order.

    Each entry is (element_id, kind, explicit_line_ids) where kind is one of
    "source", "station", "buffer", "sink". Operator pools are not flow elements
    and are excluded. ``explicit_line_ids`` is the element's declared lines: a
    list of zero or one for Source/Buffer/Sink (from ``line_id``) and zero or
    more for Station (from ``line_ids``).
    """
    elements: list[tuple[str, str, list[str]]] = []
    for s in layout.sources:
        explicit = [s.line_id] if s.line_id is not None else []
        elements.append((s.id, "source", explicit))
    for st in layout.stations:
        elements.append((st.id, "station", list(st.line_ids)))
    for b in layout.buffers:
        explicit = [b.line_id] if b.line_id is not None else []
        elements.append((b.id, "buffer", explicit))
    for sk in layout.sinks:
        explicit = [sk.line_id] if sk.line_id is not None else []
        elements.append((sk.id, "sink", explicit))
    return elements


def resolve_lines(layout: Layout) -> LineAssignment:
    """Resolve line membership for a layout.

    Returns a well-formed ``LineAssignment`` in which every flow element maps to
    at least one line, a Source/Buffer/Sink maps to exactly one line, and a
    Station may map to one or more. Empty layout returns an empty assignment.
    """
    elements = _flow_elements(layout)

    if not elements:
        return LineAssignment(lines=[], element_lines={}, shared={})

    element_ids_in_order = [eid for eid, _kind, _explicit in elements]
    element_kind = {eid: kind for eid, kind, _explicit in elements}
    element_ids_set = set(element_ids_in_order)

    # Explicit line ids declared directly on elements, in layout order.
    explicit_line_ids: dict[str, list[str]] = {
        eid: list(explicit) for eid, _kind, explicit in elements
    }

    # A layout is (partially) explicit when any element carries a line, or when
    # the layout declares lines directly.
    any_explicit_element = any(explicit_line_ids[eid] for eid in element_ids_in_order)
    is_explicit = any_explicit_element or bool(layout.lines)

    # LineInfo lookup for names/targets/takt supplied by the layout.
    line_info = {li.id: li for li in layout.lines}

    # ── Resolve each element's line ids ─────────────────────────────────────
    # element_lines starts from explicit assignments; unassigned elements are
    # filled in by connectivity below.
    element_lines: dict[str, list[str]] = {
        eid: list(explicit_line_ids[eid]) for eid in element_ids_in_order
    }

    # Track the discovery order of line ids so output ordering is stable.
    line_order: list[str] = []
    explicit_line_seen: set[str] = set()

    def _note_line(line_id: str) -> None:
        if line_id not in explicit_line_seen:
            explicit_line_seen.add(line_id)
            line_order.append(line_id)

    # Explicit lines declared on the layout come first, in layout order, so a
    # line that exists only in layout.lines still appears.
    for li in layout.lines:
        _note_line(li.id)
    # Then lines referenced by elements, in layout order.
    for eid in element_ids_in_order:
        for line_id in element_lines[eid]:
            _note_line(line_id)

    # ── Connectivity auto-default for unassigned elements ───────────────────
    # Build an undirected union-find over flow elements. An explicitly assigned
    # element is treated as fixed: it does not union its neighbors, so an
    # explicitly shared station cannot merge the lines it serves. Only edges
    # between two unassigned elements group them together.
    uf = _UnionFind()
    for eid in element_ids_in_order:
        uf.add(eid)

    assigned = {eid for eid in element_ids_in_order if element_lines[eid]}

    for conn in layout.connections:
        a, b = conn.source_id, conn.target_id
        if a in element_ids_set and b in element_ids_set:
            if a not in assigned and b not in assigned:
                uf.union(a, b)

    # Group unassigned elements by their union-find root, in layout order.
    unassigned = [eid for eid in element_ids_in_order if eid not in assigned]
    auto_components: dict[str, list[str]] = {}
    auto_component_order: list[str] = []
    for eid in unassigned:
        root = uf.find(eid)
        if root not in auto_components:
            auto_components[root] = []
            auto_component_order.append(root)
        auto_components[root].append(eid)

    # Name each auto component "Line N" sequentially from 1, in discovery order.
    # Numbering skips any explicit line ids that already read as "Line <n>" is
    # not required by the spec; auto lines number from 1 independently, but we
    # avoid colliding with an existing explicit line id.
    auto_counter = 0
    for root in auto_component_order:
        auto_counter += 1
        auto_line_id = f"Line {auto_counter}"
        # Guard against an unlikely collision with an explicit line id.
        while auto_line_id in explicit_line_seen:
            auto_counter += 1
            auto_line_id = f"Line {auto_counter}"
        _note_line(auto_line_id)
        for eid in auto_components[root]:
            element_lines[eid] = [auto_line_id]

    # ── Determine which lines were explicitly assigned ──────────────────────
    # A line is explicit when it was declared on the layout or referenced by any
    # explicitly assigned element.
    explicit_lines: set[str] = set(line_info.keys())
    for eid in element_ids_in_order:
        if explicit_line_ids[eid]:
            for line_id in explicit_line_ids[eid]:
                explicit_lines.add(line_id)

    # ── Shared stations ─────────────────────────────────────────────────────
    # A station whose resolved line set has 2+ lines serves multiple lines.
    shared: dict[str, bool] = {}
    for eid in element_ids_in_order:
        if element_kind[eid] == "station":
            shared[eid] = len(element_lines[eid]) >= 2

    # ── Build ResolvedLine objects in stable line order ─────────────────────
    # Gather members per line in layout order.
    line_element_ids: dict[str, list[str]] = {lid: [] for lid in line_order}
    line_station_ids: dict[str, list[str]] = {lid: [] for lid in line_order}
    for eid in element_ids_in_order:
        for line_id in element_lines[eid]:
            if line_id not in line_element_ids:
                # A line referenced only via a stray id; keep it well-formed.
                line_element_ids[line_id] = []
                line_station_ids[line_id] = []
                if line_id not in line_order:
                    line_order.append(line_id)
            line_element_ids[line_id].append(eid)
            if element_kind[eid] == "station":
                line_station_ids[line_id].append(eid)

    resolved: list[ResolvedLine] = []
    for line_id in line_order:
        info = line_info.get(line_id)
        if info is not None:
            name = info.name
            target = info.target_throughput
            takt = info.takt_time
        else:
            # Synthesize a default name from the id for a line missing LineInfo.
            name = line_id
            target = None
            takt = None
        resolved.append(ResolvedLine(
            line_id=line_id,
            name=name,
            target_throughput=target,
            takt_time=takt,
            explicit=line_id in explicit_lines,
            element_ids=line_element_ids.get(line_id, []),
            station_ids=line_station_ids.get(line_id, []),
        ))

    return LineAssignment(
        lines=resolved,
        element_lines=element_lines,
        shared=shared,
    )

# ── Per-line target, takt, and throughput gap helpers ───────────────────────
# These are pure functions used by the results assembly to judge a line against
# its own demand. A line may carry its own target_throughput and takt_time
# (from its LineInfo); when either is absent the value falls back to the global
# simulation config or is derived. All functions guard against a divide by zero
# and return None when a meaningful value cannot be computed.

# Seconds in one hour, used to convert between throughput (units/hr) and takt
# (seconds/unit).
_SECONDS_PER_HOUR = 3600.0


def line_effective_target(
    line: ResolvedLine, global_target: float | None
) -> float | None:
    """Return the effective target throughput (units/hr) for a line.

    The line's own ``target_throughput`` wins when set; otherwise the global
    target from the simulation config is used. Returns None when neither is set.
    """
    if line.target_throughput is not None:
        return line.target_throughput
    return global_target


def line_effective_takt(
    line: ResolvedLine, global_target: float | None
) -> float | None:
    """Return the effective takt time (seconds/unit) for a line.

    The line's own ``takt_time`` wins when set, even if a target is also
    present. Otherwise takt is derived from the effective target throughput as
    ``3600 / effective_target``. Returns None when no takt is set and the
    effective target is missing or not positive (guards divide by zero).
    """
    if line.takt_time is not None:
        return line.takt_time
    effective_target = line_effective_target(line, global_target)
    if effective_target is not None and effective_target > 0:
        return _SECONDS_PER_HOUR / effective_target
    return None


def line_throughput_gap(
    line_throughput: float, effective_target: float | None
) -> float | None:
    """Return the throughput gap percentage against a line's effective target.

    The gap is ``(effective_target - line_throughput) / effective_target * 100``,
    clamped at 0 so a line meeting or exceeding its target reports no gap (never
    a negative value). Returns None when the effective target is missing or not
    positive (guards divide by zero).
    """
    if effective_target is None or effective_target <= 0:
        return None
    return max(0.0, (effective_target - line_throughput) / effective_target * 100.0)
