import React, { useRef, useState } from "react";
import { useLayout } from "../context/LayoutContext";
import { importTimeStudy } from "../utils/simulatorApi";
import { isApiError } from "../../../../lib/apiClient";
import type { ImportReportEntry } from "../types";
import "./TimeStudyImporter.css";

/** Accepted spreadsheet extensions for a time study file. */
const ACCEPTED_EXTENSIONS = ".xlsx,.xls";

/** Columns for a routing / time-study sheet, shown in the collapsible guide. */
const COLUMN_GUIDE: { column: string; required: boolean; notes: string }[] = [
  { column: "Workstation", required: true, notes: "Name or ID of each workstation on the line." },
  { column: "Operation", required: true, notes: "Name of the individual task or operation." },
  { column: "Cycle Time (s)", required: true, notes: "Time in seconds to complete the operation once." },
  { column: "Order", required: false, notes: "Operation/sequence number (also Op No / Seq / Step No). When present, the line is auto-connected Source → … → Sink in this order." },
  { column: "Min CT (s)", required: false, notes: "Fastest observed time. With Max CT, enables cycle-time variability." },
  { column: "Max CT (s)", required: false, notes: "Slowest observed time. With Min CT, enables cycle-time variability." },
  { column: "Operator", required: false, notes: "Operator ID or name. Sets operators required per operation." },
  { column: "Product", required: false, notes: "Product or part number (optional grouping)." },
  { column: "Line", required: false, notes: "Production line name or ID (optional grouping)." },
];

/** Columns for an optional machine sheet, merged onto matching workstations by name. */
const MACHINE_COLUMN_GUIDE: { column: string; required: boolean; notes: string }[] = [
  { column: "Workstation", required: true, notes: "Must match a workstation name from the routing sheet." },
  { column: "Machines / Parallel Capacity", required: false, notes: "Number of parallel machines (default 1)." },
  { column: "Reliability (%)", required: false, notes: "Uptime percentage 1 to 100 (default 100)." },
  { column: "Scrap Rate (%)", required: false, notes: "Percent scrapped 0 to 99 (default 0)." },
  { column: "Setup Time (s)", required: false, notes: "Changeover time in seconds (default 0)." },
  { column: "Has Machine (Y/N)", required: false, notes: "Whether a machine does the work (default Yes)." },
];

/**
 * Extracts a human-readable error message from a failed import request.
 *
 * The backend returns HTTP 422 with a `{ detail }` body for expected import
 * failures (a missing required column or no readable rows). That detail is
 * carried on the thrown ApiError's `body`; we surface it verbatim so the user
 * sees the specific reason. Network/timeout and unexpected errors fall back to
 * the ApiError message.
 */
function extractErrorMessage(err: unknown): string {
  if (isApiError(err)) {
    const body = err.body;
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail?: unknown }).detail;
      if (typeof detail === "string" && detail.trim().length > 0) {
        return detail;
      }
    }
    return err.message;
  }
  return "Failed to import the time study file. Please check the file and try again.";
}

/**
 * TimeStudyImporter: a styled panel for importing factory data from one or more
 * Excel files (.xlsx / .xls), each with multiple auto-classified sheets: a
 * routing / time-study sheet (auto-generates operations-aware Workstations, and
 * auto-connects the line when an order/sequence column is present) plus an
 * optional machine sheet whose attributes merge onto matching workstations.
 *
 * Presents a themed upload zone (click or drag-and-drop), a collapsible guide
 * describing the expected/optional columns, and clear success and error states.
 * On success it dispatches IMPORT_TIME_STUDY with the returned layout and shows
 * the per-import report. On failure it shows the specific message and preserves
 * the current canvas state (no dispatch).
 */
export function TimeStudyImporter() {
  const { dispatch } = useLayout();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReportEntry[] | null>(null);
  const [importedName, setImportedName] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [useRowOrder, setUseRowOrder] = useState(false);

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  /** Close the floating success overlay and clear its state. */
  function dismissReport() {
    setReport(null);
    setImportedName(null);
    setImportedCount(0);
  }

  /** Close the floating error overlay and clear its state. */
  function dismissError() {
    setError(null);
  }

  async function importFiles(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setIsImporting(true);
    try {
      const result = await importTimeStudy(files, useRowOrder);
      dispatch({ type: "IMPORT_TIME_STUDY", layout: result.layout });
      setReport(result.report);
      setImportedName(files.length === 1 ? files[0].name : null);
      setImportedCount(files.length);
    } catch (err: unknown) {
      // Surface the specific message and preserve canvas state by NOT
      // dispatching any layout action. Clear any stale success report.
      setError(extractErrorMessage(err));
      setReport(null);
      setImportedName(null);
      setImportedCount(0);
    } finally {
      setIsImporting(false);
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files ? Array.from(event.target.files) : [];
    // Reset the input so the same file(s) can be re-selected later.
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    if (files.length > 0) {
      void importFiles(files);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (isImporting) return;
    const files = event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
    if (files.length > 0) {
      void importFiles(files);
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!isImporting) setIsDragging(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
  }

  return (
    <section className="ts-importer" aria-label="Factory data import">
      {/* Single compact bar: the whole strip is the upload zone, with a concise
          inline hint. The file-format guide lives behind a small info button on
          the right so it never adds height. */}
      <div className="ts-importer__bar">
        <div
          className={`ts-importer__dropzone ${isDragging ? "is-dragging" : ""} ${isImporting ? "is-busy" : ""}`}
          role="button"
          tabIndex={0}
          onClick={openFilePicker}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openFilePicker();
            }
          }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          aria-busy={isImporting}
        >
          {isImporting ? (
            <div className="ts-importer__busy">
              <span className="ts-importer__spinner" aria-hidden="true" />
              <span>Importing factory data…</span>
            </div>
          ) : (
            <>
              <span className="ts-importer__dropzone-icon" aria-hidden="true">📄⬆</span>
              <div className="ts-importer__dropzone-text">
                <p className="ts-importer__dropzone-primary">
                  <strong>Import Factory Data</strong>: drag &amp; drop Excel file(s) or <span className="ts-importer__link">browse</span>
                </p>
                <p className="ts-importer__dropzone-secondary">
                  Routing/time-study + optional machine sheet · one or more .xlsx / .xls · an order column auto-connects the line
                </p>
              </div>
            </>
          )}
        </div>

        {/* Row-order opt-in: when a file has no order column, treat the row
            order as the process sequence. Off by default so the importer never
            silently guesses process flow. Kept INLINE in the bar so it never
            adds height below the strip. */}
        <label
          className="ts-importer__row-order"
          title="When a file has no order/sequence column, use the row order in the sheet as the process sequence."
        >
          <input
            type="checkbox"
            className="ts-importer__row-order-checkbox"
            checked={useRowOrder}
            disabled={isImporting}
            onChange={(e) => setUseRowOrder(e.target.checked)}
          />
          <span className="ts-importer__row-order-text">
            Use row order<br />as sequence
          </span>
        </label>

        {/* Info button: opens the file-format guide as a popover */}
        <div className="ts-importer__guide-anchor">
          <button
            type="button"
            className="ts-importer__guide-toggle"
            aria-expanded={guideOpen}
            aria-label="File format guide"
            title="File format guide"
            onClick={() => setGuideOpen((v) => !v)}
          >
            <span aria-hidden="true">💡</span>
            <span className="ts-importer__guide-toggle-label">Format</span>
          </button>

          {guideOpen && (
            <>
              <div
                className="ts-importer__guide-backdrop"
                onClick={() => setGuideOpen(false)}
                aria-hidden="true"
              />
              <div className="ts-importer__guide" role="dialog" aria-label="File format guide">
                <div className="ts-importer__guide-header">
                  <span>File Format Guide</span>
                  <button
                    type="button"
                    className="ts-importer__guide-close"
                    onClick={() => setGuideOpen(false)}
                    aria-label="Close guide"
                  >
                    ✕
                  </button>
                </div>
                <h4 className="ts-importer__guide-subhead">Routing / Time-study sheet</h4>
                <table className="ts-importer__guide-table">
                  <thead>
                    <tr>
                      <th>Column</th>
                      <th>Required</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COLUMN_GUIDE.map((row) => (
                      <tr key={row.column}>
                        <td><code>{row.column}</code></td>
                        <td>
                          {row.required ? (
                            <span className="ts-importer__badge ts-importer__badge--req">Required</span>
                          ) : (
                            <span className="ts-importer__badge ts-importer__badge--opt">Optional</span>
                          )}
                        </td>
                        <td>{row.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h4 className="ts-importer__guide-subhead">Machine sheet (optional)</h4>
                <table className="ts-importer__guide-table">
                  <thead>
                    <tr>
                      <th>Column</th>
                      <th>Required</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {MACHINE_COLUMN_GUIDE.map((row) => (
                      <tr key={row.column}>
                        <td><code>{row.column}</code></td>
                        <td>
                          {row.required ? (
                            <span className="ts-importer__badge ts-importer__badge--req">Required</span>
                          ) : (
                            <span className="ts-importer__badge ts-importer__badge--opt">Optional</span>
                          )}
                        </td>
                        <td>{row.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="ts-importer__guide-note">
                  Put routing and machine data on separate sheets or separate files. Sheet
                  names don’t matter (they’re auto-detected), and lookup/config tabs are
                  ignored. Column-name synonyms are accepted (e.g. “WS”, “Station”, “CT”).
                  Repeated readings of the same operation are averaged, then summed per
                  workstation.
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS}
        multiple
        onChange={handleFileChange}
        className="ts-importer__file-input"
        aria-label="Import factory data Excel files"
      />

      {/* Error: floats below the bar as an absolutely-positioned overlay so it
          never grows the fixed-height strip. A backdrop + ✕ dismiss it. */}
      {error && (
        <>
          <div
            className="ts-importer__overlay-backdrop"
            onClick={dismissError}
            aria-hidden="true"
          />
          <div className="ts-importer__error" role="alert">
            <button
              type="button"
              className="ts-importer__overlay-close"
              onClick={dismissError}
              aria-label="Dismiss error"
            >
              ✕
            </button>
            <span className="ts-importer__error-icon" aria-hidden="true">⚠</span>
            <div>
              <strong>Import failed.</strong>
              <span className="ts-importer__error-detail"> {error}</span>
              <p className="ts-importer__error-note">Your current canvas was left unchanged.</p>
            </div>
          </div>
        </>
      )}

      {/* Success report: same floating-overlay treatment as the error so the
          bar keeps its fixed height after an upload. */}
      {report && report.length > 0 && (
        <>
          <div
            className="ts-importer__overlay-backdrop"
            onClick={dismissReport}
            aria-hidden="true"
          />
          <div className="ts-importer__report" role="status">
            <div className="ts-importer__report-head">
              <span className="ts-importer__report-icon" aria-hidden="true">✓</span>
              <span>
                Imported
                {importedName ? (
                  <> <strong>{importedName}</strong></>
                ) : importedCount > 1 ? (
                  <> <strong>{importedCount} file(s)</strong></>
                ) : null}
              </span>
              <button
                type="button"
                className="ts-importer__overlay-close"
                onClick={dismissReport}
                aria-label="Dismiss import report"
              >
                ✕
              </button>
            </div>
            <ul className="ts-importer__report-list">
              {report.map((entry, index) => (
                <li key={index} className="ts-importer__report-entry">
                  <span className={`ts-importer__report-kind ts-importer__report-kind--${entry.kind.toLowerCase()}`}>
                    {entry.kind}
                  </span>
                  <span className="ts-importer__report-message">{entry.message}</span>
                </li>
              ))}
            </ul>
            <p className="ts-importer__report-note">
              {report.some(
                (entry) =>
                  entry.kind === "Sequence" &&
                  entry.message.toLowerCase().includes("auto-connected")
              )
                ? "Your line is connected end-to-end. Review it and run the simulation."
                : "Add a Source and Sink, then connect them to complete your layout."}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
