import { describe, expect, it } from "vitest";
import type { DetailedDesign } from "../src/lib/ai/design-quality";
import { actorRoles, asIsNarratives, deriveSections, documentControl, ricefwList, type DeriveMeta } from "../src/lib/to-be-derived";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV2, rentalDraftV3 } from "../fixtures/ai/to-be/rental-registers";
import { fixture } from "./support/to-be-input";

const asIsSteps = fixture().discovery.asIsSteps;
const meta: DeriveMeta = { sourceRevision: 7, variantCode: "RENTAL", variantName: "Fictional equipment hire", snapshotId: "11111111-1111-4111-8111-111111111111",
  generatedAt: "2026-10-21T09:30:00.000Z", targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: "2023",
  sources: [{ id: "SRC-1", title: "Workshop 1", revision: "v1", digest: "ab".repeat(32) }, { id: "SRC-2", title: "Workshop 2", revision: "v1" }] };
const sections = deriveSections({ design: rentalDraftV3, asIsSteps, meta });

describe("document control (checklist 1)", () => {
  const control = documentControl({ design: rentalDraftV3, meta });
  it("carries version, date, source revision, target and per-source digests from the frozen metadata", () => {
    expect(control).toMatchObject({ title: rentalDraftV3.processName, version: "0.1 draft", date: "2026-10-21", designSchemaVersion: 3,
      sourceRevision: { discoveryRevision: 7, variantCode: "RENTAL", snapshotId: meta.snapshotId, targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: "2023" } });
    expect(control.sourceRevision.sources).toEqual([{ id: "SRC-1", title: "Workshop 1", revision: "v1", digest: "ab".repeat(32) },
      { id: "SRC-2", title: "Workshop 2", revision: "v1", digest: "Not recorded" }]);
  });
  it("lists reviewer roles as placeholders and a sign-off table that is always review-required, never approved", () => {
    expect(control.reviewerRoles.length).toBeGreaterThanOrEqual(3);
    expect(control.reviewerRoles.every(item => item.assignee === "to be assigned")).toBe(true);
    expect(control.signOff.map(item => item.status)).toEqual(control.signOff.map(() => "HUMAN_REVIEW_REQUIRED"));
    expect(control.signOff.every(item => item.name === "to be assigned" && item.date === "-")).toBe(true);
    expect(control.status).toBe("HUMAN_REVIEW_REQUIRED");
    expect(JSON.stringify(control)).not.toMatch(/approved/i);
  });
  it("says so when the date, release or revision is not known", () => {
    const empty = documentControl({ design: rentalDraft, meta: { ...meta, generatedAt: null, targetRelease: null, sourceRevision: null } });
    expect(empty).toMatchObject({ date: "Not recorded", designSchemaVersion: 1, sourceRevision: { targetRelease: "not decided", discoveryRevision: null } });
  });
});

describe("As-Is narrative per step (checklist 5)", () => {
  it("keys each To-Be step to the client text of the As-Is steps it replaces, verbatim", () => {
    expect(sections.asIsNarratives.map(item => item.toBeStepId)).toEqual(["TB-1", "TB-2", "TB-3"]);
    const first = sections.asIsNarratives[0]!;
    expect(first.asIs).toHaveLength(1);
    expect(first.asIs[0]).toMatchObject({ asIsStepId: "AS-1", name: "Create hire order", description: asIsSteps[0]!.description, actor: "Rental coordinator" });
    expect(first.asIs[0]!.description).toContain("copies accepted quotation quantities into a spreadsheet");
  });
  it("lists eliminated As-Is steps with the design's reason, and skips an As-Is id the discovery does not hold", () => {
    const design: DetailedDesign = { ...rentalDraftV3, eliminatedAsIsSteps: [{ asIsStepId: "AS-2", reason: "Paper copy no longer needed" }],
      steps: rentalDraftV3.steps.map((step, i) => i === 0 ? { ...step, asIsStepIds: ["AS-1", "AS-404"] } : step) };
    const result = asIsNarratives({ design, asIsSteps });
    expect(result.eliminated).toEqual([{ asIsStepId: "AS-2", name: "Record returns", description: asIsSteps[1]!.description, reason: "Paper copy no longer needed" }]);
    expect(result.narratives[0]!.asIs.map(item => item.asIsStepId)).toEqual(["AS-1"]);
  });
  it("never mixes To-Be wording into the As-Is text", () => {
    const text = JSON.stringify(sections.asIsNarratives);
    for (const step of rentalDraftV3.steps) expect(text).not.toContain(step.addedValue);
  });
});

describe("consolidated RICEFW list: the same enhancement is listed once", () => {
  const TEXT = "Key-user extension adds a deposit approval field to the rental order and blocks release until it is filled.";
  const withSteps = (kinds: number[], fitGap: DetailedDesign["fitGap"]): DetailedDesign => {
    const draft = structuredClone(rentalDraftV3) as DetailedDesign;
    for (const i of kinds) draft.steps[i]!.implementation = { ...draft.steps[i]!.implementation, kind: "EXTENSION", detail: TEXT, referenceIds: [] };
    return { ...draft, fitGap };
  };
  const row = (requirementId: string, stepIds: string[], justification: string) => ({ ...rentalDraftV3.fitGap![0]!, requirementId, stepIds, classification: "KEY_USER_EXTENSION" as const, ricefwType: "ENHANCEMENT" as const, justification });
  it("merges two step-derived items that name the same enhancement into one with both steps", () => {
    const list = ricefwList({ design: withSteps([0, 1], []) });
    expect(list).toHaveLength(1);
    expect(list[0]!.linkedSteps.map(step => step.id)).toEqual(["TB-1", "TB-2"]);
  });
  it("merges a step-derived item into the fit-gap item whose rationale it repeats, keeping the union of steps", () => {
    const list = ricefwList({ design: withSteps([1], [row("R-1", ["TB-1"], TEXT)]) });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: "FIT_GAP", requirementId: "R-1" });
    expect(list[0]!.linkedSteps.map(step => step.id)).toEqual(["TB-1", "TB-2"]);
  });
  it("keeps apart items of different types and fit-gap rows for different requirements", () => {
    const rows = [row("R-1", ["TB-1"], TEXT), row("R-2", ["TB-2"], TEXT), { ...row("R-3", ["TB-3"], TEXT), ricefwType: "REPORT" as const }];
    expect(ricefwList({ design: withSteps([], rows) }).map(item => item.requirementId)).toEqual(["R-1", "R-2", "R-3"]);
  });
});

describe("consolidated RICEFW list (checklist 19)", () => {
  it("has one entry per fit-gap row that needs something built, typed, with its linked steps and rationale", () => {
    const list = ricefwList({ design: rentalDraftV3 });
    expect(list.map(item => item.requirementId)).toEqual(["R-1", "R-2", "R-3", "R-5"]);
    expect(list.map(item => item.id)).toEqual(["RICEFW-1", "RICEFW-2", "RICEFW-3", "RICEFW-4"]);
    expect(list[3]).toMatchObject({ type: "ENHANCEMENT", classification: "CLASSIC_RICEFW", owner: "Rental coordinator", status: "OPEN",
      linkedSteps: [{ id: "TB-3", title: rentalDraftV3.steps[2]!.title }], needsValidation: true });
    expect(list[0]).toMatchObject({ type: "ENHANCEMENT", classification: "KEY_USER_EXTENSION" });
    expect(list.every(item => item.rationale.length > 0)).toBe(true);
  });
  it("omits standard, configuration and manual rows, and links the steps that cite the requirement even when the row does not", () => {
    const design: DetailedDesign = { ...rentalDraftV3, fitGap: rentalDraftV3.fitGap!.map(row => row.requirementId === "R-1" ? { ...row, stepIds: [] } : row) };
    const list = ricefwList({ design });
    expect(list.find(item => item.requirementId === "R-1")!.linkedSteps.map(step => step.id)).toEqual(["TB-1"]);
    expect(list.some(item => ["R-4", "R-6"].includes(item.requirementId ?? ""))).toBe(false);
    const withIntegration: DetailedDesign = { ...rentalDraftV3, fitGap: rentalDraftV3.fitGap!.map(row => row.requirementId === "R-4" ? { ...row, classification: "STANDARD_INTEGRATION", ricefwType: null } : row) };
    expect(ricefwList({ design: withIntegration }).map(item => item.requirementId)).toContain("R-4");
  });
  it("is empty for a version 1 design, and for a version 2 design carries no owner or status", () => {
    expect(ricefwList({ design: rentalDraft })).toEqual([]);
    expect(ricefwList({ design: rentalDraftV2 })[0]).toMatchObject({ owner: null, status: null });
  });
});

describe("actor to role matrix", () => {
  it("shows the roles that cover each step next to the actor as written", () => {
    expect(sections.actorRoles).toEqual([{ stepId: "TB-1", actor: "Rental coordinator", roleIds: ["ROLE-1"] },
      { stepId: "TB-2", actor: "Rental stores clerk", roleIds: ["ROLE-2"] }, { stepId: "TB-3", actor: "Billing clerk", roleIds: ["ROLE-3"] }]);
    expect(actorRoles({ design: rentalDraftV2 }).every(row => row.roleIds.length === 0)).toBe(true);
  });
});

describe("RICEFW list beyond the fit-gap rows", () => {
  const withKinds = (change: (design: DetailedDesign) => void) => { const design = structuredClone(rentalDraftV3); change(design); return design; };
  it("adds every step realised as an extension or integration that no fit-gap item already links, once, with its own source", () => {
    // TB-2 is already linked by fit-gap items, so realising it as an integration adds no second row.
    const linked = withKinds(d => { d.steps[1]!.implementation = { kind: "INTEGRATION", detail: "Receive the return confirmation from the customer portal.", referenceIds: [] }; });
    expect(ricefwList({ design: linked }).some(item => item.source === "STEP")).toBe(false);
    const orphan = withKinds(d => { d.steps[1]!.implementation = { kind: "EXTENSION", detail: "Key-user logic.", referenceIds: [] }; d.fitGap = d.fitGap!.filter(row => !["R-3", "R-4"].includes(row.requirementId)); d.steps[1]!.requirementIds = []; d.steps[1]!.enablesStepIds = ["TB-3"]; });
    const added = ricefwList({ design: orphan }).filter(item => item.source === "STEP");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: "ENHANCEMENT", classification: "STEP_EXTENSION", requirementId: null, linkedSteps: [{ id: "TB-2", title: orphan.steps[1]!.title }], needsValidation: true });
    expect(ricefwList({ design: orphan }).map(item => item.id)).toEqual(ricefwList({ design: orphan }).map((_, i) => `RICEFW-${i + 1}`));
  });
  it("adds a report or KPI realised with custom analytics, and leaves a standard one out", () => {
    const design = withKinds(d => {
      d.reports![0]!.realization = "A custom analytical query over hire items filtered by status.";
      d.reports!.push({ ...d.reports![0]!, id: "REP-2", name: "Hire items list", realization: "The standard hire item list app." });
    });
    const list = ricefwList({ design });
    const analytics = list.filter(item => item.source === "ANALYTICS");
    expect(analytics).toHaveLength(1);
    expect(analytics[0]).toMatchObject({ type: "REPORT", classification: "CUSTOM_ANALYTICS" });
    expect(analytics[0]!.rationale).toContain("Open hire items by return date");
    expect(ricefwList({ design: rentalDraftV3 }).some(item => item.source === "ANALYTICS")).toBe(false);
  });
});
