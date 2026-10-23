import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { AuthError, type AuthService, type SessionUser } from "./auth";
import { CompanyContextSchema } from "./company-context";
import { withTenantSession } from "./tenant";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
// Preserve source whitespace and Unicode verbatim, including CRLF.
const rawText = (limit: number) => z.string().min(1).max(limit).refine(value => !!value.trim() && !value.includes("\0"));
const text = rawText(8000);
const label = rawText(200);
const evidence = z.strictObject({ sourceId: id, quote: text });
const texts = z.array(text).max(50);
export const DiscoveryInputSchema = z.strictObject({
  schemaVersion: z.literal(1), variantName: label, targetRelease: label.nullable(),
  sources: z.array(z.strictObject({
    id, title: label, revision: label, locator: label, text: rawText(40000),
  })).min(1).max(200),
  asIsSteps: z.array(z.strictObject({
    id, sequence: z.number().int().positive(), name: label, actor: label, system: label,
    trigger: text, description: text, inputs: texts, outputs: texts, controls: texts,
    exceptions: texts, evidence,
  })).min(1).max(200),
  requirements: z.array(z.strictObject({
    id, asIsStepId: id, kind: z.enum(["PAIN_POINT", "TO_BE_REQUIREMENT", "CONTROL"]),
    statement: text, critical: z.boolean(), evidence,
  })).min(1).max(200),
  conflicts: z.array(z.strictObject({
    id, question: text, sourceIds: z.array(id).min(1).max(20),
  })).max(100),
  openQuestions: z.array(z.strictObject({ id, question: text, owner: label })).max(100),
  // Answered company-context fields (design input). Optional so frozen revisions saved before it existed still load.
  companyContext: CompanyContextSchema.optional(),
});
const SaveSchema = z.strictObject({
  expectedVersion: z.number().int().min(0).max(2147483646), input: DiscoveryInputSchema,
});
export type DiscoveryInput = z.infer<typeof DiscoveryInputSchema>;
const variantSchema = z.string().regex(/^[A-Z][A-Z0-9_-]{0,39}$/);
const invalid = (field: string) => new AuthError("INVALID_DISCOVERY", 400, "Check discovery fields and source references", field);

export function validateDiscovery(value: unknown): DiscoveryInput {
  const parsed = DiscoveryInputSchema.safeParse(value);
  if (!parsed.success) throw invalid("input");
  const input = parsed.data;
  // Same cap as the HTTP boundary; repository calls must also be bounded.
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 256 * 1024) throw invalid("input");
  const unique = (values: string[], field: string) => {
    if (new Set(values).size !== values.length) throw invalid(field);
  };
  for (const key of ["sources", "asIsSteps", "requirements", "conflicts", "openQuestions"] as const) {
    unique(input[key].map(item => item.id), key);
  }
  const sources = new Map(input.sources.map(source => [source.id, source]));
  const steps = new Set(input.asIsSteps.map(step => step.id));
  const checkEvidence = (reference: z.infer<typeof evidence>, field: string) => {
    if (!sources.get(reference.sourceId)?.text.includes(reference.quote)) throw invalid(field);
  };
  input.asIsSteps.forEach((step, i) => {
    if (step.sequence !== i + 1) throw invalid(`asIsSteps.${i}.sequence`);
    checkEvidence(step.evidence, `asIsSteps.${i}.evidence`);
  });
  input.requirements.forEach((requirement, i) => {
    if (!steps.has(requirement.asIsStepId)) throw invalid(`requirements.${i}.asIsStepId`);
    checkEvidence(requirement.evidence, `requirements.${i}.evidence`);
  });
  unique((input.companyContext ?? []).map(item => item.fieldId), "companyContext");
  (input.companyContext ?? []).forEach((item, i) => checkEvidence(item.evidence, `companyContext.${i}.evidence`));
  input.conflicts.forEach((conflict, i) => {
    unique(conflict.sourceIds, `conflicts.${i}.sourceIds`);
    if (conflict.sourceIds.some(sourceId => !sources.has(sourceId))) throw invalid(`conflicts.${i}.sourceIds`);
  });
  return input;
}

type Snapshot = {
  id: string; variantCode: string; version: number; targetProduct: string;
  input: DiscoveryInput; sourceDigests: Record<string, string>; createdBy: string; createdAt: Date;
};
const columns = `id,variant_code AS "variantCode",version_no AS version,target_product AS "targetProduct",
  payload AS input,source_digests AS "sourceDigests",created_by AS "createdBy",created_at AS "createdAt"`;
const expose = (row: Snapshot) => ({ ...row, evidenceStatus: "USER_PROVIDED" as const, status: "DRAFT" as const });
const notFound = () => new AuthError("PROJECT_NOT_FOUND", 404, "Project not found");
type Access = { targetProduct: string; isDemo: boolean; projectRole: string };

async function access(client: PoolClient, user: SessionUser, projectId: string): Promise<Access> {
  if (!z.uuid().safeParse(projectId).success) throw notFound();
  const row = (await client.query<Access>(`SELECT p.target_product AS "targetProduct",p.is_demo AS "isDemo",
    m.project_role AS "projectRole" FROM projects p JOIN project_memberships m
    ON m.org_id=p.org_id AND m.project_id=p.id
    WHERE p.org_id=$1 AND p.id=$2 AND m.user_id=$3`, [user.orgId, projectId, user.id])).rows[0];
  if (!row) throw notFound();
  return row;
}
function checkVariant(code: string) {
  if (!variantSchema.safeParse(code).success) throw invalid("variantCode");
}

/** Capture only: source text is user-provided evidence, not independently
 * verified or approved. Generation must pin a returned snapshot ID/version. */
export function createDiscoveryRepository(pool: Pool, auth: AuthService) {
  return {
    list: (token: string | null, projectId: string) => withTenantSession(pool, auth, token, async ({ client, user }) => {
      await access(client, user, projectId);
      return (await client.query<{ variantCode: string; version: number; variantName: string }>(
        `SELECT DISTINCT ON (variant_code) variant_code AS "variantCode",version_no AS version,
        payload->>'variantName' AS "variantName" FROM discovery_versions
        WHERE org_id=$1 AND project_id=$2 ORDER BY variant_code,version_no DESC`, [user.orgId, projectId])).rows;
    }),
    get: (token: string | null, projectId: string, variantCode: string, version?: number) =>
      withTenantSession(pool, auth, token, async ({ client, user }) => {
        const project = await access(client, user, projectId);
        checkVariant(variantCode);
        if (version !== undefined && (!Number.isSafeInteger(version) || version < 1 || version > 2147483647)) throw invalid("version");
        const row = (await client.query<Snapshot>(`SELECT ${columns} FROM discovery_versions
          WHERE org_id=$1 AND project_id=$2 AND variant_code=$3 AND ($4::integer IS NULL OR version_no=$4)
          ORDER BY version_no DESC LIMIT 1`, [user.orgId, projectId, variantCode, version ?? null])).rows[0];
        return { snapshot: row ? expose(row) : null, canEdit: user.orgRole !== "GUEST" &&
          ["LEAD", "CONSULTANT"].includes(project.projectRole) && !project.isDemo };
      }),
    save: (token: string | null, projectId: string, variantCode: string, value: unknown, key: string | null) =>
      withTenantSession(pool, auth, token, async ({ client, user }) => {
        const project = await access(client, user, projectId);
        if (user.orgRole === "GUEST" || !["LEAD", "CONSULTANT"].includes(project.projectRole)) {
          throw new AuthError("FORBIDDEN", 403, "You cannot edit discovery inputs");
        }
        if (project.isDemo) throw new AuthError("DEMO_READ_ONLY", 403, "This example project is read-only");
        checkVariant(variantCode);
        if (!z.uuid().safeParse(key).success) throw new AuthError("INVALID_IDEMPOTENCY_KEY", 400, "Send a UUID Idempotency-Key header");
        const parsed = SaveSchema.safeParse(value);
        if (!parsed.success) throw invalid("input");
        const input = validateDiscovery(parsed.data.input);
        const requestHash = createHash("sha256").update(JSON.stringify({ expectedVersion: parsed.data.expectedVersion, input })).digest("hex");
        // One resource lock serializes initial creation, retries and competing edits.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`discovery:${user.orgId}:${projectId.toLowerCase()}:${variantCode}`]);
        const prior = (await client.query<Snapshot & { requestHash: string }>(`SELECT ${columns},request_hash AS "requestHash"
          FROM discovery_versions WHERE org_id=$1 AND project_id=$2 AND variant_code=$3 AND created_by=$4 AND request_key=$5`,
          [user.orgId, projectId, variantCode, user.id, key])).rows[0];
        if (prior) {
          if (prior.requestHash !== requestHash) throw new AuthError("IDEMPOTENCY_CONFLICT", 409, "This save key was already used for different inputs");
          const { requestHash: _hash, ...snapshot } = prior;
          void _hash;
          return expose(snapshot);
        }
        const latest = (await client.query<{ version: number }>(`SELECT version_no AS version FROM discovery_versions
          WHERE org_id=$1 AND project_id=$2 AND variant_code=$3 ORDER BY version_no DESC LIMIT 1`,
          [user.orgId, projectId, variantCode])).rows[0]?.version ?? 0;
        if (latest !== parsed.data.expectedVersion) throw new AuthError("DISCOVERY_CONFLICT", 409, "Discovery changed. Reload the latest revision before saving.");
        const sourceDigests = Object.fromEntries(input.sources.map(source =>
          [source.id, createHash("sha256").update(source.text, "utf8").digest("hex")]));
        const row = (await client.query<Snapshot>(`INSERT INTO discovery_versions
          (id,org_id,project_id,variant_code,version_no,target_product,payload,source_digests,request_key,request_hash,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${columns}`,
          [randomUUID(), user.orgId, projectId, variantCode, latest + 1, project.targetProduct, JSON.stringify(input),
            JSON.stringify(sourceDigests), key, requestHash, user.id])).rows[0]!;
        return expose(row);
      }),
  };
}
