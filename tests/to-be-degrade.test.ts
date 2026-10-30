import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";
import type { RegisterGroup } from "../src/lib/ai/design-registers";
import { parseStoredToBe } from "../src/lib/consultant-report";
import { repairOutlineShape } from "../src/lib/ai/outline-repair";
import { STRUCTURAL_ERROR_CODES, demoteErrors, validateToBeOutput } from "../src/lib/ai/to-be";
import { MAX_REEXPANSION_ROUNDS, OUTLINE_ROUND_MIN_REMAINING, REEXPANSION_MIN_REMAINING, reexpansionAllowed, runDesign, type DesignDeps } from "../src/lib/ai/to-be-pipeline";
import { fixture } from "./support/to-be-input";
import { splitDesign } from "./support/to-be-split";

const split = splitDesign(rentalDraft);
const withTbd = (stepId: string) => ({ ...split.details[stepId]!, addedValue: "Returned assets are recorded per item [TBD]." });

describe("error classification", () => {
  it("lists only input-corruption, unparseable and leaked-markup codes as structural", () => {
    expect([...STRUCTURAL_ERROR_CODES].sort()).toEqual(["DUPLICATE_INPUT_ID", "INVALID_APPROVED_DECISION", "INVALID_DRAFT", "INVALID_INPUT", "SOURCE_QUOTE_INVALID", "TOOL_MARKUP_LEAKED", "UNKNOWN_SOURCE"]);
  });
  it("demoteErrors keeps code, path and detail, bounds them and caps the list", () => {
    const out = demoteErrors([{ code: "X", path: "p".repeat(300), detail: "d".repeat(900) }, { code: "Y", path: "q" }]);
    expect(out[0]!.path).toHaveLength(200);
    expect(out[0]!.detail).toHaveLength(500);
    expect(out[1]).toEqual({ code: "Y", path: "q" });
    expect(demoteErrors(Array.from({ length: 1500 }, () => ({ code: "X", path: "p" })))).toHaveLength(1000);
  });
});

describe("validateToBeOutput degrade", () => {
  const broken = () => { const design = structuredClone(rentalDraft); design.steps[0]!.addedValue = "Returned assets are recorded per item [TBD]."; return design; };
  it("fails a content error by default and returns it as a blocker with degrade", () => {
    expect(validateToBeOutput(fixture(), broken(), [])).toMatchObject({ success: false });
    const degraded = validateToBeOutput(fixture(), broken(), [], [], { degrade: true });
    expect(degraded.success).toBe(true);
    if (!degraded.success) return;
    expect(degraded.data.evaluation.blockers).toContainEqual(expect.objectContaining({ code: "PLACEHOLDER_TEXT", path: "draft.steps.0" }));
    expect(degraded.data.evaluation.reviewStatus).toBe("BLOCKED");
    expect(() => parseStoredToBe({ design: degraded.data.design, evaluation: degraded.data.evaluation, unresolvedInputQuestions: [], sourceRevision: 1, snapshotId: "s" })).not.toThrow();
  });
  it("is the identity on a clean design", () => {
    const strict = validateToBeOutput(fixture(), rentalDraft, []), lenient = validateToBeOutput(fixture(), rentalDraft, [], [], { degrade: true });
    expect(lenient).toEqual(strict);
  });
  it("still fails a draft that does not parse, with the structural errors", () => {
    const result = validateToBeOutput(fixture(), { ...rentalDraft, steps: [] }, [], [], { degrade: true });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.some(error => error.code === "INVALID_DRAFT")).toBe(true);
  });
  it("still fails a design holding tool-call markup", () => {
    const design = broken(); design.processName = "<｜DSML｜function_calls> x";
    expect(validateToBeOutput(fixture(), design, [], [], { degrade: true }).success).toBe(false);
  });
  it("still fails when a structural error comes with content errors", () => {
    const input = fixture(); input.discovery.requirements[0]!.evidence.quote = "not in the source";
    expect(validateToBeOutput(input, broken(), [], [], { degrade: true }).success).toBe(false);
  });
});

/** A model that answers the rental design as it is, except that step TB-2 always carries a placeholder: the re-expansion rounds never clear it. */
function run(input = fixture(), remainingBudget?: () => number) {
  const warnings: { code: string; path: string; detail?: string }[] = [], calls: string[] = [];
  const deps: DesignDeps = {
    parallelism: 2, invalid: () => new Error("AI_INVALID_OUTPUT"), record: () => {}, warn: issues => { warnings.push(...issues); }, review: true, reviewRounds: 2, maxFixParts: 8, ...(remainingBudget && { remainingBudget }),
    ask: async (substage, user, group) => {
      calls.push(substage);
      if (substage === "to_be_outline") return split.outline;
      if (substage === "to_be_step") { const id = (user as { step: { id: string } }).step.id; return id === "TB-2" ? withTbd(id) : split.details[id]; }
      return rentalRegisterGroups[group as RegisterGroup];
    },
  };
  return { result: runDesign(input, [], deps), warnings, calls };
}

describe("the final validation loop", () => {
  it("saves a design that keeps a content error as a blocked draft instead of failing", async () => {
    const h = run();
    const out = await h.result;
    expect(out.evaluation.reviewStatus).toBe("BLOCKED");
    expect(out.evaluation.blockers).toContainEqual(expect.objectContaining({ code: "PLACEHOLDER_TEXT" }));
    expect(h.warnings).toContainEqual(expect.objectContaining({ code: "TO_BE_DEGRADED_TO_BLOCKED" }));
    expect(h.calls.filter(call => call === "to_be_step").length).toBeGreaterThan(MAX_REEXPANSION_ROUNDS);
    // The degraded draft gets neither a review nor a fix pass: they only adopt a repair when the whole design validates.
    expect(h.calls).not.toContain("to_be_review");
    expect(validateToBeOutput(fixture(), out.design, [], [], { degrade: true }).success).toBe(true);
  });
  it("still fails when the remaining error is structural", async () => {
    const input = fixture(); input.discovery.requirements[0]!.evidence.quote = "not in the source";
    await expect(run(input).result).rejects.toThrow("AI_INVALID_OUTPUT");
  });
});

describe("the final validation loop with the stage budget nearly spent", () => {
  const stepCalls = (h: ReturnType<typeof run>) => h.calls.filter(call => call === "to_be_step").length;
  it("saves the blocked draft at once, without starting a re-expansion round the deadline would kill", async () => {
    const h = run(fixture(), () => REEXPANSION_MIN_REMAINING - 0.01);
    const out = await h.result;
    expect(out.evaluation.reviewStatus).toBe("BLOCKED");
    expect(stepCalls(h)).toBe(rentalDraft.steps.length); // the first expansion only
    expect(h.warnings).toContainEqual(expect.objectContaining({ code: "REEXPANSION_SKIPPED_BUDGET" }));
    expect(h.warnings).toContainEqual(expect.objectContaining({ code: "TO_BE_DEGRADED_TO_BLOCKED" }));
    expect(h.calls).not.toContain("to_be_review");
  });
  it("still re-expands while more than the threshold remains", async () => {
    const h = run(fixture(), () => 0.6);
    await h.result;
    expect(stepCalls(h)).toBeGreaterThan(rentalDraft.steps.length);
    expect(h.warnings.some(warning => warning.code === "REEXPANSION_SKIPPED_BUDGET")).toBe(false);
  });
  it("asks for more room when the round repairs the outline, which costs most of an outline call plus a full re-expansion", () => {
    expect(OUTLINE_ROUND_MIN_REMAINING).toBeGreaterThan(REEXPANSION_MIN_REMAINING);
    for (const left of [REEXPANSION_MIN_REMAINING, (REEXPANSION_MIN_REMAINING + OUTLINE_ROUND_MIN_REMAINING) / 2, OUTLINE_ROUND_MIN_REMAINING]) expect(reexpansionAllowed(left, true)).toBe(false);
    expect(reexpansionAllowed(OUTLINE_ROUND_MIN_REMAINING + 0.01, true)).toBe(true);
    expect(reexpansionAllowed((REEXPANSION_MIN_REMAINING + OUTLINE_ROUND_MIN_REMAINING) / 2, false)).toBe(true);
    expect(reexpansionAllowed(REEXPANSION_MIN_REMAINING, false)).toBe(false);
  });
});

describe("unknown question ids in coverage rows", () => {
  const outline = () => structuredClone(split.outline) as unknown as { coverage: Record<string, unknown>[]; openQuestions: { id: string }[] };
  it("drops a questionIds entry that no open question holds, and reports it", () => {
    const raw = outline();
    const known = raw.openQuestions[0]?.id ?? "OQ-1";
    raw.coverage[0] = { ...raw.coverage[0], questionIds: [known, "JWK-OQ-24"] };
    const { value, warnings } = repairOutlineShape({ requirements: fixture().discovery.requirements }, new Set(), raw);
    expect((value as typeof raw).coverage[0]!.questionIds).toEqual(raw.openQuestions.length ? [known] : []);
    expect(warnings).toContainEqual({ code: "REPAIRED_UNKNOWN_QUESTION_REF", path: "outline.coverage.0" });
  });
  it("leaves coverage rows whose question ids all exist untouched", () => {
    const raw = outline();
    const known = raw.openQuestions[0]?.id;
    if (known) raw.coverage[0] = { ...raw.coverage[0], questionIds: [known] };
    expect(repairOutlineShape({ requirements: fixture().discovery.requirements }, new Set(), raw).warnings.some(item => item.code === "REPAIRED_UNKNOWN_QUESTION_REF")).toBe(false);
  });
});

describe("round trip of the four unrepairable runs", () => {
  for (const name of ["di-prod-1", "iter4", "iter9a", "iter9b"]) {
    it(`${name}: its remaining errors become stored blockers that the reader accepts`, () => {
      const { design, errors } = JSON.parse(readFileSync(new URL(`./fixtures/to-be-degrade/${name}.json`, import.meta.url), "utf8")) as { design: unknown; errors: { code: string; path: string; detail?: string }[] };
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(error => STRUCTURAL_ERROR_CODES.has(error.code))).toBe(false);
      const blockers = demoteErrors(errors);
      expect(blockers.map(item => item.code)).toEqual(errors.map(item => item.code));
      const stored = parseStoredToBe({ design, evaluation: { blockers }, unresolvedInputQuestions: [], sourceRevision: 1, snapshotId: "s" });
      expect(stored.evaluation.blockers).toHaveLength(errors.length);
    });
  }
});
