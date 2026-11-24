// A pasted paragraph states who/system/trigger of each step. A proposed step carries those details, accepting it records them
// as known facts with evidence, and the "Finish Step" sentence names only what is still missing. A step proposed without
// details (as stored workspaces have) keeps the old behaviour: only name and description are known.
import { describe, expect, it } from "vitest";
import { MAX_REQUEUED_EXTRACTIONS, missedExtractions } from "../src/lib/consultant-extraction";
import { applyWorkspaceCommand, buildInterviewInput, createWorkspace, getWorkspaceReadiness, recordInterviewTurn,
  type WorkspaceMeta, type WorkspaceState } from "../src/lib/discovery-workspace-model";
import { describeBlocker } from "../src/lib/workspace-fields";

let sequence = 0;
const meta = (): WorkspaceMeta => ({ actorId: "consultant", at: "2026-11-18T10:00:00.000Z", id: `evt_${++sequence}` });
const send = (state: WorkspaceState, text: string) => {
  const m = meta();
  return { state: applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text }, m), id: m.id };
};

const S1 = "A customer returns rented equipment at the depot counter.";
const S1b = "The depot clerk books the return in the RentPro system when the customer arrives, and then the clerk inspects the item.";
const S2 = "Billing runs in SAP when the return is booked.";
const S2b = "The billing analyst sends the final invoice from SAP after the return is booked, and the customer receives it by email.";
const PARAGRAPH = `${S1} ${S1b} ${S2} ${S2b}`;

function acceptedTwoSteps() {
  let state = createWorkspace({ variantCode: "RENTAL", variantName: "Equipment rental", targetProduct: "S4HANA_CLOUD_PRIVATE",
    targetRelease: null, problemStatement: "Returns are recorded late and bills are disputed." }, meta());
  const sent = send(state, PARAGRAPH);
  state = sent.state;
  // What a valid extraction of that paragraph looks like once the server has resolved sentence ids to quotes
  // (no model call: the turn is scripted). Extraction scope, as the background worker records it.
  state = recordInterviewTurn(state, { questions: [], observations: [], proposedUpdates: [], proposedRequirements: [],
    proposedSteps: [{ sourceId: sent.id, quote: `${S1} ${S1b}`, nameHint: "A customer returns rented equipment",
      details: [{ key: "actor", value: "The depot clerk", quote: S1b }, { key: "system", value: "RentPro", quote: S1b },
        { key: "trigger", value: "the customer arrives", quote: S1b }] },
      { sourceId: sent.id, quote: `${S2} ${S2b}`, nameHint: "Billing runs in SAP" }] }, sent.id, meta(), "extraction");
  state = applyWorkspaceCommand(state, { type: "DECIDE_PROPOSALS", ids: state.proposals.map(p => p.id), decision: "ACCEPT" }, meta());
  return { state, paragraphId: sent.id };
}

const field = (state: WorkspaceState, draftIndex: number, key: string) => {
  const draft = state.stepDrafts[draftIndex]!;
  return draft.fields.find(f => f.id === `${draft.id}_${key}`)!;
};

describe("a proposed step carries the details its paragraph states", () => {
  it("accepting fills the stated details as known facts with evidence; the rest stay EMPTY", () => {
    const { state, paragraphId } = acceptedTwoSteps();
    expect(state.stepDrafts).toHaveLength(2);
    for (const [key, value] of [["actor", "The depot clerk"], ["system", "RentPro"], ["trigger", "the customer arrives"]] as const) {
      const fact = field(state, 0, key);
      expect(fact.status).toBe("KNOWN");
      expect(fact.value).toBe(value);
      expect(fact.evidence).toEqual({ sourceId: paragraphId, quote: S1b });
    }
    for (const key of ["inputs", "outputs", "controls", "exceptions"]) expect(field(state, 0, key).status).toBe("EMPTY");
  });

  it("a step proposed without details is unchanged: only description and name are known", () => {
    const { state } = acceptedTwoSteps();
    expect(field(state, 1, "description").status).toBe("KNOWN");
    expect(field(state, 1, "name").status).toBe("KNOWN");
    for (const key of ["actor", "system", "trigger", "inputs", "outputs", "controls", "exceptions"]) expect(field(state, 1, key).status).toBe("EMPTY");
  });

  it("the still-needed sentence names only what is missing for that step", () => {
    const { state } = acceptedTwoSteps();
    const incomplete = getWorkspaceReadiness(state).blockers.filter(b => b.code === "AS_IS_STEP_INCOMPLETE");
    expect(incomplete).toHaveLength(2);
    expect(describeBlocker(state, incomplete[0]!)).toBe("Finish Step 1 (A customer returns rented equipment): inputs, outputs, controls and exceptions.");
    expect(describeBlocker(state, incomplete[1]!)).toBe(
      "Finish Step 2 (Billing runs in SAP): who does it, system, trigger, inputs, outputs, controls and exceptions.");
  });

  it("the paragraph's message is marked extracted and is never queued again for the new steps", () => {
    const { state, paragraphId } = acceptedTwoSteps();
    expect(state.extractedMessageIds).toContain(paragraphId);
    const next = send(state, "Thanks");
    expect(missedExtractions(next.state.messages, next.state.extractedMessageIds, new Set(), next.id, MAX_REQUEUED_EXTRACTIONS)).toEqual([]);
    // Extraction of the next message may not even run for this step: recordInterviewTurn refuses a second extraction of the same message.
    expect(() => recordInterviewTurn(next.state, { questions: [], observations: [], proposedUpdates: [], proposedSteps: [], proposedRequirements: [] },
      paragraphId, meta(), "extraction")).toThrow("ALREADY_EXTRACTED");
  });

  it("H2: the paragraph stays quotable for the next 3 user messages only, then leaves the model's evidence", () => {
    let { state } = acceptedTwoSteps();
    const ids: string[] = [];
    for (let n = 1; n <= 4; n++) {
      const sent = send(state, `Follow-up message number ${n}.`);
      state = sent.state; ids.push(sent.id);
      const paragraphVisible = buildInterviewInput(state, sent.id).evidence.some(e => e.text === PARAGRAPH);
      expect(paragraphVisible, `message ${n}`).toBe(n <= 3);
    }
    // The still-empty step fields are listed to the model for the 1st follow-up (step 2's actor; step 1's came with its proposal).
    const first = buildInterviewInput(state, ids[0]!);
    expect(first.fields.filter(f => /_actor$/.test(f.id) && f.status === "EMPTY")).toHaveLength(1);
  });

  it("a step whose core details are filled still lists the four list fields, in the sentence too", () => {
    let { state } = acceptedTwoSteps();
    const paragraphSourceId = state.sources.find(s => s.text === PARAGRAPH)!.id;
    const set = (index: number, key: string, value: string, quote: string) => {
      state = applyWorkspaceCommand(state, { type: "SET_STEP_DRAFT_FIELD", fieldId: `${state.stepDrafts[index]!.id}_${key}`,
        status: "KNOWN", value, rationale: null, owner: null, sourceId: paragraphSourceId, quote }, meta());
    };
    set(1, "actor", "The billing analyst", "The billing analyst");
    set(1, "system", "SAP", "SAP");
    set(1, "trigger", "the return is booked", "the return is booked");
    const blockers = getWorkspaceReadiness(state).blockers.filter(b => b.code === "AS_IS_STEP_INCOMPLETE");
    expect(blockers.some(b => b.detail.endsWith(state.stepDrafts[1]!.id))).toBe(true); // lists are required even with the core filled
    expect(describeBlocker(state, blockers[1]!)).toBe("Finish Step 2 (Billing runs in SAP): inputs, outputs, controls and exceptions.");
  });
});
