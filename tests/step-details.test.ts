import { describe, expect, it } from "vitest";
import { summarizeExtraction } from "../src/lib/consultant-extraction";
import { parseInterviewInput, revalidateStoredTurn, validateExtraction, type InterviewInput } from "../src/lib/ai/discovery-interview";
import { applyWorkspaceCommand, createWorkspace, recordInterviewTurn, type WorkspaceMeta } from "../src/lib/discovery-workspace-model";

const S1 = "Step 3, the charge: the back office billing team sends it to the customer by email.";
const S2 = "It is raised in RentTrack when the contract ends.";
const S3 = "Customers often dispute the charge.";
const EARLIER = "The yard supervisor inspects every machine.";
const input = (): InterviewInput => parseInterviewInput({
  schemaVersion: 1, contextRevision: 4, variantName: "Late returns", problemStatement: "Late-return charges are disputed.",
  currentMessage: { id: "M2", text: [S1, S2, S3].join(" ") }, evidence: [{ id: "M1", text: EARLIER }],
  fields: [], activeGaps: [], closedGapKeys: [], unextractedMessageIds: [], history: [], requirements: [], steps: [],
});
const step = (details?: unknown[], sentenceIds = ["S1", "S2"]) => ({ sentenceIds, nameHint: null, ...(details ? { details } : {}) });
const detail = (key: string, answer: string, sentenceIds = ["S1"]) => ({ key, sentenceIds, answer });
const run = (steps: unknown[]) => {
  const result = validateExtraction(input(), { proposedUpdates: [], proposedSteps: steps, proposedRequirements: [], observations: [] });
  if (!result.success) throw new Error(JSON.stringify(result.errors));
  return result;
};
const dropped = (r: ReturnType<typeof run>) => r.warnings.filter(w => w.code === "step_detail_dropped").map(w => `${w.path}:${w.detail}`);

describe("details of a proposed step, from a model's answer", () => {
  it("keeps a detail whose answer is an exact span of its cited sentence, with the sentence as evidence", () => {
    const result = run([step([detail("actor", "the back office billing team"), detail("system", "RentTrack", ["S2"])])]);
    expect(result.data.proposedSteps).toHaveLength(1);
    expect(result.data.proposedSteps[0]!.details).toEqual([
      { key: "actor", value: "the back office billing team", quote: S1 }, { key: "system", value: "RentTrack", quote: S2 }]);
    expect(dropped(result)).toEqual([]);
  });

  it("drops a detail whose answer is not a span, keeps the step and never falls back to the sentence", () => {
    const result = run([step([detail("actor", "the billing department"), detail("system", "RentTrack", ["S2"])])]);
    expect(result.data.proposedSteps).toHaveLength(1);
    expect(result.data.proposedSteps[0]!.details).toEqual([{ key: "system", value: "RentTrack", quote: S2 }]);
    expect(dropped(result)).toEqual(["proposedSteps.0.details.0:answer_not_in_quote"]);
  });

  it("a missing answer is dropped, not replaced by the sentence", () => {
    const result = run([step([{ key: "actor", sentenceIds: ["S1"], answer: "" }])]);
    expect(result.data.proposedSteps[0]!.details).toBeUndefined();
    expect(dropped(result)).toEqual(["proposedSteps.0.details.0:answer_not_in_quote"]);
  });

  it("keeps the first detail of a key and drops later ones", () => {
    const result = run([step([detail("actor", "the back office billing team"), detail("actor", "the customer")])]);
    expect(result.data.proposedSteps[0]!.details).toEqual([{ key: "actor", value: "the back office billing team", quote: S1 }]);
    expect(dropped(result)).toEqual(["proposedSteps.0.details.1:duplicate_key"]);
  });

  it("drops a detail that cites a sentence of another source than the step", () => {
    const result = run([step([detail("actor", "yard supervisor", ["S4"])])]);
    expect(result.data.proposedSteps).toHaveLength(1);
    expect(result.data.proposedSteps[0]!.details).toBeUndefined();
    expect(dropped(result)).toEqual(["proposedSteps.0.details.0:other_source"]);
  });

  it("drops a detail citing an unknown sentence, and a key that is not one of the seven", () => {
    const result = run([step([detail("actor", "x", ["S99"]), detail("name", "the charge"), detail("trigger", "when the contract ends", ["S2"])])]);
    expect(result.data.proposedSteps[0]!.details).toEqual([{ key: "trigger", value: "when the contract ends", quote: S2 }]);
    expect(dropped(result)).toEqual(["proposedSteps.0.details.0:unknown_sentence_id", "proposedSteps.0.details.1:malformed"]);
  });

  const withMessage = (text: string, details: unknown[]) => {
    const result = validateExtraction(parseInterviewInput({ ...input(), currentMessage: { id: "M2", text } }),
      { proposedUpdates: [], proposedSteps: [step(details, ["S1"])], proposedRequirements: [], observations: [] });
    if (!result.success) throw new Error(JSON.stringify(result.errors));
    return result;
  };
  const reasons = (r: ReturnType<typeof run>) => r.warnings.filter(w => w.code === "step_detail_dropped").map(w => w.detail);

  it("drops a detail value too long for its key", () => {
    const long = `The back office billing team calculates the extra days for every contract, applies the daily rate agreed in the contract, ${"and sends the charge to the customer by email, ".repeat(5)}at the end of each month.`;
    expect(long.length).toBeGreaterThan(300);
    const result = withMessage(long, [detail("actor", long), detail("trigger", long)]);
    expect(result.data.proposedSteps[0]!.details).toBeUndefined();
    expect(reasons(result)).toEqual(["too_long_for_field", "too_long_for_field"]);
  });

  it("drops a detail that is the step's own sentence, or the same long value as an earlier detail", () => {
    const sentence = "The back office billing team sends the charge to the customer by email every day.";
    expect(withMessage(sentence, [detail("actor", sentence)]).data.proposedSteps[0]!.details).toBeUndefined();
    const result = withMessage(`${sentence} It runs in RentTrack.`, [detail("actor", "The back office billing team"), detail("system", sentence)]);
    expect(result.data.proposedSteps[0]!.details).toEqual([{ key: "actor", value: "The back office billing team", quote: sentence }]);
    expect(reasons(result)).toEqual(["echoed_value"]);
  });

  it("a dropped detail is not counted as a dropped step", () => {
    const result = run([step([detail("actor", "the billing department")])]);
    const summary = summarizeExtraction(result.data, result.warnings);
    expect(summary.kept.steps).toBe(1);
    expect(summary.dropped.steps).toBe(0);
    expect(summary.dropReasons).toEqual({});
  });
});

describe("stored proposals", () => {
  const stored = (steps: unknown[]) => revalidateStoredTurn(input(), { proposedUpdates: [], proposedSteps: steps, proposedRequirements: [], observations: [] }, "extraction");
  const quote = `${S1} ${S2}`;

  it("a turn stored without details revalidates with none", () => {
    const result = stored([{ sourceId: "M2", quote, value: quote, nameHint: null }]);
    expect(result.success && result.data.proposedSteps[0]).toEqual({ sourceId: "M2", quote, value: quote, nameHint: null });
  });

  it("a stored detail must be a span of its quote, inside the step's source", () => {
    const ok = stored([{ sourceId: "M2", quote, value: quote, nameHint: null, details: [{ key: "system", value: "RentTrack", quote: S2 }] }]);
    expect(ok.success && ok.data.proposedSteps[0]!.details).toEqual([{ key: "system", value: "RentTrack", quote: S2 }]);
    const bad = stored([{ sourceId: "M2", quote, value: quote, nameHint: null, details: [
      { key: "system", value: "SAP", quote: S2 }, { key: "actor", value: "yard", quote: EARLIER }] }]);
    expect(bad.success && bad.data.proposedSteps[0]!.details).toBeUndefined();
  });

  it("the workspace refuses a stored proposal whose detail quote is not in its source, and accepts one without details", () => {
    let n = 0;
    const meta = (): WorkspaceMeta => ({ actorId: "u", at: "2026-11-18T10:00:00.000Z", id: `e${++n}` });
    let state = createWorkspace({ variantCode: "LR", variantName: "Late returns", targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: null,
      problemStatement: "Charges are disputed." }, meta());
    const sent = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: `${S1} ${S2}` }, sent);
    state = recordInterviewTurn(state, { questions: [], observations: [], proposedUpdates: [], proposedRequirements: [],
      proposedSteps: [{ sourceId: sent.id, quote: `${S1} ${S2}`, nameHint: null }] }, sent.id, meta(), "extraction");
    expect(state.proposals[0]!.details).toBeUndefined();
    const tampered = structuredClone(state);
    tampered.proposals[0]!.details = [{ key: "actor", value: "the clerk", quote: "the clerk" }];
    expect(() => applyWorkspaceCommand(tampered, { type: "SEND_MESSAGE", text: "x" }, meta())).toThrow("INVALID_WORKSPACE_EVIDENCE");
    const notSpan = structuredClone(state);
    notSpan.proposals[0]!.details = [{ key: "actor", value: "billing", quote: S1.replace("billing", "billing") }];
    expect(() => applyWorkspaceCommand(notSpan, { type: "SEND_MESSAGE", text: "x" }, meta())).not.toThrow(); // "billing" is a span
    notSpan.proposals[0]!.details = [{ key: "actor", value: "accounts team", quote: S1 }];
    expect(() => applyWorkspaceCommand(notSpan, { type: "SEND_MESSAGE", text: "x" }, meta())).toThrow("INVALID_WORKSPACE_EVIDENCE");
  });
});
