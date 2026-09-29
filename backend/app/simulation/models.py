"""Pydantic models for the Factory Floor Simulator.

Complete DES model supporting: Source, Station, Buffer, Sink, Operator Pool,
Connections with transport time, and comprehensive simulation results.
"""

from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Optional, Literal
from enum import Enum


# ═══════════════════════════════════════════════════════════════════════
# ELEMENT TYPES
# ═══════════════════════════════════════════════════════════════════════

class ElementType(str, Enum):
    SOURCE = "source"
    STATION = "station"
    BUFFER = "buffer"
    SINK = "sink"
    OPERATOR_POOL = "operator_pool"


class LineInfo(BaseModel):
    """Line-level identity and optional per-line demand.

    Backward compatible: all demand fields are optional. Priority orders lines
    for Priority_By_Line scheduling, where a lower value means higher priority.
    """
    id: str
    name: str = Field(min_length=1, max_length=50)
    target_throughput: Optional[float] = Field(default=None, ge=0,
        description="Line_Target throughput (units/hr). None => fall back to global target.")
    takt_time: Optional[float] = Field(default=None, ge=0,
        description="Line takt (seconds). None => derive from effective target throughput.")
    priority: int = Field(default=0,
        description="Ordering for Priority_By_Line scheduling; lower = higher priority.")


class Operation(BaseModel):
    """A discrete task performed within a Workstation.

    Each Operation has its own cycle time and operator requirement. A Workstation
    holds an ordered list of Operations; its Effective_Cycle_Time is the sum of
    its Operations' cycle times.
    """
    name: str = Field(min_length=1, max_length=50)
    cycle_time: float = Field(gt=0, description="Operation cycle time in seconds (positive)")
    min_ct: Optional[float] = Field(default=None, ge=0, description="Fastest observed CT (variability)")
    max_ct: Optional[float] = Field(default=None, ge=0, description="Slowest observed CT (variability)")
    operators_required: int = Field(ge=0, default=1,
        description="Operators needed to run this operation (0 = fully automated)")

    @model_validator(mode="after")
    def check_ct_bounds(self):
        if self.min_ct is not None and self.max_ct is not None and self.min_ct > self.max_ct:
            raise ValueError("min_ct cannot exceed max_ct")
        return self


class Source(BaseModel):
    """Entry point where raw material/parts enter the system."""
    id: str
    name: str = Field(min_length=1, max_length=50)
    element_type: Literal["source"] = "source"
    x: float
    y: float
    arrival_rate: float = Field(ge=0,
        description="Units per hour arriving. 0 = Auto_Match_Arrival_Rate "
                    "(match Target Throughput / line capacity at run time).")
    batch_size: int = Field(ge=1, default=1, description="Units per arrival")
    variability: float = Field(ge=0, le=1, default=0.0, description="Arrival variability (0=constant, 1=high)")
    # Behavior when this element has 2+ outgoing connections (a split):
    #   "either" -> each unit goes to ONE downstream path (alternative routing),
    #               load-balanced to the least-busy path.
    #   "all"    -> each unit must go through EVERY downstream path (parallel
    #               work); a downstream merge waits for all branches.
    split_mode: Literal["either", "all"] = Field(default="either",
        description="Routing when this element splits to multiple downstream paths")
    line_id: Optional[str] = Field(default=None,
        description="Line this source belongs to (at most one). None => auto-resolve by connectivity.")


class Station(BaseModel):
    """A Workstation: a processing step (machine, workstation, inspection, assembly).

    A Workstation holds an ordered list of Operations. Its Effective_Cycle_Time is
    the sum of its Operations' cycle times, with backward-compatible fallback to the
    flat ``cycle_time`` when the operations list is empty.
    """
    id: str
    name: str = Field(min_length=1, max_length=50)
    element_type: Literal["station"] = "station"
    x: float
    y: float
    cycle_time: float = Field(gt=0, description="Flat fallback cycle time (used when operations empty)")
    num_machines: int = Field(ge=1, default=1, description="Parallel machines at this station")
    operators_required: int = Field(ge=0, default=1,
        description="Flat fallback operators (used when operations empty; 0=automated)")
    has_machine: bool = Field(default=True,
        description="Whether a machine performs the work. A station does work only "
                    "if it has a machine OR at least one operator; 0 operators AND "
                    "no machine means nothing can do the work.")
    reliability: float = Field(ge=1, le=100, default=100.0, description="Uptime percentage (100=never breaks)")
    scrap_rate: float = Field(ge=0, le=99, default=0.0, description="Percentage of units scrapped")
    setup_time: float = Field(ge=0, default=0.0, description="Setup/changeover time in seconds")
    variability: float = Field(ge=0, le=1, default=0.1, description="Cycle time variability (0=exact, 1=high)")
    operations: list[Operation] = Field(default_factory=list,
        description="Ordered operations. Empty => use flat cycle_time / operators_required.")
    # Behavior when this station has 2+ outgoing connections (a split):
    #   "either" -> each unit goes to ONE downstream path (alternative routing),
    #               load-balanced to the least-busy path.
    #   "all"    -> each unit must go through EVERY downstream path (parallel
    #               work); a downstream merge waits for all branches.
    split_mode: Literal["either", "all"] = Field(default="either",
        description="Routing when this station splits to multiple downstream paths")
    line_ids: list[str] = Field(default_factory=list,
        description="Lines this station serves. Zero => auto-default by connectivity, "
                    "one => dedicated, many => Shared_Workstation.")
    shared_schedule: Literal["fcfs", "round_robin", "priority"] = Field(default="fcfs",
        description="How a shared station orders work across lines. fcfs = first come first served.")

    @property
    def effective_cycle_time(self) -> float:
        """Sum of operations' cycle times; falls back to flat cycle_time when empty."""
        if self.operations:
            return sum(op.cycle_time for op in self.operations)
        return self.cycle_time

    @property
    def total_operators_required(self) -> int:
        """Sum of operations' operators_required; falls back to flat value when empty."""
        if self.operations:
            return sum(op.operators_required for op in self.operations)
        return self.operators_required


class Buffer(BaseModel):
    """WIP storage between stations. Limits queue size, enables blocking/starving detection."""
    id: str
    name: str = Field(min_length=1, max_length=50)
    element_type: Literal["buffer"] = "buffer"
    x: float
    y: float
    capacity: int = Field(ge=1, default=999, description="Max units that can wait (999=effectively infinite)")
    line_id: Optional[str] = Field(default=None,
        description="Line this buffer belongs to (at most one). None => auto-resolve by connectivity.")


class Sink(BaseModel):
    """Exit point where finished products leave the system."""
    id: str
    name: str = Field(min_length=1, max_length=50)
    element_type: Literal["sink"] = "sink"
    x: float
    y: float
    line_id: Optional[str] = Field(default=None,
        description="Line this sink belongs to (at most one). None => auto-resolve by connectivity.")


class OperatorPool(BaseModel):
    """A shared pool of operators that stations draw from."""
    id: str
    name: str = Field(min_length=1, max_length=50)
    element_type: Literal["operator_pool"] = "operator_pool"
    x: float
    y: float
    count: int = Field(ge=1, description="Number of operators in this pool")
    walking_speed: float = Field(gt=0, default=1.4, description="Walking speed in m/s")


# ═══════════════════════════════════════════════════════════════════════
# CONNECTIONS
# ═══════════════════════════════════════════════════════════════════════

class TransportMode(str, Enum):
    NONE = "none"           # Instant (adjacent stations)
    CONVEYOR = "conveyor"   # Automated continuous
    MANUAL = "manual"       # Operator carries/walks
    AGV = "agv"             # Automated guided vehicle


class Connection(BaseModel):
    """Directed connection between two elements representing material flow."""
    id: str
    source_id: str
    target_id: str
    transport_time: float = Field(ge=0, default=0.0, description="Transport time in seconds")
    transport_mode: TransportMode = TransportMode.NONE
    distance: float = Field(ge=0, default=0.0, description="Physical distance in meters (for walking waste calc)")

    @field_validator("target_id")
    @classmethod
    def no_self_loop(cls, v, info):
        if v == info.data.get("source_id"):
            raise ValueError("Connection cannot loop to same element")
        return v


# ═══════════════════════════════════════════════════════════════════════
# LAYOUT (combines all elements)
# ═══════════════════════════════════════════════════════════════════════

class FloorPlan(BaseModel):
    filename: str
    data_url: Optional[str] = None


class Layout(BaseModel):
    """Complete factory floor layout with all element types."""
    schema_version: int = 4
    sources: list[Source] = []
    stations: list[Station] = []
    buffers: list[Buffer] = []
    sinks: list[Sink] = []
    operator_pools: list[OperatorPool] = []
    connections: list[Connection] = []
    lines: list[LineInfo] = []
    floor_plan: Optional[FloorPlan] = None


# ═══════════════════════════════════════════════════════════════════════
# SIMULATION CONFIG
# ═══════════════════════════════════════════════════════════════════════

class SimulationConfig(BaseModel):
    duration_seconds: float = Field(default=3600, gt=0, description="Simulation duration in seconds")
    warmup_seconds: float = Field(ge=0, default=300, description="Warmup period (results excluded)")
    target_throughput: Optional[float] = Field(default=None, description="Target units/hour for gap analysis")
    takt_time: Optional[float] = Field(default=None, description="Takt time in seconds")
    operator_count: Optional[int] = Field(default=None, ge=0,
        description="Supplied operators for the line. None => use sum of operator pools / requirements.")


# ═══════════════════════════════════════════════════════════════════════
# SIMULATION RESULTS
# ═══════════════════════════════════════════════════════════════════════

class OperationMetrics(BaseModel):
    """Per-operation measured metrics within a Workstation."""
    name: str
    avg_cycle_time: float = Field(ge=0)      # actual avg sampled CT for this operation
    operators_required: int = Field(ge=0, default=0)
    is_slowest: bool = False                 # the largest avg_cycle_time on its station


class LineTimeShare(BaseModel):
    """A single line's attributed share of one station's time and output.

    Percentages are of the station's capacity, so per-line shares sum to the
    station bucket percentage within a small rounding tolerance.
    """
    line_id: str
    line_name: str
    busy_pct: float = Field(ge=0, le=100)
    blocked_pct: float = Field(ge=0, le=100)
    starved_pct: float = Field(ge=0, le=100)
    down_pct: float = Field(ge=0, le=100)
    idle_pct: float = Field(ge=0, le=100)
    throughput: float = Field(ge=0, description="Units of this line processed at the station")


class StationMetrics(BaseModel):
    """Per-station simulation metrics."""
    station_id: str
    station_name: str
    utilization: float = Field(ge=0, le=100, description="% time busy")
    avg_queue_length: float = Field(ge=0)
    max_queue_length: float = Field(ge=0)
    throughput: float = Field(ge=0, description="Units processed at this station")
    avg_cycle_time: float = Field(ge=0, description="Actual avg cycle time including variability")
    effective_cycle_time: float = Field(ge=0, default=0, description="Sum of operation cycle times (or flat fallback)")
    blocked_pct: float = Field(ge=0, le=100, default=0, description="% time blocked (can't output)")
    starved_pct: float = Field(ge=0, le=100, default=0, description="% time starved (no input)")
    down_pct: float = Field(ge=0, le=100, default=0, description="% time down for machine breakdown/repair")
    idle_pct: float = Field(ge=0, le=100, default=0, description="% time idle (operator-wait + breakdown)")
    oee: float = Field(ge=0, le=100, default=100, description="Overall Equipment Effectiveness %")
    scrap_pct: float = Field(default=0.0, ge=0, le=100,
        description="Scrapped / (processed + scrapped) * 100, one decimal; 0.0 when no units")
    setup_impact: float = Field(default=0.0, ge=0,
        description="setup_time / effective_cycle_time ratio, capped at 999.0. One-time setup as applied by the engine, not a recurring per-unit loss.")
    is_bottleneck: bool = False
    overstaffed: bool = Field(default=False, description="Overstaffed_Signal for this station")
    operations: list[OperationMetrics] = []
    is_shared: bool = Field(default=False, description="Serves 2+ lines (Shared_Workstation)")
    line_ids: list[str] = Field(default_factory=list, description="Lines this station serves")
    line_shares: list[LineTimeShare] = Field(default_factory=list,
        description="Per-line split of this station's time and output (empty when single-line)")


class BufferMetrics(BaseModel):
    """Per-buffer simulation metrics."""
    buffer_id: str
    buffer_name: str
    avg_level: float = Field(ge=0, description="Average WIP units")
    max_level: float = Field(ge=0, description="Peak WIP units")
    capacity: int
    overflow_count: int = Field(ge=0, default=0, description="Times buffer was full (caused blocking)")


class OperatorMetrics(BaseModel):
    """Per-operator-pool simulation metrics."""
    pool_id: str
    pool_name: str
    utilization: float = Field(ge=0, le=100)
    avg_wait_time: float = Field(ge=0, description="Avg time stations wait for operator")
    supplied: int = Field(ge=0, default=0, description="Operators supplied to this pool/line")
    required: int = Field(ge=0, default=0, description="Operators required by the workstation's operations")
    overstaffed: bool = Field(default=False, description="Overstaffed_Signal (supplied > required)")


class TransportMetrics(BaseModel):
    """Transport/walking waste summary."""
    total_transport_time: float = Field(ge=0, description="Total seconds spent in transport")
    total_value_added_time: float = Field(ge=0, description="Total seconds of actual processing")
    transport_waste_pct: float = Field(ge=0, le=100, description="Transport time as % of total lead time")
    total_distance: float = Field(ge=0, description="Total meters traveled")


class LineBalanceMetrics(BaseModel):
    """Line balance efficiency metrics."""
    balance_efficiency: float = Field(ge=0, le=100, description="How evenly distributed work is")
    takt_time: Optional[float] = Field(default=None, description="Required pace to meet demand (seconds)")
    fastest_station_cycle: float = Field(ge=0)
    slowest_station_cycle: float = Field(ge=0)
    cycle_time_spread: float = Field(ge=0, description="Max - Min cycle time")


class Recommendation(BaseModel):
    """An actionable improvement suggestion."""
    element_id: str
    element_name: str
    problem: str  # "bottleneck" | "wip_explosion" | "starvation" | "blocking" | "labor_constraint" | "walking_waste" | "line_imbalance" | "low_throughput"
    severity: Literal["high", "medium", "low"]
    action: str
    description: str
    estimated_throughput_gain_pct: float = Field(ge=0, description="Estimated % improvement in throughput")


class PerLineResult(BaseModel):
    """Per_Line_Metrics for one Line: the same summary shape as SimulationResult, scoped.

    Defined after StationMetrics, BufferMetrics, LineBalanceMetrics, and
    Recommendation so its referenced types already exist.
    """
    line_id: str
    line_name: str
    is_single_line: bool = False  # True when this is the only line (no-regression read)
    throughput: float = Field(ge=0)
    avg_lead_time: float = Field(ge=0)
    wip_total: float = Field(ge=0)
    value_added_ratio: float = Field(ge=0, le=100)
    total_operators: int = Field(ge=0, default=0)
    labor_utilization: float = Field(ge=0, le=100, default=0)
    operators_needed: float = Field(default=0.0, ge=0,
        description="Per-line Operators_Needed at 0.1 resolution (from Work_Content x processed share)")
    operators_supplied: float = Field(default=0.0, ge=0,
        description="Per-line Supplied_Operators at 0.1 resolution (shared pool split by processed share)")
    stations: list[StationMetrics] = []  # this line's stations; shared ones flagged is_shared
    buffers: list[BufferMetrics] = []
    line_balance: LineBalanceMetrics
    recommendations: list[Recommendation] = []
    target_throughput: Optional[float] = None  # this line's effective target (own or global)
    takt_time: Optional[float] = None
    throughput_gap_pct: Optional[float] = None
    shared_station_ids: list[str] = []


# ═══════════════════════════════════════════════════════════════════════
# TIME STUDY & LINE BALANCER
# ═══════════════════════════════════════════════════════════════════════

class WorkstationBalance(BaseModel):
    """Per-Workstation balance result from the Line_Balancer."""
    workstation_name: str
    effective_cycle_time: float = Field(ge=0, description="Sum of assigned operation cycle times (seconds)")
    pct_of_takt: float = Field(ge=0, description="Effective_Cycle_Time / takt_time * 100")
    over_takt: bool = Field(default=False, description="True when Effective_Cycle_Time exceeds takt_time")


class LineBalanceProposal(BaseModel):
    """A proposed assignment of Operations to Workstations balanced against Takt_Time."""
    takt_time: float = Field(gt=0, description="Takt time (bin size) in seconds")
    workstations: list[WorkstationBalance] = []
    assignment: dict[str, list[str]] = Field(default_factory=dict,
        description="Workstation name -> ordered list of assigned operation names")
    balance_efficiency: float = Field(ge=0, description="Sum ECT / (n_workstations * takt_time) * 100")
    best_effort: bool = Field(default=False,
        description="True when a fully balanced solution within Takt wasn't found")
    message: str = Field(default="", description="Explanation, especially for best-effort proposals")


class SimulationResult(BaseModel):
    """Complete simulation output."""
    # Summary
    throughput: float = Field(ge=0, description="Units per hour exiting the system")
    avg_lead_time: float = Field(ge=0, description="Average time from source to sink in seconds")
    wip_total: float = Field(ge=0, description="Average total WIP in system")
    value_added_ratio: float = Field(ge=0, le=100, description="Value-added time / total lead time * 100")
    total_operators: int = Field(ge=0, default=0, description="Total operators across all stations")
    labor_utilization: float = Field(ge=0, le=100, default=0, description="Average operator utilization %")

    # Detailed metrics
    stations: list[StationMetrics] = []
    buffers: list[BufferMetrics] = []
    operators: list[OperatorMetrics] = []
    transport: TransportMetrics
    line_balance: LineBalanceMetrics

    # Recommendations
    recommendations: list[Recommendation] = []

    # Per-line breakdown (additive). Existing top-level fields remain the
    # Whole_Factory_Rollup, so existing consumers keep working.
    lines: list[PerLineResult] = []

    # Config echo
    simulation_duration: float
    target_throughput: Optional[float] = None
    throughput_gap_pct: Optional[float] = None  # % below target


# ═══════════════════════════════════════════════════════════════════════
# TIME STUDY IMPORT
# ═══════════════════════════════════════════════════════════════════════

class ImportReportEntry(BaseModel):
    """One line in the per-import report."""
    kind: str = Field(description='"Fixed" | "Missing" | "Summary"')
    message: str


class TimeStudyImportResult(BaseModel):
    """Result of importing a time-study Excel file: an auto-generated Layout plus a report."""
    layout: Layout
    report: list[ImportReportEntry] = []
