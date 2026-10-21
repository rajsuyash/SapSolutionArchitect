import { z } from "zod";

const text = z.string().trim().min(1).max(4000);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const ProblemAnalysisSchema = z.strictObject({
  schemaVersion: z.literal(1),
  objectives: z.array(z.strictObject({ id: z.string().regex(/^OBJ-[1-9]\d*$/), text })).min(1).max(50),
  painPoints: z.array(z.strictObject({ id: z.string().regex(/^PPS-[1-9]\d*$/), text, quote: text })).max(100),
  scopeSummary: text,
  proposedProcesses: z.array(z.strictObject({ ref: identifier, parentRef: identifier.nullable(), level: z.number().int().min(1).max(3),
    code: identifier, name: text, module: z.string().max(20), rationale: text })).min(1).max(200),
  clarifyingQuestions: z.array(text).max(50),
  inputTruncated: z.boolean(),
});
export type ProblemAnalysis = z.infer<typeof ProblemAnalysisSchema>;

// This allowlist excludes auth/session data and arbitrary fields. The future job
// loader must authorize the tenant/project before assembling this internal input.
export const ProblemAnalysisInputSchema = z.object({
  name: z.string().trim().min(1).max(160), clientName: z.string().trim().min(1).max(160),
  problemStatement: z.string().trim().min(50).max(20000),
  targetProduct: z.enum(["S4HANA_CLOUD_PUBLIC", "S4HANA_CLOUD_PRIVATE", "S4HANA_ON_PREMISE"]),
  startingLandscape: z.enum(["NON_SAP", "EXISTING_SAP", "MIXED"]).default("MIXED"),
  modules: z.array(z.string().regex(/^[A-Z][A-Z0-9_-]{0,19}$/)).max(32).default([]),
  orgUnits: z.array(z.object({ type: z.enum(["COMPANY_CODE", "PLANT", "SALES_ORG", "REGION"]),
    code: z.string().regex(/^[A-Z0-9_-]{1,40}$/), name: z.string().trim().min(1).max(160) })).max(50).default([]),
  candidates: z.array(z.object({ kind: z.enum(["SCOPE_ITEM", "TCODE", "FIORI_APP", "IMG_ACTIVITY", "TABLE", "BUSINESS_ROLE"]),
    code: identifier, title: text, summary: text })).max(50).default([]),
});
export type ProblemAnalysisInput = z.infer<typeof ProblemAnalysisInputSchema>;
export type ValidationIssue = { path: string; code: string; detail?: string };
export function schemaIssues(issues: z.core.$ZodIssue[]): ValidationIssue[] {
  // Never return Zod messages, received values, or model-controlled property names.
  return issues.slice(0, 30).map((issue) => ({ path: issue.path.filter((part) => typeof part === "number" ||
    (typeof part === "string" && /^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(part))).join("."), code: issue.code }));
}

export function validateProblemAnalysis(value: unknown, statement: string):
  { success: true; data: ProblemAnalysis } | { success: false; errors: ValidationIssue[] } {
  const parsed = ProblemAnalysisSchema.safeParse(value);
  if (!parsed.success) return { success: false, errors: schemaIssues(parsed.error.issues) };
  const data = parsed.data;
  const errors: ValidationIssue[] = [];
  const invalid = (path: string, code: string) => errors.push({ path, code });
  for (const key of ["objectives", "painPoints"] as const) {
    if (new Set(data[key].map((item) => item.id)).size !== data[key].length) invalid(key, "duplicate_id");
  }
  data.painPoints.forEach((point, index) => {
    if (!statement.includes(point.quote)) invalid(`painPoints.${index}.quote`, "quote_not_in_source");
  });
  const nodes = new Map(data.proposedProcesses.map((node) => [node.ref, node]));
  if (nodes.size !== data.proposedProcesses.length) invalid("proposedProcesses", "duplicate_ref");
  if (new Set(data.proposedProcesses.map((node) => node.code)).size !== nodes.size) invalid("proposedProcesses", "duplicate_code");
  if (!data.proposedProcesses.some((node) => node.level === 1 && node.parentRef === null)) invalid("proposedProcesses", "missing_root");
  data.proposedProcesses.forEach((node, index) => {
    const parent = node.parentRef ? nodes.get(node.parentRef) : undefined;
    // Strictly increasing levels also exclude cycles, self-links and orphan trees.
    if (node.level === 1 ? node.parentRef !== null : !parent || parent.level !== node.level - 1) {
      invalid(`proposedProcesses.${index}.parentRef`, "invalid_hierarchy");
    }
  });
  return errors.length ? { success: false, errors: errors.slice(0, 30) } : { success: true, data };
}

/** Remove common email/credential forms from free text before provider I/O.
 * This is defense in depth, not a substitute for an authorized minimal loader. */
export function redactInput(input: ProblemAnalysisInput): ProblemAnalysisInput | null {
  const redact = (value: string) => value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g, "[redacted]")
    .replace(/\b(?:Bearer\s+\S+|(?:password|api[_ -]?key|secret|token)\s*[:=]\s*\S+)/gi, "[redacted]");
  // IDs/codes must be preserved, so reject credential-like identifiers instead of rewriting them.
  if ([...input.modules, ...input.orgUnits.map((unit) => unit.code), ...input.candidates.map((ref) => ref.code)]
    .some((value) => redact(value) !== value)) return null;
  return { ...input, name: redact(input.name), clientName: redact(input.clientName), problemStatement: redact(input.problemStatement),
    orgUnits: input.orgUnits.map((unit) => ({ ...unit, name: redact(unit.name) })),
    candidates: input.candidates.map((ref) => ({ ...ref, title: redact(ref.title), summary: redact(ref.summary) })) };
}
