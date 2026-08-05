import { describe, expect, it } from "vitest";
import { COMFORT_FLOOR, SCORE_WEIGHTS } from "../../src/advisor/weights.js";
import { BOTTLENECKS } from "../../src/types.js";

describe("advisor score weights", () => {
  it("the four sub-weights sum to 1", () => {
    const sum = BOTTLENECKS.reduce((acc, axis) => acc + SCORE_WEIGHTS[axis], 0);
    expect(sum).toBeGreaterThan(0.999);
    expect(sum).toBeLessThan(1.001);
  });

  it("assigns a positive weight to every bottleneck axis", () => {
    for (const axis of BOTTLENECKS) {
      expect(SCORE_WEIGHTS[axis]).toBeGreaterThan(0);
    }
  });
});

describe("comfort floor", () => {
  it("is a positive tokens/sec threshold", () => {
    expect(COMFORT_FLOOR).toBeGreaterThan(0);
    expect(Number.isFinite(COMFORT_FLOOR)).toBe(true);
  });
});
