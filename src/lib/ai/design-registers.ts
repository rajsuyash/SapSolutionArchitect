import { z } from "zod";
import { FIT_TYPES, basis, id, ids, list, text, trace } from "./design-primitives";
import { norm, overlaps, type RegisterContext, type Report, type Row } from "./design-register-types";
import {
  ConfigurationItemSchema, ControlMappingSchema, DocumentStatusModelSchema, EndToEndTestSchema, ObjectiveSchema, ReportRowSchema, RoleSchema,
  BUILT_CLASSES, OWNER_FIELDS, PeriodEndActivitySchema, ScopeStatementSchema, SodAssessmentSchema, buildTypeOf, checkVersion3, roleKey, fitGapExtension, interfaceExtension, kpiExtension, masterDataExtension, orgExtension,
} from "./design-registers-v3";

export type { RegisterContext } from "./design-register-types";

/** The solution-design registers a principal consultant's blueprint carries beyond the step walkthrough (schemaVersion 2).
 * Every row traces to requirements, company-context field ids and/or steps; every SAP object it names comes from the curated
 * catalog (`referenceIds`) or is flagged `needsValidation` with a reason. */
export const FIT_CLASSES = ["STANDARD", "CONFIGURATION", "STANDARD_INTEGRATION", "KEY_USER_EXTENSION", "SIDE_BY_SIDE_BTP", "CLASSIC_RICEFW", "MANUAL_WORKAROUND"] as const;
export const RICEFW_TYPES = ["REPORT", "INTERFACE", "CONVERSION", "ENHANCEMENT", "FORM", "WORKFLOW"] as const;
export const NOT_PROVIDED = "not provided";
/** A KPI value that says nothing is provided: exactly "not provided", or "not provided — <plan to obtain it>" (see addKpiPlans). Compared normalised. */
export const isNotProvided = (value: string) => { const claimed = norm(value); return claimed === NOT_PROVIDED || claimed.startsWith(`${NOT_PROVIDED} — `); };

/** The fields version 3 adds to a version 2 row are required when the model answers and optional when a stored design is read. */
const optionally = <T extends z.ZodRawShape>(shape: T) =>
  Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, (value as z.ZodType).optional()])) as unknown as { [K in keyof T]: z.ZodOptional<T[K]> };

export const KeyDesignDecisionSchema = z.strictObject({
  id, topic: text,
  options: z.array(z.strictObject({ name: text, pros: text, cons: text, fitType: z.enum(FIT_TYPES) })).min(2).max(5),
  recommendation: text, rationale: text, impactedStepIds: ids.min(1), requirementIds: ids, contextFieldIds: ids,
  owner: text, status: z.literal("PROPOSED"),
});
const fitGapBase = { requirementId: id, classification: z.enum(FIT_CLASSES), ricefwType: z.enum(RICEFW_TYPES).nullable(), justification: text, stepIds: ids, ...basis };
const orgBase = { id, unitType: text, proposal: text, openPoint: text.nullable(), ...trace };
const masterDataBase = { id, object: text, owner: text, keyFields: z.array(text).min(1).max(50), migrationSource: text, ...trace };
const interfaceBase = {
  id, counterpartSystem: text, direction: z.enum(["INBOUND", "OUTBOUND", "BIDIRECTIONAL"]), triggerFrequency: text, payload: text,
  errorOwner: text, outOfScopeReason: text.nullable(), ...basis, ...trace,
};
const kpiBase = { id, name: text, baseline: text, target: text, measuredFrom: text, ...basis, ...trace };
export const FitGapRowSchema = z.strictObject({ ...fitGapBase, ...fitGapExtension });
export const OrgUnitSchema = z.strictObject({ ...orgBase, ...orgExtension });
export const MasterDataPrerequisiteSchema = z.strictObject({ ...masterDataBase, ...masterDataExtension });
export const InterfaceSchema = z.strictObject({ ...interfaceBase, ...interfaceExtension });
export const KpiSchema = z.strictObject({ ...kpiBase, ...kpiExtension });
export const DataMigrationSchema = z.strictObject({ id, object: text, source: text, approach: text, sequence: z.number().int().positive(), risk: text, ...trace });
export const CutoverSchema = z.strictObject({ id, activity: text, sequence: z.number().int().positive(), owner: text, risk: text, ...trace });

/** What a stored design may hold: the version 3 fields of the version 2 registers are optional here. */
const StoredFitGapSchema = z.strictObject({ ...fitGapBase, ...optionally(fitGapExtension) });
const StoredOrgUnitSchema = z.strictObject({ ...orgBase, ...optionally(orgExtension) });
const StoredMasterDataSchema = z.strictObject({ ...masterDataBase, ...optionally(masterDataExtension) });
const StoredInterfaceSchema = z.strictObject({ ...interfaceBase, ...optionally(interfaceExtension) });
const StoredKpiSchema = z.strictObject({ ...kpiBase, ...optionally(kpiExtension) });

export const RegistersShape = {
  keyDesignDecisions: list(KeyDesignDecisionSchema).optional(), fitGap: list(StoredFitGapSchema).optional(),
  orgStructure: list(StoredOrgUnitSchema).optional(), masterDataPrerequisites: list(StoredMasterDataSchema).optional(),
  interfaces: list(StoredInterfaceSchema).optional(), kpis: list(StoredKpiSchema).optional(),
  dataMigration: list(DataMigrationSchema).optional(), cutover: list(CutoverSchema).optional(),
  // Version 3.
  objectives: list(ObjectiveSchema).optional(), scopeStatements: list(ScopeStatementSchema).optional(),
  documentStatusModels: list(DocumentStatusModelSchema).optional(), configurationCatalogue: list(ConfigurationItemSchema).optional(),
  roles: list(RoleSchema).optional(), sodAssessments: list(SodAssessmentSchema).optional(), controlMappings: list(ControlMappingSchema).optional(),
  reports: list(ReportRowSchema).optional(), endToEndTests: list(EndToEndTestSchema).optional(), periodEndActivities: list(PeriodEndActivitySchema).optional(),
};
export type RegisterKey = keyof typeof RegistersShape;
export const REGISTER_KEYS = Object.keys(RegistersShape) as RegisterKey[];
/** The registers a version 2 design carries; version 3 adds the rest. */
export const VERSION_2_KEYS = REGISTER_KEYS.slice(0, 8);

/** One model call per group; each stays within roughly 4k output tokens. */
export const REGISTER_GROUPS = {
  decisions: ["keyDesignDecisions"], fitgap: ["fitGap"],
  foundation: ["masterDataPrerequisites", "dataMigration", "cutover", "periodEndActivities"], integration: ["interfaces", "kpis"],
  scope: ["objectives", "scopeStatements", "orgStructure"], reporting: ["reports", "endToEndTests"],
  documents: ["documentStatusModels", "configurationCatalogue"], governance: ["roles", "sodAssessments", "controlMappings"],
} as const satisfies Record<string, readonly RegisterKey[]>;
/** Groups that need the finished step bodies (actors, output documents, rule ids), so they run after the step calls. */
export const LATE_GROUPS = ["documents", "governance"] as const satisfies readonly (keyof typeof REGISTER_GROUPS)[];
export type RegisterGroup = keyof typeof REGISTER_GROUPS;
export const REGISTER_GROUP_NAMES = Object.keys(REGISTER_GROUPS) as RegisterGroup[];
export const groupOf = (key: string): RegisterGroup | undefined => REGISTER_GROUP_NAMES.find(group => (REGISTER_GROUPS[group] as readonly string[]).includes(key));

export const RegisterGroupSchemas = {
  decisions: z.strictObject({ keyDesignDecisions: list(KeyDesignDecisionSchema) }),
  fitgap: z.strictObject({ fitGap: list(FitGapRowSchema) }),
  foundation: z.strictObject({ masterDataPrerequisites: list(MasterDataPrerequisiteSchema), dataMigration: list(DataMigrationSchema), cutover: list(CutoverSchema), periodEndActivities: list(PeriodEndActivitySchema) }),
  integration: z.strictObject({ interfaces: list(InterfaceSchema), kpis: list(KpiSchema) }),
  scope: z.strictObject({ objectives: list(ObjectiveSchema), scopeStatements: list(ScopeStatementSchema), orgStructure: list(OrgUnitSchema) }),
  reporting: z.strictObject({ reports: list(ReportRowSchema), endToEndTests: list(EndToEndTestSchema) }),
  documents: z.strictObject({ documentStatusModels: list(DocumentStatusModelSchema), configurationCatalogue: list(ConfigurationItemSchema) }),
  governance: z.strictObject({ roles: list(RoleSchema), sodAssessments: list(SodAssessmentSchema), controlMappings: list(ControlMappingSchema) }),
} as const;
export type RegisterPayloads = { [G in RegisterGroup]: z.infer<(typeof RegisterGroupSchemas)[G]> };

// --- mechanical checks --------------------------------------------------------------------------------------

type Draft = { schemaVersion: 1 | 2 | 3 } & { [K in RegisterKey]?: unknown[] };

/** Lines and semicolon items of a free-text answer that a register must account for. Headings ("Systems we keep:") are skipped. */
export const segments = (value: string, needsDigit = false) => value.split(/\r?\n|;/).map(norm).filter(part =>
  part.length >= 3 && !part.endsWith(":") && (!needsDigit || /\d/.test(part)));

/** Units, time words and generic business nouns: they say nothing about WHICH measure a sentence is about ("customers pay 60-90 days" is not a baseline for every day-count KPI). */
const GENERIC_KPI_WORDS = new Set(["days", "day", "working", "period", "count", "counts", "share", "number", "numbers", "percent", "percentage", "value", "values", "total", "within", "month", "months", "monthly", "week", "weeks", "weekly",
  "quarter", "quarterly", "year", "yearly", "annual", "rate", "rates", "time", "times", "older", "than", "from", "with", "that", "this", "over", "under", "open", "closed", "late", "often", "later", "average", "daily", "hours", "end",
  "receipt", "receipts", "invoice", "invoices", "payment", "payments", "paid", "order", "orders", "document", "documents", "report", "reports", "finance", "business", "process", "flow", "carrying", "carried", "billed", "need", "needs", "must", "pending"]);
const kpiSubjectStems = (value: string) => new Set((norm(value).match(/[a-z]{4,}/g) ?? []).filter(word => !GENERIC_KPI_WORDS.has(word)).map(word => word.slice(0, 5)));
/** True when `text` shares a distinctive content word (stem of 4+ letters, not a unit/time/generic business word) with the KPI's NAME. A name with no distinctive word proves nothing. */
const sharesKpiSubject = (name: string, text: string) => {
  const wanted = kpiSubjectStems(name);
  if (!wanted.size) return true;
  const have = kpiSubjectStems(text);
  return [...wanted].some(stem => have.has(stem));
};
/** A target is verbatim when it sits inside ONE segment of the answer and does not paste two or more of that segment's comma-separated figures at once. No relevance to the KPI's name is asked. */
const isVerbatimTarget = (claimed: string, source: string) => segments(source).some(part => part.includes(claimed)
  && part.replace(/^[^:,;]{1,40}:\s*/, "").split(",").map(item => item.trim()).filter(item => item.length >= 3 && claimed.includes(item)).length < 2);
const stripEnumerator = (value: string) => value.replace(/^\s*\(\d+\)\s*/, "");

/** A KPI value must sit inside ONE line/semicolon item of the answer and speak only of this KPI's measure: pasting the whole answer (or its other
 * comma-separated figures) onto every KPI is not a figure for the measure. A leading "label:" or "(6)" is ignored when judging relevance. `name` is the KPI's name. */
const isAboutMeasure = (claimed: string, source: string, name: string) => {
  if (!segments(source).some(part => part.includes(claimed))) return false;
  const items = stripEnumerator(claimed).replace(/^[^:,;]{1,40}:\s*/, "").split(/[,;]/).map(item => item.trim()).filter(Boolean);
  return items.length > 0 && items.every(item => sharesKpiSubject(name, item));
};

/** A KPI baseline/target is a copy task, so the server settles it instead of failing the design: a value that is "not provided", or that already passes both KPI checks,
 * stays; any other becomes the first line/semicolon item of the company-context answer that is about the KPI's own measure, else "not provided". Never invents text.
 * Each replacement is reported as a KPI_VALUE_NORMALISED warning (code and path only). */
export function normaliseKpiRows<T extends { name: string; measuredFrom: string; baseline: string; target: string }>(
  kpis: readonly T[], companyContext: readonly { fieldId: string; value: string }[], basePath = "draft.kpis"): { rows: T[]; warnings: { code: string; path: string }[] } {
  const known = new Map(companyContext.map(item => [item.fieldId, item.value]));
  const warnings: { code: string; path: string }[] = [];
  const itemsOf = (source: string) => source.split(/\r?\n|;/).map(item => stripEnumerator(item.trim()).replace(/^[^:,;]{1,40}:\s*(?=\S)/, ""));
  const settle = (value: string, source: string | undefined, subject: string) => {
    const claimed = norm(value);
    if (isNotProvided(claimed)) return value;
    if (source !== undefined && norm(source).includes(claimed) && isAboutMeasure(claimed, source, subject)) return value;
    return source === undefined ? NOT_PROVIDED : itemsOf(source).find(item => segments(item).length > 0 && isAboutMeasure(norm(item), source, subject)) ?? NOT_PROVIDED;
  };
  const baselines = kpis.map(row => settle(row.baseline, known.get("kpi_baselines"), row.name));

  // A target is a verbatim single segment (or a contiguous part of one) of kpi_targets and needs no relevance test ("close in 5 days" stays on a "Job-work flow close" KPI);
  // the same text is never the target of two KPIs. A KPI left with "not provided" takes an unused segment that is about its own measure.
  const targetSource = known.get("kpi_targets");
  const used: string[] = [];
  const isUsed = (text: string) => used.some(item => text.includes(item) || item.includes(text));
  const targets = kpis.map(row => {
    const claimed = norm(row.target);
    if (isNotProvided(claimed)) return row.target;
    if (targetSource !== undefined && isVerbatimTarget(claimed, targetSource)) { if (isUsed(claimed)) return NOT_PROVIDED; used.push(claimed); return row.target; }
    const found = targetSource === undefined ? undefined : itemsOf(targetSource).find(item => segments(item).length > 0 && !isUsed(norm(item)) && isAboutMeasure(norm(item), targetSource, row.name));
    if (found) used.push(norm(found));
    return found ?? NOT_PROVIDED;
  });
  if (targetSource !== undefined) targets.forEach((target, i) => {
    const name = kpis[i]!.name;
    if (!isNotProvided(target) || kpiSubjectStems(name).size === 0) return;
    const found = itemsOf(targetSource).find(item => segments(item).length > 0 && !isUsed(norm(item)) && isAboutMeasure(norm(item), targetSource, name));
    if (found) { used.push(norm(found)); targets[i] = found; }
  });
  const rows = kpis.map((row, i) => {
    const baseline = baselines[i]!, target = targets[i]!;
    if (baseline !== row.baseline) warnings.push({ code: "KPI_VALUE_NORMALISED", path: `${basePath}.${i}.baseline` });
    if (target !== row.target) warnings.push({ code: "KPI_VALUE_NORMALISED", path: `${basePath}.${i}.target` });
    return baseline === row.baseline && target === row.target ? row : { ...row, baseline, target };
  });
  return { rows, warnings };
}

type Warning = { code: string; path: string };
type RoleRow = { id: string; name: string; responsibilities: string; stepIds: string[] };

/** Roles whose names are one role (roleKey) become the first of them: its id and name stay, its step ids are the union and a responsibility the first does not already say is appended.
 * Every reference to a dropped id (SoD roleIds, control mappings carry none) is rewritten to the kept id, and `renames` lists the dropped name variants (exact strings) for the caller to rewrite
 * where roles are named in other registers or steps. One ROLE_MERGED warning per dropped row (code and path only). Rows with distinct names are returned untouched. */
export function mergeDuplicateRoles<G extends { roles: RoleRow[]; sodAssessments: { roleIds: string[] }[] }>(group: G, basePath = "draft"):
  { value: G; warnings: Warning[]; renames: Map<string, string> } {
  const kept = new Map<string, RoleRow>(), idMap = new Map<string, string>(), renames = new Map<string, string>(), warnings: Warning[] = [];
  group.roles.forEach((role, i) => {
    const first = kept.get(roleKey(role.name));
    if (!first) { kept.set(roleKey(role.name), role); return; }
    idMap.set(role.id, first.id);
    if (role.name !== first.name) renames.set(role.name, first.name);
    warnings.push({ code: "ROLE_MERGED", path: `${basePath}.roles.${i}` });
    const known = norm(first.responsibilities);
    kept.set(roleKey(role.name), { ...first, stepIds: [...new Set([...first.stepIds, ...role.stepIds])],
      responsibilities: role.responsibilities && !known.includes(norm(role.responsibilities)) ? `${first.responsibilities.replace(/\s+$/, "")} ${role.responsibilities}` : first.responsibilities });
  });
  if (!warnings.length) return { value: group, warnings, renames };
  const roles = [...kept.values()];
  const sodAssessments = group.sodAssessments.map(row => row.roleIds.some(roleId => idMap.has(roleId))
    ? { ...row, roleIds: [...new Set(row.roleIds.map(roleId => idMap.get(roleId) ?? roleId))] } : row);
  return { value: { ...group, roles, sodAssessments }, warnings, renames };
}

const OWNER_KEYS = new Set(["actor", "owner", "errorOwner", ...OWNER_FIELDS.map(([, field]) => field)]);
/** Rewrites a dropped role-name variant to the kept name wherever a role is named by an actor or owner field (exact string match only), without touching the input. */
export function renameRoleRefs<T>(value: T, renames: ReadonlyMap<string, string>): T {
  if (!renames.size) return value;
  const walk = (node: unknown, owned: boolean): unknown => {
    if (typeof node === "string") return owned ? renames.get(node) ?? node : node;
    if (Array.isArray(node)) return node.map(item => walk(item, owned));
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item, OWNER_KEYS.has(key) || key === "owners")]));
    return node;
  };
  return walk(value, false) as T;
}

/** A built fit-gap row (key-user extension, side-by-side or classic development) with no RICEFW type takes the type its own justification names (a form, a custom report, a workflow, ...),
 * with a RICEFW_TYPE_INFERRED warning; a justification that names none stays as it is for the model to fix. */
export function inferRicefwTypes<T extends { classification: string; ricefwType: string | null; justification: string }>(rows: readonly T[], basePath = "draft.fitGap"): { rows: T[]; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const out = rows.map((row, i) => {
    const found = !row.ricefwType && BUILT_CLASSES.includes(row.classification) ? buildTypeOf(row.justification) : null;
    if (!found) return row;
    warnings.push({ code: "RICEFW_TYPE_INFERRED", path: `${basePath}.${i}` });
    return { ...row, ricefwType: found.type };
  });
  return { rows: out, warnings };
}

/** Words that say nothing about WHICH system is meant (generic IT nouns and the verbs of "X stays, Y is replaced"). */
const GENERIC_SYSTEM_WORDS = new Set(["system", "systems", "sap", "tool", "tools", "app", "apps", "application", "applications", "package", "packages", "the", "and", "with", "data",
  "legacy", "local", "old", "new", "for", "are", "was", "its", "our", "all", "stay", "stays", "kept", "keep", "must", "should", "will", "integrated", "integration", "replaced", "retired", "excel"]);
const distinctiveWords = (value: string) => new Set(value.split(/[^\p{L}\p{M}\p{N}]+/u).filter(word => word.length >= 3 && !GENERIC_SYSTEM_WORDS.has(word)));
/** True when both texts (already normalised) share a whole distinctive word. */
const sharesDistinctiveWord = (a: string, b: string) => { const words = distinctiveWords(b); return [...distinctiveWords(a)].some(word => words.has(word)); };

/** Checks the registers of a schemaVersion 2 design. A version 1 design must carry none. Codes only: no model text is echoed. */
export function checkRegisters(draft: Draft, ctx: RegisterContext, error: Report, block: Report): void {
  // Version 1 carries no registers, version 2 the first eight, version 3 all of them.
  const expected: readonly RegisterKey[] = draft.schemaVersion === 1 ? [] : draft.schemaVersion === 2 ? VERSION_2_KEYS : REGISTER_KEYS;
  for (const key of REGISTER_KEYS) {
    if (expected.includes(key) && draft[key] === undefined) error("REGISTER_MISSING", `draft.${key}`);
    if (!expected.includes(key) && draft[key] !== undefined) error("REGISTER_VERSION_MISMATCH", `draft.${key}`);
  }
  if (draft.schemaVersion === 1) return;
  const rows = (key: RegisterKey) => (draft[key] ?? []) as (Row & Record<string, unknown>)[];
  const known = new Map(ctx.companyContext.map(item => [item.fieldId, item.value]));
  const dup = (values: string[], path: string, code: string) => { if (new Set(values).size !== values.length) error(code, path); };

  // A step cites an open question (ETO-OQ-4, IQ-7) that is in no register: a blocker the step's fix pass clears, never an error.
  const questionIds = [...ctx.takenIds].filter(item => new RegExp(QUESTION_REF.source).test(item));
  (ctx.steps ?? []).forEach((step, i) => {
    const missing = [...new Set((step.texts ?? []).flatMap(text => [...text.matchAll(QUESTION_REF)].map(hit => hit[0])))].filter(token => !ctx.takenIds.has(token));
    if (missing.length) block("UNKNOWN_QUESTION_REFERENCE", `draft.steps.${i}`, `${missing.slice(0, 5).join(", ")} ${missing.length > 1 ? "do" : "does"} not exist; valid question ids: ${questionIds.slice(0, 12).join(", ") || "none"}`);
  });

  const seenIds = new Set(ctx.takenIds);
  for (const key of REGISTER_KEYS) rows(key).forEach((row, i) => {
    if (row.id === undefined) return;
    if (seenIds.has(row.id)) error("DUPLICATE_OUTPUT_ID", `draft.${key}.${i}`);
    seenIds.add(row.id);
  });
  const traced = (key: RegisterKey, row: Row, i: number, extra: string[] = [], required = true) => {
    const path = `draft.${key}.${i}`;
    if (row.requirementIds?.some(ref => !ctx.requirements.has(ref))) error("UNKNOWN_REQUIREMENT", path);
    if (row.contextFieldIds?.some(ref => !known.has(ref))) error("UNKNOWN_CONTEXT_FIELD", path);
    if (row.stepIds?.some(ref => !ctx.stepIds.has(ref))) error("UNKNOWN_STEP", path);
    for (const list of [row.requirementIds, row.contextFieldIds, row.stepIds]) dup(list ?? [], path, "DUPLICATE_TRACE");
    if (required && !(row.requirementIds?.length || row.contextFieldIds?.length || row.stepIds?.length || extra.length)) error("REGISTER_TRACE_MISSING", path);
  };
  const based = (key: RegisterKey, row: Row, i: number, needed = true) => {
    const path = `draft.${key}.${i}`;
    if (row.referenceIds?.some(ref => !ctx.referenceIds.has(ref))) error("UNKNOWN_REFERENCE", path);
    dup(row.referenceIds ?? [], path, "DUPLICATE_TRACE");
    if (needed && !row.referenceIds?.length && !row.needsValidation) error("SAP_BASIS_MISSING", path);
    if (row.needsValidation && !row.validationReason) error("VALIDATION_REASON_MISSING", path);
  };

  rows("keyDesignDecisions").forEach((row, i) => {
    traced("keyDesignDecisions", { ...row, stepIds: row.impactedStepIds as string[] }, i);
    const options = row.options as { name: string }[];
    dup(options.map(option => norm(option.name)), `draft.keyDesignDecisions.${i}`, "DUPLICATE_OPTION");
    if (!options.some(option => norm(option.name) === norm(row.recommendation as string))) error("RECOMMENDATION_NOT_AN_OPTION", `draft.keyDesignDecisions.${i}`);
  });

  const fitGap = rows("fitGap") as (Row & { requirementId: string; classification: string; ricefwType: string | null })[];
  dup(fitGap.map(row => row.requirementId), "draft.fitGap", "DUPLICATE_DISPOSITION");
  fitGap.forEach((row, i) => {
    const path = `draft.fitGap.${i}`;
    if (!ctx.requirements.has(row.requirementId)) error("UNKNOWN_REQUIREMENT", path);
    if (row.stepIds?.some(ref => !ctx.stepIds.has(ref))) error("UNKNOWN_STEP", path);
    // Anything built (a key-user query, a side-by-side app, classic development) states what is built. Version 2 designs stored before this rule stay valid.
    if (!row.ricefwType && (row.classification === "CLASSIC_RICEFW" || (draft.schemaVersion === 3 && BUILT_CLASSES.includes(row.classification)))) {
      error("RICEFW_TYPE_MISSING", path, `a ${row.classification.toLowerCase().replace(/_/g, " ")} row names what is built: ricefwType REPORT, INTERFACE, CONVERSION, ENHANCEMENT, FORM or WORKFLOW`);
    }
    if (!BUILT_CLASSES.includes(row.classification) && row.ricefwType) error("RICEFW_TYPE_UNEXPECTED", path);
    based("fitGap", row, i, row.classification !== "MANUAL_WORKAROUND");
  });
  const covered = new Set(fitGap.map(row => row.requirementId));
  if ([...ctx.requirements].some(([requirementId, requirement]) => requirement.critical && !covered.has(requirementId))) error("FIT_GAP_MISSING", "draft.fitGap");

  rows("orgStructure").forEach((row, i) => {
    traced("orgStructure", row, i);
    if (!row.contextFieldIds?.length && !row.openPoint) error("ORG_SOURCE_MISSING", `draft.orgStructure.${i}`);
  });
  rows("masterDataPrerequisites").forEach((row, i) => traced("masterDataPrerequisites", row, i));
  rows("dataMigration").forEach((row, i) => traced("dataMigration", row, i));
  rows("cutover").forEach((row, i) => traced("cutover", row, i));

  const interfaces = rows("interfaces") as (Row & { counterpartSystem: string; outOfScopeReason: string | null })[];
  interfaces.forEach((row, i) => {
    traced("interfaces", row, i);
    based("interfaces", row, i, !row.outOfScopeReason);
  });
  // Each line/semicolon item of the answer needs a row naming it: one distinctive word in common is enough (a one-sentence answer is one item).
  const retained = known.get("retained_systems");
  if (retained !== undefined) {
    const names = interfaces.map(row => norm(row.counterpartSystem));
    if (!interfaces.some(row => row.contextFieldIds?.includes("retained_systems"))) error("RETAINED_SYSTEM_UNCOVERED", "draft.interfaces", "no interface row cites retained_systems");
    else if (segments(retained).some(part => !names.some(name => overlaps(part, name) || sharesDistinctiveWord(part, name)))) error("RETAINED_SYSTEM_UNCOVERED", "draft.interfaces", "a retained system has no interface row naming it");
  }

  // Each interface in scope needs a cutover item for its initial load or connection set-up (open documents, master or condition data, credentials, certificates), or a "none needed" with the reason.
  if (draft.schemaVersion === 3) {
    const covering = [...rows("cutover").map(row => `${row.activity} ${row.risk}`), ...rows("dataMigration").map(row => `${row.object} ${row.source} ${row.approach}`)].map(norm);
    const bare = interfaces.filter(row => !row.outOfScopeReason && !covering.some(part => (row.id !== undefined && part.includes(norm(row.id))) || sharesDistinctiveWord(part, norm(row.counterpartSystem))));
    if (bare.length) block("CUTOVER_INTERFACE_UNCOVERED", "draft.cutover", bare.slice(0, 5).map(row => row.counterpartSystem).join("; "));
  }

  const kpis = rows("kpis") as (Row & { baseline: string; target: string; name: string; measuredFrom: string })[];
  const baselines = known.get("kpi_baselines"), targets = known.get("kpi_targets");
  kpis.forEach((row, i) => {
    traced("kpis", row, i);
    based("kpis", row, i);
    const path = `draft.kpis.${i}`;
    for (const [value, source, isTarget] of [[row.baseline, baselines, false], [row.target, targets, true]] as const) {
      const claimed = norm(value);
      if (isNotProvided(claimed)) continue;
      if (source === undefined || !norm(source).includes(claimed)) error("KPI_VALUE_NOT_VERBATIM", path);
      else if (isTarget ? !isVerbatimTarget(claimed, source) : !isAboutMeasure(claimed, source, row.name)) error("KPI_VALUE_NOT_FOR_MEASURE", path, "a KPI baseline or target must be the part of the company-context answer that is about this KPI's own measure: copy only that part (one line, never the whole answer or other measures' figures), or write exactly \"not provided\" and keep the measure if only a target exists");
    }
    // "not provided" while the answer has a line about this measure is a value the design ignored (a review finding, fixable by the KPI call).
    for (const [value, source] of [[row.baseline, baselines], [row.target, targets]] as const) {
      if (isNotProvided(value) && source !== undefined && segments(source).some(part => part !== NOT_PROVIDED && /\d/.test(part) && kpiSubjectStems(row.name).size > 0 && sharesKpiSubject(row.name, part))) {
        block("KPI_VALUE_IGNORED", path); break;
      }
    }
  });
  if (targets !== undefined) {
    const stated = kpis.map(row => norm(row.target)).filter(target => !isNotProvided(target));
    if (segments(targets, true).some(part => !stated.some(target => overlaps(part, target)))) block("KPI_TARGET_UNCOVERED", "draft.kpis"); // a finding, not a fatal error: a target the normaliser had to turn into "not provided" lands here
  }
  if (draft.schemaVersion === 3) {
    checkVersion3({ ctx, error, block, known, dup, rows: key => rows(key as RegisterKey), based: (key, row, i, needed) => based(key as RegisterKey, row, i, needed),
      traced: (key, row, i, extra, required) => traced(key as RegisterKey, row, i, extra, required) });
  }
}

// --- deterministic text rewrites on the assembled design -----------------------------------------------------

type TextRewrite = (text: string, key: string, parent: Record<string, unknown>) => string;
/** A copy of `value` with every string replaced by `rewrite(text, key, parentObject)`; each change is reported at its path as `code`. Ids are never rewritten here. */
export function rewriteStrings<T>(value: T, rewrite: TextRewrite, code: string, basePath = "draft"): { value: T; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const walk = (node: unknown, path: string, key: string, parent: Record<string, unknown>): unknown => {
    if (typeof node === "string") {
      if (key === "id" || key.endsWith("Id") || key.endsWith("Ids")) return node;
      const next = rewrite(node, key, parent);
      if (next !== node) warnings.push({ code, path });
      return next;
    }
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}.${i}`, key, parent));
    if (node && typeof node === "object") {
      const object = node as Record<string, unknown>;
      return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, walk(v, `${path}.${k}`, k, object)]));
    }
    return node;
  };
  return { value: walk(value, basePath, "", {}) as T, warnings };
}

const HONORIFIC = String.raw`(?:Mr|Mrs|Ms|Miss|Dr|Shri|Smt)\.?\s+`;
const NAME_WORDS = String.raw`\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+){0,2}`;
const PERSON = String.raw`${HONORIFIC}${NAME_WORDS}`;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Names that follow an honorific in the discovery text (sources, company-context answers): the full name and its "First Last" and leading two-word forms, longest first.
 * A single word is never listed (a surname alone is too ambiguous); the honorific rules still remove "Mr. Sharma". */
export function personNamesIn(texts: readonly string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) for (const hit of text.matchAll(new RegExp(`${HONORIFIC}(${NAME_WORDS})`, "gu"))) {
    const words = hit[1]!.split(/\s+/);
    if (words.length < 2) continue;
    names.add(words.join(" ")); names.add(`${words[0]} ${words[1]}`); names.add(`${words[0]} ${words[words.length - 1]}`);
  }
  return [...names].sort((a, b) => b.length - a.length);
}
const personPatterns = (names: readonly string[]) => {
  const known = names.length ? `(?<![\\p{L}\\p{M}])(?:${names.map(escapeRegExp).map(name => name.replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{M}])` : undefined;
  const person = known ? `(?:${PERSON}|${known})` : PERSON;
  return { wrapped: new RegExp(String.raw`\s*[(\[]\s*${person}\s*[)\]]`, "gu"), afterDash: new RegExp(String.raw`\s*[,—–-]\s*${person}(?=\s*(?:[,;.)]|$))`, "gu"),
    bare: new RegExp(person, "gu"), test: new RegExp(person, "u") };
};
const KPI_SOURCE_KEYS = new Set(["baseline", "target"]);
/** "CFO (Mr. Rajesh Kulkarni)" becomes "CFO": a To-Be names roles, not people. A field that was only a name becomes the title of the object it sits in, else a placeholder.
 * KPI baselines and targets are copies of the company-context answer and stay as written. An honorific (Mr, Ms, Mrs, Miss, Dr, Shri, Smt) followed by 1-3 capitalised words is removed,
 * and so is any name in `knownNames` (see personNamesIn) written without its honorific. */
export function removePersonNames<T>(design: T, knownNames: readonly string[] = []): { design: T; warnings: Warning[] } {
  const patterns = personPatterns(knownNames);
  const tidy = (text: string) => text.replace(/\(\s*\)|\[\s*\]/g, "").replace(/\s+([,;.])/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,;—–-]+|[\s,;—–-]+$/g, "");
  const { value, warnings } = rewriteStrings(design, (text, key, parent) => {
    if ((KPI_SOURCE_KEYS.has(key) && "measuredFrom" in parent) || !patterns.test.test(text)) return text;
    const stripped = tidy(text.replace(patterns.wrapped, "").replace(patterns.afterDash, "").replace(patterns.bare, ""));
    if (stripped) return stripped;
    const role = [parent.title, parent.name].find(item => typeof item === "string" && item.trim() && !patterns.test.test(item));
    return typeof role === "string" ? role : "Role to be confirmed";
  }, "PERSON_NAME_REMOVED");
  return { design: value, warnings };
}

/** Every occurrence of an input question's raw id in the design's text becomes its readable IQ-n label. */
export function rewriteQuestionIds<T>(design: T, labels: ReadonlyMap<string, string>): { design: T; warnings: Warning[] } {
  if (!labels.size) return { design, warnings: [] };
  const escaped = [...labels.keys()].sort((a, b) => b.length - a.length).map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${escaped.join("|")})(?![A-Za-z0-9_-])`, "g");
  const { value, warnings } = rewriteStrings(design, text => text.replace(pattern, id => labels.get(id) ?? id), "INPUT_QUESTION_ID_REWRITTEN");
  return { design: value, warnings };
}

const INPUT_QUESTION_REF = /(?<![A-Za-z0-9_-])IQ-\d+(?![A-Za-z0-9_-])/g;
/** The question-id pattern of a design: the model's own questions (ETO-OQ-4, ETO-OQ-5-F1) and the input questions (IQ-7). */
export const QUESTION_REF = /(?<![A-Za-z0-9_-])(?:IQ|[A-Z][A-Z0-9]*-OQ)-\d+(?:-[A-Z]+\d*)*(?![A-Za-z0-9_-])/g;
const PROCESS_OWNER = "Process owner";
type QuestionDesign = { steps: { id: string }[]; openQuestions: { id: string; question: string; owner: string; affectedStepIds: string[]; decisionIds?: string[] }[] };

/** Every input question (IQ-n) the design's text or id lists cite becomes an entry of design.openQuestions (the register a hold such as "Pending IQ-7" points at): the input's question text and owner
 * ("Process owner" when it names none) and, as affected steps, the steps whose text cites it (the steps of the register row that cites it, else the first step). An id the register already holds is left alone;
 * an IQ id the input does not have is not invented here (the question-reference check reports it). One INPUT_QUESTION_REGISTERED warning per entry added. */
export function registerInputQuestions<D extends QuestionDesign>(design: D, inputQuestions: readonly { id: string; question: string; owner: string }[]): { design: D; warnings: Warning[] } {
  const wanted = new Map(inputQuestions.map(item => [item.id, item]));
  const cited = new Map<string, Set<string>>();
  const walk = (node: unknown, stepIds: readonly string[]) => {
    if (typeof node === "string") { for (const [token] of node.matchAll(INPUT_QUESTION_REF)) { const set = cited.get(token) ?? new Set<string>(); stepIds.forEach(step => set.add(step)); cited.set(token, set); } return; }
    if (Array.isArray(node)) { node.forEach(item => walk(item, stepIds)); return; }
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    const own = Array.isArray(object.stepIds) ? object.stepIds.filter((item): item is string => typeof item === "string") : undefined;
    const here = own?.length ? own : stepIds;
    Object.values(object).forEach(value => walk(value, here));
  };
  const top = design as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(top)) {
    if (key === "openQuestions") continue;
    if (key === "steps" && Array.isArray(value)) value.forEach(step => walk(step, [(step as { id: string }).id]));
    else walk(value, []);
  }
  const held = new Set(design.openQuestions.map(item => item.id));
  const added = [...cited].filter(([token]) => wanted.has(token) && !held.has(token)).map(([token, stepIds]) => {
    const item = wanted.get(token)!;
    return { id: token, question: item.question, owner: item.owner.trim() || PROCESS_OWNER, affectedStepIds: stepIds.size ? [...stepIds] : design.steps.slice(0, 1).map(step => step.id) };
  }).filter(entry => entry.affectedStepIds.length > 0);
  if (!added.length) return { design, warnings: [] };
  const warnings = added.map((_, i) => ({ code: "INPUT_QUESTION_REGISTERED", path: `draft.openQuestions.${design.openQuestions.length + i}` }));
  return { design: { ...design, openQuestions: [...design.openQuestions, ...added] }, warnings };
}
