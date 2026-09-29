"""Layout serialization and deserialization for the Factory Floor Simulator.

Handles conversion between Layout objects and JSON strings, with schema
versioning for forward-compatible migrations.
"""

import json
from pydantic import ValidationError
from .models import Layout

# The current layout schema version emitted by the serializer.
CURRENT_SCHEMA_VERSION = 3

# Schema versions this parser can read. Version 2 layouts lack the per-station
# `operations` field; Pydantic defaults it to an empty list, which yields the
# flat cycle_time / operators_required fallback.
SUPPORTED_SCHEMA_VERSIONS = frozenset({2, 3})


def serialize_layout(layout: Layout) -> str:
    """Serialize a Layout Pydantic model to a JSON string.

    Emits schema_version 3 (the model default). The `operations` field on each
    station is included automatically by Pydantic's model_dump_json.
    """
    return layout.model_dump_json()


def parse_layout(json_str: str) -> Layout:
    """Parse a JSON string into a Layout model.

    Tolerates schema version 2 layouts (stations without an `operations` field,
    which defaults to an empty list and uses the flat cycle_time fallback) as
    well as version 3. Rejects unknown/incompatible schema versions with a
    descriptive ValueError. Raises ValueError with a descriptive message on any
    invalid input.
    """
    try:
        data = json.loads(json_str)
    except (json.JSONDecodeError, TypeError) as e:
        raise ValueError(f"Invalid JSON syntax: {e}")

    if not isinstance(data, dict):
        raise ValueError("Invalid layout: expected a JSON object at the top level")

    # Reject unknown/incompatible schema versions before Pydantic parsing so the
    # error clearly identifies the version mismatch rather than a field error.
    if "schema_version" in data:
        raw_version = data["schema_version"]
        if not isinstance(raw_version, int) or isinstance(raw_version, bool):
            raise ValueError(
                f"Invalid layout: 'schema_version' must be an integer, "
                f"got {raw_version!r}"
            )
        if raw_version not in SUPPORTED_SCHEMA_VERSIONS:
            supported = ", ".join(str(v) for v in sorted(SUPPORTED_SCHEMA_VERSIONS))
            raise ValueError(
                f"Invalid layout: unsupported schema_version {raw_version}. "
                f"Supported versions are {supported}."
            )

    # Parse with Pydantic
    try:
        layout = Layout.model_validate(data)
    except ValidationError as e:
        first_error = e.errors()[0]
        loc = " -> ".join(str(part) for part in first_error["loc"])
        msg = first_error["msg"]
        raise ValueError(f"Invalid layout at '{loc}': {msg}")

    # Validate referential integrity of connections
    all_ids = set()
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

    for connection in layout.connections:
        if connection.source_id not in all_ids:
            raise ValueError(
                f"Invalid layout: connection '{connection.id}' references "
                f"non-existent source element '{connection.source_id}'"
            )
        if connection.target_id not in all_ids:
            raise ValueError(
                f"Invalid layout: connection '{connection.id}' references "
                f"non-existent target element '{connection.target_id}'"
            )

    return layout
