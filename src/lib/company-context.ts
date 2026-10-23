// Client-safe: shared by the discovery schema, the workspace compiler and the To-Be pipeline.
import { z } from "zod";
import { WORKSPACE_FIELDS } from "./workspace-fields";

type FieldId = (typeof WORKSPACE_FIELDS)[number]["id"];
const FIELD_IDS = WORKSPACE_FIELDS.map(field => field.id) as [FieldId, ...FieldId[]];
const rawText = (limit: number) => z.string().min(1).max(limit).refine(value => !!value.trim() && !value.includes("\0"));

/** One answered interview field handed to the To-Be as design input. Only KNOWN facts are compiled in, each with the evidence
 * that proves the user said it. The value is client text: the model may quote it, never extend it. */
export const CompanyContextItemSchema = z.strictObject({
  fieldId: z.enum(FIELD_IDS), label: rawText(200), value: rawText(8000),
  evidence: z.strictObject({ sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), quote: rawText(8000) }),
});
export const CompanyContextSchema = z.array(CompanyContextItemSchema).max(WORKSPACE_FIELDS.length);
export type CompanyContext = z.infer<typeof CompanyContextSchema>;

/** The fields a single step call can use. Volumes, landscape, approvals, localisation and constraints shape step design; the
 * KPI, timeline and organisation fields belong to the registers and would only dilute a step prompt. */
export const STEP_CONTEXT_FIELD_IDS: ReadonlySet<string> = new Set<FieldId>([
  "operating_scale", "retained_systems", "external_parties", "approval_rules", "localization_compliance", "constraints", "required_outputs",
]);
const STEP_VALUE_LIMIT = 600;

/** Trimmed per-step view: relevant fields only, values capped, no evidence quotes. */
export const contextForStep = (context: CompanyContext | undefined) =>
  (context ?? []).filter(item => STEP_CONTEXT_FIELD_IDS.has(item.fieldId))
    .map(({ fieldId, label, value }) => ({ fieldId, label, value: value.length > STEP_VALUE_LIMIT ? `${value.slice(0, STEP_VALUE_LIMIT)}…` : value }));
