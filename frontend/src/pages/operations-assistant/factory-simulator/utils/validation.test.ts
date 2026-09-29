import { describe, it, expect } from "vitest";
import { validateFileType } from "./validation";

describe("validateFileType", () => {
  it("accepts .png files", () => {
    expect(validateFileType("layout.png")).toBe(true);
  });

  it("accepts .jpg files", () => {
    expect(validateFileType("photo.jpg")).toBe(true);
  });

  it("accepts .jpeg files", () => {
    expect(validateFileType("image.jpeg")).toBe(true);
  });

  it("accepts .svg files", () => {
    expect(validateFileType("diagram.svg")).toBe(true);
  });

  it("accepts .pdf files", () => {
    expect(validateFileType("plan.pdf")).toBe(true);
  });

  it("accepts extensions case-insensitively", () => {
    expect(validateFileType("file.PNG")).toBe(true);
    expect(validateFileType("file.Jpg")).toBe(true);
    expect(validateFileType("file.JPEG")).toBe(true);
    expect(validateFileType("file.SVG")).toBe(true);
    expect(validateFileType("file.PDF")).toBe(true);
  });

  it("rejects files with no extension", () => {
    expect(validateFileType("noextension")).toBe(false);
  });

  it("rejects unsupported extensions", () => {
    expect(validateFileType("file.gif")).toBe(false);
    expect(validateFileType("file.bmp")).toBe(false);
    expect(validateFileType("file.tiff")).toBe(false);
    expect(validateFileType("file.webp")).toBe(false);
  });

  it("uses the last dot for extension detection", () => {
    expect(validateFileType("archive.tar.gz")).toBe(false);
    expect(validateFileType("file.backup.png")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateFileType("")).toBe(false);
  });
});
