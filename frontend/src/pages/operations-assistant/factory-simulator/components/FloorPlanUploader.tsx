import React, { useRef, useState } from "react";
import { useLayout } from "../context/LayoutContext";
import { validateFileType } from "../utils/validation";
import "./FloorPlanUploader.css";

/** Maximum allowed file size in bytes (10 MB). */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * FloorPlanUploader component provides a file input and drag-and-drop zone
 * for uploading floor plan background images, plus a button to remove them.
 *
 * Validates file type (.png, .jpg, .jpeg, .svg, .pdf) and file size (≤ 10 MB).
 * On valid upload, reads the file as a data URL and dispatches SET_FLOOR_PLAN.
 * Shows "Remove Background" button only when a floor plan is loaded.
 */
export function FloorPlanUploader() {
  const { layout, dispatch } = useLayout();
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Process a file (from input or drop). */
  function processFile(file: File) {
    setError(null);

    // Validate file type
    if (!validateFileType(file.name)) {
      setError("Invalid file type. Accepted formats: PNG, JPG, JPEG, SVG, PDF.");
      return;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setError("File exceeds maximum size of 10 MB.");
      return;
    }

    // Read valid file as data URL
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      dispatch({
        type: "SET_FLOOR_PLAN",
        floorPlan: { filename: file.name, data_url: dataUrl },
      });
    };
    reader.readAsDataURL(file);
  }

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    processFile(file);
    // Reset input so the same file can be re-selected
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);

    const file = event.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const handleRemove = () => {
    setError(null);
    dispatch({ type: "REMOVE_FLOOR_PLAN" });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleClickZone = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="floor-plan-uploader">
      <label>Floor Plan</label>

      {/* Drag-and-drop zone */}
      <div
        className={`floor-plan-dropzone ${isDragging ? "floor-plan-dropzone--active" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClickZone}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClickZone();
          }
        }}
        aria-label="Upload floor plan - click or drag and drop a file"
      >
        <p className="floor-plan-dropzone__text">
          {isDragging
            ? "Drop file here"
            : "Drag & drop or click to upload"}
        </p>
        <p className="floor-plan-dropzone__formats">
          PNG, JPG, SVG, PDF (max 10 MB)
        </p>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.svg,.pdf"
        onChange={handleFileChange}
        style={{ display: "none" }}
        aria-hidden="true"
      />

      {error && (
        <p className="floor-plan-error" role="alert">
          {error}
        </p>
      )}

      {layout.floor_plan && (
        <div className="floor-plan-loaded">
          <span className="floor-plan-loaded__name">{layout.floor_plan.filename}</span>
          <button type="button" onClick={handleRemove} className="floor-plan-remove-btn">
            Remove Background
          </button>
        </div>
      )}
    </div>
  );
}
