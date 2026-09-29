import React, { useRef, useState } from "react";
import { useLayout } from "../context/LayoutContext";
import { serializeLayout, parseLayout } from "../utils/layoutSerializer";

/**
 * SaveLoadLayout provides save (export) and load (import) actions for the factory layout.
 * - Save: serializes the current layout to JSON and triggers a file download.
 * - Load: accepts a .json file, parses it, validates, and dispatches LOAD_LAYOUT on success.
 */
export function SaveLoadLayout() {
  const { layout, dispatch } = useLayout();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  /** Serialize the current layout and trigger a JSON file download. */
  function handleSave() {
    const json = serializeLayout(layout);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const timestamp = Date.now();
    const link = document.createElement("a");
    link.href = url;
    link.download = `factory-layout-${timestamp}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  }

  /** Open the hidden file input to let the user select a JSON file. */
  function handleLoadClick() {
    setError(null);
    fileInputRef.current?.click();
  }

  /** Read and parse the selected file, dispatching LOAD_LAYOUT if valid. */
  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const result = parseLayout(text);

        if ("error" in result) {
          // Schema/validation failure: surface the message, preserve the canvas
          // (no LOAD_LAYOUT dispatch).
          setError(result.error);
        } else {
          setError(null);
          dispatch({ type: "LOAD_LAYOUT", layout: result });
        }
      } catch {
        // Technical failure unrelated to schema validation (e.g. unexpected
        // exception while reading result or parsing): show a generic error and
        // preserve the current canvas by not dispatching LOAD_LAYOUT.
        setError("Failed to load the layout due to a technical error. The current canvas was preserved.");
      } finally {
        // Clear the file input so the same file can be re-selected if needed
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    };

    reader.onerror = () => {
      // Read error (file corruption, memory/IO failure): show a generic
      // technical error and preserve the canvas (no LOAD_LAYOUT dispatch).
      setError("Failed to read the file. The current canvas was preserved.");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    };

    try {
      reader.readAsText(file);
    } catch {
      // readAsText itself can throw for certain unreadable inputs; treat as a
      // technical failure and preserve the canvas.
      setError("Failed to read the file. The current canvas was preserved.");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  return (
    <div className="save-load-layout">
      <button type="button" onClick={handleSave}>
        Save Layout
      </button>
      <button type="button" onClick={handleLoadClick}>
        Load Layout
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: "none" }}
        onChange={handleFileChange}
        aria-label="Load layout file"
      />
      {error && (
        <p className="save-load-layout__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
