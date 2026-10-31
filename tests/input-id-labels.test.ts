import { describe, expect, it } from "vitest";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";
import { repairIdTypos } from "../src/lib/ai/id-variant-repair";
import { replaceIds, shortenInputIds } from "../src/lib/ai/input-id-labels";
import { runDesign, validateOutline, type DesignDeps, type Substage } from "../src/lib/ai/to-be-pipeline";
import { fixture } from "./support/to-be-input";
import { splitDesign } from "./support/to-be-split";
import type { RegisterGroup } from "../src/lib/ai/design-registers";
import type { ToBeInput } from "../src/lib/ai/to-be";

const UUID = "b6555739-b387-4e37-a2d5-dbb9bf351c62";
const rq = (n: number) => `rq_${UUID}_${n}`, st = (n: number) => `st_${UUID}_${n}`;
/** The fixture with production-shaped long requirement and As-Is step ids, plus the map from the fixture's short ids to them. */
function longInput() {
  const input = fixture(), forward = new Map<string, string>();
  input.discovery.requirements.forEach((item, i) => forward.set(item.id, rq(i + 1)));
  input.discovery.asIsSteps.forEach((item, i) => forward.set(item.id, st(i + 1)));
  return { input: replaceIds(input, forward), forward };
}
/** What the model sees and writes: the same ids as RQ-n / AS-n. */
const shortFor = (forward: Map<string, string>, input: ToBeInput) => new Map([...forward].map(([short, long]) => {
  const ri = input.discovery.requirements.findIndex(item => item.id === long), si = input.discovery.asIsSteps.findIndex(item => item.id === long);
  return [short, ri >= 0 ? `RQ-${ri + 1}` : `AS-${si + 1}`] as const;
}));

describe("long input ids are shown to the model as RQ-n / AS-n and written back", () => {
  it("pipeline: the requests carry labels only, the result carries the original ids", async () => {
    const { input, forward } = longInput(), toModel = shortFor(forward, input);
    const split = splitDesign(rentalDraft), requests: string[] = [];
    const deps: DesignDeps = { parallelism: 2, invalid: () => new Error("AI_INVALID_OUTPUT"), record: () => {},
      ask: async (substage: Substage, user, group) => {
        requests.push(JSON.stringify(user));
        if (substage === "to_be_outline") return replaceIds(split.outline, toModel);
        if (substage === "to_be_step") return replaceIds(split.details[(user as { step: { id: string } }).step.id], toModel);
        return replaceIds(rentalRegisterGroups[group as RegisterGroup], toModel);
      } };
    const out = await runDesign(input, [], deps), text = JSON.stringify(out);
    expect(requests.length).toBeGreaterThan(3);
    expect(requests.every(request => request.includes("RQ-1") && !request.includes(UUID))).toBe(true);
    expect(requests.some(request => request.includes("AS-1"))).toBe(true);
    expect(text).toContain(rq(1));
    expect(text).toContain(st(1));
    expect(text).not.toMatch(/(?<![A-Za-z0-9_-])(?:RQ|AS)-\d+(?![A-Za-z0-9_-])/);
  });

  it("short ids pass through untouched", () => {
    const input = fixture();
    expect(shortenInputIds(input).input).toBe(input);
  });

  it("a failed run reports the draft and its errors with the original ids", async () => {
    const { input, forward } = longInput(), toModel = shortFor(forward, input), split = splitDesign(rentalDraft);
    const drafts: string[] = [], errors: string[] = [];
    // The model never tests the first requirement: the assembled design fails its trace checks and the stage gives up (no repairs allowed).
    const untested = (detail: { acceptanceTests: { requirementIds: string[] }[] }) => ({ ...detail, acceptanceTests: detail.acceptanceTests.map(test => ({ ...test, requirementIds: test.requirementIds.filter(id => id !== "R-1") })) });
    const deps: DesignDeps = { parallelism: 2, invalid: () => new Error("AI_INVALID_OUTPUT"), record: issues => { errors.push(JSON.stringify(issues)); }, lastDraft: (design, issues) => { drafts.push(JSON.stringify([design, issues])); },
      maxPartRepairs: 0, maxOutlineRepairs: 0,
      ask: async (substage: Substage, user, group) => {
        if (substage === "to_be_outline") return replaceIds(split.outline, toModel);
        if (substage === "to_be_step") return replaceIds(untested(split.details[(user as { step: { id: string } }).step.id] as never), toModel);
        return replaceIds(rentalRegisterGroups[group as RegisterGroup], toModel);
      } };
    // Repairs run out on a content error: the draft is saved as blocked, its errors listed with the original ids.
    const out = await runDesign(input, [], deps);
    expect(out.evaluation.reviewStatus).toBe("BLOCKED");
    expect(out.evaluation.blockers.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.evaluation.blockers)).not.toMatch(/(?<![A-Za-z0-9_-])(?:RQ|AS)-\d+(?![A-Za-z0-9_-])/);
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts[0]).toContain(rq(1));
    expect(drafts[0] + errors.join()).not.toMatch(/(?<![A-Za-z0-9_-])(?:RQ|AS)-\d+(?![A-Za-z0-9_-])/);
  });

  it("a failed run whose remaining error is structural is still rejected", async () => {
    const { input, forward } = longInput(), toModel = shortFor(forward, input), split = splitDesign(rentalDraft);
    input.discovery.requirements[0]!.evidence.quote = "not in the source";
    const deps: DesignDeps = { parallelism: 2, invalid: () => new Error("AI_INVALID_OUTPUT"), record: () => {}, maxPartRepairs: 0, maxOutlineRepairs: 0,
      ask: async (substage: Substage, user, group) => {
        if (substage === "to_be_outline") return replaceIds(split.outline, toModel);
        if (substage === "to_be_step") return replaceIds(split.details[(user as { step: { id: string } }).step.id], toModel);
        return replaceIds(rentalRegisterGroups[group as RegisterGroup], toModel);
      } };
    await expect(runDesign(input, [], deps)).rejects.toThrow("AI_INVALID_OUTPUT");
  });

  it("a step answer that mis-copies a long id the model sees verbatim (a decision id) is repaired", async () => {
    // Decision ids are not relabelled: the typo net is what protects them.
    const decision = `dec_${UUID}_1`, input = { ...fixture(), decisionRegister: [{ id: decision, topic: "Return handling", owner: "Rental operations lead", affectedStepIds: ["TB-1"] }] };
    const split = splitDesign(rentalDraft), warnings: string[] = [];
    const deps: DesignDeps = { parallelism: 2, invalid: () => new Error("AI_INVALID_OUTPUT"), record: () => {}, warn: issues => { warnings.push(...issues.map(issue => issue.code)); },
      ask: async (substage: Substage, user, group) => {
        if (substage === "to_be_outline") return split.outline;
        if (substage === "to_be_step") {
          const id = (user as { step: { id: string } }).step.id;
          return id === "TB-1" ? { ...split.details[id]!, decisionIds: [decision.replace("b6555739", "6555739")] } : split.details[id];
        }
        return rentalRegisterGroups[group as RegisterGroup];
      } };
    const out = await runDesign(input, [], deps).catch(() => undefined);
    expect(warnings).toContain("REPAIRED_ID_TYPO");
    expect(warnings).not.toContain("REPAIRED_UNKNOWN_DECISION");
    expect(out?.design.steps[0]!.decisionIds).toEqual([decision]);
  });
});

describe("repairIdTypos", () => {
  const known = [rq(17), rq(18), "R-1", "R-2"];
  it("repairs a long id with a dropped character, only in id fields, with a path-only warning", () => {
    const typo = rq(17).replace("b6555739", "6555739");
    const out = repairIdTypos({ tests: [{ requirementIds: [typo, "R-1"], note: typo }], requirementId: typo }, known, "draft");
    expect(out.value).toEqual({ tests: [{ requirementIds: [rq(17), "R-1"], note: typo }], requirementId: rq(17) });
    expect(out.warnings.map(warning => warning.code)).toEqual(["REPAIRED_ID_TYPO", "REPAIRED_ID_TYPO"]);
    expect(JSON.stringify(out.warnings)).not.toContain(UUID);
  });
  it("never repairs short ids, ambiguous ones or ones further than two edits", () => {
    expect(repairIdTypos({ requirementIds: ["R-3", "RQ-21"] }, [...known, "RQ-12"], "d").value).toEqual({ requirementIds: ["R-3", "RQ-21"] });
    expect(repairIdTypos({ requirementIds: [`rq_${UUID}_1`] }, [rq(11), rq(12)], "d").warnings).toEqual([]);
    expect(repairIdTypos({ requirementIds: [`rq_${UUID}_999`] }, known, "d").warnings).toEqual([]);
  });
  it("outline: a mis-copied long requirement id in the coverage is repaired, not dropped", () => {
    const { input, forward } = longInput(), split = splitDesign(rentalDraft), long = replaceIds(split.outline, forward) as { coverage: { requirementId: string }[] };
    const wrong = { ...long, coverage: long.coverage.map((row, i) => i === 0 ? { ...row, requirementId: row.requirementId.replace("b6555739", "6555739") } : row) };
    const result = validateOutline(input, [], wrong);
    expect(result.success && result.warnings.some(warning => warning.code === "REPAIRED_ID_TYPO")).toBe(true);
    expect(result.success && result.outline.coverage.some(row => row.requirementId === rq(1))).toBe(true);
  });
});
