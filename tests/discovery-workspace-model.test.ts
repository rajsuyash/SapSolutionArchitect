import { describe, expect, it } from "vitest";
import { buildInterviewInput, compileDiscovery, createWorkspace, getWorkspaceReadiness,
  applyWorkspaceCommand, recordInterviewTurn, type WorkspaceMeta, type WorkspaceState } from "../src/lib/discovery-workspace-model";

let sequence = 0;
const meta = (): WorkspaceMeta => ({ actorId: "consultant", at: "2026-10-21T10:00:00.000Z", id: `evt_${++sequence}` });
const start = () => createWorkspace({ variantCode: "RENTAL", variantName: "Equipment rental",
  targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: null,
  problemStatement: "Returns are recorded late and bills are disputed." }, meta());
const set = (state: WorkspaceState, fieldId: string, value: string) => applyWorkspaceCommand(state,
  { type: "SET_FIELD", fieldId, status: "KNOWN", value, rationale: null, owner: null, sourceId: null, quote: null }, meta());
const step = { name: "Record return", actor: "Stores clerk", system: "Spreadsheet", trigger: "Equipment arrives",
  description: "Stores clerk records the physical return in a spreadsheet.", inputs: ["Return note"],
  outputs: ["Spreadsheet row"], controls: ["Clerk checks asset ID"], exceptions: ["Missing return date"] };

describe("discovery workspace model", () => {
  it("starts with a structured As-Is and desired catalog, without invented facts", () => {
    const state = start();
    expect(state.facts.find(f => f.id === "business_problem")?.status).toBe("KNOWN");
    expect(state.facts.find(f => f.id === "current_trigger")?.status).toBe("EMPTY");
    expect(state.facts.find(f => f.id === "desired_outcome")?.status).toBe("EMPTY");
    expect(getWorkspaceReadiness(state).blockers.map(b => b.code)).toContain("AS_IS_STEP_MISSING");
    expect(() => applyWorkspaceCommand(state, { type: "CONFIRM" }, meta())).toThrow("WORKSPACE_NOT_READY");
  });

  it("asks only unanswered catalog gaps, validates model quotes and requires separate acceptance", () => {
    let state = start();
    const messageMeta = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE",
      text: "The clerk records physical returns in a spreadsheet. We need faster billing corrections." }, messageMeta);
    const context = buildInterviewInput(state, messageMeta.id);
    expect(context.activeGaps.find(g => g.fieldId === "current_systems")?.detail).toContain("current practice");
    expect(context.activeGaps.find(g => g.fieldId === "desired_outcome")?.detail).toContain("desired future");
    const quote = "The clerk records physical returns in a spreadsheet.";
    const turn = { schemaVersion: 1, contextRevision: state.revision, reply: "Thank you for that context.",
      questions: [{ gapKey: "g_current_trigger", question: "What starts the current return process?",
        whyItMatters: "This identifies the first handoff." }],
      proposedUpdates: [{ fieldId: "current_systems", operation: "PROPOSE_SET", previousValue: null,
        value: quote, sourceId: messageMeta.id, quote }], observations: [] };
    expect(() => recordInterviewTurn(state, { ...turn, proposedUpdates: [{ ...turn.proposedUpdates[0], quote: "Invented" }] },
      messageMeta.id, meta())).toThrow("INVALID_INTERVIEW_TURN");
    state = recordInterviewTurn(state, turn, messageMeta.id, meta());
    expect(state.facts.find(f => f.id === "current_systems")?.status).toBe("EMPTY");
    expect(state.proposals[0]?.status).toBe("PENDING");
    expect(state.questions[0]?.gapKey).toBe("g_current_trigger");
    expect(buildInterviewInput(state, messageMeta.id).activeGaps.some(g => g.key === "g_current_trigger")).toBe(false);
    state = applyWorkspaceCommand(state, { type: "DECIDE_PROPOSAL", proposalId: state.proposals[0]!.id,
      decision: "ACCEPT" }, meta());
    expect(state.facts.find(f => f.id === "current_systems")?.evidence).toEqual({ sourceId: messageMeta.id, quote });
    expect(() => applyWorkspaceCommand(state, { type: "DECIDE_PROPOSAL", proposalId: state.proposals[0]!.id,
      decision: "ACCEPT" }, meta())).toThrow("PROPOSAL_NOT_PENDING");
  });

  it("retains model conflict suggestions for explicit review without treating them as facts", () => {
    let state = start();
    const messageMeta = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "Billing says the return was yesterday." }, messageMeta);
    state = recordInterviewTurn(state, { schemaVersion: 1, contextRevision: state.revision,
      reply: "Let's review what you've shared.", questions: [], proposedUpdates: [], observations: [{
        kind: "POSSIBLE_CONFLICT", fieldIds: ["current_trigger"], detail: "The return date may differ from the billing date.",
      }] }, messageMeta.id, meta());
    expect(state.observations[0]?.status).toBe("PENDING");
    expect(getWorkspaceReadiness(state).blockers.map(b => b.code)).toContain("OBSERVATIONS_PENDING");
    state = applyWorkspaceCommand(state, { type: "REVIEW_OBSERVATION", observationId: state.observations[0]!.id,
      decision: "RESOLVE", rationale: "The owner confirmed these are separate dates." }, meta());
    expect(state.observations[0]?.reviewedBy).toBe("consultant");
    expect(state.facts.find(f => f.id === "current_trigger")?.value).toBeNull();
  });

  it("keeps unknown, not applicable and owner pending distinct and requires reasons", () => {
    let state = start();
    expect(() => applyWorkspaceCommand(state, { type: "SET_FIELD", fieldId: "current_financial",
      status: "NOT_APPLICABLE", value: null, rationale: null, owner: null, sourceId: null, quote: null }, meta()))
      .toThrow("INVALID_FIELD_STATUS");
    state = applyWorkspaceCommand(state, { type: "SET_FIELD", fieldId: "current_financial",
      status: "NOT_APPLICABLE", value: null, rationale: "No financial posting in this variant", owner: null,
      sourceId: null, quote: null }, meta());
    state = applyWorkspaceCommand(state, { type: "SET_FIELD", fieldId: "current_rules",
      status: "OWNER_PENDING", value: null, rationale: "Approval policy needs validation", owner: "Finance owner",
      sourceId: null, quote: null }, meta());
    state = applyWorkspaceCommand(state, { type: "SET_FIELD", fieldId: "current_exceptions",
      status: "UNKNOWN", value: null, rationale: null, owner: null, sourceId: null, quote: null }, meta());
    expect(state.facts.map(f => f.status)).toEqual(expect.arrayContaining(["UNKNOWN", "OWNER_PENDING", "NOT_APPLICABLE"]));
    expect(compileDiscovery).toBeTypeOf("function");
  });

  it("compiles reviewed current steps and desired requirements with exact evidence, then invalidates confirmation on edit", () => {
    let state = start();
    state = set(state, "process_owner", "Rental operations manager");
    state = set(state, "scope_boundary", "From customer return through final billing");
    state = set(state, "current_trigger", "Equipment arrives at the depot");
    state = set(state, "desired_outcome", "Correct final invoices within one business day");
    state = set(state, "current_systems", "Return spreadsheet and finance system");
    state = set(state, "current_rules", "Stores clerk checks asset ID");
    state = set(state, "current_exceptions", "Manager investigates missing return date");
    state = set(state, "current_financial", "Finance issues the final invoice");
    state = set(state, "desired_controls", "Record the return date and reviewer");
    state = applyWorkspaceCommand(state, { type: "ADD_STEP", step }, meta());
    const stepId = state.steps[0]!.id;
    state = applyWorkspaceCommand(state, { type: "ADD_REQUIREMENT", requirement: {
      asIsStepId: stepId, kind: "PAIN_POINT", statement: "Late return recording causes invoice disputes", critical: true,
    } }, meta());
    expect(getWorkspaceReadiness(state).ready).toBe(true);
    const compiled = compileDiscovery(state);
    expect(compiled.asIsSteps[0]?.description).toBe(step.description);
    expect(compiled.requirements[0]?.kind).toBe("PAIN_POINT");
    expect(compiled.sources.find(s => s.id === compiled.requirements[0]?.evidence.sourceId)?.text)
      .toContain(compiled.requirements[0]!.evidence.quote);
    state = applyWorkspaceCommand(state, { type: "CONFIRM" }, meta());
    expect(state.confirmation?.revision).toBe(state.revision);
    state = set(state, "desired_outcome", "Correct final invoices on the same day");
    expect(state.confirmation).toBeNull();
    expect(state.steps[0]?.description).toBe(step.description);
  });

  it("fills an As-Is step progressively from accepted chat proposals", () => {
    let state = start();
    state = applyWorkspaceCommand(state, { type: "START_STEP_DRAFT" }, meta());
    const draft = state.stepDrafts[0]!;
    const values = ["Receive return", "Stores clerk", "Spreadsheet", "Truck arrives", "Clerk enters asset ID and return date",
      "Return note", "Return log", "Asset ID check", "Missing date escalated to manager"];
    const messageMeta = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: values.join(". ") }, messageMeta);
    const input = buildInterviewInput(state, messageMeta.id);
    expect(input.fields.some(f => f.id === `${draft.id}_description`)).toBe(true);
    expect(input.activeGaps.find(g => g.fieldId === `${draft.id}_exceptions`)?.detail).toContain("today");
    const turn = { schemaVersion: 1, contextRevision: state.revision, reply: "Thank you for that context.",
      questions: [], observations: [], proposedUpdates: draft.fields.map((fact, index) => ({
        fieldId: fact.id, operation: "PROPOSE_SET", previousValue: null, value: values[index],
        sourceId: messageMeta.id, quote: values[index],
      })) };
    state = recordInterviewTurn(state, turn, messageMeta.id, meta());
    expect(getWorkspaceReadiness(state).blockers.map(b => b.code)).toContain("AS_IS_STEP_INCOMPLETE");
    for (const proposal of [...state.proposals]) {
      state = applyWorkspaceCommand(state, { type: "DECIDE_PROPOSAL", proposalId: proposal.id, decision: "ACCEPT" }, meta());
    }
    expect(getWorkspaceReadiness(state).blockers.map(b => b.code)).not.toContain("AS_IS_STEP_INCOMPLETE");
    state = applyWorkspaceCommand(state, { type: "START_REQUIREMENT_DRAFT", asIsStepId: draft.id,
      kind: "PAIN_POINT", critical: true }, meta());
    const requirementDraft = state.requirementDrafts[0]!;
    const painMeta = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "Late return entry delays billing", }, painMeta);
    const painInput = buildInterviewInput(state, painMeta.id);
    expect(painInput.activeGaps.some(g => g.fieldId === requirementDraft.statement.id)).toBe(true);
    state = recordInterviewTurn(state, { schemaVersion: 1, contextRevision: state.revision,
      reply: "Thank you for that context.", questions: [], observations: [], proposedUpdates: [{
        fieldId: requirementDraft.statement.id, operation: "PROPOSE_SET", previousValue: null,
        value: "Late return entry delays billing", sourceId: painMeta.id, quote: "Late return entry delays billing",
      }] }, painMeta.id, meta());
    state = applyWorkspaceCommand(state, { type: "DECIDE_PROPOSAL", proposalId: state.proposals.at(-1)!.id,
      decision: "ACCEPT" }, meta());
    expect(compileDiscovery(state).asIsSteps[0]?.actor).toBe("Stores clerk");
    expect(compileDiscovery(state).asIsSteps[0]?.evidence.quote).toBe(values[4]);
    expect(compileDiscovery(state).requirements[0]?.statement).toBe("Late return entry delays billing");
  });

  it("rejects client-controlled metadata, invalid references and stale model proposals", () => {
    let state = start();
    expect(() => applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "hello", actorId: "intruder" }, meta()))
      .toThrow("INVALID_WORKSPACE_COMMAND");
    expect(() => applyWorkspaceCommand(state, { type: "ADD_REQUIREMENT", requirement: {
      asIsStepId: "missing", kind: "TO_BE_REQUIREMENT", statement: "Automate invoicing", critical: true,
    } }, meta())).toThrow("UNKNOWN_WORKSPACE_STEP");
    expect(() => applyWorkspaceCommand(state, { type: "SET_FIELD", fieldId: "current_trigger", status: "KNOWN",
      value: "Return arrives", rationale: null, owner: null, sourceId: "missing", quote: "Return arrives" }, meta()))
      .toThrow("INVALID_WORKSPACE_EVIDENCE");
    const messageMeta = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "Returns arrive at the depot" }, messageMeta);
    const proposal = { schemaVersion: 1, contextRevision: state.revision, reply: "Thank you for that context.",
      questions: [], observations: [], proposedUpdates: [{ fieldId: "current_trigger", operation: "PROPOSE_SET",
        previousValue: null, value: "Returns arrive at the depot", sourceId: messageMeta.id,
        quote: "Returns arrive at the depot" }] };
    state = recordInterviewTurn(state, proposal, messageMeta.id, meta());
    state = set(state, "current_trigger", "A driver checks in a return");
    expect(() => applyWorkspaceCommand(state, { type: "DECIDE_PROPOSAL", proposalId: state.proposals[0]!.id,
      decision: "ACCEPT" }, meta())).toThrow("STALE_PROPOSAL");
  });
});
