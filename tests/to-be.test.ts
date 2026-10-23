import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, promisify } from "node:util";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuthService } from "../src/lib/auth";
import { createProjectRepository } from "../src/lib/tenant";
import { createDiscoveryRepository } from "../src/lib/discovery";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { createToBeGenerator, parseToBeInput, toBeContext, validateToBeOutput, type ToBeInput } from "../src/lib/ai/to-be";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV2 } from "../fixtures/ai/to-be/rental-registers";
import { asStream } from "./support/sse";
import { fixture } from "./support/to-be-input";
import { routeLegacyReply } from "./support/to-be-split";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const settings = (overrides = {}) => parseEnvironment({ ...local, NODE_ENV: "test",
  AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-to-be-key", ...overrides });
type Body = { model: string; system: string; messages: { content: string }[];
  tools: { name: string; input_schema: unknown }[]; tool_choice: unknown };
function response(output: unknown = rentalDraft, stop = "tool_use", name = "submit_to_be") {
  return new Response(JSON.stringify({ id: "msg_synthetic", type: "message", role: "assistant", model: "synthetic",
    content: [{ type: "tool_use", id: "tool_synthetic", name, input: output }], stop_reason: stop,
    usage: { input_tokens: 100, output_tokens: 200 } }), { headers: { "content-type": "application/json" } });
}
/** `reply` still answers with a whole design (as the one-shot protocol did); routeLegacyReply turns it into the outline or step payload the
 * pipeline asked for, so each test keeps expressing "the model produced this design". `attempt` counts every generation request. */
function harness(reply: (attempt: number) => Response | Promise<Response> = () => response(), count: (attempt: number) => number = () => 1000, sapCatalogDir?: string, overrides = {}) {
  // The four register calls are answered with valid fixture registers and kept out of `sent`/`counted`, which describe the outline and step protocol.
  const sent: Body[] = [], counted: Body[] = [], registerCalls: Body[] = [];
  const isRegister = (body: Body) => body.tools[0]!.name.startsWith("submit_to_be_registers_");
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    const body = JSON.parse(String(init?.body)) as Body;
    if (String(url).includes("count_tokens")) {
      if (isRegister(body)) return new Response(JSON.stringify({ input_tokens: 1000 }), { headers: { "content-type": "application/json" } });
      counted.push(body);
      return new Response(JSON.stringify({ input_tokens: count(counted.length) }), { headers: { "content-type": "application/json" } });
    }
    if (isRegister(body)) { registerCalls.push(body); return asStream(routeLegacyReply(response(), body)); }
    sent.push(body); return asStream(routeLegacyReply(reply(sent.length), body));
  });
  const runner = createStageRunner(settings(overrides), { fetch, sapCatalogDir });
  return { sent, counted, registerCalls, fetch, generate: (input: unknown, signal?: AbortSignal) => runner("to_be", input, signal) };
}

describe("detailed generation protocol", () => {
  it("preserves complete discovery, counts system/schema, and retains unresolved input questions", async () => {
    const h = harness();
    const input = fixture();
    const result = await h.generate(input);
    expect(JSON.parse(h.sent[0]!.messages[0]!.content).input).toEqual(input);
    expect(h.counted[0]).toEqual(expect.objectContaining({
      system: h.sent[0]!.system, messages: h.sent[0]!.messages, tools: h.sent[0]!.tools, tool_choice: h.sent[0]!.tool_choice,
    }));
    expect(h.sent[0]!.tools[0]!.name).toBe("submit_to_be_outline");
    expect(h.sent.slice(1).map(body => body.tools[0]!.name)).toEqual(["submit_to_be_step", "submit_to_be_step", "submit_to_be_step"]);
    expect(h.sent[0]!.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(result.payload.design).toEqual(rentalDraftV2);
    expect(result.payload.unresolvedInputQuestions).toEqual(input.discovery.openQuestions);
    expect(result.payload.evaluation).toMatchObject({ structurallyValid: true, reviewStatus: "BLOCKED",
      blockers: expect.arrayContaining([{ code: "INPUT_QUESTION_UNRESOLVED", path: "input.openQuestions.0" }]) });
    // One outline call plus one call per step (3), each reported as 100 in / 200 out.
    expect(result.metrics.substages).toMatchObject({ to_be_registers: { calls: 4 } });
    expect(h.registerCalls.map(body => body.tools[0]!.name).sort()).toEqual(["decisions", "fitgap", "foundation", "integration"].map(group => `submit_to_be_registers_${group}`));
    expect(result.metrics).toMatchObject({ stage: "to_be", attempts: 8, inputTokens: 800, outputTokens: 1600 });
  });
  it("repairs incomplete coverage once without echoing model prose", async () => {
    const wrong = structuredClone(rentalDraft); wrong.coverage.pop(); wrong.processName = "private-invalid-model-output";
    const h = harness(attempt => response(attempt === 1 ? wrong : rentalDraft));
    const result = await h.generate(fixture());
    // The outline is repaired once (2 calls), then 3 step calls.
    expect(h.sent).toHaveLength(5); expect(h.counted).toHaveLength(5);
    expect(h.sent[1]!.messages[0]!.content).toContain("REQUIREMENT_UNDISPOSITIONED");
    expect(h.sent[1]!.messages[0]!.content).not.toContain("private-invalid-model-output");
    expect(result.metrics).toMatchObject({ attempts: 9, inputTokens: 900, outputTokens: 1800 });
  });
  it.each(["invented approval", "unverified SAP", "truncated", "wrong tool", "no tool"])("rejects %s after bounded repair", async kind => {
    const wrong = structuredClone(rentalDraft);
    if (kind === "invented approval") wrong.conflictDecisions[0]!.decisionId = "FAKE-APPROVAL";
    if (kind === "unverified SAP") wrong.steps[0]!.implementation = { kind: "STANDARD", detail: "Claimed standard", referenceIds: [] };
    const h = harness(() => response(wrong, kind === "truncated" ? "max_tokens" : kind === "no tool" ? "end_turn" : "tool_use",
      kind === "wrong tool" ? "other_tool" : "submit_to_be"));
    await expect(h.generate(fixture())).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 3 } });
    expect(h.sent).toHaveLength(3); // first answer plus two outline repairs
  });
  it.each([1, 2])("rejects oversized complete request on attempt %i without truncation", async overflowAt => {
    const h = harness(() => response({}), attempt => attempt === overflowAt ? 60001 : 1000);
    await expect(h.generate(fixture())).rejects.toMatchObject({ code: "AI_INPUT_TOO_LARGE" });
    expect(h.sent).toHaveLength(overflowAt - 1);
    expect(JSON.parse(h.counted[0]!.messages[0]!.content).input).toEqual(fixture());
  });
  it.each(["secret", "email", "quote", "trusted fields"])("rejects invalid %s input before provider I/O", async kind => {
    const input = fixture(); const h = harness();
    if (kind === "secret") input.discovery.sources[0]!.text += " api_key=synthetic-private-secret";
    if (kind === "email") input.discovery.sources[0]!.text += " private@example.invalid";
    if (kind === "quote") input.discovery.requirements[0]!.evidence.quote = "not in source";
    await expect(h.generate(kind === "trusted fields" ? { ...input, approvedDecisions: [] } : input))
      .rejects.toMatchObject({ code: "AI_INPUT_INVALID" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("does not pass off a static stub as a generated design", async () => {
    const run = createStageRunner(settings({ AI_PROVIDER: "stub" }));
    await expect(run("to_be", fixture())).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR", metrics: { attempts: 0 } });
  });
  it("cancels before any provider request", async () => {
    const h = harness();
    await expect(h.generate(fixture(), AbortSignal.abort())).rejects.toMatchObject({ code: "AI_CANCELLED" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("allows a detailed response past two minutes without changing the problem-analysis timeout", async () => {
    vi.useFakeTimers();
    try {
      // Every call takes 150 s: the outline, then the three parallel step calls. The stage budget is raised to fit both.
      const h = harness(() => new Promise(resolve => setTimeout(() => resolve(response()), 150000)), () => 1000, undefined, { AI_STAGE_BUDGET_SECONDS: "600" });
      let settled = false;
      const pending = h.generate(fixture()).finally(() => { settled = true; });
      await vi.waitFor(() => expect(h.sent).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(120000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(30000);
      await vi.waitFor(() => expect(h.sent).toHaveLength(4));
      await vi.advanceTimersByTimeAsync(150000);
      expect((await pending).payload.design).toEqual(rentalDraftV2);
    } finally { vi.useRealTimers(); }
  });
  it.each(["call", "job"])("enforces the %s deadline for detailed generation", async boundary => {
    vi.useFakeTimers();
    let settle!: (value: Response) => void;
    try {
      const h = harness(attempt => boundary === "job" && attempt === 1
        ? new Promise(resolve => setTimeout(() => resolve(response({})), 150000))
        : new Promise(resolve => { settle = resolve; }));
      const pending = h.generate(fixture()).catch(error => error);
      await vi.waitFor(() => expect(h.sent).toHaveLength(1));
      if (boundary === "job") {
        await vi.advanceTimersByTimeAsync(150000);
        await vi.waitFor(() => expect(h.sent).toHaveLength(2));
      }
      await vi.advanceTimersByTimeAsync(boundary === "job" ? 150000 : 240000);
      expect(await pending).toMatchObject({ code: "AI_TIMEOUT" });
      settle(response());
      await vi.advanceTimersByTimeAsync(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("evaluation-only guidance inputs", () => {
  it("passes sharedRules and decisionRegister to the model without making them approvals", async () => {
    const h = harness(); const input = { ...fixture(), sharedRules: "Synthetic rule: every return needs an actual timestamp.",
      decisionRegister: [{ id: "DR-1", topic: "Proration policy", owner: "Billing lead", affectedStepIds: ["AS-3"] }] };
    await h.generate(input);
    const sent = JSON.parse(h.sent[0]!.messages[0]!.content);
    expect(sent.input).toEqual(input); expect(sent.approvedDecisions).toEqual([]);
    expect(toBeContext(parseToBeInput(input)).approvedDecisions).toEqual([]);
  });
  it("validates model decisionIds against the supplied register only", () => {
    const input = parseToBeInput({ ...fixture(), decisionRegister: [{ id: "DR-1", topic: "Proration policy", owner: "Billing lead", affectedStepIds: [] }] });
    expect(toBeContext(input).decisionRegister).toEqual([{ id: "DR-1" }]);
    const design = (id: string) => ({ ...structuredClone(rentalDraft), openQuestions: [{ ...rentalDraft.openQuestions[0]!, decisionIds: [id] }] });
    expect(validateToBeOutput(input, design("DR-1")).success).toBe(true);
    expect(validateToBeOutput(input, design("DR-9"))).toMatchObject({ success: false, errors: expect.arrayContaining([expect.objectContaining({ code: "UNKNOWN_DECISION" })]) });
    expect(validateToBeOutput(parseToBeInput(fixture()), design("DR-1")).success).toBe(false);
  });
  it.each([
    ["oversized rules", { sharedRules: "x".repeat(20001) }],
    ["unknown register field", { decisionRegister: [{ id: "DR-1", topic: "t", owner: "o", affectedStepIds: [], approved: true }] }],
    ["secret in rules", { sharedRules: "api_key=synthetic-private-secret" }],
  ])("rejects %s before provider I/O", async (_name, extra) => {
    const h = harness();
    await expect(h.generate({ ...fixture(), ...extra })).rejects.toMatchObject({ code: "AI_INPUT_INVALID" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("trusted SAP references in generation", () => {
  let dir: string;
  const withRelease = (): ToBeInput => { const input = fixture(); input.discovery.targetRelease = "2023"; return input; };
  const catalog = { schemaVersion: 1, targetProducts: ["S4HANA_CLOUD_PRIVATE"], targetRelease: "2023", references: [{
    id: "REF-SYN", capability: "Synthetic capability", fitType: "STANDARD", objects: ["Synthetic object"], verification: "VERIFIED",
    evidence: [{ url: "https://help.sap.com/docs/synthetic", quote: "Synthetic quote", release: "2023" }], limitations: [] }] };
  const designCiting = (kind: "STANDARD" | "EXTENSION") => {
    const draft = structuredClone(rentalDraft);
    draft.steps[0]!.implementation = { kind, detail: "Synthetic realization", referenceIds: ["REF-SYN"] };
    return draft;
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "to-be-sap-"));
    await mkdir(join(dir, "s4hana-2023"), { recursive: true });
    await writeFile(join(dir, "s4hana-2023", "reference-catalog.json"), JSON.stringify(catalog));
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("sends catalog references to the model and accepts a step that cites them consistently", async () => {
    const h = harness(() => response(designCiting("STANDARD")), () => 1000, dir);
    const result = await h.generate(withRelease());
    const sent = JSON.parse(h.sent[0]!.messages[0]!.content);
    // The outline sees the compact slice only: no evidence quotes or limitations (the step call receives the full entry).
    expect(sent.references).toEqual([{ id: "REF-SYN", fitType: "STANDARD", capability: "Synthetic capability", objects: ["Synthetic object"] }]);
    expect(JSON.parse(h.sent[1]!.messages[0]!.content).references).toEqual([expect.objectContaining({ id: "REF-SYN", status: "VERIFIED", evidence: expect.any(String) })]);
    expect(sent.approvedDecisions).toEqual([]);
    expect(h.sent).toHaveLength(4); // outline + 3 steps
    expect(result.payload.evaluation.errors).toEqual([]);
  });
  it("rejects a STANDARD claim whose only citation is not a standard capability, after bounded repair", async () => {
    const extension = structuredClone(catalog); extension.references[0]!.fitType = "EXTENSION";
    const other = await mkdtemp(join(tmpdir(), "to-be-sap-ext-"));
    try {
      await mkdir(join(other, "s4hana-2023"), { recursive: true });
      await writeFile(join(other, "s4hana-2023", "reference-catalog.json"), JSON.stringify(extension));
      const h = harness(() => response(designCiting("STANDARD")), () => 1000, other);
      await expect(h.generate(withRelease())).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 3 } });
      expect(h.sent[1]!.messages[0]!.content).toContain("SAP_FIT_MISMATCH");
    } finally { await rm(other, { recursive: true, force: true }); }
  });
  it("keeps the model-claimed reference untrusted when no catalog exists", async () => {
    const h = harness(() => response(designCiting("STANDARD")), () => 1000, join(dir, "missing"));
    await expect(h.generate(withRelease())).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    expect(JSON.parse(h.sent[0]!.messages[0]!.content).references).toEqual([]);
  });
  it("fails closed on a malformed catalog instead of dropping to an empty list", async () => {
    const bad = await mkdtemp(join(tmpdir(), "to-be-sap-bad-"));
    try {
      await mkdir(join(bad, "s4hana-2023"), { recursive: true });
      await writeFile(join(bad, "s4hana-2023", "reference-catalog.json"), "{not json");
      const h = harness(() => response(), () => 1000, bad);
      await expect(h.generate(withRelease())).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR" });
      expect(h.fetch).not.toHaveBeenCalled();
    } finally { await rm(bad, { recursive: true, force: true }); }
  });
  it("revalidates in the snapshot generator against the same catalog", async () => {
    const input = withRelease();
    const snapshot = { id: randomUUID(), variantCode: "RENTAL", version: 1, targetProduct: input.targetProduct, input: input.discovery,
      sourceDigests: Object.fromEntries(input.discovery.sources.map(source => [source.id, createHash("sha256").update(source.text).digest("hex")])),
      createdBy: randomUUID(), createdAt: new Date(), evidenceStatus: "USER_PROVIDED" as const, status: "DRAFT" as const };
    const get = vi.fn().mockResolvedValue({ snapshot, canEdit: true });
    const request = { projectId: randomUUID(), snapshotId: snapshot.id, variantCode: "RENTAL", version: 1 };
    const h = harness(() => response(designCiting("STANDARD")), () => 1000, dir);
    const result = await createToBeGenerator({ get }, h.generate, { baseDir: dir })("session", request);
    expect(result.evaluation.errors).toEqual([]);
    const without = await createToBeGenerator({ get }, h.generate, { baseDir: join(dir, "missing") })("session", request).catch(error => error);
    expect(without).toBeInstanceOf(Error);
  });
});

describe("authorized snapshot generator", () => {
  function setup() {
    const input = fixture();
    const snapshot = { id: randomUUID(), variantCode: "RENTAL", version: 1, targetProduct: input.targetProduct,
      input: input.discovery, sourceDigests: Object.fromEntries(input.discovery.sources.map(source =>
        [source.id, createHash("sha256").update(source.text).digest("hex")])), createdBy: randomUUID(), createdAt: new Date(),
      evidenceStatus: "USER_PROVIDED" as const, status: "DRAFT" as const };
    const request = { projectId: randomUUID(), snapshotId: snapshot.id, variantCode: "RENTAL", version: 1 };
    const get = vi.fn().mockResolvedValue({ snapshot, canEdit: true });
    const h = harness();
    return { snapshot, request, get, h, run: createToBeGenerator({ get }, h.generate) };
  }
  it("pins the requested revision and never sends session or project identity to the model", async () => {
    const s = setup(); const result = await s.run("private-session", s.request);
    expect(s.get).toHaveBeenNthCalledWith(1, "private-session", s.request.projectId, "RENTAL", 1);
    expect(s.get).toHaveBeenCalledTimes(2);
    expect(result.sourceRevision).toMatchObject({ id: s.snapshot.id, version: 1, sourceDigests: s.snapshot.sourceDigests });
    expect(JSON.stringify(s.h.sent)).not.toContain("private-session");
    expect(JSON.stringify(s.h.sent)).not.toContain(s.request.projectId);
  });
  it.each(["permission", "wrong revision", "digest", "client content"])("blocks %s before provider I/O", async kind => {
    const s = setup();
    if (kind === "permission") s.get.mockResolvedValue({ snapshot: s.snapshot, canEdit: false });
    if (kind === "wrong revision") s.snapshot.version = 2;
    if (kind === "digest") s.snapshot.sourceDigests["SRC-1"] = "tampered";
    await expect(s.run("session", kind === "client content" ? { ...s.request, input: fixture() } : s.request)).rejects.toThrow();
    expect(s.h.fetch).not.toHaveBeenCalled();
  });
  it("withholds output after access is revoked during generation", async () => {
    const s = setup(); s.get.mockResolvedValueOnce({ snapshot: s.snapshot, canEdit: true })
      .mockResolvedValueOnce({ snapshot: s.snapshot, canEdit: false });
    await expect(s.run("session", s.request)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(s.h.sent).toHaveLength(4);
  });
  it("recomputes quality instead of trusting a runner-supplied approval", async () => {
    const s = setup(); const parsed = validateToBeOutput(parseToBeInput(fixture()), rentalDraft);
    if (!parsed.success) throw new Error("Invalid test oracle");
    parsed.data.evaluation = { structurallyValid: true, errors: [], blockers: [], reviewStatus: "HUMAN_REVIEW_REQUIRED" };
    const generate = vi.fn().mockResolvedValue({ payload: parsed.data, metrics: {} });
    const result = await createToBeGenerator({ get: s.get }, generate)("session", s.request);
    expect(result.evaluation.reviewStatus).toBe("BLOCKED");
    expect(result.unresolvedInputQuestions).toEqual(fixture().discovery.openQuestions);
  });
});

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("generation from tenant-authorized PostgreSQL discovery", () => {
  const database = `sap_tobe_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(local.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Local test database required");
  const admin = new Client({ connectionString: url.href }); url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.href, max: 4 });
  const auth = createAuthService(pool, { secret: "synthetic-to-be-secret-123456789012345", appUrl: "http://127.0.0.1:3017" });
  const projects = createProjectRepository(pool, auth), discovery = createDiscoveryRepository(pool, auth);
  let created = false;
  beforeAll(async () => {
    await admin.connect(); await admin.query(`CREATE DATABASE ${database}`); created = true;
    await promisify(execFile)("pnpm", ["db:seed"], { env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url.href }, timeout: 30000 });
  }, 40000);
  afterAll(async () => {
    await pool.end();
    try { if (created) await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
  }, 15000);
  async function account() {
    return auth.signup({ name: "Fictional lead", email: `to-be-${randomUUID()}@example.invalid`,
      password: "SyntheticOnly123!", orgName: "Fictional design team" });
  }
  it("uses the selected immutable revision, rejects outsiders and read-only members, and preserves draft questions", async () => {
    const owner = await account(), outsider = await account();
    const project = await projects.create(owner.token, { name: "Fictional hire", clientName: "Synthetic",
      problemStatement: "Manual rental returns cause billing errors when assets return on different dates.",
      targetProduct: "S4HANA_CLOUD_PRIVATE" }, randomUUID());
    const first = await discovery.save(owner.token, project.id, "RENTAL", { expectedVersion: 0, input: fixture().discovery }, randomUUID());
    const second = fixture().discovery; second.variantName = "Newer workshop revision";
    await discovery.save(owner.token, project.id, "RENTAL", { expectedVersion: 1, input: second }, randomUUID());
    const h = harness(), generate = createToBeGenerator(discovery, h.generate);
    const request = { projectId: project.id, snapshotId: first.id, variantCode: "RENTAL", version: 1 };
    await expect(generate(outsider.token, request)).rejects.toMatchObject({ status: 404 });
    expect(h.sent).toHaveLength(0);
    const result = await generate(owner.token, request);
    expect(result.sourceRevision.id).toBe(first.id);
    expect(JSON.parse(h.sent[0]!.messages[0]!.content).input.discovery.variantName).toBe("Fictional equipment hire");
    await pool.query("UPDATE project_memberships SET project_role='PROCESS_OWNER' WHERE project_id=$1 AND user_id=$2", [project.id, owner.user.id]);
    await expect(generate(owner.token, request)).rejects.toMatchObject({ status: 403 });
    expect(h.sent).toHaveLength(4);
  });
});

it.skipIf(process.env.RUN_LIVE_TO_BE_TESTS !== "1")("real provider rental benchmark: writes synthetic output for human review", async () => {
  // Explicit opt-in only. Read the single required secret; never log it or copy it.
  const keyLine = readFileSync(process.env.TO_BE_KEY_FILE ?? new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/).find(line => /^ANTHROPIC_API_KEY\s*=/.test(line));
  const key = keyLine ? parseEnv(keyLine).ANTHROPIC_API_KEY : undefined;
  if (!key) throw new Error("Live benchmark needs the configured Anthropic key");
  const run = createStageRunner(settings({ ANTHROPIC_API_KEY: key }));
  const result = await run("to_be", fixture());
  expect(result.metrics.provider).toBe("anthropic");
  expect(result.metrics.outputTokens).toBeGreaterThan(0);
  expect(result.payload.evaluation.structurallyValid).toBe(true);
  expect(result.payload.design.coverage).toHaveLength(6);
  expect(result.payload.evaluation.reviewStatus).toBe("BLOCKED");
  await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
  await writeFile(new URL("../test-results/to-be-live.json", import.meta.url), JSON.stringify({ input: fixture(), ...result }, null, 2));
}, 310000);
