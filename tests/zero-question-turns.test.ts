import { describe, expect, it } from "vitest";
import { revalidateStoredTurn, validateChatTurn } from "../src/lib/ai/discovery-interview";
import { applyWorkspaceCommand, buildInterviewInput, createWorkspace, recordInterviewTurn, settleChatTurn,
  type WorkspaceMeta, type WorkspaceState } from "../src/lib/discovery-workspace-model";

let sequence = 0;
const meta = (): WorkspaceMeta => ({ actorId: "consultant", at: "2026-10-21T10:00:00.000Z", id: `evt_${++sequence}` });
const start = () => createWorkspace({ variantCode: "PUMP", variantName: "Pump order to cash", targetProduct: "S4HANA_CLOUD_PRIVATE",
  targetRelease: null, problemStatement: "Orders are keyed twice and invoices are late." }, meta());
const send = (state: WorkspaceState, text: string) => {
  const m = meta();
  return { state: applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text }, m), id: m.id };
};
const why = "It fixes the first handoff.";

/** The race: chat asked two gaps for message M; extraction of M then proposed answers to both before the chat turn is saved. */
function raceFixture() {
  const { state: sent, id } = send(start(), "The scale is 40 orders a day and the owner is Priya.");
  const chat = { schemaVersion: 1, contextRevision: sent.revision, reply: "Thank you for that context.",
    questions: [{ gapKey: "g_process_owner", question: "Who owns the process?", whyItMatters: why },
      { gapKey: "g_operating_scale", question: "How large is the operation?", whyItMatters: why }] };
  expect(validateChatTurn(buildInterviewInput(sent, id), chat).success).toBe(true);
  const extraction = { questions: [], observations: [], proposedUpdates: [
    { fieldId: "process_owner", operation: "PROPOSE_SET", previousValue: null, value: "the owner is Priya", sourceId: id, quote: "the owner is Priya" },
    { fieldId: "operating_scale", operation: "PROPOSE_SET", previousValue: null, value: "40 orders a day", sourceId: id, quote: "40 orders a day" }] };
  const extracted = recordInterviewTurn(sent, extraction, id, meta(), "extraction");
  return { extracted, id, chat };
}

describe("a chat turn saved after its asked gaps were closed", () => {
  it("is topped up with questions for still-open gaps instead of being saved without a question", () => {
    const { extracted, id, chat } = raceFixture();
    const input = buildInterviewInput(extracted, id);
    expect(input.activeGaps.length).toBeGreaterThan(0);
    expect(input.activeGaps.map(g => g.key)).not.toContain("g_process_owner");
    const settled = settleChatTurn(extracted, id, chat) as { questions: { gapKey: string; question: string }[] };
    expect(settled.questions.length).toBe(2);
    const open = new Set(input.activeGaps.map(g => g.key));
    for (const q of settled.questions) { expect(open.has(q.gapKey)).toBe(true); expect(q.question.length).toBeGreaterThan(10); }
    expect(new Set(settled.questions.map(q => q.gapKey)).size).toBe(2);
    expect(revalidateStoredTurn(input, settled, "chat").success).toBe(true);
    const saved = recordInterviewTurn(extracted, settled, id, meta(), "chat");
    expect(saved.questions.length).toBe(2);
    expect(saved.messages.at(-1)!.text.split("\n\n").length).toBe(3); // reply + two questions
  });

  it("keeps a question whose gap is still open and never re-asks a closed gap", () => {
    const { extracted, id, chat } = raceFixture();
    const mixed = { ...chat, questions: [chat.questions[0]!, { gapKey: "g_scope_boundary", question: "Where does it begin and end?", whyItMatters: why }] };
    const settled = settleChatTurn(extracted, id, mixed) as { questions: { gapKey: string; question: string }[] };
    expect(settled.questions[0]).toMatchObject({ gapKey: "g_scope_boundary", question: "Where does it begin and end?" });
    expect(settled.questions.map(q => q.gapKey)).not.toContain("g_process_owner");
    expect(settled.questions.length).toBe(2);
  });

  it("changes nothing when every asked gap is still open", () => {
    const { state, id } = send(start(), "Hello");
    const turn = { reply: "Thank you for that context.", questions: [{ gapKey: "g_process_owner", question: "Who owns it?", whyItMatters: why }] };
    expect(settleChatTurn(state, id, turn)).toBe(turn);
  });
});

describe("one question can cover several fields of one step", () => {
  function twoStepState() {
    let state = applyWorkspaceCommand(start(), { type: "START_STEP_DRAFT" }, meta());
    state = applyWorkspaceCommand(state, { type: "START_STEP_DRAFT" }, meta());
    const [a, b] = state.stepDrafts.map(d => d.id) as [string, string];
    for (let i = 0; i < 3; i++) state = send(state, `Message ${i}`).state;
    const first = send(state, "Walkthrough text");
    state = recordInterviewTurn(first.state, { reply: "Thank you for that context.", proposedUpdates: [], observations: [],
      questions: [{ gapKey: `gstep_${a}`, question: "Walk me through the first stage?", whyItMatters: why }] }, first.id, meta(), "chat");
    const next = send(send(state, "More").state, "Even more");
    return { a, b, ...next };
  }

  it("accepts gapKeys of the same step, stores each as asked, and refuses other steps or walkthrough keys", () => {
    const { a, b, state, id } = twoStepState();
    const input = buildInterviewInput(state, id);
    const keys = input.activeGaps.filter(g => g.stepId === a && !g.key.startsWith("gstep_")).map(g => g.key);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    const foreign = input.activeGaps.find(g => g.stepId === b)!.key;
    const turn = { reply: "Thank you for that context.", questions: [{ gapKey: keys[0]!,
      question: "Who does the first stage, in which system, and what starts it?", whyItMatters: why,
      gapKeys: [keys[1]!, keys[2]!, foreign, keys[0]!] }] };
    const result = validateChatTurn(input, turn);
    expect(result).toMatchObject({ success: true, data: { questions: [{ gapKey: keys[0], gapKeys: [keys[1], keys[2]] }] } });
    const saved = recordInterviewTurn(state, (result as { data: unknown }).data, id, meta(), "chat");
    expect(saved.questions.slice(-3).map(q => q.gapKey)).toEqual([keys[0], keys[1], keys[2]]);
    const again = send(saved, "Answer");
    expect(buildInterviewInput(again.state, again.id).activeGaps.map(g => g.key)).not.toContain(keys[1]);
  });

  it("lists every incomplete step's blank fields to the model, even when its walkthrough gap is not among the shown gaps", () => {
    let state = start();
    for (let i = 0; i < 6; i++) state = applyWorkspaceCommand(state, { type: "START_STEP_DRAFT" }, meta());
    const { state: sent, id } = send(state, "Each step is done by a clerk.");
    const input = buildInterviewInput(sent, id);
    const listed = new Set(input.fields.map(f => f.id));
    for (const draft of sent.stepDrafts) expect(listed.has(`${draft.id}_actor`)).toBe(true);
  });
});
