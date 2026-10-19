import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Client } from "pg";
import { expect, test, type Page } from "@playwright/test";
import scenarios from "../../fixtures/e2e/synthetic-projects.json" with { type: "json" };
import { validateProject } from "../../src/lib/tenant";
import { validateProblemAnalysis } from "../../src/lib/ai/problem-analysis";

const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3017";
const databaseUrl = process.env.BROWSER_TEST_DATABASE_URL;
test.skip(process.env.RUN_SYNTHETIC_E2E !== "1", "Run pnpm test:browser:synthetic for an isolated database and worker");
if (process.env.RUN_SYNTHETIC_E2E === "1" && (!databaseUrl ||
  !/^\/sap_browser_[a-f0-9]{32}$/.test(new URL(databaseUrl).pathname) ||
  !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname) ||
  !["127.0.0.1", "localhost"].includes(new URL(origin).hostname))) throw new Error("Synthetic tests require the isolated local harness");

async function signup(page: Page, name: string) {
  await page.goto(`${origin}/signup`);
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Work email").fill(`synthetic-${randomUUID()}@example.invalid`);
  await page.getByLabel("Password", { exact: true }).fill("SyntheticOnly123!");
  await page.getByLabel("Organisation name").fill(`${name} — fictional test organisation`);
  await page.locator("[data-action=signup]").click();
  await expect(page).toHaveURL(`${origin}/projects`);
  await expect(page.getByTestId("projects-empty")).toBeVisible();
}

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 7000);
  try { await exited; } finally { clearTimeout(timeout); }
}

for (const scenario of scenarios) test(`synthetic ${scenario.scenario}: browser setup, API analysis and isolation`, async ({ page, browser }, testInfo) => {
  expect(scenario.fictional).toBe(true);
  const project = validateProject(scenario.project);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await signup(page, `Synthetic ${scenario.scenario}`);
  await page.locator("[data-action=new-project]").click();
  for (const [label, value] of [["Project name", project.name], ["Client name", project.clientName], ["Problem statement", project.problemStatement]]) {
    await page.getByLabel(label!, { exact: true }).fill(value!);
  }
  await page.getByLabel("Target product", { exact: true }).selectOption(project.targetProduct);
  await page.getByLabel("Starting landscape", { exact: true }).selectOption(project.startingLandscape);
  await page.getByLabel("Modules (optional)").fill(project.modules.join(", "));
  for (const [index, unit] of project.orgUnits.entries()) {
    await page.getByRole("button", { name: "Add organisation unit" }).click();
    await page.getByLabel(`Unit ${index + 1} type`).selectOption(unit.type);
    await page.getByLabel(`Unit ${index + 1} code`).fill(unit.code);
    await page.getByLabel(`Unit ${index + 1} name`).fill(unit.name);
  }
  await testInfo.attach("synthetic-input", { body: JSON.stringify(scenario, null, 2), contentType: "application/json" });
  await testInfo.attach("project-form", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/projects") && r.request().method() === "POST");
  await page.locator("[data-action=create-project]").click();
  const response = await saved; expect(response.status()).toBe(201);
  // Saving navigates the document, so Chromium can discard the response body.
  // Read the committed ID from the destination and verify persisted fields below.
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}$/);
  const projectId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.reload();
  await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
  await expect(page.locator("main")).toContainText(project.clientName);
  await expect(page.locator("main")).toContainText({ S4HANA_CLOUD_PUBLIC: "SAP S/4HANA Cloud Public Edition",
    S4HANA_CLOUD_PRIVATE: "SAP S/4HANA Cloud Private Edition", S4HANA_ON_PREMISE: "SAP S/4HANA on-premise" }[project.targetProduct]);
  await expect(page.locator("main")).toContainText({ NON_SAP: "Non-SAP", EXISTING_SAP: "Existing SAP", MIXED: "Mixed landscape" }[project.startingLandscape]);
  await expect(page.locator("main")).toContainText(project.modules.join(", "));
  await expect(page.locator("main")).toContainText(project.problemStatement);
  for (const unit of project.orgUnits) await expect(page.locator("main")).toContainText(`${unit.code} · ${unit.name}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await testInfo.attach("saved-project", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  expect((await (await page.request.get(`${origin}/api/projects/${projectId}`)).json()).data.project).toMatchObject(project);

  // No analysis controls exist yet. Exercise the real API with this browser's
  // authenticated cookie jar, not a mocked route or a fabricated UI result.
  const submitted = await page.request.post(`${origin}/api/projects/${projectId}/analysis`, { headers: { origin } });
  expect(submitted.status()).toBe(202);
  const firstId = (await submitted.json()).data.jobId as string;
  const readJob = async (id: string) => {
    const response = await page.request.get(`${origin}/api/jobs/${id}`); expect(response.status()).toBe(200);
    return (await response.json()).data;
  };
  expect(await readJob(firstId)).toMatchObject({ status: "QUEUED", error: null, result: null });
  const conflict = await page.request.post(`${origin}/api/projects/${projectId}/analysis`, { headers: { origin } });
  expect(conflict.status()).toBe(409);
  expect((await conflict.json()).error).toMatchObject({ code: "JOB_ALREADY_RUNNING", jobId: firstId });
  const local = parseEnv(readFileSync(".env.example", "utf8"));
  const db = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  await db.connect();
  let worker: ChildProcess | undefined;
  let workerError: Error | undefined;
  const workerLogs: string[] = [];
  let completedId = firstId;
  try {
    // Prove the browser server and worker target the same disposable database.
    expect((await db.query("SELECT id FROM projects WHERE id=$1 AND name=$2", [projectId, project.name])).rowCount).toBe(1);
    worker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], { stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, ...local, NODE_ENV: "test", DATABASE_URL: databaseUrl, APP_URL: origin,
        AI_PROVIDER: "stub", AI_FAULT_INJECTION: scenario.fault ?? "" } });
    worker.stdout?.on("data", (data) => workerLogs.push(String(data)));
    worker.stderr?.on("data", (data) => workerLogs.push(String(data)));
    worker.on("error", (error) => { workerError = error; });
    const terminal = async (id: string, status: string) => {
      await expect.poll(async () => {
        expect(workerError, "Worker starts successfully").toBeUndefined();
        expect(worker!.signalCode, `Worker signal exit; logs: ${workerLogs.join("").slice(-2000)}`).toBeNull();
        expect(worker!.exitCode, `Worker remains alive; logs: ${workerLogs.join("").slice(-2000)}`).toBeNull();
        return (await readJob(id)).status;
      }, { timeout: 15000, intervals: [100, 250, 500] }).toBe(status);
      return readJob(id);
    };
    if (scenario.fault === "problem_analysis:timeout:once") {
      expect(await terminal(firstId, "FAILED")).toMatchObject({ error: { code: "AI_TIMEOUT" }, result: null });
      expect((await (await page.request.get(`${origin}/api/projects/${projectId}`)).json()).data.project.setupStatus).toBe("DRAFT");
      const retry = await page.request.post(`${origin}/api/jobs/${firstId}/retry`, { headers: { origin } });
      expect(retry.status()).toBe(202); completedId = (await retry.json()).data.jobId;
      expect(completedId).not.toBe(firstId);
    }
    const result = await terminal(completedId, "SUCCEEDED");
    const row = (await db.query(`SELECT a.payload,j.metrics FROM problem_analyses a JOIN jobs j ON j.id=a.job_id
      WHERE a.id=$1 AND a.job_id=$2 AND a.project_id=$3`, [result.result.analysisId, completedId, projectId])).rows[0];
    expect(validateProblemAnalysis(row.payload, project.problemStatement).success).toBe(true);
    expect(row.metrics).toMatchObject({ provider: "stub", attempts: scenario.fault === "problem_analysis:invalid:once" ? 2 : 1 });
    expect((await (await page.request.get(`${origin}/api/projects/${projectId}`)).json()).data.project.setupStatus).toBe("SCOPE_PROPOSED");
    expect((await page.request.post(`${origin}/api/jobs/${completedId}/retry`, { headers: { origin } })).status()).toBe(409);
    await testInfo.attach("analysis-evidence", { contentType: "application/json", body: JSON.stringify({
      scenario: scenario.scenario, synthetic: true, aiProvider: "stub", scopeUiTested: false,
      projectId, firstJobId: firstId, completedJobId: completedId, result, ...row }, null, 2) });
  } finally {
    if (worker) await stop(worker);
    await db.end();
  }
  expect(workerLogs.join("")).not.toContain(project.problemStatement);
  expect(workerLogs.join("")).not.toContain("Worker failed");

  const foreign = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const outsider = await foreign.newPage();
    await signup(outsider, "Synthetic unrelated organisation");
    for (const route of [`/api/projects/${projectId}`, `/api/jobs/${completedId}`]) {
      expect((await outsider.request.get(`${origin}${route}`)).status()).toBe(404);
    }
    expect((await outsider.request.post(`${origin}/api/projects/${projectId}/analysis`, { headers: { origin } })).status()).toBe(404);
    expect((await outsider.request.post(`${origin}/api/jobs/${completedId}/retry`, { headers: { origin } })).status()).toBe(404);
    await outsider.goto(`${origin}/projects/${projectId}`);
    await expect(outsider.getByRole("heading", { name: "404" })).toBeVisible();
    await expect(outsider.locator("body")).not.toContainText(project.clientName);
    await testInfo.attach("foreign-tenant-denied", { body: await outsider.screenshot({ fullPage: true }), contentType: "image/png" });
  } finally { await foreign.close(); }
  await page.goto(`${origin}/projects`);
  await expect(page.getByRole("list", { name: "Projects" }).getByRole("link")).toHaveCount(1);
  await expect(page.getByRole("link", { name: project.name, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
