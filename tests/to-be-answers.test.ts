import { describe, expect, it } from "vitest";
import { rentalContext, rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { DetailedDesignSchema, evaluateDesign, inputIds } from "../src/lib/ai/design-quality";
import { toBeContext, parseToBeInput, STRUCTURAL_ERROR_CODES } from "../src/lib/ai/to-be";
import { fixture } from "./support/to-be-input";
import { rebuildDiscovery, type ReportLike, type StateLike } from "../scripts/tobe-input";

const answers = [
  { id: "SIP-OQ-1", question: "Which timezone governs the return timestamp?", answer: "The warehouse local time.", owner: "Rental operations lead", answeredBy: "user-1", answeredAt: "2026-11-20T10:00:00.000Z" },
  { id: "SIP-OQ-1", question: "Who approves a credit note?", answer: "The finance controller.", owner: "Finance lead", answeredBy: "user-1", answeredAt: "2026-11-20T11:00:00.000Z" },
];
const withAnswers = () => {
  const input = structuredClone(rentalContext) as typeof rentalContext & { answeredQuestions?: { id: string; question: string; answer: string }[] };
  input.answeredQuestions = [{ id: "ANS-1", question: answers[0]!.question, answer: answers[0]!.answer }];
  return { input, draft: structuredClone(rentalDraft) as ReturnType<typeof structuredClone<typeof rentalDraft>> };
};
const codes = (input: unknown, draft: unknown) => evaluateDesign(input, draft).errors.map(error => error.code);
const blockerCodes = (input: unknown, draft: unknown) => evaluateDesign(input, draft).blockers.map(item => item.code);

describe("toBeContext answered questions", () => {
  it("omits the key when no question is answered", () => {
    expect(toBeContext(parseToBeInput(fixture()))).not.toHaveProperty("answeredQuestions");
  });

  it("labels answers ANS-1..n by position and never shows the old design question id", () => {
    const input = fixture();
    input.discovery.answeredQuestions = answers;
    const context = toBeContext(parseToBeInput(input));
    expect(context.answeredQuestions).toEqual([
      { id: "ANS-1", question: answers[0]!.question, answer: answers[0]!.answer },
      { id: "ANS-2", question: answers[1]!.question, answer: answers[1]!.answer },
    ]);
    expect(JSON.stringify(context.answeredQuestions)).not.toContain("SIP-OQ-1");
    expect(context.approvedDecisions).toEqual([]);
    expect(inputIds(context)).toEqual(expect.arrayContaining(["ANS-1", "ANS-2"]));
  });
});

describe("answered questions in design evaluation", () => {
  it("parses a stored design that has no answerIds", () => {
    expect(DetailedDesignSchema.safeParse(rentalDraft).success).toBe(true);
    expect(evaluateDesign(withAnswers().input, rentalDraft).structurallyValid).toBe(true);
  });

  it("errors UNKNOWN_ANSWER for an answerIds entry that was not supplied", () => {
    const { input, draft } = withAnswers();
    draft.steps[0]!.answerIds = ["ANS-9"];
    expect(codes(input, draft)).toContain("UNKNOWN_ANSWER");
    const noAnswers = structuredClone(rentalContext), other = structuredClone(draft);
    other.steps[0]!.answerIds = ["ANS-1"];
    expect(codes(noAnswers, other)).toContain("UNKNOWN_ANSWER");
    const onCoverage = withAnswers();
    onCoverage.draft.coverage[0]!.answerIds = ["ANS-9"];
    expect(codes(onCoverage.input, onCoverage.draft)).toContain("UNKNOWN_ANSWER");
  });

  it("errors ANSWERED_QUESTION_REOPENED when an open question or a coverage question link uses an ANS id", () => {
    const reopened = withAnswers();
    reopened.draft.openQuestions[0]!.id = "ANS-1";
    expect(codes(reopened.input, reopened.draft)).toContain("ANSWERED_QUESTION_REOPENED");
    const linked = withAnswers();
    linked.draft.coverage[0]!.questionIds = ["ANS-1"];
    expect(codes(linked.input, linked.draft)).toContain("ANSWERED_QUESTION_REOPENED");
  });

  it("blocks ANSWER_NOT_APPLIED until a step or a coverage item cites the answer", () => {
    const { input, draft } = withAnswers();
    const result = evaluateDesign(input, draft);
    expect(result.errors).toEqual([]);
    expect(result.blockers).toContainEqual({ code: "ANSWER_NOT_APPLIED", path: "input.answeredQuestions.0" });
    const viaStep = structuredClone(draft);
    viaStep.steps[0]!.answerIds = ["ANS-1"];
    expect(evaluateDesign(input, viaStep).errors).toEqual([]);
    expect(blockerCodes(input, viaStep)).not.toContain("ANSWER_NOT_APPLIED");
    const viaCoverage = structuredClone(draft);
    viaCoverage.coverage[0]!.answerIds = ["ANS-1"];
    expect(evaluateDesign(input, viaCoverage).errors).toEqual([]);
    expect(blockerCodes(input, viaCoverage)).not.toContain("ANSWER_NOT_APPLIED");
  });

  it("raises no answer finding when nothing was answered", () => {
    expect(blockerCodes(rentalContext, rentalDraft).filter(code => code.startsWith("ANSWER"))).toEqual([]);
  });

  it("treats the new error codes as content errors that degrade to blockers", () => {
    expect(STRUCTURAL_ERROR_CODES.has("UNKNOWN_ANSWER")).toBe(false);
    expect(STRUCTURAL_ERROR_CODES.has("ANSWERED_QUESTION_REOPENED")).toBe(false);
  });
});

describe("rebuildDiscovery answers", () => {
  const source = { id: "SRC-1", title: "Workshop", locator: "Workshop 1", revision: "v1", text: "The coordinator copies quantities." };
  const base = fixture().discovery;
  const report = { project: { name: "P", clientName: "C" }, variant: { code: "V", name: "Variant" }, targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: null,
    discovery: { asIsSteps: base.asIsSteps, requirements: base.requirements, conflicts: base.conflicts, openQuestions: base.openQuestions,
      sources: base.sources.map(({ id, title, locator, revision, text }) => ({ id, title, locator, revision, text })) }, design: {} } as unknown as ReportLike;
  const stateWith = (extra: object) => ({ problemStatement: "", messages: [], facts: [], ...extra }) as unknown as StateLike;
  void source;

  it("carries state.answers as answeredQuestions, as compileDiscovery does", () => {
    const state = stateWith({ answers: answers.map((a, i) => ({ ...a, sourceJobId: "00000000-0000-4000-8000-000000000001", questionId: a.id + i })) });
    const { discovery } = rebuildDiscovery(report, state);
    expect(discovery.answeredQuestions).toHaveLength(2);
    expect(discovery.answeredQuestions![0]).toEqual({ id: "SIP-OQ-10", question: answers[0]!.question, answer: answers[0]!.answer,
      owner: answers[0]!.owner, answeredBy: "user-1", answeredAt: answers[0]!.answeredAt });
  });

  it("leaves the key out when there are no answers", () => {
    expect(rebuildDiscovery(report, stateWith({})).discovery).not.toHaveProperty("answeredQuestions");
    expect(rebuildDiscovery(report, stateWith({ answers: [] })).discovery).not.toHaveProperty("answeredQuestions");
  });
});
