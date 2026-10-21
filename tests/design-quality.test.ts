import { describe, expect, it } from "vitest";
import { rentalContext, rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { evaluateDesign, materializeComparison } from "../src/lib/ai/design-quality";

const fixture = () => ({ input: structuredClone(rentalContext), draft: structuredClone(rentalDraft) });
const codes = (input: unknown, draft: unknown) => evaluateDesign(input, draft).errors.map(error => error.code);

describe("detailed design quality contract", () => {
  it("accepts the detailed fictional draft but blocks release while decisions and SAP applicability are open", () => {
    const result = evaluateDesign(rentalContext, rentalDraft);
    expect(result.errors).toEqual([]);
    expect(result.structurallyValid).toBe(true);
    expect(result.reviewStatus).toBe("BLOCKED");
    expect(result.blockers.map(item => item.code)).toEqual(expect.arrayContaining(["OPEN_CONFLICT", "OPEN_QUESTION", "IMPLEMENTATION_UNVERIFIED", "TARGET_RELEASE_MISSING"]));
  });

  it("rejects the current superficial scope proposal as a detailed design", () => {
    expect(evaluateDesign(rentalContext, { scopeSummary: "Automate rental with SAP", proposedProcesses: [{ name: "Billing" }] }).structurallyValid).toBe(false);
  });

  it("requires operational actions and the fields used, not just a process title", () => {
    const { input, draft } = fixture(); draft.steps[0]!.actions = [];
    expect(codes(input, draft)).toContain("INVALID_DRAFT");
  });

  it("rejects invented source quotes and ambiguous upstream IDs", () => {
    const { input, draft } = fixture(); input.requirements[0]!.quote = "This fact was never provided";
    expect(codes(input, draft)).toContain("SOURCE_QUOTE_INVALID");
    input.requirements[0]!.quote = rentalContext.requirements[0]!.quote;
    input.sources.push({ ...input.sources[0]! });
    expect(codes(input, draft)).toContain("DUPLICATE_INPUT_ID");
  });

  it("reports missing requirement disposition instead of accepting omitted detail", () => {
    const { input, draft } = fixture(); draft.coverage.pop();
    expect(codes(input, draft)).toContain("REQUIREMENT_UNDISPOSITIONED");
  });

  it("requires As-Is coverage independently of requirement coverage", () => {
    const { input, draft } = fixture(); draft.steps[0]!.asIsStepIds = [];
    expect(codes(input, draft)).toContain("AS_IS_UNCOVERED");
  });

  it("rejects unknown trace IDs and fabricated reference IDs", () => {
    const { input, draft } = fixture();
    draft.steps[0]!.asIsStepIds.push("AS-FAKE");
    draft.steps[0]!.implementation = { ...draft.steps[0]!.implementation, referenceIds: ["REF-FAKE"] };
    expect(codes(input, draft)).toEqual(expect.arrayContaining(["UNKNOWN_AS_IS", "UNKNOWN_REFERENCE"]));
  });

  it("rejects a coverage link that does not match the step's requirement trace", () => {
    const { input, draft } = fixture(); draft.coverage[0]!.stepIds = ["TB-3"];
    expect(codes(input, draft)).toContain("COVERAGE_TRACE_MISMATCH");
  });

  it("requires tests for critical requirements, not merely tests somewhere in the document", () => {
    const { input, draft } = fixture(); draft.steps[1]!.acceptanceTests[1]!.requirementIds = ["R-3"];
    expect(codes(input, draft)).toContain("CRITICAL_REQUIREMENT_UNTESTED");
  });

  it("requires exception-path tests and explicit reasons when exceptions are not applicable", () => {
    const { input, draft } = fixture();
    draft.steps[0]!.acceptanceTests = draft.steps[0]!.acceptanceTests.filter(test => test.kind === "NORMAL");
    expect(codes(input, draft)).toContain("EXCEPTION_TEST_MISSING");
    draft.steps[0]!.exceptions = [];
    expect(codes(input, draft)).toContain("EXCEPTION_SCOPE_MISSING");
  });

  it("never permits the model to invent a business approval or resolve a conflict silently", () => {
    const { input, draft } = fixture();
    const changed = { ...draft, conflictDecisions: [{ conflictId: "CON-1", decisionId: "DEC-FAKE" }] };
    expect(codes(input, changed)).toContain("DECISION_NOT_APPROVED");
    draft.conflictDecisions = [];
    expect(codes(input, draft)).toContain("CONFLICT_UNDISPOSITIONED");
  });

  it("requires an approved decision to defer or reject a requirement", () => {
    const { input, draft } = fixture();
    draft.coverage[0] = { ...draft.coverage[0]!, disposition: "DEFERRED", stepIds: [] };
    expect(codes(input, draft)).toContain("DECISION_NOT_APPROVED");
  });

  it("does not equate a plausible SAP reference with verified release applicability", () => {
    const { input, draft } = fixture();
    const enriched = { ...input, targetRelease: "Fictional-Release-A", references: [{
      id: "REF-1", targetProduct: input.targetProduct, targetRelease: "Different-Release",
      status: "VERIFIED", evidence: "Synthetic verifier fixture only", fitType: "STANDARD",
    }] };
    draft.steps[0]!.implementation = { kind: "STANDARD", detail: "Claimed standard capability", referenceIds: ["REF-1"] };
    expect(codes(enriched, draft)).toContain("SAP_APPLICABILITY_UNVERIFIED");
  });

  it("requires unique step IDs and contiguous sequence, and rejects dangling test traces", () => {
    const { input, draft } = fixture();
    draft.steps[1]!.id = "TB-1"; draft.steps[2]!.sequence = 8;
    draft.steps[0]!.acceptanceTests[0]!.requirementIds.push("R-FAKE");
    expect(codes(input, draft)).toEqual(expect.arrayContaining(["DUPLICATE_OUTPUT_ID", "INVALID_SEQUENCE", "UNKNOWN_REQUIREMENT"]));
  });

  it("builds comparison evidence from supplied source facts without relabeling future requests as As-Is", () => {
    const rows = materializeComparison(rentalContext, rentalDraft);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.sourceFacts).toContainEqual({ requirementId: "R-1", sourceId: "SRC-1",
      locator: "Fictional workshop / order entry", quote: rentalContext.requirements[0]!.quote });
    expect(rows[0]!.toBe.id).toBe("TB-1");
  });

  it("does not render invalid drafts as trusted comparison rows", () => {
    const { input, draft } = fixture(); draft.steps[0]!.requirementIds = ["R-FAKE"];
    expect(() => materializeComparison(input, draft)).toThrow("INVALID_DETAILED_DESIGN");
  });

  it("requires human review even when all structural checks and known blockers are cleared", () => {
    const { input, draft } = fixture();
    input.targetRelease = "Fictional-Release-A";
    input.references = [{ id: "REF-1", targetProduct: input.targetProduct, targetRelease: input.targetRelease,
      status: "VERIFIED", evidence: "Synthetic reference fixture; not a real SAP claim", fitType: "STANDARD" }];
    input.approvedDecisions = [{ id: "DEC-1", subjectType: "CONFLICT", subjectId: "CON-1",
      outcome: "RESOLVED", rationale: "Fictional approved decision for testing structural behavior only" }];
    draft.conflictDecisions[0]!.decisionId = "DEC-1";
    draft.openQuestions = [];
    draft.steps.forEach(step => { step.implementation = { kind: "STANDARD",
      detail: "Synthetic proposed behavior", referenceIds: ["REF-1"] }; });
    const result = evaluateDesign(input, draft);
    expect(result).toEqual({ structurallyValid: true, errors: [], blockers: [], reviewStatus: "HUMAN_REVIEW_REQUIRED" });
    // Removing a question does not prove the text incorporated the decision.
    // That semantic issue remains part of human review, even in this clean case.
    input.references[0]!.status = "UNVERIFIED";
    expect(codes(input, draft)).toContain("SAP_APPLICABILITY_UNVERIFIED");
  });

  it("does not allow an approval for one subject to authorize another", () => {
    const { input, draft } = fixture();
    input.approvedDecisions = [{ id: "DEC-1", subjectType: "REQUIREMENT", subjectId: "R-2",
      outcome: "DEFERRED", rationale: "Fictional approval for a different requirement" }];
    draft.coverage[0] = { ...draft.coverage[0]!, disposition: "DEFERRED", stepIds: [], decisionId: "DEC-1" };
    expect(codes(input, draft)).toContain("DECISION_NOT_APPROVED");
  });

  it("reports duplicate dispositions and unknown question targets", () => {
    const { input, draft } = fixture();
    draft.coverage.push({ ...draft.coverage[0]! });
    draft.openQuestions[0]!.affectedStepIds = ["TB-FAKE"];
    expect(codes(input, draft)).toEqual(expect.arrayContaining(["DUPLICATE_DISPOSITION", "UNKNOWN_STEP"]));
  });
});

describe("actionable draft errors", () => {
  const draftErrors = (input: unknown, draft: unknown) => evaluateDesign(input, draft).errors.filter(item => item.code === "INVALID_DRAFT");

  it("points at the real path and names the invented key without echoing its value", () => {
    const { input, draft } = fixture();
    const secret = "SECRET-VALUE-".repeat(50);
    Object.assign(draft.steps[0]!.actions[0]!, { fitnote: secret });
    const errors = draftErrors(input, draft);
    expect(errors).toContainEqual({ code: "INVALID_DRAFT", path: "draft.steps.0.actions.0", detail: "unrecognized_keys: fitnote" });
    expect(JSON.stringify(errors)).not.toContain("SECRET-VALUE");
  });

  it("reports expected type for wrong-typed fields and bounds hostile key names and error count", () => {
    const { input, draft } = fixture();
    (draft.steps[0] as Record<string, unknown>).sequence = "one";
    for (let i = 0; i < 40; i++) (draft as Record<string, unknown>)[`bad${i}`] = 1;
    (draft as Record<string, unknown>)["x".repeat(500) + " <script>"] = 1;
    const errors = draftErrors(input, draft);
    expect(errors.length).toBeLessThanOrEqual(20);
    expect(errors).toContainEqual({ code: "INVALID_DRAFT", path: "draft.steps.0.sequence", detail: "invalid_type: expected number" });
    expect(errors.every(item => item.path.length <= 200 && (item.detail?.length ?? 0) <= 200)).toBe(true);
    expect(JSON.stringify(errors)).not.toContain("<script>");
  });

  it("keeps a bare INVALID_DRAFT error for a non-object draft", () => {
    expect(draftErrors(rentalContext, "nope")).toEqual([{ code: "INVALID_DRAFT", path: "draft", detail: "invalid_type: expected object" }]);
  });
});

describe("trusted SAP reference applicability", () => {
  type Fit = "STANDARD" | "CONFIGURATION" | "EXTENSION" | "INTEGRATION" | "MANUAL" | "LICENSE_DEPENDENT";
  const reference = (id: string, fitType: Fit, overrides: Record<string, unknown> = {}) => ({
    id, targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: "2023", status: "VERIFIED" as const,
    evidence: "Synthetic quote for structural tests only", fitType, capability: "Synthetic capability",
    objects: ["Synthetic object"], limitations: [], evidenceUrls: ["https://help.sap.com/synthetic"], ...overrides,
  });
  function setup(kind: "STANDARD" | "CONFIGURATION" | "EXTENSION" | "INTEGRATION" | "MANUAL" | "NEEDS_VALIDATION",
    referenceIds: string[], references = [reference("REF-STD", "STANDARD"), reference("REF-EXT", "EXTENSION"),
      reference("REF-LIC", "LICENSE_DEPENDENT"), reference("REF-CFG", "CONFIGURATION"), reference("REF-INT", "INTEGRATION")]) {
    const { input, draft } = fixture();
    const context = { ...input, targetRelease: "2023", references };
    draft.steps[0]!.implementation = { kind, detail: "Synthetic realization", referenceIds };
    const result = evaluateDesign(context, draft);
    return { errors: result.errors.map(item => item.code), blockers: result.blockers,
      stepBlockers: result.blockers.filter(item => item.path === "draft.steps.0.implementation").map(item => item.code),
      stepErrors: result.errors.filter(item => item.path === "draft.steps.0.implementation").map(item => item.code) };
  }

  it("accepts a step citing a verified, release-matching reference with consistent fit", () => {
    for (const [kind, ids] of [["STANDARD", ["REF-STD"]], ["STANDARD", ["REF-STD", "REF-CFG"]], ["CONFIGURATION", ["REF-CFG"]],
      ["CONFIGURATION", ["REF-STD", "REF-CFG"]], ["EXTENSION", ["REF-STD", "REF-EXT"]], ["INTEGRATION", ["REF-INT"]]] as const) {
      const result = setup(kind, [...ids]);
      expect(result.stepErrors, `${kind} ${ids}`).toEqual([]);
      expect(result.stepBlockers, `${kind} ${ids}`).toEqual([]);
    }
  });
  it("rejects unknown reference ids as structural errors", () => {
    expect(setup("STANDARD", ["REF-STD", "REF-FAKE"]).stepErrors).toContain("UNKNOWN_REFERENCE");
  });
  it("rejects a STANDARD claim backed only by an extension or license-dependent entry", () => {
    expect(setup("STANDARD", ["REF-EXT"]).stepErrors).toContain("SAP_FIT_MISMATCH");
    expect(setup("STANDARD", ["REF-LIC"]).stepErrors).toContain("SAP_FIT_MISMATCH");
    expect(setup("STANDARD", ["REF-STD", "REF-EXT"]).stepErrors).toContain("SAP_FIT_MISMATCH");
    expect(setup("CONFIGURATION", ["REF-STD"]).stepErrors).toContain("SAP_FIT_MISMATCH");
    expect(setup("EXTENSION", ["REF-STD"]).stepErrors).toContain("SAP_FIT_MISMATCH");
  });
  it("rejects a release or product mismatch and an unverified entry", () => {
    expect(setup("STANDARD", ["REF-STD"], [reference("REF-STD", "STANDARD", { targetRelease: "2022" })]).stepErrors)
      .toContain("SAP_APPLICABILITY_UNVERIFIED");
    expect(setup("STANDARD", ["REF-STD"], [reference("REF-STD", "STANDARD", { targetProduct: "S4HANA_ON_PREMISE" })]).stepErrors)
      .toContain("SAP_APPLICABILITY_UNVERIFIED");
    expect(setup("STANDARD", ["REF-STD"], [reference("REF-STD", "STANDARD", { status: "UNVERIFIED" })]).stepErrors)
      .toContain("SAP_APPLICABILITY_UNVERIFIED");
  });
  it("requires a release-matching reference for extension and integration claims too", () => {
    const stale = [reference("REF-EXT", "EXTENSION", { targetRelease: "2022" })];
    expect(setup("EXTENSION", ["REF-EXT"], stale).stepErrors).toContain("SAP_APPLICABILITY_UNVERIFIED");
  });
  it("keeps steps without a trusted reference as blockers, not errors", () => {
    const none = setup("NEEDS_VALIDATION", []);
    expect(none.stepErrors).toEqual([]);
    expect(none.stepBlockers).toEqual(["IMPLEMENTATION_UNVERIFIED"]);
    expect(setup("EXTENSION", []).stepErrors).toEqual([]);
    expect(setup("EXTENSION", []).stepBlockers).toEqual(["SAP_REFERENCE_MISSING"]);
    expect(setup("INTEGRATION", []).stepBlockers).toEqual(["SAP_REFERENCE_MISSING"]);
    expect(setup("MANUAL", []).stepBlockers).toEqual([]);
    expect(setup("STANDARD", []).stepErrors).toContain("SAP_APPLICABILITY_UNVERIFIED");
  });
  it("blocks release when a cited entry depends on an unconfirmed license", () => {
    expect(setup("EXTENSION", ["REF-EXT", "REF-LIC"]).stepBlockers).toEqual(["LICENSE_ENTITLEMENT_UNCONFIRMED"]);
  });
  it("names the claimed kind and the cited fit types (ids and fit types only) on SAP_FIT_MISMATCH", () => {
    const { input, draft } = fixture();
    const references = [reference("REF-STD", "STANDARD"), reference("REF-EXT", "EXTENSION", { capability: "LEAKY-CAPABILITY" })];
    draft.steps[0]!.implementation = { kind: "STANDARD", detail: "Synthetic realization", referenceIds: ["REF-STD", "REF-EXT"] };
    const result = evaluateDesign({ ...input, targetRelease: "2023", references }, draft);
    const mismatch = result.errors.find(item => item.code === "SAP_FIT_MISMATCH");
    expect(mismatch).toEqual({ code: "SAP_FIT_MISMATCH", path: "draft.steps.0.implementation",
      detail: "kind STANDARD; cited REF-STD=STANDARD, REF-EXT=EXTENSION" });
    expect(JSON.stringify(mismatch)).not.toContain("LEAKY");
  });
});

describe("open decisions and conditional coverage", () => {
  const register = [{ id: "DR-1" }, { id: "DR-2" }];
  const withRegister = () => { const f = fixture(); f.input.decisionRegister = register; return f; };

  it("accepts question and step links to decisions in the supplied register", () => {
    const { input, draft } = withRegister();
    draft.openQuestions[0]!.decisionIds = ["DR-1"]; draft.steps[0]!.decisionIds = ["DR-1", "DR-2"];
    expect(evaluateDesign(input, draft).errors).toEqual([]);
  });

  it("rejects an unknown decision id on a question or a step", () => {
    const { input, draft } = withRegister();
    draft.openQuestions[0]!.decisionIds = ["DR-FAKE"];
    expect(codes(input, draft)).toContain("UNKNOWN_DECISION");
    draft.openQuestions[0]!.decisionIds = []; draft.steps[0]!.decisionIds = ["DR-FAKE"];
    expect(evaluateDesign(input, draft).errors).toContainEqual(expect.objectContaining({ code: "UNKNOWN_DECISION", path: "draft.steps.0" }));
  });

  it("requires decisionIds to be empty when no register was supplied", () => {
    const { input, draft } = fixture();
    expect(evaluateDesign(input, draft).errors).toEqual([]);
    draft.openQuestions[0]!.decisionIds = ["DR-1"];
    expect(codes(input, draft)).toContain("UNKNOWN_DECISION");
  });

  const conditional = (draft: ReturnType<typeof fixture>["draft"], extra = {}) => {
    draft.coverage[0] = { ...draft.coverage[0]!, disposition: "CONDITIONAL", ...extra };
  };

  it("accepts CONDITIONAL coverage tied to an open decision or question, as a review blocker not an error", () => {
    const { input, draft } = withRegister();
    conditional(draft, { decisionIds: ["DR-1"] });
    const result = evaluateDesign(input, draft);
    expect(result.errors).toEqual([]);
    expect(result.blockers).toContainEqual({ code: "COVERAGE_CONDITIONAL", path: "draft.coverage.0" });
    expect(result.reviewStatus).toBe("BLOCKED");
    const viaQuestion = fixture(); conditional(viaQuestion.draft, { questionIds: ["Q-1"] });
    expect(evaluateDesign(viaQuestion.input, viaQuestion.draft).errors).toEqual([]);
  });

  it("accepts IMPLEMENTED coverage and steps linked to open decisions that only supply policy values, without a blocker", () => {
    const { input, draft } = withRegister();
    draft.coverage[0] = { ...draft.coverage[0]!, disposition: "IMPLEMENTED", decisionIds: ["DR-1"] };
    draft.steps[0]!.decisionIds = ["DR-1"];
    const result = evaluateDesign(input, draft);
    expect(result.errors).toEqual([]);
    expect(result.blockers.map(item => item.code)).not.toContain("COVERAGE_CONDITIONAL");
  });

  it("rejects CONDITIONAL coverage with no open link, an unknown link, or an approval", () => {
    const bare = withRegister(); conditional(bare.draft);
    expect(codes(bare.input, bare.draft)).toContain("CONDITIONAL_UNLINKED");
    const unknown = withRegister(); conditional(unknown.draft, { decisionIds: ["DR-FAKE"], questionIds: ["Q-FAKE"] });
    expect(codes(unknown.input, unknown.draft)).toEqual(expect.arrayContaining(["UNKNOWN_DECISION", "UNKNOWN_QUESTION"]));
    const approved = withRegister(); conditional(approved.draft, { decisionIds: ["DR-1"], decisionId: "DEC-1" });
    expect(codes(approved.input, approved.draft)).toContain("UNEXPECTED_DECISION");
  });

  it("still requires CONDITIONAL coverage to trace to the steps that carry the requirement", () => {
    const { input, draft } = withRegister();
    conditional(draft, { decisionIds: ["DR-1"], stepIds: ["TB-3"] });
    expect(codes(input, draft)).toContain("COVERAGE_TRACE_MISMATCH");
  });

  it("rejects decisionIds on IMPLEMENTED coverage unknown to the register", () => {
    const { input, draft } = withRegister();
    draft.coverage[0] = { ...draft.coverage[0]!, decisionIds: ["DR-FAKE"] };
    expect(codes(input, draft)).toContain("UNKNOWN_DECISION");
  });
});
