import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repairOutlineLinks } from "../src/lib/ai/outline-repair";
import { validateOutline } from "../src/lib/ai/to-be-pipeline";
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

/** The three outline payloads DeepSeek-V4.1-Flash returned live (engineering-mto, --tobe-only; synthetic case data), replayed through validateOutline. */
describe("replay of the live outline attempts", async () => {
  const fixture = JSON.parse(readFileSync("fixtures/eval/engineering-mto.json", "utf8")) as Fixture;
  const input = buildToBeInput(fixture);
  const references = await loadSapReferences(input.targetProduct, input.discovery.targetRelease);
  const live = JSON.parse(readFileSync("fixtures/ai/to-be/live-outline-requirements.json", "utf8")) as { id: string; statement: string }[];
  const byStatement = new Map(input.discovery.requirements.map(r => [r.statement, r.id]));
  const requirementOf = new Map(live.map(r => [r.id, byStatement.get(r.statement)!]));
  const replay = (attempt: number) => {
    const payload = JSON.parse(readFileSync(`fixtures/ai/to-be/live-outline-${attempt}.json`, "utf8")).payload;
    // As-Is ids: the live run's ids in order of first appearance map to the fixture's steps in order.
    const asIsOf = new Map<string, string>();
    for (const s of payload.steps) for (const id of s.asIsStepIds) if (!asIsOf.has(id)) asIsOf.set(id, input.discovery.asIsSteps[asIsOf.size]?.id ?? id);
    const mapped = JSON.parse(JSON.stringify(payload, (_, v) => typeof v === "string" ? requirementOf.get(v) ?? asIsOf.get(v) ?? v : v));
    return validateOutline(input, references, mapped);
  };

  it("has a catalog and maps every live requirement", () => {
    expect(references.length).toBeGreaterThan(0);
    expect(live.length).toBeGreaterThan(0);
    expect([...requirementOf.values()].every(Boolean)).toBe(true);
  });
  const remaining: Record<number, string[]> = { 1: [], 2: ["CONDITIONAL_UNLINKED@outline.coverage.7"], 3: [] };
  it.each([1, 2, 3])("attempt %i: only the unrepairable judgment error is left", attempt => {
    const result = replay(attempt);
    const left = result.success ? [] : result.errors.map(e => `${e.code}@${e.path}`);
    expect(left).toEqual(remaining[attempt]);
  });
});
