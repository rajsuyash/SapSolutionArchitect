// Explicitly opt in: this creates one fictional tenant and three real AI jobs.
// Credentials stay in ignored local files; reports contain synthetic data only.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { chromium, expect as playwrightExpect, type APIResponse } from "@playwright/test";
import { validateProblemAnalysis } from "../src/lib/ai/problem-analysis";
import fixtureScenarios from "../fixtures/e2e/synthetic-projects.json" with { type: "json" };

if (!process.argv.includes("--create-synthetic-data")) throw new Error("Requires --create-synthetic-data");
const expect = playwrightExpect.configure({ timeout: 10000 });
const access = parseEnv(readFileSync(".env.demo-access", "utf8"));
function required(key: string): string {
  const value = access[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
const origin = "https://sap-web-965411321011.europe-west1.run.app";
if (access.DEMO_URL !== origin) throw new Error("Unexpected demo origin");
const run = new Date().toISOString().replace(/[:.]/g, "-");
const output = `test-results/live-audit/${run}`;
mkdirSync(output, { recursive: true });
const account = { name: "Synthetic QA Consultant", email: `qa-${randomUUID()}@example.test`,
  password: `Qa9-${randomUUID()}`, orgName: `Fictional QA ${run}` };
const credentials = `ACCOUNT_EMAIL=${JSON.stringify(account.email)}\nACCOUNT_PASSWORD=${JSON.stringify(account.password)}\n`;
writeFileSync(".env.live-test", credentials, { mode: 0o600 });
if (parseEnv(readFileSync(".env.live-test", "utf8")).ACCOUNT_PASSWORD !== account.password) throw new Error("Credential write failed");
const scenarios = fixtureScenarios
  .map(({ scenario, project }) => ({ scenario, project: { ...project, name: `${project.name} ${run}` } }));
const saveJson = (path: string, value: unknown) => {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  JSON.parse(readFileSync(path, "utf8"));
};
saveJson(`${output}/synthetic-data.json`, scenarios);
type ProjectResult = { scenario: string; id: string; jobId?: string; status?: string; objectives?: number; processes?: number };
type Report = { testedAt: string; finishedAt?: string; origin: string; checks: Array<{ name: string; status: string; error?: string }>;
  projects: ProjectResult[]; browserErrors: string[]; limitations: string[] };
const report: Report = { testedAt: new Date().toISOString(), origin, checks: [], projects: [], browserErrors: [], limitations: [
  "Scope confirmation, As-Is, Gap, To-Be, invitations and blueprint export are not implemented.",
  "Real provider failure/retry and outage injection are not forced on the live deployment.",
  "Chromium desktop and mobile viewport coverage; not a cross-browser certification.",
] };
const browser = await chromium.launch({ headless: true });
const options = { httpCredentials: { username: required("DEMO_USERNAME"), password: required("DEMO_PASSWORD") },
  viewport: { width: 1440, height: 1000 } };
const context = await browser.newContext(options);
context.setDefaultTimeout(15000);
context.setDefaultNavigationTimeout(30000);
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror", error => report.browserErrors.push(error.message));
const errorMessage = (error: unknown) => {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [access.DEMO_PASSWORD, access.ACCOUNT_PASSWORD, account.password]) {
    if (secret) message = message.replaceAll(secret, "[redacted]");
  }
  return message.slice(0, 1800);
};
const check = async (name: string, work: () => Promise<void>) => {
  console.log(`CHECK ${name}`);
  try { await work(); report.checks.push({ name, status: "PASS" }); console.log(`PASS ${name}`); }
  catch (error) {
    report.checks.push({ name, status: "FAIL", error: errorMessage(error) });
    console.log(`FAIL ${name}: ${errorMessage(error)}`);
    saveJson(`${output}/report.json`, report);
    await page.screenshot({ path: `${output}/failure-${report.checks.length}.png`, fullPage: true, timeout: 5000 }).catch(() => {});
  }
  saveJson(`${output}/report.json`, report);
};
const data = async (response: APIResponse) => {
  expect(response.ok(), `HTTP ${response.status()}`).toBeTruthy();
  const body = await response.json();
  expect(body.success).toBe(true);
  return body.data;
};
const login = async (email: string, password: string) => {
  await page.goto(`${origin}/login`);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.locator("[data-action=login]").click();
  await expect(page).toHaveURL(`${origin}/projects`);
};
try {
  await check("Live database, queue and storage health", async () => {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(20000) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ db: "ok", queue: "ok", storage: "ok" });
  });
  await check("Private gate protects login and signup API", async () => {
    for (const path of ["/login", "/api/auth/signup"]) expect((await fetch(origin + path, { signal: AbortSignal.timeout(20000) })).status).toBe(401);
  });
  await page.goto(`${origin}/signup`);
  await expect(page.locator("[data-action=signup]")).toBeDisabled();
  for (const [label, value] of Object.entries({ "Full name": account.name, "Work email": account.email,
    Password: account.password, "Organisation name": account.orgName })) await page.getByLabel(label, { exact: true }).fill(value);
  await page.locator("[data-action=signup]").click();
  await expect(page).toHaveURL(`${origin}/projects`);
  await check("Fresh signup and empty workspace", async () => {
    await expect(page.getByTestId("projects-empty")).toBeVisible();
    await expect(page.getByTestId("session-user")).toHaveText(account.name);
  });
  await check("Production session cookie security", async () => {
    const cookies = (await context.cookies()).filter(cookie => cookie.name.includes("session"));
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.secure).toBe(true);
    expect(cookies[0]?.httpOnly).toBe(true);
    expect(cookies[0]?.sameSite).toBe("Lax");
  });
  await page.locator("[data-action=logout]").click();
  await expect(page).toHaveURL(`${origin}/login`);
  await check("Invalid password produces an inline error", async () => {
    await page.getByLabel("Work email").fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill("Incorrect9-password");
    await page.locator("[data-action=login]").click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(`${origin}/login`);
  });
  await login(account.email, account.password);
  await check("Login returns the correct workspace", async () => {
    await expect(page.getByTestId("session-user")).toHaveText(account.name);
    expect((await data(await page.request.get(`${origin}/api/projects`))).projects).toHaveLength(0);
  });
  for (const { scenario, project } of scenarios) {
    await page.goto(`${origin}/projects/new`);
    await check(`${scenario}: empty project form cannot submit`, async () => {
      await expect(page.locator("[data-action=create-project]")).toBeDisabled();
    });
    for (const [label, value] of Object.entries({ "Project name": project.name, "Client name": project.clientName,
      "Problem statement": project.problemStatement })) await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByLabel("Target product", { exact: true }).selectOption(project.targetProduct);
    await page.getByLabel("Starting landscape", { exact: true }).selectOption(project.startingLandscape);
    await page.getByLabel("Modules (optional)").fill(project.modules.join(", "));
    for (const [i, unit] of project.orgUnits.entries()) {
      await page.getByRole("button", { name: "Add organisation unit" }).click();
      await page.getByLabel(`Unit ${i + 1} type`).selectOption(unit.type);
      await page.getByLabel(`Unit ${i + 1} code`).fill(unit.code);
      await page.getByLabel(`Unit ${i + 1} name`).fill(unit.name);
    }
    const createdResponse = page.waitForResponse(response => response.url() === `${origin}/api/projects` && response.request().method() === "POST");
    await page.locator("[data-action=create-project]").click();
    const created = await createdResponse;
    expect(created.status()).toBe(201);
    await expect(page).toHaveURL(/\/projects\/[a-f0-9-]{36}$/);
    const id = new URL(page.url()).pathname.split("/").at(-1);
    if (!id) throw new Error("Missing project ID");
    const endpoint = `${origin}/api/projects/${id}/analysis`;
    report.projects.push({ scenario, id });
    await check(`${scenario}: saved inputs and organisation units`, async () => {
      const saved = (await data(await page.request.get(`${origin}/api/projects/${id}`))).project;
      for (const key of ["name", "clientName", "problemStatement", "targetProduct", "startingLandscape"] as const) expect(saved[key]).toEqual(project[key]);
      expect(saved.modules).toEqual([...project.modules].sort());
      expect(saved.orgUnits).toEqual(expect.arrayContaining(project.orgUnits.map(unit => expect.objectContaining(unit))));
      await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible();
    });
    await check(`${scenario}: creation retry is idempotent`, async () => {
      const replay = await page.request.post(`${origin}/api/projects`, { headers: { origin,
        "idempotency-key": created.request().headers()["idempotency-key"] }, data: created.request().postDataJSON() });
      expect((await data(replay)).project.id).toBe(id);
    });
    await page.getByRole("button", { name: "Analyze business problem", exact: true }).click();
    await check(`${scenario}: duplicate analysis is blocked`, async () => {
      await expect.poll(async () => (await data(await page.request.get(endpoint))).job?.status).toMatch(/QUEUED|RUNNING/);
      expect((await page.request.post(endpoint, { headers: { origin } })).status()).toBe(409);
      await expect(page.getByRole("button", { name: "Analyzing…", exact: true })).toBeDisabled();
    });
    await page.reload();
    await check(`${scenario}: real AI completes after reload`, async () => {
      await expect.poll(async () => {
        const state = await data(await page.request.get(endpoint));
        if (state.job?.status === "FAILED") throw new Error(`AI job failed: ${state.job.error?.code}`);
        return state.job?.status;
      }, { timeout: 330000, intervals: [2000, 4000, 5000] }).toBe("SUCCEEDED");
      await expect(page.getByTestId("analysis-result")).toBeVisible();
    });
    const state = await data(await page.request.get(endpoint));
    if (!state.analysis) continue;
    Object.assign(report.projects.at(-1)!, { jobId: state.job.id, status: state.job.status,
      objectives: state.analysis.objectives.length, processes: state.analysis.proposedProcesses.length });
    saveJson(`${output}/${scenario}-analysis.json`, state.analysis);
    await check(`${scenario}: schema, hierarchy and source quotes`, async () => {
      expect(validateProblemAnalysis(state.analysis, project.problemStatement).success).toBe(true);
      expect(state.analysis.inputTruncated).toBe(false);
      await expect(page.getByTestId("analysis-result")).toContainText(state.analysis.scopeSummary);
    });
    await check(`${scenario}: overview status updates when analysis finishes`, async () => {
      await expect(page.locator(".panel-description").filter({ hasText: project.clientName }).first()).toContainText("Scope proposed", { timeout: 3000 });
    });
    await page.reload();
    await check(`${scenario}: durable results survive another reload`, async () => {
      await expect(page.getByTestId("analysis-result")).toContainText(state.analysis.scopeSummary);
      expect((await data(await page.request.get(endpoint))).analysis).toEqual(state.analysis);
    });
    await page.screenshot({ path: `${output}/${scenario}.png`, fullPage: true, timeout: 10000 });
  }
  await check("List contains exactly the three new projects", async () => {
    await page.goto(`${origin}/projects`);
    await expect(page.getByRole("list", { name: "Projects" }).getByRole("link")).toHaveCount(3);
  });
  await check("Cross-origin mutations are denied", async () => {
    expect((await page.request.post(`${origin}/api/projects/${report.projects[0].id}/analysis`,
      { headers: { origin: "https://untrusted.example" } })).status()).toBe(403);
  });
  const last = report.projects.at(-1);
  if (!last) throw new Error("No projects created");
  await page.goto(`${origin}/projects/${last.id}`);
  await check("Mobile layout and Unicode data", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("analysis-result")).toBeVisible();
    await expect(page.locator("body")).toContainText("東京");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${output}/mobile.png`, fullPage: true, timeout: 10000 });
  });
  await check("To-Be route is not implemented", async () => {
    const response = await page.goto(`${origin}/projects/${last.id}/processes/${randomUUID()}/to-be`);
    expect(response?.status()).toBe(404);
  });
  await page.locator("[data-action=logout]").click();
  await expect(page).toHaveURL(`${origin}/login`);
  await check("Logout revokes API and page access", async () => {
    expect((await page.request.get(`${origin}/api/projects/${last.id}/analysis`)).status()).toBe(401);
    await page.goto(`${origin}/projects/${last.id}`);
    await expect(page).toHaveURL(/\/login\?next=/);
    await expect(page.getByTestId("session-user")).toHaveCount(0);
  });
  await login(required("ACCOUNT_EMAIL"), required("ACCOUNT_PASSWORD"));
  await check("Other organisation cannot read or mutate QA projects", async () => {
    for (const project of report.projects) {
      for (const path of [`/api/projects/${project.id}`, `/api/projects/${project.id}/analysis`, `/api/jobs/${project.jobId}`]) {
        expect((await page.request.get(origin + path)).status()).toBe(404);
      }
      expect((await page.request.post(`${origin}/api/projects/${project.id}/analysis`, { headers: { origin } })).status()).toBe(404);
    }
    await page.goto(`${origin}/projects/${last.id}`);
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(scenarios[2].project.clientName);
  });
  await check("No uncaught browser JavaScript errors", async () => expect(report.browserErrors).toEqual([]));
} catch (error) {
  report.checks.push({ name: "Journey execution", status: "FAIL", error: errorMessage(error) });
  console.log(`FAIL Journey execution: ${errorMessage(error)}`);
  await page.screenshot({ path: `${output}/journey-failure.png`, fullPage: true, timeout: 5000 }).catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString();
  saveJson(`${output}/report.json`, report);
  await browser.close();
}
const failures = report.checks.filter(check => check.status === "FAIL");
console.log(`${report.checks.length - failures.length}/${report.checks.length} checks passed. ${output}/report.json`);
process.exitCode = failures.length ? 1 : 0;
