/**
 * TypeScript interfaces for the Factory Floor Simulator.
 * Matches the backend Pydantic models for the complete DES.
 */

// ═══════════════════════════════════════════════════════════════════════
// ELEMENT TYPES
// ═══════════════════════════════════════════════════════════════════════

export type ElementType = "source" | "station" | "buffer" | "sink" | "operator_pool";

export interface LineInfo {
  id: string;
  name: string;
  target_throughput?: number | null;  // Line_Target units/hr; null => fall back to global target
  takt_time?: number | null;          // line takt seconds; null => derive from target throughput
  priority?: number;                  // Priority_By_Line ordering; lower = higher priority
}

export interface Operation {
  name: string;                 // 1-50 chars
  cycle_time: number;           // positive seconds
  min_ct?: number;              // fastest observed CT (variability)
  max_ct?: number;              // slowest observed CT (variability)
  operators_required: number;   // >= 0 (0 = automated)
}

export interface Source {
  id: string;
  name: string;
  element_type: "source";
  x: number;
  y: number;
  arrival_rate: number;       // units per hour
  batch_size: number;         // units per arrival (default 1)
  variability: number;        // 0-1 (0=constant, 1=high)
  split_mode?: SplitMode;     // routing when 2+ outgoing connections
  line_id?: string | null;    // line this source belongs to; null => auto-resolve by connectivity
}

/** How a unit is routed when an element splits to multiple downstream paths. */
export type SplitMode = "either" | "all";

export interface Station {
  id: string;
  name: string;
  element_type: "station";
  x: number;
  y: number;
  cycle_time: number;         // seconds per unit
  num_machines: number;       // parallel machines (default 1)
  operators_required: number; // operators needed (0=automated)
  has_machine?: boolean;      // whether a machine does the work (default true)
  reliability: number;        // uptime % (100=never breaks)
  scrap_rate: number;         // % of units scrapped
  setup_time: number;         // seconds for changeover
  variability: number;        // 0-1 cycle time variability
  operations: Operation[];    // ordered operations; empty => flat cycle_time fallback
  split_mode?: SplitMode;     // routing when 2+ outgoing connections
  line_ids?: string[];        // lines this station serves; empty => auto, one => dedicated, many => shared
  shared_schedule?: "fcfs" | "round_robin" | "priority"; // how a shared station orders work across lines
}

export interface Buffer {
  id: string;
  name: string;
  element_type: "buffer";
  x: number;
  y: number;
  capacity: number;           // max WIP units (999=infinite)
  line_id?: string | null;    // line this buffer belongs to; null => auto-resolve by connectivity
}

export interface Sink {
  id: string;
  name: string;
  element_type: "sink";
  x: number;
  y: number;
  line_id?: string | null;    // line this sink belongs to; null => auto-resolve by connectivity
}

export interface OperatorPool {
  id: string;
  name: string;
  element_type: "operator_pool";
  x: number;
  y: number;
  count: number;              // number of operators
  walking_speed: number;      // m/s (default 1.4)
}

/** Union of all element types that can be placed on the canvas */
export type CanvasElement = Source | Station | Buffer | Sink | OperatorPool;

// ═══════════════════════════════════════════════════════════════════════
// CONNECTIONS
// ═══════════════════════════════════════════════════════════════════════

export type TransportMode = "none" | "conveyor" | "manual" | "agv";

export interface Connection {
  id: string;
  source_id: string;
  target_id: string;
  transport_time: number;     // seconds
  transport_mode: TransportMode;
  distance: number;           // meters
}

// ═══════════════════════════════════════════════════════════════════════
// LAYOUT
// ═══════════════════════════════════════════════════════════════════════

export interface FloorPlan {
  filename: string;
  data_url?: string;
}

export interface Layout {
  schema_version: number;
  sources: Source[];
  stations: Station[];
  buffers: Buffer[];
  sinks: Sink[];
  operator_pools: OperatorPool[];
  connections: Connection[];
  lines?: LineInfo[];
  floor_plan?: FloorPlan;
}

// ═══════════════════════════════════════════════════════════════════════
// SIMULATION CONFIG & RESULTS
// ═══════════════════════════════════════════════════════════════════════

export interface SimulationConfig {
  duration_seconds: number;
  warmup_seconds: number;
  target_throughput?: number;
  takt_time?: number;
  total_operators?: number;
  operator_count?: number;    // supplied operators for the line/pool
}

export interface LineTimeShare {
  line_id: string;
  line_name: string;
  busy_pct: number;
  blocked_pct: number;
  starved_pct: number;
  down_pct: number;
  idle_pct: number;
  throughput: number;         // units of this line processed at the station
}

export interface StationMetrics {
  station_id: string;
  station_name: string;
  utilization: number;
  avg_queue_length: number;
  max_queue_length: number;
  throughput: number;
  avg_cycle_time: number;
  effective_cycle_time: number;
  blocked_pct: number;
  starved_pct: number;
  idle_pct: number;
  down_pct: number;           // % time down for machine breakdown/repair
  oee: number;
  is_bottleneck: boolean;
  overstaffed: boolean;       // Overstaffed_Signal
  operations: OperationMetrics[]; // per-operation breakdown for this station
  is_shared?: boolean;        // serves 2+ lines (Shared_Workstation)
  line_ids?: string[];        // lines this station serves
  line_shares?: LineTimeShare[]; // per-line split of time and output (empty when single-line)
  scrap_pct?: number;         // scrapped / (processed + scrapped) * 100, one decimal
  setup_impact?: number;      // setup_time / effective_cycle_time ratio, capped 999.0, one-time setup as modeled
}

export interface OperationMetrics {
  name: string;
  avg_cycle_time: number;
  operators_required: number;
  is_slowest: boolean;        // the slowest operation on its station
}

export interface BufferMetrics {
  buffer_id: string;
  buffer_name: string;
  avg_level: number;
  max_level: number;
  capacity: number;
  overflow_count: number;
}

export interface OperatorMetrics {
  pool_id: string;
  pool_name: string;
  utilization: number;
  avg_wait_time: number;
  supplied: number;
  required: number;
  overstaffed: boolean;
}

export interface TransportMetrics {
  total_transport_time: number;
  total_value_added_time: number;
  transport_waste_pct: number;
  total_distance: number;
}

export interface LineBalanceMetrics {
  balance_efficiency: number;
  takt_time: number | null;
  fastest_station_cycle: number;
  slowest_station_cycle: number;
  cycle_time_spread: number;
}

export interface Recommendation {
  element_id: string;
  element_name: string;
  problem: string;
  severity: "high" | "medium" | "low";
  action: string;
  description: string;
  estimated_throughput_gain_pct: number;
}

export interface PerLineResult {
  line_id: string;
  line_name: string;
  is_single_line?: boolean;   // true when this is the only line (no-regression read)
  throughput: number;
  avg_lead_time: number;
  wip_total: number;
  value_added_ratio: number;
  total_operators?: number;
  labor_utilization?: number;
  operators_needed?: number;  // per-line Operators_Needed at 0.1 resolution
  operators_supplied?: number; // per-line Supplied_Operators at 0.1 resolution
  stations: StationMetrics[]; // this line's stations; shared ones flagged is_shared
  buffers: BufferMetrics[];
  line_balance: LineBalanceMetrics;
  recommendations: Recommendation[];
  target_throughput?: number | null; // this line's effective target (own or global)
  takt_time?: number | null;
  throughput_gap_pct?: number | null;
  shared_station_ids?: string[];
}

export interface SimulationResult {
  throughput: number;
  avg_lead_time: number;
  wip_total: number;
  value_added_ratio: number;
  total_operators: number;
  labor_utilization: number;
  stations: StationMetrics[];
  buffers: BufferMetrics[];
  operators: OperatorMetrics[];
  transport: TransportMetrics;
  line_balance: LineBalanceMetrics;
  recommendations: Recommendation[];
  lines?: PerLineResult[];
  simulation_duration: number;
  target_throughput: number | null;
  throughput_gap_pct: number | null;
}

// ═══════════════════════════════════════════════════════════════════════
// TIME STUDY IMPORT
// ═══════════════════════════════════════════════════════════════════════

export interface ImportReportEntry {
  kind: string; // "Fixed" | "Missing" | "Summary"
  message: string;
}

export interface TimeStudyImportResult {
  layout: Layout;
  report: ImportReportEntry[];
}

// ═══════════════════════════════════════════════════════════════════════
// LINE BALANCER
// ═══════════════════════════════════════════════════════════════════════

export interface WorkstationBalance {
  workstation_name: string;
  effective_cycle_time: number;
  pct_of_takt: number;
  over_takt: boolean;
}

export interface LineBalanceProposal {
  takt_time: number;
  workstations: WorkstationBalance[];
  assignment: Record<string, string[]>;  // workstation_name -> ordered operation names
  balance_efficiency: number;
  best_effort: boolean;                   // true when a fully balanced solution wasn't found
  message: string;
}

// ═══════════════════════════════════════════════════════════════════════
// SCENARIOS
// ═══════════════════════════════════════════════════════════════════════

export interface Scenario {
  id: string;
  timestamp: number;
  layout: Layout;
  result: SimulationResult;
}

// ═══════════════════════════════════════════════════════════════════════
// LAYOUT ACTIONS (for useReducer)
// ═══════════════════════════════════════════════════════════════════════

export type LayoutAction =
  | { type: "ADD_SOURCE"; source: Source }
  | { type: "ADD_STATION"; station: Station }
  | { type: "ADD_BUFFER"; buffer: Buffer }
  | { type: "ADD_SINK"; sink: Sink }
  | { type: "ADD_OPERATOR_POOL"; pool: OperatorPool }
  | { type: "MOVE_ELEMENT"; id: string; x: number; y: number }
  | { type: "UPDATE_ELEMENT"; id: string; updates: Partial<CanvasElement> }
  | { type: "DELETE_ELEMENT"; id: string }
  | { type: "ADD_OPERATION"; stationId: string; operation: Operation }
  | { type: "UPDATE_OPERATION"; stationId: string; index: number; updates: Partial<Operation> }
  | { type: "REORDER_OPERATION"; stationId: string; from: number; to: number }
  | { type: "REMOVE_OPERATION"; stationId: string; index: number }
  | { type: "MOVE_OPERATION"; fromStationId: string; toStationId: string; index: number }
  | { type: "APPLY_BALANCE"; assignment: Record<string, string[]> }
  | { type: "IMPORT_TIME_STUDY"; layout: Layout }
  | { type: "ADD_CONNECTION"; connection: Connection }
  | { type: "UPDATE_CONNECTION"; id: string; updates: Partial<Connection> }
  | { type: "DELETE_CONNECTION"; id: string }
  | { type: "SET_FLOOR_PLAN"; floorPlan: FloorPlan }
  | { type: "REMOVE_FLOOR_PLAN" }
  | { type: "LOAD_LAYOUT"; layout: Layout }
  | { type: "CLEAR" }
  | { type: "SAVE_SCENARIO"; result: SimulationResult }
  | { type: "DELETE_SCENARIO"; id: string }
  | { type: "ASSIGN_ELEMENT_LINES"; id: string; line_ids: string[] }
  | { type: "SET_ELEMENT_LINE"; id: string; line_id: string | null }
  | { type: "RENAME_LINE"; line_id: string; name: string }
  | { type: "SET_LINE_TARGET"; line_id: string; target_throughput?: number | null; takt_time?: number | null }
  | { type: "SET_SHARED_SCHEDULE"; station_id: string; schedule: "fcfs" | "round_robin" | "priority" };
