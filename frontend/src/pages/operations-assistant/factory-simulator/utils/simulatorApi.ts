/**
 * Simulation API client for the Factory Floor Simulator.
 */

import { apiRequest } from '../../../../lib/apiClient';
import type {
  Layout,
  LineBalanceProposal,
  SimulationConfig,
  SimulationResult,
  TimeStudyImportResult,
} from '../types';

/**
 * Runs a discrete event simulation on the given layout.
 */
export async function runSimulation(
  layout: Layout,
  config?: Partial<SimulationConfig>
): Promise<SimulationResult> {
  return apiRequest<SimulationResult>('POST', '/operations-assistant/simulator/run', {
    body: {
      layout,
      config: {
        duration_seconds: config?.duration_seconds ?? 3600,
        warmup_seconds: config?.warmup_seconds ?? 300,
        target_throughput: config?.target_throughput ?? null,
      },
    },
  });
}

/**
 * Validates a layout against backend rules.
 */
export async function validateLayout(
  layout: Layout
): Promise<{ valid: boolean; errors: string[] }> {
  return apiRequest<{ valid: boolean; errors: string[] }>(
    'POST',
    '/operations-assistant/simulator/validate',
    { body: { layout } }
  );
}

/**
 * Imports one or more time-study Excel files and returns the auto-generated
 * layout plus the per-import report.
 *
 * Accepts either a single `File` or a `File[]`; the argument is normalized to an
 * array and each file is appended under the repeated `files` field so the
 * endpoint's `list[UploadFile]` receives every file. The optional `useRowOrder`
 * flag is appended as the `use_row_order` form field (matching `Form(False)` on
 * the endpoint), letting the importer opt in to row-order sequence detection
 * when no order column is present.
 *
 * On a 422 the backend returns `{ detail }` with a specific message (missing
 * required column, no readable rows, or no time-study sheet found); the ApiError
 * thrown by `apiRequest` carries that detail in its `body` so callers can
 * surface it and preserve canvas state.
 */
export async function importTimeStudy(
  files: File | File[],
  useRowOrder = false
): Promise<TimeStudyImportResult> {
  const list = Array.isArray(files) ? files : [files];
  const formData = new FormData();
  for (const f of list) {
    // Repeated `files` parts map to the endpoint's list[UploadFile].
    formData.append('files', f);
  }
  formData.append('use_row_order', String(useRowOrder));

  return apiRequest<TimeStudyImportResult>(
    'POST',
    '/operations-assistant/simulator/import-time-study',
    { body: formData }
  );
}

/**
 * Requests a line-balancing proposal for the given layout against a Takt time.
 *
 * POSTs `{ layout, takt_time }` and returns a LineBalanceProposal describing the
 * proposed assignment of Operations to Workstations, each Workstation's
 * Effective_Cycle_Time and percentage of Takt, the overall balance efficiency,
 * and a best-effort flag with an explanatory message when a fully balanced
 * solution could not be found.
 */
export async function balanceLine(
  layout: Layout,
  taktTime: number
): Promise<LineBalanceProposal> {
  return apiRequest<LineBalanceProposal>(
    'POST',
    '/operations-assistant/simulator/balance',
    { body: { layout, takt_time: taktTime } }
  );
}
