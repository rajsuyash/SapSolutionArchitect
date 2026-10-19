import type { Pool, PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AuthError, transaction, type AuthService, type SessionUser } from "./auth";

/** Internal repository boundary. Callers supply an opaque session, never org IDs.
 * The callback is trusted server code, not user-supplied SQL or a route handler.
 * Identity resolves before privilege reduction, on the same locked transaction.
 */
export function withTenantSession<T>(pool: Pool, auth: AuthService, token: string | null,
  work: (context: { client: PoolClient; user: SessionUser }) => Promise<T>): Promise<T> {
  return transaction(pool, async (client) => {
    const user = await auth.resolveSession(client, token);
    if (!user) throw new AuthError("UNAUTHENTICATED", 401, "Sign in to continue");
    await client.query("SET LOCAL ROLE sap_pm_tenant");
    const role = (await client.query<{ safe: boolean }>(`SELECT NOT (rolsuper OR rolbypassrls OR
      rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit OR rolcanlogin) AS safe
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (!role?.safe) throw new Error("Unsafe tenant database role");
    await client.query("SELECT set_config('app.org_id',$1,true),set_config('app.user_id',$2,true),set_config('app.org_role',$3,true)",
      [user.orgId, user.id, user.orgRole]);
    return work({ client, user });
  });
}

type Project = { id: string; name: string; clientName: string; setupStatus: string };
const visibility = `p.org_id=$1 AND ($2<>'GUEST' OR EXISTS (
  SELECT 1 FROM project_memberships m WHERE m.org_id=p.org_id AND m.project_id=p.id AND m.user_id=$3))`;
const columns = 'p.id,p.name,p.client_name AS "clientName",p.setup_status AS "setupStatus"';
const projectInput = z.object({
  name: z.string().trim().min(1).max(160), clientName: z.string().trim().min(1).max(160),
  problemStatement: z.string().trim().min(50).max(20000),
  targetProduct: z.enum(["S4HANA_CLOUD_PUBLIC", "S4HANA_CLOUD_PRIVATE", "S4HANA_ON_PREMISE"]),
  startingLandscape: z.enum(["NON_SAP", "EXISTING_SAP", "MIXED"]).default("MIXED"),
  modules: z.array(z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_-]{0,19}$/)).max(32).default([]),
  orgUnits: z.array(z.object({ type: z.enum(["COMPANY_CODE", "PLANT", "SALES_ORG", "REGION"]),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,40}$/), name: z.string().trim().min(1).max(160),
  })).max(50).default([]),
});

export function validateProject(input: unknown) {
  const parsed = projectInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = issue.path.join(".");
    const short = field === "problemStatement" && issue.code === "too_small";
    throw new AuthError(short ? "FIELD_TOO_SHORT" : "INVALID_FIELD", 400,
      short ? "Describe the problem in at least 50 characters" : "Check this field", field);
  }
  const value = parsed.data;
  const units = new Set<string>();
  value.orgUnits.forEach((unit, index) => {
    const key = `${unit.type}:${unit.code}`;
    if (units.has(key)) throw new AuthError("INVALID_FIELD", 400, "This unit type and code already exist", `orgUnits.${index}.code`);
    units.add(key);
  });
  value.modules = [...new Set(value.modules)].sort();
  value.orgUnits.sort((a, b) => `${a.type}:${a.code}`.localeCompare(`${b.type}:${b.code}`));
  return value;
}

/** Both the explicit org filter and PostgreSQL RLS apply. Guest membership is an
 * additional authorization check; organization role alone is never sufficient.
 */
export function createProjectRepository(pool: Pool, auth: AuthService) {
  return {
    create: (token: string | null, input: unknown, key: string | null) => withTenantSession(pool, auth, token, async ({ client, user }) => {
      if (user.orgRole === "GUEST") throw new AuthError("FORBIDDEN", 403, "You cannot create projects");
      if (!z.uuid().safeParse(key).success) throw new AuthError("INVALID_IDEMPOTENCY_KEY", 400, "Send a UUID Idempotency-Key header");
      const value = validateProject(input);
      const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      // Serialize same-key requests across processes before checking or inserting.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`project-create:${user.orgId}:${user.id}:${key!.toLowerCase()}`]);
      const existing = (await client.query<{ request_hash: string; project_id: string }>(
        "SELECT request_hash,project_id FROM project_creation_requests WHERE org_id=$1 AND user_id=$2 AND request_key=$3",
        [user.orgId, user.id, key])).rows[0];
      if (existing) {
        if (existing.request_hash !== hash) throw new AuthError("IDEMPOTENCY_CONFLICT", 409, "This request was already used for different project details");
        return (await client.query<Project>(`SELECT ${columns} FROM projects p WHERE p.org_id=$1 AND p.id=$2`,
          [user.orgId, existing.project_id])).rows[0]!;
      }
      const id = randomUUID();
      await client.query(`INSERT INTO projects(id,org_id,name,client_name,problem_statement,target_product,starting_landscape,
        modules,setup_status,is_demo,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',false,$9)`,
        [id, user.orgId, value.name, value.clientName, value.problemStatement, value.targetProduct, value.startingLandscape, value.modules, user.id]);
      await client.query("INSERT INTO project_memberships(org_id,project_id,user_id,project_role) VALUES($1,$2,$3,'LEAD')", [user.orgId, id, user.id]);
      for (const unit of value.orgUnits) await client.query("INSERT INTO org_units(id,org_id,project_id,type,code,name) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), user.orgId, id, unit.type, unit.code, unit.name]);
      await client.query("INSERT INTO project_creation_requests(org_id,user_id,request_key,request_hash,project_id) VALUES($1,$2,$3,$4,$5)",
        [user.orgId, user.id, key, hash, id]);
      return { id, name: value.name, clientName: value.clientName, setupStatus: "DRAFT" } satisfies Project;
    }),
    list: (token: string | null) => withTenantSession(pool, auth, token, async ({ client, user }) => {
      const { rows } = await client.query<Project>(`SELECT ${columns} FROM projects p WHERE ${visibility} ORDER BY p.created_at,p.id`,
        [user.orgId, user.orgRole, user.id]);
      return rows;
    }),
    get: (token: string | null, id: string) => withTenantSession(pool, auth, token, async ({ client, user }) => {
      const notFound = () => new AuthError("PROJECT_NOT_FOUND", 404, "Project not found");
      if (!z.uuid().safeParse(id).success) throw notFound();
      const { rows } = await client.query<Project & { problemStatement: string; targetProduct: string; startingLandscape: string; modules: string[] }>(
        `SELECT ${columns},p.problem_statement AS "problemStatement",p.target_product AS "targetProduct",
        p.starting_landscape AS "startingLandscape",p.modules FROM projects p WHERE ${visibility} AND p.id=$4`,
        [user.orgId, user.orgRole, user.id, id]);
      if (!rows[0]) throw notFound();
      const units = await client.query<{ type: string; code: string; name: string }>(
        "SELECT type,code,name FROM org_units WHERE org_id=$1 AND project_id=$2 ORDER BY type,code", [user.orgId, id]);
      return { ...rows[0], orgUnits: units.rows };
    }),
  };
}
