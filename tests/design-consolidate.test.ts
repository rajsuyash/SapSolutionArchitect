import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { evaluateDesign, type DetailedDesign } from "../src/lib/ai/design-quality";
import { consolidateDesign, addDocumentTypeRows, addKpiPlans, addOwnerRoles, mergeConfigRows, mergeRoles, mergeStatusModels, syncFitGapSteps } from "../src/lib/ai/design-consolidate";
import { isNotProvided, normaliseKpiRows, type RegisterGroup } from "../src/lib/ai/design-registers";
import { roleKey } from "../src/lib/ai/design-registers-v3";
import { rentalContext, rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV3, rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";
import { asStream } from "./support/sse";
import { fixture } from "./support/to-be-input";
import { registerGroupOf, splitDesign, stepIdOf, toolOf, toolResponse, type RequestBody } from "./support/to-be-split";

const design = (change: (draft: DetailedDesign) => void = () => {}) => { const draft = structuredClone(rentalDraftV3); change(draft); return draft; };
const at = <T,>(list: T[] | undefined, i = 0) => list![i]!;
const kpi = (overrides: Record<string, unknown> = {}) => ({ id: "KPI-1", name: "Quote turnaround in days", baseline: "not provided", target: "Quote turnaround under 2 days", measuredFrom: "Quotation documents",
  referenceIds: [], needsValidation: true, validationReason: "Confirm the app", requirementIds: [], contextFieldIds: ["kpi_targets"], stepIds: ["TB-1"],
  owner: "Rental operations lead", producingStepId: "TB-1", ...overrides });
const errorsOf = (draft: DetailedDesign) => evaluateDesign(rentalContext, draft).errors.map(error => `${error.code}@${error.path}`);
const blockersOf = (draft: DetailedDesign) => evaluateDesign(rentalContext, draft).blockers.map(item => `${item.code}@${item.path}`);

describe("roleKey abbreviations", () => {
  it("reads abbreviations word-wise, so an abbreviated role is the spelled-out role", () => {
    expect(roleKey("AP clerk")).toBe(roleKey("Accounts payable clerk"));
    expect(roleKey("AR clerk, Chakan")).toBe(roleKey("Chakan accounts receivable clerk"));
    expect(roleKey("QA Mgr")).toBe(roleKey("quality assurance manager"));
    expect(roleKey("HOD Stores")).toBe(roleKey("Head of department, stores"));
    expect(roleKey("CFO")).toBe(roleKey("Chief financial officer"));
    expect(roleKey("AP clerk")).not.toBe(roleKey("AR clerk"));
  });
});

describe("mergeRoles", () => {
  it("merges AP clerk and Accounts payable clerk, rewrites the dropped name where it is used and warns", () => {
    const draft = design(d => {
      d.roles = [...d.roles!, { id: "ROLE-4", name: "Accounts payable clerk", responsibilities: "Posts supplier invoices.", stepIds: ["TB-3"] }, { id: "ROLE-5", name: "AP clerk", responsibilities: "Checks three-way match.", stepIds: ["TB-2"] }];
      d.sodAssessments = [{ ...at(d.sodAssessments), roleIds: ["ROLE-5", "ROLE-3"] }];
      d.masterDataPrerequisites = [{ ...at(rentalDraftV3.masterDataPrerequisites ?? [{} as never]), id: "MD-1", owner: "AP clerk" } as never];
    });
    const out = mergeRoles(draft);
    expect(out.design.roles!.map(role => role.name)).toEqual(["Rental coordinator", "Rental stores clerk", "Billing clerk", "Accounts payable clerk"]);
    expect(at(out.design.roles, 3).stepIds).toEqual(["TB-3", "TB-2"]);
    expect(at(out.design.sodAssessments).roleIds).toEqual(["ROLE-4", "ROLE-3"]);
    expect(out.warnings).toEqual([{ code: "ROLE_MERGED", path: "draft.roles.4" }]);
  });
});

describe("addOwnerRoles", () => {
  const withOwners = () => design(d => {
    d.kpis = [kpi({ owner: "Credit controller" }), kpi({ id: "KPI-2", owner: "credit  Controller", producingStepId: "TB-2", stepIds: ["TB-2"] })] as never;
    d.fitGap = [{ ...at(d.fitGap), owner: "to be assigned" }, { ...at(d.fitGap), owner: "Rental coordinator" }] as never;
    at(d.steps, 2).exceptions = [{ condition: "Customer disputes the invoice", response: "Hold the invoice and escalate", owner: "Finance controller" }];
  });
  const BOILERPLATE = /Owner of|fitGap|register|keyDesignDecisions|undefined|\bmore\b/;
  it("adds one role per uncatalogued owner, with its steps and what it owns as duties, and skips placeholders and catalogue roles", () => {
    const draft = withOwners();
    const out = addOwnerRoles(draft);
    const added = out.design.roles!.slice(3);
    expect(added.map(role => [role.id, role.name, role.stepIds])).toEqual([["ROLE-4", "Credit controller", ["TB-1", "TB-2"]], ["ROLE-5", "Finance controller", ["TB-3"]]]);
    expect(added[0]!.responsibilities).toContain("Quote turnaround in days");
    expect(added[1]!.responsibilities).toBe("Resolves customer disputes the invoice.");
    for (const role of added) expect(role.responsibilities).not.toMatch(BOILERPLATE);
    expect(out.warnings).toEqual([{ code: "ROLE_ADDED_FOR_OWNER", path: "draft.roles.3" }, { code: "ROLE_ADDED_FOR_OWNER", path: "draft.roles.4" }]);
    expect(draft.roles).toHaveLength(3); // the input is not mutated
  });
  it("gives a fit-gap owner its steps only: the justification is never a duty, and there is no 'Confirms the fit call'", () => {
    const out = addOwnerRoles(design(d => { d.fitGap = [{ ...at(d.fitGap), requirementId: "R-1", justification: "Standard approval is enough", stepIds: ["TB-1"], owner: "Quality auditor" }] as never; }));
    const role = out.design.roles!.find(item => item.name === "Quality auditor")!;
    expect(role.stepIds).toEqual(["TB-1"]);
    expect(role.responsibilities).toMatch(/^Acts in .*TB-1/);
    expect(role.responsibilities).not.toMatch(/Confirms the fit call|Standard approval/);
  });
  it("builds duties from short phrases: no ellipsis, no field list, a long condition cut at a clause boundary or dropped, at most 200 characters", () => {
    const long = "Customer disputes the invoice amount, and the credit note has to be approved by the regional finance head before posting";
    const out = addOwnerRoles(design(d => {
      at(d.steps, 2).exceptions = [{ condition: long, response: "Hold", owner: "Finance controller" }, { condition: "x".repeat(150), response: "Hold", owner: "Finance controller" }];
      at(d.steps, 2).masterData = [{ object: "Vendor master", fields: ["a", "b", "c", "d"], owner: "Finance controller", source: "x" } as never];
      d.kpis = Array.from({ length: 12 }, (_, i) => kpi({ id: `KPI-${i + 1}`, name: `Measure number ${i + 1} with a rather long descriptive name`, owner: "Credit controller" })) as never;
    }));
    for (const name of ["Finance controller", "Credit controller"]) {
      const role = out.design.roles!.find(item => item.name === name)!.responsibilities;
      expect(role).not.toContain("…");
      expect(role).not.toMatch(/\(a, b|Confirms the fit call/);
      expect(role.length).toBeLessThanOrEqual(200);
    }
    const finance = out.design.roles!.find(item => item.name === "Finance controller")!.responsibilities;
    expect(finance).toContain("Resolves customer disputes the invoice amount.");
    expect(finance).toContain("Maintains vendor master.");
    expect(finance).not.toContain("xxxx");
  });
  it("appends at most one new kind of duty to a matched catalogue role and never rewrites its text", () => {
    const draft = design(d => { d.kpis = [kpi({ owner: "Rental coordinator Chakan", producingStepId: "TB-3", stepIds: ["TB-3"] })] as never; });
    const before = draft.roles![0]!.responsibilities;
    const after = addOwnerRoles(draft).design.roles![0]!.responsibilities;
    expect(after.startsWith(before.replace(/[.]$/, ""))).toBe(true);
    expect(after.length).toBeLessThanOrEqual(Math.max(200, before.length));
    expect(after.split("Reports").length - 1).toBeLessThanOrEqual(1);
    expect(after).not.toContain("…");
  });
  it("gives a role whose owned rows have no usable text a duty from the step it acts in", () => {
    const out = addOwnerRoles(design(d => { d.fitGap = [{ ...at(d.fitGap), requirementId: "", justification: "", id: undefined, stepIds: ["TB-1"], owner: "Quality auditor" }] as never; }));
    const text = out.design.roles!.find(item => item.name === "Quality auditor")!.responsibilities;
    expect(text).toContain("TB-1");
    expect(text).not.toMatch(BOILERPLATE);
  });
  it("lists at most a handful of duties and never says 'and N more'", () => {
    const out = addOwnerRoles(design(d => { d.kpis = Array.from({ length: 12 }, (_, i) => kpi({ id: `KPI-${i + 1}`, name: `Measure number ${i + 1}`, owner: "Credit controller" })) as never; }));
    const text = out.design.roles!.find(item => item.name === "Credit controller")!.responsibilities;
    expect(text).toContain("Measure number 1");
    expect(text).not.toContain("Measure number 12");
    expect(text).not.toMatch(BOILERPLATE);
  });
  it("matches an owner to an equivalent catalogue role: adds the steps, creates no role, renames the owner where used", () => {
    const draft = design(d => { d.kpis = [kpi({ owner: "Rental coordinator Chakan", producingStepId: "TB-3", stepIds: ["TB-3"] })] as never; });
    const out = addOwnerRoles(draft);
    expect(out.design.roles!.map(role => role.name)).toEqual(draft.roles!.map(role => role.name));
    expect(out.design.roles![0]!.stepIds).toContain("TB-3");
    expect(at(out.design.kpis).owner).toBe("Rental coordinator");
    expect(out.warnings.map(w => w.code)).toEqual(["ROLE_OWNER_MATCHED"]);
    expect(addOwnerRoles(out.design).design).toBe(out.design);
  });
  it("collapses two equivalent new owners into one role carrying both owners' steps and duties", () => {
    const draft = design(d => { d.kpis = [kpi({ owner: "Credit controller" }), kpi({ id: "KPI-2", name: "Days sales outstanding", owner: "Credit controller Pune", producingStepId: "TB-2", stepIds: ["TB-2"] })] as never; });
    const out = addOwnerRoles(draft);
    const added = out.design.roles!.slice(3);
    expect(added).toHaveLength(1);
    expect(added[0]!.stepIds).toEqual(["TB-1", "TB-2"]);
    expect(added[0]!.responsibilities).toContain("Days sales outstanding");
    expect(out.design.kpis!.map(row => row.owner)).toEqual(["Credit controller", "Credit controller"]);
  });
  it("removes every ROLE_OWNER_UNCATALOGUED finding the owners caused, and adds no error", () => {
    const draft = withOwners();
    expect(blockersOf(draft).filter(item => item.startsWith("ROLE_OWNER_UNCATALOGUED"))).not.toEqual([]);
    const out = consolidateDesign(draft).design;
    expect(blockersOf(out).filter(item => item.startsWith("ROLE_OWNER_UNCATALOGUED"))).toEqual([]);
    expect(errorsOf(out)).toEqual(errorsOf(draft));
  });
  it("adds no role for an owner it can name no step for", () => {
    const draft = design(d => { d.keyDesignDecisions = [{ id: "KDD-9", owner: "Treasury head", impactedStepIds: [] }] as never; });
    expect(addOwnerRoles(draft).design).toBe(draft);
  });
  it("is idempotent and leaves a design with no role catalogue alone", () => {
    const once = consolidateDesign(withOwners()).design;
    expect(consolidateDesign(once)).toEqual({ design: once, warnings: [] });
    expect(consolidateDesign(once).design).toBe(once);
    const v1 = structuredClone(rentalDraft);
    expect(consolidateDesign(v1).design).toBe(v1);
  });
});

describe("syncFitGapSteps", () => {
  const coverageOf = (d: DetailedDesign) => d.coverage.find(row => row.requirementId === at(d.fitGap).requirementId)!;
  it("sets a fit-gap row's steps to those of the coverage row of its requirement, with a warning", () => {
    const draft = design(d => { coverageOf(d).stepIds = ["TB-2", "TB-3"]; at(d.fitGap).stepIds = ["TB-1"]; });
    const out = syncFitGapSteps(draft);
    expect(at(out.design.fitGap).stepIds).toEqual(["TB-2", "TB-3"]);
    expect(out.warnings).toEqual([{ code: "FITGAP_STEPS_SYNCED", path: "draft.fitGap.0" }]);
    expect(draft.fitGap![0]!.stepIds).toEqual(["TB-1"]); // the input is not mutated
    expect(syncFitGapSteps(out.design).design).toBe(out.design);
  });
  it("leaves a row alone when the steps agree (in any order), the coverage row has no steps, or the requirement has no coverage row", () => {
    const agree = design(d => { coverageOf(d).stepIds = ["TB-2", "TB-3"]; at(d.fitGap).stepIds = ["TB-3", "TB-2"]; });
    expect(syncFitGapSteps(agree).design).toBe(agree);
    const none = design(d => { coverageOf(d).stepIds = []; at(d.fitGap).stepIds = ["TB-1"]; });
    expect(syncFitGapSteps(none).design).toBe(none);
    const orphan = design(d => { at(d.fitGap).requirementId = "R-UNKNOWN"; });
    expect(syncFitGapSteps(orphan).design).toBe(orphan);
  });
  it("runs inside consolidateDesign", () => {
    const draft = design(d => { coverageOf(d).stepIds = ["TB-2"]; at(d.fitGap).stepIds = ["TB-1"]; });
    expect(at(consolidateDesign(draft).design.fitGap).stepIds).toEqual(["TB-2"]);
  });
});

describe("mergeStatusModels and mergeConfigRows", () => {
  const second = (model: DetailedDesign["documentStatusModels"] extends (infer M)[] | undefined ? M : never) => ({ ...model, id: "DSM-2", documentType: "hire order ", statuses: ["Open", "Closed"],
    transitions: [{ from: "Open", to: "Partly returned", stepId: "TB-2", event: "First item back" }, { from: "Fully returned", to: "Closed", stepId: "TB-3", event: "Final billing released" }],
    editLockRules: [{ afterEvent: "Closed", locked: "All dates", stillEditable: "Nothing" }] });
  it("merges two models of one document type: union of statuses and transitions by from, to and step, references rewritten, one warning", () => {
    const draft = design(d => {
      d.documentStatusModels = [at(d.documentStatusModels), second(at(d.documentStatusModels))];
      d.interfaces = [] as never;
      at(d.steps, 2).businessRules[0]!.response += " See status model DSM-2.";
    });
    const out = mergeStatusModels(draft);
    const [model] = out.design.documentStatusModels!;
    expect(out.design.documentStatusModels).toHaveLength(1);
    expect(model!.id).toBe("DSM-1");
    expect(model!.statuses).toEqual(["Open", "Partly returned", "Fully returned", "Closed"]);
    expect(model!.transitions.map(t => `${t.from}>${t.to}@${t.stepId}`)).toEqual(["null>Open@TB-1", "Open>Partly returned@TB-2", "Partly returned>Fully returned@TB-2", "Fully returned>Closed@TB-3"]);
    expect(model!.editLockRules).toHaveLength(2);
    expect(at(out.design.steps, 2).businessRules[0]!.response).toContain("DSM-1.");
    expect(out.warnings).toEqual([{ code: "DSM_MERGED", path: "draft.documentStatusModels.1" }]);
    expect(errorsOf(out.design)).toEqual(errorsOf(rentalDraftV3));
  });
  it("keeps two models of one type when the union would break the schema limits", () => {
    const many = (prefix: string) => Array.from({ length: 12 }, (_, i) => `${prefix}${i}`);
    const draft = design(d => { d.documentStatusModels = [{ ...at(d.documentStatusModels), statuses: many("A") }, { ...at(d.documentStatusModels), id: "DSM-2", statuses: many("B") }]; });
    expect(mergeStatusModels(draft).design).toBe(draft);
  });
  it("merges configuration rows of one category and name, unions steps and references, rewrites ids", () => {
    const draft = design(d => {
      d.configurationCatalogue = [at(d.configurationCatalogue), { ...at(d.configurationCatalogue), id: "CFG-2", name: "Hire  order", stepIds: ["TB-2"], referenceIds: ["REF-OBJ"] },
        { ...at(d.configurationCatalogue), id: "CFG-3", category: "REASON_CODE" as const }];
      at(d.steps, 0).businessRules[0]!.response += " Uses CFG-2.";
    });
    const out = mergeConfigRows(draft);
    expect(out.design.configurationCatalogue!.map(row => row.id)).toEqual(["CFG-1", "CFG-3"]);
    expect(at(out.design.configurationCatalogue)).toMatchObject({ stepIds: ["TB-1", "TB-2"], referenceIds: ["REF-OBJ"] });
    expect(at(out.design.steps, 0).businessRules[0]!.response).toContain("CFG-1.");
    expect(out.warnings).toEqual([{ code: "CONFIG_MERGED", path: "draft.configurationCatalogue.1" }]);
  });
});

describe("addDocumentTypeRows", () => {
  it("adds a DOCUMENT_TYPE row for the business to provide for a status model without one, owned by the role of its first step", () => {
    const draft = design(d => {
      d.configurationCatalogue = [{ ...at(d.configurationCatalogue), category: "REASON_CODE" as const, name: "Return reason" }];
      d.documentStatusModels = [at(d.documentStatusModels), { ...at(d.documentStatusModels), id: "DSM-2", documentType: "Return note", statuses: ["Recorded", "Billed"],
        transitions: [{ from: null, to: "Recorded", stepId: "TB-2", event: "Return recorded" }] }];
    });
    expect(errorsOf(draft)).toEqual(errorsOf(rentalDraftV3));
    expect(blockersOf(draft).filter(item => item.startsWith("CONFIG_DOCUMENT_TYPE_MISSING"))).toHaveLength(2);
    const out = addDocumentTypeRows(draft);
    expect(out.design.configurationCatalogue!.map(row => [row.id, row.category, row.name, row.status, row.owner, row.stepIds])).toEqual([
      ["CFG-1", "REASON_CODE", "Return reason", "BUSINESS_TO_PROVIDE", "Rental coordinator", ["TB-1"]],
      ["CFG-2", "DOCUMENT_TYPE", "Hire order", "BUSINESS_TO_PROVIDE", "Rental coordinator", ["TB-1", "TB-2"]],
      ["CFG-3", "DOCUMENT_TYPE", "Return note", "BUSINESS_TO_PROVIDE", "Rental stores clerk", ["TB-2"]]]);
    expect(out.warnings.map(w => w.code)).toEqual(["CONFIG_ROW_ADDED", "CONFIG_ROW_ADDED"]);
    expect(errorsOf(out.design)).toEqual(errorsOf(rentalDraftV3));
    expect(blockersOf(out.design).filter(item => item.startsWith("CONFIG_DOCUMENT_TYPE_MISSING"))).toEqual([]);
    expect(addDocumentTypeRows(out.design).design).toBe(out.design);
  });
});

describe("addKpiPlans", () => {
  it("gives a not-provided baseline and target a plan owned by the KPI owner, and leaves real values alone", () => {
    const draft = design(d => { d.kpis = [kpi(), kpi({ id: "KPI-2", baseline: "Quote turnaround today 5 days", target: "not provided" }), kpi({ id: "KPI-3", owner: "to be assigned" })] as never; });
    const out = addKpiPlans(draft);
    expect(out.design.kpis!.map(row => [row.baseline, row.target])).toEqual([
      ["not provided — current value to be measured by Rental operations lead from today's records before go-live", "Quote turnaround under 2 days"],
      ["Quote turnaround today 5 days", "not provided — to be set by Rental operations lead before go-live"],
      ["not provided", "Quote turnaround under 2 days"]]);
    expect(out.warnings).toEqual([{ code: "KPI_PLAN_ADDED", path: "draft.kpis.0.baseline" }, { code: "KPI_PLAN_ADDED", path: "draft.kpis.1.target" }]);
    expect(addKpiPlans(out.design).design).toBe(out.design);
  });
  it("is accepted by the KPI checks and the normaliser as not provided", () => {
    expect(isNotProvided("Not provided — to be set by CFO before go-live")).toBe(true);
    expect(isNotProvided("not provided anywhere in the answer")).toBe(false);
    const planned = kpi({ baseline: "not provided — current value to be measured by Credit controller from today's records before go-live", target: "not provided — to be set by Credit controller before go-live" });
    expect(normaliseKpiRows([planned], [{ fieldId: "kpi_baselines", value: "Days sales outstanding 62 days" }]).rows[0]).toBe(planned);
    const draft = design(d => { d.kpis = [planned] as never; });
    const codes = errorsOf(draft);
    expect(codes.filter(code => code.startsWith("KPI_VALUE"))).toEqual([]);
  });
});

describe("pipeline", () => {
  const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const settings = parseEnvironment({ ...local, NODE_ENV: "test", AI_TO_BE_REVIEW: "off", AI_TO_BE_FIX_MAX_PARTS: "0", AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-consolidate-key" });
  const split = splitDesign(rentalDraft);
  const groups = (group: RegisterGroup): unknown => {
    const base = rentalRegisterGroups[group];
    if (group === "integration") return { ...base, kpis: [kpi({ target: "not provided", contextFieldIds: [] })] };
    if (group === "documents") {
      const models = (base as typeof rentalRegisterGroups.documents).documentStatusModels;
      return { ...base, documentStatusModels: [models[0], { ...models[0], id: "DSM-2", documentType: "Hire order", statuses: ["Open", "Closed"],
        transitions: [{ from: "Open", to: "Closed", stepId: "TB-3", event: "Final billing released" }] }] };
    }
    if (group === "governance") {
      const roles = (base as typeof rentalRegisterGroups.governance).roles;
      return { ...base, roles: [...roles, { id: "ROLE-4", name: "Accounts payable clerk", responsibilities: "Posts supplier invoices.", stepIds: ["TB-3"] }, { id: "ROLE-5", name: "AP clerk", responsibilities: "Checks the match.", stepIds: ["TB-3"] }] };
    }
    return base;
  };
  it("comes out consolidated, with a warning per change and no new error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as RequestBody;
      if (String(_url).includes("count_tokens")) return new Response(JSON.stringify({ input_tokens: 1000 }), { headers: { "content-type": "application/json" } });
      const tool = toolOf(body), group = registerGroupOf(body);
      const out = tool === "submit_to_be_outline" ? split.outline : group ? groups(group) : split.details[stepIdOf(body)];
      return asStream(toolResponse(out, tool));
    });
    const result = await createStageRunner(settings, { fetch })("to_be", fixture());
    const warnings = (result.metrics.warnings ?? []).map(w => w.code);
    for (const code of ["ROLE_MERGED", "DSM_MERGED", "ROLE_ADDED_FOR_OWNER", "KPI_PLAN_ADDED"]) expect(warnings).toContain(code);
    const out = result.payload.design as unknown as DetailedDesign;
    expect(out.documentStatusModels).toHaveLength(1);
    expect(out.roles!.map(role => role.name)).toEqual(["Rental coordinator", "Rental stores clerk", "Billing clerk", "Accounts payable clerk", "Rental operations lead"]);
    expect(at(out.kpis).baseline).toMatch(/^not provided — current value to be measured by Rental operations lead/);
    expect(blockersOf(out).filter(item => item.startsWith("ROLE_OWNER_UNCATALOGUED") || item.startsWith("DUPLICATE_ROLE"))).toEqual([]);
  });
});
