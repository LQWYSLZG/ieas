/**
 * Validation utilities for the Factory Floor Simulator.
 */

/** Accepted file extensions for floor plan uploads (case-insensitive). */
const ACCEPTED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".svg", ".pdf"];

/**
 * Validates that a filename has an accepted image extension.
 * Accepted extensions: .png, .jpg, .jpeg, .svg, .pdf (case-insensitive).
 *
 * @param filename - The filename string to validate.
 * @returns true if the file extension is accepted, false otherwise.
 */
export function validateFileType(filename: string): boolean {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) {
    return false;
  }
  const extension = filename.slice(dotIndex).toLowerCase();
  return ACCEPTED_EXTENSIONS.includes(extension);
}
