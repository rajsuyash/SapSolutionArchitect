import type { ValidationIssue } from "./problem-analysis";
import type { ToBeInput } from "./to-be";

/** Deterministic repair of the slips a model makes in the To-Be outline, applied to the raw tool payload before it is parsed.
 * Each repair only re-derives a field from other fields of the same outline or from the server-owned input (ids, never prose),
 * so it cannot add a client fact, an SAP object or a disposition the model did not state. Every repair is reported as a
 * warning (code REPAIRED_*, path, no model text). What it cannot derive is left as is and fails validation as before. */
type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
const TRACED = new Set(["IMPLEMENTED", "CONDITIONAL"]);

export function repairOutlineShape(input: Pick<ToBeInput["discovery"], "requirements">, catalogIds: ReadonlySet<string>, raw: unknown,
  registerIds: ReadonlySet<string> = new Set()):
  { value: unknown; warnings: ValidationIssue[] } {
  const warnings: ValidationIssue[] = [];
  if (!isObj(raw) || !Array.isArray(raw.steps) || !raw.steps.every(isObj)) return { value: raw, warnings };
  const warn = (code: string, path: string) => { warnings.push({ code, path }); };
  const home = new Map(input.requirements.map(requirement => [requirement.id, requirement.asIsStepId]));
  const dedupe = (value: unknown, path: string): unknown => {
    const list = strings(value);
    if (!list || new Set(list).size === list.length) return value;
    warn("REPAIRED_DUPLICATE_TRACE", path);
    return [...new Set(list)];
  };
  // A coverage row for an id that is not an input requirement is an invention, and a second row for one requirement is a repeat: the
  // row is dropped (the first of a repeat is kept), never renamed. Skipped when no requirements are supplied, as there is nothing to compare.
  const inputIds = new Set(input.requirements.map(requirement => requirement.id)), checkIds = inputIds.size > 0;
  const seen = new Set<unknown>();
  const rawCoverage: unknown = checkIds && Array.isArray(raw.coverage) && raw.coverage.every(isObj)
    ? raw.coverage.filter((item, i) => {
      const drop = !inputIds.has(item.requirementId as string) || seen.has(item.requirementId);
      seen.add(item.requirementId);
      if (drop) warn("REPAIRED_UNKNOWN_COVERAGE_ROW", `outline.coverage.${i}`);
      return !drop;
    }) : raw.coverage;
  const coverage: Obj[] = Array.isArray(rawCoverage) && rawCoverage.every(isObj) ? rawCoverage : [];
  const traced = coverage.filter(item => typeof item.requirementId === "string" && TRACED.has(String(item.disposition)));

  let steps = raw.steps.map((step, i): Obj => {
    const path = `outline.steps.${i}`, implementation = isObj(step.implementation) ? step.implementation : undefined;
    let referenceIds = implementation && dedupe(implementation.referenceIds, `${path}.implementation`);
    // An unknown id is dropped only when a catalog reference remains. A step that cites nothing else rests its SAP claim on an
    // invented reference, which fails closed (UNKNOWN_REFERENCE) and goes back to the model rather than being relabelled.
    const known = strings(referenceIds)?.filter(ref => catalogIds.has(ref));
    if (known?.length && known.length !== (referenceIds as string[]).length) { warn("REPAIRED_UNKNOWN_REFERENCE", `${path}.implementation`); referenceIds = known; }
    let requirementIds = dedupe(step.requirementIds, path);
    const refs = strings(requirementIds), valid = checkIds ? refs?.filter(ref => inputIds.has(ref)) : refs;
    if (refs && valid && valid.length !== refs.length) { warn("REPAIRED_UNKNOWN_REQUIREMENT_REF", `${path}.requirementIds`); requirementIds = valid; }
    if (!strings(requirementIds)?.length && typeof step.id === "string") {
      const derived = traced.filter(item => strings(item.stepIds)?.includes(step.id as string)).map(item => item.requirementId as string);
      if (derived.length) { warn("REPAIRED_STEP_REQUIREMENTS", path); requirementIds = [...new Set(derived)]; }
    }
    if (step.sequence !== i + 1) warn("REPAIRED_SEQUENCE", path);
    return { ...step, sequence: i + 1, asIsStepIds: dedupe(step.asIsStepIds, path), requirementIds,
      ...(step.enablesStepIds !== undefined && { enablesStepIds: dedupe(step.enablesStepIds, path) }),
      ...(implementation && { implementation: { ...implementation, referenceIds } }) };
  });

  // A step that implements a requirement traces that requirement's own As-Is step.
  steps = steps.map((step, i) => {
    const asIs = strings(step.asIsStepIds), requirements = strings(step.requirementIds);
    if (!asIs || !requirements) return step;
    const missing = [...new Set(requirements.flatMap(ref => home.get(ref) ?? []))].filter(ref => !asIs.includes(ref));
    if (!missing.length) return step;
    warn("REPAIRED_AS_IS_TRACE", `outline.steps.${i}`);
    return { ...step, asIsStepIds: [...asIs, ...missing] };
  });
  const stepsOf = (requirementId: string) => steps.flatMap(step => strings(step.requirementIds)?.includes(requirementId) ? [step.id] : []);

  // Coverage lists exactly the steps whose requirementIds contain the requirement. Only re-derived when a step lists it.
  const repairedCoverage = !Array.isArray(rawCoverage) || !rawCoverage.every(isObj) ? rawCoverage : coverage.map((item, i) => {
    if (typeof item.requirementId !== "string" || !TRACED.has(String(item.disposition))) return item;
    const derived = stepsOf(item.requirementId), current = strings(item.stepIds);
    if (!derived.length || (current?.length === derived.length && derived.every(stepId => current.includes(stepId as string)))) return item;
    warn("REPAIRED_COVERAGE_STEPS", `outline.coverage.${i}`);
    return { ...item, stepIds: derived };
  });
  const coverageOut = Array.isArray(repairedCoverage) ? repairedCoverage as Obj[] : [];

  // An open question that names no affected step holds the steps that implement the requirements it is linked to.
  const questions = Array.isArray(raw.openQuestions) && raw.openQuestions.every(isObj) ? raw.openQuestions.map((question, i) => {
    if (strings(question.affectedStepIds)?.length) return { ...question, affectedStepIds: dedupe(question.affectedStepIds, `outline.openQuestions.${i}`) };
    const derived = [...new Set(coverageOut.filter(item => strings(item.questionIds)?.includes(String(question.id)))
      .flatMap(item => strings(item.stepIds) ?? []))];
    if (!derived.length) return question;
    warn("REPAIRED_QUESTION_STEPS", `outline.openQuestions.${i}`);
    return { ...question, affectedStepIds: derived };
  }) : raw.openQuestions;

  // A step that is traced to an As-Is step is not eliminated: the mapping wins.
  const mapped = new Set(steps.flatMap(step => strings(step.asIsStepIds) ?? []));
  const eliminated = Array.isArray(raw.eliminatedAsIsSteps) && raw.eliminatedAsIsSteps.every(isObj)
    ? raw.eliminatedAsIsSteps.filter((item, i) => {
      const clash = typeof item.asIsStepId === "string" && mapped.has(item.asIsStepId);
      if (clash) warn("REPAIRED_AS_IS_DISPOSITION", `outline.eliminatedAsIsSteps.${i}`);
      return !clash;
    }) : raw.eliminatedAsIsSteps;

  // A decision id that is not in the supplied register is an invention (with no register every id is): the link is dropped, never replaced.
  // A CONDITIONAL row left without any link, or a DEFERRED / REJECTED row whose approval was never supplied, stays an error for the model.
  const knownDecisions = (items: unknown, name: string) => !Array.isArray(items) ? items : items.map((item, i) => {
    const cited = isObj(item) ? strings(item.decisionIds) : undefined, kept = cited?.filter(ref => registerIds.has(ref));
    if (!isObj(item) || !cited || kept!.length === cited.length) return item;
    warn("REPAIRED_UNKNOWN_DECISION", `outline.${name}.${i}`);
    return { ...item, decisionIds: kept };
  });

  // A coverage row citing an open question the outline does not hold cites an invention: the id is dropped (a row left with no link stays an error for the model).
  const heldQuestions = new Set(Array.isArray(raw.openQuestions) ? raw.openQuestions.flatMap(question => isObj(question) && typeof question.id === "string" ? [question.id] : []) : []);
  const knownQuestions = (items: unknown) => !Array.isArray(items) || !Array.isArray(raw.openQuestions) ? items : items.map((item, i) => {
    const cited = isObj(item) ? strings(item.questionIds) : undefined, kept = cited?.filter(ref => heldQuestions.has(ref));
    if (!isObj(item) || !cited || kept!.length === cited.length) return item;
    warn("REPAIRED_UNKNOWN_QUESTION_REF", `outline.coverage.${i}`);
    return { ...item, questionIds: kept };
  });

  return { value: { ...raw, steps, coverage: knownQuestions(knownDecisions(repairedCoverage, "coverage")), openQuestions: knownDecisions(questions, "openQuestions"),
    eliminatedAsIsSteps: eliminated }, warnings };
}

/** The outline repair answer is a whole new outline, so a model asked to fix one field can break another that was fine. For a step
 * (same id) whose list field is unusable now, was usable in the previous attempt and was not named by any issue of that attempt, the
 * previous value is restored. Only requirementIds, asIsStepIds and implementation.referenceIds; ids copied, never invented. */
export function restoreFromPrevious(previous: { value: unknown; issues: readonly ValidationIssue[] }, raw: unknown):
  { value: unknown; warnings: ValidationIssue[] } {
  const warnings: ValidationIssue[] = [];
  if (!isObj(previous.value) || !Array.isArray(previous.value.steps) || !isObj(raw) || !Array.isArray(raw.steps)) return { value: raw, warnings };
  const before = new Map(previous.value.steps.flatMap((step, i) => isObj(step) && typeof step.id === "string" ? [[step.id, { step, i }] as const] : []));
  const named = (path: string) => previous.issues.some(issue => path === issue.path || path.startsWith(`${issue.path}.`));
  const usable = (value: unknown) => (strings(value)?.length ?? 0) > 0;
  const steps = raw.steps.map((step, i) => {
    const old = isObj(step) && typeof step.id === "string" ? before.get(step.id) : undefined;
    if (!isObj(step) || !old) return step;
    let out: Obj = step;
    const restore = (field: "requirementIds" | "asIsStepIds") => {
      const path = `outline.steps.${old.i}.${field}`;
      // An enabling step has no requirements on purpose: nothing to restore.
      if (usable(step[field]) || !usable(old.step[field]) || named(path) || (field === "requirementIds" && usable(step.enablesStepIds))) return;
      warn(`outline.steps.${i}.${field}`);
      out = { ...out, [field]: old.step[field] };
    };
    const warn = (path: string) => { warnings.push({ code: "REPAIRED_FROM_PREVIOUS_ATTEMPT", path }); };
    restore("requirementIds"); restore("asIsStepIds");
    const now = isObj(step.implementation) ? step.implementation : undefined, was = isObj(old.step.implementation) ? old.step.implementation : undefined;
    const path = `outline.steps.${old.i}.implementation.referenceIds`;
    const traced = now && ["STANDARD", "CONFIGURATION", "EXTENSION", "INTEGRATION"].includes(String(now.kind));
    if (now && was && traced && !usable(now.referenceIds) && usable(was.referenceIds) && !named(path)) {
      warn(`outline.steps.${i}.implementation.referenceIds`);
      out = { ...out, implementation: { ...now, referenceIds: was.referenceIds } };
    }
    return out;
  });
  return warnings.length ? { value: { ...raw, steps }, warnings } : { value: raw, warnings };
}

type Reference = { id: string; fitType: string; status: string; targetProduct: string; targetRelease: string };
const DEMAND: Record<string, number> = { STANDARD: 0, CONFIGURATION: 1, EXTENSION: 2, INTEGRATION: 2 };

/** Two repairs that need the SAP catalog or the step order and have one deterministic answer, applied after repairOutlineShape.
 * - REPAIRED_FIT_KIND: a STANDARD or CONFIGURATION step whose every cited reference is a verified catalog entry for the target
 *   release is raised to the most demanding cited fit type (STANDARD < CONFIGURATION < EXTENSION | INTEGRATION). Only ever raised, so
 *   effort is never understated. Citing both EXTENSION and INTEGRATION, or MANUAL / LICENSE_DEPENDENT, is a judgment and is left alone.
 * - REPAIRED_ENABLING_LINK: a step without requirements of its own enables the next requirement-bearing step in sequence (the previous
 *   one when none follows); an enabled step that is itself, or has no requirements, is replaced by the next requirement-bearing step
 *   at or after it. Needs at least one requirement-bearing step; an unknown step id is left to fail validation.
 * Ids only, no model text. CONDITIONAL coverage without a decision or question is deliberately not repaired: it needs judgment. */
export function repairOutlineLinks(target: { product: string; release: string }, references: readonly Reference[], raw: unknown):
  { value: unknown; warnings: ValidationIssue[] } {
  const warnings: ValidationIssue[] = [];
  if (!isObj(raw) || !Array.isArray(raw.steps) || !raw.steps.every(isObj)) return { value: raw, warnings };
  const list: Obj[] = raw.steps;
  const catalog = new Map(references.map(reference => [reference.id, reference]));
  const bears = (step: Obj) => (strings(step.requirementIds)?.length ?? 0) > 0;
  const ids = list.map(step => step.id);
  const bearing = list.flatMap((step, i) => bears(step) ? [i] : []);
  const nearest = (from: number) => bearing.find(i => i >= from) ?? bearing.filter(i => i < from).at(-1);

  const steps = list.map((step, i): Obj => {
    const path = `outline.steps.${i}`;
    let out = step;
    const implementation = isObj(step.implementation) ? step.implementation : undefined;
    const cited = strings(implementation?.referenceIds)?.map(ref => catalog.get(ref));
    if (implementation && (implementation.kind === "STANDARD" || implementation.kind === "CONFIGURATION") && cited?.length &&
        cited.every((ref): ref is Reference => !!ref && ref.status === "VERIFIED" && ref.targetProduct === target.product && ref.targetRelease === target.release)) {
      const types = new Set(cited.map(ref => ref.fitType));
      const known = [...types].every(type => type in DEMAND);
      const top = Math.max(...[...types].map(type => DEMAND[type] ?? -1));
      const named = [...types].filter(type => DEMAND[type] === top);
      if (known && named.length === 1 && top > DEMAND[implementation.kind]!) {
        warnings.push({ code: "REPAIRED_FIT_KIND", path: `${path}.implementation` });
        out = { ...out, implementation: { ...implementation, kind: named[0] } };
      }
    }
    if (bears(step) || !bearing.length) return out;
    const listed = Array.isArray(step.enablesStepIds) ? strings(step.enablesStepIds) : step.enablesStepIds === undefined ? [] : undefined;
    if (!listed) return out;
    const fix = (ref: string) => {
      const at = ids.indexOf(ref);
      return at < 0 || (at !== i && bears(list[at]!)) ? ref : ids[nearest(Math.max(at, i)) ?? at] as string;
    };
    const targets = listed.length ? [...new Set(listed.map(fix))] : [ids[nearest(i + 1)!] as string];
    if (targets.length === listed.length && targets.every((ref, j) => ref === listed[j])) return out;
    warnings.push({ code: "REPAIRED_ENABLING_LINK", path });
    return { ...out, enablesStepIds: targets };
  });
  return warnings.length ? { value: { ...raw, steps }, warnings } : { value: raw, warnings };
}
