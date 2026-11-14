import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Client } from "pg";
import { expect, test } from "@playwright/test";

const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3017";
const database = process.env.BROWSER_TEST_DATABASE_URL;
test.skip(process.env.RUN_SYNTHETIC_E2E !== "1", "Use the isolated production HTTPS browser harness");
if (process.env.RUN_SYNTHETIC_E2E === "1" && (!database ||
  !/^\/sap_browser_[a-f0-9]{32}$/.test(new URL(database).pathname) ||
  !["127.0.0.1", "localhost"].includes(new URL(database).hostname))) throw new Error("Isolated local database required");

const shots = "test-results/journey";

test("a new project shows where it stands, and an ended trial offers a way to reach us instead of a retry", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  const signup = await page.request.post(`${origin}/api/auth/signup`, { headers: { origin },
    data: { name: "Fictional journey lead", email: `journey-${randomUUID()}@example.invalid`, password: "SyntheticJourneyOnly123!", orgName: "Synthetic journey team" } });
  expect(signup.status()).toBe(201);
  const created = await page.request.post(`${origin}/api/projects`, { headers: { origin, "Idempotency-Key": randomUUID() },
    data: { name: "Fictional journey project", clientName: "Synthetic client",
      problemStatement: "Our spreadsheet-based equipment return process causes incorrect recurring invoices and delayed updates.",
      targetProduct: "S4HANA_CLOUD_PRIVATE" } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.project.id as string;

  await page.goto(`${origin}/projects/${id}`);
  const steps = page.getByRole("list", { name: "Project steps" });
  await expect(steps.getByRole("listitem")).toHaveCount(3);
  await expect(steps.locator('[aria-current="step"]')).toHaveText("Scope the problem");
  await expect(steps).not.toContainText("(done)"); // nothing is marked done before a scope exists
  await expect(page.locator('[data-action="next-step"]')).toHaveCount(0);
  await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0); // control: no contact exit while nothing is wrong
  await page.screenshot({ path: `${shots}/overview-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `${shots}/overview-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  await steps.getByRole("link", { name: "Map the current process" }).click();
  await expect(page.getByRole("list", { name: "Project steps" }).locator('[aria-current="step"]')).toHaveText("Map the current process");
  await page.goBack();

  const db = new Client({ connectionString: database });
  await db.connect();
  try {
    const expired = await db.query(`UPDATE organizations SET trial_ends_at=now()-interval '1 day'
      WHERE id=(SELECT org_id FROM projects WHERE id=$1)`, [id]);
    expect(expired.rowCount).toBe(1);
    await page.getByRole("button", { name: "Analyze business problem" }).click();
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("Your trial has ended");
    await expect(alert.locator('a[href^="mailto:"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh analysis" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Analyze business problem" })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/trial-ended.png`, fullPage: true });

    // The chat saves the message before the reply is refused; that path must offer the same way out.
    await page.goto(`${origin}/projects/${id}/consultant`);
    await page.getByLabel("Which process are we discussing?").fill("Equipment hire");
    await page.getByRole("button", { name: "Start the conversation" }).click();
    await page.getByLabel("Your message").fill("We track equipment returns in a spreadsheet and invoices are often wrong.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const chatAlert = page.getByRole("main").getByRole("alert");
    await expect(chatAlert).toContainText("Your trial has ended");
    await expect(chatAlert).not.toContainText("reply again");
    await expect(page.getByRole("main").locator('a[href^="mailto:"]')).toBeVisible();
    await page.screenshot({ path: `${shots}/trial-ended-chat.png`, fullPage: true });
  } finally { await db.end(); }
});
