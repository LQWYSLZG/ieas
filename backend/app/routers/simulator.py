"""FastAPI router for the Factory Floor Simulator.

Exposes endpoints for running simulations and validating layouts.
"""

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

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
