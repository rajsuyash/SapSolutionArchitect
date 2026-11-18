import { describe, expect, it } from "vitest";
import { OBSERVATION_CLOSE_REASON, WORKSPACE_FIELDS, isPossiblySettled } from "../src/lib/workspace-fields";
import { applyWorkspaceCommand, compileDiscovery, createWorkspace, getWorkspaceReadiness, recordInterviewTurn, WorkspaceStateSchema,
  type WorkspaceMeta, type WorkspaceState } from "../src/lib/discovery-workspace-model";

let sequence = 0;
const meta = (): WorkspaceMeta => ({ actorId: "consultant", at: "2026-10-21T10:00:00.000Z", id: `evt_${++sequence}` });
const start = () => createWorkspace({ variantCode: "RENTAL", variantName: "Equipment rental", targetProduct: "S4HANA_CLOUD_PRIVATE",
  targetRelease: null, problemStatement: "Returns are recorded late and bills are disputed." }, meta());
const set = (state: WorkspaceState, fieldId: string, status: "KNOWN" | "NOT_APPLICABLE", value: string | null = "An answer") =>
  applyWorkspaceCommand(state, { type: "SET_FIELD", fieldId, status, value: status === "KNOWN" ? value : null,
    rationale: status === "KNOWN" ? null : "Does not apply here", owner: null, sourceId: null, quote: null }, meta());

type Seen = { kind: "POSSIBLE_CONFLICT" | "FOLLOW_UP_SUGGESTION"; fieldIds: string[]; detail: string };
const seen = (kind: Seen["kind"], fieldIds: string[], detail = "Check this.") => ({ kind, fieldIds, detail });
/** One extraction of a fresh user message that reports these observations. */
function extract(state: WorkspaceState, observations: Seen[]): WorkspaceState {
  const message = meta();
  const withMessage = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "Billing says the return was yesterday." }, message);
  return recordInterviewTurn(withMessage, { schemaVersion: 1, contextRevision: withMessage.revision, proposedUpdates: [], observations },
    message.id, meta(), "extraction");
}
const pending = (state: WorkspaceState) => state.observations.filter(o => o.status === "PENDING");

describe("recording points to check", () => {
  it("records one point when the same kind and the same fields are already pending, whatever the field order", () => {
    let state = extract(start(), [seen("FOLLOW_UP_SUGGESTION", ["current_systems", "current_trigger"], "First wording.")]);
    state = extract(state, [seen("FOLLOW_UP_SUGGESTION", ["current_trigger", "current_systems"], "Second wording.")]);
    expect(state.observations).toHaveLength(1);
    expect(state.observations[0]!.detail).toBe("First wording.");
  });

  it("de-duplicates inside one turn and still records the rest of the turn", () => {
    const state = extract(start(), [seen("FOLLOW_UP_SUGGESTION", ["current_rules"]), seen("FOLLOW_UP_SUGGESTION", ["current_rules"], "Again."),
      seen("POSSIBLE_CONFLICT", ["current_exceptions"])]);
    expect(state.observations.map(o => [o.kind, o.fieldIds])).toEqual([["FOLLOW_UP_SUGGESTION", ["current_rules"]], ["POSSIBLE_CONFLICT", ["current_exceptions"]]]);
    expect(new Set(state.observations.map(o => o.id)).size).toBe(2);
  });

  it("keeps both when the kind differs or the field set differs", () => {
    let state = extract(start(), [seen("FOLLOW_UP_SUGGESTION", ["current_rules"])]);
    state = extract(state, [seen("POSSIBLE_CONFLICT", ["current_rules"]), seen("FOLLOW_UP_SUGGESTION", ["current_rules", "current_trigger"]),
      seen("FOLLOW_UP_SUGGESTION", ["current_trigger"])]);
    expect(state.observations).toHaveLength(4);
  });

  it("does not compare against a dismissed or resolved point, so a closed point can be raised again", () => {
    let state = extract(start(), [seen("FOLLOW_UP_SUGGESTION", ["current_rules"]), seen("POSSIBLE_CONFLICT", ["current_trigger"])]);
    state = applyWorkspaceCommand(state, { type: "REVIEW_OBSERVATION", observationId: state.observations[0]!.id, decision: "DISMISS", rationale: "Not relevant." }, meta());
    state = applyWorkspaceCommand(state, { type: "REVIEW_OBSERVATION", observationId: state.observations[1]!.id, decision: "RESOLVE", rationale: "Checked." }, meta());
    state = extract(state, [seen("FOLLOW_UP_SUGGESTION", ["current_rules"]), seen("POSSIBLE_CONFLICT", ["current_trigger"])]);
    expect(state.observations.map(o => o.status)).toEqual(["DISMISSED", "RESOLVED", "PENDING", "PENDING"]);
  });
});

describe("possibly settled points", () => {
  const follow = (fieldIds: string[]) => ({ kind: "FOLLOW_UP_SUGGESTION" as const, status: "PENDING" as const, fieldIds });

  it("is settled when every field is known or not applicable, and not when one is still empty", () => {
    let state = set(start(), "current_systems", "KNOWN");
    expect(isPossiblySettled(state, follow(["current_systems"]))).toBe(true);
    state = set(state, "current_rules", "NOT_APPLICABLE");
    expect(isPossiblySettled(state, follow(["current_systems", "current_rules"]))).toBe(true);
    expect(isPossiblySettled(state, follow(["current_systems", "current_trigger"]))).toBe(false);
  });

  it("is not settled when a field is unknown or waiting on the owner", () => {
    let state = applyWorkspaceCommand(start(), { type: "SET_FIELD", fieldId: "current_systems", status: "UNKNOWN", value: null,
      rationale: "Not known yet", owner: null, sourceId: null, quote: null }, meta());
    expect(isPossiblySettled(state, follow(["current_systems"]))).toBe(false);
    state = applyWorkspaceCommand(state, { type: "SET_FIELD", fieldId: "current_systems", status: "OWNER_PENDING", value: null,
      rationale: null, owner: "Dana", sourceId: null, quote: null }, meta());
    expect(isPossiblySettled(state, follow(["current_systems"]))).toBe(false);
  });

  it("is not settled when a field id does not resolve, and a conflict is never settled", () => {
    const state = set(start(), "current_systems", "KNOWN");
    expect(isPossiblySettled(state, follow(["current_systems", "no_such_field"]))).toBe(false);
    expect(isPossiblySettled(state, { ...follow(["current_systems"]), kind: "POSSIBLE_CONFLICT" })).toBe(false);
    expect(isPossiblySettled(state, { ...follow(["current_systems"]), status: "DISMISSED" })).toBe(false);
  });

  it("resolves step-draft and requirement-draft field ids", () => {
    let state = applyWorkspaceCommand(start(), { type: "START_STEP_DRAFT" }, meta());
    const draft = state.stepDrafts[0]!;
    expect(isPossiblySettled(state, follow([`${draft.id}_actor`]))).toBe(false);
    state = applyWorkspaceCommand(state, { type: "SET_STEP_DRAFT_FIELD", fieldId: `${draft.id}_actor`, status: "KNOWN", value: "Clerk",
      rationale: null, owner: null, sourceId: null, quote: null }, meta());
    expect(isPossiblySettled(state, follow([`${draft.id}_actor`]))).toBe(true);
    state = applyWorkspaceCommand(state, { type: "START_REQUIREMENT_DRAFT", asIsStepId: draft.id, kind: "PAIN_POINT", critical: false }, meta());
    const requirement = state.requirementDrafts[0]!;
    expect(isPossiblySettled(state, follow([`${requirement.id}_statement`]))).toBe(false);
    state = applyWorkspaceCommand(state, { type: "SET_REQUIREMENT_DRAFT_STATEMENT", requirementDraftId: requirement.id, status: "KNOWN",
      value: "Late entry", rationale: null, owner: null, sourceId: null, quote: null }, meta());
    expect(isPossiblySettled(state, follow([`${requirement.id}_statement`]))).toBe(true);
  });

  it("closing with the fixed reason records the reviewer and reason, and closing twice fails as before", () => {
    let state = extract(set(start(), "current_systems", "KNOWN"), [seen("FOLLOW_UP_SUGGESTION", ["current_systems"])]);
    const id = state.observations[0]!.id;
    const close = { type: "REVIEW_OBSERVATION" as const, observationId: id, decision: "RESOLVE" as const, rationale: OBSERVATION_CLOSE_REASON };
    state = applyWorkspaceCommand(state, close, meta());
    expect(state.observations[0]).toMatchObject({ status: "RESOLVED", rationale: OBSERVATION_CLOSE_REASON, reviewedBy: "consultant" });
    expect(() => applyWorkspaceCommand(state, close, meta())).toThrow("OBSERVATION_NOT_PENDING");
  });

  /** Every catalog answer, one named step draft with gaps and one requirement: confirmable as a draft, so it can be compiled. */
  const draftReady = () => {
    let state = start();
    for (const def of WORKSPACE_FIELDS) if (state.facts.find(f => f.id === def.id)!.status === "EMPTY") state = set(state, def.id, "KNOWN");
    state = applyWorkspaceCommand(state, { type: "START_STEP_DRAFT" }, meta());
    const id = state.stepDrafts[0]!.id;
    state = applyWorkspaceCommand(state, { type: "SET_STEP_DRAFT_FIELD", fieldId: `${id}_name`, status: "KNOWN", value: "Record return",
      rationale: null, owner: null, sourceId: null, quote: null }, meta());
    state = applyWorkspaceCommand(state, { type: "START_REQUIREMENT_DRAFT", asIsStepId: id, kind: "PAIN_POINT", critical: true }, meta());
    return applyWorkspaceCommand(state, { type: "SET_REQUIREMENT_DRAFT_STATEMENT", requirementDraftId: state.requirementDrafts[0]!.id,
      status: "KNOWN", value: "Late entry", rationale: null, owner: null, sourceId: null, quote: null }, meta());
  };

  it("still counts as pending in readiness and is still exported as an open question until it is closed", () => {
    const state = extract(draftReady(), [seen("FOLLOW_UP_SUGGESTION", ["current_systems"], "Check the systems again.")]);
    expect(isPossiblySettled(state, state.observations[0]!)).toBe(true);
    expect(getWorkspaceReadiness(state).blockers.map(b => b.code)).toContain("OBSERVATIONS_PENDING");
    const exported = (s: WorkspaceState) => compileDiscovery(s, { allowGaps: true }).openQuestions.map(q => q.question);
    expect(exported(state)).toContain("Check the systems again.");
    const closed = applyWorkspaceCommand(state, { type: "REVIEW_OBSERVATION", observationId: state.observations[0]!.id, decision: "RESOLVE",
      rationale: OBSERVATION_CLOSE_REASON }, meta());
    expect(getWorkspaceReadiness(closed).blockers.map(b => b.code)).not.toContain("OBSERVATIONS_PENDING");
    expect(exported(closed)).not.toContain("Check the systems again.");
  });

  it("a stored state from before the change still validates", () => {
    const state = extract(start(), [seen("FOLLOW_UP_SUGGESTION", ["current_rules"])]);
    expect(WorkspaceStateSchema.safeParse(JSON.parse(JSON.stringify(state))).success).toBe(true);
    expect(pending(state)).toHaveLength(1);
  });
});
