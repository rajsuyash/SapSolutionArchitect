import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { AuthError, type AuthService } from "./auth";
import { withTenantSession } from "./tenant";
import { containsSensitiveText, revalidateStoredTurn, type Scope } from "./ai/discovery-interview";
import { applyWorkspaceCommand, backfillCatalog, buildInterviewInput, compileDiscovery, createWorkspace,
  getWorkspaceReadiness, recordInterviewTurn, settleChatTurn, WorkspaceCommandSchema, WorkspaceStateSchema,
  type WorkspaceState } from "./discovery-workspace-model";

const uuid = z.uuid();
const variant = z.string().regex(/^[A-Z][A-Z0-9_-]{0,39}$/);
const initial = z.strictObject({ variantName: z.string().trim().min(1).max(200),
  targetRelease: z.string().trim().min(1).max(200).nullable().default(null) });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const metadata = (actorId: string) => ({ actorId, at: new Date().toISOString(), id: randomUUID() });
const absent = () => new AuthError("WORKSPACE_NOT_FOUND", 404, "Discovery workspace not found");
const conflict = () => new AuthError("WORKSPACE_CONFLICT", 409, "Discovery changed. Reload the latest revision before saving.");
type Row = { id: string; revision: number; state: unknown; request_hash: string;
  confirmed_snapshot_id: string | null; created_at: Date };
type Access = { target_product: WorkspaceState["targetProduct"]; problem_statement: string;
  modules: string[]; org_units: { type: string; code: string; name: string }[];
  project_role: string; org_role: string; is_demo: boolean };
export type WorkspaceWorkerArgs = { orgId: string; projectId: string; variantCode: string; requestedBy: string };
/** `scope` "chat" or "extraction" persists one half of a turn onto the latest revision (the other half, or the user, may
 * have moved the workspace on since the job started); the default "full" still requires `expectedRevision` to be current. */
export type WorkspaceTurnArgs = WorkspaceWorkerArgs & { expectedRevision: number; currentMessageId: string;
  turn: unknown; requestKey: string; scope?: Scope };

function validIdentity(projectId: string, variantCode: string) {
  if (!uuid.safeParse(projectId).success || !variant.safeParse(variantCode).success) throw absent();
}
function validKey(key: string | null) {
  if (!uuid.safeParse(key).success) throw new AuthError("INVALID_IDEMPOTENCY_KEY", 400, "Send a UUID Idempotency-Key header");
}
function validRevision(value: number) {
  if (!Number.isInteger(value) || value < 0 || value >= 2147483647) {
    throw new AuthError("INVALID_REVISION", 400, "Send a valid expected revision");
  }
}
function readState(row: Row): WorkspaceState {
  const parsed = WorkspaceStateSchema.safeParse(row.state);
  if (!parsed.success || parsed.data.revision !== row.revision) throw new Error("Invalid persisted discovery workspace");
  return backfillCatalog(parsed.data);
}
async function lock(client: PoolClient, orgId: string, projectId: string, variantCode: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [`workspace:${orgId}:${projectId.toLowerCase()}:${variantCode}`]);
}
/** `lockRows` takes FOR SHARE row locks, so a concurrent membership/role revocation waits for this
 * transaction. PostgreSQL requires UPDATE privilege for that, which the tenant role must not have:
 * only the privileged worker connection may pass true. Tenant paths re-check authorization under the
 * workspace advisory lock instead; a revocation committing mid-request is ordered after that request. */
async function access(client: PoolClient, args: WorkspaceWorkerArgs, lockRows = false): Promise<Access> {
  validIdentity(args.projectId, args.variantCode);
  if (!uuid.safeParse(args.orgId).success || !uuid.safeParse(args.requestedBy).success) throw absent();
  const row = (await client.query<Access>(`SELECT p.target_product,p.problem_statement,p.modules,p.is_demo,
    COALESCE((SELECT json_agg(json_build_object('type',o.type,'code',o.code,'name',o.name) ORDER BY o.type,o.code)
      FROM org_units o WHERE o.org_id=p.org_id AND o.project_id=p.id),'[]'::json) AS org_units,
    m.project_role,u.org_role FROM projects p JOIN project_memberships m
    ON m.org_id=p.org_id AND m.project_id=p.id AND m.user_id=$3
    JOIN users u ON u.org_id=m.org_id AND u.id=m.user_id
    WHERE p.org_id=$1 AND p.id=$2${lockRows ? " FOR SHARE OF p,m,u" : ""}`, [args.orgId, args.projectId, args.requestedBy])).rows[0];
  if (!row) throw absent();
  return row;
}
function mayEdit(a: Access) { return !a.is_demo && a.org_role !== "GUEST" &&
  ["LEAD", "CONSULTANT", "PROCESS_OWNER"].includes(a.project_role); }
function mayConfirm(a: Access) { return mayEdit(a) && ["LEAD", "CONSULTANT"].includes(a.project_role); }
function requireEdit(a: Access) {
  if (a.is_demo) throw new AuthError("DEMO_READ_ONLY", 403, "This example project is read-only");
  if (!mayEdit(a)) throw new AuthError("FORBIDDEN", 403, "You cannot edit discovery inputs");
}
function requireConfirm(a: Access) {
  requireEdit(a);
  if (!mayConfirm(a)) throw new AuthError("FORBIDDEN", 403, "Only project leads and consultants can confirm discovery");
}
async function latest(client: PoolClient, args: WorkspaceWorkerArgs): Promise<Row | undefined> {
  return (await client.query<Row>(`SELECT id,revision,state,request_hash,confirmed_snapshot_id,created_at
    FROM discovery_workspace_revisions WHERE org_id=$1 AND project_id=$2 AND variant_code=$3
    ORDER BY revision DESC LIMIT 1`, [args.orgId, args.projectId, args.variantCode])).rows[0];
}
async function replay(client: PoolClient, args: WorkspaceWorkerArgs, key: string, hash: string): Promise<Row | undefined> {
  const prior = (await client.query<Row>(`SELECT id,revision,state,request_hash,confirmed_snapshot_id,created_at
    FROM discovery_workspace_revisions WHERE org_id=$1 AND project_id=$2 AND variant_code=$3
      AND created_by=$4 AND request_key=$5`,
    [args.orgId, args.projectId, args.variantCode, args.requestedBy, key])).rows[0];
  if (prior && prior.request_hash !== hash) throw new AuthError("IDEMPOTENCY_CONFLICT", 409, "This save key was already used for different inputs");
  return prior;
}
async function append(client: PoolClient, args: WorkspaceWorkerArgs, operation: "CREATE" | "COMMAND" | "TURN" | "CONFIRM",
  state: WorkspaceState, key: string, hash: string, snapshotId: string | null = null): Promise<Row> {
  return (await client.query<Row>(`INSERT INTO discovery_workspace_revisions
    (id,org_id,project_id,variant_code,revision,operation,state,request_key,request_hash,created_by,confirmed_snapshot_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id,revision,state,request_hash,confirmed_snapshot_id,created_at`,
    [randomUUID(), args.orgId, args.projectId, args.variantCode, state.revision, operation,
      JSON.stringify(state), key, hash, args.requestedBy, snapshotId])).rows[0]!;
}
function result(row: Row, a: Access) {
  const state = readState(row);
  return { id: row.id, state, confirmedSnapshotId: row.confirmed_snapshot_id,
    canEdit: mayEdit(a), canConfirm: mayConfirm(a), readiness: getWorkspaceReadiness(state) };
}

/** Trusted transaction helper for enqueue/commit. It locks the workspace and
 * re-reads authorization; its caller must own BEGIN/COMMIT and job fencing.
 * Pass `lockRows` only from the privileged worker connection (never under sap_pm_tenant). */
export async function loadWorkspaceForWorker(client: PoolClient, args: WorkspaceWorkerArgs, lockRows = false) {
  validIdentity(args.projectId, args.variantCode);
  await lock(client, args.orgId, args.projectId, args.variantCode);
  const a = await access(client, args, lockRows);
  const row = await latest(client, args);
  if (!row) throw absent();
  return result(row, a);
}

/** Called only inside the worker's transaction after it has fenced the job.
 * Model/network execution belongs outside this transaction. */
export async function persistWorkspaceTurn(client: PoolClient, args: WorkspaceTurnArgs) {
  const scope = args.scope ?? "full";
  validKey(args.requestKey);
  validRevision(args.expectedRevision);
  validIdentity(args.projectId, args.variantCode);
  await lock(client, args.orgId, args.projectId, args.variantCode);
  const a = await access(client, args, true); // worker-only: privileged connection
  requireEdit(a);
  const hash = digest(scope === "full" ? { expectedRevision: args.expectedRevision, currentMessageId: args.currentMessageId, turn: args.turn }
    : { scope, currentMessageId: args.currentMessageId, turn: args.turn });
  const prior = await replay(client, args, args.requestKey, hash);
  if (prior) return result(prior, a);
  const current = await latest(client, args);
  if (!current) throw absent();
  const state = readState(current);
  if (scope === "full" && state.revision !== args.expectedRevision) throw conflict();
  // An extraction that was already recorded (a retry, or the same message extracted twice) changes nothing.
  if (scope === "extraction" && state.extractedMessageIds?.includes(args.currentMessageId)) return result(current, a);
  const input = buildInterviewInput(state, args.currentMessageId);
  // A chat turn is stored after its message's extraction may have answered what it asked: closed gaps are not asked, and
  // are replaced so the stored turn still asks something while any gap is open (see settleChatTurn).
  const turn = scope === "chat" ? settleChatTurn(state, args.currentMessageId, args.turn) : args.turn;
  if (!revalidateStoredTurn(input, turn, scope).success) {
    throw new AuthError("INVALID_INTERVIEW_TURN", 400, "The interview response could not be validated");
  }
  const next = recordInterviewTurn(state, turn, args.currentMessageId, metadata(args.requestedBy), scope);
  return result(await append(client, args, "TURN", next, args.requestKey, hash,
    next.confirmation ? current.confirmed_snapshot_id : null), a);
}

/** Session-facing entry points accept only a session token and resource IDs.
 * Project identity, roles, timestamps and generated IDs come from the server. */
/** Bounds per-project spend and storage from variant creation. */
const MAX_VARIANTS_PER_PROJECT = 20;
export function createDiscoveryWorkspaceRepository(pool: Pool, auth: AuthService) {
  return {
    list: (token: string | null, projectId: string) => withTenantSession(pool, auth, token, async ({ client, user }) => {
      if (!uuid.safeParse(projectId).success) throw absent();
      const member = (await client.query(`SELECT 1 FROM project_memberships WHERE org_id=$1 AND project_id=$2 AND user_id=$3`,
        [user.orgId, projectId, user.id])).rowCount;
      if (!member) throw absent();
      return (await client.query<{ variantCode: string; revision: number; variantName: string; confirmedSnapshotId: string | null }>(
        `SELECT DISTINCT ON (variant_code) variant_code AS "variantCode",revision,
          state->>'variantName' AS "variantName",confirmed_snapshot_id AS "confirmedSnapshotId"
          FROM discovery_workspace_revisions WHERE org_id=$1 AND project_id=$2
          ORDER BY variant_code,revision DESC`, [user.orgId, projectId])).rows;
    }),
    get: (token: string | null, projectId: string, variantCode: string) =>
      withTenantSession(pool, auth, token, async ({ client, user }) => {
        const args = { orgId: user.orgId, projectId, variantCode, requestedBy: user.id };
        const a = await access(client, args);
        const row = await latest(client, args);
        return row ? result(row, a) : { state: null, canEdit: mayEdit(a), canConfirm: mayConfirm(a),
          confirmedSnapshotId: null, readiness: null };
      }),
    create: (token: string | null, projectId: string, variantCode: string, value: unknown, key: string | null) =>
      withTenantSession(pool, auth, token, async ({ client, user }) => {
        validKey(key);
        const args = { orgId: user.orgId, projectId, variantCode, requestedBy: user.id };
        validIdentity(projectId, variantCode);
        await lock(client, user.orgId, projectId, variantCode);
        const a = await access(client, args);
        requireEdit(a);
        const parsed = initial.safeParse(value);
        if (!parsed.success) throw new AuthError("INVALID_WORKSPACE", 400, "Check the process variant details");
        const hash = digest({ value: parsed.data });
        const prior = await replay(client, args, key!, hash);
        if (prior) return result(prior, a);
        if (await latest(client, args)) throw conflict();
        const variants = (await client.query<{ n: number }>(`SELECT count(DISTINCT variant_code)::int AS n
          FROM discovery_workspace_revisions WHERE org_id=$1 AND project_id=$2`, [user.orgId, projectId])).rows[0]!.n;
        if (variants >= MAX_VARIANTS_PER_PROJECT) {
          throw new AuthError("VARIANT_LIMIT", 409, `A project can have at most ${MAX_VARIANTS_PER_PROJECT} process variants.`);
        }
        const state = createWorkspace({ variantCode, ...parsed.data, targetProduct: a.target_product,
          problemStatement: a.problem_statement, modules: a.modules, orgUnits: a.org_units }, metadata(user.id));
        return result(await append(client, args, "CREATE", state, key!, hash), a);
      }),
    command: (token: string | null, projectId: string, variantCode: string, expectedRevision: number,
      key: string | null, rawCommand: unknown) => withTenantSession(pool, auth, token, async ({ client, user }) => {
        validKey(key);
        validRevision(expectedRevision);
        const args = { orgId: user.orgId, projectId, variantCode, requestedBy: user.id };
        validIdentity(projectId, variantCode);
        await lock(client, user.orgId, projectId, variantCode);
        const a = await access(client, args);
        requireEdit(a);
        const parsed = WorkspaceCommandSchema.safeParse(rawCommand);
        if (!parsed.success) throw new AuthError("INVALID_WORKSPACE_COMMAND", 400, "Check the discovery edit");
        if (parsed.data.type === "CONFIRM") requireConfirm(a);
        if (parsed.data.type === "SEND_MESSAGE" && containsSensitiveText(parsed.data.text)) {
          throw new AuthError("SENSITIVE_MESSAGE", 400, "Remove emails, passwords or tokens before sending", "text");
        }
        const hash = digest({ expectedRevision, command: parsed.data });
        const prior = await replay(client, args, key!, hash);
        if (prior) return result(prior, a);
        const current = await latest(client, args);
        if (!current) throw absent();
        const state = readState(current);
        if (state.revision !== expectedRevision) throw conflict();
        let next: WorkspaceState;
        try { next = applyWorkspaceCommand(state, parsed.data, metadata(user.id)); }
        catch (error) {
          if (error instanceof Error && error.message === "WORKSPACE_NOT_READY") {
            throw new AuthError("WORKSPACE_NOT_READY", 409, "Resolve the discovery gaps before confirmation");
          }
          if (error instanceof Error && /^[A-Z_]+$/.test(error.message)) {
            throw new AuthError(error.message, 400, "Check the discovery edit");
          }
          throw error;
        }
        if (parsed.data.type !== "CONFIRM") return result(await append(client, args, "COMMAND", next, key!, hash,
          next.confirmation ? current.confirmed_snapshot_id : null), a);
        const input = compileDiscovery(next);
        // Coordinate with the separate manual capture path before assigning a
        // discovery version. The workspace lock remains held until commit.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`discovery:${user.orgId}:${projectId.toLowerCase()}:${variantCode}`]);
        const version = (await client.query<{ version: number }>(`SELECT version_no AS version FROM discovery_versions
          WHERE org_id=$1 AND project_id=$2 AND variant_code=$3 ORDER BY version_no DESC LIMIT 1`,
          [user.orgId, projectId, variantCode])).rows[0]?.version ?? 0;
        const snapshotId = randomUUID();
        const sourceDigests = Object.fromEntries(input.sources.map(source =>
          [source.id, createHash("sha256").update(source.text, "utf8").digest("hex")]));
        await client.query(`INSERT INTO discovery_versions
          (id,org_id,project_id,variant_code,version_no,target_product,payload,source_digests,request_key,request_hash,created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [snapshotId, user.orgId, projectId, variantCode,
          version + 1, a.target_product, JSON.stringify(input), JSON.stringify(sourceDigests), randomUUID(), digest(input), user.id]);
        return result(await append(client, args, "CONFIRM", next, key!, hash, snapshotId), a);
      }),
  };
}
