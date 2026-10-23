import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pharma from "../fixtures/eval/pharma-p2p.json";
import services from "../fixtures/eval/services-r2r.json";
import engineering from "../fixtures/eval/engineering-mto.json";
import pump from "../fixtures/eval/pump-o2c.json";
import strongControl from "../fixtures/eval/controls/pump-o2c.strong.json";
import { DetailedDesignSchema } from "../src/lib/ai/design-quality";
import { rentalDraftV3 } from "../fixtures/ai/to-be/rental-registers";
import { deriveSections } from "../src/lib/to-be-derived";
import { fixture as rentalInput } from "./support/to-be-input";
import { ScoringCaseSchema } from "../src/lib/eval-score";
import { STEP_KEYS, WORKSPACE_FIELDS } from "../src/lib/workspace-fields";
import {
  aggregateRuns, buildCaseBrief, buildSystemPrompt, buildUserPrompt, calibrate, citableIds, CHECKLIST_TEXT, costUsd, degradeDesign, gradeRun, isGrounded, JUDGE_TOOL, JudgeError, judgeOnce,
  loadToBe, median, parseRubric, RUBRIC, scoreGraded, validateJudgeOutput, type Criterion, type Graded, type JudgeClient, type JudgeMessage, type ToBe,
} from "../src/lib/eval-judge";

// --- rubric ---------------------------------------------------------------------------------------------------

describe("rubric", () => {
  it("has 37 checklist criteria matching the reference standard verbatim, plus six reviewer dimensions", () => {
    const doc = readFileSync("docs/to-be-reference-standard.md", "utf8").split("\n");
    const start = doc.findIndex(l => l.startsWith("## 4.")), end = doc.findIndex((l, i) => i > start && l.startsWith("## 5."));
    const items: string[] = [];
    for (const line of doc.slice(start, end)) {
      const m = /^(\d+)\. (.*)$/.exec(line);
      if (m) items.push(m[2]!); else if (/^\s{2,}\S/.test(line) && items.length) items[items.length - 1] += ` ${line.trim()}`;
    }
    expect(items).toHaveLength(37);
    expect([...CHECKLIST_TEXT]).toEqual(items);
    expect(RUBRIC.filter(c => c.source === "checklist")).toHaveLength(37);
    expect(RUBRIC.filter(c => c.source === "dimension").map(c => c.id)).toEqual(["DIM-REQ", "DIM-OPS", "DIM-LOGIC", "DIM-SAP", "DIM-EVID", "DIM-USE"]);
  });

  it("weights the checklist 60 and the dimensions 40, summing to 100 with the quality-plan dimension ratios", () => {
    const sum = (rows: Criterion[]) => rows.reduce((n, c) => n + c.weight, 0);
    expect(sum(RUBRIC.filter(c => c.source === "checklist"))).toBe(60);
    expect(sum(RUBRIC.filter(c => c.source === "dimension"))).toBe(40);
    expect(sum(RUBRIC)).toBe(100);
    expect(RUBRIC.filter(c => c.source === "dimension").map(c => c.weight / 40 * 100)).toEqual([25, 20, 20, 15, 10, 10]);
  });

  it("allows NA only where the criterion states a condition", () => {
    const allowed = RUBRIC.filter(c => c.na === "allowed");
    expect(allowed.map(c => c.n)).toEqual([12, 18, 21, 32, 36]);
    for (const c of allowed) expect(c.naWhen).toBeTruthy();
  });

  it("rejects malformed rubrics", () => {
    const ok = { id: "CL01", source: "checklist", n: 1, text: "x", weight: 1, na: "never" };
    expect(parseRubric([ok])).toHaveLength(1);
    expect(() => parseRubric([ok, ok])).toThrow(/duplicate/);
    expect(() => parseRubric([{ ...ok, na: "allowed" }])).toThrow(/naWhen/);
    expect(() => parseRubric([{ ...ok, n: undefined }])).toThrow(/checklist/);
    expect(() => parseRubric([{ ...ok, weight: 0 }])).toThrow();
    expect(() => parseRubric([])).toThrow();
  });
});

// --- new benchmark fixtures -------------------------------------------------------------------------------------

describe.each([["pharma-p2p", pharma], ["services-r2r", services], ["engineering-mto", engineering]])("fixture %s", (caseId, fixture) => {
  it("mirrors the pump-o2c schema and passes the scorer's case schema", () => {
    expect(fixture.caseId).toBe(caseId);
    expect(Object.keys(fixture).sort()).toEqual(Object.keys(pump).sort());
    expect(Object.keys(fixture.project).sort()).toEqual(Object.keys(pump.project).sort());
    expect(() => ScoringCaseSchema.parse(fixture)).not.toThrow();
    expect(fixture.company).toContain("(fictional)");
    expect(fixture.project.problemStatement.length).toBeGreaterThanOrEqual(50);
  });

  it("answers every empty catalog field and keeps steps, keys and counts in range", () => {
    const empty = WORKSPACE_FIELDS.filter(f => f.id !== "business_problem").map(f => f.id).sort();
    expect(Object.keys(fixture.answerBank.catalog).sort()).toEqual(empty);
    expect(fixture.steps.length).toBeGreaterThanOrEqual(8);
    expect(fixture.steps.length).toBeLessThanOrEqual(12);
    expect(fixture.steps.map(s => s.n)).toEqual(fixture.steps.map((_, i) => i + 1));
    for (const s of fixture.steps) for (const key of STEP_KEYS) expect(s[key].length, `${s.n}.${key}`).toBeGreaterThan(0);
    expect(fixture.requirements.length).toBeGreaterThanOrEqual(10);
    expect(fixture.requirements.length).toBeLessThanOrEqual(16);
    expect(new Set(fixture.requirements.map(r => r.key)).size).toBe(fixture.requirements.length);
    for (const r of fixture.requirements) expect(r.stepN).toBeLessThanOrEqual(fixture.steps.length);
    expect(fixture.requirements.some(r => r.critical)).toBe(true);
    expect(fixture.opening.length).toBeGreaterThan(200);
  });

  it("keeps every answer clear of the sensitive-text screen applied to messages", () => {
    const answers = [fixture.opening, ...Object.values(fixture.answerBank.catalog),
      ...fixture.steps.flatMap(s => STEP_KEYS.map(k => s[k])), ...fixture.requirements.map(r => r.statement)];
    for (const text of answers) expect(text).not.toMatch(/@|password|api[_ -]?key|secret\s*[:=]|token\s*[:=]|Bearer/i);
  });

  it("has 7 to 9 capabilities whose regexes compile and whose pain text appears in a requirement", () => {
    const { capabilities, kpis, salesforce } = fixture.expected;
    expect(capabilities.length).toBeGreaterThanOrEqual(7);
    expect(capabilities.length).toBeLessThanOrEqual(9);
    for (const cap of capabilities) {
      expect(() => new RegExp(cap.solutionRegex, "i")).not.toThrow();
      expect(fixture.requirements.some(r => new RegExp(cap.painRegex, "i").test(r.statement)), `pain for ${cap.id}`).toBe(true);
    }
    for (const k of kpis) expect(() => new RegExp(k.regex, "i")).not.toThrow();
    expect(kpis).toHaveLength(3);
    // The retained-system requirement names the system that mentionRegex looks for.
    const retained = fixture.requirements.find(r => r.kind === "CONTROL" && new RegExp(salesforce.mentionRegex, "i").test(r.statement));
    expect(retained, "retained-system CONTROL requirement").toBeDefined();
    expect(new RegExp(salesforce.replaceRegex, "i").test(retained!.statement)).toBe(false);
  });

  it("builds a judge brief without expected answers", () => {
    const brief = buildCaseBrief(fixture);
    expect(brief.asIsSteps).toHaveLength(fixture.steps.length);
    expect(brief.requirements[0]!.id).toBe(`rq_${fixture.requirements[0]!.key}`);
    expect(JSON.stringify(brief)).not.toContain("solutionRegex");
  });
});

// --- calibration controls --------------------------------------------------------------------------------------

describe("calibration controls", () => {
  const strong = loadToBe(strongControl);
  it("the STRONG control is a schema-valid DetailedDesign that covers every pump-o2c requirement", () => {
    expect(() => DetailedDesignSchema.parse(strong.design)).not.toThrow();
    expect(strong.requirements.map(r => r.id).sort()).toEqual(pump.requirements.map(r => `rq_${r.key}`).sort());
    const covered = new Set((strong.design.coverage as { requirementId: string }[]).map(c => c.requirementId));
    for (const r of strong.requirements) expect(covered.has(r.id)).toBe(true);
  });

  it("the WEAK control is derived mechanically, stays schema-valid, and drops postings, rules, interfaces, gaps and KPIs", () => {
    const weak = degradeDesign(strong.design);
    expect(() => DetailedDesignSchema.parse(weak)).not.toThrow();
    const text = JSON.stringify(weak);
    expect(text.length).toBeLessThan(JSON.stringify(strong.design).length / 2);
    for (const gone of [/IF-SF-/, /GAP-\d/, /KPI-/, /Dr customer/i, /WF-/, /DEC-\d/, /QR code/]) expect(text).not.toMatch(gone);
    expect((weak.openQuestions as unknown[])).toHaveLength(0);
    expect((weak.steps as { id: string }[]).map(s => s.id)).toEqual((strong.design.steps as { id: string }[]).map(s => s.id));
    // The strong design itself was not mutated.
    expect(JSON.stringify(strong.design)).toContain("IF-SF-001");
  });
});

// --- inputs ---------------------------------------------------------------------------------------------------

describe("loadToBe", () => {
  const design = { schemaVersion: 1, steps: [{ id: "S1" }] };
  it("accepts eval run files, transcripts, wrapped designs and bare designs", () => {
    const reqs = [{ id: "rq_a", statement: "A" }];
    for (const raw of [{ transcript: { toBe: { design, requirements: reqs } } }, { toBe: { design, requirements: reqs } }, { design, requirements: reqs }]) {
      expect(loadToBe(raw)).toMatchObject({ design, requirements: reqs });
    }
    expect(loadToBe(design).requirements).toEqual([]);
  });
  it("rejects input with no design", () => {
    expect(() => loadToBe({ transcript: { toBe: null } })).toThrow(/No To-Be design/);
    expect(() => loadToBe({ transcript: { toBe: { errorCode: "AI_INVALID_OUTPUT", design: null, structurallyValid: false } } })).toThrow("the run's To-Be was not valid (AI_INVALID_OUTPUT)");
    expect(() => loadToBe({ steps: [] })).toThrow(/No To-Be design/);
  });
});

// --- validation, citation rule, scoring ----------------------------------------------------------------------------

const tiny: Criterion[] = parseRubric([
  { id: "CL01", source: "checklist", n: 1, text: "one", weight: 2, na: "never" },
  { id: "CL02", source: "checklist", n: 2, text: "two", weight: 1, na: "allowed", naWhen: "no approvals" },
  { id: "DIM-X", source: "dimension", text: "dim", weight: 1, na: "never" },
]);
const tobe: ToBe = { requirements: [{ id: "rq_a", statement: "A" }], design: {
  steps: [{ id: "O2C-ORD-020", businessRules: [{ id: "BR-ORD-01" }], acceptanceTests: [{ id: "AT-1" }] }],
  coverage: [{ requirementId: "rq_a" }], openQuestions: [{ id: "DEC-01" }] } };
const v = (id: string, verdict: string, citation = "O2C-ORD-020.effects.financial", reason = "ok") => ({ id, verdict, citation, reason });

describe("validateJudgeOutput", () => {
  it("accepts exactly one verdict per rubric id", () => {
    const result = validateJudgeOutput(tiny, { verdicts: [v("CL01", "PASS"), v("CL02", "NA"), v("DIM-X", "FAIL")] });
    expect(result.success).toBe(true);
  });
  it("rejects missing, unknown and duplicate criteria", () => {
    const result = validateJudgeOutput(tiny, { verdicts: [v("CL01", "PASS"), v("CL01", "PASS"), v("ZZ", "PASS")] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.issues.map(i => `${i.code}:${i.detail}`)).toEqual(
      expect.arrayContaining(["missing_criterion:CL02", "missing_criterion:DIM-X", "unknown_criterion:ZZ", "duplicate_criterion:CL01"]));
  });
  it.each([
    ["an unknown verdict", { verdicts: [v("CL01", "MAYBE")] }],
    ["a missing reason", { verdicts: [{ id: "CL01", verdict: "PASS", citation: "x" }] }],
    ["an extra property", { verdicts: [{ ...v("CL01", "PASS"), score: 9 }] }],
    ["a string instead of an object", "PASS"],
    ["an empty verdict list", { verdicts: [] }],
    ["null", null],
  ])("rejects %s", (_, raw) => { expect(validateJudgeOutput(tiny, raw).success).toBe(false); });
});

describe("citation-required rule", () => {
  const grade = (verdicts: ReturnType<typeof v>[]) => {
    const parsed = validateJudgeOutput(tiny, { verdicts });
    if (!parsed.success) throw new Error("fixture invalid");
    return gradeRun(tiny, tobe, parsed.data);
  };
  it("keeps PASS and PARTIAL that cite a real element, in any of its forms", () => {
    const g = grade([v("CL01", "PASS", "O2C-ORD-020.effects.financial"), v("CL02", "PARTIAL", "see BR-ORD-01 and AT-1"), v("DIM-X", "PASS", "coverage[rq_a]")]);
    expect(g.map(x => x.verdict)).toEqual(["PASS", "PARTIAL", "PASS"]);
    expect(g.every(x => x.flags.length === 0)).toBe(true);
  });
  it("downgrades PASS or PARTIAL with an empty or invented citation to FAIL and flags it", () => {
    const g = grade([v("CL01", "PASS", ""), v("CL02", "PARTIAL", "step Z9 handles this"), v("DIM-X", "PASS", "the whole design")]);
    expect(g.map(x => x.verdict)).toEqual(["FAIL", "FAIL", "FAIL"]);
    expect(g.map(x => x.rawVerdict)).toEqual(["PASS", "PARTIAL", "PASS"]);
    expect(g.every(x => x.flags.includes("unjustified"))).toBe(true);
  });
  it("matches ids as whole tokens only", () => {
    const ids = new Set(["S1"]);
    expect(isGrounded("S1.actions", ids)).toBe(true);
    expect(isGrounded("S10.actions", ids)).toBe(false);
    expect(isGrounded("XS1", ids)).toBe(false);
  });
  it("flags a FAIL with no citation without changing its score, and rejects NA where it is never allowed", () => {
    const g = grade([v("CL01", "FAIL", ""), v("CL02", "NA", ""), v("DIM-X", "NA", "")]);
    expect(g[0]).toMatchObject({ verdict: "FAIL", flags: ["no_citation"] });
    expect(g[1]).toMatchObject({ verdict: "NA", flags: [] });
    expect(g[2]).toMatchObject({ verdict: "FAIL", rawVerdict: "NA", flags: ["illegal_na"] });
  });
});

describe("scoring arithmetic", () => {
  const graded = (...rows: [string, Graded["verdict"]][]): Graded[] => rows.map(([id, verdict]) => ({ id, rawVerdict: verdict, verdict, citation: "x", reason: "x", flags: [] }));
  it("is a weighted mean of PASS=1, PARTIAL=0.5, FAIL=0 out of 100", () => {
    expect(scoreGraded(tiny, graded(["CL01", "PASS"], ["CL02", "PASS"], ["DIM-X", "PASS"]))).toEqual({ points: 4, max: 4, total: 100 });
    expect(scoreGraded(tiny, graded(["CL01", "PARTIAL"], ["CL02", "PASS"], ["DIM-X", "FAIL"]))).toEqual({ points: 2, max: 4, total: 50 });
    expect(scoreGraded(tiny, graded(["CL01", "FAIL"], ["CL02", "FAIL"], ["DIM-X", "FAIL"])).total).toBe(0);
  });
  it("removes NA criteria from the denominator", () => {
    expect(scoreGraded(tiny, graded(["CL01", "PASS"], ["CL02", "NA"], ["DIM-X", "FAIL"]))).toEqual({ points: 2, max: 3, total: 66.67 });
  });
  it("scores the full rubric to 100 when everything passes and 0 when everything fails", () => {
    const all = (verdict: Graded["verdict"]) => RUBRIC.map(c => ({ id: c.id, rawVerdict: verdict, verdict, citation: "x", reason: "x", flags: [] }));
    expect(scoreGraded(RUBRIC, all("PASS")).total).toBe(100);
    expect(scoreGraded(RUBRIC, all("FAIL")).total).toBe(0);
    expect(scoreGraded(RUBRIC, all("PARTIAL")).total).toBe(50);
  });
  it("prices tokens at the DeepInfra rate", () => {
    expect(costUsd(1_000_000, 1_000_000)).toBe(3.9);
    expect(costUsd(16_000, 4_000)).toBe(0.0312);
    expect(costUsd(0, 0)).toBe(0);
  });
});

describe("median and spread aggregation", () => {
  const run = (a: Graded["verdict"], b: Graded["verdict"], c: Graded["verdict"]): Graded[] =>
    ([["CL01", a], ["CL02", b], ["DIM-X", c]] as const).map(([id, verdict]) => ({ id, rawVerdict: verdict, verdict, citation: `${id} cite ${verdict}`, reason: "r", flags: [] }));
  it("computes medians of odd and even samples", () => {
    expect(median([1, 0, 0.5])).toBe(0.5);
    expect(median([1, 0])).toBe(0.5);
    expect(median([0.5])).toBe(0.5);
    expect(() => median([])).toThrow();
  });
  it("reports median verdict and spread per criterion and flags disagreement", () => {
    const agg = aggregateRuns(tiny, [run("PASS", "PASS", "FAIL"), run("PASS", "PARTIAL", "FAIL"), run("FAIL", "PASS", "FAIL")]);
    const by = Object.fromEntries(agg.criteria.map(c => [c.id, c]));
    expect(by.CL01).toMatchObject({ verdict: "PASS", median: 1, spread: 1, flagged: true });
    expect(by.CL02).toMatchObject({ verdict: "PASS", median: 1, spread: 0.5, flagged: true });
    expect(by["DIM-X"]).toMatchObject({ verdict: "FAIL", median: 0, spread: 0, flagged: false });
    expect(agg.flagged).toEqual(["CL01", "CL02"]);
    expect(agg.perRunTotals).toEqual([75, 62.5, 25]);
    expect(agg.total).toBe(62.5);
    expect(agg.totalSpread).toBe(50);
    expect(by.CL01!.citation).toContain("PASS");
  });
  it("lets the spread threshold be raised and treats NA as NA only when most runs say so", () => {
    const strict = aggregateRuns(tiny, [run("PASS", "PASS", "PASS"), run("PASS", "PARTIAL", "PASS")], 1);
    expect(strict.flagged).toEqual([]);
    const na = aggregateRuns(tiny, [run("PASS", "NA", "PASS"), run("PASS", "NA", "PASS"), run("PASS", "PASS", "PASS")]);
    expect(na.criteria.find(c => c.id === "CL02")).toMatchObject({ verdict: "NA", median: null, flagged: true });
    const scored = aggregateRuns(tiny, [run("PASS", "NA", "PASS"), run("PASS", "FAIL", "PASS"), run("PASS", "FAIL", "PASS")]);
    expect(scored.criteria.find(c => c.id === "CL02")).toMatchObject({ verdict: "FAIL", median: 0 });
  });
  it("counts runs whose credit was unjustified", () => {
    const bad = run("PASS", "PASS", "PASS").map(g => g.id === "CL01" ? { ...g, verdict: "FAIL" as const, flags: ["unjustified" as const] } : g);
    expect(aggregateRuns(tiny, [bad, run("PASS", "PASS", "PASS")]).unjustified).toEqual([{ id: "CL01", runs: 1 }]);
  });
  it("rejects an empty run list", () => { expect(() => aggregateRuns(tiny, [])).toThrow(); });
});

describe("calibration verdict", () => {
  const agg = (verdict: Graded["verdict"]) => aggregateRuns(tiny, [tiny.map(c => ({ id: c.id, rawVerdict: verdict, verdict, citation: "x", reason: "x", flags: [] }))]);
  it("is usable only when STRONG beats WEAK by the minimum gap", () => {
    const good = calibrate(tiny, agg("PASS"), agg("FAIL"));
    expect(good).toMatchObject({ usable: true, gap: 100, strongTotal: 100, weakTotal: 0 });
    const small = calibrate(tiny, agg("PASS"), agg("PASS"));
    expect(small.usable).toBe(false);
    expect(small.verdict).toMatch(/INVERTED/);
    const inverted = calibrate(tiny, agg("FAIL"), agg("PASS"));
    expect(inverted).toMatchObject({ usable: false, gap: -100 });
    expect(inverted.invertedCriteria).toEqual(["CL01", "CL02", "DIM-X"]);
    expect(calibrate(tiny, agg("PARTIAL"), agg("FAIL"), 60).verdict).toMatch(/below the 60-point minimum/);
  });
});

// --- provider call ---------------------------------------------------------------------------------------------

const msg = (content: JudgeMessage["content"], inputTokens = 100, outputTokens = 50): JudgeMessage => ({ content, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
const call = (input: unknown) => ({ type: "tool_use", name: JUDGE_TOOL, input });
function mockClient(replies: JudgeMessage[]) {
  const requests: Parameters<JudgeClient["messages"]["stream"]>[] = [];
  const client: JudgeClient = { messages: { stream: (...args) => {
    requests.push(args);
    const reply = replies[requests.length - 1];
    if (!reply) throw new Error("mock: no reply left");
    return { finalMessage: () => Promise.resolve(reply) };
  } } };
  return { client, requests };
}
const brief = buildCaseBrief(pump);
const goodOutput = { verdicts: [v("CL01", "PASS"), v("CL02", "NA", ""), v("DIM-X", "PARTIAL")] };

describe("judgeOnce", () => {
  it("sends the independent model, low temperature, a strict tool and the rubric, and grades the reply", async () => {
    const { client, requests } = mockClient([msg([call(goodOutput)])]);
    const result = await judgeOnce(client, tiny, brief, tobe);
    expect(result.attempts).toBe(1);
    expect(result.score.total).toBe(83.33);
    const [params, options] = requests[0]!;
    expect(params).toMatchObject({ model: "deepseek-ai/DeepSeek-V4-Pro-0813", temperature: 0.2 });
    expect(params.tools?.[0]).toMatchObject({ name: JUDGE_TOOL });
    expect(JSON.stringify(params.tools)).toContain("\"additionalProperties\":false");
    expect(String(params.system)).toContain("CL02 | weight 1 | NA allowed only if no approvals");
    expect(String(params.system)).not.toMatch(/MiMo|generator/i);
    expect(options?.timeout).toBeGreaterThan(0);
  });

  it("repairs once: the second request carries the validation issues, and usage adds up", async () => {
    const { client, requests } = mockClient([msg([call({ verdicts: [v("CL01", "PASS")] })], 100, 10), msg([call(goodOutput)], 120, 20)]);
    const result = await judgeOnce(client, tiny, brief, tobe);
    expect(result.attempts).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 220, outputTokens: 30, calls: 2 });
    const second = JSON.parse((requests[1]![0].messages[0] as { content: string }).content) as { validationErrors: { code: string; detail: string }[] };
    expect(second.validationErrors).toEqual(expect.arrayContaining([{ path: "verdicts", code: "missing_criterion", detail: "CL02" }]));
  });

  it("counts cached prompt tokens as input", async () => {
    const reply: JudgeMessage = { content: [call(goodOutput)], usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } };
    const result = await judgeOnce(mockClient([reply]).client, tiny, brief, tobe);
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 5, calls: 1 });
  });

  it("throws JudgeError carrying the spent usage when output stays malformed or no tool is called", async () => {
    const bad = mockClient([msg([call({ verdicts: "no" })]), msg([call({ nope: 1 })])]);
    await expect(judgeOnce(bad.client, tiny, brief, tobe)).rejects.toMatchObject({ name: "JudgeError", code: "JUDGE_INVALID_OUTPUT", usage: { calls: 2, inputTokens: 200 } });
    const none = mockClient([msg([{ type: "text" }]), msg([{ type: "text" }])]);
    const error = await judgeOnce(none.client, tiny, brief, tobe).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JudgeError);
    expect((error as JudgeError).code).toBe("JUDGE_NO_TOOL_CALL");
  });

  it("scores an unjustified PASS as FAIL end to end", async () => {
    const { client } = mockClient([msg([call({ verdicts: [v("CL01", "PASS", "somewhere"), v("CL02", "NA", ""), v("DIM-X", "PASS")] })])]);
    const result = await judgeOnce(client, tiny, brief, tobe);
    expect(result.graded[0]).toMatchObject({ verdict: "FAIL", flags: ["unjustified"] });
    expect(result.score.total).toBe(33.33);
  });
});

describe("solution-design registers reach the judge", () => {
  const v2 = loadToBe({ design: rentalDraftV3 });
  it("sends the registers inside the design and the company context inside the case brief", () => {
    const brief = buildCaseBrief(pump);
    expect(brief.companyContext.map(item => item.fieldId)).toEqual(expect.arrayContaining(["operating_scale", "retained_systems", "kpi_baselines", "kpi_targets"]));
    expect(brief.companyContext.find(item => item.fieldId === "kpi_targets")!.value).toBe((pump.answerBank.catalog as Record<string, string>).kpi_targets);
    const sent = JSON.parse(buildUserPrompt(brief, v2));
    expect(Object.keys(sent.toBeDesign)).toEqual(expect.arrayContaining(["keyDesignDecisions", "fitGap", "orgStructure", "masterDataPrerequisites", "interfaces", "kpis", "dataMigration", "cutover"]));
    expect(sent.case.companyContext).toHaveLength(brief.companyContext.length);
  });
  it("puts the content of every register and of coverage and open questions in the judge user message, not just the keys", () => {
    // The rental fixture leaves kpis and interfaces empty: add one row each so every register carries content.
    const trace = { requirementIds: [], contextFieldIds: [], stepIds: ["TB-1"] }, basis = { referenceIds: [], needsValidation: false, validationReason: null };
    const full = loadToBe({ design: { ...rentalDraftV3,
      kpis: [{ id: "KPI-X", name: "OTIF", baseline: "80%", target: "92% by Q4", measuredFrom: "Delivery docs", ...basis, ...trace }],
      interfaces: [{ id: "IF-X", counterpartSystem: "Salesforce", direction: "INBOUND", triggerFrequency: "On quote", payload: "Quote", errorOwner: "Sales ops", outOfScopeReason: null, ...basis, ...trace }] } });
    const text = buildUserPrompt(buildCaseBrief(pump), full);
    const d = full.design as unknown as Record<string, { id?: string; [k: string]: unknown }[]>;
    for (const key of ["keyDesignDecisions", "orgStructure", "masterDataPrerequisites", "interfaces", "kpis", "dataMigration", "cutover"]) {
      expect(d[key]!.length, key).toBeGreaterThan(0);
      for (const row of d[key]!) expect(text, `${key}.${row.id}`).toContain(JSON.stringify(row));
    }
    for (const row of d.fitGap!) expect(text).toContain(JSON.stringify(row));
    for (const row of d.coverage!) expect(text).toContain(JSON.stringify(row));
    for (const row of d.openQuestions!) expect(text).toContain(JSON.stringify(row));
  });
  it("loadToBe keeps the whole design of a saved eval run file", () => {
    const run = { transcript: { toBe: { design: rentalDraftV3, requirements: [] } } };
    expect(loadToBe(run).design).toEqual(rentalDraftV3);
  });
  it("lets a verdict cite a register row, and tells the judge how to read the registers without touching the rubric", () => {
    const ids = citableIds(v2);
    for (const id of ["KDD-1", "ORG-1", "MD-1", "MIG-1", "CUT-1", "fitGap", "interfaces", "kpis"]) expect(isGrounded(`see ${id}`, ids)).toBe(true);
    expect(buildSystemPrompt(RUBRIC)).toContain("schemaVersion 2");
    expect(buildSystemPrompt(RUBRIC)).toContain("fitGap");
    expect(RUBRIC).toHaveLength(43);
  });
  it("the weak control drops the registers of a version 2 plan; a version 1 plan is untouched", () => {
    const weak = degradeDesign(v2.design);
    for (const key of ["keyDesignDecisions", "fitGap", "orgStructure", "masterDataPrerequisites", "interfaces", "kpis", "dataMigration", "cutover"]) expect(weak).not.toHaveProperty(key);
    expect(v2.design).toHaveProperty("fitGap");
    expect(() => DetailedDesignSchema.parse(weak)).not.toThrow();
  });
});

describe("server-built sections reach the judge", () => {
  const derived = deriveSections({ design: rentalDraftV3, asIsSteps: rentalInput().discovery.asIsSteps, meta: { sourceRevision: 7, variantCode: "RENTAL", variantName: "Equipment hire",
    snapshotId: "33333333-3333-4333-8333-333333333333", generatedAt: "2026-10-21T09:30:00.000Z", targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: "2023",
    sources: [{ id: "SRC-1", title: "Workshop 1", revision: "v1", digest: "cd".repeat(32) }] } });
  const withDerived = loadToBe({ transcript: { toBe: { design: rentalDraftV3, requirements: [], derived } } });
  it("loadToBe keeps the derived sections of a saved run, and a run without them still loads", () => {
    expect(withDerived.derived).toEqual(JSON.parse(JSON.stringify(derived)));
    expect(loadToBe({ design: rentalDraftV3 })).not.toHaveProperty("derived");
  });
  it("puts document control, the As-Is narratives and the RICEFW list in the judge user message, whole", () => {
    const sent = JSON.parse(buildUserPrompt(buildCaseBrief(pump), withDerived)) as { derivedSections: typeof derived; toBeDesign: unknown };
    expect(sent.derivedSections.documentControl.sourceRevision.snapshotId).toBe("33333333-3333-4333-8333-333333333333");
    expect(sent.derivedSections.documentControl.signOff.every(item => item.status === "HUMAN_REVIEW_REQUIRED")).toBe(true);
    expect(sent.derivedSections.asIsNarratives[0]!.asIs[0]!.description).toBe(rentalInput().discovery.asIsSteps[0]!.description);
    expect(sent.derivedSections.ricefwList.map(item => item.id)).toEqual(["RICEFW-1", "RICEFW-2", "RICEFW-3", "RICEFW-4"]);
    expect(buildUserPrompt(buildCaseBrief(pump), loadToBe({ design: rentalDraftV3 }))).not.toContain("derivedSections");
  });
  it("lets a verdict cite a derived item or a version 3 register row, and the system prompt explains both", () => {
    const ids = citableIds(withDerived);
    for (const id of ["RICEFW-2", "AS-1", "documentControl", "ricefwList", "OBJ-1", "ROLE-3", "DSM-1", "CFG-1", "SOD-1", "REP-1", "E2E-1", "roles", "reports"]) expect(isGrounded(`see ${id}`, ids), id).toBe(true);
    expect(isGrounded("see RICEFW-2", citableIds(loadToBe({ design: rentalDraftV3 })))).toBe(false);
    const prompt = buildSystemPrompt(RUBRIC);
    for (const phrase of ["derivedSections", "schemaVersion 3", "documentStatusModels", "sodAssessments", "never approved"]) expect(prompt).toContain(phrase);
  });
  it("the weak control drops the version 3 registers too", () => {
    const weak = degradeDesign(withDerived.design);
    for (const key of ["objectives", "scopeStatements", "documentStatusModels", "configurationCatalogue", "roles", "sodAssessments", "controlMappings", "reports", "endToEndTests"]) expect(weak, key).not.toHaveProperty(key);
  });
});
