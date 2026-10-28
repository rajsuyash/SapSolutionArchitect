import { describe, expect, it } from "vitest";
import { validateExtraction, validateInterviewTurn } from "../src/lib/ai/discovery-interview";
import { MAX_OPEN_QUESTIONS } from "../src/lib/discovery";
import { indexSentences } from "../src/lib/ai/interview-sentences";
import { WORKSPACE_FIELDS } from "../src/lib/workspace-fields";
import { TO_CONFIRM } from "../src/lib/workspace-fields";
import { backfillCatalog, buildInterviewInput, compileDiscovery, createWorkspace, getWorkspaceReadiness,
  applyWorkspaceCommand, asksForToBe, recordInterviewTurn, WorkspaceStateSchema, type WorkspaceMeta, type WorkspaceState } from "../src/lib/discovery-workspace-model";

let sequence = 0;
const meta = (): WorkspaceMeta => ({ actorId: "consultant", at: "2026-10-21T10:00:00.000Z", id: `evt_${++sequence}` });
const start = () => createWorkspace({ variantCode: "RENTAL", variantName: "Equipment rental",
  targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: null,
  problemStatement: "Returns are recorded late and bills are disputed." }, meta());
const set = (state: WorkspaceState, fieldId: string, value: string) => applyWorkspaceCommand(state,
  { type: "SET_FIELD", fieldId, status: "KNOWN", value, rationale: null, owner: null, sourceId: null, quote: null }, meta());
/** A turn must ask while any gap is open: the cheapest valid question. */
const ask = (gapKey = "g_current_trigger", question = `What starts the process (${gapKey})?`) => [{ gapKey, question, whyItMatters: "It fixes the first handoff." }];
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

  it("carries the project's modules and org units into a new variant as known, evidenced answers", () => {
    const state = createWorkspace({ variantCode: "RENTAL", variantName: "Equipment rental", targetProduct: "S4HANA_CLOUD_PRIVATE",
      targetRelease: null, problemStatement: "Returns are recorded late and bills are disputed.", modules: ["FI", "CO", "MM"],
      orgUnits: [{ type: "COMPANY_CODE", code: "1000", name: "Shaktiman Pvt Ltd" }, { type: "PLANT", code: "1100", name: "Bhosari" }] }, meta());
    const source = state.sources.find(s => s.title === "Project details")!;
    expect(source.kind).toBe("USER_ENTRY");
    expect(state.sources).toHaveLength(2);
    const modules = state.facts.find(f => f.id === "modules_in_scope")!, units = state.facts.find(f => f.id === "target_org_units")!;
    expect(modules).toMatchObject({ status: "KNOWN", value: "FI, CO, MM", acceptedBy: "consultant" });
    expect(units).toMatchObject({ status: "KNOWN", acceptedBy: "consultant" });
    expect(units.value).toBe("Company code 1000 Shaktiman Pvt Ltd; Plant 1100 Bhosari");
    expect(source.text).toContain("SAP modules in scope: FI, CO, MM");
    expect(source.text).toContain("Planned organisational units: Company code 1000 Shaktiman Pvt Ltd; Plant 1100 Bhosari");
    for (const fact of [modules, units]) {
      expect(fact.evidence?.sourceId).toBe(source.id);
      expect(source.text.includes(fact.evidence!.quote)).toBe(true);
      expect(fact.evidence!.quote).toBe(fact.value);
    }
    const next = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "Returns come back by truck." }, meta());
    const gaps = buildInterviewInput(next, next.messages.at(-1)!.id).activeGaps.map(g => g.key);
    expect(gaps).not.toContain("g_modules_in_scope");
    expect(gaps).not.toContain("g_target_org_units");
  });

  it("seeds only what the project has: modules alone, org units alone, or neither", () => {
    const base = { variantCode: "RENTAL", variantName: "Equipment rental", targetProduct: "S4HANA_CLOUD_PRIVATE" as const,
      targetRelease: null, problemStatement: "Returns are recorded late and bills are disputed." };
    const fact = (s: WorkspaceState, id: string) => s.facts.find(f => f.id === id)!.status;
    const only = createWorkspace({ ...base, modules: ["SD"], orgUnits: [] }, meta());
    expect([fact(only, "modules_in_scope"), fact(only, "target_org_units")]).toEqual(["KNOWN", "EMPTY"]);
    const units = createWorkspace({ ...base, modules: [], orgUnits: [{ type: "PLANT", code: "1100", name: "Bhosari" }] }, meta());
    expect([fact(units, "modules_in_scope"), fact(units, "target_org_units")]).toEqual(["EMPTY", "KNOWN"]);
    for (const none of [createWorkspace(base, meta()), createWorkspace({ ...base, modules: [], orgUnits: [] }, meta())]) {
      expect(none.sources).toHaveLength(1);
      expect([fact(none, "modules_in_scope"), fact(none, "target_org_units")]).toEqual(["EMPTY", "EMPTY"]);
    }
    expect(() => createWorkspace({ ...base, modules: [""] }, meta())).toThrow("INVALID_WORKSPACE_CREATE");
    expect(() => createWorkspace({ ...base, orgUnits: [{ type: "BOGUS", code: "1", name: "x" } as never] }, meta())).toThrow("INVALID_WORKSPACE_CREATE");
  });

  it("asks only unanswered catalog gaps, validates model quotes and requires separate acceptance", () => {
    let state = start();
    const messageMeta = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE",
      text: "The clerk records physical returns in a spreadsheet. We need faster billing corrections." }, messageMeta);
    const context = buildInterviewInput(state, messageMeta.id);
    expect(context.activeGaps.find(g => g.fieldId === "current_systems")?.detail).toContain("current practice");
    expect(context.activeGaps.length).toBeLessThanOrEqual(15); // only the head of the list is shown
    expect(context.fields.find(f => f.id === "desired_outcome")?.label).toContain("DESIRED");
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
      reply: "Let's review what you've shared.", questions: ask("g_current_systems"), proposedUpdates: [], observations: [{
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
    for (const def of WORKSPACE_FIELDS) { // the company-context fields are required too
      if (state.facts.find(f => f.id === def.id)!.status === "EMPTY") state = set(state, def.id, `Answer for ${def.label}`);
    }
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
    // Answered company-context fields become typed design input with the evidence that proves them; unanswered ones are left out.
    const context = compiled.companyContext!;
    expect(context.map(item => item.fieldId)).toEqual(expect.arrayContaining(["operating_scale", "retained_systems", "kpi_targets", "constraints"]));
    expect(context.find(item => item.fieldId === "operating_scale")).toMatchObject({ label: "Operating scale and volumes", value: "Answer for Operating scale and volumes" });
    expect(compiled.sources.find(s => s.id === context[0]!.evidence.sourceId)?.text).toContain(context[0]!.evidence.quote);
    expect(context.some(item => item.fieldId === "current_financial")).toBe(true);
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
    // One walkthrough question covers the whole step; single-field gaps wait until it has been asked.
    expect(input.activeGaps.find(g => g.key === `gstep_${draft.id}`)?.detail).toContain("Walkthrough");
    expect(input.activeGaps.some(g => g.fieldId === `${draft.id}_exceptions`)).toBe(false);
    const turn = { schemaVersion: 1, contextRevision: state.revision, reply: "Thank you for that context.",
      questions: ask(`gstep_${draft.id}`), observations: [], proposedUpdates: draft.fields.map((fact, index) => ({
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
      reply: "Thank you for that context.", questions: ask(), observations: [], proposedUpdates: [{
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
      questions: ask("g_current_systems"), observations: [], proposedUpdates: [{ fieldId: "current_trigger", operation: "PROPOSE_SET",
        previousValue: null, value: "Returns arrive at the depot", sourceId: messageMeta.id,
        quote: "Returns arrive at the depot" }] };
    state = recordInterviewTurn(state, proposal, messageMeta.id, meta());
    state = set(state, "current_trigger", "A driver checks in a return");
    expect(() => applyWorkspaceCommand(state, { type: "DECIDE_PROPOSAL", proposalId: state.proposals[0]!.id,
      decision: "ACCEPT" }, meta())).toThrow("STALE_PROPOSAL");
  });

  it("loads persisted proposals that carry a value, and stores the server-set value for a validated turn without one", () => {
    let state = start();
    const messageMeta = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE",
      text: "The clerk records physical returns in a spreadsheet." }, messageMeta);
    const quote = "The clerk records physical returns in a spreadsheet.";
    // A validated turn (exact quote) without value or scalars.
    state = recordInterviewTurn(state, { reply: "Thank you for that context.", questions: ask(), observations: [],
      proposedUpdates: [{ fieldId: "current_systems", operation: "PROPOSE_SET", previousValue: null,
        sourceId: messageMeta.id, quote }] }, messageMeta.id, meta());
    expect(state.proposals[0]).toMatchObject({ quote, value: quote, status: "PENDING" });
    // State written before the change has exactly this shape (value === quote) and must still load and round-trip.
    const reloaded = WorkspaceStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(getWorkspaceReadiness(reloaded).blockers.map(b => b.code)).toContain("PROPOSALS_PENDING");
    expect(() => getWorkspaceReadiness({ ...reloaded, proposals: [{ ...reloaded.proposals[0]!, value: "changed" }] })).toThrow("INVALID_WORKSPACE_EVIDENCE");
  });

  it("backfills catalog facts added after a workspace was saved, as EMPTY, without changing what was answered", () => {
    let state = set(start(), "process_owner", "Rental operations manager");
    const oldIds = ["business_problem", "process_owner", "scope_boundary", "current_trigger", "current_systems", "current_rules",
      "current_exceptions", "current_financial", "desired_outcome", "desired_controls"];
    const saved = JSON.parse(JSON.stringify({ ...state, facts: state.facts.filter(f => oldIds.includes(f.id)) }));
    const loaded = backfillCatalog(WorkspaceStateSchema.parse(saved));
    expect(loaded.facts).toHaveLength(WORKSPACE_FIELDS.length);
    const added = loaded.facts.filter(f => !oldIds.includes(f.id));
    expect(added.length).toBeGreaterThan(10);
    expect(added.every(f => f.status === "EMPTY" && f.value === null && f.evidence === null)).toBe(true);
    expect(loaded.facts.find(f => f.id === "process_owner")?.value).toBe("Rental operations manager");
    // Every entry point reads through the backfill: readiness lists the new critical fields, commands still apply.
    expect(getWorkspaceReadiness(WorkspaceStateSchema.parse(saved)).blockers.map(b => b.detail)).toContain("Operating scale and volumes");
    state = applyWorkspaceCommand(WorkspaceStateSchema.parse(saved), { type: "SET_FIELD", fieldId: "operating_scale", status: "KNOWN",
      value: "2,800 orders a month", rationale: null, owner: null, sourceId: null, quote: null }, meta());
    expect(state.facts.find(f => f.id === "operating_scale")?.status).toBe("KNOWN");
  });

  it("requires the critical company-context fields to be known before readiness", () => {
    let state = start();
    for (const def of WORKSPACE_FIELDS) if (def.id !== "operating_scale" && state.facts.find(f => f.id === def.id)!.status === "EMPTY") state = set(state, def.id, `Answer ${def.id}`);
    state = applyWorkspaceCommand(state, { type: "ADD_STEP", step }, meta());
    state = applyWorkspaceCommand(state, { type: "ADD_REQUIREMENT", requirement: { asIsStepId: state.steps[0]!.id,
      kind: "PAIN_POINT", statement: "Late returns cause disputes", critical: true } }, meta());
    expect(getWorkspaceReadiness(state).blockers).toEqual([{ code: "FIELD_UNANSWERED", fieldId: "operating_scale", detail: "Operating scale and volumes" }]);
    state = applyWorkspaceCommand(state, { type: "SET_FIELD", fieldId: "operating_scale", status: "UNKNOWN", value: null,
      rationale: null, owner: null, sourceId: null, quote: null }, meta());
    expect(getWorkspaceReadiness(state).blockers.map(b => b.code)).toEqual(["CRITICAL_FIELD_UNRESOLVED"]);
    for (const id of ["operating_scale", "retained_systems", "kpi_baselines", "kpi_targets", "constraints"]) {
      expect(WORKSPACE_FIELDS.find(f => f.id === id)?.priority, id).toBe("CRITICAL");
    }
  });

  it("orders gaps: critical context, landscape, process steps, then KPIs, targets and constraints", () => {
    let state = applyWorkspaceCommand(start(), { type: "START_STEP_DRAFT" }, meta());
    const m = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "Hello" }, m);
    const keys = buildInterviewInput(state, m.id).activeGaps.map(g => g.key);
    const at = (key: string) => keys.indexOf(key);
    const draftGap = keys.find(k => k.startsWith("gstep_"))!;
    expect(keys.length).toBe(15);
    expect(Math.max(at("g_process_owner"), at("g_scope_boundary"), at("g_operating_scale"))).toBeLessThan(at("g_retained_systems"));
    expect(Math.max(...["g_retained_systems", "g_current_systems", "g_legal_entities", "g_external_parties"].map(at))).toBeLessThan(at(draftGap));
    expect(at(draftGap)).toBeLessThan(at("g_current_trigger"));
    // The KPI, target and constraint gaps come last, and show once the earlier tiers are answered.
    expect(at("g_kpi_baselines")).toBe(-1);
    for (const def of WORKSPACE_FIELDS) if (def.tier < 3 && def.id !== "business_problem") state = set(state, def.id, `Answer ${def.id}`);
    const m2 = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "More" }, m2);
    const later = buildInterviewInput(state, m2.id).activeGaps.map(g => g.key);
    expect(later.slice(-3)).toEqual(expect.arrayContaining(["g_required_outputs"]));
    expect(later.indexOf("g_kpi_baselines")).toBeGreaterThan(later.indexOf(draftGap));
    expect(later.indexOf("g_constraints")).toBeGreaterThan(later.indexOf("g_kpi_baselines"));
  });

  it("asks one walkthrough per step, holds single-field gaps until it was answered, and allows one gap per step per turn", () => {
    let state = applyWorkspaceCommand(start(), { type: "START_STEP_DRAFT" }, meta());
    state = applyWorkspaceCommand(state, { type: "START_STEP_DRAFT" }, meta());
    const [a, b] = state.stepDrafts.map(d => d.id) as [string, string];
    let m = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "First message" }, m);
    let input = buildInterviewInput(state, m.id);
    expect(input.activeGaps.filter(g => g.stepId === a).map(g => g.key)).toEqual([`gstep_${a}`]);
    expect(input.activeGaps.find(g => g.key === `gstep_${a}`)?.detail).toContain("ONE open question");
    const both = [`gstep_${a}`, `gstep_${b}`].map(gapKey => ({ gapKey, question: `Walk me through ${gapKey}?`, whyItMatters: "It shows the flow." }));
    expect(validateInterviewTurn(input, { questions: both, proposedUpdates: [], observations: [] }).success).toBe(true);
    // Two gaps about the same step in one turn are refused.
    const sameStep = [{ gapKey: `gstep_${a}`, question: "Walk me through the first stage?", whyItMatters: "x" },
      { gapKey: `g_${a}_actor`, question: "Who does the first stage?", whyItMatters: "x" }];
    input.closedGapKeys = input.closedGapKeys.filter(k => k !== `g_${a}_actor`);
    input.activeGaps.push({ key: `g_${a}_actor`, fieldId: `${a}_actor`, detail: "Who?", priority: "CRITICAL", stepId: a });
    // The second question about the same step is dropped; asked alone it is refused outright.
    expect(validateInterviewTurn(input, { questions: sameStep, proposedUpdates: [], observations: [] }))
      .toMatchObject({ success: true, data: { questions: [{ gapKey: `gstep_${a}` }] }, warnings: expect.arrayContaining([expect.objectContaining({ code: "question_dropped", detail: "duplicate_step_gap" })]) });
    const twice = [{ ...sameStep[0]!, gapKey: `gstep_${b}` }, sameStep[1]!, { ...sameStep[0]! }];
    expect(validateInterviewTurn(input, { questions: twice, proposedUpdates: [], observations: [] }))
      .toMatchObject({ success: true, data: { questions: [{ gapKey: `gstep_${b}` }, { gapKey: `g_${a}_actor` }] }, warnings: expect.arrayContaining([expect.objectContaining({ detail: "duplicate_step_gap" })]) });
    state = recordInterviewTurn(state, { questions: both, proposedUpdates: [], observations: [] }, m.id, meta());
    // Directly after the walkthrough was asked, its single fields stay closed; one answer later the EMPTY ones open.
    m = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "Here is the walkthrough" }, m);
    expect(buildInterviewInput(state, m.id).activeGaps.some(g => g.fieldId === `${a}_actor`)).toBe(false);
    m = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "More detail" }, m);
    input = buildInterviewInput(state, m.id);
    expect(input.activeGaps.filter(g => g.stepId === a).map(g => g.key)).toContain(`g_${a}_actor`);
    expect(input.activeGaps.some(g => g.key === `gstep_${a}`)).toBe(false);
  });

  it("creates a step and a requirement from accepted proposals, with the quote as evidence", () => {
    let state = start();
    const m = meta();
    const text = "Customer orders arrive by email. The clerk re-keys each order into the Access app. 7% of orders have entry errors.";
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text }, m);
    const stepQuote = "The clerk re-keys each order into the Access app.";
    const turn = { questions: ask("g_process_owner"), proposedUpdates: [],
      proposedSteps: [{ sourceId: m.id, quote: stepQuote, nameHint: "re-keys each order" }],
      proposedRequirements: [{ stepRef: "new_0", kind: "PAIN_POINT", critical: true, sourceId: m.id, quote: "7% of orders have entry errors." }],
      observations: [] };
    state = recordInterviewTurn(state, turn, m.id, meta());
    expect(state.stepDrafts).toHaveLength(0); // nothing exists until the user accepts
    const [stepProposal, requirementProposal] = state.proposals;
    expect(stepProposal).toMatchObject({ operation: "PROPOSE_STEP", status: "PENDING", value: stepQuote, nameHint: "re-keys each order" });
    expect(requirementProposal).toMatchObject({ operation: "PROPOSE_REQUIREMENT", stepRef: stepProposal!.id, kind: "PAIN_POINT", critical: true });
    // The requirement cannot be accepted before its step exists.
    expect(() => applyWorkspaceCommand(state, { type: "DECIDE_PROPOSAL", proposalId: requirementProposal!.id, decision: "ACCEPT" }, meta()))
      .toThrow("STALE_PROPOSAL");
    state = applyWorkspaceCommand(state, { type: "DECIDE_PROPOSALS", ids: state.proposals.map(p => p.id), decision: "ACCEPT" }, meta());
    expect(state.proposals.every(p => p.status === "ACCEPTED")).toBe(true);
    const draft = state.stepDrafts[0]!;
    const field = (key: string) => draft.fields.find(f => f.id === `${draft.id}_${key}`)!;
    expect(field("description")).toMatchObject({ status: "KNOWN", value: stepQuote, evidence: { sourceId: m.id, quote: stepQuote } });
    expect(field("name")).toMatchObject({ status: "KNOWN", value: "re-keys each order" });
    expect(field("actor").status).toBe("EMPTY");
    expect(state.requirementDrafts[0]).toMatchObject({ asIsStepId: draft.id, kind: "PAIN_POINT", critical: true,
      statement: { status: "KNOWN", value: "7% of orders have entry errors.", evidence: { sourceId: m.id, quote: "7% of orders have entry errors." } } });
    // The next turn sees the new step and requirement, so it neither re-proposes them nor loses the reference.
    const next = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "More" }, next);
    const input = buildInterviewInput(state, next.id);
    expect(input.steps).toMatchObject([{ id: draft.id, status: "CURRENT", summary: stepQuote }]);
    expect(input.requirements).toMatchObject([{ stepId: draft.id, kind: "PAIN_POINT" }]);
    const index = indexSentences(input);
    const stepSentence = [...index.sentences].find(([, found]) => found.sourceId === m.id && text.slice(found.start, found.end) === stepQuote)![0];
    expect(validateInterviewTurn(input, { questions: ask("g_operating_scale"), proposedUpdates: [], proposedSteps: [{ sentenceIds: [stepSentence] }], observations: [] }))
      .toMatchObject({ success: true, data: { proposedSteps: [] }, warnings: expect.arrayContaining([expect.objectContaining({ code: "step_dropped", detail: "duplicate_step" })]) });
    expect(compileDiscovery).toBeTypeOf("function");
  });

  it("turns sentence ids the model cited into proposals whose stored quote is an exact substring of the message", () => {
    let state = start();
    const m = meta();
    const text = "We use Tally for finance. A clerk checks credit by phone.\nOrders go out late on Fridays.";
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text }, m);
    const input = buildInterviewInput(state, m.id);
    // The currentMessage sentences are S1..S3 in order.
    const modelTurn = { questions: ask("g_process_owner"), observations: [],
      proposedUpdates: [{ fieldId: "current_systems", operation: "PROPOSE_SET", previousValue: null, sentenceIds: ["S1"] },
        { fieldId: "current_rules", operation: "PROPOSE_SET", previousValue: null, sentenceIds: ["S2", "S3"] }] };
    const validated = validateInterviewTurn(input, modelTurn);
    expect(validated.success).toBe(true);
    state = recordInterviewTurn(state, (validated as { data: unknown }).data, m.id, meta());
    expect(state.proposals.map(p => p.quote)).toEqual(["We use Tally for finance.", "A clerk checks credit by phone.\nOrders go out late on Fridays."]);
    expect(state.proposals.every(p => p.value === p.quote && text.includes(p.quote!) && p.sourceId === m.id)).toBe(true);
  });

  it("merges a proposed step that repeats an existing one and points its requirement at the existing step", () => {
    let state = start();
    const first = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "Raise customer quote: the sales engineer configures the pump and issues the quote from Salesforce." }, first);
    state = recordInterviewTurn(state, { questions: ask("g_process_owner"), proposedUpdates: [], observations: [],
      proposedSteps: [{ sourceId: first.id, quote: "the sales engineer configures the pump and issues the quote from Salesforce.", nameHint: "Raise customer quote" }] }, first.id, meta());
    state = applyWorkspaceCommand(state, { type: "DECIDE_PROPOSALS", ids: [state.proposals[0]!.id], decision: "ACCEPT" }, meta());
    const draftId = state.stepDrafts[0]!.id;
    const second = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE",
      text: "For the \"Raise customer quote\" step the sales engineer works in Salesforce. The problem here: quotes carry stale prices." }, second);
    state = recordInterviewTurn(state, { questions: ask("g_scope_boundary"), proposedUpdates: [], observations: [],
      proposedSteps: [{ sourceId: second.id, quote: "For the \"Raise customer quote\" step the sales engineer works in Salesforce.", nameHint: "Raise customer quote" }],
      proposedRequirements: [{ stepRef: "new_0", kind: "PAIN_POINT", critical: false, sourceId: second.id, quote: "quotes carry stale prices." }] }, second.id, meta());
    expect(state.proposals.filter(p => p.status === "PENDING" && p.operation === "PROPOSE_STEP")).toHaveLength(0);
    expect(state.proposals.at(-1)).toMatchObject({ operation: "PROPOSE_REQUIREMENT", stepRef: draftId });
  });

  it("rejects invented quotes and unknown step references in proposed structure", () => {
    let state = start();
    const m = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "The clerk re-keys each order. Orders are late." }, m);
    const base = { questions: ask("g_process_owner"), proposedUpdates: [], observations: [] };
    const run = (turn: object) => () => recordInterviewTurn(state, { ...base, ...turn }, m.id, meta());
    expect(run({ proposedSteps: [{ sourceId: m.id, quote: "The clerk invented a step." }] })).toThrow("INVALID_INTERVIEW_TURN");
    expect(run({ proposedSteps: [{ sourceId: "missing", quote: "The clerk re-keys each order." }] })).toThrow("INVALID_INTERVIEW_TURN");
    const requirement = { kind: "PAIN_POINT", critical: false, sourceId: m.id, quote: "Orders are late." };
    expect(run({ proposedRequirements: [{ ...requirement, stepRef: "st_missing" }] })).toThrow("INVALID_INTERVIEW_TURN");
    expect(run({ proposedRequirements: [{ ...requirement, stepRef: "new_0" }] })).toThrow("INVALID_INTERVIEW_TURN"); // no step proposed this turn
    expect(run({ proposedRequirements: [{ ...requirement, quote: "Orders were never late." , stepRef: "new_0" }],
      proposedSteps: [{ sourceId: m.id, quote: "The clerk re-keys each order." }] })).toThrow("INVALID_INTERVIEW_TURN");
    expect(run({ proposedSteps: [{ sourceId: m.id, quote: "The clerk re-keys each order.", nameHint: "not in the message" }] })()).toBeTruthy(); // a bad hint is dropped, not fatal
  });

  it("decides proposals in a batch, leaving a stale one pending and failing only when nothing applies", () => {
    let state = start();
    const m = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "We use Tally for finance. A clerk checks credit by phone." }, m);
    state = recordInterviewTurn(state, { questions: ask("g_process_owner"), observations: [], proposedUpdates: [
      { fieldId: "current_systems", operation: "PROPOSE_SET", previousValue: null, sourceId: m.id, quote: "We use Tally for finance." },
      { fieldId: "current_rules", operation: "PROPOSE_SET", previousValue: null, sourceId: m.id, quote: "A clerk checks credit by phone." }] }, m.id, meta());
    const [systems, rules] = state.proposals;
    state = set(state, "current_rules", "Credit is checked by the sales head"); // the second proposal is now stale
    const batch = applyWorkspaceCommand(state, { type: "DECIDE_PROPOSALS", ids: [systems!.id, rules!.id], decision: "ACCEPT" }, meta());
    expect(batch.facts.find(f => f.id === "current_systems")).toMatchObject({ status: "KNOWN", value: "We use Tally for finance." });
    expect(batch.facts.find(f => f.id === "current_rules")?.value).toBe("Credit is checked by the sales head");
    expect(batch.proposals.map(p => p.status)).toEqual(["ACCEPTED", "PENDING"]);
    expect(() => applyWorkspaceCommand(batch, { type: "DECIDE_PROPOSALS", ids: [rules!.id], decision: "ACCEPT" }, meta())).toThrow("STALE_PROPOSAL");
    expect(() => applyWorkspaceCommand(batch, { type: "DECIDE_PROPOSALS", ids: [systems!.id], decision: "ACCEPT" }, meta())).toThrow("PROPOSAL_NOT_PENDING");
    expect(() => applyWorkspaceCommand(batch, { type: "DECIDE_PROPOSALS", ids: ["p_missing"], decision: "ACCEPT" }, meta())).toThrow("PROPOSAL_NOT_PENDING");
    const rejected = applyWorkspaceCommand(batch, { type: "DECIDE_PROPOSALS", ids: [rules!.id], decision: "REJECT" }, meta());
    expect(rejected.proposals[1]).toMatchObject({ status: "REJECTED", decidedBy: "consultant" });
  });

  it("re-asks a gap that stayed unanswered exactly once, after three more user turns", () => {
    let state = start();
    let m = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "Hello" }, m);
    state = recordInterviewTurn(state, { questions: ask("g_process_owner"), proposedUpdates: [], observations: [] }, m.id, meta());
    const keys = (id: string) => buildInterviewInput(state, id).activeGaps.map(g => g.key);
    const say = (text: string) => { m = meta(); state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text }, m); return m.id; };
    expect(keys(say("two"))).not.toContain("g_process_owner");
    expect(keys(say("three"))).not.toContain("g_process_owner_r2");
    expect(keys(say("four"))).toContain("g_process_owner_r2"); // 3 user turns after the first ask
    expect(keys(m.id)).not.toContain("g_process_owner");
    state = recordInterviewTurn(state, { questions: ask("g_process_owner_r2", "Who owns the process day to day?"), proposedUpdates: [], observations: [] }, m.id, meta());
    for (const text of ["five", "six", "seven", "eight"]) {
      const id = say(text);
      expect(keys(id).filter(k => k.startsWith("g_process_owner"))).toEqual([]);
    }
  });

  it("records the chat half and the extraction half of a turn separately, and extracts each message once", () => {
    let state = start();
    const m = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "We use Tally for finance. A clerk checks credit by phone." }, m);
    const chat = { questions: ask("g_process_owner"), proposedUpdates: [], observations: [] };
    const extraction = { proposedUpdates: [{ fieldId: "current_systems", operation: "PROPOSE_SET", previousValue: null, sourceId: m.id,
      quote: "We use Tally for finance.", value: "We use Tally for finance." }], observations: [] };
    // Chat: the reply and its question only; nothing is proposed and nothing is marked extracted.
    state = recordInterviewTurn(state, { ...chat, ...extraction }, m.id, meta(), "chat");
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(state.proposals).toHaveLength(0);
    expect(state.extractedMessageIds ?? []).toEqual([]);
    expect(buildInterviewInput(state, m.id).unextractedMessageIds).toEqual([]); // the current message is never listed
    // A later message sees the earlier one as not yet extracted, with its text in evidence.
    const later = meta();
    state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "Credit is checked by phone." }, later);
    const view = buildInterviewInput(state, later.id);
    expect(view.unextractedMessageIds).toEqual([m.id]);
    expect(view.evidence.find(source => source.id === m.id)?.text).toContain("We use Tally");
    // Extraction: proposals and marker, no assistant message, and only once.
    const messages = state.messages.length;
    state = recordInterviewTurn(state, extraction, m.id, meta(), "extraction");
    expect(state.messages).toHaveLength(messages);
    expect(state.proposals).toMatchObject([{ fieldId: "current_systems", status: "PENDING" }]);
    expect(state.extractedMessageIds).toEqual([m.id]);
    expect(() => recordInterviewTurn(state, extraction, m.id, meta(), "extraction")).toThrow("ALREADY_EXTRACTED");
    expect(buildInterviewInput(state, later.id).unextractedMessageIds).toEqual([]);
    // The field now has an answer waiting: the next extraction is told, and does not propose it again.
    expect(buildInterviewInput(state, later.id).fields.find(f => f.id === "current_systems")).toMatchObject({ status: "EMPTY", pending: true });
    const again = validateExtraction(buildInterviewInput(state, later.id), { ...extraction, proposedUpdates: [{ fieldId: "current_systems",
      operation: "PROPOSE_SET", previousValue: null, sentenceIds: ["S1"] }] });
    expect(again).toMatchObject({ success: true, data: { proposedUpdates: [] },
      warnings: expect.arrayContaining([expect.objectContaining({ code: "update_dropped", detail: "already_proposed" })]) });
  });

  describe("interview input with many incomplete steps", () => {
    /** `count` empty step drafts; every round the consultant asks up to three shown walkthroughs (re-asks included) of the first
     * `askFirst` drafts. Each round's input must build, and every shown gap must point at a field the input lists. */
    const interview = (count: number, askFirst: number, rounds = 12) => {
      let state = start();
      for (let i = 0; i < count; i++) state = applyWorkspaceCommand(state, { type: "START_STEP_DRAFT" }, meta());
      const target = new Set(state.stepDrafts.slice(0, askFirst).map(d => d.id));
      let asked = 0;
      for (let round = 0; round < rounds; round++) {
        const m = meta();
        state = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: `Turn ${round}` }, m);
        const input = buildInterviewInput(state, m.id);
        const fieldIds = new Set(input.fields.map(f => f.id));
        expect(input.activeGaps.filter(g => !fieldIds.has(g.fieldId)), `${count} drafts, round ${round}`).toEqual([]);
        const questions = input.activeGaps.filter(g => g.key.startsWith("gstep_") && g.stepId && target.has(g.stepId)).slice(0, 3)
          .map(g => ({ gapKey: g.key, question: `Round ${round}: walk me through ${g.stepId}?`, whyItMatters: "It shows the flow." }));
        if (!questions.length) continue;
        asked += questions.length;
        state = recordInterviewTurn(state, { questions, proposedUpdates: [], observations: [] }, m.id, meta());
      }
      return asked;
    };

    it.each([[14, 14], [14, 11], [14, 0], [16, 16]])("builds every turn for %i drafts when the first %i are asked", (count, askFirst) => {
      const asked = interview(count, askFirst);
      expect(asked > 0).toBe(askFirst > 0);
    });

    it("builds for every draft count from 0 to 25, asked or not", () => {
      for (let count = 0; count <= 25; count++) for (const askFirst of [0, count]) interview(count, askFirst);
    }, 30_000);
  });
});

describe("confirming the As-Is as a draft with gaps", () => {
  const setDraft = (state: WorkspaceState, key: string, value: string) => applyWorkspaceCommand(state, { type: "SET_STEP_DRAFT_FIELD",
    fieldId: `${state.stepDrafts[0]!.id}_${key}`, status: "KNOWN", value, rationale: null, owner: null, sourceId: null, quote: null }, meta());
  /** Everything answered, one requirement, and one step draft that only has what the caller sets. */
  const withDraft = (known: Record<string, string>) => {
    let state = start();
    for (const def of WORKSPACE_FIELDS) if (state.facts.find(f => f.id === def.id)!.status === "EMPTY") state = set(state, def.id, `Answer for ${def.label}`);
    state = applyWorkspaceCommand(state, { type: "START_STEP_DRAFT" }, meta());
    for (const [key, value] of Object.entries(known)) state = setDraft(state, key, value);
    state = applyWorkspaceCommand(state, { type: "START_REQUIREMENT_DRAFT", asIsStepId: state.stepDrafts[0]!.id, kind: "PAIN_POINT", critical: true }, meta());
    return applyWorkspaceCommand(state, { type: "SET_REQUIREMENT_DRAFT_STATEMENT", requirementDraftId: state.requirementDrafts[0]!.id,
      status: "KNOWN", value: "Late return entry delays billing", rationale: null, owner: null, sourceId: null, quote: null }, meta());
  };
  const gaps = { type: "CONFIRM", allowGaps: true };

  it("marks an incomplete but named draft as a soft blocker; everything else stays hard", () => {
    const soft = getWorkspaceReadiness(withDraft({ name: "Record return" }));
    expect(soft).toMatchObject({ ready: false, draftReady: true, blockers: [{ code: "AS_IS_STEP_INCOMPLETE", soft: true }] });
    const nameless = getWorkspaceReadiness(withDraft({ actor: "Stores clerk" }));
    expect(nameless).toMatchObject({ ready: false, draftReady: false, blockers: [{ code: "AS_IS_STEP_INCOMPLETE" }] });
    expect(nameless.blockers[0]).not.toHaveProperty("soft");
    expect(getWorkspaceReadiness(set(withDraft({ name: "Record return" }), "process_owner", "x")).draftReady).toBe(true);
    expect(getWorkspaceReadiness(start()).draftReady).toBe(false);
  });

  it("confirms with allowGaps only when every blocker is soft, and plain CONFIRM is unchanged", () => {
    const state = withDraft({ name: "Record return" });
    expect(() => applyWorkspaceCommand(state, { type: "CONFIRM" }, meta())).toThrow("WORKSPACE_NOT_READY");
    expect(() => applyWorkspaceCommand(withDraft({ actor: "Stores clerk" }), gaps, meta())).toThrow("WORKSPACE_NOT_READY");
    expect(() => applyWorkspaceCommand(start(), gaps, meta())).toThrow("WORKSPACE_NOT_READY");
    const confirmed = applyWorkspaceCommand(state, gaps, meta());
    expect(confirmed.confirmation).toMatchObject({ revision: confirmed.revision, withGaps: true });
    // A complete workspace confirmed "with gaps" is simply confirmed: nothing is missing.
    const complete = applyWorkspaceCommand(withDraft({ name: "Record return", actor: "Stores clerk", system: "Spreadsheet",
      trigger: "Equipment arrives", description: "Clerk records the return", inputs: "Return note", outputs: "Return row",
      controls: "Asset ID check", exceptions: "Missing date" }), gaps, meta());
    expect(complete.confirmation).not.toHaveProperty("withGaps");
  });

  it("compiles missing details as 'To confirm' with evidence and one open question per step, and still throws without the flag", () => {
    const state = withDraft({ name: "Record return", description: "Clerk records the return in a spreadsheet", inputs: "Return note\nPhoto" });
    expect(() => compileDiscovery(state)).toThrow("AS_IS_STEP_INCOMPLETE");
    const compiled = compileDiscovery(state, { allowGaps: true });
    const id = state.stepDrafts[0]!.id;
    expect(compiled.asIsSteps[0]).toMatchObject({ name: "Record return", actor: TO_CONFIRM, system: TO_CONFIRM, trigger: TO_CONFIRM,
      description: "Clerk records the return in a spreadsheet", inputs: ["Return note", "Photo"], outputs: [], controls: [], exceptions: [] });
    expect(compiled.sources.find(s => s.id === compiled.asIsSteps[0]!.evidence.sourceId)?.text).toContain(compiled.asIsSteps[0]!.evidence.quote);
    expect(compiled.openQuestions.filter(q => q.id.startsWith(`q_${id}`))).toEqual([{ id: `q_${id}`, owner: "Process owner",
      question: "Record return: confirm who does it, system or record used, what starts it, outputs, checks and approvals, exceptions." }]);
    // Evidence falls back to the name's when there is no description.
    const nameOnly = compileDiscovery(withDraft({ name: "Record return" }), { allowGaps: true }).asIsSteps[0]!;
    expect(nameOnly).toMatchObject({ description: TO_CONFIRM, name: "Record return" });
    expect(nameOnly.evidence.quote).toBe("Record return");
    // A step with neither name nor description cannot be carried even with the flag.
    expect(() => compileDiscovery(withDraft({ actor: "Stores clerk" }), { allowGaps: true })).toThrow("AS_IS_STEP_INCOMPLETE");
  });

  /** A draft-ready workspace that also has pending model observations. */
  const withObservations = (count: number, known: Record<string, string> = { name: "Record return" }) => {
    const state = withDraft(known);
    const sent = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text: "Billing says the return was yesterday." }, meta());
    const id = sent.messages.at(-1)!.id;
    return { id, state: recordInterviewTurn(sent, { schemaVersion: 1, contextRevision: sent.revision, reply: "Noted.", questions: [],
      proposedUpdates: [], observations: Array.from({ length: count }, (_, i) => ({ kind: i % 2 ? "FOLLOW_UP_SUGGESTION" as const : "POSSIBLE_CONFLICT" as const,
        fieldIds: ["current_trigger"], detail: `Check point ${i}: the return date may differ from billing.` })) }, id, meta()) };
  };

  it("treats pending observations as a soft blocker: draft-ready but not ready", () => {
    const { state } = withObservations(2);
    const readiness = getWorkspaceReadiness(state);
    expect(readiness).toMatchObject({ ready: false, draftReady: true });
    expect(readiness.blockers.find(b => b.code === "OBSERVATIONS_PENDING")).toMatchObject({ soft: true });
    expect(() => applyWorkspaceCommand(state, { type: "CONFIRM" }, meta())).toThrow("WORKSPACE_NOT_READY");
    // A hard blocker next to the observations still prevents the draft.
    expect(getWorkspaceReadiness(withObservations(1, { actor: "Stores clerk" }).state).draftReady).toBe(false);
  });

  it("carries pending observations into the To-Be as open questions only with allowGaps", () => {
    const { state } = withObservations(2);
    const confirmed = applyWorkspaceCommand(state, gaps, meta());
    expect(confirmed.confirmation).toMatchObject({ withGaps: true });
    const compiled = compileDiscovery(state, { allowGaps: true });
    for (const obs of state.observations) {
      expect(compiled.openQuestions).toContainEqual({ id: `q_obs_${obs.id}`.slice(0, 64), question: obs.detail, owner: "Process owner" });
    }
    expect(new Set(compiled.openQuestions.map(q => q.id)).size).toBe(compiled.openQuestions.length);
    // Without the flag nothing about observations is added (and the unfinished step still throws).
    expect(() => compileDiscovery(state)).toThrow("AS_IS_STEP_INCOMPLETE");
    const complete = withDraft({ name: "Record return", actor: "Stores clerk", system: "Spreadsheet", trigger: "Equipment arrives",
      description: "Clerk records the return", inputs: "Return note", outputs: "Return row", controls: "Asset ID check", exceptions: "Missing date" });
    expect(compileDiscovery(complete).openQuestions.some(q => q.id.startsWith("q_obs_"))).toBe(false);
  });

  it("never exceeds the open-question limit: facts, then steps, then observations, then one pointer question", () => {
    const { state: base } = withObservations(1);
    const draft = base.stepDrafts[0]!;
    const dup = (n: number) => JSON.parse(JSON.stringify(draft).replaceAll(draft.id, `${draft.id}x${n}`)) as typeof draft;
    const state: WorkspaceState = { ...base,
      stepDrafts: [draft, ...Array.from({ length: 29 }, (_, i) => dup(i))],
      observations: Array.from({ length: 90 }, (_, i) => ({ ...base.observations[0]!, id: `${base.observations[0]!.id}x${i}` })) };
    const compiled = compileDiscovery(state, { allowGaps: true });
    expect(compiled.openQuestions).toHaveLength(MAX_OPEN_QUESTIONS);
    expect(compiled.openQuestions.at(-1)).toMatchObject({ id: "q_more_open_points",
      question: "21 further open points are listed on the Summary tab of the discovery workspace." });
    expect(compiled.openQuestions.filter(q => q.id.startsWith("q_st_"))).toHaveLength(30);
    expect(new Set(compiled.openQuestions.map(q => q.id)).size).toBe(MAX_OPEN_QUESTIONS);
  });

  it("does not carry dismissed or resolved observations", () => {
    const { state } = withObservations(2);
    const reviewed = applyWorkspaceCommand(state, { type: "REVIEW_OBSERVATION", observationId: state.observations[0]!.id,
      decision: "RESOLVE", rationale: "Owner confirmed these are separate dates." }, meta());
    const ids = compileDiscovery(reviewed, { allowGaps: true }).openQuestions.map(q => q.id).filter(id => id.startsWith("q_obs_"));
    expect(ids).toEqual([`q_obs_${state.observations[1]!.id}`.slice(0, 64)]);
  });

  describe("when the participant asks for the To-Be", () => {
    const FULL = { name: "Record return", actor: "Stores clerk", system: "Spreadsheet", trigger: "Equipment arrives",
      description: "Clerk records the return", inputs: "Return note", outputs: "Return row", controls: "Asset ID check", exceptions: "Missing date" };
    /** The chat turn that answers `text`, asking the most urgent open gap (if any). */
    const answer = (state: WorkspaceState, text: string) => {
      const sent = applyWorkspaceCommand(state, { type: "SEND_MESSAGE", text }, meta());
      const id = sent.messages.at(-1)!.id;
      const questions = buildInterviewInput(sent, id).activeGaps.slice(0, 1)
        .map(g => ({ gapKey: g.key, question: `About ${g.key}?`, whyItMatters: "It matters." }));
      const turn = { reply: "Thank you for that context." as const, questions, proposedUpdates: [], observations: [] };
      return { saved: recordInterviewTurn(sent, turn, id, meta(), "chat"), turn };
    };

    it.each([
      "Can you draft the To-Be with what you have?", "draft the to be now", "Generate the design", "what will the future state look like",
      "Show me the To-Be design", "I want the future process", "Please create the TO-BE", "generate me a design",
    ])("recognises %j", text => expect(asksForToBe(text)).toBe(true));

    it.each([
      "To be honest, it is a spreadsheet.", "What needs to be done next?", "It has to be approved by finance.", "We want to be faster.",
      "The clerk wants to be notified", "The design of the form is old.", "Returns are slow.", "",
    ])("ignores %j", text => expect(asksForToBe(text)).toBe(false));

    it("says the As-Is can be confirmed when it is ready", () => {
      const { saved } = answer(withDraft(FULL), "Please draft the To-Be.");
      expect(saved.messages.at(-1)!.note).toBe("The As-Is is complete. A project lead or consultant can confirm it on the Summary tab and then generate the To-Be design.");
    });

    it("points to the draft confirmation, with the number of carried unfinished steps, when only step details are missing", () => {
      const { saved } = answer(withDraft({ name: "Record return" }), "Draft the To-Be with what you have");
      expect(saved.messages.at(-1)!.note).toBe("A draft To-Be can be generated now: on the Summary tab, a project lead or consultant can use \"Confirm as draft with gaps\". 1 unfinished step will be carried into the To-Be as an open question to confirm.");
    });

    it("counts unfinished steps and points to check separately in the draft note", () => {
      const { saved } = answer(withObservations(2).state, "Draft the To-Be with what you have");
      expect(saved.messages.at(-1)!.note).toBe("A draft To-Be can be generated now: on the Summary tab, a project lead or consultant can use \"Confirm as draft with gaps\". 1 unfinished step and 2 points to check will be carried into the To-Be as open questions to confirm.");
    });

    it("mentions only the soft parts that exist, with singular forms", () => {
      const FULLSTEP = { name: "Record return", actor: "Stores clerk", system: "Spreadsheet", trigger: "Equipment arrives",
        description: "Clerk records the return", inputs: "Return note", outputs: "Return row", controls: "Asset ID check", exceptions: "Missing date" };
      const onlyObs = answer(withObservations(1, FULLSTEP).state, "Draft the To-Be").saved.messages.at(-1)!.note!;
      expect(onlyObs).toContain("1 point to check will be carried into the To-Be as an open question to confirm.");
      expect(onlyObs).not.toContain("unfinished");
    });

    it("tells how many other gaps can stay open when required items remain", () => {
      const hardState = setDraft(applyWorkspaceCommand(start(), { type: "START_STEP_DRAFT" }, meta()), "name", "Record return");
      const r = getWorkspaceReadiness(hardState);
      const hard = r.blockers.filter(b => !b.soft).length, soft = r.blockers.length - hard;
      expect(soft).toBe(1);
      const note = answer(hardState, "Generate the To-Be design").saved.messages.at(-1)!.note!;
      expect(note.endsWith(`; and ${hard - 3} more required items. 1 other gap (unfinished steps, points to check) can stay open in a draft. These are listed on the Summary tab.`)).toBe(true);
    });

    it("lists the first three hard blockers and counts the rest otherwise", () => {
      const state = start();
      const readiness = getWorkspaceReadiness(state);
      const hard = readiness.blockers.filter(b => !b.soft);
      expect(hard.length).toBeGreaterThan(3);
      const note = answer(state, "Generate the To-Be design").saved.messages.at(-1)!.note!;
      expect(note.startsWith("Before a To-Be can be drafted: ")).toBe(true);
      expect(note.endsWith(`; and ${hard.length - 3} more required items. These are listed on the Summary tab.`)).toBe(true);
      expect(note).not.toContain("can stay open in a draft");
      expect(note).not.toContain("\n");
      expect(note).not.toMatch(/FIELD_UNANSWERED|AS_IS_STEP/);
    });

    it("leaves the stored message exactly as before when the To-Be is not asked for, and keeps the reply text free of the note", () => {
      const base = withDraft({ name: "Record return" });
      const { saved, turn } = answer(base, "The clerk uses a spreadsheet.");
      const message = saved.messages.at(-1)!;
      expect(message).not.toHaveProperty("note");
      expect(message.text).toBe([turn.reply, ...turn.questions.map(q => `${q.question} ${q.whyItMatters}`)].join("\n\n"));
      const asked = answer(base, "Draft the To-Be").saved.messages.at(-1)!;
      expect(asked.text).toBe(message.text);
    });

    it("loads messages stored before the note existed", () => {
      const { saved } = answer(withDraft({ name: "Record return" }), "Draft the To-Be");
      expect(WorkspaceStateSchema.parse(JSON.parse(JSON.stringify(saved))).messages.at(-1)!.note).toBeTruthy();
      const old = JSON.parse(JSON.stringify(answer(withDraft(FULL), "hello").saved));
      expect(WorkspaceStateSchema.parse(old).messages.at(-1)).not.toHaveProperty("note");
    });
  });
});
