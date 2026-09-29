import { describe, it, expect } from 'vitest';
import { serializeLayout, parseLayout, CURRENT_SCHEMA_VERSION } from './layoutSerializer';
import type { Layout, Station, Connection } from '../types';

/** Build a valid Station literal for the current (schema v3) model. */
function makeStation(overrides: Partial<Station> = {}): Station {
  return {
    id: 's1',
    name: 'Station A',
    element_type: 'station',
    x: 100,
    y: 200,
    cycle_time: 10,
    num_machines: 1,
    operators_required: 1,
    reliability: 100,
    scrap_rate: 0,
    setup_time: 0,
    variability: 0.1,
    operations: [],
    ...overrides,
  };
}

/** Build a valid Connection literal for the current model. */
function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'c1',
    source_id: 's1',
    target_id: 's2',
    transport_time: 0,
    transport_mode: 'none',
    distance: 0,
    ...overrides,
  };
}

describe('layoutSerializer', () => {
  const validLayout: Layout = {
    schema_version: CURRENT_SCHEMA_VERSION,
    sources: [],
    stations: [
      makeStation({ id: 's1', name: 'Station A', x: 100, y: 200, cycle_time: 10 }),
      makeStation({ id: 's2', name: 'Station B', x: 300, y: 400, cycle_time: 5 }),
    ],
    buffers: [],
    sinks: [],
    operator_pools: [],
    connections: [makeConnection({ id: 'c1', source_id: 's1', target_id: 's2' })],
  };

  describe('serializeLayout', () => {
    it('produces valid JSON with the current schema_version', () => {
      const json = serializeLayout(validLayout);
      const parsed = JSON.parse(json);
      expect(parsed.schema_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(parsed.stations).toHaveLength(2);
      expect(parsed.connections).toHaveLength(1);
    });

    it('emits an operations array on every station', () => {
      const json = serializeLayout(validLayout);
      const parsed = JSON.parse(json);
      for (const s of parsed.stations) {
        expect(Array.isArray(s.operations)).toBe(true);
      }
    });

    it('includes floor_plan when present', () => {
      const layoutWithFloorPlan: Layout = {
        ...validLayout,
        floor_plan: { filename: 'plan.png', data_url: 'data:image/png;base64,abc' },
      };
      const json = serializeLayout(layoutWithFloorPlan);
      const parsed = JSON.parse(json);
      expect(parsed.floor_plan.filename).toBe('plan.png');
      expect(parsed.floor_plan.data_url).toBe('data:image/png;base64,abc');
    });

    it('omits floor_plan when not present', () => {
      const json = serializeLayout(validLayout);
      const parsed = JSON.parse(json);
      expect(parsed.floor_plan).toBeUndefined();
    });
  });

  describe('parseLayout', () => {
    it('parses valid layout JSON', () => {
      const json = serializeLayout(validLayout);
      const result = parseLayout(json);
      expect(result).not.toHaveProperty('error');
      const layout = result as Layout;
      expect(layout.schema_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(layout.stations).toHaveLength(2);
      expect(layout.connections).toHaveLength(1);
    });

    it('round-trips a layout correctly', () => {
      const json = serializeLayout(validLayout);
      const result = parseLayout(json);
      expect(result).toEqual(validLayout);
    });

    it('returns error for invalid JSON', () => {
      const result = parseLayout('not valid json');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Invalid JSON syntax');
    });

    it('returns error for missing schema_version', () => {
      const result = parseLayout(JSON.stringify({ stations: [], connections: [] }));
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('schema_version');
    });

    it('rejects an unsupported schema_version', () => {
      const result = parseLayout(
        JSON.stringify({ schema_version: 1, stations: [], connections: [] })
      );
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Unsupported schema_version');
    });

    it('returns error for an operation with a too-long name', () => {
      const json = JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        stations: [
          makeStation({
            id: 's1',
            operations: [
              { name: 'A'.repeat(51), cycle_time: 5, operators_required: 1 },
            ],
          }),
        ],
        connections: [],
      });
      const result = parseLayout(json);
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('name');
    });

    it('returns error for an operation with a non-positive cycle_time', () => {
      const json = JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        stations: [
          makeStation({
            id: 's1',
            operations: [{ name: 'Op', cycle_time: -1, operators_required: 1 }],
          }),
        ],
        connections: [],
      });
      const result = parseLayout(json);
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('cycle_time');
    });

    it('returns error for self-connection', () => {
      const json = JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        stations: [makeStation({ id: 's1' })],
        connections: [makeConnection({ id: 'c1', source_id: 's1', target_id: 's1' })],
      });
      const result = parseLayout(json);
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('self-connection');
    });

    it('returns error for connection referencing non-existent element', () => {
      const json = JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        stations: [makeStation({ id: 's1' })],
        connections: [makeConnection({ id: 'c1', source_id: 's1', target_id: 's999' })],
      });
      const result = parseLayout(json);
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('non-existent');
    });

    it('accepts valid layout with floor_plan', () => {
      const layoutWithFp: Layout = {
        ...validLayout,
        floor_plan: { filename: 'plan.png' },
      };
      const json = serializeLayout(layoutWithFp);
      const result = parseLayout(json);
      expect(result).not.toHaveProperty('error');
      expect((result as Layout).floor_plan?.filename).toBe('plan.png');
    });
  });
});
