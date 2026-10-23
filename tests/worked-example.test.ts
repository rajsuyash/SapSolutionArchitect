import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateDesign } from "../src/lib/ai/design-quality";
import { RegisterGroupSchemas, REGISTER_GROUP_NAMES } from "../src/lib/ai/design-registers";
import { lintSapObjects } from "../src/lib/ai/sap-object-lint";
import { loadSapReferences } from "../src/lib/ai/sap-references";
import { StepDetailSchema, OutlineSchema, assemble, validateOutline } from "../src/lib/ai/to-be-pipeline";
import { parseWorkedExample, renderWorkedExamples, withWorkedExample, workedExampleContext, WORKED_EXAMPLE_MARKER } from "../src/lib/ai/worked-example";

const raw = JSON.parse(readFileSync("fixtures/ai/to-be/worked-example.json", "utf8")) as unknown;
const example = parseWorkedExample(raw);
const prompt = (name: string) => readFileSync(`prompts/to_be_${name}.system.md`, "utf8");
const tokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
const references = await loadSapReferences("S4HANA_ON_PREMISE", "2023");
const context = workedExampleContext(example, references);
const design = () => assemble(example.outline, new Map(Object.entries(example.details)), new Map(REGISTER_GROUP_NAMES.map(group => [group, example.registers[group]])));

describe("worked example fixture", () => {
  it("parses through the step, outline and register schemas", () => {
    for (const detail of Object.values(example.details)) expect(StepDetailSchema.safeParse(detail).success).toBe(true);
    expect(OutlineSchema.safeParse(example.outline).success).toBe(true);
    for (const group of REGISTER_GROUP_NAMES) expect(RegisterGroupSchemas[group].safeParse(example.registers[group]).success).toBe(true);
  });
  it("cites only real, loaded catalog references", () => {
    expect(references.length).toBeGreaterThan(0);
    const cited = new Set(JSON.stringify(raw).match(/S4-2023-[A-Z0-9-]+/g));
    expect(cited.size).toBeGreaterThan(0);
    for (const reference of cited) expect(references.map(item => item.id)).toContain(reference);
  });
  it("passes evaluateDesign as an assembled version 3 design with no structural errors", () => {
    const evaluation = evaluateDesign(context, design());
    expect(evaluation.errors).toEqual([]);
    expect(evaluation.structurallyValid).toBe(true);
    expect(design().schemaVersion).toBe(3);
  });
  it("passes the SAP-object linter", () => {
    expect(lintSapObjects(design(), references)).toEqual([]);
  });
  it("the linter and evaluator do go red on a corrupted copy", () => {
    const bad = structuredClone(design());
    bad.steps[0]!.implementation.detail += " Post with transaction VA01 and movement type 999.";
    expect(lintSapObjects(bad, references).length).toBeGreaterThan(0);
    bad.steps[0]!.acceptanceTests = bad.steps[0]!.acceptanceTests.map(test => ({ ...test, requirementIds: ["R-2"] }));
    expect(evaluateDesign(context, bad).errors.length).toBeGreaterThan(0);
  });
  it("the outline example survives the real outline validation", async () => {
    const result = validateOutline({ targetProduct: context.targetProduct, discovery: { targetRelease: context.targetRelease,
      asIsSteps: context.asIsSteps, requirements: context.requirements.map(item => ({ ...item, evidence: { sourceId: item.sourceId, quote: item.quote } })),
      sources: context.sources, conflicts: [], openQuestions: [], companyContext: [] } } as never, references, example.outline);
    expect(result).toMatchObject({ success: true });
  });
  it("keeps each example within its token budget", () => {
    expect(tokens(example.outline)).toBeLessThanOrEqual(800);
    expect(tokens(example.details["EX-1"])).toBeLessThanOrEqual(1200);
    for (const group of REGISTER_GROUP_NAMES) expect(tokens(example.registers[group])).toBeLessThanOrEqual(1000);
  });
});

describe("prompt rendering", () => {
  const rendered = renderWorkedExamples(example);
  it("each prompt carries exactly one marker and renders the matching example", () => {
    for (const [name, section] of [["outline", rendered.outline], ["step", rendered.step], ["registers", rendered.registers]] as const) {
      const template = prompt(name);
      expect(template.split(WORKED_EXAMPLE_MARKER)).toHaveLength(2);
      const system = withWorkedExample(template, section);
      expect(system).not.toContain(WORKED_EXAMPLE_MARKER);
      expect(system).toContain("Illustrative example from an unrelated process — do not copy its content; match its depth, specificity and traceability");
    }
    expect(withWorkedExample(prompt("outline"), rendered.outline)).toContain(JSON.stringify(example.outline));
    expect(withWorkedExample(prompt("step"), rendered.step)).toContain(JSON.stringify(example.details["EX-1"]));
    const registers = withWorkedExample(prompt("registers"), rendered.registers);
    for (const group of REGISTER_GROUP_NAMES) expect(registers).toContain(JSON.stringify(example.registers[group]));
  });
  it("refuses a prompt without exactly one marker", () => {
    expect(() => withWorkedExample("no marker", "x")).toThrow("WORKED_EXAMPLE_MARKER_INVALID");
    expect(() => withWorkedExample(`${WORKED_EXAMPLE_MARKER}${WORKED_EXAMPLE_MARKER}`, "x")).toThrow("WORKED_EXAMPLE_MARKER_INVALID");
  });
});

describe("no leakage from evaluation material", () => {
  const SHINGLE = 6;
  const words = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const shingles = (value: string) => { const w = words(value); return new Set(Array.from({ length: Math.max(0, w.length - SHINGLE + 1) }, (_, i) => w.slice(i, i + SHINGLE).join(" "))); };
  const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings)
    : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  // The reference ids and objects legitimately recur: they quote the shared catalog, not an evaluation case.
  const own = (() => {
    const { context: ctx, outline, details, registers } = example;
    return new Set(strings([ctx, outline, details, registers]).flatMap(item => [...shingles(item)]));
  })();
  const files = [...readdirSync("fixtures/eval").filter(name => name.endsWith(".json")).map(name => `fixtures/eval/${name}`),
    ...readdirSync("fixtures/eval/controls").filter(name => name.endsWith(".json")).map(name => `fixtures/eval/controls/${name}`)];
  it("reads the four eval cases and the strong control", () => { expect(files.length).toBeGreaterThanOrEqual(5); });
  for (const file of files) {
    it(`shares no ${SHINGLE}-word shingle with ${file}`, () => {
      const theirs = new Set(strings(JSON.parse(readFileSync(file, "utf8"))).flatMap(item => [...shingles(item)]));
      expect(own.size).toBeGreaterThan(100);
      expect([...own].filter(item => theirs.has(item))).toEqual([]);
    });
  }
  it("the overlap check detects a sentence copied from an eval case", () => {
    const sentence = strings(JSON.parse(readFileSync(files[0]!, "utf8"))).find(item => words(item).length >= 12)!;
    const theirs = shingles(sentence);
    expect([...shingles(`Unrelated lead-in. ${sentence}`)].filter(item => theirs.has(item)).length).toBeGreaterThan(0);
    expect([...own].filter(item => theirs.has(item))).toEqual([]);
  });
});
