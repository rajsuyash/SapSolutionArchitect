import { z } from "zod";
import { FIT_TYPES, basis, id, ids, list, text, trace } from "./design-primitives";
import { mentionsSubject, norm, overlaps, type RegisterContext, type Report, type Row } from "./design-register-types";
import {
  ConfigurationItemSchema, ControlMappingSchema, DocumentStatusModelSchema, EndToEndTestSchema, ObjectiveSchema, ReportRowSchema, RoleSchema,
  BUILT_CLASSES, PeriodEndActivitySchema, ScopeStatementSchema, SodAssessmentSchema, checkVersion3, fitGapExtension, interfaceExtension, kpiExtension, masterDataExtension, orgExtension,
} from "./design-registers-v3";

export type { RegisterContext } from "./design-register-types";

/** The solution-design registers a principal consultant's blueprint carries beyond the step walkthrough (schemaVersion 2).
 * Every row traces to requirements, company-context field ids and/or steps; every SAP object it names comes from the curated
 * catalog (`referenceIds`) or is flagged `needsValidation` with a reason. */
export const FIT_CLASSES = ["STANDARD", "CONFIGURATION", "STANDARD_INTEGRATION", "KEY_USER_EXTENSION", "SIDE_BY_SIDE_BTP", "CLASSIC_RICEFW", "MANUAL_WORKAROUND"] as const;
export const RICEFW_TYPES = ["REPORT", "INTERFACE", "CONVERSION", "ENHANCEMENT", "FORM", "WORKFLOW"] as const;
export const NOT_PROVIDED = "not provided";

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

/** A KPI value must sit inside ONE line/semicolon item of the answer and speak only of this KPI's measure: pasting the whole answer (or its other
 * comma-separated figures) onto every KPI is not a figure for the measure. A leading "label:" is ignored when judging relevance. */
const isAboutMeasure = (claimed: string, source: string, subject: string) => {
  if (!segments(source).some(part => part.includes(claimed))) return false;
  const items = claimed.replace(/^[^:,;]{1,40}:\s*/, "").split(/[,;]/).map(item => item.trim()).filter(Boolean);
  return items.length > 0 && items.every(item => mentionsSubject(subject, item, true));
};

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
    for (const [value, source] of [[row.baseline, baselines], [row.target, targets]] as const) {
      const claimed = norm(value);
      if (claimed === NOT_PROVIDED) continue;
      if (source === undefined || !norm(source).includes(claimed)) error("KPI_VALUE_NOT_VERBATIM", path);
      else if (!isAboutMeasure(claimed, source, `${row.name} ${row.measuredFrom}`)) error("KPI_VALUE_NOT_FOR_MEASURE", path, "a KPI baseline or target must be the part of the company-context answer that is about this KPI's own measure: copy only that part (one line, never the whole answer or other measures' figures), or write exactly \"not provided\" and keep the measure if only a target exists");
    }
    // "not provided" while the answer has a line about this measure is a value the design ignored (a review finding, fixable by the KPI call).
    for (const [value, source] of [[row.baseline, baselines], [row.target, targets]] as const) {
      if (norm(value) === NOT_PROVIDED && source !== undefined && segments(source).some(part => part !== NOT_PROVIDED && /\d/.test(part) && mentionsSubject(`${row.name} ${row.measuredFrom}`, part, false))) {
        block("KPI_VALUE_IGNORED", path); break;
      }
    }
  });
  if (targets !== undefined) {
    const stated = kpis.map(row => norm(row.target)).filter(target => target !== NOT_PROVIDED);
    if (segments(targets, true).some(part => !stated.some(target => overlaps(part, target)))) error("KPI_TARGET_UNCOVERED", "draft.kpis");
  }
  if (draft.schemaVersion === 3) {
    checkVersion3({ ctx, error, block, known, dup, rows: key => rows(key as RegisterKey), based: (key, row, i, needed) => based(key as RegisterKey, row, i, needed),
      traced: (key, row, i, extra, required) => traced(key as RegisterKey, row, i, extra, required) });
  }
}
