import { beforeAll, describe, expect, it } from "vitest";

interface CalculatorTemplateApi {
  createCalculatorProposal(workspaceId: string): {
    readonly workspaceId: string;
    readonly operations: readonly { readonly op: string; readonly path: string; readonly text: string }[];
  };
}

let calculator: CalculatorTemplateApi;

beforeAll(async () => {
  await import("../../src/gui/static/calculator-template.js");
  calculator = (globalThis as unknown as { GuiCalculatorTemplate: CalculatorTemplateApi }).GuiCalculatorTemplate;
});

describe("calculator workspace template", () => {
  it("proposes one self-contained, interactive calculator app", () => {
    const proposal = calculator.createCalculatorProposal("workspace-1");

    expect(proposal.workspaceId).toBe("workspace-1");
    expect(proposal.operations).toHaveLength(1);
    expect(proposal.operations[0]).toMatchObject({ op: "create", path: "index.html" });
    expect(proposal.operations[0]?.text).toContain('aria-label="Calculator"');
    expect(proposal.operations[0]?.text).toContain('data-action="evaluate"');
  });
});