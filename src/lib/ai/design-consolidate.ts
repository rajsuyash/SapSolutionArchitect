// Deterministic, warn-only consolidation of an assembled To-Be design: what the server can settle without a model call is settled here, so the same
// finding is not paid for again in a fix round (owners missing from the role catalogue, duplicate status models and configuration rows, KPIs with
// no plan to obtain a baseline). Every step returns the design it was given (same object) when it has nothing to do, so the whole is idempotent.
import { orgCodeChecker, type DetailedDesign } from "./design-quality";
import { norm, overlaps } from "./design-register-types";
import { NOT_PROVIDED, mergeDuplicateRoles, renameRoleRefs, rewriteStrings } from "./design-registers";
import { NO_OWNER_YET, OWNER_FIELDS, roleKey } from "./design-registers-v3";

type Warning = { code: string; path: string };
type Result = { design: DetailedDesign; warnings: Warning[] };
type Model = NonNullable<DetailedDesign["documentStatusModels"]>[number];
type ConfigRow = NonNullable<DetailedDesign["configurationCatalogue"]>[number];

const PLACEHOLDER_OWNER = "to be assigned";
const MAX_STATUSES = 20, MAX_TRANSITIONS = 40, MAX_LOCK_RULES = 15, MAX_LISTED_ITEMS = 6;
const unchanged = (design: DetailedDesign): Result => ({ design, warnings: [] });
const union = <T>(first: readonly T[], second: readonly T[], key: (item: T) => string): T[] => { const seen = new Set<string>(); return [...first, ...second].filter(item => !seen.has(key(item)) && !!seen.add(key(item))); };

/** `PREFIX-n` with n one above the highest PREFIX-number in `taken`, and itself untaken. */
function nextId(taken: Iterable<string>, prefix: string): string {
  const used = new Set(taken), pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let n = Math.max(0, ...[...used].map(item => Number(pattern.exec(item)?.[1] ?? 0)));
  while (used.has(`${prefix}-${++n}`)) { /* skip ids already in use */ }
  return `${prefix}-${n}`;
}

/** Every occurrence of a dropped row's id in the design's text becomes the id of the row it was merged into. */
function rewriteIds(design: DetailedDesign, ids: ReadonlyMap<string, string>): DetailedDesign {
  const escaped = [...ids.keys()].sort((a, b) => b.length - a.length).map(item => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${escaped.join("|")})(?![A-Za-z0-9_-])`, "g");
  return rewriteStrings(design, text => text.replace(pattern, found => ids.get(found) ?? found), "ID_REWRITTEN").value;
}

/** Roles whose names are one role (after abbreviations are read out) are merged into the first, and the dropped name variants renamed where they are used. */
function mergeRoles(design: DetailedDesign): Result {
  if (!design.roles || !design.sodAssessments) return unchanged(design);
  const merged = mergeDuplicateRoles({ roles: design.roles, sodAssessments: design.sodAssessments });
  if (!merged.warnings.length) return unchanged(design);
  return { design: renameRoleRefs({ ...design, ...merged.value }, merged.renames), warnings: merged.warnings };
}

function unionModels(first: Model, second: Model): Model | null {
  const statuses = union(first.statuses, second.statuses, norm);
  const transitions = union(first.transitions, second.transitions, item => `${norm(item.from ?? "")}|${norm(item.to)}|${item.stepId}`);
  const editLockRules = union(first.editLockRules, second.editLockRules, item => `${norm(item.afterEvent)}|${norm(item.locked)}|${norm(item.stillEditable)}`);
  // A union the schema would refuse stays two models: dropping statuses or transitions would not be honest.
  if (statuses.length > MAX_STATUSES || transitions.length > MAX_TRANSITIONS || editLockRules.length > MAX_LOCK_RULES) return null;
  return { ...first, statuses, transitions, editLockRules, requirementIds: [...new Set([...first.requirementIds, ...second.requirementIds])] };
}

/** Two status models of one document type become the first: the union of statuses, transitions (by from, to and step) and lock rules. */
function mergeStatusModels(design: DetailedDesign): Result {
  const models = design.documentStatusModels;
  if (!models) return unchanged(design);
  const kept: Model[] = [], dropped = new Map<string, string>(), warnings: Warning[] = [];
  models.forEach((model, i) => {
    const at = kept.findIndex(other => norm(other.documentType) === norm(model.documentType));
    const merged = at < 0 ? null : unionModels(kept[at]!, model);
    if (at < 0 || !merged) { kept.push(model); return; }
    kept[at] = merged; dropped.set(model.id, merged.id);
    warnings.push({ code: "DSM_MERGED", path: `draft.documentStatusModels.${i}` });
  });
  return warnings.length ? { design: rewriteIds({ ...design, documentStatusModels: kept }, dropped), warnings } : unchanged(design);
}

/** Two configuration rows of one category and normalised name become the first: the union of steps and references. */
function mergeConfigRows(design: DetailedDesign): Result {
  const rows = design.configurationCatalogue;
  if (!rows) return unchanged(design);
  const kept: ConfigRow[] = [], dropped = new Map<string, string>(), warnings: Warning[] = [];
  rows.forEach((row, i) => {
    const at = kept.findIndex(other => other.category === row.category && norm(other.name) === norm(row.name));
    if (at < 0) { kept.push(row); return; }
    const first = kept[at]!;
    kept[at] = { ...first, stepIds: [...new Set([...first.stepIds, ...row.stepIds])], referenceIds: [...new Set([...first.referenceIds, ...row.referenceIds])], note: first.note ?? row.note };
    dropped.set(row.id, first.id);
    warnings.push({ code: "CONFIG_MERGED", path: `draft.configurationCatalogue.${i}` });
  });
  return warnings.length ? { design: rewriteIds({ ...design, configurationCatalogue: kept }, dropped), warnings } : unchanged(design);
}

/** A status model whose document type has no DOCUMENT_TYPE row in the configuration catalogue gets one, for the business to provide (the SAP code is never invented). */
function addDocumentTypeRows(design: DetailedDesign): Result {
  const models = design.documentStatusModels, catalogue = design.configurationCatalogue;
  if (!models?.length || !catalogue) return unchanged(design);
  const rows = [...catalogue], warnings: Warning[] = [];
  for (const model of models) {
    if (rows.some(row => row.category === "DOCUMENT_TYPE" && overlaps(norm(row.name), norm(model.documentType)))) continue;
    const stepIds = [...new Set(model.transitions.map(transition => transition.stepId))];
    const owner = design.roles?.find(role => role.stepIds.includes(stepIds[0] ?? ""))?.name ?? PLACEHOLDER_OWNER;
    warnings.push({ code: "CONFIG_ROW_ADDED", path: `draft.configurationCatalogue.${rows.length}` });
    rows.push({ id: nextId(rows.map(row => row.id), "CFG"), category: "DOCUMENT_TYPE", name: model.documentType,
      purpose: `Document type that carries the ${model.documentType} lifecycle of status model ${model.id}.`, status: "BUSINESS_TO_PROVIDE", owner, referenceIds: [],
      note: `The business provides the SAP document type for ${model.documentType}; status model ${model.id} fixes the lifecycle it has to support.`, stepIds });
  }
  return warnings.length ? { design: { ...design, configurationCatalogue: rows }, warnings } : unchanged(design);
}

type OwnerUse = { name: string; items: string[]; stepIds: Set<string>; rowStepIds: Set<string> };
/** An owner written in a register row or a step exception or master-data line that no catalogue role carries becomes a role: the owner of what it owns. */
function addOwnerRoles(design: DetailedDesign): Result {
  const roles = design.roles;
  if (!roles?.length) return unchanged(design);
  const stepIds = new Set(design.steps.map(step => step.id));
  const catalogued = new Set([...roles.map(role => roleKey(role.name)), ...roles.map(role => roleKey(role.id))]);
  const uses = new Map<string, OwnerUse>();
  /** `inStep` marks an owner written inside a step (its steps are where the role acts); otherwise the steps are those of the register row that names it. */
  const noteOwner = (owner: unknown, item: string, steps: readonly (string | null | undefined)[], inStep: boolean) => {
    if (typeof owner !== "string" || !owner.trim() || NO_OWNER_YET.test(owner.trim()) || catalogued.has(roleKey(owner))) return;
    const entry = uses.get(roleKey(owner)) ?? { name: owner.trim(), items: [], stepIds: new Set<string>(), rowStepIds: new Set<string>() };
    if (!entry.items.includes(item)) entry.items.push(item);
    for (const stepId of steps) if (stepId && stepIds.has(stepId)) (inStep ? entry.stepIds : entry.rowStepIds).add(stepId);
    uses.set(roleKey(owner), entry);
  };
  for (const [register, field] of OWNER_FIELDS) {
    for (const row of ((design as Record<string, unknown>)[register] ?? []) as Record<string, unknown>[]) {
      const own = [...((row.stepIds ?? []) as string[]), ...((row.impactedStepIds ?? []) as string[]), row.producingStepId as string | undefined];
      noteOwner(row[field], `${register} ${String(row.id)}`, own, false);
    }
  }
  for (const step of design.steps) {
    step.exceptions.forEach(item => noteOwner(item.owner, `step ${step.id} exception`, [step.id], true));
    step.masterData.forEach(item => noteOwner(item.owner, `step ${step.id} master data`, [step.id], true));
  }
  const added: typeof roles = [], warnings: Warning[] = [];
  for (const owner of uses.values()) {
    const covered = owner.stepIds.size ? owner.stepIds : owner.rowStepIds;
    if (!covered.size) continue; // a role covers at least one step; with none to name, the finding stays for the model
    const shown = owner.items.slice(0, MAX_LISTED_ITEMS).join("; "), more = owner.items.length - MAX_LISTED_ITEMS;
    warnings.push({ code: "ROLE_ADDED_FOR_OWNER", path: `draft.roles.${roles.length + added.length}` });
    added.push({ id: nextId([...roles, ...added].map(role => role.id), "ROLE"), name: owner.name, responsibilities: `Owner of ${shown}${more > 0 ? ` and ${more} more` : ""}.`, stepIds: [...covered] });
  }
  return added.length ? { design: { ...design, roles: [...roles, ...added] }, warnings } : unchanged(design);
}

/** A KPI whose baseline or target is "not provided" says who obtains it and by when. */
function addKpiPlans(design: DetailedDesign): Result {
  const kpis = design.kpis;
  if (!kpis) return unchanged(design);
  const warnings: Warning[] = [];
  const rows = kpis.map((row, i) => {
    const owner = row.owner?.trim();
    if (!owner || NO_OWNER_YET.test(owner)) return row;
    const baseline = norm(row.baseline) === NOT_PROVIDED ? `${NOT_PROVIDED} — current value to be measured by ${owner} from today's records before go-live` : row.baseline;
    const target = norm(row.target) === NOT_PROVIDED ? `${NOT_PROVIDED} — to be set by ${owner} before go-live` : row.target;
    if (baseline !== row.baseline) warnings.push({ code: "KPI_PLAN_ADDED", path: `draft.kpis.${i}.baseline` });
    if (target !== row.target) warnings.push({ code: "KPI_PLAN_ADDED", path: `draft.kpis.${i}.target` });
    return baseline === row.baseline && target === row.target ? row : { ...row, baseline, target };
  });
  return warnings.length ? { design: { ...design, kpis: rows }, warnings } : unchanged(design);
}

/** A text that gives an organisation unit a code other than the organisation structure's has just that code token rewritten to the structure's, when every unit of that name agrees on it. */
function repairOrgCodes(design: DetailedDesign): Result {
  const org = design.orgStructure;
  if (!org?.some(row => row.code)) return unchanged(design);
  const check = orgCodeChecker(org);
  const { orgStructure, ...rest } = design;
  const rewritten = rewriteStrings(rest, text => {
    const spans = check(text).filter(span => span.unambiguous).sort((a, b) => b.start - a.start);
    return spans.reduce((out, span, i) => i && spans[i - 1]!.start < span.end ? out : out.slice(0, span.start) + span.expected + out.slice(span.end), text);
  }, "ORG_CODE_REPAIRED");
  return rewritten.warnings.length ? { design: { ...rewritten.value, orgStructure } as DetailedDesign, warnings: rewritten.warnings } : unchanged(design);
}

const HELD_ID = String.raw`(?:[A-Z][A-Za-z0-9]*-)?(?:IQ|OQ)-\d+`;
const PENDING_HOLD = new RegExp(String.raw`\bPending\s+(${HELD_ID}(?:\s*(?:,|and|&|/)\s*${HELD_ID})*)`, "g");
const stringsIn = (node: unknown): string[] => typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(stringsIn) : node && typeof node === "object" ? Object.values(node).flatMap(stringsIn) : [];

/** A coverage row that says IMPLEMENTED while a step realising that requirement holds the behaviour ("Pending IQ-7 ..." in a rule, action, effect or a test of that requirement)
 * becomes CONDITIONAL on the cited questions the design registers. Rows already conditional, deferred or rejected are left alone. */
function holdCoverageOnPendingQuestions(design: DetailedDesign): Result {
  const registered = new Set(design.openQuestions.map(question => question.id));
  const warnings: Warning[] = [];
  const coverage = design.coverage.map((row, i) => {
    if (row.disposition !== "IMPLEMENTED") return row;
    const texts = design.steps.filter(step => step.requirementIds.includes(row.requirementId)).flatMap(step =>
      stringsIn([step.businessRules, step.actions, step.effects, step.acceptanceTests.filter(test => test.requirementIds.includes(row.requirementId))]));
    const cited = [...new Set(texts.flatMap(text => [...text.matchAll(PENDING_HOLD)].flatMap(match => match[1]!.match(new RegExp(HELD_ID, "g")) ?? [])))].filter(id => registered.has(id));
    if (!cited.length) return row;
    warnings.push({ code: "COVERAGE_MADE_CONDITIONAL", path: `draft.coverage.${i}` });
    return { ...row, disposition: "CONDITIONAL" as const, questionIds: [...new Set([...(row.questionIds ?? []), ...cited])], rationale: `Held pending ${cited.join(", ")}: ${row.rationale}` };
  });
  return warnings.length ? { design: { ...design, coverage }, warnings } : unchanged(design);
}

/** The consolidation run on every assembled design: duplicates merged first (roles, status models, configuration rows), then the rows the merged design lacks added. */
export function consolidateDesign<T extends DetailedDesign>(design: T): { design: T; warnings: Warning[] } {
  let current: DetailedDesign = design;
  const warnings: Warning[] = [];
  for (const step of [mergeRoles, mergeStatusModels, mergeConfigRows, addDocumentTypeRows, addOwnerRoles, addKpiPlans, repairOrgCodes, holdCoverageOnPendingQuestions]) {
    const out = step(current);
    current = out.design; warnings.push(...out.warnings);
  }
  return { design: current as T, warnings };
}

export { addDocumentTypeRows, addKpiPlans, addOwnerRoles, holdCoverageOnPendingQuestions, mergeConfigRows, repairOrgCodes, mergeRoles, mergeStatusModels };
