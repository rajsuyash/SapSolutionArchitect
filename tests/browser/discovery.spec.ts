import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { expect, test, type Page } from "@playwright/test";

const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3017";
const database = process.env.BROWSER_TEST_DATABASE_URL;
test.skip(process.env.RUN_SYNTHETIC_E2E !== "1", "Use the isolated production HTTPS browser harness");
if (process.env.RUN_SYNTHETIC_E2E === "1" && (!database ||
  !/^\/sap_browser_[a-f0-9]{32}$/.test(new URL(database).pathname) ||
  !["127.0.0.1", "localhost"].includes(new URL(database).hostname) ||
  !["127.0.0.1", "localhost"].includes(new URL(origin).hostname))) throw new Error("Isolated local database required");

const currentQuote = "The clerk records returns in a spreadsheet.";
const desiredQuote = "Require a return date before completion.";
const sourceText = `${currentQuote}\n${desiredQuote}`;
const password = "SyntheticCaptureOnly123!";
async function setup(page: Page) {
  const email = `capture-${randomUUID()}@example.invalid`;
  const signup = await page.request.post(`${origin}/api/auth/signup`, { headers: { origin },
    data: { name: "Fictional capture lead", email, password, orgName: "Synthetic discovery team" } });
  expect(signup.status()).toBe(201);
  const user = (await signup.json()).data.user;
  const response = await page.request.post(`${origin}/api/projects`, { headers: { origin, "Idempotency-Key": randomUUID() },
    data: { name: "Fictional hire design", clientName: "Synthetic client",
      problemStatement: "Our spreadsheet-based equipment return process causes incorrect recurring invoices and delayed updates.",
      targetProduct: "S4HANA_CLOUD_PRIVATE" } });
  expect(response.status()).toBe(201);
  const id = (await response.json()).data.project.id as string;
  await page.goto(`${origin}/projects/${id}`);
  await page.getByRole("link", { name: "Capture and review process details" }).click();
  await expect(page.getByRole("heading", { name: "Detailed process discovery", exact: true })).toBeVisible();
  return { id, email, userId: user.id as string, endpoint: `${origin}/api/projects/${id}/discovery/RENTAL` };
}
async function fill(page: Page) {
  await page.getByRole("button", { name: "Add process variant", exact: true }).click();
  for (const [label, value] of Object.entries({
    "Process variant code": "RENTAL", "Process variant name": "Equipment hire",
    "Source 1 title": "Fictional workshop", "Source 1 revision": "v1", "Source 1 location": "Returns!B2:C2",
    "Source 1 original text": sourceText,
    "Current step 1 name": "Record return", "Current step 1 actor": "Stores clerk", "Current step 1 system": "Spreadsheet",
    "Current step 1 trigger": "An asset physically returns", "Current step 1 description": currentQuote,
    "Current step 1 inputs (one per line, optional)": "Return note\nAsset identifier",
    "Current step 1 outputs (one per line, optional)": "Return record",
    "Current step 1 exact quote": currentQuote,
    "Requirement 1 statement": "Block completion without the return date", "Requirement 1 exact quote": desiredQuote,
  })) await page.getByLabel(label, { exact: true }).fill(value);
}
async function save(page: Page, revision: number) {
  await page.getByRole("button", { name: "Save revision", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(`Saved revision ${revision}.`);
}
async function open(page: Page) {
  await page.getByRole("button", { name: "Open Equipment hire", exact: true }).click();
  await expect(page.getByRole("form", { name: "Detailed discovery" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Loaded revision");
}

test("capture, review, reload and historical revision preserve source-linked details", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const { endpoint } = await setup(page);
  await fill(page);
  await expect(page.getByRole("button", { name: "Remove source 1", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Add open question", exact: true }).click();
  await page.getByLabel("Open question 1", { exact: true }).fill("Which timezone applies?");
  await page.getByLabel("Open question 1 owner", { exact: true }).fill("Stores lead");
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await expect(page.getByLabel("Requirement 1 statement", { exact: true })).toBeDisabled();
  await expect(page.getByText("Review draft: check the current process", { exact: false })).toBeVisible();
  await info.attach("discovery-desktop", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await info.attach("desktop-source-detail", { body: await page.getByRole("region", { name: "1. Source notes", exact: true }).screenshot(), contentType: "image/png" });
  await save(page, 1);
  const persisted = (await (await page.request.get(endpoint)).json()).data.snapshot;
  expect(persisted.input).toMatchObject({ targetRelease: null, sources: [{ text: sourceText, locator: "Returns!B2:C2" }],
    asIsSteps: [{ inputs: ["Return note", "Asset identifier"], evidence: { quote: currentQuote } }],
    requirements: [{ kind: "TO_BE_REQUIREMENT", evidence: { quote: desiredQuote } }] });
  await page.reload(); await open(page);
  await expect(page.getByLabel("Source 1 original text", { exact: true })).toHaveValue(sourceText);
  await expect(page.getByLabel("Open question 1 owner", { exact: true })).toHaveValue("Stores lead");
  await page.getByLabel("Requirement 1 statement", { exact: true }).fill("Validate the return timestamp before completion.");
  await save(page, 2);
  await page.getByLabel("Saved revision", { exact: true }).selectOption("1");
  await expect(page.getByRole("status")).toContainText("Loaded revision 1.");
  await expect(page.getByLabel("Requirement 1 statement", { exact: true })).toHaveValue("Block completion without the return date");
  await expect(page.getByLabel("Requirement 1 statement", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save revision", exact: true })).toHaveCount(0);
  await page.getByLabel("Saved revision", { exact: true }).selectOption("2");
  await expect(page.getByLabel("Requirement 1 statement", { exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("invalid quotations are rejected locally and the editable draft is retained", async ({ page }) => {
  const { endpoint } = await setup(page); await fill(page);
  let posts = 0;
  page.on("request", request => { if (request.url() === endpoint && request.method() === "POST") posts++; });
  await page.getByLabel("Requirement 1 exact quote", { exact: true }).fill("This rule is not in the source");
  await page.getByRole("button", { name: "Save revision", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Requirement 1: the exact quote must appear");
  expect(posts).toBe(0);
  await expect(page.getByLabel("Requirement 1 exact quote", { exact: true })).toHaveValue("This rule is not in the source");
  await page.getByLabel("Requirement 1 exact quote", { exact: true }).fill(desiredQuote);
  await save(page, 1); expect(posts).toBe(1);
});

test("source reassignment, requirement types and conflicts survive saving", async ({ page }) => {
  const { endpoint } = await setup(page); await fill(page);
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  for (const [label, value] of Object.entries({
    "Source 2 title": "Fictional control review", "Source 2 revision": "v2",
    "Source 2 location": "Controls section 1", "Source 2 original text": sourceText,
  })) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel("Requirement 1 type", { exact: true }).selectOption("CONTROL");
  await page.getByLabel("Requirement 1 current step", { exact: true }).selectOption("AS-1");
  const sourceSelect = page.getByLabel("Requirement 1 source", { exact: true });
  await sourceSelect.selectOption({ label: "Fictional control review · Controls section 1" });
  const sourceId = await sourceSelect.inputValue();
  await page.getByLabel("Current step 1 source", { exact: true }).selectOption(sourceId);
  await page.getByRole("button", { name: "Add conflict", exact: true }).click();
  await page.getByLabel("Conflict 1 question", { exact: true }).fill("Which revision governs the return-date control?");
  await page.getByLabel("Conflict 1 sources (select all that apply)", { exact: true }).selectOption(["SRC-1", sourceId]);
  await save(page, 1);
  const persisted = (await (await page.request.get(endpoint)).json()).data.snapshot.input;
  expect(persisted.requirements[0]).toMatchObject({ kind: "CONTROL", asIsStepId: "AS-1", evidence: { sourceId } });
  expect(persisted.asIsSteps[0].evidence.sourceId).toBe(sourceId);
  expect(persisted.conflicts[0].sourceIds).toEqual(["SRC-1", sourceId]);
  await page.reload(); await open(page);
  await expect(page.getByLabel("Requirement 1 source", { exact: true })).toHaveValue(sourceId);
  await expect(page.getByLabel("Requirement 1 type", { exact: true })).toHaveValue("CONTROL");
  await expect(page.getByLabel("Conflict 1 sources (select all that apply)", { exact: true })).toHaveValues(["SRC-1", sourceId]);
});

test("concurrent editors keep their work and explicitly choose whether to load a newer revision", async ({ page, context }) => {
  const { endpoint } = await setup(page); await fill(page); await save(page, 1);
  const second = await context.newPage();
  await second.goto(page.url()); await open(second);
  await page.getByLabel("Requirement 1 statement", { exact: true }).fill("Editor A approved wording");
  await save(page, 2);
  await second.getByLabel("Requirement 1 statement", { exact: true }).fill("Editor B unsaved wording");
  await second.getByRole("button", { name: "Save revision", exact: true }).click();
  await expect(second.getByRole("main").getByRole("alert")).toContainText("A newer revision was saved elsewhere");
  await expect(second.getByLabel("Requirement 1 statement", { exact: true })).toHaveValue("Editor B unsaved wording");
  const downloading = second.waitForEvent("download");
  await second.getByRole("button", { name: "Download my draft", exact: true }).click();
  const downloaded = await downloading;
  const draft = JSON.parse(await readFile((await downloaded.path())!, "utf8"));
  expect(draft.input.requirements[0].statement).toBe("Editor B unsaved wording");
  second.once("dialog", dialog => dialog.accept());
  await second.getByRole("button", { name: "Load latest and discard my edits" }).click();
  await expect(second.getByRole("status")).toContainText("Loaded revision 2.");
  await expect(second.getByLabel("Requirement 1 statement", { exact: true })).toHaveValue("Editor A approved wording");
  expect((await (await page.request.get(endpoint)).json()).data.snapshot.version).toBe(2);
  await second.close();
});

test("a committed save with a lost response and subsequent timeout retries with one payload and key", async ({ page }) => {
  const { endpoint } = await setup(page); await fill(page);
  const attempts: { key: string | undefined; body: string | null }[] = [];
  await page.route(endpoint, async route => {
    if (route.request().method() !== "POST") return route.continue();
    attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (attempts.length === 1) {
      expect((await route.fetch()).status()).toBe(201);
      return route.abort("failed");
    }
    if (attempts.length === 2) return route.fulfill({ status: 408, contentType: "application/json",
      body: JSON.stringify({ success: false, error: { code: "REQUEST_TIMEOUT", message: "Synthetic timeout" } }) });
    return route.continue();
  });
  await page.getByRole("button", { name: "Save revision", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same save" })).toBeEnabled();
  await expect(page.getByLabel("Requirement 1 statement", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same save" }).click();
  await expect(page.getByRole("button", { name: "Retry same save" })).toBeEnabled();
  await page.getByRole("button", { name: "Retry same save" }).click();
  await expect(page.getByRole("status")).toContainText("Saved revision 1.");
  expect(attempts).toHaveLength(3);
  expect(new Set(attempts.map(item => item.key)).size).toBe(1);
  expect(new Set(attempts.map(item => item.body)).size).toBe(1);
  expect((await (await page.request.get(endpoint)).json()).data.snapshot.version).toBe(1);
});

test("reauthentication preserves unsaved inputs and then permits a successful save", async ({ page }) => {
  const { email } = await setup(page); await fill(page);
  expect((await page.request.post(`${origin}/api/auth/logout`, { headers: { origin } })).status()).toBe(200);
  await page.getByRole("button", { name: "Save revision", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in in a new tab, then retry here" })).toBeVisible();
  await expect(page.getByLabel("Requirement 1 statement", { exact: true })).toHaveValue("Block completion without the return date");
  expect((await page.request.post(`${origin}/api/auth/login`, { headers: { origin }, data: { email, password } })).status()).toBe(200);
  await save(page, 1);
});

test("mobile capture remains usable and process-owner review is read-only", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const actor = await setup(page); await fill(page); await save(page, 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await info.attach("discovery-mobile", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await info.attach("mobile-source-detail", { body: await page.getByRole("region", { name: "1. Source notes", exact: true }).screenshot(), contentType: "image/png" });
  const db = new Client({ connectionString: database });
  await db.connect();
  try { await db.query("UPDATE project_memberships SET project_role='PROCESS_OWNER' WHERE project_id=$1 AND user_id=$2", [actor.id, actor.userId]); }
  finally { await db.end(); }
  await page.reload(); await open(page);
  await expect(page.getByText("You have read-only access to these inputs.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Source 1 original text", { exact: true })).toHaveValue(sourceText);
  await expect(page.getByLabel("Requirement 1 statement", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add process variant", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save revision", exact: true })).toHaveCount(0);
});
