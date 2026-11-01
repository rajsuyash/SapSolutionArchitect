// Deterministic, warn-only consolidation of an assembled To-Be design: what the server can settle without a model call is settled here, so the same
// finding is not paid for again in a fix round (owners missing from the role catalogue, matched to an equivalent role or added with duties, duplicate
// status models and configuration rows, fit-gap steps that disagree with their coverage row, KPIs with no plan to obtain a baseline). Every step returns the design it was given (same object) when it has nothing to do, so the whole is idempotent.
import { orgCodeChecker, type DetailedDesign } from "./design-quality";
import { norm, overlaps } from "./design-register-types";
import { NOT_PROVIDED, mergeDuplicateRoles, renameRoleRefs, rewriteStrings } from "./design-registers";
import { NO_OWNER_YET, OWNER_FIELDS, roleKey } from "./design-registers-v3";

type Warning = { code: string; path: string };
type Result = { design: DetailedDesign; warnings: Warning[] };
type Model = NonNullable<DetailedDesign["documentStatusModels"]>[number];
type ConfigRow = NonNullable<DetailedDesign["configurationCatalogue"]>[number];

const PLACEHOLDER_OWNER = "to be assigned";
const MAX_STATUSES = 20, MAX_TRANSITIONS = 40, MAX_LOCK_RULES = 15, MAX_LISTED_ITEMS = 4, MAX_DUTY_CHARS = 70, MAX_RESPONSIBILITY_CHARS = 200;
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

type OwnerUse = { name: string; names: Set<string>; items: string[]; stepIds: Set<string>; rowStepIds: Set<string> };
type Row = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value.trim().replace(/[.;:,\s]+$/, "") : "";
const DANGLING_END = /\s(?:a|an|the|of|for|to|in|on|at|by|with|from|and|or|is|are|that|which|as)$/i;
/** A noun phrase of at most `max` characters, with a common first word (an article, "how", "whether" ...) lower-cased so it reads after a verb: the text up to its first clause boundary when it is longer; empty when no complete phrase fits
 * (a phrase ending in a connective is not complete), so a duty is dropped rather than cut mid-phrase. */
const phrase = (value: unknown, max = MAX_DUTY_CHARS) => {
  const whole = text(value);
  const boundary = whole.length <= max ? -1 : whole.search(/\s[-–—]\s|[,;:.(]/);
  const head = boundary === -1 ? whole : boundary > 8 ? whole.slice(0, boundary).replace(/[\s,;:.(]+$/, "") : "";
  return head.length > max || DANGLING_END.test(head) ? "" : head.replace(/^(?:the|a|an|how|whether|what|when|each|every|all|any|if|no|per|customer|vendor|material|batch|job|heat)\b/i, word => word.toLowerCase());
};
/** What an owned register row asks of its owner, as a short duty built from the row's own text (empty when the row has none to build it from). A fit-gap row gives its owner steps only: its justification is the fit call, not a duty. */
const REGISTER_DUTY: Record<string, (row: Row) => string> = {
  keyDesignDecisions: row => phrase(row.topic) && `Decides ${phrase(row.topic)}`,
  orgStructure: row => text(row.unitType) && `Maintains the ${text(row.unitType)} set-up`,
  masterDataPrerequisites: row => phrase(row.object) && `Provides ${phrase(row.object)} master data before go-live`,
  interfaces: row => phrase(row.counterpartSystem) && `Clears errors on the ${phrase(row.counterpartSystem)} interface`,
  kpis: row => phrase(row.name) && `Reports ${phrase(row.name)}`,
  cutover: row => phrase(row.activity) && `Carries out the cutover activity: ${phrase(row.activity)}`,
  periodEndActivities: row => phrase(row.activity) && `Carries out the period-end activity: ${phrase(row.activity)}`,
  configurationCatalogue: row => phrase(row.name) && `Confirms the ${phrase(row.name)} configuration`,
};
/** Roles are one role when their name keys match, or when one name's words (two at least) are all in the other's ("Plant head" / "Plant Head Chakan"). */
const sameRole = (a: string, b: string) => {
  const [x, y] = [new Set(roleKey(a).split(" ")), new Set(roleKey(b).split(" "))], [small, large] = x.size <= y.size ? [x, y] : [y, x];
  return roleKey(a) === roleKey(b) || small.size >= 2 && [...small].every(word => large.has(word));
};
/** Whole duties as sentences, in order, while they fit MAX_RESPONSIBILITY_CHARS (at most MAX_LISTED_ITEMS); a role with no duty text says where it acts. */
function dutiesOf(items: readonly string[], stepIds: readonly string[], titles: ReadonlyMap<string, string>): string {
  const fitting: string[] = [];
  for (const item of items.slice(0, MAX_LISTED_ITEMS)) {
    const next = [...fitting, `${item}.`].join(" ");
    if (next.length <= MAX_RESPONSIBILITY_CHARS) fitting.push(`${item}.`);
  }
  if (fitting.length) return fitting.join(" ");
  const where = stepIds.slice(0, MAX_LISTED_ITEMS).map(id => `${titles.get(id) ?? "the step"} (${id})`);
  while (where.length > 1 && `Acts in ${where.join("; ")}.`.length > MAX_RESPONSIBILITY_CHARS) where.pop();
  return `Acts in ${where.join("; ")}.`;
}
/** One short duty for a catalogue role, only when its verb is a kind of duty the role's text does not already hold, and only if it fits; the model's text is never rewritten. */
function withNewDuty(responsibilities: string, items: readonly string[]): string {
  const held = responsibilities.toLowerCase();
  const duty = items.find(item => !held.includes(item.split(" ")[0]!.toLowerCase().slice(0, 5)));
  const base = responsibilities.trim(), joined = duty ? `${/[.!?]$/.test(base) ? base : `${base}.`} ${duty}.` : "";
  return duty && joined.length <= MAX_RESPONSIBILITY_CHARS ? joined : responsibilities;
}

/** An owner written in a register row or a step exception or master-data line that no catalogue role carries is matched to the equivalent role (its steps extended, its name rewritten where used)
 * or, failing that, becomes a role whose responsibilities are the duties of what it owns; equivalent new owners become one role. */
function addOwnerRoles(design: DetailedDesign): Result {
  const roles = design.roles;
  if (!roles?.length) return unchanged(design);
  const stepIds = new Set(design.steps.map(step => step.id)), titles = new Map(design.steps.map(step => [step.id, step.title]));
  const catalogued = new Set([...roles.map(role => roleKey(role.name)), ...roles.map(role => roleKey(role.id))]);
  const uses = new Map<string, OwnerUse>();
  /** `inStep` marks an owner written inside a step (its steps are where the role acts); otherwise the steps are those of the register row that names it. */
  const noteOwner = (owner: unknown, duty: string, steps: readonly (string | null | undefined)[], inStep: boolean) => {
    if (typeof owner !== "string" || !owner.trim() || NO_OWNER_YET.test(owner.trim()) || catalogued.has(roleKey(owner))) return;
    const entry = uses.get(roleKey(owner)) ?? { name: owner.trim(), names: new Set<string>(), items: [], stepIds: new Set<string>(), rowStepIds: new Set<string>() };
    entry.names.add(owner);
    if (duty && !entry.items.some(item => item.split(" ", 3).join(" ") === duty.split(" ", 3).join(" "))) entry.items.push(duty);
    for (const stepId of steps) if (stepId && stepIds.has(stepId)) (inStep ? entry.stepIds : entry.rowStepIds).add(stepId);
    uses.set(roleKey(owner), entry);
  };
  for (const [register, field] of OWNER_FIELDS) {
    for (const row of ((design as Record<string, unknown>)[register] ?? []) as Row[]) {
      const own = [...((row.stepIds ?? []) as string[]), ...((row.impactedStepIds ?? []) as string[]), row.producingStepId as string | undefined];
      noteOwner(row[field], REGISTER_DUTY[register]?.(row) ?? "", own, false);
    }
  }
  for (const step of design.steps) {
    step.exceptions.forEach(item => noteOwner(item.owner, phrase(item.condition) && `Resolves ${phrase(item.condition)}`, [step.id], true));
    step.masterData.forEach(item => noteOwner(item.owner, phrase(item.object) && `Maintains ${phrase(item.object)}`, [step.id], true));
  }
  const all = roles.map(role => ({ role, items: [] as string[], created: false })), renames = new Map<string, string>(), warnings: Warning[] = [];
  for (const owner of uses.values()) {
    const covered = [...(owner.stepIds.size ? owner.stepIds : owner.rowStepIds)];
    const found = all.filter(entry => sameRole(entry.role.name, owner.name));
    if (found.length > 1) continue; // two roles fit: which one the owner is, is not for the server to guess
    const match = found[0];
    if (!match && !covered.length) continue; // a role covers at least one step; with none to name, the finding stays for the model
    if (match) {
      for (const name of owner.names) if (name !== match.role.name) renames.set(name, match.role.name);
      match.role = { ...match.role, stepIds: [...new Set([...match.role.stepIds, ...covered])], responsibilities: match.created ? match.role.responsibilities : withNewDuty(match.role.responsibilities, owner.items) };
      if (match.created) match.items.push(...owner.items); // a role made from an earlier owner takes every duty of its equivalents
      warnings.push({ code: "ROLE_OWNER_MATCHED", path: `draft.roles.${all.indexOf(match)}` });
    } else {
      warnings.push({ code: "ROLE_ADDED_FOR_OWNER", path: `draft.roles.${all.length}` });
      all.push({ role: { id: nextId(all.map(entry => entry.role.id), "ROLE"), name: owner.name, responsibilities: "", stepIds: covered }, items: owner.items, created: true });
    }
  }
  if (!warnings.length) return unchanged(design);
  const finished = all.map(entry => entry.created ? { ...entry.role, responsibilities: dutiesOf(entry.items, entry.role.stepIds, titles) } : entry.role);
  return { design: renameRoleRefs({ ...design, roles: finished }, renames), warnings };
}

/** A fit-gap row's steps are those of the coverage row of its requirement (the outline owns the trace); a row is left alone when the coverage row names no step. */
function syncFitGapSteps(design: DetailedDesign): Result {
  const rows = design.fitGap;
  if (!rows) return unchanged(design);
  const coverage = new Map(design.coverage.map(row => [row.requirementId, row.stepIds])), warnings: Warning[] = [];
  const synced = rows.map((row, i) => {
    const steps = coverage.get(row.requirementId);
    if (!steps?.length || (steps.length === new Set(row.stepIds).size && steps.every(id => row.stepIds.includes(id)))) return row;
    warnings.push({ code: "FITGAP_STEPS_SYNCED", path: `draft.fitGap.${i}` });
    return { ...row, stepIds: [...steps] };
  });
  return warnings.length ? { design: { ...design, fitGap: synced }, warnings } : unchanged(design);
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
  for (const step of [mergeRoles, mergeStatusModels, mergeConfigRows, addDocumentTypeRows, addOwnerRoles, syncFitGapSteps, addKpiPlans, repairOrgCodes, holdCoverageOnPendingQuestions]) {
    const out = step(current);
    current = out.design; warnings.push(...out.warnings);
  }
  return { design: current as T, warnings };
}

export { addDocumentTypeRows, addKpiPlans, addOwnerRoles, holdCoverageOnPendingQuestions, mergeConfigRows, repairOrgCodes, mergeRoles, mergeStatusModels, syncFitGapSteps };
