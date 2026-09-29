"""Time_Study_Import for the Factory Floor Simulator.

Mirrors the proven app2 logic (``TS_COL_MAP`` synonyms, ``harmonise``,
``clean_time_study``) to read a time-study Excel file, harmonize columns,
clean and validate rows, aggregate with the app2 average-then-sum rule, and
auto-generate an operations-aware ``Layout``.

Aggregation rule (app2):
    1. average Cycle Time per (Workstation, Operation)
    2. a Workstation's Effective_Cycle_Time is the SUM of those per-operation averages
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from io import BytesIO
from typing import Union

import pandas as pd

from .models import (
    Connection,
    ImportReportEntry,
    Layout,
    LineInfo,
    Operation,
    Sink,
    Source,
    Station,
    TimeStudyImportResult,
    TransportMode,
)


# ═══════════════════════════════════════════════════════════════════════
# COLUMN SYNONYM MAP (adapted from app2)
# ═══════════════════════════════════════════════════════════════════════
# Maps a lowercased/stripped incoming column name to its standard name.
# Note: unlike app2 (where the whole Streamlit app treated "line"/"machine"
# as a Workstation alias), here "line" maps to the standard "Line" column and
# "machine" is treated as a Workstation alias, matching the design's standard
# column set: Workstation, Operation, Cycle Time (s), Min CT (s), Max CT (s),
# Operator, Product, Line.
TS_COL_MAP: dict[str, str] = {
    # Workstation
    "workstation": "Workstation",
    "station": "Workstation", "work station": "Workstation", "ws": "Workstation",
    "work center": "Workstation", "workcenter": "Workstation", "cell": "Workstation",
    "machine": "Workstation",
    # Operation
    "operation": "Operation",
    "task": "Operation", "process": "Operation", "step": "Operation",
    "activity": "Operation", "op": "Operation",
    # Cycle time
    "cycle time": "Cycle Time (s)", "ct": "Cycle Time (s)", "cycle time (s)": "Cycle Time (s)",
    "cycle time (sec)": "Cycle Time (s)", "time (s)": "Cycle Time (s)",
    "time per unit": "Cycle Time (s)", "process time": "Cycle Time (s)",
    "std time": "Cycle Time (s)", "standard time": "Cycle Time (s)",
    "avg ct (s)": "Cycle Time (s)", "avg ct": "Cycle Time (s)",
    # Min / Max CT
    "min ct": "Min CT (s)", "min ct (s)": "Min CT (s)", "minimum ct": "Min CT (s)",
    "min cycle time": "Min CT (s)", "min cycle time (s)": "Min CT (s)",
    "max ct": "Max CT (s)", "max ct (s)": "Max CT (s)", "maximum ct": "Max CT (s)",
    "max cycle time": "Max CT (s)", "max cycle time (s)": "Max CT (s)",
    # Operator
    "operator": "Operator", "operator id": "Operator", "operator name": "Operator",
    "worker": "Operator", "associate": "Operator",
    # Product
    "product": "Product",
    "part": "Product", "part number": "Product", "sku": "Product",
    "item": "Product", "product name": "Product",
    # Line
    "line": "Line", "production line": "Line", "line name": "Line",
    "line id": "Line", "line number": "Line",
}

# ═══════════════════════════════════════════════════════════════════════
# ORDER COLUMN SYNONYM MAP (sequence detection)
# ═══════════════════════════════════════════════════════════════════════
# Maps a lowercased/stripped incoming column name to the standard "Order" column.
# Applied as a SECOND harmonization pass in clean_time_study, only against columns
# that were not already claimed by TS_COL_MAP. Because harmonise() guards with
# ``std not in df.columns``, a stray "step" header still resolves to Operation when
# Operation is otherwise absent; the order pass then only promotes a still-unclaimed
# order synonym (e.g. "Op No", "Seq", "Routing") to "Order".
ORDER_COL_MAP: dict[str, str] = {
    "op no": "Order", "op number": "Order", "op #": "Order",
    "operation no": "Order", "operation number": "Order",
    "seq": "Order", "sequence": "Order", "seq no": "Order",
    "step": "Order", "step no": "Order", "step number": "Order",
    "order": "Order", "order no": "Order",
    "routing": "Order", "routing no": "Order",
}

REQUIRED_COLUMNS = {"Workstation", "Operation", "Cycle Time (s)"}

# ═══════════════════════════════════════════════════════════════════════
# MACHINE COLUMN SYNONYM MAP (sheet classification / machine attributes)
# ═══════════════════════════════════════════════════════════════════════
# Maps a lowercased/stripped incoming column name to a standard machine column.
MACHINE_COL_MAP: dict[str, str] = {
    # num_machines  (Requirement 17.1)
    "machines": "num_machines", "parallel capacity": "num_machines",
    "num machines": "num_machines", "machine count": "num_machines",
    "parallel machines": "num_machines", "no of machines": "num_machines",
    "# machines": "num_machines",
    # reliability
    "reliability": "reliability", "reliability (%)": "reliability",
    "reliability %": "reliability", "uptime": "reliability", "uptime (%)": "reliability",
    "availability": "reliability", "availability (%)": "reliability",
    # scrap_rate
    "scrap rate": "scrap_rate", "scrap rate (%)": "scrap_rate", "scrap": "scrap_rate",
    "scrap %": "scrap_rate", "reject rate": "scrap_rate", "reject rate (%)": "scrap_rate",
    "defect rate": "scrap_rate",
    # setup_time
    "setup time": "setup_time", "setup time (s)": "setup_time", "setup": "setup_time",
    "changeover": "setup_time", "changeover time": "setup_time",
    "changeover time (s)": "setup_time", "setup (s)": "setup_time",
    # has_machine
    "has machine": "has_machine", "has machine (y/n)": "has_machine",
    "machine present": "has_machine", "automated": "has_machine",
    "has machine (yes/no)": "has_machine",
}

# ═══════════════════════════════════════════════════════════════════════
# SHEET-CLASSIFICATION SIGNAL SETS (Requirement 14)
# ═══════════════════════════════════════════════════════════════════════
# Standard column names that signal a time-study routing sheet.
TIME_STUDY_SIGNAL_SET: set[str] = {
    "Workstation", "Operation", "Cycle Time (s)",
    "Min CT (s)", "Max CT (s)", "Operator", "Product", "Line", "Order",
}

# Standard machine-attribute column names (plus Workstation as the join key).
MACHINE_SIGNAL_SET: set[str] = {
    "Workstation",
    "num_machines", "reliability", "scrap_rate", "setup_time", "has_machine",
}

# Machine-attribute columns only (used to require >= 1 for a Machine sheet).
MACHINE_ATTRIBUTE_COLS: set[str] = {
    "num_machines", "reliability", "scrap_rate", "setup_time", "has_machine",
}

# Sheets whose (lowercased/stripped) name contains any of these keywords are
# Ignored without scoring their columns (Requirement 14.1).
NON_DATA_SHEET_KEYWORDS: set[str] = {
    "dropdown", "lookup", "reference", "config", "settings", "readme",
}

# Grid spacing for auto-generated station positions
_GRID_X_START = 200.0
_GRID_X_STEP = 220.0
_GRID_Y = 300.0
_STATIONS_PER_ROW = 6
_GRID_Y_STEP = 200.0


def harmonise(df: pd.DataFrame, col_map: dict) -> pd.DataFrame:
    """Rename columns according to a synonym map (case-insensitive on col.lower().strip())."""
    rename: dict = {}
    for col in df.columns:
        std = col_map.get(str(col).lower().strip())
        if std and std not in df.columns:
            rename[col] = std
    return df.rename(columns=rename)


# ═══════════════════════════════════════════════════════════════════════
# SHEET CLASSIFICATION (Requirement 14)
# ═══════════════════════════════════════════════════════════════════════
def _harmonise_all(df: pd.DataFrame) -> pd.DataFrame:
    """Apply the three synonym maps in order and return the harmonized dataframe.

    Order: TS_COL_MAP, then the unclaimed-column ORDER_COL_MAP pass (same as
    clean_time_study), then MACHINE_COL_MAP. harmonise() guards with
    ``std not in df.columns`` so already-claimed standard names are not disturbed.
    Classification therefore scores post-harmonization names, the same names the
    downstream pipeline sees.
    """
    df = harmonise(df, TS_COL_MAP)
    df = harmonise(df, ORDER_COL_MAP)
    df = harmonise(df, MACHINE_COL_MAP)
    return df


def classify_sheet(df: pd.DataFrame, sheet_name: str) -> str:
    """Classify a sheet as "Time_Study" | "Machine" | "Ignored" (Requirement 14).

    1. Non_Data_Sheet_Name (name contains a NON_DATA keyword) -> "Ignored", no scoring.
    2. Otherwise harmonize columns with TS_COL_MAP, ORDER_COL_MAP, MACHINE_COL_MAP.
    3. required time-study cols (Workstation, Operation, Cycle Time) present -> "Time_Study"
       (this also wins ties per Requirement 14.5).
    4. Else score columns against TIME_STUDY_SIGNAL_SET and MACHINE_SIGNAL_SET; higher wins.
    5. Workstation + >=1 machine-attribute column but not time-study -> "Machine".
    6. Neither -> "Ignored".
    """
    name = str(sheet_name).strip().lower()
    if any(kw in name for kw in NON_DATA_SHEET_KEYWORDS):
        return "Ignored"

    cols = set(_harmonise_all(df).columns)  # TS_COL_MAP -> ORDER_COL_MAP -> MACHINE_COL_MAP

    has_required_ts = REQUIRED_COLUMNS <= cols            # {Workstation, Operation, Cycle Time (s)}
    has_ws = "Workstation" in cols
    machine_attrs_present = MACHINE_ATTRIBUTE_COLS & cols

    if has_required_ts:
        return "Time_Study"                                # required cols win + break ties (14.3, 14.5)

    ts_score = len(TIME_STUDY_SIGNAL_SET & cols)
    mc_score = len(MACHINE_SIGNAL_SET & cols)

    if has_ws and machine_attrs_present and mc_score >= ts_score:
        return "Machine"                                   # 14.4
    if ts_score > mc_score and ts_score > 0:
        # Looks time-study-ish but is missing a required column -> not usable as TS.
        # Falls through to Ignored (clean_time_study would reject it anyway).
        return "Ignored"
    if has_ws and machine_attrs_present:
        return "Machine"
    return "Ignored"                                        # 14.6


def clean_time_study(df: pd.DataFrame) -> tuple[pd.DataFrame, list[ImportReportEntry]]:
    """Harmonize, validate required columns, and clean a time-study dataframe.

    Raises:
        ValueError: if required columns are missing, or no readable rows remain.
    """
    df = harmonise(df, TS_COL_MAP)
    # Second pass: promote any still-unclaimed order synonym to "Order". harmonise()
    # guards with ``std not in df.columns``, so a stray "step" that already resolved
    # to Operation above is not re-touched, and Order is only set from an unclaimed
    # order-synonym column.
    df = harmonise(df, ORDER_COL_MAP)
    report: list[ImportReportEntry] = []

    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise ValueError(f"Required columns not found: {missing}")

    before = len(df)
    df = df.dropna(subset=["Workstation", "Operation", "Cycle Time (s)"])
    df["Cycle Time (s)"] = pd.to_numeric(df["Cycle Time (s)"], errors="coerce")
    df = df[df["Cycle Time (s)"] > 0].copy()
    removed = before - len(df)
    if removed > 0:
        report.append(ImportReportEntry(
            kind="Fixed",
            message=f"Removed {removed} row(s) with missing or zero Cycle Time",
        ))

    if df.empty:
        raise ValueError("No readable time-study rows found")

    df["Workstation"] = df["Workstation"].astype(str).str.strip()
    df["Operation"] = df["Operation"].astype(str).str.strip()

    # Coerce optional numeric columns when present
    for opt_col in ("Min CT (s)", "Max CT (s)"):
        if opt_col in df.columns:
            df[opt_col] = pd.to_numeric(df[opt_col], errors="coerce")

    # Coerce the optional Order column to numeric WITHOUT dropping rows for a bad or
    # blank Order value; a NaN Order is handled downstream by sequence detection.
    if "Order" in df.columns:
        df["Order"] = pd.to_numeric(df["Order"], errors="coerce")

    report.append(ImportReportEntry(
        kind="Summary",
        message=f"{len(df):,} operations across {df['Workstation'].nunique()} workstations",
    ))
    return df.reset_index(drop=True), report


# ═══════════════════════════════════════════════════════════════════════
# SEQUENCE DETECTION
# ═══════════════════════════════════════════════════════════════════════
@dataclass
class SequenceDetection:
    """Result of deciding whether a cleaned time-study frame carries a sequence signal.

    Not a pydantic model; it never crosses the API boundary and mirrors the module's
    functional-helper style.
    """

    detected: bool                     # Sequence_Detected
    signal: str                        # "order_column" | "row_order" | "none"
    has_order_column: bool             # a recognized Order column was present
    order_all_nonnumeric: bool = False # Order column present but no usable numeric value


def detect_sequence(df: pd.DataFrame, use_row_order: bool) -> SequenceDetection:
    """Decide whether the cleaned dataframe carries a usable sequence signal.

    Priority (Requirement 1.3): a usable Order column always wins over row order.
      - Order column present with >= 1 usable numeric value -> detected via "order_column".
      - Order column present but no usable numeric value    -> not detected; record reason.
      - No Order column and use_row_order                   -> detected via "row_order".
      - No Order column and not use_row_order               -> not detected.
    """
    has_order_column = "Order" in df.columns

    if has_order_column:
        order_num = pd.to_numeric(df["Order"], errors="coerce")
        usable_numeric = bool(order_num.notna().any())
        if usable_numeric:
            return SequenceDetection(
                detected=True,
                signal="order_column",
                has_order_column=True,
            )
        return SequenceDetection(
            detected=False,
            signal="none",
            has_order_column=True,
            order_all_nonnumeric=True,
        )

    if use_row_order:
        return SequenceDetection(
            detected=True,
            signal="row_order",
            has_order_column=False,
        )

    return SequenceDetection(
        detected=False,
        signal="none",
        has_order_column=False,
    )


# ═══════════════════════════════════════════════════════════════════════
# WORKSTATION ORDERING
# ═══════════════════════════════════════════════════════════════════════
def order_workstations(
    df: pd.DataFrame, detection: SequenceDetection
) -> tuple[list[str], list[ImportReportEntry]]:
    """Return Workstation names in generation order plus any ordering notes.

    - signal == "order_column": order by Workstation_Order_Key (min numeric Order
      per Workstation), ascending; ties -> first appearance; Workstations whose
      rows have no usable Order value -> placed after all ordered ones (in first-
      appearance order) with a report note. Duplicate keys across Workstations ->
      report note.
    - signal == "row_order" or "none": preserve first-appearance order (identical
      to today's op_avg["Workstation"].drop_duplicates() order), no ordering notes.
    """
    # First-appearance order of Workstation names (stable). This reproduces exactly
    # today's op_avg["Workstation"].drop_duplicates() order used by the layout builder.
    ws_series = df["Workstation"]
    first_appearance = ws_series.drop_duplicates().tolist()

    if detection.signal != "order_column":
        return [str(ws) for ws in first_appearance], []

    # Map each Workstation to its first-appearance index for stable tie-breaks.
    first_index: dict = {ws: i for i, ws in enumerate(first_appearance)}

    order_num = pd.to_numeric(df["Order"], errors="coerce")

    # Compute per-Workstation min key ignoring NaN.
    keys: dict = {}
    for ws in first_appearance:
        mask = (ws_series == ws) & order_num.notna()
        vals = order_num[mask]
        if len(vals) > 0:
            keys[ws] = float(vals.min())

    ordered = [ws for ws in first_appearance if ws in keys]
    unordered = [ws for ws in first_appearance if ws not in keys]

    # Sort keyed Workstations by (key, first_appearance_index) ascending so ties
    # resolve by first appearance.
    ordered.sort(key=lambda ws: (keys[ws], first_index[ws]))
    # Unordered kept in first-appearance order (already, since derived from it).

    notes: list[ImportReportEntry] = []

    # Duplicate-order note: any two ordered Workstations sharing the same key.
    key_values = [keys[ws] for ws in ordered]
    duplicate_count = len(key_values) - len(set(key_values))
    if duplicate_count > 0:
        # Count how many workstations are involved in shared-key groups.
        seen: dict = {}
        for k in key_values:
            seen[k] = seen.get(k, 0) + 1
        shared_ws = sum(cnt for cnt in seen.values() if cnt > 1)
        notes.append(ImportReportEntry(
            kind="Fixed",
            message=(
                f"{shared_ws} workstations shared an order value, "
                "ordered them by first appearance."
            ),
        ))

    if unordered:
        notes.append(ImportReportEntry(
            kind="Fixed",
            message=(
                f"{len(unordered)} workstation(s) had no usable order value, "
                "placed after ordered workstations."
            ),
        ))

    result = [str(ws) for ws in ordered] + [str(ws) for ws in unordered]
    return result, notes


def _read_excel(source: Union[str, bytes, BytesIO]) -> pd.DataFrame:
    """Read an Excel file from a path, bytes, or BytesIO using pandas + openpyxl."""
    if isinstance(source, bytes):
        source = BytesIO(source)
    return pd.read_excel(source, engine="openpyxl")


# ═══════════════════════════════════════════════════════════════════════
# MULTI-FILE, MULTI-SHEET READING
# ═══════════════════════════════════════════════════════════════════════
@dataclass
class LabeledSheet:
    """A single parsed-and-cleaned worksheet tagged with its source file and tab.

    Not a pydantic model; it never crosses the API boundary and mirrors the module's
    functional-helper style (like SequenceDetection).
    """

    file_name: str          # source filename, e.g. "line-a.xlsx"
    sheet_name: str         # worksheet/tab name, e.g. "Routing"
    df: pd.DataFrame        # cleaned per-sheet dataframe


def clean_sheet_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Strip Unnamed/blank columns, drop duplicate columns keeping first, drop empty rows.

    Mirrors the Inventory Assistant (app2) per-sheet cleaning pattern (Requirement 13.5):
      1. Drop columns whose stripped name is blank or begins (case-insensitive) with
         "unnamed" (pandas names unlabeled columns "Unnamed: N").
      2. Drop duplicate columns and pandas' ".1"/".2" de-dupe suffixes, keeping the FIRST
         occurrence. The base name is computed by stripping a trailing ".<n>" suffix, so a
         column like "Workstation.1" (pandas auto-rename of a duplicate header) is dropped
         when "Workstation" was already seen.
      3. Drop fully-empty rows (all cells NaN/blank) and reset the index.
    """
    # 1. Drop columns whose name is blank or begins with "Unnamed".
    keep = [
        c for c in df.columns
        if str(c).strip() != "" and not str(c).strip().lower().startswith("unnamed")
    ]
    df = df[keep]

    # 2. Drop duplicate columns and pandas' ".1"/".2" de-dupe suffixes, keeping the first.
    base_seen: set[str] = set()
    keep2: list = []
    for c in df.columns:
        base = re.sub(r"\.\d+$", "", str(c)).strip()
        if base in base_seen:
            continue
        base_seen.add(base)
        keep2.append(c)
    df = df[keep2]

    # 3. Drop fully-empty rows (all cells NaN/blank).
    df = df.dropna(how="all")
    return df.reset_index(drop=True)


def read_workbooks(sources: list[tuple[str, bytes]]) -> list[LabeledSheet]:
    """Read every sheet of every file in the Upload_Set (Requirement 13.3).

    Each source is (filename, raw bytes). Bytes are wrapped in BytesIO and opened once
    with ``pandas.ExcelFile``; every sheet is parsed with ``xl.parse(name)`` and passed
    through ``clean_sheet_columns``. Both .xlsx and .xls are accepted: the engine is
    resolved by pandas (openpyxl / xlrd), not hardcoded here (Requirement 13.2).

    Returns one LabeledSheet per sheet, in file-then-sheet order across all sources.
    """
    sheets: list[LabeledSheet] = []
    for file_name, raw in sources:
        xl = pd.ExcelFile(BytesIO(raw))
        for sheet_name in xl.sheet_names:
            raw_df = xl.parse(sheet_name)
            sheets.append(LabeledSheet(file_name, sheet_name, clean_sheet_columns(raw_df)))
    return sheets


# ═══════════════════════════════════════════════════════════════════════
# COMBINING CLASSIFIED SHEETS (Requirement 15)
# ═══════════════════════════════════════════════════════════════════════
@dataclass
class SheetClassification:
    """The classification decision recorded for a single sheet (Requirement 15).

    Not a pydantic model; it never crosses the API boundary and mirrors the module's
    functional-helper style (like LabeledSheet / SequenceDetection).
    """

    file_name: str          # source filename, e.g. "line-a.xlsx"
    sheet_name: str         # worksheet/tab name, e.g. "Routing"
    sheet_type: str         # "Time_Study" | "Machine" | "Ignored"


def combine_sheets(
    sheets: list[LabeledSheet],
) -> tuple[pd.DataFrame, pd.DataFrame, list[SheetClassification]]:
    """Concatenate all Time_Study sheets and all Machine sheets (Requirement 15).

    Iterates ``sheets`` in read order (file order, then sheet order within a file),
    classifies each with ``classify_sheet``, and records a ``SheetClassification``.
    Time-study frames are harmonized with TS_COL_MAP then ORDER_COL_MAP before concat
    so the combined frame is exactly what ``clean_time_study`` expects. Machine frames
    are harmonized with MACHINE_COL_MAP. Ignored sheets contribute no rows.

    ``pd.concat`` aligns on the column union and fills gaps with NaN, desired, since
    disjoint optional columns become blank downstream. File-then-row order is preserved
    (``apply_machine_attributes`` relies on it for "first non-blank wins").

    Returns:
        (combined_time_study_df, combined_machine_df, classifications). Empty combined
        frames are returned as empty DataFrames (not None).
    """
    ts_frames: list[pd.DataFrame] = []
    mc_frames: list[pd.DataFrame] = []
    classifications: list[SheetClassification] = []

    for sheet in sheets:
        sheet_type = classify_sheet(sheet.df, sheet.sheet_name)
        classifications.append(SheetClassification(
            file_name=sheet.file_name,
            sheet_name=sheet.sheet_name,
            sheet_type=sheet_type,
        ))

        if sheet_type == "Time_Study":
            df = harmonise(sheet.df, TS_COL_MAP)
            df = harmonise(df, ORDER_COL_MAP)
            ts_frames.append(df)
        elif sheet_type == "Machine":
            df = harmonise(sheet.df, MACHINE_COL_MAP)
            mc_frames.append(df)
        # Ignored: recorded only.

    combined_ts = (
        pd.concat(ts_frames, ignore_index=True) if ts_frames else pd.DataFrame()
    )
    combined_machine = (
        pd.concat(mc_frames, ignore_index=True) if mc_frames else pd.DataFrame()
    )
    return combined_ts, combined_machine, classifications


# ═══════════════════════════════════════════════════════════════════════
# MACHINE-ATTRIBUTE MERGE (Requirement 17)
# ═══════════════════════════════════════════════════════════════════════
_HAS_MACHINE_TRUE = {"y", "yes", "true", "1"}
_HAS_MACHINE_FALSE = {"n", "no", "false", "0"}

# Standard machine-attribute columns handled by the merge, plus how each is
# coerced/clamped. Numeric attributes coerce via pd.to_numeric; has_machine
# parses via _parse_has_machine.
_MACHINE_NUMERIC_ATTRS = ("num_machines", "reliability", "scrap_rate", "setup_time")

# Small tolerance for deciding whether float clamping actually changed a value.
_CLAMP_TOL = 1e-9


def _parse_has_machine(raw) -> bool | None:
    """Parse a has_machine cell to True/False, or None when unrecognized/blank.

    Accepts Y/Yes/True/1 -> True and N/No/False/0 -> False (case-insensitive,
    trimmed). Handles native booleans and numeric 1/0. Anything else (including
    NaN/blank/whitespace) returns None, which the caller treats as "blank" so it
    never overrides a default and never triggers a conflict (Requirement 17.8).
    """
    if isinstance(raw, bool):
        return raw
    if raw is None:
        return None
    # NaN check (floats and pandas NA) without importing numpy.
    try:
        if pd.isna(raw):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(raw, (int, float)):
        if raw == 1:
            return True
        if raw == 0:
            return False
        return None
    s = str(raw).strip().lower()
    if s in _HAS_MACHINE_TRUE:
        return True
    if s in _HAS_MACHINE_FALSE:
        return False
    return None


def _is_blank(raw) -> bool:
    """True when a cell is NaN, None, empty, or whitespace-only."""
    if raw is None:
        return True
    try:
        if pd.isna(raw):
            return True
    except (TypeError, ValueError):
        pass
    if isinstance(raw, str) and raw.strip() == "":
        return True
    return False


def apply_machine_attributes(
    stations: list[Station],
    machine_df: pd.DataFrame,
) -> tuple[list[Station], list[ImportReportEntry]]:
    """Merge Combined_Machine_Dataset rows onto built Stations by name (Requirement 17).

    Runs AFTER build_layout, so it works identically for connected and unconnected
    layouts. Matching is by Workstation_Name_Key = casefolded/trimmed workstation
    name. For each matched attribute the FIRST non-blank value in file-and-row order
    wins; blank -> leave the station's existing/default value; out-of-range -> clamp
    to the nearest model bound (Requirement 17.7); an unmatched machine row -> ignored
    + note (17.4); conflicting differing non-blank values for one attribute -> first
    wins + a single note (17.6). Every value is clamped/parsed BEFORE the Station is
    rebuilt so pydantic validation can never raise.

    Returns:
        (stations, notes): the same-order, same-id station list (rebuilt via
        model_copy where attributes were resolved) plus unmatched/conflict/clamp notes.
    """
    # Degenerate cases: nothing to merge (Requirement 17.5).
    if machine_df is None or machine_df.empty or "Workstation" not in machine_df.columns:
        return stations, []

    # Match on casefolded/trimmed name; keep the first station on a name collision.
    station_by_key: dict[str, Station] = {}
    for s in stations:
        key = str(s.name).strip().casefold()
        if key not in station_by_key:
            station_by_key[key] = s

    # Per-station accumulator of resolved (unclamped) attribute values, plus the set
    # of attributes that already emitted a conflict note.
    resolved: dict[str, dict[str, object]] = {}
    conflicted: dict[str, set[str]] = {}
    notes: list[ImportReportEntry] = []

    present_numeric = [c for c in _MACHINE_NUMERIC_ATTRS if c in machine_df.columns]
    has_has_machine = "has_machine" in machine_df.columns

    for _, row in machine_df.iterrows():
        raw_ws = row["Workstation"]
        if _is_blank(raw_ws):
            continue
        key = str(raw_ws).strip().casefold()
        if key not in station_by_key:
            notes.append(ImportReportEntry(
                kind="Machine",
                message=(
                    f"Machine row for '{str(raw_ws).strip()}' matched no "
                    "workstation, ignored."
                ),
            ))
            continue

        station = station_by_key[key]
        display_name = station.name

        def _accumulate(attr: str, value) -> None:
            acc = resolved.setdefault(key, {})
            if attr not in acc:
                acc[attr] = value
                return
            # Already set: a differing non-blank value is a conflict (keep first).
            if acc[attr] != value:
                seen = conflicted.setdefault(key, set())
                if attr not in seen:
                    seen.add(attr)
                    notes.append(ImportReportEntry(
                        kind="Machine",
                        message=(
                            f"Conflicting {attr} values for '{display_name}', "
                            "kept the first."
                        ),
                    ))

        for attr in present_numeric:
            cell = row[attr]
            if _is_blank(cell):
                continue
            num = pd.to_numeric(cell, errors="coerce")
            if pd.isna(num):
                continue
            _accumulate(attr, float(num))

        if has_has_machine:
            cell = row["has_machine"]
            if not _is_blank(cell):
                parsed = _parse_has_machine(cell)
                if parsed is not None:
                    _accumulate("has_machine", parsed)

    if not resolved:
        return stations, notes

    # Rebuild each station whose attributes were resolved, clamping first.
    new_stations: list[Station] = []
    resolved_by_id = {id(station_by_key[k]): (k, vals) for k, vals in resolved.items()}
    for station in stations:
        entry = resolved_by_id.get(id(station))
        if entry is None:
            new_stations.append(station)
            continue
        key, vals = entry
        update: dict[str, object] = {}
        name = station.name

        if "num_machines" in vals:
            v = float(vals["num_machines"])
            clamped = max(1, int(round(v)))
            update["num_machines"] = clamped
            if abs(clamped - v) > _CLAMP_TOL:
                notes.append(ImportReportEntry(
                    kind="Machine",
                    message=f"num_machines {v} on '{name}' adjusted to {clamped}.",
                ))
        if "reliability" in vals:
            v = float(vals["reliability"])
            clamped = min(100.0, max(1.0, v))
            update["reliability"] = clamped
            if abs(clamped - v) > _CLAMP_TOL:
                notes.append(ImportReportEntry(
                    kind="Machine",
                    message=f"reliability {v} on '{name}' clamped to {clamped}.",
                ))
        if "scrap_rate" in vals:
            v = float(vals["scrap_rate"])
            clamped = min(99.0, max(0.0, v))
            update["scrap_rate"] = clamped
            if abs(clamped - v) > _CLAMP_TOL:
                notes.append(ImportReportEntry(
                    kind="Machine",
                    message=f"scrap_rate {v} on '{name}' clamped to {clamped}.",
                ))
        if "setup_time" in vals:
            v = float(vals["setup_time"])
            clamped = max(0.0, v)
            update["setup_time"] = clamped
            if abs(clamped - v) > _CLAMP_TOL:
                notes.append(ImportReportEntry(
                    kind="Machine",
                    message=f"setup_time {v} on '{name}' clamped to {clamped}.",
                ))
        if "has_machine" in vals:
            update["has_machine"] = bool(vals["has_machine"])

        new_stations.append(station.model_copy(update=update))

    return new_stations, notes


# ═══════════════════════════════════════════════════════════════════════
# LINE ASSIGNMENT FROM THE "Line" COLUMN (Requirements 9.1, 9.2, 9.4)
# ═══════════════════════════════════════════════════════════════════════
def line_names_by_workstation(
    df: pd.DataFrame,
) -> tuple[dict[str, list[str]], list[str]]:
    """Compute the distinct Line names per Workstation from a cleaned time-study frame.

    Returns ``(line_by_workstation, line_order)`` where:
      * ``line_by_workstation`` maps each Workstation name to the SORTED list of the
        distinct Line values recorded across its rows. Line values are stringified and
        trimmed; blank/NaN values are ignored. A workstation with no usable Line value
        maps to an empty list.
      * ``line_order`` is the distinct Line names in first-appearance order (as they
        appear scanning rows top to bottom), used for stable line numbering/positioning.

    When the frame has no "Line" column, or the column carries no usable value at all,
    both results are empty ({}, []), which the caller treats as "no line info" so the
    existing single-chain/unconnected behavior is preserved exactly (Req 9.3, 10.7).
    """
    if "Line" not in df.columns:
        return {}, []

    line_by_ws: dict[str, set[str]] = {}
    line_order: list[str] = []
    seen: set[str] = set()

    for ws_raw, line_raw in zip(df["Workstation"], df["Line"]):
        if _is_blank(line_raw):
            continue
        line_name = str(line_raw).strip()
        if line_name == "":
            continue
        ws_name = str(ws_raw).strip()
        line_by_ws.setdefault(ws_name, set()).add(line_name)
        if line_name not in seen:
            seen.add(line_name)
            line_order.append(line_name)

    # No usable Line value anywhere: behave as if there were no Line column.
    if not line_order:
        return {}, []

    sorted_map = {ws: sorted(lines) for ws, lines in line_by_ws.items()}
    return sorted_map, line_order


def build_layout(
    df: pd.DataFrame,
    ordered_names: list[str],
    connect: bool,
    line_by_workstation: dict[str, list[str]] | None = None,
    line_order: list[str] | None = None,
) -> Layout:
    """Build the Layout from cleaned rows, Stations emitted in ``ordered_names`` order.

    App2 aggregation rule (unchanged): average Cycle Time per (Workstation, Operation),
    then a Workstation's Effective_Cycle_Time is the sum of those per-operation averages.

    Station construction (operations, cycle times, Min/Max CT, operators, id scheme) is
    IDENTICAL to the previous ``_build_layout``; the only difference is that Stations are
    emitted in ``ordered_names`` order rather than raw first-appearance order.

    Line assignment (Requirements 9.1, 9.2, 9.4): when ``line_by_workstation`` carries
    usable line info, each Station's ``line_ids`` is set to the sorted distinct Line
    names for that workstation (a workstation under 2+ lines becomes a Shared_Workstation
    via the resolver) and ``layout.lines`` gets one ``LineInfo`` per distinct line name.
    When ``connect`` is also True, ONE Source -> ... -> Sink chain is built per line, each
    running through that line's stations in the existing workstation order restricted to
    the line, sharing any workstation that belongs to 2+ lines (a single Station object
    referenced by both chains). Each line sits on its own row so chains do not overlap.

    When there is NO usable line info this collapses to the prior behavior exactly:
      * ``connect`` False -> only Stations, grid-wrap positioning, no line_ids, no lines.
      * ``connect`` True  -> one Source, one Sink, Source -> WS1 -> ... -> WSn -> Sink in
        a single left-to-right row with strictly increasing x, no line_ids, no lines.
    """
    has_line_info = bool(line_by_workstation) and bool(line_order)
    has_min = "Min CT (s)" in df.columns
    has_max = "Max CT (s)" in df.columns
    has_operator = "Operator" in df.columns

    # Average Cycle Time (and optional variability) per (Workstation, Operation).
    agg_spec: dict = {"Cycle Time (s)": "mean"}
    if has_min:
        agg_spec["Min CT (s)"] = "mean"
    if has_max:
        agg_spec["Max CT (s)"] = "mean"

    op_avg = (
        df.groupby(["Workstation", "Operation"], sort=False)
        .agg(agg_spec)
        .reset_index()
    )

    # Operators required per (Workstation, Operation): distinct operator count
    # when the Operator column is present, else default 1.
    operators_map: dict[tuple[str, str], int] = {}
    if has_operator:
        op_counts = (
            df.dropna(subset=["Operator"])
            .assign(_op=lambda d: d["Operator"].astype(str).str.strip())
            .groupby(["Workstation", "Operation"], sort=False)["_op"]
            .nunique()
        )
        for key, cnt in op_counts.items():
            operators_map[key] = int(cnt) if cnt and cnt > 0 else 1

    def _build_operations(ws_name: str) -> list[Operation]:
        """Build the ordered Operation list for a Workstation (per-workstation op_avg order)."""
        ws_rows = op_avg[op_avg["Workstation"] == ws_name]
        operations: list[Operation] = []
        for _, row in ws_rows.iterrows():
            op_name = str(row["Operation"])
            ct = float(row["Cycle Time (s)"])

            min_ct = None
            if has_min and pd.notna(row.get("Min CT (s)")):
                min_ct = float(row["Min CT (s)"])
            max_ct = None
            if has_max and pd.notna(row.get("Max CT (s)")):
                max_ct = float(row["Max CT (s)"])
            # Guard against inverted bounds that would fail the model validator.
            if min_ct is not None and max_ct is not None and min_ct > max_ct:
                min_ct, max_ct = max_ct, min_ct

            operators_required = operators_map.get((ws_name, op_name), 1)

            operations.append(Operation(
                name=op_name[:50] if op_name else "Operation",
                cycle_time=ct,
                min_ct=min_ct,
                max_ct=max_ct,
                operators_required=operators_required,
            ))
        return operations

    # Emit Stations in the given order. Positioning depends on connect mode:
    #   connect=False -> grid-wrap (today's behavior).
    #   connect=True  -> single-row left-to-right, Source at far left, then stations,
    #                    then Sink at far right, so x strictly increases along the chain.
    #                    (Multi-line layouts reposition stations per line below.)
    stations: list[Station] = []
    for idx, ws_name in enumerate(ordered_names):
        operations = _build_operations(ws_name)
        effective_ct = sum(op.cycle_time for op in operations)

        if connect:
            # Station k sits one step right of the Source (which is at index 0).
            x = _GRID_X_START + (idx + 1) * _GRID_X_STEP
            y = _GRID_Y
        else:
            col = idx % _STATIONS_PER_ROW
            row_n = idx // _STATIONS_PER_ROW
            x = _GRID_X_START + col * _GRID_X_STEP
            y = _GRID_Y + row_n * _GRID_Y_STEP

        # Line assignment from the "Line" column (Req 9.1, 9.2). Empty when no line info.
        ws_line_ids = list(line_by_workstation.get(str(ws_name), [])) if has_line_info else []

        stations.append(Station(
            id=f"ws-import-{idx + 1}",
            name=str(ws_name)[:50] if ws_name else f"Workstation {idx + 1}",
            x=x,
            y=y,
            # Set the flat cycle_time to the effective cycle time for fallback consistency.
            cycle_time=effective_ct if effective_ct > 0 else 1.0,
            operations=operations,
            line_ids=ws_line_ids,
        ))

    # When line info is present, populate layout.lines with a LineInfo per distinct
    # line name (id and name both the line string; no target/takt from import). This
    # marks the assignment explicit so resolve_lines takes the explicit path (Req 9.4).
    lines_info = (
        [LineInfo(id=ln, name=str(ln)[:50]) for ln in line_order]
        if has_line_info else []
    )

    if not connect:
        # Unconnected fallback. Even when a Line column is present we do NOT build
        # sources/sinks/connections here (no sequence detected), but we still carry
        # the station line_ids and layout.lines so resolve_lines groups them (Req 9.3).
        return Layout(stations=stations, lines=lines_info)

    # ── Multi-line connected generation (Requirements 9.1, 9.2, 9.4) ───────
    # When line info is present, build ONE Source -> ... -> Sink chain per line, each
    # running through that line's stations in the existing workstation order restricted
    # to the line. A workstation belonging to 2+ lines is a single shared Station object
    # that appears in every serving chain's connections.
    if has_line_info:
        return _build_multiline_layout(stations, line_order)

    # ── Single connected-chain generation (Requirements 3, 5, 6, 10) ───────
    n = len(stations)

    # Source at the far left; Sink one step right of the last station.
    source = Source(
        id="src-import",
        name="Line Entry",
        x=_GRID_X_START,
        y=_GRID_Y,
        arrival_rate=0,
        batch_size=1,
        variability=0,
    )
    sink = Sink(
        id="snk-import",
        name="Line Exit",
        x=_GRID_X_START + (n + 1) * _GRID_X_STEP,
        y=_GRID_Y,
    )

    # Chain: src-import -> ws-import-1 -> ... -> ws-import-n -> snk-import.
    # Exactly n+1 connections, ids conn-import-0 .. conn-import-n.
    node_ids = [source.id] + [st.id for st in stations] + [sink.id]
    connections: list[Connection] = []
    for i in range(len(node_ids) - 1):
        connections.append(Connection(
            id=f"conn-import-{i}",
            source_id=node_ids[i],
            target_id=node_ids[i + 1],
            transport_time=0,
            transport_mode=TransportMode.NONE,
            distance=0,
        ))

    return Layout(
        sources=[source],
        stations=stations,
        sinks=[sink],
        connections=connections,
    )


def _build_multiline_layout(
    stations: list[Station],
    line_order: list[str],
) -> Layout:
    """Build one Source -> ... -> Sink chain per line, sharing multi-line stations.

    ``stations`` are the already-built Station objects (with ``line_ids`` set from the
    "Line" column) in generation order. ``line_order`` is the distinct line names in
    first-appearance order. For each line, in ``line_order``:
      * select that line's stations, preserving the generation order of ``stations``;
      * give the line its own Source (id ``src-import-{i}``, name "<line> Entry",
        line_id=<line>, arrival_rate=0, batch_size=1, variability=0) and Sink
        (id ``snk-import-{i}``, name "<line> Exit", line_id=<line>);
      * chain source -> ordered stations -> sink with connection ids unique per line
        (``conn-import-{i}-{k}``).

    Positioning is computed globally so imported multi-line layouts render as clean
    parallel rows:
      * X is a global processing-stage column, the MAX over the lines a station serves
        of its 1-based slot within that line's ordered sequence. This aligns the same
        stage across rows and keeps x strictly increasing along every line's chain.
      * Y places a dedicated station (serves one line) on that line's row, and a shared
        station (serves 2+ lines) in a lane at the average of its served line indices,
        so shared stations read as common nodes the lines converge on.
      * Sources stay on their own line's row at the far left. Sinks stay on their own
        line's row at a shared far-right column so they align.

    The shared station is a single Station object appearing in both chains' connections,
    which resolve_lines reads as a Shared_Workstation. Returns a Layout carrying all
    per-line sources, the shared station list, all sinks, all connections, and one
    LineInfo per line.
    """
    stations_by_id = {st.id: st for st in stations}

    # ── Global positioning pass (positioning only, no structural change) ──────
    # Per line, the ordered station list in the existing generation order.
    line_stations_by_line: dict[str, list[Station]] = {
        line_name: [st for st in stations if line_name in st.line_ids]
        for line_name in line_order
    }
    line_index_of = {line_name: idx for idx, line_name in enumerate(line_order)}

    # For each station: the sorted line_order indices it serves, and its global
    # column = MAX over served lines of (per-line slot + 1). The max-column rule
    # keeps x strictly increasing along every line (a station's column is always
    # >= its slot+1 on each line it serves, so it never lands left of an earlier
    # station on any line it serves).
    served_line_indices: dict[str, list[int]] = {}
    column: dict[str, int] = {}
    for line_name in line_order:
        for slot, st in enumerate(line_stations_by_line[line_name]):
            served_line_indices.setdefault(st.id, []).append(line_index_of[line_name])
            column[st.id] = max(column.get(st.id, 0), slot + 1)
    for st_id in served_line_indices:
        served_line_indices[st_id].sort()

    max_column = max(column.values(), default=0)

    # Apply x/y to each station once from the global computation. Remove the old
    # first-wins per-line positioning, which stranded shared stations on line 0's row.
    for st in stations:
        served = served_line_indices[st.id]
        st.x = _GRID_X_START + column[st.id] * _GRID_X_STEP
        avg_index = sum(served) / len(served)   # dedicated -> its own row; shared -> lane
        st.y = _GRID_Y + avg_index * _GRID_Y_STEP

    sources: list[Source] = []
    sinks: list[Sink] = []
    connections: list[Connection] = []

    for line_idx, line_name in enumerate(line_order):
        line_stations = line_stations_by_line[line_name]

        y = _GRID_Y + line_idx * _GRID_Y_STEP

        source = Source(
            id=f"src-import-{line_idx}",
            name=f"{line_name} Entry"[:50],
            x=_GRID_X_START,
            y=y,
            arrival_rate=0,
            batch_size=1,
            variability=0,
            line_id=line_name,
        )
        sources.append(source)

        # Every line's sink shares a far-right column so sinks align across rows.
        # The +1 guarantees every station on this line is strictly left of the sink.
        sink = Sink(
            id=f"snk-import-{line_idx}",
            name=f"{line_name} Exit"[:50],
            x=_GRID_X_START + (max_column + 1) * _GRID_X_STEP,
            y=y,
            line_id=line_name,
        )
        sinks.append(sink)

        # Chain source -> ordered stations -> sink, unique connection ids per line.
        node_ids = [source.id] + [st.id for st in line_stations] + [sink.id]
        for k in range(len(node_ids) - 1):
            connections.append(Connection(
                id=f"conn-import-{line_idx}-{k}",
                source_id=node_ids[k],
                target_id=node_ids[k + 1],
                transport_time=0,
                transport_mode=TransportMode.NONE,
                distance=0,
            ))

    lines_info = [LineInfo(id=ln, name=str(ln)[:50]) for ln in line_order]

    # Emit stations in their original generation order (stations_by_id preserves the
    # single shared Station object) for a stable, de-duplicated station list.
    return Layout(
        sources=sources,
        stations=[stations_by_id[st.id] for st in stations],
        sinks=sinks,
        connections=connections,
        lines=lines_info,
    )


# ═══════════════════════════════════════════════════════════════════════
# SOURCE NORMALIZATION (Requirement 13.1, backward compatibility)
# ═══════════════════════════════════════════════════════════════════════
# A single source may be raw bytes, a str path, a BytesIO stream, or an
# explicit (filename, bytes) tuple; ``sources`` may be one of those or a list
# of them. Everything normalizes to list[(filename, bytes)].
SourceLike = Union[str, bytes, BytesIO, tuple]


def _normalize_one_source(src) -> tuple[str, bytes]:
    """Normalize a single source into a (filename, bytes) tuple.

    - bytes            -> ("upload.xlsx", bytes)
    - str (path)       -> (basename(path), file bytes read from disk)
    - BytesIO          -> ("upload.xlsx", stream.getvalue())
    - (filename, bytes)-> (str(filename), bytes)
    """
    if isinstance(src, tuple):
        if len(src) != 2:
            raise ValueError(
                "A source tuple must be (filename, bytes)."
            )
        filename, raw = src
        if isinstance(raw, BytesIO):
            raw = raw.getvalue()
        if not isinstance(raw, (bytes, bytearray)):
            raise ValueError("A source tuple's second element must be bytes.")
        return str(filename), bytes(raw)
    if isinstance(src, BytesIO):
        return "upload.xlsx", src.getvalue()
    if isinstance(src, (bytes, bytearray)):
        return "upload.xlsx", bytes(src)
    if isinstance(src, str):
        with open(src, "rb") as fh:
            return os.path.basename(src) or "upload.xlsx", fh.read()
    raise ValueError(
        f"Unsupported source type: {type(src).__name__}. Expected bytes, a "
        "path str, a BytesIO, a (filename, bytes) tuple, or a list of those."
    )


def _normalize_sources(sources: Union[SourceLike, list]) -> list[tuple[str, bytes]]:
    """Normalize ``sources`` into a list of (filename, bytes) tuples.

    Accepts a single source (bytes / str path / BytesIO / (filename, bytes)) OR a
    list of any of those, so existing single-source callers, ``import_time_study(bytes)``
    or ``import_time_study(path)``, keep working while new callers pass a list.
    A single (filename, bytes) tuple is treated as ONE source (not a two-item list).
    """
    if isinstance(sources, list):
        return [_normalize_one_source(s) for s in sources]
    return [_normalize_one_source(sources)]


# ═══════════════════════════════════════════════════════════════════════
# REPORT ASSEMBLY (Requirement 18)
# ═══════════════════════════════════════════════════════════════════════
def _sheets_report(
    normalized: list[tuple[str, bytes]],
    sheets: list[LabeledSheet],
    classifications: list[SheetClassification],
) -> list[ImportReportEntry]:
    """Build the two always-present "Sheets" entries (Requirements 18.1, 18.2)."""
    n_files = len({name for name, _ in normalized})
    n_sheets = len(sheets)

    _TYPE_LABEL = {
        "Time_Study": "Time study",
        "Machine": "Machine",
        "Ignored": "ignored",
    }
    listing = ", ".join(
        f"{c.file_name}:{c.sheet_name} → {_TYPE_LABEL.get(c.sheet_type, c.sheet_type)}"
        for c in classifications
    )
    return [
        ImportReportEntry(
            kind="Sheets",
            message=f"Read {n_files} file(s), {n_sheets} sheet(s).",
        ),
        ImportReportEntry(
            kind="Sheets",
            message=f"Sheets: {listing}." if listing else "Sheets: (none).",
        ),
    ]


def _machine_applied_report(
    machine_df: pd.DataFrame,
    stations: list[Station],
) -> list[ImportReportEntry]:
    """Build the "Applied N machine attribute value(s) to M workstation(s)." entry.

    Only emitted when the combined machine dataset is non-empty AND at least one
    attribute value was applied (Requirement 18.3). Counts are re-derived from
    ``machine_df`` against the built station names using the SAME matching rule as
    ``apply_machine_attributes`` (casefold/trim name; first non-blank per attribute
    wins), so N/M reflect the values that actually landed on stations.
    """
    if machine_df is None or machine_df.empty or "Workstation" not in machine_df.columns:
        return []

    station_keys = {str(s.name).strip().casefold() for s in stations}
    present_numeric = [c for c in _MACHINE_NUMERIC_ATTRS if c in machine_df.columns]
    has_has_machine = "has_machine" in machine_df.columns

    # Per station key, the set of attributes that received a usable (first non-blank)
    # value. "First wins" -> an attribute counts once per station regardless of how
    # many rows carry it.
    applied: dict[str, set[str]] = {}
    for _, row in machine_df.iterrows():
        raw_ws = row["Workstation"]
        if _is_blank(raw_ws):
            continue
        key = str(raw_ws).strip().casefold()
        if key not in station_keys:
            continue
        acc = applied.setdefault(key, set())
        for attr in present_numeric:
            if attr in acc:
                continue
            cell = row[attr]
            if _is_blank(cell):
                continue
            if pd.isna(pd.to_numeric(cell, errors="coerce")):
                continue
            acc.add(attr)
        if has_has_machine and "has_machine" not in acc:
            cell = row["has_machine"]
            if not _is_blank(cell) and _parse_has_machine(cell) is not None:
                acc.add("has_machine")

    m_stations = sum(1 for attrs in applied.values() if attrs)
    n_values = sum(len(attrs) for attrs in applied.values())
    if n_values == 0:
        return []
    return [ImportReportEntry(
        kind="Machine",
        message=(
            f"Applied {n_values} machine attribute value(s) to "
            f"{m_stations} workstation(s)."
        ),
    )]


def _sequence_and_summary_report(
    detection: SequenceDetection,
    layout: Layout,
) -> list[ImportReportEntry]:
    """Build the Sequence outcome entry plus the generated-count summary (Req 7, 18.5)."""
    n = len(layout.stations)
    entries: list[ImportReportEntry] = []

    if detection.detected and detection.signal == "order_column":
        entries.append(ImportReportEntry(
            kind="Sequence",
            message=(
                f"Sequence detected: auto-connected Source → {n} workstations → Sink."
            ),
        ))
    elif detection.detected and detection.signal == "row_order":
        # Row order was the signal (Req 7.4 / 9.3) and the line was auto-connected (Req 7.1).
        entries.append(ImportReportEntry(
            kind="Sequence",
            message="Row order was used as the sequence (no order column present).",
        ))
        entries.append(ImportReportEntry(
            kind="Sequence",
            message=(
                f"Sequence detected: auto-connected Source → {n} workstations → Sink."
            ),
        ))
    elif not detection.detected and detection.order_all_nonnumeric:
        entries.append(ImportReportEntry(
            kind="Sequence",
            message=(
                "An order column was found but had no usable numbers, "
                "created workstations unconnected."
            ),
        ))
    else:
        entries.append(ImportReportEntry(
            kind="Sequence",
            message=(
                "No sequence column found: workstations created unconnected. "
                "Add a Source and Sink, then connect them."
            ),
        ))

    entries.append(ImportReportEntry(
        kind="Summary",
        message=f"Generated {n} workstation(s) from time study",
    ))
    return entries


def import_time_study(
    sources: Union[SourceLike, list],
    use_row_order: bool = False,
) -> TimeStudyImportResult:
    """Read one or more time-study/machine workbooks and produce a Layout + report.

    Orchestrates the full pipeline: normalize sources -> read every sheet of every
    file -> classify + combine sheets -> require a time-study sheet -> clean/validate
    -> detect sequence -> order workstations -> build layout (connected iff detected)
    -> merge machine attributes -> assemble the report.

    Args:
        sources: a single source (Excel path str, raw bytes, BytesIO, or a
            (filename, bytes) tuple) OR a list of any of those. Bare single-source
            forms preserve backward compatibility with older callers.
        use_row_order: opt-in fallback, when no Order column is present, use the
            row order as the sequence (Requirements 9.1, 9.2).

    Returns:
        TimeStudyImportResult with the auto-generated Layout and per-import report.

    Raises:
        ValueError: "No time-study sheet found: …" when no uploaded sheet is a
            time-study sheet (Requirement 16.1); "Required columns not found: {missing}"
            or "No readable time-study rows found" from ``clean_time_study`` when the
            combined time-study dataframe is present but invalid.
    """
    normalized = _normalize_sources(sources)
    report: list[ImportReportEntry] = []

    sheets = read_workbooks(normalized)                       # every sheet of every file
    combined_ts, combined_machine, classifications = combine_sheets(sheets)

    # Files/sheets read + per-sheet classification listing (Requirements 18.1, 18.2).
    report.extend(_sheets_report(normalized, sheets, classifications))

    # Require at least one time-study sheet BEFORE cleaning (Requirement 16.1).
    if combined_ts.empty:
        raise ValueError(
            "No time-study sheet found: an uploaded file must contain "
            "Workstation, Operation and Cycle Time columns."
        )

    cleaned, clean_report = clean_time_study(combined_ts)     # unchanged validation
    report.extend(clean_report)

    detection = detect_sequence(cleaned, use_row_order)
    ordered_names, order_notes = order_workstations(cleaned, detection)

    # Feed the "Line" column into explicit line assignment (Requirements 9.1, 9.2, 9.4).
    # Empty ({}, []) when there is no usable Line column, which preserves today's
    # single-chain/unconnected behavior exactly (Req 9.3, 10.7).
    line_by_workstation, line_order = line_names_by_workstation(cleaned)

    layout = build_layout(
        cleaned,
        ordered_names,
        connect=detection.detected,
        line_by_workstation=line_by_workstation,
        line_order=line_order,
    )

    # Merge machine attributes onto built stations, then rebuild the Layout with the
    # merged stations while preserving sources/sinks/connections.
    stations, machine_notes = apply_machine_attributes(layout.stations, combined_machine)
    layout = layout.model_copy(update={"stations": stations})

    # Machine applied-count summary (Requirement 18.3), then machine notes (18.4).
    report.extend(_machine_applied_report(combined_machine, stations))
    report.extend(order_notes)
    report.extend(machine_notes)

    # Sequence outcome + generated-count summary (Requirements 7.x, 9.3, 1.5, 18.5).
    report.extend(_sequence_and_summary_report(detection, layout))

    return TimeStudyImportResult(layout=layout, report=report)
