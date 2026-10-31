import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";
import { runDesign, type DesignDeps, type Substage } from "../src/lib/ai/to-be-pipeline";
import { parseEnvironment } from "../src/lib/env";
import { fixture } from "./support/to-be-input";
import { splitDesign } from "./support/to-be-split";
import type { RegisterGroup } from "../src/lib/ai/design-registers";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const split = splitDesign(rentalDraft);
const first = { kind: "CONTRADICTION", paths: ["TB-2"], explanation: "TB-2 says no goods receipt occurs but DSM-1 moves the order to goods receipt posted." };
const second = { kind: "MISSING_LINK", paths: ["TB-2"], explanation: "TB-2 releases the hire item without naming who confirms the return." };
type Script = { reviews: unknown[]; deps?: Partial<DesignDeps>; onReview?: (nth: number) => void };

/** A model that answers the rental design as it is; the nth review answers reviews[n-1] (the last one repeats); TB-2 is rewritten on every repair. */
function run(script: Script) {
  const calls: Substage[] = [], warnings: { code: string; path: string; detail?: string }[] = [], stepCount: Record<string, number> = {};
  let reviews = 0, verifies = 0;
  const deps: DesignDeps = {
    parallelism: 2, invalid: () => new Error("AI_INVALID_OUTPUT"), record: () => {}, warn: issues => { warnings.push(...issues); }, review: true,
    ask: async (substage, user, group) => {
      calls.push(substage);
      const request = user as Record<string, unknown>;
      if (substage === "to_be_outline") return split.outline;
      // A verify call (it carries verifyFindings, see to-be-verify.test.ts) confirms every claimed repair and is not one of the numbered reviews.
      if (substage === "to_be_review" && request.verifyFindings) { verifies++; return { findings: [] }; }
      if (substage === "to_be_review") { reviews++; script.onReview?.(reviews); return script.reviews[Math.min(reviews, script.reviews.length) - 1]; }
      if (substage === "to_be_step") {
        const id = (request.step as { id: string }).id; stepCount[id] = (stepCount[id] ?? 0) + 1;
        return id === "TB-2" && stepCount[id]! > 1 ? { ...split.details[id]!, addedValue: `Returned assets are recorded per item, version ${stepCount[id]}.` } : split.details[id];
      }
      return rentalRegisterGroups[group as RegisterGroup];
    },
    ...script.deps,
  };
  return { result: runDesign(fixture(), [], deps), calls, warnings, stepCount, reviewCalls: () => reviews, verifyCalls: () => verifies };
}

describe("review rounds", () => {
  it("round 2 reviews the repaired design, routes only its new findings and may retry a part round 1 already tried", async () => {
    const h = run({ reviews: [{ findings: [first] }, { findings: [first, second] }, { findings: [] }], deps: { reviewRounds: 2 } });
    const out = await h.result;
    expect(h.reviewCalls()).toBe(2);
    expect(h.stepCount["TB-2"]).toBe(3); // first answer, round 1 repair, round 2 repair
    expect(out.reviewFindings!.map(finding => [finding.kind, finding.outcome])).toEqual([["CONTRADICTION", "REPAIRED"], ["MISSING_LINK", "REPAIRED"]]);
    expect(out.design.steps.find(step => step.id === "TB-2")!.effects.accountingEntry).toBeDefined();
    expect(h.warnings.map(item => item.code)).toContain("REVIEW_REPAIRED");
    expect(h.warnings.filter(item => item.code === "REVIEW_ROUND").map(item => item.detail)).toEqual([
      "round 1: 1 findings, 1 new, 1 of 1 parts repaired, 0 open", "round 2: 2 findings, 1 new, 1 of 1 parts repaired, 0 open"]);
  });

  it("a round 2 that only repeats round 1 sends nothing back", async () => {
    const h = run({ reviews: [{ findings: [first] }], deps: { reviewRounds: 2 } });
    const out = await h.result;
    expect(h.reviewCalls()).toBe(2);
    expect(h.stepCount["TB-2"]).toBe(2);
    expect(out.reviewFindings).toHaveLength(1);
    expect(h.warnings.some(item => item.code === "REVIEW_ROUND" && item.detail === "round 2: 1 findings, none new")).toBe(true);
  });

  it("skips round 2 with REVIEW_ROUND_SKIPPED_BUDGET when the budget left is less than round 1 took", async () => {
    let budget = 1;
    const h = run({ reviews: [{ findings: [first] }, { findings: [second] }], onReview: nth => { if (nth === 1) budget = 0.45; }, deps: { reviewRounds: 2, remainingBudget: () => budget } });
    const out = await h.result;
    expect(h.reviewCalls()).toBe(1);
    expect(h.stepCount["TB-2"]).toBe(2);
    expect(out.reviewFindings).toHaveLength(1);
    expect(h.warnings.map(item => item.code)).toContain("REVIEW_ROUND_SKIPPED_BUDGET");
  });

  it("rounds = 1 (or unset) is the single review: one review call, no round warnings", async () => {
    for (const deps of [{ reviewRounds: 1 }, {}]) {
      const h = run({ reviews: [{ findings: [first] }, { findings: [second] }], deps });
      const out = await h.result;
      expect(h.reviewCalls()).toBe(1);
      expect(out.reviewFindings).toHaveLength(1);
      expect(h.warnings.some(item => item.code.startsWith("REVIEW_ROUND"))).toBe(false);
    }
  });

  it("never turns a valid design invalid: a failing round 2 review keeps the round 1 result", async () => {
    const h = run({ reviews: [{ findings: [first] }, { findings: "many" }], deps: { reviewRounds: 2 } });
    const out = await h.result;
    expect(h.reviewCalls()).toBe(2);
    expect(out.reviewFindings).toHaveLength(1);
    expect(h.warnings.map(item => item.code)).toContain("REVIEW_INVALID_OUTPUT");
  });

  it("AI_TO_BE_REVIEW_ROUNDS defaults to 2 and accepts 1 to 3", () => {
    const base = { ...local, NODE_ENV: "test" };
    expect(parseEnvironment(base).AI_TO_BE_REVIEW_ROUNDS).toBe(2);
    expect(parseEnvironment({ ...base, AI_TO_BE_REVIEW_ROUNDS: "3" }).AI_TO_BE_REVIEW_ROUNDS).toBe(3);
    for (const bad of ["0", "4"]) expect(() => parseEnvironment({ ...base, AI_TO_BE_REVIEW_ROUNDS: bad })).toThrow("AI_TO_BE_REVIEW_ROUNDS");
  });
});
