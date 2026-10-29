import { describe, expect, it } from "vitest";
import { carriedGaps } from "../src/lib/workspace-fields";

const step = { code: "AS_IS_STEP_INCOMPLETE" }, pending = { code: "OBSERVATIONS_PENDING" };
const obs = (...statuses: string[]) => ({ observations: statuses.map(status => ({ status })) });

describe("carriedGaps", () => {
  it("counts unfinished steps and every pending observation, not the single OBSERVATIONS_PENDING blocker", () => {
    const blockers = [...Array.from({ length: 13 }, () => step), pending];
    const result = carriedGaps(obs(...Array.from({ length: 15 }, () => "PENDING"), "RESOLVED"), blockers);
    expect(result).toEqual({ steps: 13, points: 15, total: 28, parts: "13 unfinished steps and 15 points to check" });
  });
  it("uses singular wording and omits an empty part", () => {
    expect(carriedGaps(obs(), [step]).parts).toBe("1 unfinished step");
    expect(carriedGaps(obs("PENDING"), []).parts).toBe("1 point to check");
  });
  it("is empty when nothing is carried", () => {
    expect(carriedGaps(obs("DISMISSED"), [])).toEqual({ steps: 0, points: 0, total: 0, parts: "" });
  });
});
