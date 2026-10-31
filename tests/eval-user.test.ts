import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyWorkspaceCommand, createWorkspace, getWorkspaceReadiness, type WorkspaceMeta, type WorkspaceState } from "../src/lib/discovery-workspace-model";
import { answerFor, fieldCommand, planForcedCompletion, type Fixture } from "../src/lib/eval-user";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/eval/pump-o2c.json", import.meta.url), "utf8")) as Fixture;
let n = 0;
const meta = (): WorkspaceMeta => ({ actorId: "consultant", at: "2026-10-21T10:00:00.000Z", id: `evt_${++n}` });
const apply = (state: WorkspaceState, command: unknown) => applyWorkspaceCommand(state, command as never, meta());

describe("forced completion plan", () => {
  it("clears step and requirement blockers even for steps that resemble no fixture step, and names what it cannot clear", () => {
    let state = createWorkspace({ variantCode: "O2C", variantName: "Quote to report", targetProduct: "S4HANA_CLOUD_PUBLIC",
      targetRelease: null, problemStatement: "Order to cash is manual." }, meta());
    for (let i = 0; i < 2; i++) state = apply(state, { type: "START_STEP_DRAFT" });
    const [odd, blank] = state.stepDrafts.map(d => d.id) as [string, string];
    state = apply(state, fieldCommand(state, `${odd}_name`, "Zzz qqq"));
    state = apply(state, { type: "START_REQUIREMENT_DRAFT", asIsStepId: blank, kind: "PAIN_POINT", critical: true });
    // The old path (a bank answer only for drafts that match a fixture step by words) has nothing for the odd step's actor.
    expect(answerFor(fixture, state, `${blank}_actor`)).toBeNull();
    expect(getWorkspaceReadiness(state).blockers.map(b => b.code)).toEqual(expect.arrayContaining(["AS_IS_STEP_INCOMPLETE", "REQUIREMENT_INCOMPLETE"]));

    const plan = planForcedCompletion(fixture, state);
    expect(plan.unresolved).toEqual([]);
    expect(plan.commands.length).toBeGreaterThan(0);
    for (const command of plan.commands) state = apply(state, command);
    const codes = getWorkspaceReadiness(state).blockers.map(b => b.code);
    expect(codes).not.toContain("AS_IS_STEP_INCOMPLETE");
    expect(codes).not.toContain("REQUIREMENT_INCOMPLETE");
    expect(codes).not.toContain("FIELD_UNANSWERED");
    expect(planForcedCompletion(fixture, state).commands).toEqual([]); // nothing left to do
  });

  it("reports a step it cannot fill when there are more drafts than fixture steps", () => {
    let state = createWorkspace({ variantCode: "O2C", variantName: "Quote to report", targetProduct: "S4HANA_CLOUD_PUBLIC",
      targetRelease: null, problemStatement: "Order to cash is manual." }, meta());
    for (let i = 0; i < fixture.steps.length + 1; i++) state = apply(state, { type: "START_STEP_DRAFT" });
    const plan = planForcedCompletion(fixture, state);
    expect(plan.unresolved).toHaveLength(1);
    expect(plan.unresolved[0]).toContain("no unused fixture step");
  });
});
