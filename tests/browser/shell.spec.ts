import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { parseEnv } from "node:util";
import { Client } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { fixtureId } from "../../scripts/seed";

const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3017";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname)) throw new Error("Browser fixtures require a local server");
test.use({ ignoreHTTPSErrors: true }); // Also supports a local production TLS proxy.
const createdEmails: string[] = [];
const freshEmail = () => { const email = `fresh+${randomUUID()}@test.local`; createdEmails.push(email); return email; };
async function credentials(page: Page, email = "lead@test.local", password = "LocalSeed123!") {
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
}
async function signupFields(page: Page, email = freshEmail()) {
  await page.getByLabel("Full name").fill("Browser Tester");
  await credentials(page, email, "ValidBrowser123!");
  await page.getByLabel("Organisation name").fill("Browser Test Organisation");
  return email;
}
function browserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}
test.afterEach(async ({ context }) => {
  expect((await context.request.post(`${origin}/api/auth/logout`, { headers: { origin } })).status()).toBe(200);
});
test.afterAll(async () => {
  if (!createdEmails.length) return;
  const local = parseEnv(readFileSync(".env.example", "utf8"));
  const db = new Client({ connectionString: process.env.BROWSER_TEST_DATABASE_URL ?? local.DATABASE_URL, connectionTimeoutMillis: 3000 });
  await db.connect();
  try {
    await db.query("BEGIN");
    const orgs = (await db.query<{ org_id: string }>("SELECT org_id FROM users WHERE email=ANY($1::text[])", [createdEmails])).rows.map((row) => row.org_id);
    for (const table of ["project_creation_requests", "org_units", "project_memberships", "projects"]) {
      await db.query(`DELETE FROM ${table} WHERE org_id=ANY($1::uuid[])`, [orgs]);
    }
    const users = await db.query<{ org_id: string }>("DELETE FROM users WHERE email=ANY($1::text[]) RETURNING org_id", [createdEmails]);
    await db.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [users.rows.map((row) => row.org_id)]);
    await db.query("COMMIT");
    expect((await db.query("SELECT id FROM users WHERE email=ANY($1::text[])", [createdEmails])).rowCount).toBe(0);
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { await db.end(); }
});

for (const width of [1280, 1024]) {
  test(`M0-AC1: login shell renders without errors at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.setViewportSize({ width, height: 900 });
    const response = await page.goto(`${origin}/login`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle("Sign in | AI SAP Program Manager");
    const icon = page.locator('link[rel="icon"]');
    await expect(icon).toHaveAttribute("href", /^data:image\/svg\+xml,/);
    expect(await icon.evaluate(async (element) => {
      const image = new Image();
      image.src = (element as HTMLLinkElement).href;
      await image.decode();
      return image.naturalWidth > 0;
    })).toBe(true);
    await expect(page.getByTestId("app-shell-header")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to your workspace" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await expect(page.locator("[data-primary-cta]")).toHaveCount(1);
    await expect(page.getByLabel("Work email")).toBeEnabled();
    await expect(page.getByLabel("Password", { exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("login.png"), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test("shell navigation preserves destinations and returns from signup", async ({ page }) => {
  await page.goto(origin);
  await expect(page).toHaveURL(`${origin}/login`);
  for (const [label, destination] of [
    ["Projects", "/projects"],
    ["Review", "/review"],
    ["Reference library", "/admin/reference-library"],
  ]) {
    await page.getByRole("navigation").getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(`${origin}/login?${new URLSearchParams({ next: destination })}`);
  }
  await page.getByRole("link", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create account", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(`${origin}/login`);
});

test("F1-AC1: signup sets an HttpOnly session, opens empty projects, and logout revokes it", async ({ page, context }, testInfo) => {
  const errors = browserErrors(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(`${origin}/signup`);
  await expect(page.locator("[data-action=signup]")).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("signup.png"), fullPage: true });
  await signupFields(page);
  let submissions = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/auth/signup", async (route) => { submissions++; await gate; await route.continue(); });
  const response = page.waitForResponse((r) => r.url().endsWith("/api/auth/signup"));
  await page.locator("[data-action=signup]").click();
  await expect(page.getByRole("button", { name: "Creating account…" })).toBeDisabled();
  release();
  expect((await response).status()).toBe(201);
  await expect(page).toHaveURL(`${origin}/projects`);
  await expect(page.getByTestId("projects-empty")).toBeVisible();
  await expect(page.getByTestId("session-user")).toHaveText("Browser Tester");
  expect(submissions).toBe(1);
  const cookie = (await context.cookies()).find((item) => item.name.endsWith("sap_pm_session"));
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/", secure: origin.startsWith("https:") });
  expect(await page.evaluate(() => document.cookie)).not.toContain("sap_pm_session");
  await page.reload();
  await expect(page.getByTestId("projects-empty")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("projects-empty.png"), fullPage: true });
  await page.locator("[data-action=new-project]").click();
  await expect(page).toHaveURL(`${origin}/projects/new`);
  await expect(page.getByRole("heading", { name: "Start a transformation project" })).toBeVisible();
  await page.locator("[data-action=logout]").click();
  await expect(page).toHaveURL(`${origin}/login`);
  expect((await context.cookies()).some((item) => item.name.endsWith("sap_pm_session"))).toBe(false);
  const oldSession = await page.request.get(`${origin}/api/auth/session`, { headers: { cookie: `${cookie!.name}=${cookie!.value}` } });
  expect(oldSession.status()).toBe(401);
  await page.goBack();
  await page.reload();
  await expect(page).toHaveURL(/\/login/);
  expect(errors).toEqual([]);
});

test("F1-AC2 and ERR7: login resumes a protected page, shows only own projects, and refresh keeps identity", async ({ page }, testInfo) => {
  const errors = browserErrors(page);
  await page.goto(`${origin}/projects`);
  await expect(page).toHaveURL(`${origin}/login?${new URLSearchParams({ next: "/projects" })}`);
  await credentials(page);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/auth/login"));
  await page.locator("[data-action=login]").click();
  expect((await response).status()).toBe(200);
  await expect(page).toHaveURL(`${origin}/projects`);
  await expect(page.getByRole("link", { name: "Acme O2C Transformation" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Other Co");
  await page.reload();
  await expect(page.getByTestId("session-user")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("projects-list.png"), fullPage: true });
  await page.getByRole("link", { name: "Acme O2C Transformation" }).click();
  await expect(page).toHaveURL(`${origin}/projects/${fixtureId("acme-project")}`);
  await expect(page.getByRole("heading", { name: "Acme O2C Transformation" })).toBeVisible();
  await page.getByRole("link", { name: "Back to projects" }).click();
  await expect(page).toHaveURL(`${origin}/projects`);
  await page.goto(`${origin}/login`);
  await expect(page).toHaveURL(`${origin}/projects`);
  expect(errors).toEqual([]);
});

test("F1-ERR1/2: server field errors retain entries; duplicate signup is generic", async ({ page }) => {
  await page.goto(`${origin}/signup`);
  await signupFields(page);
  await page.route("**/api/auth/signup", async (route) => {
    await route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), orgName: "" }) });
  }, { times: 1 });
  let response = page.waitForResponse((r) => r.url().endsWith("/api/auth/signup"));
  await page.locator("[data-action=signup]").click();
  expect((await response).status()).toBe(400);
  await expect(page.getByLabel("Organisation name")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Organisation name")).toBeFocused();
  await expect(page.locator("form").getByRole("alert")).toHaveText("This field is required");
  await expect(page.getByLabel("Full name")).toHaveValue("Browser Tester");
  await page.getByLabel("Work email").fill("lead@test.local");
  response = page.waitForResponse((r) => r.url().endsWith("/api/auth/signup"));
  await page.locator("[data-action=signup]").click();
  expect((await response).status()).toBe(409);
  await expect(page.locator("form").getByRole("alert")).toHaveText("Couldn't create account — try signing in");
  await expect(page).toHaveURL(`${origin}/signup`);
});

test("F1-ERR3: incorrect credentials stay inline, then valid login resumes a project", async ({ page }) => {
  const destination = `/projects/${fixtureId("acme-project")}`;
  await page.goto(`${origin}${destination}`);
  await credentials(page, "lead@test.local", "Incorrect123!");
  const response = page.waitForResponse((r) => r.url().endsWith("/api/auth/login"));
  await page.locator("[data-action=login]").click();
  expect((await response).status()).toBe(401);
  await expect(page.locator("form").getByRole("alert")).toHaveText("Email or password is incorrect");
  await expect(page).toHaveURL(`${origin}/login?${new URLSearchParams({ next: destination })}`);
  await expect(page.getByLabel("Work email")).toHaveValue("lead@test.local");
  await credentials(page);
  await page.locator("[data-action=login]").click();
  await expect(page).toHaveURL(`${origin}${destination}`);
});

test("signup recovers from a network failure without losing entries", async ({ page }) => {
  await page.goto(`${origin}/signup`);
  const email = await signupFields(page);
  await page.route("**/api/auth/signup", (route) => route.abort("failed"), { times: 1 });
  await page.locator("[data-action=signup]").click();
  await expect(page.locator("form").getByRole("alert")).toContainText("Couldn't reach the server");
  await expect(page.getByLabel("Work email")).toHaveValue(email);
  await expect(page.locator("[data-action=signup]")).toBeEnabled();
  await page.locator("[data-action=signup]").click();
  await expect(page).toHaveURL(`${origin}/projects`);
});

test("guest sees assigned projects only and cannot open another tenant or create projects", async ({ page }) => {
  await page.goto(`${origin}/login`);
  await credentials(page, "owner@test.local");
  await page.locator("[data-action=login]").click();
  await expect(page).toHaveURL(`${origin}/review`);
  await expect(page.getByRole("link", { name: "Acme O2C Transformation" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Reference library" })).toHaveCount(0);
  await page.getByRole("navigation").getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.locator("[data-action=new-project]")).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Projects" }).getByRole("link")).toHaveCount(1);
  for (const path of [`/projects/${fixtureId("other-project")}`, "/projects/new", "/admin/reference-library"]) {
    await page.goto(`${origin}${path}`);
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Other Co");
  }
});

test("login ignores unsafe return URLs", async ({ page }) => {
  for (const next of ["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "/projects/../login"]) {
    await page.goto(`${origin}/login?${new URLSearchParams({ next })}`);
    await credentials(page);
    await page.locator("[data-action=login]").click();
    await expect(page).toHaveURL(`${origin}/projects`);
    await page.locator("[data-action=logout]").click();
    await expect(page).toHaveURL(`${origin}/login`);
  }
});

test("a revoked session in another tab cannot reopen protected data", async ({ page, context }) => {
  await page.goto(`${origin}/login`);
  await credentials(page);
  await page.locator("[data-action=login]").click();
  await expect(page).toHaveURL(`${origin}/projects`);
  await page.getByRole("navigation").getByRole("link", { name: "Review", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/review`);
  const other = await context.newPage();
  await other.goto(`${origin}/projects`);
  await other.locator("[data-action=logout]").click();
  await expect(other).toHaveURL(`${origin}/login`);
  await page.getByRole("navigation").getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole("link", { name: "Acme O2C Transformation" })).toHaveCount(0);
  await expect(page.getByTestId("session-user")).toHaveCount(0);
  await other.close();
});

test("page authentication rejects duplicate raw session cookies", async ({ page, context }) => {
  await page.goto(`${origin}/login`);
  await credentials(page);
  await page.locator("[data-action=login]").click();
  await expect(page).toHaveURL(`${origin}/projects`);
  const cookie = (await context.cookies()).find((item) => item.name.endsWith("sap_pm_session"))!;
  for (const pair of [`${cookie.name}=invalid; ${cookie.name}=${cookie.value}`, `${cookie.name}=${cookie.value}; ${cookie.name}=invalid`]) {
    // Playwright's cookie jar normalizes duplicate names; use raw HTTP instead.
    const response = await new Promise<{ status?: number; location?: string; body: string }>((resolve, reject) => {
      const get = origin.startsWith("https:") ? httpsGet : httpGet;
      const request = get(`${origin}/projects`, { headers: { cookie: pair }, rejectUnauthorized: false }, (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, location: response.headers.location, body }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.setTimeout(5000, () => request.destroy(new Error("Raw page request timed out")));
    });
    expect(response.status).toBe(307);
    expect(response.location).toBe(`/login?${new URLSearchParams({ next: "/projects" })}`);
    expect(response.body).not.toContain("Acme O2C Transformation");
  }
});

test("route stubs guard project paths, expose no invite token, and reject unknown routes", async ({ page, request }) => {
  const destination = "/projects/example/processes/example/as-is";
  await page.goto(`${origin}${destination}`);
  await expect(page).toHaveURL(`${origin}/login?${new URLSearchParams({ next: destination })}`);
  await page.goto(`${origin}/invite/example-private-token`);
  await expect(page.getByRole("heading", { name: "Join your project" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("example-private-token");
  const unknown = await request.get(`${origin}/not-a-product-route`);
  expect(unknown.status()).toBe(404);
});

async function projectFields(page: Page) {
  await page.goto(`${origin}/signup`);
  await signupFields(page);
  await page.locator("[data-action=signup]").click();
  await expect(page).toHaveURL(`${origin}/projects`);
  await page.locator("[data-action=new-project]").click();
  await expect(page.locator("[data-action=create-project]")).toBeDisabled();
  await page.getByLabel("Project name", { exact: true }).fill("Order transformation");
  await page.getByLabel("Client name", { exact: true }).fill("Browser client");
  await page.getByLabel("Problem statement", { exact: true }).fill("Our order processing relies on manual spreadsheets and delays deliveries to customers.");
  await page.getByLabel("Target product", { exact: true }).selectOption("S4HANA_CLOUD_PUBLIC");
}

test("project creation saves details and optional units with one pending submission", async ({ page }, testInfo) => {
  const errors = browserErrors(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  await projectFields(page);
  await page.getByLabel("Modules (optional)").fill("SD, MM, SD");
  await page.getByRole("button", { name: "Add organisation unit" }).click();
  await page.getByLabel("Unit 1 type").selectOption("PLANT");
  await page.getByLabel("Unit 1 code").fill("p1");
  await page.getByLabel("Unit 1 name").fill("Paris factory");
  await page.screenshot({ path: testInfo.outputPath("project-form.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  let submissions = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/projects", async (route) => { submissions++; await gate; await route.continue(); });
  const response = page.waitForResponse((r) => r.url().endsWith("/api/projects") && r.request().method() === "POST");
  await page.locator("[data-action=create-project]").click();
  await expect(page.getByRole("button", { name: "Saving project…" })).toBeDisabled();
  release();
  expect((await response).status()).toBe(201);
  await expect(page.getByRole("heading", { name: "Order transformation" })).toBeVisible();
  await expect(page.locator("main")).toContainText("PLANT · P1 · Paris factory");
  await expect(page.locator("main")).toContainText("MM, SD");
  expect(submissions).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("project-saved.png"), fullPage: true });
  await page.getByRole("link", { name: "Back to projects", exact: true }).click();
  await expect(page.getByRole("list", { name: "Projects" }).getByRole("link")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("lost committed save followed by a timeout retry retains one project and one key", async ({ page }) => {
  await projectFields(page);
  const keys: string[] = [];
  await page.route("**/api/projects", async (route) => {
    keys.push(route.request().headers()["idempotency-key"]!);
    if (keys.length === 1) { expect((await route.fetch()).status()).toBe(201); await route.abort("failed"); }
    else if (keys.length === 2) await route.fulfill({ status: 408, contentType: "application/json", body: JSON.stringify({ success: false, error: { code: "REQUEST_TIMEOUT", message: "Request body timed out" } }) });
    else await route.continue();
  });
  await page.locator("[data-action=create-project]").click();
  await expect(page.locator("form").getByRole("alert")).toContainText("couldn't confirm");
  await expect(page.getByLabel("Project name", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("Request body timed out");
  await expect(page.getByLabel("Project name", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByRole("heading", { name: "Order transformation" })).toBeVisible();
  expect(keys).toHaveLength(3); expect(new Set(keys).size).toBe(1);
  await page.getByRole("link", { name: "Back to projects", exact: true }).click();
  await expect(page.getByRole("list", { name: "Projects" }).getByRole("link")).toHaveCount(1);
});

test("project server validation focuses the field and preserves entries for correction", async ({ page }) => {
  await projectFields(page);
  await page.route("**/api/projects", async (route) => {
    await route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), problemStatement: "Short" }) });
  }, { times: 1 });
  await page.locator("[data-action=create-project]").click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("Describe the problem in at least 50 characters");
  await expect(page.getByLabel("Problem statement", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue("Order transformation");
  expect((await (await page.request.get(`${origin}/api/projects`)).json()).data.projects).toEqual([]);
  await page.locator("[data-action=create-project]").click();
  await expect(page.getByRole("heading", { name: "Order transformation" })).toBeVisible();
});
