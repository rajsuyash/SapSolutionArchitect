import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyOutlinePatch, isPatchable } from "../src/lib/ai/outline-patch";
import { repairOutlineLinks } from "../src/lib/ai/outline-repair";
import { outlinePatchRequest, validateOutline } from "../src/lib/ai/to-be-pipeline";
import { loadSapReferences } from "../src/lib/ai/sap-references";
import { buildToBeInput } from "./support/expert-control";
import type { Fixture } from "../src/lib/eval-user";

const target = { product: "P", release: "2023" };
const ref = (id: string, fitType: string, over: Record<string, unknown> = {}) =>
  ({ id, fitType, status: "VERIFIED", targetProduct: "P", targetRelease: "2023", ...over });
const refs = [ref("S", "STANDARD"), ref("C", "CONFIGURATION"), ref("E", "EXTENSION"), ref("I", "INTEGRATION"), ref("L", "LICENSE_DEPENDENT"),
  ref("U", "STANDARD", { status: "UNVERIFIED" }), ref("O", "STANDARD", { targetRelease: "2022" })];
const step = (id: string, over: Record<string, unknown> = {}) => ({ id, requirementIds: ["R"], implementation: { kind: "NEEDS_VALIDATION", referenceIds: [] }, ...over });
const withKind = (kind: string, referenceIds: string[]) => step("A", { implementation: { kind, referenceIds } });
const run = (...steps: unknown[]) => repairOutlineLinks(target, refs, { steps });
const kindOf = (out: ReturnType<typeof run>) => ((out.value as { steps: { implementation: { kind: string } }[] }).steps[0]!).implementation.kind;
const enables = (out: ReturnType<typeof run>) => (out.value as { steps: { enablesStepIds?: string[] }[] }).steps.map(s => s.enablesStepIds);

describe("REPAIRED_FIT_KIND", () => {
  it.each([["STANDARD", ["S", "C"], "CONFIGURATION"], ["STANDARD", ["S", "E"], "EXTENSION"], ["CONFIGURATION", ["C", "I", "S"], "INTEGRATION"]])(
    "raises %s over %j to %s", (kind, ids, expected) => {
      const out = run(withKind(kind, ids));
      expect(kindOf(out)).toBe(expected);
      expect(out.warnings).toEqual([{ code: "REPAIRED_FIT_KIND", path: "outline.steps.0.implementation" }]);
    });
  it.each([
    ["EXTENSION and INTEGRATION both cited", "STANDARD", ["E", "I"]], ["license dependent cited", "STANDARD", ["S", "L"]],
    ["unverified reference", "STANDARD", ["S", "U"]], ["other release", "STANDARD", ["S", "O"]], ["id not in catalog", "STANDARD", ["S", "X"]],
    ["kind already demanding enough", "CONFIGURATION", ["S", "C"]], ["nothing cited", "STANDARD", []], ["EXTENSION kind is not touched", "EXTENSION", ["I"]],
  ])("leaves the step for the model: %s", (_, kind, ids) => {
    const out = run(withKind(kind, ids));
    expect(kindOf(out)).toBe(kind);
    expect(out.warnings).toEqual([]);
  });
});

describe("REPAIRED_ENABLING_LINK", () => {
  const none = { requirementIds: [] };
  it("links an unlinked step to the next requirement-bearing step, skipping other enabling steps", () => {
    const out = run(step("A", none), step("B", { ...none, enablesStepIds: ["A"] }), step("C"));
    expect(enables(out)).toEqual([["C"], ["C"], undefined]);
    expect(out.warnings.map(w => w.path)).toEqual(["outline.steps.0", "outline.steps.1"]);
  });
  it("falls back to the previous requirement-bearing step when none follows", () => {
    expect(enables(run(step("A"), step("B", none)))).toEqual([undefined, ["A"]]);
    expect(enables(run(step("A"), step("B", { ...none, enablesStepIds: [] })))[1]).toEqual(["A"]);
  });
  it("replaces a self or non-requirement target by the next requirement-bearing step and keeps valid targets", () => {
    const out = run(step("A", { ...none, enablesStepIds: ["A", "B"] }), step("B", none), step("C"), step("D", { ...none, enablesStepIds: ["C", "D"] }));
    expect(enables(out)).toEqual([["C"], ["C"], undefined, ["C"]]);
  });
  it("does nothing when no step carries a requirement, for a valid link, or for an unknown step id", () => {
    expect(run(step("A", none), step("B", none)).warnings).toEqual([]);
    expect(run(step("A"), step("B", { ...none, enablesStepIds: ["A"] })).warnings).toEqual([]);
    const unknown = run(step("A"), step("B", { ...none, enablesStepIds: ["ZZ"] }));
    expect(unknown.warnings).toEqual([]);
    expect(enables(unknown)[1]).toEqual(["ZZ"]);
  });
});

/** Outline payloads DeepSeek-V4.1-Flash returned live (engineering-mto, --tobe-only; synthetic case data), replayed through validateOutline.
 * `prefix` picks the run's fixtures; `asIsFrom` is the attempt whose first-appearance order of As-Is ids maps to the fixture's steps
 * (an attempt that leaves an As-Is step out cannot define the order). */
async function liveReplay(prefix: string, asIsFrom?: number) {
  const fixture = JSON.parse(readFileSync("fixtures/eval/engineering-mto.json", "utf8")) as Fixture;
  const input = buildToBeInput(fixture);
  const references = await loadSapReferences(input.targetProduct, input.discovery.targetRelease);
  const live = JSON.parse(readFileSync(`fixtures/ai/to-be/${prefix}-requirements.json`, "utf8")) as { id: string; statement: string }[];
  const byStatement = new Map(input.discovery.requirements.map(r => [r.statement, r.id]));
  const requirementOf = new Map(live.map(r => [r.id, byStatement.get(r.statement)!]));
  const load = (attempt: number) => JSON.parse(readFileSync(`fixtures/ai/to-be/${prefix}-${attempt}.json`, "utf8")).payload;
  const asIsOf = new Map<string, string>();
  const order = (payload: { steps: { asIsStepIds: string[] }[] }) => {
    asIsOf.clear();
    for (const s of payload.steps) for (const id of s.asIsStepIds) if (!asIsOf.has(id)) asIsOf.set(id, input.discovery.asIsSteps[asIsOf.size]?.id ?? id);
  };
  if (asIsFrom) order(load(asIsFrom));
  const mapped = (attempt: number) => {
    const payload = load(attempt);
    if (!asIsFrom) order(payload);
    return JSON.parse(JSON.stringify(payload, (_, v) => typeof v === "string" ? requirementOf.get(v) ?? asIsOf.get(v) ?? v : v));
  };
  const replay = (attempt: number) => validateOutline(input, references, mapped(attempt));
  return { input, references, live, requirementOf, replay };
}
const left = (result: ReturnType<typeof validateOutline>) => result.success ? [] : result.errors.map(e => `${e.code}@${e.path}`);

describe("replay of the live outline attempts", async () => {
  const { references, live, requirementOf, replay } = await liveReplay("live-outline");
  it("has a catalog and maps every live requirement", () => {
    expect(references.length).toBeGreaterThan(0);
    expect(live.length).toBeGreaterThan(0);
    expect([...requirementOf.values()].every(Boolean)).toBe(true);
  });
  const remaining: Record<number, string[]> = { 1: [], 2: ["CONDITIONAL_UNLINKED@outline.coverage.7"], 3: [] };
  it.each([1, 2, 3])("attempt %i: only the unrepairable judgment error is left", attempt => {
    expect(left(replay(attempt))).toEqual(remaining[attempt]);
  });
});

/** Second live run (0ad3ae0): attempt 1 had one error, the full re-answer after it regressed fields that were valid, and with no decision
 * register supplied every decisionIds value the model wrote was invented. Attempts 1 and 2 are the first 20000 characters the eval kept
 * (the last, cut-off open question dropped and the lists closed). */
describe("replay of the second live run (no decision register)", async () => {
  const { input, references, requirementOf, replay } = await liveReplay("live2-outline", 3);
  const outlineOf = (attempt: number) => { const r = replay(attempt); return { r, shaped: (r as { shaped: unknown }).shaped }; };
  const stepAt = (shaped: unknown, i: number) => (shaped as { steps: Record<string, unknown>[] }).steps[i]!;
  const asManual = (step: Record<string, unknown>) => ({ ...step, implementation: { kind: "NEEDS_VALIDATION", referenceIds: [] } });

  it("maps every live requirement and the run had no register", () => {
    expect([...requirementOf.values()].every(Boolean)).toBe(true);
    expect(input.decisionRegister).toBeUndefined();
  });

  it("attempt 1: one patchable SAP_FIT_MISMATCH; a stub patch for that step alone validates", () => {
    const { r, shaped } = outlineOf(1);
    expect(left(r)).toEqual(["SAP_FIT_MISMATCH@outline.steps.12.implementation"]);
    const errors = r.success ? [] : r.errors;
    expect(isPatchable(errors, shaped)).toBe(true);
    const note = String(outlinePatchRequest(input, references, shaped, errors).repairNote);
    expect(note).toContain("cited fit types STANDARD, CONFIGURATION, LICENSE_DEPENDENT -> allowed kinds: MANUAL, NEEDS_VALIDATION");
    const merged = applyOutlinePatch(shaped, { steps: [asManual(stepAt(shaped, 12))] });
    expect((merged as { steps: unknown[] }).steps).toHaveLength((shaped as { steps: unknown[] }).steps.length);
    expect(left(validateOutline(input, references, merged))).toEqual([]);
  });

  it("attempt 2: two patchable errors remain (a fit mismatch and an As-Is step nobody traces); the decision ids are repaired away", () => {
    const { r, shaped } = outlineOf(2);
    expect(left(r)).toEqual(["SAP_FIT_MISMATCH@outline.steps.11.implementation", "AS_IS_UNCOVERED@input.asIsSteps.10"]);
    const errors = r.success ? [] : r.errors;
    expect(isPatchable(errors, shaped)).toBe(true);
    const merged = applyOutlinePatch(shaped, { steps: [asManual(stepAt(shaped, 11))],
      eliminatedAsIsSteps: [{ asIsStepId: input.discovery.asIsSteps[10]!.id, reason: "Stub patch: not part of the To-Be process." }] });
    expect(left(validateOutline(input, references, merged))).toEqual([]);
  });

  it("attempt 3: the invented decision ids are dropped (paths only) and nothing else is wrong", () => {
    const result = replay(3);
    expect(left(result)).toEqual([]);
    if (!result.success) return;
    const dropped = result.warnings.filter(w => w.code === "REPAIRED_UNKNOWN_DECISION").map(w => w.path);
    expect(dropped).toEqual(["outline.coverage.1", "outline.coverage.3", "outline.coverage.4", "outline.coverage.8", "outline.coverage.9", "outline.coverage.10", "outline.openQuestions.0"]);
    expect(result.warnings.every(w => Object.keys(w).sort().join() === "code,path")).toBe(true);
  });
});

/** Third live run (4a864f4): the model wrote a 14th coverage row whose requirementId is an input id plus "_NA". The raw first attempt
 * parsed whole (16247 characters), so it is stored unrepaired. The patch repair could not delete the row, so all three attempts failed. */
describe("replay of the third live run (a coverage row for an invented requirement)", async () => {
  const { input, references, requirementOf, live, replay } = await liveReplay("live3-outline", 1);
  it("maps every live requirement; the raw payload carries 14 coverage rows for 13 requirements", () => {
    expect(live).toHaveLength(13);
    expect([...requirementOf.values()].every(Boolean)).toBe(true);
    expect(input.discovery.requirements).toHaveLength(13);
  });
  it("attempt 1: the invented row is dropped by the server; the one error left is the patchable fit mismatch, and a stub patch for it validates", () => {
    const result = replay(1), shaped = (result as { shaped: unknown }).shaped;
    expect(left(result)).toEqual(["SAP_FIT_MISMATCH@outline.steps.9.implementation"]);
    const errors = result.success ? [] : result.errors;
    expect(isPatchable(errors, shaped)).toBe(true);
    const steps = (shaped as { steps: Record<string, unknown>[] }).steps;
    const merged = applyOutlinePatch(shaped, { steps: [{ ...steps[9]!, implementation: { kind: "NEEDS_VALIDATION", referenceIds: [] } }] });
    const fixed = validateOutline(input, references, merged);
    expect(left(fixed)).toEqual([]);
    if (!fixed.success) return;
    expect(fixed.outline.coverage).toHaveLength(13);
    // The warning belongs to the first validation (the shaped payload no longer holds the row); the shaped payload proves it was dropped.
    expect((shaped as { coverage: { requirementId: string }[] }).coverage).toHaveLength(13);
    expect(JSON.stringify(shaped)).not.toContain("_NA");
  });
});
