import { describe, it, expect } from "vitest";
import { deltaColor } from "./ComparisonView";

const GREEN = "#28a745";
const RED = "#dc3545";
const NEUTRAL = "#212529";

describe("deltaColor", () => {
  describe("standard metrics (throughput, utilization)", () => {
    it("returns green for a positive delta (improvement, Req 8.3)", () => {
      expect(deltaColor(5)).toBe(GREEN);
    });

    it("returns red for a negative delta (degradation, Req 8.3)", () => {
      expect(deltaColor(-3)).toBe(RED);
    });

    it("returns neutral for a zero delta (Req 8.5)", () => {
      expect(deltaColor(0)).toBe(NEUTRAL);
    });
  });

  describe("inverted metric (queue length, Req 8.6)", () => {
    it("returns green for a decrease (shorter queue is better)", () => {
      expect(deltaColor(-2, true)).toBe(GREEN);
    });

    it("returns red for an increase (longer queue is worse)", () => {
      expect(deltaColor(4, true)).toBe(RED);
    });

    it("returns neutral for a zero delta (Req 8.5)", () => {
      expect(deltaColor(0, true)).toBe(NEUTRAL);
    });
  });
});
