import { describe, it, expect } from "vitest";
import { getUtilizationColor, getLineThickness } from "./visualization";

describe("getUtilizationColor", () => {
  it("returns green for utilization at 0%", () => {
    expect(getUtilizationColor(0)).toBe("#28a745");
  });

  it("returns green for utilization at 60%", () => {
    expect(getUtilizationColor(60)).toBe("#28a745");
  });

  it("returns yellow for utilization at 61%", () => {
    expect(getUtilizationColor(61)).toBe("#ffc107");
  });

  it("returns yellow for utilization at 84%", () => {
    expect(getUtilizationColor(84)).toBe("#ffc107");
  });

  it("returns red for utilization at 85% (bottleneck threshold)", () => {
    expect(getUtilizationColor(85)).toBe("#dc3545");
  });

  it("returns red for utilization at 86%", () => {
    expect(getUtilizationColor(86)).toBe("#dc3545");
  });

  it("returns red for utilization at 100%", () => {
    expect(getUtilizationColor(100)).toBe("#dc3545");
  });
});

describe("getLineThickness", () => {
  it("returns minimum thickness (2) for queue length of 0", () => {
    expect(getLineThickness(0)).toBe(2);
  });

  it("returns minimum thickness for negative queue length", () => {
    expect(getLineThickness(-1)).toBe(2);
  });

  it("returns maximum thickness (12) for queue length of 10 or above", () => {
    expect(getLineThickness(10)).toBe(12);
    expect(getLineThickness(20)).toBe(12);
  });

  it("returns an intermediate value for queue length of 5", () => {
    const thickness = getLineThickness(5);
    expect(thickness).toBeGreaterThan(2);
    expect(thickness).toBeLessThan(12);
  });

  it("is monotonically non-decreasing", () => {
    let prev = getLineThickness(0);
    for (let q = 1; q <= 20; q++) {
      const current = getLineThickness(q);
      expect(current).toBeGreaterThanOrEqual(prev);
      prev = current;
    }
  });
});
