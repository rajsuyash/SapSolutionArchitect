import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const prompt = (name: string) => readFileSync(new URL(`../prompts/${name}.system.md`, import.meta.url), "utf8");

describe("every document or posting a step relies on has a producing step", () => {
  it("outline prompt: a consumed document or posting must be produced by an earlier or the same step, or come from an external party", () => {
    const text = prompt("to_be_outline");
    expect(text).toContain("Every document, posting or status");
    expect(text).toContain("goods issue");
    expect(text).toContain("billing document");
  });
  it("step prompt: a step that dispatches, bills, receives or posts carries the posting in its actions and the entry in its effects", () => {
    expect(prompt("to_be_step")).toContain("dispatches, bills, receives or posts");
  });
  it("review prompt: a document nobody creates is a COVERAGE_GAP, not a CONTRADICTION", () => {
    const text = prompt("to_be_review");
    expect(text).toContain("no step's action creates or posts");
    expect(text).toContain("leave paths empty");
    expect(text).toContain("not a CONTRADICTION");
  });
});
