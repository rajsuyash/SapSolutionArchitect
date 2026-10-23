import { z } from "zod";
import { DetailedDesignSchema, IMPLEMENTATION_KINDS, draftIssues, evaluateDesign, id, ids, list, text,
  type DesignContext, type DetailedDesign } from "./design-quality";
import type { ValidationIssue } from "./problem-analysis";
import { toBeContext, validateToBeOutput, type ToBeInput, type ToBeOutput } from "./to-be";

/** Skeleton-then-expansion To-Be generation. A slow model cannot emit a whole design inside the stage budget, so the model
 * first returns an outline (steps, traceability, coverage, questions), then one small call per step fills in the operational
 * detail, in parallel. The assembled result is a plain DetailedDesign, validated by the same checks as a one-shot design. */

export type Substage = "to_be_outline" | "to_be_step";

export const OutlineSchema = z.strictObject({
  schemaVersion: z.literal(1), processName: text,
  steps: list(z.strictObject({
    id, sequence: z.number().int().positive(), title: text, purpose: text,
    asIsStepIds: ids, requirementIds: ids.min(1),
    implementation: z.strictObject({ kind: z.enum(IMPLEMENTATION_KINDS), referenceIds: ids }),
  })).min(1),
  eliminatedAsIsSteps: DetailedDesignSchema.shape.eliminatedAsIsSteps,
  coverage: DetailedDesignSchema.shape.coverage,
  conflictDecisions: DetailedDesignSchema.shape.conflictDecisions,
  openQuestions: DetailedDesignSchema.shape.openQuestions,
});
export type Outline = z.infer<typeof OutlineSchema>;
type OutlineStep = Outline["steps"][number];

/** Everything in a design step that the outline does not already fix. Derived from DetailedDesignSchema so the two cannot drift. */
export const StepDetailSchema = DetailedDesignSchema.shape.steps.element
  .omit({ id: true, sequence: true, title: true, asIsStepIds: true, requirementIds: true, implementation: true })
  .extend({ implementation: z.strictObject({ detail: text }) });
export type StepDetail = z.infer<typeof StepDetailSchema>;

const PLACEHOLDER = "(filled in by the step call)";
const MAX_ERRORS = 30;
const MAX_ID_LENGTH = 64;
const rePath = (issues: ValidationIssue[], from: string, to: string): ValidationIssue[] =>
  issues.map(issue => ({ ...issue, path: issue.path === from || issue.path.startsWith(`${from}.`) ? to + issue.path.slice(from.length) : issue.path }));

/** The outline as a structurally complete design whose step bodies are inert placeholders that satisfy every per-step rule.
 * Running the unchanged design evaluator over it applies the trace, coverage, catalog-reference and SAP fit-ladder checks to the outline. */
function skeleton(outline: Outline): DetailedDesign {
  const steps = outline.steps.map((step): DetailedDesign["steps"][number] => ({
    id: step.id, sequence: step.sequence, title: step.title, asIsStepIds: step.asIsStepIds, requirementIds: step.requirementIds,
    actor: PLACEHOLDER, trigger: PLACEHOLDER, inputDocuments: [PLACEHOLDER], outputDocuments: [PLACEHOLDER],
    actions: [{ actor: PLACEHOLDER, system: PLACEHOLDER, operation: PLACEHOLDER, fields: [PLACEHOLDER] }],
    businessRules: [{ id: `${step.id}-PH-BR`, condition: PLACEHOLDER, response: PLACEHOLDER }],
    exceptions: [], exceptionsNotApplicableReason: PLACEHOLDER,
    masterData: [{ object: PLACEHOLDER, fields: [PLACEHOLDER], owner: PLACEHOLDER }],
    effects: { inventory: PLACEHOLDER, financial: PLACEHOLDER, ownership: PLACEHOLDER },
    implementation: { kind: step.implementation.kind, detail: PLACEHOLDER, referenceIds: step.implementation.referenceIds },
    addedValue: PLACEHOLDER,
    acceptanceTests: [{ id: `${step.id}-PH-T`, kind: "NORMAL", given: PLACEHOLDER, when: PLACEHOLDER, then: PLACEHOLDER, requirementIds: step.requirementIds }],
  }));
  return { schemaVersion: 1, processName: outline.processName, steps, eliminatedAsIsSteps: outline.eliminatedAsIsSteps,
    coverage: outline.coverage, conflictDecisions: outline.conflictDecisions, openQuestions: outline.openQuestions };
}

export function validateOutline(input: ToBeInput, references: DesignContext["references"], raw: unknown):
  { success: true; outline: Outline } | { success: false; errors: ValidationIssue[] } {
  const parsed = OutlineSchema.safeParse(raw);
  if (!parsed.success) return { success: false, errors: rePath(draftIssues(parsed.error.issues), "draft", "outline") };
  const evaluation = evaluateDesign(toBeContext(input, references), skeleton(parsed.data));
  if (!evaluation.structurallyValid) return { success: false, errors: rePath(evaluation.errors, "draft", "outline").slice(0, MAX_ERRORS) };
  return { success: true, outline: parsed.data };
}

/** Join the outline and the step bodies into a DetailedDesign. Parallel step calls cannot coordinate ids, so a business-rule or
 * test id already taken elsewhere is prefixed with its step id; a collision that cannot be fixed that way stays and fails validation. */
export function assemble(outline: Outline, details: ReadonlyMap<string, StepDetail>): DetailedDesign {
  const taken = new Set([...outline.steps.map(step => step.id), ...outline.openQuestions.map(question => question.id)]);
  const unique = (stepId: string, local: string) => {
    const candidate = taken.has(local) && `${stepId}-${local}`.length <= MAX_ID_LENGTH ? `${stepId}-${local}` : local;
    taken.add(candidate); return candidate;
  };
  return {
    schemaVersion: 1, processName: outline.processName,
    steps: outline.steps.map(step => {
      const { implementation, businessRules, acceptanceTests, ...rest } = details.get(step.id)!;
      return {
        id: step.id, sequence: step.sequence, title: step.title, asIsStepIds: step.asIsStepIds, requirementIds: step.requirementIds,
        ...rest,
        businessRules: businessRules.map(rule => ({ ...rule, id: unique(step.id, rule.id) })),
        implementation: { kind: step.implementation.kind, detail: implementation.detail, referenceIds: step.implementation.referenceIds },
        acceptanceTests: acceptanceTests.map(test => ({ ...test, id: unique(step.id, test.id) })),
      };
    }),
    eliminatedAsIsSteps: outline.eliminatedAsIsSteps, coverage: outline.coverage,
    conflictDecisions: outline.conflictDecisions, openQuestions: outline.openQuestions,
  };
}

/** Split whole-design errors into those a single step call can fix and those that need the outline. */
export function attributeErrors(errors: ValidationIssue[], design: DetailedDesign):
  { byStep: Map<string, ValidationIssue[]>; global: ValidationIssue[] } {
  const byStep = new Map<string, ValidationIssue[]>(), global: ValidationIssue[] = [];
  const add = (index: number, issue: ValidationIssue) => {
    const stepId = design.steps[index]!.id;
    byStep.set(stepId, [...(byStep.get(stepId) ?? []), issue]);
  };
  for (const error of errors) {
    const step = /^draft\.steps\.(\d+)(?:\.|$)/.exec(error.path);
    const item = /^draft\.coverage\.(\d+)$/.exec(error.path);
    if (step && design.steps[Number(step[1])]) add(Number(step[1]), error);
    else if (item && error.code === "CRITICAL_REQUIREMENT_UNTESTED" && design.coverage[Number(item[1])]) {
      const requirementId = design.coverage[Number(item[1])]!.requirementId;
      design.steps.forEach((candidate, i) => {
        if (candidate.requirementIds.includes(requirementId) && !candidate.acceptanceTests.some(test => test.requirementIds.includes(requirementId))) {
          add(i, { code: error.code, path: `draft.steps.${i}.acceptanceTests` });
        }
      });
      if (!design.steps.some(candidate => candidate.requirementIds.includes(requirementId))) global.push(error);
    } else global.push(error);
  }
  return { byStep, global };
}

/** Per-step model input: the frozen outline plus only this step's requirements, the sources they quote, the references it cites. */
export function stepRequest(input: ToBeInput, references: DesignContext["references"], outline: Outline, step: OutlineStep, validationErrors: ValidationIssue[]) {
  const { discovery } = input;
  const requirements = discovery.requirements.filter(requirement => step.requirementIds.includes(requirement.id));
  const asIsSteps = discovery.asIsSteps.filter(asIs => step.asIsStepIds.includes(asIs.id));
  const sourceIds = new Set([...requirements.map(r => r.evidence.sourceId), ...asIsSteps.map(a => a.evidence.sourceId)]);
  return {
    targetProduct: input.targetProduct, targetRelease: discovery.targetRelease, variantName: discovery.variantName,
    ...(input.sharedRules && { sharedRules: input.sharedRules }),
    ...(input.decisionRegister && { decisionRegister: input.decisionRegister }),
    outline: { processName: outline.processName, steps: outline.steps,
      coverage: outline.coverage.filter(item => step.requirementIds.includes(item.requirementId)),
      conflictDecisions: outline.conflictDecisions, openQuestions: outline.openQuestions },
    step, asIsSteps,
    requirements: requirements.map(r => ({ id: r.id, asIsStepId: r.asIsStepId, critical: r.critical, kind: r.kind,
      statement: r.statement, sourceId: r.evidence.sourceId, quote: r.evidence.quote })),
    sources: discovery.sources.filter(source => sourceIds.has(source.id)).map(({ id, locator, text }) => ({ id, locator, text })),
    conflicts: discovery.conflicts.filter(conflict => conflict.sourceIds.some(sourceId => sourceIds.has(sourceId))),
    inputOpenQuestions: discovery.openQuestions,
    references: references.filter(reference => step.implementation.referenceIds.includes(reference.id)),
    approvedDecisions: [], validationErrors,
  };
}

/** Run `worker` over `items` with at most `limit` in flight. After the first failure nothing new starts; the rest settle, then it rethrows. */
export async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0, failure: { error: unknown } | undefined;
  const lane = async () => {
    while (!failure && next < items.length) {
      try { await worker(items[next++]!); } catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure) throw failure.error;
}

export type DesignDeps = {
  /** One model call; resolves to the tool payload, or null when the provider did not return exactly one complete tool call. */
  ask: (substage: Substage, user: unknown) => Promise<unknown>;
  /** The error to throw for AI_INVALID_OUTPUT. */
  invalid: () => Error;
  /** Record the issues of one failed attempt in the stage metrics. */
  record: (issues: ValidationIssue[]) => void;
  parallelism: number;
};

export async function runDesign(input: ToBeInput, references: DesignContext["references"], deps: DesignDeps): Promise<ToBeOutput> {
  const base = { input, approvedDecisions: [] as never[], references };
  let outlineRepairs = 0;
  const requestOutline = async (errors: ValidationIssue[]) => {
    const result = validateOutline(input, references, await deps.ask("to_be_outline", { ...base, validationErrors: errors }));
    if (!result.success) deps.record(result.errors);
    return result;
  };
  // The outline gets one repair: errors only, never the model's own text.
  let first = await requestOutline([]);
  if (!first.success) { outlineRepairs++; first = await requestOutline(first.errors); }
  if (!first.success) throw deps.invalid();
  let outline = first.outline;

  const details = new Map<string, StepDetail>(), retries = new Map<string, number>();
  const expand = async (stepIds: readonly string[], errors: ReadonlyMap<string, ValidationIssue[]>) => {
    const current = outline;
    await runPool(stepIds, deps.parallelism, async stepId => {
      const index = current.steps.findIndex(step => step.id === stepId);
      let validationErrors = errors.get(stepId) ?? [];
      for (;;) {
        const raw = await deps.ask("to_be_step", stepRequest(input, references, current, current.steps[index]!, validationErrors));
        const parsed = StepDetailSchema.safeParse(raw);
        if (parsed.success) { details.set(stepId, parsed.data); return; }
        validationErrors = raw === null ? [{ path: `draft.steps.${index}`, code: "NO_TOOL_PAYLOAD" }]
          : rePath(draftIssues(parsed.error.issues), "draft", `draft.steps.${index}`);
        deps.record(validationErrors);
        // One re-request per step in total, whether the first answer failed the schema or the assembled design's checks.
        if ((retries.get(stepId) ?? 0) >= 1) throw deps.invalid();
        retries.set(stepId, 1);
      }
    });
  };

  await expand(outline.steps.map(step => step.id), new Map());
  for (let round = 0; ; round++) {
    const design = assemble(outline, details);
    const result = validateToBeOutput(input, design, references);
    if (result.success) return result.data;
    deps.record(result.errors);
    if (round >= 1) throw deps.invalid();
    const { byStep, global } = attributeErrors(result.errors, design);
    const redo = new Set(byStep.keys());
    for (const stepId of redo) {
      if ((retries.get(stepId) ?? 0) >= 1) throw deps.invalid();
      retries.set(stepId, 1);
    }
    if (global.length) {
      if (outlineRepairs >= 1) throw deps.invalid();
      outlineRepairs++;
      const repaired = await requestOutline(global);
      if (!repaired.success) throw deps.invalid();
      // Frozen means unchanged steps keep their expansion; a step whose outline entry changed (or is new) is expanded again.
      const before = new Map(outline.steps.map(step => [step.id, JSON.stringify(step)]));
      outline = repaired.outline;
      for (const step of outline.steps) {
        if (before.get(step.id) !== JSON.stringify(step)) { details.delete(step.id); retries.delete(step.id); redo.add(step.id); }
      }
      for (const stepId of [...details.keys()]) if (!outline.steps.some(step => step.id === stepId)) details.delete(stepId);
    }
    await expand([...redo].filter(stepId => outline.steps.some(step => step.id === stepId)), byStep);
  }
}
