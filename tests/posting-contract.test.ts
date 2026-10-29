import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OutlineSchema, registerRequest, reviewRequest, stepRequest } from "../src/lib/ai/to-be-pipeline";
import { loadExpert } from "./support/expert-control";

const step = (id: string, postingSummary: string) => ({ id, sequence: 1, title: id, purpose: "p", postingSummary, asIsStepIds: [], requirementIds: [],
  implementation: { kind: "STANDARD" as const, referenceIds: [] } });

describe("posting contract reaches every downstream request", async () => {
  const { input } = await loadExpert("pump-o2c");
  const outline = OutlineSchema.parse({ schemaVersion: 1, processName: "P", processFacts: ["Returns are weighed at the gate.", "Payable is created at invoice (JOB-4)."],
    steps: [step("S-1", "no posting"), step("S-2", "posts goods issue at dispatch")], eliminatedAsIsSteps: [], coverage: [], conflictDecisions: [], openQuestions: [] });
  const chain = [{ id: "S-1", postingSummary: "no posting" }, { id: "S-2", postingSummary: "posts goods issue at dispatch" }];

  it("step request carries the facts, every step's summary once, and the step's own", () => {
    const request = stepRequest(input, [], outline, outline.steps[1]!, []);
    expect(request.outline.processFacts).toEqual(outline.processFacts);
    expect(request.outline.postingChain).toEqual(chain);
    expect(request.step.postingSummary).toBe("posts goods issue at dispatch");
    expect(request.outline.steps.some(s => "postingSummary" in s)).toBe(false);
  });
  it("register request carries the facts and the posting chain", () => {
    const request = registerRequest(input, [], outline, "decisions" as never, []);
    expect(request.outline.processFacts).toEqual(outline.processFacts);
    expect(request.outline.postingChain).toEqual(chain);
  });
  it("review request carries the contract when given an outline and omits it otherwise", () => {
    const design = { processName: "P", steps: [], eliminatedAsIsSteps: [], coverage: [], conflictDecisions: [], openQuestions: [] } as never;
    expect(reviewRequest(input, design, outline)).toMatchObject({ processContract: { processFacts: outline.processFacts, postingChain: chain } });
    expect(reviewRequest(input, design)).not.toHaveProperty("processContract");
  });
  it("an outline without the contract sends none", () => {
    const old = OutlineSchema.parse({ schemaVersion: 1, processName: "P", steps: [{ ...step("S-1", ""), postingSummary: undefined }], eliminatedAsIsSteps: [], coverage: [], conflictDecisions: [], openQuestions: [] });
    expect(registerRequest(input, [], old, "decisions" as never, []).outline).not.toHaveProperty("postingChain");
  });
  it("the prompts state the contract", () => {
    const read = (name: string) => readFileSync(`prompts/${name}.system.md`, "utf8");
    expect(read("to_be_outline")).toMatch(/postingSummary[\s\S]*processFacts/);
    expect(read("to_be_step")).toMatch(/postingChain/);
    expect(read("to_be_registers")).toMatch(/postingChain/);
    expect(read("to_be_review")).toMatch(/processContract[\s\S]*CONTRADICTION/);
  });
});
