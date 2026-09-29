/**
 * Layout serializer and parser for the Factory Floor Simulator.
 * Handles save/load of layout JSON files.
 */

import type { Layout, Operation, Station } from '../types';

/** The current layout schema version emitted by the serializer. */
export const CURRENT_SCHEMA_VERSION = 3;

/**
 * Schema versions this parser can read. Version 2 layouts lack the per-station
 * `operations` field; parsing defaults it to an empty array, which yields the
 * flat cycle_time / operators_required fallback. Version 3 includes operations.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [2, 3];

/**
 * Serializes a Layout object to a JSON string.
 *
 * Emits schema_version 3 and includes the `operations` array on each station
 * (defaulting to an empty array when a station has no operations).
 */
export function serializeLayout(layout: Layout): string {
  const out: Layout = {
    ...layout,
    schema_version: CURRENT_SCHEMA_VERSION,
    stations: layout.stations.map((s) => ({
      ...s,
      operations: Array.isArray(s.operations) ? s.operations : [],
    })),
  };
  return JSON.stringify(out, null, 2);
}

/**
 * Parses a JSON string and validates it as a Layout.
 *
 * Tolerates schema version 2 input (stations without an `operations` field
 * default to an empty array, yielding the flat cycle_time fallback) and accepts
 * version 2 or 3. Unknown/incompatible versions are rejected with a descriptive
 * error. When present, operation fields are validated (name length 1-50,
 * cycle_time positive, operators_required a number >= 0) and the first violation
 * is reported.
 *
 * The existing referential-integrity validation is preserved: every
 * connection must reference existing element ids and may not form a self-loop.
 * The first violation encountered is reported as a descriptive error.
 *
 * Returns the parsed Layout on success, or an error object.
 */
export function parseLayout(json: string): Layout | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: 'Invalid JSON syntax' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Layout must be a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;

  // Validate schema_version presence and type.
  if (!('schema_version' in obj) || typeof obj.schema_version !== 'number' || !Number.isInteger(obj.schema_version)) {
    return { error: 'Missing or invalid schema_version' };
  }

  const version = obj.schema_version as number;
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    const supported = SUPPORTED_SCHEMA_VERSIONS.join(', ');
    return {
      error: `Unsupported schema_version ${version}. Supported versions are ${supported}.`,
    };
  }

  const rawStations = Array.isArray(obj.stations) ? (obj.stations as unknown[]) : [];

  // Normalize stations and validate operation fields when present.
  const stations: Station[] = [];
  for (const rawStation of rawStations) {
    const station = rawStation as Record<string, unknown>;
    const stationName = typeof station.name === 'string' ? station.name : (station.id as string) ?? 'unknown';

    let operations: Operation[] = [];
    if ('operations' in station && station.operations !== undefined && station.operations !== null) {
      if (!Array.isArray(station.operations)) {
        return { error: `Station '${stationName}': 'operations' must be an array` };
      }

      const validated = validateOperations(station.operations as unknown[], stationName);
      if ('error' in validated) {
        return validated;
      }
      operations = validated.operations;
    }

    stations.push({ ...(station as unknown as Station), operations });
  }

  const layout: Layout = {
    schema_version: version,
    sources: Array.isArray(obj.sources) ? (obj.sources as Layout['sources']) : [],
    stations,
    buffers: Array.isArray(obj.buffers) ? (obj.buffers as Layout['buffers']) : [],
    sinks: Array.isArray(obj.sinks) ? (obj.sinks as Layout['sinks']) : [],
    operator_pools: Array.isArray(obj.operator_pools) ? (obj.operator_pools as Layout['operator_pools']) : [],
    connections: Array.isArray(obj.connections) ? (obj.connections as Layout['connections']) : [],
    floor_plan: obj.floor_plan as Layout['floor_plan'],
  };

  // Preserve referential-integrity validation: connection endpoints must
  // reference existing element ids and may not form self-loops. Report the
  // first violation with a descriptive error.
  const integrityError = validateConnectionIntegrity(layout);
  if (integrityError) {
    return { error: integrityError };
  }

  return layout;
}

/**
 * Validates that every connection references existing element ids and does not
 * form a self-loop. Returns a descriptive message for the first violation, or
 * undefined when all connections are valid.
 */
function validateConnectionIntegrity(layout: Layout): string | undefined {
  const allIds = new Set<string>();
  for (const s of layout.sources) allIds.add(s.id);
  for (const s of layout.stations) allIds.add(s.id);
  for (const b of layout.buffers) allIds.add(b.id);
  for (const s of layout.sinks) allIds.add(s.id);
  for (const p of layout.operator_pools) allIds.add(p.id);

  for (const connection of layout.connections) {
    if (connection.source_id === connection.target_id) {
      return `Connection '${connection.id}' is a self-connection: source and target are the same element`;
    }
    if (!allIds.has(connection.source_id)) {
      return `Connection '${connection.id}' references non-existent station '${connection.source_id}'`;
    }
    if (!allIds.has(connection.target_id)) {
      return `Connection '${connection.id}' references non-existent station '${connection.target_id}'`;
    }
  }

  return undefined;
}

/**
 * Validates an array of raw operation objects, returning the normalized
 * operations or the first violation as an error. Reports the first violation
 * with a descriptive message.
 */
function validateOperations(
  rawOperations: unknown[],
  stationName: string,
): { operations: Operation[] } | { error: string } {
  const operations: Operation[] = [];

  for (let i = 0; i < rawOperations.length; i++) {
    const op = rawOperations[i] as Record<string, unknown>;
    const label = `Station '${stationName}' operation ${i + 1}`;

    if (typeof op !== 'object' || op === null || Array.isArray(op)) {
      return { error: `${label}: must be an object` };
    }

    // name: length 1-50
    if (typeof op.name !== 'string' || op.name.length < 1 || op.name.length > 50) {
      return { error: `${label}: name must be between 1 and 50 characters` };
    }

    // cycle_time: positive number
    if (typeof op.cycle_time !== 'number' || !Number.isFinite(op.cycle_time) || op.cycle_time <= 0) {
      return { error: `${label}: cycle_time must be a positive number` };
    }

    // operators_required: number >= 0
    if (typeof op.operators_required !== 'number' || !Number.isFinite(op.operators_required) || op.operators_required < 0) {
      return { error: `${label}: operators_required must be a number >= 0` };
    }

    operations.push({
      name: op.name,
      cycle_time: op.cycle_time,
      min_ct: typeof op.min_ct === 'number' ? op.min_ct : undefined,
      max_ct: typeof op.max_ct === 'number' ? op.max_ct : undefined,
      operators_required: op.operators_required,
    });
  }

  return { operations };
}
