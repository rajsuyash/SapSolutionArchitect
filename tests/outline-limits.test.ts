import { describe, expect, it } from "vitest";
import { OUTLINE_PURPOSE_MAX_CHARS, OUTLINE_RATIONALE_MAX_CHARS, OUTLINE_REASON_MAX_CHARS, OutlineSchema } from "../src/lib/ai/to-be-pipeline";

const valid = () => ({
  schemaVersion: 1 as const, processName: "P",
  steps: [{ id: "S1", sequence: 1, title: "T", purpose: "Issue blanks.", asIsStepIds: ["A1"], requirementIds: ["R1"], implementation: { kind: "STANDARD" as const, referenceIds: [] } }],
  eliminatedAsIsSteps: [{ asIsStepId: "A2", reason: "Merged into S1." }],
  coverage: [{ requirementId: "R1", disposition: "IMPLEMENTED" as const, stepIds: ["S1"], decisionId: null, rationale: "Covered by S1." }],
  conflictDecisions: [], openQuestions: [],
});

describe("OutlineSchema free-text limits", () => {
  it("accepts an outline within the limits", () => {
    expect(OutlineSchema.safeParse(valid()).success).toBe(true);
  });
  it.each([
    ["step purpose", (o: ReturnType<typeof valid>, s: string) => { o.steps[0]!.purpose = s; }, OUTLINE_PURPOSE_MAX_CHARS],
    ["coverage rationale", (o: ReturnType<typeof valid>, s: string) => { o.coverage[0]!.rationale = s; }, OUTLINE_RATIONALE_MAX_CHARS],
    ["eliminated step reason", (o: ReturnType<typeof valid>, s: string) => { o.eliminatedAsIsSteps[0]!.reason = s; }, OUTLINE_REASON_MAX_CHARS],
  ])("rejects an over-long %s and accepts one at the limit", (_name, set, max) => {
    const atLimit = valid(); set(atLimit, "x".repeat(max));
    expect(OutlineSchema.safeParse(atLimit).success).toBe(true);
    const over = valid(); set(over, "x".repeat(max + 1));
    expect(OutlineSchema.safeParse(over).success).toBe(false);
  });
});
