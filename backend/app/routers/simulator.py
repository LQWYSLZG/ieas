"""FastAPI router for the Factory Floor Simulator.

Exposes endpoints for running simulations and validating layouts.
"""

from typing import Literal, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.simulation.models import (
    Layout,
    LineBalanceProposal,
    SimulationConfig,
    SimulationResult,
    TimeStudyImportResult,
)
from app.simulation.engine import run_simulation
from app.simulation.line_balancer import balance_line
from app.simulation.recommender import generate_recommendations
from app.simulation.time_study import import_time_study
from app.simulation.validator import validate_layout
from app.optimization.service import run_optimize

router = APIRouter()


class SimulationRunRequest(BaseModel):
    layout: Layout
    config: SimulationConfig = SimulationConfig()


class ValidateRequest(BaseModel):
    layout: Layout


class BalanceRequest(BaseModel):
    layout: Layout
    takt_time: float


class ValidateResponse(BaseModel):
    valid: bool
    errors: list[str]


# -----------------------------------------------------------------------
# AUTO-OPTIMIZE REQUEST AND RESPONSE MODELS
# -----------------------------------------------------------------------
# These Pydantic models define the wire contract for the Auto-Optimize
# endpoint (added in task 9.2). Field names match the design Data Models
# exactly, so the frontend TypeScript types mirror them with no remapping and
# an OptimizeResult from optimization/service.py wraps cleanly into
# OptimizeResponse. Project rule: ASCII hyphens only, no em or en dashes.


class PrecedenceRule(BaseModel):
    """One precedence edge: ``before`` must come no later than ``after``.

    The two attribute names (before, after) are the ones build_model reads via
    getattr(rule, "before") and getattr(rule, "after") in
    optimization/model_builder.py, so an OptimizeConstraints parsed from the
    request feeds straight into the pure builder.
    """

    before: str  # operation key that must come no later than...
    after: str  # ...this operation key


class StationLock(BaseModel):
    """Pin one operation to one station.

    The attribute names (operation, station_id) match what build_model reads via
    getattr(lock, "operation") and getattr(lock, "station_id").
    """

    operation: str  # operation key
    station_id: str  # pinned station


class OptimizeConstraints(BaseModel):
    """The user-editable constraints for an Auto-Optimize run.

    Every field has a current-layout-friendly default or a validated range so a
    request may omit them. The ranges enforce the requirement bounds server side
    (Req 2.5 to 2.10). build_model reads each field via getattr with its own
    fallbacks, so these names must stay in lockstep with model_builder.
    """

    precedence: list[PrecedenceRule] = []  # default empty => current order used
    locks: list[StationLock] = []  # default none (Req 2.3)
    # 0 is a sentinel meaning "use the current-layout total"; build_model fills
    # in the real cap from the layout. A positive value is an explicit ceiling.
    operator_cap: int = Field(default=0, ge=0, le=999)  # Req 2.5
    machine_cap: int = Field(default=0, ge=0, le=999)  # Req 2.7
    per_station_machine_limit: Optional[int] = Field(
        default=None, ge=0, le=999
    )  # Req 2.7
    # Whether machine-paced stations may ADD machines (they may always reduce
    # idle ones). Defaults to True: the data decides which stations are machine-
    # paced (has_machine) and the utilization ceiling keeps any change healthy,
    # so there is no need to ask the user a global yes/no. A caller can still set
    # False to forbid adding machines.
    allow_add_machines: bool = True
    operator_weight: float = Field(default=1.0, ge=0, le=1000)  # Req 2.9
    machine_weight: float = Field(default=1.0, ge=0, le=1000)  # Req 2.9
    # Healthy utilization ceiling as a fraction (0.50 to 1.00, default 0.85). No
    # station may be loaded past this share of its takt capacity, so the
    # optimizer cannot drive a station to a bottleneck when trimming resources.
    # Lower is more conservative (more slack for variability); 1.00 reverts to
    # the old behavior of allowing full-takt loading.
    utilization_ceiling: float = Field(default=0.85, ge=0.5, le=1.0)


class ChangeListItem(BaseModel):
    """One plain-language difference between the current and proposed layout.

    Field names and the ``kind`` vocabulary match the ChangeListItem dataclass in
    optimization/model_builder.py exactly, so build_change_list records wrap into
    this model with no remapping (Req 7.1 to 7.4).
    """

    kind: Literal["operation_move", "operator_delta", "machine_delta"]
    station_id: str
    station_name: str
    operation_name: Optional[str] = None  # for operation_move
    from_station_id: Optional[str] = None  # for operation_move
    from_station_name: Optional[str] = None  # for operation_move
    delta: Optional[int] = None  # signed, for operator_delta and machine_delta
    description: str  # plain-language line


class OptimizeRequest(BaseModel):
    """The Auto-Optimize request: a layout, constraints, and a sim config.

    The config drives both the before/after validation simulations and the takt
    resolution when a line does not supply one, matching SimulationRunRequest.
    """

    layout: Layout
    constraints: OptimizeConstraints = OptimizeConstraints()
    config: SimulationConfig = SimulationConfig()


class OptimizeResponse(BaseModel):
    """The Auto-Optimize response.

    Field names and types match the OptimizeResult dataclass in
    optimization/service.py exactly, so run_optimize's return value wraps into
    this response model with no remapping. before_metrics and after_metrics
    reuse the existing SimulationResult; proposed_layout reuses the existing
    Layout, so no new metric shapes are introduced (Req 7.1).
    """

    status: Literal[
        "optimal",
        "feasible_timeout",
        "infeasible",
        "no_feasible_timeout",
        "validation_failed",
        "no_improvement",
    ]
    proposed_layout: Optional[Layout] = None
    before_metrics: Optional[SimulationResult] = None
    after_metrics: Optional[SimulationResult] = None
    change_list: list[ChangeListItem] = []
    optimality_gap_pct: Optional[float] = None  # 0.00 to 100.00 for feasible_timeout
    binding_category: Optional[
        Literal["takt_capacity", "operator_cap", "machine_cap", "locks"]
    ] = None
    message: str = ""


@router.post("/run", response_model=SimulationResult)
async def simulate_run(request: SimulationRunRequest):
    """Run a discrete event simulation on the provided layout.

    Validates the layout, runs the SimPy simulation engine, generates
    optimization recommendations, and returns the combined result.
    """
    # Validate layout first
    errors = validate_layout(request.layout)
    if errors:
        raise HTTPException(status_code=422, detail=errors[0])

    try:
        result = run_simulation(request.layout, request.config)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Generate recommendations and merge into result
    recommendations = generate_recommendations(request.layout, result)
    result.recommendations = recommendations

    return result


@router.post("/optimize", response_model=OptimizeResponse)
async def optimize(request: OptimizeRequest):
    """Run the Auto-Optimize pipeline on the provided layout and constraints.

    Mirrors simulate_run exactly: validate the layout first and return a 422 on a
    non-empty error list, then delegate to run_optimize inside a try/except that
    maps a ValueError to a 422. run_optimize raises ValueError when zero valid
    lines resolve (Req 11.5), and run_simulation inside it raises ValueError on an
    invalid layout; both map to 422 (Req 1.5, 12.4).

    run_optimize returns an OptimizeResult dataclass whose field names match
    OptimizeResponse exactly. The only nested shape needing a conversion is the
    change_list: run_optimize carries model_builder.ChangeListItem dataclasses,
    which are mapped field-for-field into the Pydantic ChangeListItem below. The
    proposed_layout (Layout) and before/after metrics (SimulationResult) pass
    through unchanged, since they are already the existing shared models.
    """
    # Validate the layout first, matching simulate_run.
    errors = validate_layout(request.layout)
    if errors:
        raise HTTPException(status_code=422, detail=errors[0])

    try:
        result = run_optimize(request.layout, request.constraints, request.config)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Map the dataclass change-list records into the Pydantic ChangeListItem.
    # The field names match one-for-one, so this is a straight per-field copy.
    change_list = [
        ChangeListItem(
            kind=item.kind,
            station_id=item.station_id,
            station_name=item.station_name,
            operation_name=item.operation_name,
            from_station_id=item.from_station_id,
            from_station_name=item.from_station_name,
            delta=item.delta,
            description=item.description,
        )
        for item in result.change_list
    ]

    return OptimizeResponse(
        status=result.status,
        proposed_layout=result.proposed_layout,
        before_metrics=result.before_metrics,
        after_metrics=result.after_metrics,
        change_list=change_list,
        optimality_gap_pct=result.optimality_gap_pct,
        binding_category=result.binding_category,
        message=result.message,
    )


@router.post("/validate", response_model=ValidateResponse)
async def validate(request: ValidateRequest):
    """Validate a layout for simulation readiness.

    Returns whether the layout is valid and any validation errors.
    """
    errors = validate_layout(request.layout)

    if errors:
        return ValidateResponse(valid=False, errors=errors)

    return ValidateResponse(valid=True, errors=[])


@router.post("/import-time-study", response_model=TimeStudyImportResult)
async def import_time_study_endpoint(
    files: list[UploadFile] = File(...),
    use_row_order: bool = Form(False),
):
    """Import one or more time-study Excel files and auto-generate an operations-aware layout.

    Accepts a multipart/form-data upload of one or more Excel files (each may
    contain multiple sheets) plus an optional ``use_row_order`` form field. Reads
    each file's bytes together with its filename, then delegates to the time-study
    importer. Returns the auto-generated Layout together with the per-import report.

    When ``use_row_order`` is true and no order column is present, the importer
    treats the row order as the operation sequence; it defaults to false so
    behavior is unchanged when the toggle is off.

    On a ValueError from the importer (a missing required column, no readable
    rows, an all-non-numeric order column, or no time-study sheet found), returns
    HTTP 422 with a specific detail so the frontend can show a precise message and
    preserve the current canvas state.
    """
    sources: list[tuple[str, bytes]] = [
        (f.filename or "upload.xlsx", await f.read()) for f in files
    ]

    try:
        result = import_time_study(sources, use_row_order=use_row_order)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return result


@router.post("/balance", response_model=LineBalanceProposal)
async def balance(request: BalanceRequest):
    """Propose an assignment of Operations to Workstations balanced against a Takt_Time.

    Delegates to the Line_Balancer, which greedily packs Operations into
    Workstations so that each Workstation's Effective_Cycle_Time stays within the
    provided Takt_Time (best-effort when an indivisible Operation cannot fit).

    On a ValueError from the balancer (e.g. a non-positive Takt_Time), returns HTTP
    422 with a specific detail.
    """
    try:
        proposal = balance_line(request.layout, request.takt_time)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return proposal
