"""SimPy-based Discrete Event Simulation engine.

Operator-gated DES supporting: Sources, Stations (with per-Operation execution,
reliability, scrap, setup), Buffers (blocking/starving), Sinks, a shared operator
pool, and Transport.

Task 16.1 reworks the engine to be operator-gated:
  * A single shared operator-pool SimPy ``Resource`` is sized to the SUPPLIED
    operator count (config.operator_count, else sum of operator_pools[*].count,
    else the layout's total operators required).
  * Each Station executes its Operations in order. An Operation requiring 0
    operators is FULLY AUTOMATED and never acquires an operator; an Operation
    requiring N > 0 operators acquires N operator units from the pool BEFORE
    processing and releases them after, so operations wait when the pool is
    under-supplied (constraining throughput).
  * Cycle time is sampled per-operation via triangular(min_ct, cycle_time, max_ct)
    when both bounds are present, else via the station ``variability`` approach.

Later tasks (16.2-16.4) refine the time-accounting buckets and the labor /
value-added metrics; this rework leaves clear seams for those.
"""

import simpy
import random
from typing import Optional
from .models import (
    Layout, SimulationConfig, SimulationResult,
    StationMetrics, BufferMetrics, OperatorMetrics,
    TransportMetrics, LineBalanceMetrics, OperationMetrics,
    Station, Source, Buffer, Connection, Operation,
)
from .validator import validate_layout
from .lines import resolve_lines
from .results import assemble_per_line_results


# Module-level seed hook. When set to an int, run_simulation seeds ``random`` at
# the top of the run for reproducibility. When None (default), the engine keeps
# its current non-deterministic random behavior. Callers/tests can set this, or
# pass a ``seed`` attribute on the config object, to get reproducible runs.
SIMULATION_SEED: Optional[int] = None


def _clamp_span(start: float, end: float, warmup: float) -> float:
    """Return the portion of the interval [start, end] that lies after warmup.

    Time buckets are only accumulated over the post-warmup window so they align
    with ``effective_duration`` used to derive percentages.
    """
    lo = max(start, warmup)
    if end <= lo:
        return 0.0
    return end - lo


def _resolve_operator_capacity(layout: Layout, config: SimulationConfig) -> int:
    """Resolve the supplied operator-pool capacity.

    Order of precedence:
      1. ``config.operator_count`` when not None.
      2. Sum of ``layout.operator_pools[*].count`` when any pools exist.
      3. The layout's total operators required
         (sum over stations of ``station.total_operators_required``).
    """
    if config.operator_count is not None:
        return int(config.operator_count)
    if layout.operator_pools:
        return sum(p.count for p in layout.operator_pools)
    return sum(s.total_operators_required for s in layout.stations)


def run_simulation(layout: Layout, config: SimulationConfig) -> SimulationResult:
    """Run a discrete event simulation on the factory floor layout."""
    errors = validate_layout(layout)
    if errors:
        raise ValueError(errors[0])

    # ─── Resolve production lines (pure, deterministic) ──────────────
    # resolve_lines groups the layout into one or more lines (explicit-wins,
    # else connectivity auto-default). The assignment is the single source of
    # truth the results assembly consumes to build the per-line breakdown. This
    # does not touch any aggregate computation below.
    line_assignment = resolve_lines(layout)

    # ─── Optional reproducibility seam ───────────────────────────────
    # Explicit seeding only: default behavior remains non-deterministic.
    seed = getattr(config, "seed", None)
    if seed is None:
        seed = SIMULATION_SEED
    if seed is not None:
        random.seed(seed)

    duration = config.duration_seconds
    warmup = config.warmup_seconds

    # Build lookup maps
    station_map = {s.id: s for s in layout.stations}
    source_map = {s.id: s for s in layout.sources}
    buffer_map = {b.id: b for b in layout.buffers}
    sink_map = {s.id: s for s in layout.sinks}

    # Build adjacency
    all_element_ids = (
        [s.id for s in layout.sources] +
        [s.id for s in layout.stations] +
        [b.id for b in layout.buffers] +
        [s.id for s in layout.sinks]
    )
    outgoing: dict[str, list[Connection]] = {eid: [] for eid in all_element_ids}
    incoming: dict[str, list[Connection]] = {eid: [] for eid in all_element_ids}

    for conn in layout.connections:
        if conn.source_id in outgoing:
            outgoing[conn.source_id].append(conn)
        if conn.target_id in incoming:
            incoming[conn.target_id].append(conn)

    # SimPy environment
    env = simpy.Environment()

    # ─── Resources ───────────────────────────────────────────────────

    # Buffer resources (Bug B fix): each buffer is a real capacity-limited
    # ``simpy.Store``. Upstream stations ``put`` units into it (blocking when
    # full -> charged to upstream BLOCKED), and a dedicated downstream consumer
    # process ``get``s units at the downstream station's pace. This genuinely
    # holds WIP up to capacity so a slow downstream fills the buffer and forces
    # the upstream station to block. Stored items carry the unit's original
    # ``entry_time`` so lead-time tracking survives the decoupling.
    buffer_containers: dict[str, simpy.Store] = {}
    for buf in layout.buffers:
        buffer_containers[buf.id] = simpy.Store(env, capacity=buf.capacity)

    # Station resources (parallel capacity).
    #
    # Shared-station dispatch (Task 24): a station uses a PriorityResource ONLY
    # when it is a Shared_Workstation (serves 2+ lines) AND its shared_schedule
    # is "priority" or "round_robin". Every other station, which includes all
    # non-shared stations AND shared stations under FCFS, keeps the plain
    # simpy.Resource with a plain request() so its behavior is byte-identical to
    # before this feature (the no-regression guarantee, Property 11). A
    # PriorityResource exposes the same .queue/.count/.request as a plain
    # Resource, so measurement, queue tracking, and _conn_fill_fraction all keep
    # working unchanged. FIFO tie-break among equal priorities is provided by
    # PriorityResource by default, so equal priorities reproduce arrival order.
    #
    # line_priority maps a line id to its LineInfo.priority (lower value served
    # first); a line absent from layout.lines defaults to 0.
    line_priority: dict[str, int] = {li.id: li.priority for li in layout.lines}

    # Stations that dispatch by priority (either "priority" or "round_robin").
    priority_dispatch_station_ids: set[str] = set()
    # For round_robin stations, the stable served-line order (from the resolved
    # assignment) and a running per-line request sequence number used to build a
    # rotating priority. See process_at_station for the scheme.
    rr_served_lines: dict[str, list[str]] = {}
    rr_served_index: dict[str, dict[str, int]] = {}
    rr_line_seq: dict[str, dict[str, int]] = {}

    station_resources: dict[str, simpy.Resource] = {}
    for station in layout.stations:
        is_shared = bool(line_assignment.shared.get(station.id))
        use_priority = is_shared and station.shared_schedule in ("priority", "round_robin")
        if use_priority:
            station_resources[station.id] = simpy.PriorityResource(
                env, capacity=station.num_machines)
            priority_dispatch_station_ids.add(station.id)
            if station.shared_schedule == "round_robin":
                # Served lines in the stable resolved order; the served index is
                # the minor tie-break rank so lines cycle deterministically.
                served = list(line_assignment.element_lines.get(station.id, []))
                rr_served_lines[station.id] = served
                rr_served_index[station.id] = {lid: k for k, lid in enumerate(served)}
                rr_line_seq[station.id] = {lid: 0 for lid in served}
        else:
            station_resources[station.id] = simpy.Resource(
                env, capacity=station.num_machines)

    # Shared operator pool. Sized to the SUPPLIED operator count. Only created and
    # used when the supplied capacity is > 0; a 0-capacity SimPy Resource is
    # invalid and, more importantly, when no operators are supplied any operation
    # that requires operators can never run (throughput collapses to those units
    # that need no labor).
    operator_capacity = _resolve_operator_capacity(layout, config)
    operator_pool: Optional[simpy.Resource] = None
    if operator_capacity > 0:
        operator_pool = simpy.Resource(env, capacity=operator_capacity)

    # ─── Tracking ────────────────────────────────────────────────────

    class StationTracker:
        def __init__(self, station: Station):
            self.station = station
            self.busy_time = 0.0
            self.units_processed = 0
            self.total_cycle_time = 0.0
            # blocked_time is measured directly (downstream handoff waits).
            self.blocked_time = 0.0
            # starved_time is measured directly: the time this station's machine
            # sits free-and-empty (not busy, not blocked, not in repair) between
            # finishing one unit and beginning the next, i.e. waiting on upstream
            # material. ``last_free_time`` timestamps when the machine last became
            # free (initialized to the post-warmup window start); each time a unit
            # BEGINS processing we attribute the intervening free gap to starvation.
            self.starved_time = 0.0
            self.last_free_time = 0.0
            self.queue_time_integral = 0.0
            self.max_queue = 0
            self._last_queue_time = 0.0
            self._last_queue_len = 0
            self.scrapped = 0
            self.breakdown_time = 0.0
            self.operator_wait_time = 0.0
            # Per-operation sampled cycle-time accumulation keyed by operation
            # name: {name: [sum_ct, count]}. Populated in run_operation; used to
            # build OperationMetrics in the results loop (pure measurement).
            self.op_ct_sums: dict[str, list[float]] = {}
            self._op_order: list[str] = []
            # Operator-seconds of real work performed at this station
            # (Σ operation cycle time × operators_required). Seam for 16.3.
            self.work_content = 0.0
            # Per-line raw accumulators (Task 19). Keyed by line_id. These mirror
            # the aggregate buckets above, split by the line each unit belongs
            # to, using the design's attribution rules. They are purely additive
            # observation: every point that adds to an aggregate bucket adds the
            # identical amount here, so aggregate == sum-of-lines by construction.
            # A None line_id (degenerate/empty-assignment layout) is skipped for
            # attribution but STILL accrues to the aggregate so nothing regresses.
            self.busy_by_line: dict[str, float] = {}
            self.blocked_by_line: dict[str, float] = {}
            self.starved_by_line: dict[str, float] = {}
            self.down_by_line: dict[str, float] = {}
            self.processed_by_line: dict[str, int] = {}

        def _add_line(self, d: dict, line_id, amount):
            """Add ``amount`` to per-line dict ``d`` under ``line_id`` safely.

            Does nothing when ``line_id`` is None (a None line_id can occur in a
            degenerate/empty-assignment layout, so we skip attribution then while
            the caller still performs the existing aggregate accrual).
            """
            if line_id is None:
                return
            d[line_id] = d.get(line_id, 0) + amount

        def record_operation_ct(self, name: str, ct: float):
            entry = self.op_ct_sums.get(name)
            if entry is None:
                self.op_ct_sums[name] = [ct, 1.0]
                self._op_order.append(name)
            else:
                entry[0] += ct
                entry[1] += 1.0

        def update_queue(self, current_time: float, resource: simpy.Resource):
            dt = current_time - self._last_queue_time
            self.queue_time_integral += self._last_queue_len * dt
            self._last_queue_time = current_time
            self._last_queue_len = len(resource.queue)
            self.max_queue = max(self.max_queue, self._last_queue_len)

    class BufferTracker:
        def __init__(self, buffer: Buffer):
            self.buffer = buffer
            self.level_integral = 0.0
            self.max_level = 0
            self.overflow_count = 0
            self._last_time = 0.0
            self._last_level = 0

        def update(self, current_time: float, container: simpy.Store):
            dt = current_time - self._last_time
            self.level_integral += self._last_level * dt
            self._last_time = current_time
            level = len(container.items)
            self._last_level = level
            self.max_level = max(self.max_level, level)

    station_trackers = {s.id: StationTracker(s) for s in layout.stations}
    buffer_trackers = {b.id: BufferTracker(b) for b in layout.buffers}

    # Starvation is only meaningful for stations that actually receive material
    # (have at least one incoming connection). A station with no incoming
    # connections never runs, so it must not accrue starvation. The first
    # station after a source DOES have an incoming connection, so an
    # under-delivering source correctly shows up as starvation there.
    fed_station_ids = {s.id for s in layout.stations if incoming.get(s.id)}

    # ─── Split / merge topology (user-selectable SPLIT behavior) ─────
    # A MERGE station is any station with 2+ incoming connections: it is where
    # parallel branches spawned by an upstream "all" split reconverge. Such a
    # station must JOIN, wait for all expected branch-copies of the same
    # physical unit before processing it exactly once. The number of incoming
    # connections is the number of branches to expect (well-formed split→merge).
    merge_incoming_count: dict[str, int] = {
        s.id: len(incoming.get(s.id, [])) for s in layout.stations
    }
    merge_station_ids = {sid for sid, n in merge_incoming_count.items() if n >= 2}

    # Per-merge-station join state, keyed by unit_id:
    #   {unit_id: {"count": int, "done": simpy.Event, "winner": bool}}
    # The branch-copy that lifts ``count`` to the expected incoming count is the
    # WINNER: it performs the single processing pass and single downstream
    # forward. All other branch-copies register their arrival, then simply stop
    # (their parallel work is already represented). We keep the entry lazily and
    # never purge it (bounded by number of physical units in the run window).
    merge_join_state: dict[str, dict[int, dict]] = {sid: {} for sid in merge_station_ids}

    # Expected branch count at each merge station == its incoming-connection
    # count (well-formed split→merge). Attached to a unit when it is fanned out
    # by an "all" split so downstream merges know how many copies to join.
    merge_expect_map: dict[str, int] = dict(merge_incoming_count)

    # Global unit-id counter: every physical unit created at a source gets a
    # unique, incrementing id. Branch-copies of the SAME physical unit (spawned
    # by an "all" split) SHARE the id so the merge can join them and the sink
    # can count the physical unit exactly once (no overcounting).
    unit_id_counter = [0]

    # Sink de-duplication set: a physical unit (by unit_id) is counted at most
    # ONCE at completion, regardless of how many parallel branch-copies exist.
    # This is the throughput-overcounting safety guard: for a well-formed
    # split→merge only one copy ever reaches the sink anyway; for a malformed
    # "all" layout whose branches never reconverge, the FIRST branch to reach a
    # sink counts and its siblings are ignored (documented behavior).
    completed_unit_ids: set[int] = set()

    # Initialize each station's free-clock to the post-warmup window start so
    # the first between-units gap is measured relative to when accounting begins.
    for _tr in station_trackers.values():
        _tr.last_free_time = warmup

    # Global metrics
    total_transport_time = [0.0]
    total_transport_distance = [0.0]
    total_value_added_time = [0.0]
    completed_units = [0]
    lead_times: list[float] = []
    # Per-line raw completion accumulators (Task 20). These mirror the aggregate
    # completed_units/lead_times above, split by the line each physical unit
    # belongs to. They are purely additive observation: recorded INSIDE the same
    # dedup-guarded block so each physical unit is counted EXACTLY ONCE, and the
    # per-line completed counts sum to completed_units[0] by construction for
    # units with a non-None line (all units in a well-formed layout). A None
    # line_id is skipped for per-line attribution while the aggregate is
    # unchanged. Declared here as closure variables so the results tail (Task 21)
    # can read them from the same scope.
    completed_by_line: dict[str, int] = {}
    lead_times_by_line: dict[str, list[float]] = {}

    # ─── Process Logic ───────────────────────────────────────────────

    def _post_warmup_span(start: float, end: float) -> float:
        """Portion of [start, end] after warmup, used to charge time buckets."""
        return _clamp_span(start, end, warmup)

    def sample_operation_ct(operation: Operation, station: Station) -> float:
        """Sample a cycle time for one operation.

        Uses a triangular distribution over (min_ct, cycle_time, max_ct) when both
        bounds are present; otherwise falls back to the station ``variability``
        approach already used elsewhere in the engine.
        """
        base = operation.cycle_time
        if operation.min_ct is not None and operation.max_ct is not None:
            low = operation.min_ct
            high = operation.max_ct
            mode = min(max(base, low), high)
            if high > low:
                return random.triangular(low, mode, high)
            return mode
        # Fall back to station variability around the operation's own cycle time.
        if station.variability <= 0:
            return base
        low = base * (1 - station.variability * 0.5)
        high = base * (1 + station.variability * 0.5)
        return random.triangular(low, base, high)

    def get_flat_cycle_time(station: Station) -> float:
        if station.variability <= 0:
            return station.cycle_time
        low = station.cycle_time * (1 - station.variability * 0.5)
        high = station.cycle_time * (1 + station.variability * 0.5)
        return random.triangular(low, station.cycle_time, high)

    def synthetic_operations(station: Station) -> list[Operation]:
        """A single synthetic Operation representing the flat fallback step."""
        return [Operation(
            name="__flat__",
            cycle_time=station.cycle_time,
            operators_required=station.operators_required,
        )]

    def run_operation(env: simpy.Environment, station: Station,
                      tracker: "StationTracker", operation: Operation,
                      line_id=None):
        """Execute one Operation, applying the 0-operator automation rule.

        Operations requiring 0 operators are fully automated (no acquisition).
        Operations requiring N > 0 operators acquire N operator units from the
        shared pool before processing and release them afterwards, so operations
        wait when the pool is under-supplied.
        """
        need = operation.operators_required
        ct = sample_operation_ct(operation, station)
        # Per-operation measurement name: use the real operation name; for the
        # synthetic flat fallback ("__flat__"), record under "Processing".
        op_record_name = "Processing" if operation.name == "__flat__" else operation.name

        if need <= 0:
            # Fully AUTOMATED: do not acquire any operator.
            t_proc = env.now
            yield env.timeout(ct)
            span = _post_warmup_span(t_proc, env.now)
            tracker.busy_time += span
            tracker._add_line(tracker.busy_by_line, line_id, span)
            tracker.record_operation_ct(op_record_name, ct)
            tracker.total_cycle_time += ct
            if env.now > warmup:
                total_value_added_time[0] += ct
            return
        elif operator_pool is None:
            # The operation REQUIRES operators but none are supplied (pool
            # capacity 0). It can never acquire labor, so it blocks forever and
            # the unit never completes: this is how an under-supplied line
            # constrains throughput to zero for manned operations.
            yield env.event()  # never fires
            return  # unreachable, but keeps the generator well-formed
        else:
            t_request = env.now
            # Acquire N operator units via N sequential requests. Holding the
            # request context managers open reserves all N units for the duration
            # of processing, then releases them on exit.
            requests = [operator_pool.request() for _ in range(need)]
            try:
                for req in requests:
                    yield req
                # Operator-acquisition wait is attributed to IDLE (Req 13.7);
                # measured over the post-warmup window.
                tracker.operator_wait_time += _post_warmup_span(t_request, env.now)
                t_proc = env.now
                yield env.timeout(ct)
                span = _post_warmup_span(t_proc, env.now)
                tracker.busy_time += span
                tracker._add_line(tracker.busy_by_line, line_id, span)
            finally:
                for req in requests:
                    operator_pool.release(req)
            tracker.record_operation_ct(op_record_name, ct)
            tracker.work_content += ct * need
            tracker.total_cycle_time += ct
            if env.now > warmup:
                total_value_added_time[0] += ct

    def _conn_fill_fraction(conn: Connection) -> float:
        """Normalized busyness (fill fraction) of a connection's IMMEDIATE target.

        0.0 == completely free/empty, 1.0 == full/busy. Used to pick the
        LEAST-BUSY downstream path for load-balanced "either" routing. The value
        is derived deterministically from live SimPy state (no randomness):

          * Station target: (len(resource.queue) + resource.count) / num_machines
            units in service plus queued, per machine.
          * Buffer target: len(store.items) / capacity.
          * Sink target: always 0.0 (a sink always accepts).
        """
        tid = conn.target_id
        if tid in station_map:
            res = station_resources[tid]
            nm = max(1, station_map[tid].num_machines)
            return (len(res.queue) + res.count) / nm
        if tid in buffer_map:
            store = buffer_containers[tid]
            cap = max(1, buffer_map[tid].capacity)
            return len(store.items) / cap
        # Sink (or unknown): always free.
        return 0.0

    # Round-robin rotation state for tie-breaking among EQUALLY least-busy
    # downstream paths. Keyed by the tuple of candidate connection ids so each
    # distinct split point keeps its own rotation. Without this, identical
    # parallel stations that are all equally free would always lose the tie to
    # the earliest one, so work piles onto the first station(s) and the others
    # sit at 0%: the "only two of four parallel stations get used" bug.
    _rr_rotation: dict[tuple, int] = {}

    def choose_least_busy(conns: list[Connection]) -> Connection:
        """Pick the least-busy downstream connection (load-balanced routing).

        Among the candidates, the lowest (fill_fraction, queued) wins. When
        several paths TIE for least-busy (e.g. identical parallel stations that
        are all currently free), we ROUND-ROBIN across the tied paths so the load
        spreads evenly instead of always favouring the earliest one. This keeps
        the routing deterministic under a fixed seed (no randomness) while giving
        even distribution across equivalent parallel paths. Works across mixed
        target types via the normalized fill fraction from ``_conn_fill_fraction``.
        Single-element lists just return their one connection.
        """
        if len(conns) == 1:
            return conns[0]

        def queued_at(conn: Connection) -> int:
            tid = conn.target_id
            if tid in station_map:
                return len(station_resources[tid].queue)
            if tid in buffer_map:
                return len(buffer_containers[tid].items)
            return 0

        # Score each candidate by (fill_fraction, queued); the minimum is the
        # least-busy load. Bucket every candidate that ties that minimum.
        scored = [(_conn_fill_fraction(c), queued_at(c), c) for c in conns]
        min_key = min((f, q) for (f, q, _c) in scored)
        # Small epsilon so near-equal fill fractions (float noise) count as ties.
        tied = [c for (f, q, c) in scored if abs(f - min_key[0]) < 1e-9 and q == min_key[1]]

        if len(tied) == 1:
            return tied[0]

        # Round-robin across the tied paths, keyed by this split's connection set.
        rr_key = tuple(c.id for c in conns)
        nxt = _rr_rotation.get(rr_key, 0) % len(tied)
        _rr_rotation[rr_key] = nxt + 1
        return tied[nxt]

    def pick_either_conn(conns: list[Connection]) -> Connection:
        """Route one unit down a single downstream path in 'either' mode.

        Single-downstream is unchanged (take the one connection). With 2+
        downstream connections, send the unit to the least-busy path. This
        replaces the old ``random.randint`` coin-flip pick.
        """
        if len(conns) == 1:
            return conns[0]
        return choose_least_busy(conns)

    def _fanout_unit(unit: dict, conns: list[Connection]) -> dict:
        """Prepare the unit descriptor for an 'all'-mode parallel fan-out.

        All branch-copies share the physical unit's ``id`` and ``entry_time`` so
        the downstream merge can join them and the sink counts the unit exactly
        once. We attach ``_merge_expect`` (merge station id -> expected branch
        count) so each merge knows how many copies of THIS unit to wait for.
        Returns a single shared descriptor dispatched down every branch.
        """
        return {
            "id": unit["id"],
            "entry_time": unit["entry_time"],
            "line_id": unit.get("line_id"),
            "_merge_expect": merge_expect_map,
        }

    def process_at_station(env: simpy.Environment, station_id: str, unit: dict,
                           upstream: Optional["StationTracker"] = None):
        station = station_map[station_id]
        tracker = station_trackers[station_id]
        resource = station_resources[station_id]

        # ─── MERGE join (parallel "all" branches reconverge here) ────
        # A station with 2+ incoming connections is a MERGE point. When several
        # parallel branch-copies of the SAME physical unit arrive, only ONE
        # processing pass and ONE downstream forward may happen. Each arriving
        # branch-copy registers under the shared unit_id; the copy that lifts the
        # arrival count to the expected number of incoming branches is the WINNER
        # and proceeds to process below. Every other copy is absorbed here (its
        # parallel work is already accounted for at the branch stations), it
        # simply returns without touching this station's machine or metrics.
        #
        # For a NON-"all" arrival (ordinary alternative routing, or a linear
        # line that merely happens to have 2+ feeders) every unit still processes
        # exactly once: such units arrive with a UNIQUE unit_id per physical unit
        # and the expected count for that id is reached on first arrival only if
        # the id was fanned out. To keep ordinary multi-feeder lines correct we
        # only JOIN copies that share an id AND were fanned out ("all"); a unit
        # that arrives with the ``_expect`` hint uses it, otherwise it needs just
        # one arrival. See ``_expect`` threaded onto the unit at the fan-out.
        if station_id in merge_station_ids:
            uid = unit["id"]
            state = merge_join_state[station_id]
            # Number of branch-copies of THIS physical unit to wait for. A unit
            # that was fanned out by an upstream "all" split carries the count of
            # branches converging on this merge (``_merge_expect[station_id]``).
            # An ordinary single-copy arrival (alternative routing, or a linear
            # unit that merely passes through a station with 2+ feeders) has no
            # such hint, so only ONE arrival is expected and it processes
            # immediately, preserving non-split behavior at multi-feeder joins.
            expect = unit.get("_merge_expect", {}).get(station_id, 1)
            if expect > 1:
                entry = state.get(uid)
                if entry is None:
                    entry = {"count": 0}
                    state[uid] = entry
                entry["count"] += 1
                if entry["count"] < expect:
                    # Not all branches have arrived yet, absorb this copy.
                    return
                if entry["count"] > expect:
                    # Surplus late copy: already processed once; absorb it.
                    return
                # Winner: all expected branches arrived. Fall through to process
                # this physical unit exactly once.

        tracker.update_queue(env.now, resource)

        # ─── Shared-station dispatch request (Task 24) ───────────────
        # For a shared station under a non-FCFS schedule, build a PRIORITY
        # request whose priority orders which line is served next (lower value
        # served first, FIFO tie-break within equal priority). Every other
        # station keeps a plain request() so its behavior is byte-identical to
        # before this feature. Only the request TYPE and PRIORITY differ; the
        # with-context management and ``yield machine_req`` below are unchanged.
        #
        #   priority mode: priority = the unit's line rank from LineInfo.priority
        #     (default 0 when the line is absent). Higher-priority (lower value)
        #     lines are served ahead of lower-priority ones.
        #
        #   round_robin mode: cycle the served lines fairly with a deterministic
        #     rotation (no randomness). For a unit on served line L at served
        #     index k (in the station's stable served-line order), the priority
        #     is ``seq[L] * num_served + k`` where seq[L] is a per-line counter
        #     incremented once per request built for L. This gives the Nth
        #     request of every served line the same MAJOR rank (seq * num_served)
        #     so lines interleave request-for-request, while the served index k
        #     is a stable MINOR tie-break that fixes a deterministic cycle order
        #     among lines contending at the same round. The result is that the
        #     station cycles L1, L2, ... L1, L2, ... across served lines.
        if station_id in priority_dispatch_station_ids:
            station = station_map[station_id]
            unit_line = unit.get("line_id")
            if station.shared_schedule == "round_robin":
                served_index = rr_served_index.get(station_id, {})
                num_served = max(1, len(rr_served_lines.get(station_id, [])))
                k = served_index.get(unit_line, 0)
                seq_map = rr_line_seq.get(station_id, {})
                seq = seq_map.get(unit_line, 0)
                if unit_line in seq_map:
                    seq_map[unit_line] = seq + 1
                prio = seq * num_served + k
            else:
                prio = line_priority.get(unit_line, 0)
            machine_request = resource.request(priority=prio)
        else:
            machine_request = resource.request()

        # Request machine. The wait to acquire a busy downstream machine is
        # BLOCKED time for the upstream station that is trying to hand off its
        # completed unit (Req 13.6); the unit cannot leave upstream until this
        # station has capacity.
        with machine_request as machine_req:
            tracker.update_queue(env.now, resource)
            # ─── Direct starvation measurement ───────────────────────
            # A unit has just arrived at this station and is about to begin its
            # journey through the machine. The interval since this station last
            # became free (``last_free_time``) up to NOW was time the machine sat
            # free-and-empty waiting for upstream to feed it: pure starvation.
            # We charge that gap BEFORE waiting on machine contention so we do
            # not misattribute machine-acquisition contention (which is the
            # upstream station's BLOCKED time) to starvation. Only fed stations
            # (those with an incoming connection) can be starved; a station with
            # no feeder path never runs and never accrues starvation.
            if station_id in fed_station_ids:
                span = _post_warmup_span(tracker.last_free_time, env.now)
                tracker.starved_time += span
                tracker._add_line(tracker.starved_by_line, unit.get("line_id"), span)
            t_acquire = env.now
            yield machine_req
            if upstream is not None:
                span = _post_warmup_span(t_acquire, env.now)
                upstream.blocked_time += span
                upstream._add_line(upstream.blocked_by_line, unit.get("line_id"), span)
            tracker.update_queue(env.now, resource)

            # Check for breakdown. Repair time counts toward IDLE (Req 13.7).
            if is_station_broken(station):
                repair_time = station.effective_cycle_time * 0.5
                t_repair = env.now
                yield env.timeout(repair_time)
                span = _post_warmup_span(t_repair, env.now)
                tracker.breakdown_time += span
                tracker._add_line(tracker.down_by_line, unit.get("line_id"), span)

            # Setup time: only applies if station was idle (no prior unit).
            if station.setup_time > 0 and tracker.units_processed == 0:
                yield env.timeout(station.setup_time)

            # Per-Operation execution. Fall back to a single synthetic step when
            # the station has no operations list.
            operations = station.operations if station.operations else synthetic_operations(station)
            for operation in operations:
                yield from run_operation(env, station, tracker, operation, unit.get("line_id"))

            tracker.units_processed += 1
            tracker._add_line(tracker.processed_by_line, unit.get("line_id"), 1)

            # Scrap check
            if station.scrap_rate > 0 and random.random() * 100 < station.scrap_rate:
                tracker.scrapped += 1
                # Machine becomes free-and-empty now (scrapped unit discarded);
                # reset the starvation clock so the next between-units gap is
                # measured from here.
                tracker.last_free_time = env.now
                return

            # ─── Handoff into a downstream BUFFER (Bug B fix) ─────────
            # A station physically holds its finished unit, and therefore keeps
            # its machine occupied, until that unit is accepted downstream. When
            # the next element is a buffer, we perform the ``store.put`` WHILE the
            # machine is still held so the station cannot start the next unit
            # until this one has left. If the buffer is full the put blocks, and
            # that wait is THIS station's BLOCKED time. Only after the unit is
            # accepted do we release the machine (``with`` block exit). Downstream
            # processing is decoupled (the buffer's consumer drains it), so we
            # never over-count downstream work as this station's occupancy.
            downstream_conns = outgoing.get(station_id, [])

            # ─── "all" fan-out (parallel work) ───────────────────────
            # When this station's split_mode is "all" and it has 2+ downstream
            # connections, the physical unit must traverse EVERY path in
            # parallel. We spawn one parallel branch process per connection,
            # each carrying the SAME unit_id (so the downstream merge can join
            # them and the sink counts the unit once). The station's machine is
            # freed as soon as the copies are dispatched: each branch's own
            # processing time is measured at the branch stations, never here.
            if len(downstream_conns) > 1 and station.split_mode == "all":
                branch_unit = _fanout_unit(unit, downstream_conns)
                for conn in downstream_conns:
                    env.process(_forward_process(env, conn, branch_unit))
                tracker.last_free_time = env.now
                tracker.update_queue(env.now, resource)
                return

            # ─── Single-path routing ("either" load-balanced, or 1 conn) ─
            chosen_conn = None
            if downstream_conns:
                chosen_conn = pick_either_conn(downstream_conns)
            buffer_conn = chosen_conn if (chosen_conn is not None
                                          and chosen_conn.target_id in buffer_map) else None

            if buffer_conn is not None:
                if buffer_conn.transport_time > 0:
                    yield env.timeout(buffer_conn.transport_time)
                    if env.now > warmup:
                        total_transport_time[0] += buffer_conn.transport_time
                        total_transport_distance[0] += buffer_conn.distance
                yield from process_at_buffer(env, buffer_conn.target_id, unit, tracker)
                # Unit accepted into the buffer; machine frees now.
                tracker.last_free_time = env.now
                tracker.update_queue(env.now, resource)
                return

        tracker.update_queue(env.now, resource)

        # Forward downstream to a STATION or SINK AFTER releasing this station's
        # machine (the machine is not held during downstream processing, that
        # would over-count this station's occupancy). The completed unit may
        # still have to WAIT to acquire a busy downstream machine; that pure
        # handoff-wait is charged to THIS station's BLOCKED time via the passed
        # tracker (Req 13.6), never the downstream processing time.
        # Restart the starvation clock BEFORE the downstream handoff: any wait to
        # be accepted downstream is charged to BLOCKED (measured in
        # forward_entity), not starvation, and must not delay this station's
        # free-clock: otherwise the recursive/synchronous downstream traversal
        # would shrink the measured upstream-starvation gap.
        tracker.last_free_time = env.now

        # ``chosen_conn`` was selected inside the machine-held block above and is
        # reused here (a station→station/sink target) so we do not consume an
        # extra random draw.
        if chosen_conn is not None:
            yield from forward_entity(env, chosen_conn, unit, tracker)

    def is_station_broken(station: Station) -> bool:
        if station.reliability >= 100:
            return False
        return random.random() * 100 > station.reliability

    def process_at_buffer(env: simpy.Environment, buffer_id: str, unit: dict,
                          upstream: Optional["StationTracker"] = None):
        """Push an arriving unit INTO the buffer store (Bug B fix).

        The buffer is a real capacity-limited ``simpy.Store``. Putting a unit
        into a FULL buffer blocks until a downstream consumer frees a slot; that
        wait is the upstream station's BLOCKED time (Req 13.6): the completed
        unit cannot leave upstream until the buffer accepts it. Once the unit is
        in the store the upstream process is done with it; a dedicated
        ``buffer_consumer`` process drains the store downstream at the downstream
        station's own pace (this is what keeps the buffer full and the upstream
        blocked when downstream is slow).
        """
        buf = buffer_map[buffer_id]
        container = buffer_containers[buffer_id]
        tracker = buffer_trackers[buffer_id]

        tracker.update(env.now, container)

        # Detect a FULL buffer so we can (a) count the overflow event and
        # (b) charge the ensuing wait for space to the upstream station.
        is_full = len(container.items) >= buf.capacity
        if is_full:
            tracker.overflow_count += 1
            t_block = env.now
            yield container.put(unit)
            if upstream is not None:
                span = _post_warmup_span(t_block, env.now)
                upstream.blocked_time += span
                upstream._add_line(upstream.blocked_by_line, unit.get("line_id"), span)
        else:
            yield container.put(unit)

        tracker.update(env.now, container)

    def buffer_consumer(env: simpy.Environment, buffer_id: str):
        """Drain a buffer store downstream at the downstream station's pace.

        Runs for the whole simulation. Each iteration waits (``store.get``) for a
        unit to be available (the DOWNSTREAM station's wait for input is
        captured by that station's own free-clock / starvation accounting), then
        forwards the unit to the buffer's downstream target. Because forwarding
        into a busy downstream station blocks here until the station can accept
        the unit, the consumer only pulls the next unit once the current one has
        been handed off. That paces the drain at the downstream rate and lets the
        store fill to capacity when downstream is slow, which in turn blocks the
        upstream station on ``store.put``.
        """
        container = buffer_containers[buffer_id]
        tracker = buffer_trackers[buffer_id]
        downstream_conns = outgoing.get(buffer_id, [])
        while True:
            unit = yield container.get()
            tracker.update(env.now, container)
            # From here the buffer is the origin of the next handoff; the
            # upstream station is no longer blocked once its unit is in the
            # buffer, so no ``upstream`` tracker is propagated. Buffers have no
            # split_mode field and never fan-out "all"; they keep single-path
            # forwarding. In the rare case a buffer has 2+ downstream
            # connections we default to least-busy ("either") routing.
            if downstream_conns:
                conn = pick_either_conn(downstream_conns)
                yield from forward_entity(env, conn, unit)

    def process_at_sink(env: simpy.Environment, sink_id: str, unit: dict):
        # Count each PHYSICAL unit exactly once (overcounting safety guard). A
        # unit fanned into N parallel branches by an "all" split shares one
        # ``unit_id`` across all copies; whichever copy reaches a sink first
        # counts, and any sibling copies (only possible in a malformed "all"
        # layout whose branches never reconverge) are ignored. For well-formed
        # split→merge layouts only one copy ever reaches the sink anyway. Lead
        # time uses the ORIGINAL unit's shared ``entry_time``.
        uid = unit["id"]
        if env.now > warmup and uid not in completed_unit_ids:
            completed_unit_ids.add(uid)
            completed_units[0] += 1
            lead_times.append(env.now - unit["entry_time"])
            # Per-line attribution (Task 20). Inside the same dedup guard so each
            # physical unit is counted exactly once, mirroring the aggregate. A
            # None line_id (degenerate/empty assignment) is skipped for per-line
            # attribution; the aggregate counting above is unchanged.
            lid = unit.get("line_id")
            if lid is not None:
                completed_by_line[lid] = completed_by_line.get(lid, 0) + 1
                lead_times_by_line.setdefault(lid, []).append(env.now - unit["entry_time"])
        yield env.timeout(0)

    def forward_entity(env: simpy.Environment, conn: Connection, unit: dict,
                       upstream: Optional["StationTracker"] = None):
        if conn.transport_time > 0:
            yield env.timeout(conn.transport_time)
            if env.now > warmup:
                total_transport_time[0] += conn.transport_time
                total_transport_distance[0] += conn.distance

        target_id = conn.target_id
        if target_id in station_map:
            yield from process_at_station(env, target_id, unit, upstream)
        elif target_id in buffer_map:
            yield from process_at_buffer(env, target_id, unit, upstream)
        elif target_id in sink_map:
            yield from process_at_sink(env, target_id, unit)

    def source_generator(env: simpy.Environment, source: Source):
        # Line tag for units originating at THIS source. A Source maps to exactly
        # one line; look it up from the resolved assignment. The guard covers the
        # degenerate empty-assignment case where the source id is absent.
        src_lines = line_assignment.element_lines.get(source.id, [])
        line_id = src_lines[0] if src_lines else None
        # Auto_Match_Arrival_Rate: an arrival_rate of 0 means "don't throttle at the
        # source": match Target Throughput when supplied, else push at a high rate so
        # the line self-throttles at its bottleneck (avoids a divide-by-zero and lets an
        # auto-generated Source run without the user configuring throughput).
        effective_rate = source.arrival_rate
        if effective_rate <= 0:
            if config.target_throughput and config.target_throughput > 0:
                effective_rate = config.target_throughput
            else:
                effective_rate = 1e6
        inter_arrival = 3600.0 / effective_rate

        while True:
            if source.variability > 0:
                low = inter_arrival * (1 - source.variability * 0.5)
                high = inter_arrival * (1 + source.variability * 0.5)
                wait = random.triangular(low, inter_arrival, high)
            else:
                wait = inter_arrival

            yield env.timeout(max(0.1, wait))

            for _ in range(source.batch_size):
                # Each physical unit gets a fresh, unique id. Branch-copies from
                # an "all" fan-out will SHARE this id (see _fanout_unit).
                unit_id_counter[0] += 1
                unit = {"id": unit_id_counter[0], "entry_time": env.now, "line_id": line_id}
                downstream_conns = outgoing.get(source.id, [])
                if not downstream_conns:
                    continue

                # ─── "all" fan-out at the source ─────────────────────
                if len(downstream_conns) > 1 and source.split_mode == "all":
                    branch_unit = _fanout_unit(unit, downstream_conns)
                    for conn in downstream_conns:
                        env.process(_forward_process(env, conn, branch_unit))
                    continue

                # Single-path routing ("either" load-balanced, or one conn).
                conn = pick_either_conn(downstream_conns)
                env.process(_forward_process(env, conn, unit))

    def _forward_process(env: simpy.Environment, conn: Connection, unit: dict):
        yield from forward_entity(env, conn, unit)

    # ─── Start Simulation ────────────────────────────────────────────
    # One decoupled consumer per buffer drains it downstream at the downstream
    # station's pace (Bug B fix).
    for buf in layout.buffers:
        env.process(buffer_consumer(env, buf.id))

    for source in layout.sources:
        env.process(source_generator(env, source))

    env.run(until=duration)

    # ─── Calculate Results ───────────────────────────────────────────
    effective_duration = duration - warmup
    if effective_duration <= 0:
        effective_duration = duration

    # Station metrics with OEE
    station_metrics_list: list[StationMetrics] = []
    max_utilization = 0.0
    # Bottleneck selection (Bug A fix): the TRUE constraint is the station with
    # the largest effective processing cycle time (slowest real work per unit),
    # NOT the highest utilization. A fast upstream station can show high
    # utilization purely because it is BLOCKED waiting to hand off to a slow
    # downstream neighbour, which makes utilization a misleading bottleneck
    # signal. We track the greatest effective_cycle_time candidate in layout
    # order (first wins ties) and separately track the max line utilization so
    # we can apply the existing real-load gate after the loop.
    bottleneck_candidate_id = ""
    bottleneck_candidate_ect = -1.0

    # Task 21: capture each station's exact ``max_capacity`` (the machine-time
    # budget) as it is computed in the loop below, so the per-line percentage
    # conversion in results.py divides by the IDENTICAL denominator the
    # aggregate buckets used. Recomputing in the tail would be deterministic and
    # identical, but capturing here keeps it exact and self-documenting.
    station_max_capacity: dict[str, float] = {}

    # Line-level supply/demand, used to derive the per-station Overstaffed_Signal
    # consistently with the pool/line signal computed below.
    _supplied_operators = operator_capacity
    _total_required = sum(s.total_operators_required for s in layout.stations)
    line_overstaffed = _supplied_operators > _total_required

    for station in layout.stations:
        tracker = station_trackers[station.id]
        # Capacity-time budget over the post-warmup window: one machine-second
        # per machine per second. The four buckets partition this budget.
        max_capacity = effective_duration * station.num_machines
        station_max_capacity[station.id] = max_capacity
        avg_queue = tracker.queue_time_integral / effective_duration if effective_duration > 0 else 0.0
        effective_ct = station.effective_cycle_time
        avg_ct = tracker.total_cycle_time / tracker.units_processed if tracker.units_processed > 0 else effective_ct

        # OEE = Availability × Performance × Quality
        availability = station.reliability / 100.0
        performance = min(effective_ct / avg_ct, 1.0) if avg_ct > 0 else 1.0
        quality = 1.0 - (station.scrap_rate / 100.0)
        oee = availability * performance * quality * 100.0

        # ─── Time accounting (buckets sum to 100% ± 1%) ──────────────
        # busy_time and blocked_time are measured DIRECTLY:
        #   * busy_time: operation processing (see run_operation).
        #   * blocked_time: a completed unit waiting to hand off to a full
        #     downstream buffer / busy downstream machine (see the handoff
        #     paths in process_at_station / process_at_buffer).
        # Both are clamped to the machine-time budget; blocking is bounded by
        # whatever capacity remains after busy so the identity cannot exceed
        # 100%. Starvation (a free machine waiting on upstream material) is not
        # directly observable in the current push-based pass-through model, so
        # per the design we attribute the remaining capacity-time to IDLE
        # (which by definition also holds operator-acquisition wait and
        # breakdown/repair) rather than fabricating a starvation split.
        # busy, blocked, down, and starved are all measured DIRECTLY:
        #   * busy:    operation processing (run_operation).
        #   * blocked: a completed unit waiting to hand off downstream.
        #   * down:    machine breakdown/repair.
        #   * starved: a free-and-empty machine waiting on upstream material
        #     (the between-units gaps measured in process_at_station).
        # Each is clamped to whatever capacity remains so the identity cannot
        # exceed 100%; idle is the NON-NEGATIVE residual (which also absorbs
        # operator-acquisition wait). starved is clamped LAST against the
        # remaining capacity so rounding can never push the sum over budget.
        if max_capacity > 0:
            busy = min(tracker.busy_time, max_capacity)
            blocked = min(tracker.blocked_time, max_capacity - busy)
            down = min(tracker.breakdown_time, max_capacity - busy - blocked)
            starved = min(
                max(tracker.starved_time, 0.0),
                max_capacity - busy - blocked - down,
            )
            residual = max_capacity - busy - blocked - down - starved  # >= 0

            utilization = busy / max_capacity * 100.0
            blocked_pct = blocked / max_capacity * 100.0
            down_pct = down / max_capacity * 100.0
            starved_pct = starved / max_capacity * 100.0
            idle_pct = residual / max_capacity * 100.0
        else:
            utilization = blocked_pct = starved_pct = down_pct = idle_pct = 0.0

        # Track the max line utilization (used only for the real-load gate).
        if utilization > max_utilization:
            max_utilization = utilization

        # Bottleneck candidate: the station with the GREATEST effective cycle
        # time (slowest real work per unit) in layout order. A strict ``>`` with
        # a stable layout-order iteration means the FIRST station at the max
        # effective_cycle_time wins ties (deterministic layout-order tie-break).
        # The >= 70% real-load gate is applied AFTER the loop so a lightly
        # loaded / underfed line flags NO bottleneck at all.
        if effective_ct > bottleneck_candidate_ect:
            bottleneck_candidate_ect = effective_ct
            bottleneck_candidate_id = station.id

        # ─── Per-station Overstaffed_Signal (Req 14.4) ───────────────
        # Kept consistent with the line-level signal: a manned station is
        # flagged overstaffed when the line as a whole supplies more operators
        # than it requires (supplied > required). Such a station carries real
        # labor demand while the line holds surplus operators, so the excess
        # labor is genuinely idle relative to the station's need. Stations whose
        # operations are fully automated (0 operators required) are never
        # flagged. When utilization is also low the surplus is even more
        # pronounced, but low utilization is not required for the signal.
        station_overstaffed = (
            line_overstaffed
            and station.total_operators_required > 0
        )

        # ─── Per-operation metrics (pure measurement) ────────────────
        # Operator requirements come from the layout station's matching
        # operation. Preserve the layout operation order when the station had
        # operations; otherwise fall back to the flat "Processing" record.
        op_required_map: dict[str, int] = {}
        ordered_names: list[str] = []
        if station.operations:
            for op in station.operations:
                op_required_map[op.name] = op.operators_required
                if op.name not in ordered_names:
                    ordered_names.append(op.name)
        # Append any recorded names not already covered (e.g., "Processing"
        # flat fallback), preserving first-seen order.
        for name in tracker._op_order:
            if name not in ordered_names:
                ordered_names.append(name)

        operation_metrics: list[OperationMetrics] = []
        for name in ordered_names:
            entry = tracker.op_ct_sums.get(name)
            if entry is None:
                continue  # operation never executed in the measured window
            op_sum, op_count = entry
            op_avg = op_sum / op_count if op_count > 0 else 0.0
            operation_metrics.append(OperationMetrics(
                name=name,
                avg_cycle_time=round(op_avg, 1),
                operators_required=op_required_map.get(
                    name, station.operators_required if not station.operations else 0),
                is_slowest=False,
            ))
        # Flag the slowest (largest avg_cycle_time) operation on this station.
        if operation_metrics:
            slowest_op = max(operation_metrics, key=lambda o: o.avg_cycle_time)
            slowest_op.is_slowest = True

        # ─── Scrap and setup measurement (measurement only) ──────────
        # scrap_pct is the station-level share of units lost to defects, read
        # from counters the tracker already keeps. Guard the 0/0 case to 0.0 so
        # a station that produced nothing reads a clean zero. No RNG draw.
        denom = tracker.units_processed + tracker.scrapped
        scrap_pct = round(tracker.scrapped / denom * 100.0, 1) if denom > 0 else 0.0
        # setup_impact is the one-time setup as a ratio against the effective
        # cycle time already computed above, capped at 999.0. Guard so a station
        # with no setup or a non-positive cycle time reads 0.0.
        if station.setup_time > 0 and effective_ct > 0:
            setup_impact = round(min(station.setup_time / effective_ct, 999.0), 1)
        else:
            setup_impact = 0.0

        station_metrics_list.append(StationMetrics(
            station_id=station.id,
            station_name=station.name,
            scrap_pct=scrap_pct,
            setup_impact=setup_impact,
            utilization=round(utilization, 1),
            avg_queue_length=round(avg_queue, 1),
            max_queue_length=tracker.max_queue,
            throughput=tracker.units_processed,
            avg_cycle_time=round(avg_ct, 1),
            effective_cycle_time=round(effective_ct, 1),
            blocked_pct=round(blocked_pct, 1),
            starved_pct=round(starved_pct, 1),
            down_pct=round(down_pct, 1),
            idle_pct=round(idle_pct, 1),
            oee=round(oee, 1),
            is_bottleneck=False,
            overstaffed=station_overstaffed,
            operations=operation_metrics,
        ))

    # Mark bottleneck ONLY when the line is actually loaded. The candidate is
    # the slowest station by effective cycle time (the TRUE constraint); we flag
    # it only when the line is meaningfully loaded, reusing the existing
    # real-load gate: the MAX utilization on the line must be >= 70%. Below that
    # the line is lightly loaded / underfed, so NO station is flagged (preserves
    # the earlier underfed-line fix). Handles zero stations safely
    # (bottleneck_candidate_id stays "" and nothing matches).
    BOTTLENECK_UTILIZATION_THRESHOLD = 70.0
    real_bottleneck = (
        bottleneck_candidate_id
        if (bottleneck_candidate_id != "" and max_utilization >= BOTTLENECK_UTILIZATION_THRESHOLD)
        else ""
    )
    for sm in station_metrics_list:
        sm.is_bottleneck = (real_bottleneck != "" and sm.station_id == real_bottleneck)

    # Buffer metrics
    buffer_metrics_list: list[BufferMetrics] = []
    for buf in layout.buffers:
        tracker = buffer_trackers[buf.id]
        avg_level = tracker.level_integral / effective_duration if effective_duration > 0 else 0.0
        buffer_metrics_list.append(BufferMetrics(
            buffer_id=buf.id,
            buffer_name=buf.name,
            avg_level=round(avg_level, 1),
            max_level=tracker.max_level,
            capacity=buf.capacity,
            overflow_count=tracker.overflow_count,
        ))

    # Operator metrics (Req 13.2, 13.3, 14.3, 14.4).
    #
    # Supplied operators = the operator-pool capacity resolved above.
    # Work_Content = Σ over stations of real operator-seconds performed
    #   (Σ over executed manned operations of cycle_time × operators_required;
    #    automated operations contribute 0 labor).
    # Labor_Utilization = min(Work_Content / (supplied × effective_duration), 1) × 100,
    #   so adding operators LOWERS utilization and removing them RAISES it, and
    #   Overstaffed_Signal fires when supplied > required.
    operator_metrics_list: list[OperatorMetrics] = []
    total_operators_required = _total_required
    supplied_operators = _supplied_operators
    labor_utilization = 0.0
    if supplied_operators > 0:
        work_content_seconds = sum(t.work_content for t in station_trackers.values())
        labor_supply_seconds = supplied_operators * effective_duration
        labor_utilization = (
            min((work_content_seconds / labor_supply_seconds) * 100, 100.0)
            if labor_supply_seconds > 0 else 0.0
        )
        operator_metrics_list.append(OperatorMetrics(
            pool_id="line",
            pool_name=f"Line Operators ({supplied_operators} supplied)",
            utilization=round(labor_utilization, 1),
            avg_wait_time=0.0,
            supplied=supplied_operators,
            required=total_operators_required,
            overstaffed=supplied_operators > total_operators_required,
        ))

    # Transport metrics
    total_vat = total_value_added_time[0]
    total_tt = total_transport_time[0]
    total_lead = total_vat + total_tt
    transport_waste_pct = (total_tt / total_lead * 100) if total_lead > 0 else 0.0

    transport_metrics = TransportMetrics(
        total_transport_time=round(total_tt, 1),
        total_value_added_time=round(total_vat, 1),
        transport_waste_pct=round(transport_waste_pct, 1),
        total_distance=round(total_transport_distance[0], 1),
    )

    # Line balance metrics (uses effective cycle time per station)
    cycle_times = [s.effective_cycle_time for s in layout.stations]
    if cycle_times:
        fastest = min(cycle_times)
        slowest = max(cycle_times)
        n_stations = len(cycle_times)
        balance_eff = (sum(cycle_times) / (n_stations * slowest)) * 100 if slowest > 0 else 100
    else:
        fastest = slowest = 0
        balance_eff = 100

    # Use takt from config or calculate from target throughput
    takt_time = config.takt_time
    if not takt_time and config.target_throughput and config.target_throughput > 0:
        takt_time = 3600.0 / config.target_throughput

    line_balance = LineBalanceMetrics(
        balance_efficiency=round(balance_eff, 1),
        takt_time=round(takt_time, 1) if takt_time else None,
        fastest_station_cycle=fastest,
        slowest_station_cycle=slowest,
        cycle_time_spread=round(slowest - fastest, 1),
    )

    # Overall metrics
    hours = effective_duration / 3600.0
    throughput = completed_units[0] / hours if hours > 0 else 0.0
    avg_lead_time = sum(lead_times) / len(lead_times) if lead_times else 0.0
    wip_total = sum(bm.avg_level for bm in buffer_metrics_list) + sum(sm.avg_queue_length for sm in station_metrics_list)

    # Value-Added Ratio (Process Cycle Efficiency), clamped to [0, 100].
    completed = completed_units[0]
    va_per_unit = (total_vat / completed) if completed > 0 else 0.0
    value_added_ratio = (
        min((va_per_unit / avg_lead_time) * 100, 100.0)
        if avg_lead_time > 0 else 0.0
    )
    value_added_ratio = max(0.0, min(value_added_ratio, 100.0))

    # Throughput gap
    throughput_gap = None
    if config.target_throughput and config.target_throughput > 0:
        gap = ((config.target_throughput - throughput) / config.target_throughput) * 100
        throughput_gap = round(max(0, gap), 1)

    # ─── Per-line breakdown (additive) ───────────────────────────────
    # Group the already-computed aggregate metrics into one PerLineResult per
    # resolved line. The aggregate fields below stay EXACTLY as computed (the
    # Whole_Factory_Rollup); only ``lines`` is added. Rounded aggregate scalars
    # are passed so the single-line no-regression path mirrors the rollup
    # exactly on every summary field.
    #
    # Task 21: thread the already-collected per-line raw data into the assembly
    # so results.py can compute the EXACT LineTimeShare splits and replace the
    # Increment A per-line throughput / lead time / WIP approximations with
    # tag-based values. We only COLLECT here (no new measurement, no change to
    # any aggregate or RNG order): each station's captured ``max_capacity`` plus
    # copies of the StationTracker's per-line raw buckets, and the two sink
    # accumulators (completed_by_line, lead_times_by_line) from this scope.
    station_line_raw: dict[str, dict] = {}
    for station in layout.stations:
        tr = station_trackers[station.id]
        station_line_raw[station.id] = {
            "max_capacity": station_max_capacity.get(station.id, 0.0),
            "busy": dict(tr.busy_by_line),
            "blocked": dict(tr.blocked_by_line),
            "starved": dict(tr.starved_by_line),
            "down": dict(tr.down_by_line),
            "processed": dict(tr.processed_by_line),
            "work_content": tr.work_content,
            "scrapped": tr.scrapped,
        }

    per_line_results = assemble_per_line_results(
        layout,
        line_assignment,
        station_metrics_list,
        buffer_metrics_list,
        throughput=round(throughput, 1),
        avg_lead_time=round(avg_lead_time, 1),
        wip_total=round(wip_total, 1),
        value_added_ratio=round(value_added_ratio, 1),
        total_operators=supplied_operators,
        labor_utilization=round(labor_utilization, 1),
        line_balance=line_balance,
        config=config,
        station_line_raw=station_line_raw,
        completed_by_line=dict(completed_by_line),
        lead_times_by_line={k: list(v) for k, v in lead_times_by_line.items()},
        hours=hours,
        effective_duration=effective_duration,
        supplied_operators=supplied_operators,
    )

    return SimulationResult(
        throughput=round(throughput, 1),
        avg_lead_time=round(avg_lead_time, 1),
        wip_total=round(wip_total, 1),
        value_added_ratio=round(value_added_ratio, 1),
        total_operators=supplied_operators,
        labor_utilization=round(labor_utilization, 1),
        stations=station_metrics_list,
        buffers=buffer_metrics_list,
        operators=operator_metrics_list,
        transport=transport_metrics,
        line_balance=line_balance,
        recommendations=[],
        lines=per_line_results,
        simulation_duration=duration,
        target_throughput=config.target_throughput,
        throughput_gap_pct=throughput_gap,
    )
