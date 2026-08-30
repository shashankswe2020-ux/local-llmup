import { describe, expect, it } from "vitest";
import { RunConflictError, RunCoordinator, type Run } from "../../src/gui/run.js";

describe("RunCoordinator", () => {
  it("begins a run with a unique id and an unaborted signal", () => {
    const runs = new RunCoordinator();
    const a = runs.begin();
    expect(a.phase).toBe("active");
    expect(a.controller.signal.aborted).toBe(false);
    expect(runs.active).toBe(a);
  });

  it("rejects a second concurrent run with a typed conflict", () => {
    const runs = new RunCoordinator();
    runs.begin();
    expect(() => runs.begin()).toThrow(RunConflictError);
    try {
      runs.begin();
    } catch (error) {
      expect((error as RunConflictError).code).toBe("RUN_CONFLICT");
    }
  });

  it("allows a new run after the previous one settles", () => {
    const runs = new RunCoordinator();
    const a = runs.begin();
    expect(runs.settle(a, "completed")).toBe(true);
    expect(runs.active).toBeNull();
    const b = runs.begin();
    expect(b.id).not.toBe(a.id);
  });

  it("cancels the active run and aborts its signal", () => {
    const runs = new RunCoordinator();
    const a = runs.begin();
    expect(runs.cancel()).toBe(true);
    expect(a.phase).toBe("cancelled");
    expect(a.controller.signal.aborted).toBe(true);
    expect(runs.active).toBeNull();
  });

  it("guards late completion: a cancelled run cannot settle to completed", () => {
    const runs = new RunCoordinator();
    const a = runs.begin();
    runs.cancel();
    expect(runs.settle(a, "completed")).toBe(false);
    expect(a.phase).toBe("cancelled");
    expect(runs.isActive(a)).toBe(false);
  });

  it("cancel is idempotent and a no-op after settle", () => {
    const runs = new RunCoordinator();
    const a = runs.begin();
    runs.settle(a, "completed");
    expect(runs.cancel()).toBe(false);
    expect(runs.cancel(a.id)).toBe(false);
  });

  it("cancel(id) only cancels the matching run", () => {
    const runs = new RunCoordinator();
    const a: Run = runs.begin();
    expect(runs.cancel("run_other")).toBe(false);
    expect(a.phase).toBe("active");
    expect(runs.cancel(a.id)).toBe(true);
  });

  it("allows a new run after cancellation", () => {
    const runs = new RunCoordinator();
    runs.begin();
    runs.cancel();
    const b = runs.begin();
    expect(b.phase).toBe("active");
  });
});
