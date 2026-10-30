import { describe, expect, it } from "vitest";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { productRelease, noCatalogNote } from "../src/lib/sap-releases";
import { validateToBeOutput } from "../src/lib/ai/to-be";
import { fixture } from "./support/to-be-input";

const input = () => {
  const base = fixture();
  return { ...base, discovery: { ...base.discovery, openQuestions: [
    { id: "q_a", question: "Which timezone governs the return timestamp?", owner: "Ops lead" },
    { id: "q_b", question: "Who raises supplementary invoices?", owner: "Billing clerk" }] } };
};
const withQuestions = (openQuestions: { id: string; question: string; owner: string; affectedStepIds: string[] }[]) => ({ ...structuredClone(rentalDraft), openQuestions });
const codes = (result: ReturnType<typeof validateToBeOutput>) => (result.success ? result.data.evaluation.blockers : []).map(b => `${b.code}@${b.path}`);

describe("one blocker per distinct open question", () => {
  it("drops the OPEN_QUESTION blocker of a design question that carries an input question label, keeps the question and the input blocker", () => {
    const linked = { id: "IQ-2", question: "Who raises supplementary invoices? (restated)", owner: "Billing clerk", affectedStepIds: ["TB-2"] };
    const own = { id: "Q-1", question: "Which proration convention applies?", owner: "Billing clerk", affectedStepIds: ["TB-2"] };
    const result = validateToBeOutput(input(), withQuestions([own, linked]));
    expect(result.success).toBe(true);
    const list = codes(result);
    expect(list).toContain("INPUT_QUESTION_UNRESOLVED@input.openQuestions.0");
    expect(list).toContain("INPUT_QUESTION_UNRESOLVED@input.openQuestions.1");
    expect(list).toContain("OPEN_QUESTION@draft.openQuestions.0");
    expect(list).not.toContain("OPEN_QUESTION@draft.openQuestions.1");
    if (result.success) expect(result.data.design.openQuestions.map(q => q.id)).toEqual(["Q-1", "IQ-2"]);
  });
  it("keeps the blocker of a design question whose label points past the input questions, and of a lookalike text under its own id", () => {
    const result = validateToBeOutput(input(), withQuestions([
      { id: "IQ-9", question: "Which timezone governs the return timestamp?", owner: "x", affectedStepIds: ["TB-2"] },
      { id: "Q-1", question: "Which timezone governs the return timestamp?", owner: "x", affectedStepIds: ["TB-2"] }]));
    expect(codes(result).filter(code => code.startsWith("OPEN_QUESTION"))).toEqual(["OPEN_QUESTION@draft.openQuestions.0", "OPEN_QUESTION@draft.openQuestions.1"]);
  });
});

describe("target product and release in one phrase", () => {
  it("does not repeat a product the release already names", () => {
    expect(productRelease("SAP S/4HANA Cloud Public Edition", "SAP S/4HANA Cloud Public Edition 2702")).toBe("SAP S/4HANA Cloud Public Edition 2702");
    expect(productRelease("SAP S/4HANA Cloud Public Edition", "sap s/4hana cloud public edition 2702")).toBe("sap s/4hana cloud public edition 2702");
    expect(productRelease("SAP S/4HANA Cloud Private Edition", "2025")).toBe("SAP S/4HANA Cloud Private Edition 2025");
    expect(productRelease("SAP S/4HANA Cloud Private Edition", null)).toBe("SAP S/4HANA Cloud Private Edition (release not decided)");
    expect(noCatalogNote("SAP S/4HANA Cloud Public Edition", "SAP S/4HANA Cloud Public Edition 2702")).toBe(
      "no verified SAP catalog for SAP S/4HANA Cloud Public Edition 2702; every SAP claim must be NEEDS_VALIDATION");
  });
});
