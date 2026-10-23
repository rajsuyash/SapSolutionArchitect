import { z } from "zod";
import { DesignContextSchema, id, list, text, type DesignContext } from "./design-quality";
import { RegisterGroupSchemas } from "./design-registers";
import { OutlineSchema, StepDetailSchema } from "./to-be-pipeline";

/** One compact, hand-written example per To-Be call type, rendered into the system prompts at build time. The example is a
 * fictional process unrelated to any evaluation case (reusable kegs lent to pubs); tests/worked-example.test.ts runs the same
 * data through the real schemas, SAP-object linter and evaluateDesign, so the prompt can never show something the validators reject. */
const requirement = DesignContextSchema.shape.requirements.element;
export const WorkedExampleSchema = z.strictObject({
  note: text,
  context: z.strictObject({
    targetProduct: DesignContextSchema.shape.targetProduct, targetRelease: text,
    asIsSteps: DesignContextSchema.shape.asIsSteps, sources: DesignContextSchema.shape.sources,
    requirements: list(requirement.extend({ statement: text })), conflicts: DesignContextSchema.shape.conflicts,
    companyContext: list(z.strictObject({ fieldId: id, label: text, value: text })),
  }),
  outline: OutlineSchema,
  details: z.record(id, StepDetailSchema),
  registers: z.strictObject({
    decisions: RegisterGroupSchemas.decisions, fitgap: RegisterGroupSchemas.fitgap,
    foundation: RegisterGroupSchemas.foundation, integration: RegisterGroupSchemas.integration,
  }),
});
export type WorkedExample = z.infer<typeof WorkedExampleSchema>;

export const parseWorkedExample = (raw: unknown): WorkedExample => WorkedExampleSchema.parse(raw);

/** The example as an evaluation context, against the supplied (real catalog) references. */
export function workedExampleContext(example: WorkedExample, references: DesignContext["references"]): DesignContext {
  const { context } = example;
  return {
    targetProduct: context.targetProduct, targetRelease: context.targetRelease, asIsSteps: context.asIsSteps, sources: context.sources,
    requirements: context.requirements.map(({ id: requirementId, asIsStepId, sourceId, quote, critical }) => ({ id: requirementId, asIsStepId, sourceId, quote, critical })), conflicts: context.conflicts,
    approvedDecisions: [], references, companyContext: context.companyContext.map(({ fieldId, value }) => ({ fieldId, value })),
  };
}

export const WORKED_EXAMPLE_MARKER = "{{WORKED_EXAMPLE}}";
const json = (value: unknown) => JSON.stringify(value);
const HEADING = "## Illustrative example from an unrelated process — do not copy its content; match its depth, specificity and traceability";
const INTRO = "The example is a fictional brewery lending reusable kegs to pubs. It is a different business from the one you are designing: " +
  "never reuse its names, figures, steps or wording. It shows the level of concreteness a good answer reaches. Every id in it is from its own request.";

const requirementsOf = (example: WorkedExample, ids?: readonly string[]) => example.context.requirements
  .filter(item => !ids || ids.includes(item.id)).map(({ id: requirementId, critical, statement, quote }) => ({ id: requirementId, critical, statement, quote }));

function outlineExample(example: WorkedExample): string {
  return [HEADING, INTRO, "",
    "What its request said (excerpt):", json({ asIsSteps: example.context.asIsSteps, requirements: requirementsOf(example) }), "",
    "The outline it produced:", json(example.outline), "",
    "Notice: each step traces As-Is steps and requirements and names the catalog reference that justifies its implementation kind; " +
    "an As-Is step that disappears is listed with a reason; coverage rationale says how the requirement is met; an unanswered policy is an open question owned by a role and held on the step it affects."].join("\n");
}

function stepExample(example: WorkedExample): string {
  const step = example.outline.steps[0]!, detail = example.details[step.id]!;
  return [HEADING, INTRO, "",
    "What its request said (excerpt):", json({ step, requirements: requirementsOf(example, step.requirementIds) }), "",
    "The detail it produced:", json(detail), "",
    "Notice: named actors and systems; input and output documents; business rules as condition and observable response; exceptions with an owner; " +
    "master data with an owner; inventory, financial and ownership effects stated separately; an implementation detail that quotes the cited reference and ends with validation points; " +
    "tests as given, when, then with concrete quantities that cite the step's requirements."].join("\n");
}

function registersExample(example: WorkedExample): string {
  const { registers } = example;
  return [HEADING, INTRO, "The rows below are an excerpt: a real answer covers every requirement and retained system it is given.", "",
    "What its request said (excerpt):", json({ companyContext: example.context.companyContext, requirements: requirementsOf(example),
      steps: example.outline.steps.map(({ id: stepId, title }) => ({ id: stepId, title })) }), "",
    "group decisions:", json(registers.decisions), "",
    "group fitgap:", json(registers.fitgap), "",
    "group foundation:", json(registers.foundation), "",
    "group integration:", json(registers.integration), "",
    "Notice: a decision has genuine options with honest cons and a recommendation that is exactly one option name; a fit-gap row says why this class and not the cleaner one, " +
    "cites the reference and flags what to validate; an interface gives direction, frequency, payload and the role that owns errors; a KPI copies baseline and target verbatim from the context and says what is counted and over what period."].join("\n");
}

export function renderWorkedExamples(example: WorkedExample) {
  return { outline: outlineExample(example), step: stepExample(example), registers: registersExample(example) };
}

/** Replaces the one marker in a prompt. A prompt without exactly one marker would silently drop the example, so it throws. */
export function withWorkedExample(prompt: string, section: string): string {
  if (prompt.split(WORKED_EXAMPLE_MARKER).length !== 2) throw new Error("WORKED_EXAMPLE_MARKER_INVALID");
  return prompt.replace(WORKED_EXAMPLE_MARKER, () => section);
}
