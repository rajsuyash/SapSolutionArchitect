import { z } from "zod";
import { FIRST_PHASE, basis, id, ids, text, trace } from "./design-primitives";
import { norm, overlaps, type RegisterContext, type Report, type Row } from "./design-register-types";

/** The registers and row fields a schemaVersion 3 design adds to version 2: scope and objectives, document status models and a
 * configuration catalogue, a role catalogue with segregation-of-duties and control mappings, a reports list and end-to-end tests,
 * plus owner/channel/failure-handling fields on the version 2 registers. Version 1 and 2 designs carry none of them. */

export const MITIGATION_TYPES = ["NONE_STANDARD_FITS", "PROCESS_CHANGE", "CONFIGURE", "EXTEND_KEY_USER", "BUILD_SIDE_BY_SIDE", "DEVELOP_CUSTOM", "MANUAL_WORKAROUND"] as const;
/** Which mitigation a fit-gap classification can carry; the mitigation says how the gap is closed, so the two must agree. */
export const MITIGATIONS_BY_CLASS: Record<string, readonly (typeof MITIGATION_TYPES)[number][]> = {
  STANDARD: ["NONE_STANDARD_FITS", "PROCESS_CHANGE"], CONFIGURATION: ["CONFIGURE"], STANDARD_INTEGRATION: ["CONFIGURE"],
  KEY_USER_EXTENSION: ["EXTEND_KEY_USER"], SIDE_BY_SIDE_BTP: ["BUILD_SIDE_BY_SIDE"], CLASSIC_RICEFW: ["DEVELOP_CUSTOM"],
  MANUAL_WORKAROUND: ["MANUAL_WORKAROUND", "PROCESS_CHANGE"],
};
export const CONFIG_CATEGORIES = ["DOCUMENT_TYPE", "REASON_CODE", "PRICING_ELEMENT", "NUMBER_RANGE", "OTHER"] as const;
export const CONFIG_STATUSES = ["CONFIRMED_IN_CATALOG", "BUSINESS_TO_PROVIDE", "NEEDS_VALIDATION"] as const;
export const CONTROL_MECHANISMS = ["BUSINESS_RULE", "WORKFLOW", "AUTHORIZATION", "REPORT"] as const;
/** Company-context answers an objective may rest on. Each one that was answered must be cited by some objective. */
export const OBJECTIVE_FIELDS = ["desired_outcome", "kpi_targets", "constraints"] as const;

// --- fields added to version 2 register rows: required in a model answer, optional when reading a stored design -------------------

export const orgExtension = { parentId: id.nullable() };
export const masterDataExtension = { creationChannel: text, governance: text };
export const interfaceExtension = { failureHandling: z.strictObject({ detection: text, alerting: text, rerun: text, idempotency: text }).nullable() };
export const kpiExtension = { owner: text, producingStepId: id };
export const fitGapExtension = { mitigationType: z.enum(MITIGATION_TYPES), owner: text, status: z.literal("OPEN") };

// --- new registers --------------------------------------------------------------------------------------------------------------

export const ObjectiveSchema = z.strictObject({ id, statement: text, measure: text, ...trace });
export const ScopeStatementSchema = z.strictObject({ id, kind: z.enum(["IN_SCOPE", "OUT_OF_SCOPE"]), statement: text, reason: text, ...trace });
export const DocumentStatusModelSchema = z.strictObject({
  id, documentType: text, statuses: z.array(text).min(2).max(20),
  transitions: z.array(z.strictObject({ from: text.nullable(), to: text, stepId: id, event: text })).min(1).max(40),
  editLockRules: z.array(z.strictObject({ afterEvent: text, locked: text, stillEditable: text })).min(1).max(15),
  requirementIds: ids,
});
export const ConfigurationItemSchema = z.strictObject({
  id, category: z.enum(CONFIG_CATEGORIES), name: text, purpose: text, status: z.enum(CONFIG_STATUSES), owner: text,
  referenceIds: ids, note: text.nullable(), stepIds: ids,
});
export const RoleSchema = z.strictObject({ id, name: text, responsibilities: text, stepIds: ids.min(1) });
export const SodAssessmentSchema = z.strictObject({
  id, assessment: z.enum(["CONFLICT_IDENTIFIED", "NO_CONFLICT_ASSESSED"]), description: text, roleIds: ids.min(1), stepIds: ids.min(1), mitigation: text,
});
export const ControlMappingSchema = z.strictObject({
  id, requirementId: id, mechanism: z.enum(CONTROL_MECHANISMS), realization: text, stepIds: ids.min(1), ruleId: id.nullable(),
});
export const ReportRowSchema = z.strictObject({ id, name: text, purpose: text, realization: text, ...basis, ...trace });
export const EndToEndTestSchema = z.strictObject({ id, valueStream: text, given: text, when: text, then: text, stepIds: ids.min(2), requirementIds: ids.min(1) });

export const NEW_REGISTER_KEYS = ["objectives", "scopeStatements", "documentStatusModels", "configurationCatalogue", "roles", "sodAssessments",
  "controlMappings", "reports", "endToEndTests"] as const;

// --- mechanical checks ----------------------------------------------------------------------------------------------------------

type Rows = Record<string, unknown>;
export type V3Kit = {
  ctx: RegisterContext; error: Report; known: ReadonlyMap<string, string>;
  rows: (key: string) => (Row & Rows)[];
  dup: (values: string[], path: string, code: string) => void;
  /** Checks that the ids a row cites exist; `required` also demands at least one. */
  traced: (key: string, row: Row, i: number, extra?: string[], required?: boolean) => void;
  based: (key: string, row: Row, i: number, needed?: boolean) => void;
};

/** Version 3 checks. Everything here is decidable from the design and the company-context answers; a free-text claim is only compared
 * with another register of the same design (a role name with the step actors, a document type with the step outputs). */
export function checkVersion3(kit: V3Kit): void {
  const { ctx, error, known, rows, dup, traced, based } = kit;
  const steps = ctx.steps ?? [];
  const missing = (key: string, fields: readonly string[]) => rows(key).forEach((row, i) => {
    if (fields.some(field => row[field] === undefined)) error("REGISTER_FIELD_MISSING", `draft.${key}.${i}`);
  });
  const known3 = (code: string, path: string, refs: string[] | undefined, valid: ReadonlySet<string>) => { if (refs?.some(ref => !valid.has(ref))) error(code, path); };

  // Steps: type and phase (checklist 7, 14). Paths point at the step, so the step call is the one asked to fix them.
  steps.forEach((step, i) => {
    const path = `draft.steps.${i}`;
    if (!step.stepType) error("STEP_TYPE_MISSING", path);
    if (!step.phase) error("STEP_PHASE_MISSING", path);
    else if (step.phase !== FIRST_PHASE && !step.interimProcess) error("STEP_INTERIM_MISSING", path);
  });

  // Extended version 2 registers.
  const org = rows("orgStructure");
  missing("orgStructure", ["parentId"]);
  const orgIds = new Set(org.map(row => row.id as string));
  org.forEach((row, i) => {
    const parent = row.parentId as string | null | undefined;
    if (parent && (parent === row.id || !orgIds.has(parent))) error("ORG_PARENT_UNKNOWN", `draft.orgStructure.${i}`);
  });
  const parents = new Map(org.map(row => [row.id as string, (row.parentId as string | null | undefined) ?? null]));
  org.forEach((row, i) => {
    let at: string | null = row.id as string, hops = 0;
    while (at && hops++ <= org.length) at = parents.get(at) ?? null;
    if (at) error("ORG_PARENT_CYCLE", `draft.orgStructure.${i}`);
  });
  missing("masterDataPrerequisites", ["creationChannel", "governance"]);
  missing("interfaces", ["failureHandling"]);
  rows("interfaces").forEach((row, i) => { if (row.failureHandling === null && !row.outOfScopeReason) error("INTERFACE_FAILURE_HANDLING_MISSING", `draft.interfaces.${i}`); });
  missing("kpis", ["owner", "producingStepId"]);
  rows("kpis").forEach((row, i) => known3("UNKNOWN_STEP", `draft.kpis.${i}`, row.producingStepId ? [row.producingStepId as string] : [], ctx.stepIds));
  missing("fitGap", ["mitigationType", "owner", "status"]);
  rows("fitGap").forEach((row, i) => {
    const allowed = MITIGATIONS_BY_CLASS[row.classification as string];
    if (row.mitigationType !== undefined && allowed && !allowed.includes(row.mitigationType as never)) error("MITIGATION_CLASS_MISMATCH", `draft.fitGap.${i}`);
  });

  // Objectives and scope (checklist 2).
  const objectives = rows("objectives");
  if (!objectives.length) error("OBJECTIVE_MISSING", "draft.objectives");
  objectives.forEach((row, i) => {
    // An objective rests on what the business said (a requirement or a context answer); the steps only show which ones serve it.
    traced("objectives", row, i, [], false);
    if (!row.requirementIds?.length && !row.contextFieldIds?.length) error("REGISTER_TRACE_MISSING", `draft.objectives.${i}`);
    if (!row.stepIds?.length) error("OBJECTIVE_NO_STEPS", `draft.objectives.${i}`);
  });
  const served = new Set(objectives.flatMap(row => row.stepIds ?? []));
  if ([...ctx.stepIds].some(stepId => !served.has(stepId))) error("OBJECTIVE_STEP_UNMAPPED", "draft.objectives");
  if (OBJECTIVE_FIELDS.some(field => known.has(field) && !objectives.some(row => row.contextFieldIds?.includes(field)))) error("OBJECTIVE_CONTEXT_UNCOVERED", "draft.objectives");
  const scope = rows("scopeStatements");
  scope.forEach((row, i) => traced("scopeStatements", row, i, [], false));
  for (const kind of ["IN_SCOPE", "OUT_OF_SCOPE"]) if (!scope.some(row => row.kind === kind)) error("SCOPE_STATEMENT_MISSING", `draft.scopeStatements.${kind}`);

  // Document status models and the configuration catalogue (checklists 10, 11, 16).
  const models = rows("documentStatusModels") as (Row & { documentType: string; statuses: string[]; transitions: { from: string | null; to: string; stepId: string }[] })[];
  if (!models.length) error("STATUS_MODEL_MISSING", "draft.documentStatusModels");
  models.forEach((row, i) => {
    const path = `draft.documentStatusModels.${i}`;
    traced("documentStatusModels", row, i, [], false);
    const statuses = new Set(row.statuses.map(norm));
    if (statuses.size !== row.statuses.length) error("DUPLICATE_STATUS", path);
    for (const transition of row.transitions) {
      if (!ctx.stepIds.has(transition.stepId)) error("UNKNOWN_STEP", path);
      if (!statuses.has(norm(transition.to)) || (transition.from !== null && !statuses.has(norm(transition.from)))) error("STATUS_UNKNOWN", path);
    }
  });
  const sameType = (a: string, b: string) => overlaps(norm(a), norm(b));
  for (const step of steps) models.forEach((model, i) => {
    const type = norm(model.documentType);
    if (type.length >= 5 && step.outputDocuments.some(output => norm(output).includes(type)) && !model.transitions.some(transition => transition.stepId === step.id)) {
      error("STATUS_TRANSITION_MISSING", `draft.documentStatusModels.${i}`);
    }
  });
  const catalogue = rows("configurationCatalogue") as (Row & { category: string; name: string; status: string; note: string | null })[];
  if (!catalogue.length) error("CONFIG_CATALOGUE_MISSING", "draft.configurationCatalogue");
  catalogue.forEach((row, i) => {
    const path = `draft.configurationCatalogue.${i}`;
    traced("configurationCatalogue", row, i, [], false);
    known3("UNKNOWN_REFERENCE", path, row.referenceIds, ctx.referenceIds);
    dup(row.referenceIds ?? [], path, "DUPLICATE_TRACE");
    if (row.status === "CONFIRMED_IN_CATALOG" && !row.referenceIds?.length) error("CONFIG_CONFIRMATION_MISSING", path);
    if (row.status !== "CONFIRMED_IN_CATALOG" && !row.note) error("VALIDATION_REASON_MISSING", path);
  });
  models.forEach((model, i) => {
    if (!catalogue.some(item => item.category === "DOCUMENT_TYPE" && sameType(item.name, model.documentType))) error("CONFIG_DOCUMENT_TYPE_MISSING", `draft.documentStatusModels.${i}`);
  });

  // Roles, segregation of duties and control mappings (checklists 24 to 26).
  const roles = rows("roles") as (Row & { name: string })[];
  if (!roles.length) error("ROLE_MISSING", "draft.roles");
  dup(roles.map(row => norm(row.name)), "draft.roles", "DUPLICATE_ROLE");
  roles.forEach((row, i) => traced("roles", row, i, [], false));
  for (const step of steps) {
    const covering = roles.filter(role => role.stepIds?.includes(step.id));
    if (!covering.length) error("ROLE_STEP_UNCOVERED", "draft.roles");
    else if (!covering.some(role => sameType(role.name, step.actor))) error("ROLE_ACTOR_UNMATCHED", "draft.roles");
  }
  const roleIds = new Set(roles.map(row => row.id as string));
  const sod = rows("sodAssessments");
  if (!sod.length) error("SOD_ASSESSMENT_MISSING", "draft.sodAssessments");
  sod.forEach((row, i) => {
    const path = `draft.sodAssessments.${i}`;
    traced("sodAssessments", row, i, [], false);
    known3("UNKNOWN_ROLE", path, row.roleIds as string[], roleIds);
    if (row.assessment === "CONFLICT_IDENTIFIED" && (row.stepIds?.length ?? 0) < 2) error("SOD_CONFLICT_STEPS", path);
  });
  const mappings = rows("controlMappings") as (Row & { requirementId: string; mechanism: string; ruleId: string | null })[];
  const ruleIdsOf = (stepIds: string[] | undefined) => new Set(steps.filter(step => stepIds?.includes(step.id)).flatMap(step => step.businessRuleIds));
  mappings.forEach((row, i) => {
    const path = `draft.controlMappings.${i}`;
    traced("controlMappings", row, i, [], false);
    if (!ctx.requirements.has(row.requirementId)) error("UNKNOWN_REQUIREMENT", path);
    if (row.mechanism === "BUSINESS_RULE" && !row.ruleId) error("CONTROL_RULE_MISSING", path);
    if (row.ruleId && !ruleIdsOf(row.stepIds).has(row.ruleId)) error("CONTROL_RULE_UNKNOWN", path);
  });
  const mapped = new Set(mappings.map(row => row.requirementId));
  if ([...ctx.requirements].some(([requirementId, requirement]) => requirement.kind === "CONTROL" && !mapped.has(requirementId))) error("CONTROL_UNMAPPED", "draft.controlMappings");

  // Reports and end-to-end tests (checklists 22, 33).
  const reports = rows("reports");
  if (!reports.length) error("REPORT_MISSING", "draft.reports");
  reports.forEach((row, i) => { traced("reports", row, i); based("reports", row, i); });
  const cited = new Set([...reports, ...rows("kpis")].flatMap(row => row.requirementIds ?? []));
  if ([...ctx.requirements].some(([requirementId, requirement]) => requirement.kind === "PAIN_POINT" && !cited.has(requirementId))) error("REPORT_PAIN_POINT_UNCOVERED", "draft.reports");
  const tests = rows("endToEndTests");
  if (!tests.length) error("E2E_TEST_MISSING", "draft.endToEndTests");
  tests.forEach((row, i) => {
    const path = `draft.endToEndTests.${i}`;
    traced("endToEndTests", row, i);
    dup(row.stepIds ?? [], path, "DUPLICATE_TRACE");
  });
  const walked = new Set(tests.flatMap(row => row.stepIds ?? []));
  if ([...ctx.stepIds].some(stepId => !walked.has(stepId))) error("E2E_STEP_UNCOVERED", "draft.endToEndTests");
}
