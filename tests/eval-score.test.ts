import { describe, expect, it } from "vitest";
import fixture from "../fixtures/eval/pump-o2c.json";
import { STEP_KEYS, WORKSPACE_FIELDS } from "../src/lib/workspace-fields";
import { jaccard, ScoringCaseSchema, scoreRun, summarize, type Transcript } from "../src/lib/eval-score";

const evalCase = ScoringCaseSchema.parse(fixture);
type Step = NonNullable<NonNullable<Transcript["toBe"]>["design"]>["steps"][number];

/** One To-Be step per expected capability, each tied to the fixture requirement that names its pain. */
const CAPABILITY_STEPS: [capability: string, requirementKey: string, title: string, detail: string][] = [
  ["credit", "credit", "Automatic credit check at order entry", "Credit management with a credit limit check on every sales order."],
  ["atp", "atp", "Availability check on order lines", "Available-to-promise check against plant stock."],
  ["mto", "mto", "Link sales order to production", "Make-to-order flow creates the production order from the sales order."],
  ["serial", "serial", "Capture motor serial numbers", "Serial number assignment at goods issue."],
  ["einvoice", "einvoice-pain", "Generate e-invoice and e-way bill", "India e-invoicing returns the IRN and e-way bill from the billing document."],
  ["returns", "returns", "Process customer returns", "Returns management references the original billing document."],
  ["interplant", "interplant", "Bill inter-plant transfers", "Stock transport order with intercompany billing between plants."],
  ["bankrecon", "payment-matching", "Match incoming payments", "Bank statement import with automatic clearing of open items."],
  ["margin", "margin", "Report margin by customer and product", "Margin analysis through profitability reporting."],
];

function step(i: number, title: string, detail: string, requirementKey: string, extra: Partial<Step> = {}): Step {
  return { id: `D${i}`, title, requirementIds: [`rq_${requirementKey}`],
    actions: [{ operation: detail, system: "S/4HANA", fields: ["Document number"] }],
    implementation: { kind: "STANDARD", detail }, acceptanceTests: [{ given: "an order", when: "it is processed", then: "it posts" }],
    addedValue: "Fewer manual re-entries.", ...extra };
}
const turn = (index: number, gapKeys: string[], extra: Partial<Transcript["turns"][number]> = {}): Transcript["turns"][number] => ({
  index, userMessage: `message ${index}`, gapsAvailable: 5,
  questions: gapKeys.map(k => ({ gapKey: k, fieldId: k.slice(2), question: `Distinct question about ${k.slice(2)} topic number ${index}` })),
  proposals: 1, attempts: 1, validationErrors: 0, issues: [], error: null, inputTokens: 100, outputTokens: 50, latencyMs: 10, ...extra });

/** A passing run; each test mutates a private copy. */
function goodTranscript(): Transcript {
  const steps = [
    ...CAPABILITY_STEPS.map(([, key, title, detail], i) => step(i + 1, title, detail, key)),
    step(10, "Integrate Salesforce quotes", "Quote data flows from Salesforce to the sales order.", "salesforce",
      { implementation: { kind: "INTEGRATION", detail: "Salesforce quote to SAP sales order integration." } }),
    step(11, "Track delivery and collections", "Delivery and receivables monitoring.", "otif", {
      acceptanceTests: [
        { given: "a shipment", when: "OTIF is measured", then: "OTIF is above 90% for the month" },
        { given: "open invoices", when: "DSO is measured", then: "DSO is 65 days or less" },
        { given: "the period end", when: "closing runs", then: "the month-end close completes in 5 days" }] }),
  ];
  return {
    schemaVersion: 1, caseId: "pump-o2c", provider: "anthropic", model: "test-model", startedAt: "2026-10-22T00:00:00.000Z",
    turns: [turn(1, ["g_process_owner", "g_scope_boundary"]), turn(2, ["g_current_trigger"]), turn(3, ["g_desired_outcome"])],
    readiness: { reached: true, atTurn: 3, forcedCompletion: false, directEdits: 0, blockers: [] },
    toBe: { attempted: true, structurallyValid: true, errorCode: null, attempts: 1, validationErrors: 0, inputTokens: 10, outputTokens: 10,
      requirements: fixture.requirements.map(r => ({ id: `rq_${r.key}`, statement: r.statement })), design: { steps } },
    aborted: null,
  };
}
const score = (t: Transcript) => scoreRun(t, evalCase);
const check = (t: Transcript, name: string) => score(t).checks.find(c => c.name === name)!;

describe("fixture integrity", () => {
  it("answers every empty catalog field and defines 11 complete steps", () => {
    const empty = WORKSPACE_FIELDS.filter(f => f.id !== "business_problem").map(f => f.id).sort();
    expect(Object.keys(fixture.answerBank.catalog).sort()).toEqual(empty);
    expect(fixture.steps).toHaveLength(11);
    for (const s of fixture.steps) for (const key of STEP_KEYS) expect(s[key].length, `${s.n}.${key}`).toBeGreaterThan(0);
    expect(fixture.steps.map(s => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const r of fixture.requirements) expect(r.stepN).toBeGreaterThanOrEqual(1);
    expect(fixture.opening.length).toBeGreaterThan(200);
    expect(fixture.expected.capabilities).toHaveLength(9);
  });
  it("keeps every answer clear of the sensitive-text screen applied to messages", () => {
    const answers = [fixture.opening, ...Object.values(fixture.answerBank.catalog),
      ...fixture.steps.flatMap(s => STEP_KEYS.map(k => s[k])), ...fixture.requirements.map(r => r.statement)];
    for (const text of answers) expect(text).not.toMatch(/@|password|api[_ -]?key|secret\s*[:=]|token\s*[:=]|Bearer/i);
  });
});

describe("scoreRun", () => {
  it("passes a complete, well-linked run", () => {
    const result = score(goodTranscript());
    expect(result.capabilityCount).toBe(9);
    expect(result.kpiCount).toBe(3);
    expect(result.salesforce).toEqual({ integration: true, replaced: false });
    expect(result.pass).toBe(true);
    expect(summarize(result)).toContain("PASS");
  });

  it("counts a capability only when the step links to a requirement naming the pain", () => {
    const t = goodTranscript();
    // The credit step still says "credit limit", but now cites a requirement about something else.
    t.toBe!.design!.steps[0]!.requirementIds = ["rq_margin"];
    const result = score(t);
    const credit = result.capabilities.find(c => c.id === "credit")!;
    expect(credit).toMatchObject({ covered: false, reason: "no_requirement_link" });
    expect(result.capabilityCount).toBe(8);
    expect(result.pass).toBe(true); // 8/9 still meets the bar of 8
    t.toBe!.design!.steps[1]!.requirementIds = ["rq_margin"];
    expect(check(t, "capabilities").pass).toBe(false);
    expect(score(t).pass).toBe(false);
  });

  it("does not count a capability whose step text never mentions it", () => {
    const t = goodTranscript();
    t.toBe!.design!.steps[3] = step(4, "Handle motors", "Record the motor in the system.", "serial");
    const serial = score(t).capabilities.find(c => c.id === "serial")!;
    expect(serial).toMatchObject({ covered: false, reason: "no_solution_text" });
  });

  it("flags near-duplicate questions at Jaccard 0.8 and above", () => {
    expect(jaccard("Who owns the current order process?", "Who owns the current order process")).toBe(1);
    expect(jaccard("Which systems do you use today?", "Which unrelated warehouse costing rules apply?")).toBeLessThan(0.8);
    const t = goodTranscript();
    t.turns[1]!.questions = [{ gapKey: "g_other", fieldId: "other", question: "Who owns the current order process, please?" }];
    t.turns[0]!.questions = [{ gapKey: "g_owner", fieldId: "owner", question: "Who owns the current order process?" }];
    const result = score(t);
    expect(result.nearDuplicates).toHaveLength(1);
    expect(check(t, "nearDuplicates").pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("detects a gapKey asked twice, across turns or within one turn", () => {
    const t = goodTranscript();
    t.turns[1]!.questions[0]!.gapKey = "g_process_owner";
    expect(score(t).repeatedGapKeys).toEqual(["g_process_owner"]);
    const same = goodTranscript();
    same.turns[0]!.questions[1]!.gapKey = same.turns[0]!.questions[0]!.gapKey;
    expect(score(same).repeatedGapKeys).toHaveLength(1);
    expect(check(t, "repeatedGapKeys").pass).toBe(false);
  });

  it("flags zero-question turns only while gaps remain", () => {
    const t = goodTranscript();
    t.turns[1]!.questions = []; t.turns[2]!.questions = []; t.turns[2]!.gapsAvailable = 0;
    expect(score(t).turns.zeroQuestionTurnsWithGapsRemaining).toEqual([2]);
  });

  it("computes the first-attempt-valid rate from recorded attempts and errors", () => {
    const t = goodTranscript();
    t.turns[0]!.attempts = 2; t.turns[0]!.validationErrors = 1;
    expect(score(t).firstAttemptValidRate).toBeCloseTo(0.667, 2);
    expect(check(t, "firstAttemptValid").pass).toBe(false);
    const failed = goodTranscript();
    failed.turns[2]!.error = "AI_INVALID_OUTPUT";
    expect(score(failed).turns.failedTurns).toEqual([{ turn: 3, error: "AI_INVALID_OUTPUT" }]);
  });

  it("fails readiness that is late or never reached, and an invalid or missing To-Be", () => {
    const late = goodTranscript(); late.readiness.atTurn = 16;
    expect(check(late, "readiness").pass).toBe(false);
    const never = goodTranscript(); never.readiness = { ...never.readiness, reached: false, atTurn: null };
    expect(score(never).turns.turnsToReadiness).toBeNull();
    expect(check(never, "readiness").pass).toBe(false);
    const invalid = goodTranscript(); invalid.toBe!.structurallyValid = false;
    expect(check(invalid, "toBeValid").pass).toBe(false);
    const absent = goodTranscript(); absent.toBe = null;
    expect(score(absent).pass).toBe(false);
    expect(summarize(score(absent))).toContain("FAIL");
  });

  it("requires Salesforce as an INTEGRATION step and rejects replacing it", () => {
    const notIntegration = goodTranscript();
    notIntegration.toBe!.design!.steps[9]!.implementation.kind = "CONFIGURATION";
    expect(score(notIntegration).salesforce.integration).toBe(false);
    expect(check(notIntegration, "salesforce").pass).toBe(false);
    const replaced = goodTranscript();
    replaced.toBe!.design!.steps[9]!.actions[0]!.operation = "Replace Salesforce with SAP Sales Cloud";
    expect(score(replaced).salesforce.replaced).toBe(true);
    expect(check(replaced, "salesforce").pass).toBe(false);
  });

  it("requires every KPI target in acceptance tests or added value", () => {
    const t = goodTranscript();
    t.toBe!.design!.steps[10]!.acceptanceTests.pop();
    expect(score(t).kpis.find(k => k.id === "close")!.met).toBe(false);
    expect(check(t, "kpis").pass).toBe(false);
  });
});

describe("validation detail", () => {
  const issue = (attempt: number, path: string, code: string) => ({ attempt, path, code });
  const failing = () => {
    const t = goodTranscript();
    t.turns[1] = turn(2, [], { attempts: 2, validationErrors: 3, error: "AI_INVALID_OUTPUT",
      issues: [issue(1, "questions.0.gapKey", "inactive_gap"), issue(1, "questions.2.gapKey", "inactive_gap"), issue(2, "reply", "too_big")] });
    return t;
  };
  it("computes firstAttemptValid from the recorded attempts: attempts 0 (not captured) never counts as valid", () => {
    const t = goodTranscript();
    t.turns[0] = turn(1, ["g_a"], { attempts: 0 });
    t.turns[1] = turn(2, ["g_b"], { attempts: 2, validationErrors: 1 });
    expect(score(t).firstAttemptValidRate).toBe(0.333);
  });
  it("histograms issues per error code and per index-collapsed path", () => {
    const s = score(failing());
    expect(s.validationErrorCodes).toEqual({ inactive_gap: 2, too_big: 1 });
    expect(s.validationErrorPaths).toEqual({ "questions.*.gapKey|inactive_gap": 2, "reply|too_big": 1 });
    expect(summarize(s)).toContain("validation error codes: inactive_gap x2, too_big x1");
  });
  it("leaves the histograms empty for transcripts recorded before issues existed", () => {
    const legacy: Record<string, unknown> = turn(1, ["g_a"]);
    delete legacy.issues;
    const t = { ...goodTranscript(), turns: [legacy] };
    expect(scoreRun(t, evalCase).validationErrorCodes).toEqual({});
  });
});
