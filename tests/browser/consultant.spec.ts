import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Client } from "pg";
import { expect, test, type Locator, type Page } from "@playwright/test";

const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3017";
const database = process.env.BROWSER_TEST_DATABASE_URL;
test.skip(process.env.RUN_SYNTHETIC_E2E !== "1", "Use the isolated production HTTPS browser harness");
if (process.env.RUN_SYNTHETIC_E2E === "1" && (!database ||
  !/^\/sap_browser_[a-f0-9]{32}$/.test(new URL(database).pathname) ||
  !["127.0.0.1", "localhost"].includes(new URL(database).hostname) ||
  !["127.0.0.1", "localhost"].includes(new URL(origin).hostname))) throw new Error("Isolated local database required");

const password = "SyntheticConsultantOnly123!";
const shots = "test-results/consultant-ui";
const firstMessage = "We track equipment returns in a spreadsheet. Invoices are often wrong when the return date is late.";

async function setup(page: Page) {
  const signup = await page.request.post(`${origin}/api/auth/signup`, { headers: { origin },
    data: { name: "Fictional consultant lead", email: `consultant-${randomUUID()}@example.invalid`, password, orgName: "Synthetic consultant team" } });
  expect(signup.status()).toBe(201);
  const response = await page.request.post(`${origin}/api/projects`, { headers: { origin, "Idempotency-Key": randomUUID() },
    data: { name: "Fictional hire discovery", clientName: "Synthetic client",
      problemStatement: "Our spreadsheet-based equipment return process causes incorrect recurring invoices and delayed updates.",
      targetProduct: "S4HANA_CLOUD_PRIVATE" } });
  expect(response.status()).toBe(201);
  const id = (await response.json()).data.project.id as string;
  await page.goto(`${origin}/projects/${id}`);
  await page.getByRole("link", { name: "Describe the process in a guided conversation" }).click();
  await expect(page.getByRole("heading", { name: "Discovery conversation", exact: true })).toBeVisible();
  return { id };
}

/** The queue, fencing, validation and persistence are real; only the model is scripted. */
async function withWorker(work: () => Promise<void>) {
  const local = parseEnv(readFileSync(".env.example", "utf8"));
  const logs: string[] = [];
  const worker: ChildProcess = spawn(process.execPath, ["--import", "tsx", "tests/browser/support/consultant-worker.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, ...local, NODE_ENV: "test", DATABASE_URL: database, APP_URL: origin, AI_PROVIDER: "stub" } });
  worker.stdout?.on("data", chunk => logs.push(String(chunk)));
  worker.stderr?.on("data", chunk => logs.push(String(chunk)));
  const until = Date.now() + 20000;
  while (!logs.join("").includes("worker ready")) {
    if (worker.exitCode !== null || Date.now() > until) throw new Error(`Test worker did not start: ${logs.join("").slice(-1500)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try { await work(); }
  finally {
    if (worker.exitCode === null) { const exited = once(worker, "exit"); worker.kill("SIGTERM"); await exited; }
    expect(logs.join("")).not.toMatch(/Error|failed/i);
  }
}

type Scope = Page | Locator;
const group = (scope: Scope, name: string | RegExp) => scope.getByRole("group", { name });
async function startConversation(page: Page) {
  await page.getByLabel("Which process are we discussing?").fill("Equipment hire");
  await page.getByRole("button", { name: "Start the conversation", exact: true }).click();
  await expect(page.getByLabel("Your message")).toBeFocused();
}
async function say(page: Page, text: string, replies: number) {
  await page.getByLabel("Your message").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("message-user").last()).toContainText(text.slice(0, 40));
  await expect(page.getByLabel("Your message")).toBeFocused();
  await expect(page.getByTestId("message-assistant")).toHaveCount(replies, { timeout: 20000 });
}
async function answer(page: Scope, name: string | RegExp, text: string) {
  const field = group(page, name);
  await field.getByRole("button", { name: /^(Answer|Edit)$/ }).click();
  await field.getByRole("textbox").fill(text);
  await field.getByRole("button", { name: "Save", exact: true }).click();
  await expect(field.getByText(text, { exact: true })).toBeVisible();
}
async function markNotApplicable(page: Scope, name: string | RegExp, reason: string) {
  const field = group(page, name);
  await field.getByRole("button", { name: "Not applicable", exact: true }).click();
  await field.getByRole("textbox").fill(reason);
  await field.getByRole("button", { name: "Save", exact: true }).click();
  await expect(field).toContainText(`Not applicable: ${reason}`);
}

test("a consultant conversation builds, confirms and generates from reviewed discovery", async ({ page }) => {
  test.setTimeout(170000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const { id } = await setup(page);
  await startConversation(page);
  await expect(page.getByRole("log", { name: "Conversation with the consultant" })).toBeVisible();

  await withWorker(async () => {
    // Describe the problem: acknowledgement plus focused questions, each with a reason.
    await say(page, firstMessage, 1);
    const reply = page.getByTestId("message-assistant").first();
    await expect(reply).toContainText("Thank you for that context.");
    await expect(reply.getByText("Why this matters:")).toHaveCount(2);
    await expect(reply.getByText("Who owns the current process")).toBeVisible();

    // The suggestion is evidence-backed and nothing is recorded until accepted.
    const proposal = page.getByTestId("proposal");
    await expect(proposal).toHaveCount(1);
    await expect(proposal).toContainText("Current systems and handoffs");
    await expect(proposal).toContainText("We track equipment returns in a spreadsheet.");
    await expect(group(page, "Current systems and handoffs")).toContainText("Not answered yet.");
    await proposal.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(proposal).toHaveCount(0);
    await expect(group(page, "Current systems and handoffs")).toContainText("We track equipment returns in a spreadsheet.");

    const observation = page.getByTestId("observation");
    await expect(observation).toContainText("Check whether late returns are logged");
    await observation.getByLabel(/Reason for closing/).fill("Late returns are only in the spreadsheet");
    await observation.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(observation).toHaveCount(0);

    // Explicit non-answers keep the gap visible without inventing facts.
    await group(page, "Current business rules").getByRole("button", { name: /I don.t know/ }).click();
    await expect(group(page, "Current business rules")).toContainText("Marked as not known yet.");
    const exceptions = group(page, "Current exceptions");
    await exceptions.getByRole("button", { name: "Ask the process owner", exact: true }).click();
    await exceptions.getByRole("textbox").fill("Dana Whitfield");
    await exceptions.getByRole("button", { name: "Save", exact: true }).click();
    await expect(exceptions).toContainText("Waiting for Dana Whitfield to answer.");
    await markNotApplicable(page, "Current financial effects", "Hire charges are billed by a separate team");
    await expect(page.getByTestId("open-decisions")).toContainText("Current business rules — not known yet");
    await expect(page.getByTestId("open-decisions")).toContainText("Current exceptions — waiting for Dana Whitfield");

    // Readiness names concrete missing items in plain language, never internal ids.
    await expect(page.getByTestId("blockers")).toContainText("Answer: Process owner");
    await expect(page.getByTestId("blockers")).not.toContainText(/\b(?:st_|rq_|g_)[A-Za-z0-9_-]+|process_owner|business_problem/);
    await expect(page.getByRole("button", { name: "Confirm current process", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Generate/ })).toHaveCount(0);

    // Reload resumes everything from the server.
    await page.reload();
    await expect(page.getByTestId("message-user")).toContainText(firstMessage);
    await expect(page.getByTestId("message-assistant").first().getByText("Why this matters:")).toHaveCount(2);
    await expect(group(page, "Current business rules")).toContainText("Marked as not known yet.");
    await expect(group(page, "Current exceptions")).toContainText("Waiting for Dana Whitfield to answer.");
    await expect(group(page, "Current systems and handoffs")).toContainText("We track equipment returns in a spreadsheet.");

    // Continue the conversation, then complete the remaining discovery through the visible controls.
    await say(page, "The rental coordinator Dana Whitfield owns it. It runs from dispatch to the final invoice.", 2);
    await answer(page, "Process owner", "Dana Whitfield, rental coordinator");
    await answer(page, "Process scope", "From dispatch to the final invoice");
    await answer(page, "Current initiating event", "A customer requests equipment");
    await answer(page, "Desired business outcome", "Accurate final invoices");
    await answer(page, "Desired controls", "A dated return record is required for audit");
    // Company context the interviewer now requires before confirmation (see CONTEXT_FIELD_IDS).
    for (const [label, text] of [["Process overview", "Dispatch, hire, return, then invoice"], ["Operating scale and volumes", "About 400 hires a month"],
      ["Retained and non-SAP systems and integrations", "The telematics system stays and sends usage"], ["Legal entities, sites and organisation structure", "One company with two depots"],
      ["Target SAP organisational units", "One company code and two plants"], ["SAP modules in scope", "Sales and Distribution, Finance"],
      ["External parties involved", "Hire customers and a courier"], ["Approval and delegation-of-authority rules", "Invoices above 5,000 need manager approval"],
      ["Localisation and compliance", "Local VAT and e-invoicing"], ["KPI baselines", "Invoice error rate is 8 percent"], ["KPI targets", "Invoice error rate below 1 percent"],
      ["Constraints", "Standard SAP only, no custom development"], ["Timeline and go-live", "Go live next January"], ["Required outputs", "Final invoice and return report"],
    ] as const) await answer(page, label, text);
    await page.getByRole("button", { name: "Add a current step", exact: true }).click();
    // Each step is one card: a heading, a definition list and a single edit toggle, never "Step 1 (...)" repeated per field.
    const card = page.getByRole("article", { name: /^Step 1/ });
    await expect(card.getByRole("heading", { name: /^Step 1/ })).toHaveCount(1);
    await expect(card.getByText(/Step 1.*:/)).toHaveCount(0);
    await answer(card, "Step name", "Record return");
    await answer(card, "Who does it", "Stores clerk");
    await answer(card, "System or record used", "Spreadsheet");
    await answer(card, "What starts it", "An asset physically returns");
    await answer(card, "What happens", "The clerk records the return date");
    await answer(card, "Inputs", "Return note");
    await answer(card, "Outputs", "Return record");
    await markNotApplicable(card, "Checks and approvals", "No approval exists today");
    await markNotApplicable(card, "Exceptions", "Exceptions are handled ad hoc");

    // Known answers are corrected through the one toggle, with no per-field Edit buttons.
    await expect(card.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await card.getByRole("button", { name: "Edit step", exact: true }).click();
    const form = page.getByRole("form", { name: /^Edit Step 1/ });
    await form.getByLabel("Who does it").fill("Senior stores clerk");
    await form.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(group(card, "Who does it")).toContainText("Senior stores clerk");
    await expect(card.getByRole("button", { name: "Edit step", exact: true })).toBeFocused();
    const context = page.getByRole("region", { name: "Business context" });
    await context.getByRole("button", { name: "Edit answers", exact: true }).click();
    const contextForm = page.getByRole("form", { name: "Edit business context" });
    await contextForm.getByLabel("Process owner").fill("Dana Whitfield, senior rental coordinator");
    await contextForm.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(group(context, "Process owner")).toContainText("senior rental coordinator");
    await page.getByLabel("What kind of item").selectOption("TO_BE_REQUIREMENT");
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    await answer(page, /^Future requirement 1 for Step 1/, "Require a return date before invoicing");

    // Confirm, then generate; the result is a draft for human review, never an approval.
    await expect(page.getByText("Everything required is answered.")).toBeVisible();
    await page.getByRole("button", { name: "Confirm current process", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirmed", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Generate To-Be design", exact: true }).click();
    const status = page.getByTestId("to-be-status");
    await expect(status).toContainText(/A To-Be draft was generated/, { timeout: 25000 });
    await expect(status).toContainText("has not been approved");
    expect(["BLOCKED", "HUMAN_REVIEW_REQUIRED"]).toContain(await status.getAttribute("data-state"));
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/consultant-desktop-v2.png`, fullPage: true });
    // The chat column stays in view while the summary scrolls.
    const chatPane = page.getByRole("tabpanel", { name: "Chat" });
    await page.evaluate(() => window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight / 2)));
    await expect.poll(async () => (await chatPane.boundingBox())?.y ?? 9999).toBeLessThan(40);
    await page.screenshot({ path: `${shots}/consultant-desktop-v2-scrolled.png` });
    await page.evaluate(() => window.scrollTo(0, 0));

    // The durable record, not just the page, shows the confirmed revision and the finished job.
    const db = new Client({ connectionString: database, connectionTimeoutMillis: 3000 });
    await db.connect();
    try {
      const jobs = (await db.query(`SELECT kind,status FROM consultant_jobs WHERE project_id=$1 ORDER BY created_at`, [id])).rows;
      // Each message also leaves one usage row for its background extraction (written when the extraction lands, so the
      // order against the chat row is not fixed).
      expect(jobs.map(job => job.kind).sort()).toEqual(["EXTRACTION", "EXTRACTION", "INTERVIEW", "INTERVIEW", "TO_BE"]);
      expect(jobs.every(job => job.status === "SUCCEEDED")).toBe(true);
      expect((await db.query(`SELECT 1 FROM discovery_versions WHERE project_id=$1`, [id])).rowCount).toBe(1);
    } finally { await db.end(); }

    await page.reload();
    await expect(page.getByRole("button", { name: "Confirmed", exact: true })).toBeDisabled();
    await expect(page.getByTestId("to-be-status")).toContainText("has not been approved");

    // The report: comparison, truthful status, labelled tests and a Markdown download.
    await page.getByTestId("report-link").click();
    await expect(page.getByRole("heading", { level: 1, name: /^To-Be design report/ })).toBeVisible();
    const reportStatus = page.getByTestId("report-status");
    await expect(reportStatus).toContainText(/Review status: (Blocked|Human review required)\./);
    await expect(reportStatus).not.toContainText(/Review status: Approved/i);
    await expect(reportStatus).toContainText("has not been approved");
    const comparison = page.getByRole("region", { name: "As-Is versus To-Be comparison table" });
    await expect(comparison.getByRole("columnheader", { name: "Proposed To-Be steps" })).toBeVisible();
    await expect(comparison.getByRole("rowheader", { name: /Record return/ })).toBeVisible();
    await expect(comparison.getByText(/Step 1:/).first()).toBeVisible();
    await expect(page.getByText("Specified — not executed").first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Traceability matrix table" })).toBeVisible();
    expect(await page.getByRole("article").first().innerText()).not.toMatch(/\b(?:st_|rq_|g_)[A-Za-z0-9_-]{6,}/);
    await page.screenshot({ path: `${shots}/report-desktop.png`, fullPage: true });

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download Markdown" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^to-be-.*\.md$/);
    const markdown = readFileSync((await download.path())!, "utf8");
    expect(markdown).toContain("## As-Is vs To-Be comparison");
    expect(markdown).toContain("Specified — not executed");
    expect(markdown).toMatch(/Review status: (Blocked|Human review required)\./);

    // Small screens: tables scroll inside their own container, never the page.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: /^To-Be design report/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${shots}/report-mobile.png`, fullPage: true });
  });
  expect(errors).toEqual([]);
});

test.describe("small screens", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("chat and summary are tabs and the review count follows the conversation", async ({ page }) => {
    test.setTimeout(90000);
    await setup(page);
    await startConversation(page);
    const chat = page.getByRole("tab", { name: "Chat" });
    await expect(page.getByRole("tablist", { name: "Conversation sections" })).toBeVisible();
    await expect(chat).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Your message")).toBeVisible();
    await expect(page.getByRole("tabpanel", { name: "Summary" })).toBeHidden();

    await withWorker(async () => {
      await say(page, firstMessage, 1);
      const summary = page.getByRole("tab", { name: /^Summary \(2 to review\)$/ });
      await expect(summary).toBeVisible();
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: `${shots}/consultant-mobile-chat.png`, fullPage: true });
      await summary.click();
      await expect(summary).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel", { name: "Chat" })).toBeHidden();
      await expect(page.getByTestId("proposal")).toBeVisible();
      await page.screenshot({ path: `${shots}/consultant-mobile-summary.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await summary.focus();
      await page.keyboard.press("ArrowLeft");
      await expect(chat).toHaveAttribute("aria-selected", "true");
      await expect(page.getByLabel("Your message")).toBeVisible();
    });
  });
});

test("accepting every pending proposal at once records the field, the proposed step and the proposed requirement", async ({ page }) => {
  test.setTimeout(90000);
  const walkthrough = "Dispatch books the truck by phone. The clerk logs the return in a spreadsheet. Invoices are wrong when the return is late.";
  await setup(page);
  await startConversation(page);
  await withWorker(async () => {
    await say(page, walkthrough, 1);
    const proposals = page.getByTestId("proposal");
    await expect(proposals).toHaveCount(3);
    await expect(proposals.filter({ hasText: "New current step: logs the return" })).toHaveCount(1);
    await expect(proposals.filter({ hasText: /Pain point for proposed step logs the return/i })).toHaveCount(1);
    await expect(proposals.filter({ hasText: "Current systems and handoffs" })).toHaveCount(1);
    const summary = page.getByRole("tabpanel", { name: "Summary" });
    await expect(summary.getByRole("article", { name: /^Step 1/ })).toHaveCount(0);

    await page.getByTestId("accept-all").click();

    await expect(proposals).toHaveCount(0);
    await expect(page.getByTestId("accept-all")).toHaveCount(0);
    const step = summary.getByRole("article", { name: /^Step 1/ });
    await expect(step).toBeVisible();
    await expect(step).toContainText("The clerk logs the return in a spreadsheet.");
    await expect(summary.getByText("Invoices are wrong when the return is late.")).toBeVisible();
    await expect(group(page, "Current systems and handoffs")).toContainText("Dispatch books the truck by phone.");
    // Durable: the decision survives a reload and nothing is left pending.
    await page.reload();
    await expect(page.getByTestId("proposal")).toHaveCount(0);
    await expect(page.getByRole("tabpanel", { name: "Summary" }).getByRole("article", { name: /^Step 1/ })).toBeVisible();
  });
});

test("the chat reply appears first and the proposals from background extraction follow", async ({ page }) => {
  test.setTimeout(90000);
  // The scripted extraction is held back for this marker message, so the order is observable and not a race.
  const slow = "Slow extraction. Dispatch books the truck by phone. The clerk logs the return in a spreadsheet. Invoices are wrong when the return is late.";
  await setup(page);
  await startConversation(page);
  await withWorker(async () => {
    await say(page, slow, 1);
    await expect(page.getByTestId("message-assistant").first()).toContainText("Thank you for that context.");
    // The conversation is already usable while extraction is still running.
    await expect(page.getByTestId("proposal")).toHaveCount(0);
    await expect(page.getByLabel("Your message")).toBeEnabled();
    // Then the proposals arrive without any further user action.
    await expect(page.getByTestId("proposal")).not.toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId("proposal").filter({ hasText: "Current systems and handoffs" })).toHaveCount(1);
  });
});
