import { CONTEXT_FIELD_IDS } from "./support/context-fields";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import bcrypt from "bcryptjs";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthService, transaction } from "../src/lib/auth";
import { createProjectRepository } from "../src/lib/tenant";
import { createDiscoveryWorkspaceRepository, loadWorkspaceForWorker, persistWorkspaceTurn } from "../src/lib/discovery-workspace";

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("durable discovery workspace", () => {
  const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
  const database = `sap_workspace_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(local.DATABASE_URL!);
  const admin = new Client({ connectionString: url.href });
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 8, statement_timeout: 10000 });
  const auth = createAuthService(pool, { secret: "synthetic-workspace-secret-for-tests-only-123", appUrl: "http://127.0.0.1:3017" });
  const projects = createProjectRepository(pool, auth);
  const workspaces = createDiscoveryWorkspaceRepository(pool, auth);
  let created = false;
  const projectInput = { name: "Hire returns", clientName: "Synthetic client",
    problemStatement: "Manual recording of equipment returns causes delayed updates and disputed invoices for fictional customers.",
    targetProduct: "S4HANA_CLOUD_PRIVATE" as const };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    await promisify(execFile)("pnpm", ["db:seed"], { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });
  }, 40000);
  afterAll(async () => {
    await pool.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); }
    finally { await admin.end(); }
  }, 15000);
  async function fixture() {
    const owner = await auth.signup({ name: "Synthetic lead", email: `workspace-${randomUUID()}@test.local`,
      password: "Password123!", orgName: "Synthetic workspace" });
    const project = await projects.create(owner.token, projectInput, randomUUID());
    return { owner, project };
  }
  async function member(orgId: string, projectId: string, role: string, orgRole = "MEMBER") {
    const id = randomUUID();
    const email = `member-${id}@test.local`;
    await pool.query(`INSERT INTO users(id,org_id,email,name,org_role,password_hash)
      VALUES($1,$2,$3,'Synthetic member',$4,$5)`, [id, orgId, email, orgRole, await bcrypt.hash("Password123!", 12)]);
    await pool.query(`INSERT INTO project_memberships(org_id,project_id,user_id,project_role) VALUES($1,$2,$3,$4)`,
      [orgId, projectId, id, role]);
    return { id, token: (await auth.login({ email, password: "Password123!" })).token };
  }

  it("stores immutable revisions, resolves replay before CAS, and fences competing edits", async () => {
    const { owner, project } = await fixture();
    const key = randomUUID();
    const first = await workspaces.create(owner.token, project.id, "RENTAL", { variantName: "Equipment hire" }, key);
    expect(first.state.revision).toBe(1);
    expect(first.state.problemStatement).toBe(projectInput.problemStatement);
    expect(first.state.targetProduct).toBe(projectInput.targetProduct);
    expect((await workspaces.create(owner.token, project.id, "RENTAL", { variantName: "Equipment hire" }, key)).id).toBe(first.id);
    await expect(workspaces.create(owner.token, project.id, "RENTAL", { variantName: "Different" }, key))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const command = { type: "SEND_MESSAGE", text: "A clerk records returns on paper." };
    const saveKey = randomUUID();
    const edits = await Promise.all([workspaces.command(owner.token, project.id, "RENTAL", 1, saveKey, command),
      workspaces.command(owner.token, project.id, "RENTAL", 1, saveKey, command)]);
    expect(edits[0]!.id).toBe(edits[1]!.id);
    expect(edits[0]!.state.revision).toBe(2);
    await expect(workspaces.command(owner.token, project.id, "RENTAL", 1, randomUUID(), command))
      .rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" });
    expect((await pool.query("SELECT revision FROM discovery_workspace_revisions WHERE project_id=$1 ORDER BY revision",
      [project.id])).rows).toEqual([{ revision: 1 }, { revision: 2 }]);
    await expect(pool.query("UPDATE discovery_workspace_revisions SET state='{}' WHERE id=$1", [first.id]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("DELETE FROM discovery_workspace_revisions WHERE id=$1", [first.id]))
      .rejects.toMatchObject({ code: "55000" });
  });

  it("allows member process-owner input but limits confirmation; guests and other tenants cannot edit", async () => {
    const { owner, project } = await fixture();
    await workspaces.create(owner.token, project.id, "RETURNS", { variantName: "Returns" }, randomUUID());
    const processOwner = await member(owner.user.orgId, project.id, "PROCESS_OWNER");
    const read = await workspaces.get(processOwner.token, project.id, "RETURNS");
    expect(read).toMatchObject({ canEdit: true, canConfirm: false });
    const edited = await workspaces.command(processOwner.token, project.id, "RETURNS", 1, randomUUID(),
      { type: "SEND_MESSAGE", text: "Returns are entered by the stores clerk." });
    expect(edited.state.revision).toBe(2);
    await expect(workspaces.command(processOwner.token, project.id, "RETURNS", 2, randomUUID(), { type: "CONFIRM" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const guest = await member(owner.user.orgId, project.id, "PROCESS_OWNER", "GUEST");
    expect((await workspaces.get(guest.token, project.id, "RETURNS")).canEdit).toBe(false);
    await expect(workspaces.command(guest.token, project.id, "RETURNS", 2, randomUUID(),
      { type: "SEND_MESSAGE", text: "Guest edit" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const outsider = await fixture();
    await expect(workspaces.get(outsider.owner.token, project.id, "RETURNS"))
      .rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    await pool.query("UPDATE projects SET is_demo=true WHERE id=$1", [project.id]);
    await expect(workspaces.command(owner.token, project.id, "RETURNS", 2, randomUUID(),
      { type: "SEND_MESSAGE", text: "Demo edit" })).rejects.toMatchObject({ code: "DEMO_READ_ONLY" });
  });

  it("validates a worker turn against the persisted message and fences stale results", async () => {
    const { owner, project } = await fixture();
    await workspaces.create(owner.token, project.id, "HIRE", { variantName: "Hire" }, randomUUID());
    const message = await workspaces.command(owner.token, project.id, "HIRE", 1, randomUUID(),
      { type: "SEND_MESSAGE", text: "The stores clerk records the return in a spreadsheet." });
    const messageId = message.state.messages[0]!.id;
    const args = { orgId: owner.user.orgId, projectId: project.id, variantCode: "HIRE",
      requestedBy: owner.user.id, expectedRevision: 2, currentMessageId: messageId, requestKey: randomUUID() };
    const turn = { schemaVersion: 1, contextRevision: 2, reply: "Thank you for that context.",
      questions: [{ gapKey: "g_process_owner", question: "Who owns this process day to day?", whyItMatters: "They confirm the rules." }],
      proposedUpdates: [{ fieldId: "current_systems", operation: "PROPOSE_SET", previousValue: null,
        value: "in a spreadsheet", sourceId: messageId, quote: "in a spreadsheet" }], observations: [] };
    const saved = await transaction(pool, client => persistWorkspaceTurn(client, { ...args, turn }));
    expect(saved.state.proposals).toMatchObject([{ status: "PENDING", fieldId: "current_systems" }]);
    expect((await transaction(pool, client => persistWorkspaceTurn(client, { ...args, turn }))).id).toBe(saved.id);
    await expect(transaction(pool, client => persistWorkspaceTurn(client, { ...args, requestKey: randomUUID(), turn })))
      .rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" });
    const loaded = await transaction(pool, client => loadWorkspaceForWorker(client, args));
    expect(loaded.state.revision).toBe(3);
    expect(loaded.canConfirm).toBe(true);
  });

  it("loads a workspace saved before the company-context fields existed and backfills them EMPTY", async () => {
    const { owner, project } = await fixture();
    const created = await workspaces.create(owner.token, project.id, "OLD", { variantName: "Old" }, randomUUID());
    const original = ["business_problem", "process_owner", "scope_boundary", "current_trigger", "current_systems", "current_rules",
      "current_exceptions", "current_financial", "desired_outcome", "desired_controls"];
    // Rewrite the stored JSON the way an older build saved it. Revisions are immutable, so this test-only edit lifts the guard trigger.
    const client = await pool.connect();
    let done;
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE discovery_workspace_revisions DISABLE TRIGGER USER");
      done = await client.query(`UPDATE discovery_workspace_revisions SET state=jsonb_set(state,'{facts}',
        (SELECT jsonb_agg(f) FROM jsonb_array_elements(state->'facts') f WHERE f->>'id' = ANY($1))) WHERE id=$2`, [original, created.id]);
      await client.query("ALTER TABLE discovery_workspace_revisions ENABLE TRIGGER USER");
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    expect(done.rowCount).toBe(1);
    const loaded = await workspaces.get(owner.token, project.id, "OLD");
    expect(loaded.state!.facts).toHaveLength(original.length + CONTEXT_FIELD_IDS.length);
    expect(loaded.state!.facts.find(f => f.id === "operating_scale")).toMatchObject({ status: "EMPTY", value: null });
    expect(loaded.readiness!.blockers.map(b => b.detail)).toContain("Operating scale and volumes");
    const next = await workspaces.command(owner.token, project.id, "OLD", loaded.state!.revision, randomUUID(),
      { type: "SET_FIELD", fieldId: "kpi_targets", status: "KNOWN", value: "OTIF above 90%", rationale: null, owner: null, sourceId: null, quote: null });
    expect(next.state.facts.find(f => f.id === "kpi_targets")?.status).toBe("KNOWN");
    expect(next.state.facts).toHaveLength(original.length + CONTEXT_FIELD_IDS.length);
  });

  it("atomically confirms a compiled discovery snapshot and pins its exact revision", async () => {
    const { owner, project } = await fixture();
    let current = await workspaces.create(owner.token, project.id, "BILLING", { variantName: "Billing" }, randomUUID());
    const set = async (fieldId: string, value: string) => {
      current = await workspaces.command(owner.token, project.id, "BILLING", current.state.revision, randomUUID(),
        { type: "SET_FIELD", fieldId, status: "KNOWN", value, rationale: null, owner: null, sourceId: null, quote: null });
    };
    await set("process_owner", "Stores lead");
    await set("scope_boundary", "From asset return to final invoice");
    await set("current_trigger", "Asset physically returned");
    await set("desired_outcome", "Accurate final invoices");
    for (const [fieldId, value] of [
      ["current_systems", "Spreadsheet and paper return note"],
      ["current_rules", "Stores records the date before billing review"],
      ["current_exceptions", "Missing return date is escalated to the stores lead"],
      ["current_financial", "Billing adjusts the final invoice after return"],
      ["desired_controls", "Require a dated return record for audit"],
    ]) await set(fieldId!, value!);
    for (const fieldId of CONTEXT_FIELD_IDS) await set(fieldId, `Synthetic answer for ${fieldId}`);
    current = await workspaces.command(owner.token, project.id, "BILLING", current.state.revision, randomUUID(),
      { type: "ADD_STEP", step: { name: "Record return", actor: "Stores clerk", system: "Spreadsheet",
        trigger: "Asset physically returned", description: "Record the return date in the spreadsheet.",
        inputs: ["Return note"], outputs: ["Return record"], controls: [], exceptions: [] } });
    current = await workspaces.command(owner.token, project.id, "BILLING", current.state.revision, randomUUID(),
      { type: "ADD_REQUIREMENT", requirement: { asIsStepId: current.state.steps[0]!.id,
        kind: "TO_BE_REQUIREMENT", statement: "Require a return date before invoicing.", critical: true } });
    expect(current.readiness.ready).toBe(true);
    const key = randomUUID();
    const confirmed = await workspaces.command(owner.token, project.id, "BILLING", current.state.revision, key, { type: "CONFIRM" });
    expect(confirmed.state.confirmation).toMatchObject({ revision: confirmed.state.revision, by: owner.user.id });
    expect(confirmed.confirmedSnapshotId).toBeTruthy();
    const snapshot = (await pool.query("SELECT payload,version_no FROM discovery_versions WHERE id=$1",
      [confirmed.confirmedSnapshotId])).rows[0];
    expect(snapshot.version_no).toBe(1);
    expect(snapshot.payload.asIsSteps[0].evidence.quote).toBe("Record the return date in the spreadsheet.");
    expect((await workspaces.command(owner.token, project.id, "BILLING", current.state.revision, key,
      { type: "CONFIRM" })).confirmedSnapshotId).toBe(confirmed.confirmedSnapshotId);
    expect((await pool.query("SELECT count(*)::int AS count FROM discovery_versions WHERE project_id=$1", [project.id])).rows[0].count).toBe(1);
  });

  it("caps process variants per project", async () => {
    const { owner, project } = await fixture();
    for (let n = 1; n <= 20; n++) await workspaces.create(owner.token, project.id, `V${n}`, { variantName: `Variant ${n}` }, randomUUID());
    await expect(workspaces.create(owner.token, project.id, "V21", { variantName: "Variant 21" }, randomUUID()))
      .rejects.toMatchObject({ code: "VARIANT_LIMIT", status: 409 });
  }, 60000);

  it("refuses a message that fails the sensitive-data screen before saving it, so later turns are not wedged", async () => {
    const { owner, project } = await fixture();
    const created = await workspaces.create(owner.token, project.id, "SAFE", { variantName: "Safe" }, randomUUID());
    await expect(workspaces.command(owner.token, project.id, "SAFE", created.state.revision, randomUUID(),
      { type: "SEND_MESSAGE", text: "Write to jane@example.com with password: hunter2" }))
      .rejects.toMatchObject({ code: "SENSITIVE_MESSAGE", status: 400, message: "Remove emails, passwords or tokens before sending" });
    const after = await workspaces.get(owner.token, project.id, "SAFE");
    expect(after.state?.revision).toBe(created.state.revision);
    expect(after.state?.messages).toHaveLength(0);
  });
});
