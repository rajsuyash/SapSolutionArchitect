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
const phase2 = "test-results/phase2";
const SECTIONS = ["Business context", "Current process (As-Is)", "Pain points and requirements", "Desired future", "Open decisions"] as const;
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
    // The extraction log line carries a `validationErrorCount` counter; only the word "Error" outside that key is a failure.
    expect(logs.join("").replaceAll("validationErrorCount", "")).not.toMatch(/Error|failed/i);
  }
}

const phase3a = "test-results/phase3a";
const phase3b = "test-results/phase3b";
const phase3c = "test-results/phase3c";
const phase4e = "test-results/phase4e";
const phase4b = "test-results/phase4b";
const phase4g = "test-results/phase4g";
const SNAPSHOT = "00000000-0000-4000-8000-000000000001";
/** Presents the conversation as confirmed with gaps (and its To-Be jobs as given) by rewriting the two read responses only.
 * Reaching "confirmed" through the real UI takes a full discovery walk-through, which the first test already covers end to end;
 * these tests are about how the confirmed state is worded and how a refused To-Be start is shown. Writes still reach the server. */
async function presentAsConfirmed(page: Page, jobs: unknown[]) {
  await page.route(/\/api\/projects\/[^/]+\/consultant\/[^/]+$/, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch(); const body = await response.json();
    body.data.confirmedSnapshotId = SNAPSHOT;
    body.data.state.confirmation = { revision: body.data.state.revision, by: "synthetic", at: new Date().toISOString(), withGaps: true };
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/api\/projects\/[^/]+\/consultant\/[^/]+\/jobs$/, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({ json: { success: true, data: { jobs } } });
  });
}
const toBeJob = (status: string, extra: object = {}) => ({ id: "00000000-0000-4000-8000-0000000000aa", kind: "TO_BE", status, inputRevision: 1, error: null, result: null, ...extra });
async function openConfirmedSummary(page: Page, jobs: unknown[]) {
  await setup(page);
  await startConversation(page);
  await presentAsConfirmed(page, jobs);
  await page.reload();
  await page.getByRole("tab", { name: /^Summary/ }).click();
  await expect(page.getByTestId("progress")).toBeVisible();
}

type Scope = Page | Locator;
const group = (scope: Scope, name: string | RegExp) => scope.getByRole("group", { name });
async function startConversation(page: Page) {
  await page.getByLabel("Which process are we discussing?").fill("Equipment hire");
  await page.getByRole("button", { name: "Start the conversation", exact: true }).click();
  await expect(page.getByLabel("Your message")).toBeFocused();
}
/** Reference sections fold. A real person opens one by pressing its summary row; this does nothing if it is already open. */
async function expand(page: Page, title: string) {
  const region = page.getByRole("region", { name: title, exact: true });
  const details = region.locator("details").first();
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await region.locator("summary").first().click();
  await expect(details).toHaveJSProperty("open", true);
}
const expandAll = async (page: Page) => { for (const title of SECTIONS) await expand(page, title); };
/** The summary pane's rendered height, as the layout engine measures it. */
const paneHeight = async (page: Page) => Math.round((await page.getByRole("tabpanel", { name: "Summary" }).boundingBox())!.height);
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
    await expandAll(page); // a fresh conversation starts with every empty section folded

    // The suggestion is evidence-backed and nothing is recorded until accepted.
    const proposal = page.getByTestId("proposal");
    await expect(proposal).toHaveCount(1);
    await expect(proposal).toContainText("Current systems and handoffs");
    // The suggested answer is the short one; the sentence it came from is shown as its source.
    await expect(proposal.getByRole("blockquote")).toHaveText("a spreadsheet");
    await expect(proposal.getByTestId("proposal-source")).toHaveText("From: We track equipment returns in a spreadsheet.");
    await expect(group(page, "Current systems and handoffs")).toContainText("Not answered yet.");
    await proposal.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(proposal).toHaveCount(0);
    await expect(group(page, "Current systems and handoffs")).toContainText("a spreadsheet");

    const observation = page.getByTestId("observation");
    await expect(observation).toContainText("Check whether late returns are logged");

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
    // Sections holding recorded answers reopen by themselves; the rest start folded again.
    await expect(page.getByRole("region", { name: "Current process (As-Is)", exact: true }).locator("details").first()).toHaveJSProperty("open", true);
    await expandAll(page);
    await expect(group(page, "Current business rules")).toContainText("Marked as not known yet.");
    await expect(group(page, "Current exceptions")).toContainText("Waiting for Dana Whitfield to answer.");
    await expect(group(page, "Current systems and handoffs")).toContainText("a spreadsheet");

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

    // Only the point to check is still open. That is a soft gap: a draft can be confirmed, the full confirmation cannot, so the
    // Summary offers exactly one enabled confirm action, and each open item is listed once.
    const readiness = page.getByRole("region", { name: "Ready to confirm?" });
    await expect(readiness.getByRole("button", { name: "Confirm as draft with gaps", exact: true })).toBeEnabled();
    await expect(readiness.getByRole("button", { name: "Confirm current process", exact: true })).toHaveCount(0);
    await expect(readiness.locator("button:enabled", { hasText: /^Confirm/ })).toHaveCount(1);
    await expect(readiness.locator("button:disabled", { hasText: /^Confirm/ })).toHaveCount(0);
    await expect(page.getByTestId("draft-gaps")).toHaveCount(1);
    await expect(page.getByTestId("blockers")).toHaveCount(0);
    const gaps = await readiness.locator("li").allInnerTexts();
    expect(gaps.length).toBeGreaterThan(0);
    expect(new Set(gaps).size).toBe(gaps.length);
    mkdirSync(phase4b, { recursive: true });
    await page.screenshot({ path: `${phase4b}/summary-draft-confirmable.png`, fullPage: true });
    await observation.getByLabel(/Reason for closing/).fill("Late returns are only in the spreadsheet");
    await observation.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(observation).toHaveCount(0);
    await expect(readiness.getByRole("button", { name: "Confirm as draft with gaps" })).toHaveCount(0);

    // Confirm, then generate; the result is a draft for human review, never an approval.
    await expect(page.getByText("Everything required is answered.")).toBeVisible();
    await expect(page.getByTestId("progress")).toHaveText("Everything needed is answered.");
    mkdirSync(phase2, { recursive: true });
    await page.screenshot({ path: `${phase2}/populated-desktop.png`, fullPage: true });
    await page.getByRole("button", { name: "Confirm current process", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirmed", exact: true })).toBeDisabled();
    // Confirmed but nothing generated yet: the overview's third step leads back to the conversation and claims no progress.
    const overview = await page.context().newPage();
    await overview.goto(`${origin}/projects/${id}`);
    const toBeStep = overview.getByRole("list", { name: "Project steps" }).getByRole("listitem").filter({ hasText: "Design the To-Be" });
    await expect(toBeStep.getByRole("link", { name: "Design the To-Be" })).toHaveAttribute("href", `/projects/${id}/consultant`);
    await expect(toBeStep).not.toContainText("(");
    await expect(overview.locator(".panel-description").filter({ hasText: "Synthetic client" }).first()).toContainText("Process mapped");
    await overview.close();
    await page.getByRole("button", { name: "Generate To-Be design", exact: true }).click();
    const status = page.getByTestId("to-be-status");
    await expect(status).toContainText(/A To-Be draft was generated/, { timeout: 25000 });
    await expect(status).toContainText("has not been approved");
    expect(["BLOCKED", "HUMAN_REVIEW_REQUIRED"]).toContain(await status.getAttribute("data-state"));
    mkdirSync(shots, { recursive: true });
    await expect(page.getByTestId("report-link")).toBeVisible();
    await page.screenshot({ path: `${phase2}/confirmed-desktop.png`, fullPage: true });
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

    // A server-rendered page sees the confirmation: the overview and the conversation page both mark mapping done.
    for (const href of [`${origin}/projects/${id}`, `${origin}/projects/${id}/consultant`]) {
      await page.goto(href);
      const mapping = page.getByRole("list", { name: "Project steps" }).getByRole("listitem").filter({ hasText: "Map the current process" });
      await expect(mapping).toContainText("(done)");
      // A generated To-Be that still needs review is a draft, never "done". Only the overview looks the To-Be up (checked below).
      const step = page.getByRole("list", { name: "Project steps" }).getByRole("listitem").filter({ hasText: "Design the To-Be" });
      await expect(step).not.toContainText("(done)");
    }

    // The overview leads to the report: step three links to it, the status says so, and the next-step link sits on the first screen
    // even when a long scope proposal follows it. The scope proposal itself is scripted; this test is about where the link goes.
    await page.route(/\/api\/projects\/[^/]+\/analysis$/, route => route.fulfill({ json: { success: true, data: {
      job: { id: "00000000-0000-4000-8000-0000000000bb", kind: "PROBLEM_ANALYSIS", status: "SUCCEEDED", progressLabel: "Scope proposed", error: null, result: null },
      canAnalyze: true,
      analysis: { scopeSummary: "Equipment hire returns and invoicing.", inputTruncated: false, clarifyingQuestions: ["Who approves credit notes?"],
        objectives: Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, text: `Objective ${i + 1} for accurate invoicing` })),
        painPoints: [{ id: "p1", text: "Late returns bill wrongly", quote: "Invoices are often wrong" }],
        proposedProcesses: Array.from({ length: 14 }, (_, i) => ({ ref: `r${i}`, level: 1 + (i % 3), name: `Process ${i + 1}`, module: "SD", rationale: "Needed for the return-to-invoice flow." })) } } } }));
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`${origin}/projects/${id}`);
      const step = page.getByRole("list", { name: "Project steps" }).getByRole("listitem").filter({ hasText: "Design the To-Be" });
      await expect(step).toContainText("(draft ready)");
      await expect(step).not.toContainText("(done)");
      await expect(step.getByRole("link", { name: "Design the To-Be" })).toHaveAttribute("href", /\/consultant\/[^/]+\/to-be\/[0-9a-f-]{36}$/);
      await expect(page.locator(".panel-description").filter({ hasText: "Synthetic client" }).first()).toContainText("To-Be draft ready");
      const next = page.locator('[data-action="next-step"]');
      await expect(next).toHaveText("Open the To-Be report");
      await expect(next).toHaveAttribute("href", await step.getByRole("link").getAttribute("href") as string);
      expect((await next.boundingBox())!.y, `report link offset at ${viewport.width}px`).toBeLessThan(viewport.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: `${phase4b}/overview-to-be-${viewport.width}.png` });
    }
    await page.getByRole("list", { name: "Project steps" }).getByRole("link", { name: "Design the To-Be" }).click();
    await expect(page.getByRole("heading", { level: 1, name: /^To-Be design report/ })).toBeVisible();
  });
  expect(errors).toEqual([]);
});

test.describe("a fresh conversation is short and oriented", () => {
  test.use({ viewport: { width: 1280, height: 720 } });
  test("it opens with a plain sentence, three blockers and folded sections, and stays under 1600px", async ({ page }) => {
    test.setTimeout(60000);
    await setup(page);
    await startConversation(page);
    const progress = page.getByTestId("progress");
    await expect(progress).toHaveAttribute("role", "status"); // announced to screen readers when the count changes
    await expect(progress).toHaveText(/^\d+ things? still needed before you can confirm\.$/);
    const total = Number(/^(\d+)/.exec(await progress.innerText())![1]);
    expect(total).toBeGreaterThan(3); // a fresh conversation has more blockers than the preview shows

    const blockers = page.getByTestId("blockers");
    const visible = await blockers.locator("li:visible").count();
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThanOrEqual(3);
    expect(await blockers.locator("li").count()).toBe(total); // every blocker is still in the page
    await expect(blockers.getByText(`Show all ${total}`)).toBeVisible();

    // The project's problem statement pre-fills "Business problem"; that alone does not open Business context.
    for (const title of SECTIONS) {
      await expect(page.getByRole("region", { name: title, exact: true }).locator("details").first(), title).toHaveJSProperty("open", false);
    }
    const collapsed = await paneHeight(page);
    expect(collapsed).toBeLessThan(1600);
    await page.screenshot({ path: `${phase2}/fresh-desktop.png`, fullPage: true });

    await expandAll(page);
    const expanded = await paneHeight(page);
    expect(expanded).toBeGreaterThan(collapsed); // control: the measurement moves when the sections open
    test.info().annotations.push({ type: "summary-pane-height", description: `collapsed ${collapsed}px, expanded ${expanded}px` });
    console.log(`summary pane height: collapsed ${collapsed}px, all sections expanded ${expanded}px`);
  });

  test("a section with recorded answers is open after a reload and the others stay folded", async ({ page }) => {
    test.setTimeout(60000);
    await setup(page);
    await startConversation(page);
    const open = (title: string) => page.getByRole("region", { name: title, exact: true }).locator("details").first();
    await expect(open("Desired future")).toHaveJSProperty("open", false);
    await expand(page, "Desired future");
    await answer(page, "Desired business outcome", "Accurate final invoices");
    await page.reload();
    await expect(open("Desired future")).toHaveJSProperty("open", true);
    await expect(group(page, "Desired business outcome")).toContainText("Accurate final invoices");
    await expect(page.getByRole("region", { name: "Desired future", exact: true }).locator("summary")).toContainText(/^Desired future1 of \d+ answered$/);
    await expect(open("Current process (As-Is)")).toHaveJSProperty("open", false);
  });

  test("text typed into a field survives folding and reopening its section", async ({ page }) => {
    test.setTimeout(60000);
    await setup(page);
    await startConversation(page);
    await expand(page, "Business context");
    const field = group(page, "Process owner");
    await field.getByRole("button", { name: "Answer", exact: true }).click();
    await field.getByRole("textbox").fill("Dana, not saved yet");
    const region = page.getByRole("region", { name: "Business context", exact: true });
    await region.locator("summary").click();
    await expect(region.locator("details")).toHaveJSProperty("open", false);
    await expect(field).toBeHidden();
    await region.locator("summary").click();
    await expect(field.getByRole("textbox")).toHaveValue("Dana, not saved yet");
  });
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

  test("proposed answers waiting in the Summary are pointed to from the chat, and the headline says so", async ({ page }) => {
    test.setTimeout(90000);
    await setup(page);
    await startConversation(page);
    await withWorker(async () => {
      await say(page, firstMessage, 1);
      const pointer = page.getByTestId("review-pointer");
      await expect(pointer).toContainText(/^1 proposed answer and 1 point to check are waiting for your review\./, { timeout: 15000 });
      // The pointer's numbers add up to the tab's number (one pending proposal plus one pending point to check).
      await expect(page.getByRole("tab", { name: /^Summary \(2 to review\)$/ })).toBeVisible();
      mkdirSync(phase3b, { recursive: true });
      await page.screenshot({ path: `${phase3b}/chat-pointer-390.png`, fullPage: true });
      mkdirSync(phase3c, { recursive: true });
      await page.screenshot({ path: `${phase3c}/pointer-both-390.png`, fullPage: true });
      await pointer.getByRole("button", { name: "Review them", exact: true }).click();
      await expect(page.getByRole("tab", { name: /^Summary/ })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("heading", { name: "Proposed answers to review" })).toBeFocused();
      await expect(page.getByTestId("proposal")).toBeVisible();
      await expect(page.getByTestId("progress")).toContainText(/still needed before you can confirm\. 1 proposed answer is waiting for your review\.$/);
      await page.screenshot({ path: `${phase3b}/summary-headline-pending-390.png` });
      await page.getByTestId("proposal").getByRole("button", { name: "Accept", exact: true }).click();
      await expect(page.getByTestId("progress")).not.toContainText("waiting for your review");
      await page.getByRole("tab", { name: /^Chat/ }).click();
      // The point to check is still pending, so the pointer stays and now names only it; the tab agrees.
      await expect(page.getByTestId("review-pointer")).toContainText(/^1 point to check is waiting for your review\./);
      await expect(page.getByRole("tab", { name: /^Summary \(1 to review\)$/ })).toBeVisible();
    });
  });

  test("a substantial message that yields nothing is said so in the chat, and a short one or a fruitful one is not", async ({ page }) => {
    test.setTimeout(90000);
    await setup(page);
    await startConversation(page);
    const notice = page.getByTestId("nothing-recorded");
    await withWorker(async () => {
      // The first message yields proposals: no notice.
      await say(page, firstMessage, 1);
      await expect(page.getByTestId("review-pointer")).toBeVisible({ timeout: 15000 });
      await expect(notice).toHaveCount(0);
      mkdirSync(phase4e, { recursive: true });
      await page.screenshot({ path: `${phase4e}/normal-390.png`, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: `${phase4e}/normal-1440.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      // A long second message yields nothing once extraction has finished: the notice appears, with a way forward.
      await say(page, "Dispatch also keeps a separate paper log at the gate, which the yard supervisor fills in by hand when a truck leaves, and nobody reads it afterwards.", 2);
      await expect(notice).toContainText(/^Nothing was recorded from your last message\./, { timeout: 15000 });
      await expect(notice).toContainText("Summary tab");
      await page.screenshot({ path: `${phase4e}/nothing-recorded-390.png`, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: `${phase4e}/nothing-recorded-1440.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      // A short reply that also yields nothing gets no notice, and the old one goes with the message it was about.
      await say(page, "Yes.", 3);
      await expect(page.getByTestId("message-assistant")).toHaveCount(3);
      await page.waitForTimeout(3000); // let its (empty) extraction finish
      await expect(notice).toHaveCount(0);
    });
  });

  test("the fresh summary fits the screen with its sections folded and open", async ({ page }) => {
    test.setTimeout(60000);
    await setup(page);
    await startConversation(page);
    await page.getByRole("tab", { name: /^Summary/ }).click();
    await expect(page.getByTestId("progress")).toBeVisible();
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await fits()).toBe(true);
    mkdirSync(phase2, { recursive: true });
    await page.screenshot({ path: `${phase2}/fresh-390-summary.png`, fullPage: true });
    await expandAll(page);
    expect(await fits()).toBe(true);
  });

  test("confirmed with gaps says one thing: confirmed as a draft, with the open items carried forward", async ({ page }) => {
    test.setTimeout(60000);
    await openConfirmedSummary(page, []);
    const progress = page.getByTestId("progress");
    await expect(progress).toContainText(/^Confirmed as a draft: \d+ open items? carried into the To-Be as open questions\.$/);
    await expect(progress).not.toContainText("before you can confirm");
    const summary = page.getByRole("tabpanel", { name: "Summary" });
    await expect(summary.getByRole("heading", { name: "Confirmed", level: 3 })).toBeVisible();
    await expect(summary.getByRole("heading", { name: "Ready to confirm?" })).toHaveCount(0);
    mkdirSync(phase3b, { recursive: true });
    await page.screenshot({ path: `${phase3b}/confirmed-heading-390.png` });
    await expect(summary.getByText("Open items carried into the To-Be:")).toBeVisible();
    await expect(summary.getByText("Still needed before this can be confirmed:")).toHaveCount(0);
    await expect(summary.getByRole("button", { name: "Confirmed", exact: true })).toBeDisabled();
    mkdirSync(phase3a, { recursive: true });
    await page.screenshot({ path: `${phase3a}/confirmed-draft-390.png`, fullPage: true });
  });

  test("a refused To-Be start is shown beside the button, replaces the old failure text and disables retry", async ({ page }) => {
    test.setTimeout(60000);
    await openConfirmedSummary(page, [toBeJob("FAILED", { error: { code: "TIMEOUT", message: "The To-Be design took too long to generate; you can retry." } })]);
    const status = page.getByTestId("to-be-status");
    await expect(status).toContainText("took too long");
    await page.route(/\/api\/projects\/[^/]+\/consultant\/[^/]+\/to-be$/, route => route.fulfill({ status: 429,
      json: { success: false, error: { code: "RATE_LIMITED", message: "Daily AI limit reached for this workspace. Try again tomorrow." } } }));
    const retry = page.getByRole("button", { name: "Retry To-Be generation", exact: true });
    await retry.click();
    const summary = page.getByRole("tabpanel", { name: "Summary" });
    const alert = summary.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Daily AI limit reached for this workspace.");
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(1); // not also in the (hidden) chat column
    await expect(status).toHaveCount(0); // the older failure text is gone while the newer refusal is shown
    await expect(retry).toBeDisabled();
    // The refusal sits next to the button the person pressed.
    const [alertBox, buttonBox] = [await alert.boundingBox(), await retry.boundingBox()];
    expect(Math.abs(alertBox!.y - buttonBox!.y)).toBeLessThan(400);
    mkdirSync(phase3a, { recursive: true });
    await page.screenshot({ path: `${phase3a}/to-be-refused-390.png`, fullPage: true });
  });

  test("while the To-Be generates, the button and status say so and the elapsed time moves", async ({ page }) => {
    test.setTimeout(60000);
    await openConfirmedSummary(page, [toBeJob("RUNNING")]);
    const summary = page.getByRole("tabpanel", { name: "Summary" });
    const button = summary.getByRole("button", { name: "Generating To-Be design…", exact: true });
    await expect(button).toBeDisabled();
    await expect(summary.getByRole("button", { name: "Generate a new To-Be draft" })).toHaveCount(0);
    const status = page.getByTestId("to-be-status");
    await expect(status).toContainText("This usually takes several minutes");
    const elapsed = page.getByTestId("to-be-elapsed");
    await expect(elapsed).toHaveText(/^Waiting on this page for \d+ s\.$/);
    expect(await status.locator("[data-testid=to-be-elapsed]").count()).toBe(0); // the ticking figure is outside the live region
    const first = await elapsed.innerText();
    await expect.poll(() => elapsed.innerText(), { timeout: 15000 }).not.toBe(first);
    mkdirSync(phase3a, { recursive: true });
    await page.screenshot({ path: `${phase3a}/to-be-generating-390.png`, fullPage: true });
  });

  test("a populated summary with long step names and an unbroken token still fits the screen", async ({ page }) => {
    test.setTimeout(90000);
    const token = "AssetReturnReconciliationLogEntry_2026_Final_ReviewedCopy_v2"; // 60 characters, no break opportunity
    const longName = `Reconcile the final hire invoice against the dispatch log, the signed return note and the depot damage report before release ${token}`;
    const walkthrough = `Dispatch books the truck by phone. The clerk logs the return in a spreadsheet and later ${token} is copied across by hand into three other registers. Invoices are wrong when the return is late and nobody updates ${token} afterwards.`;
    await setup(page);
    await startConversation(page);
    await withWorker(async () => {
      await say(page, walkthrough, 1);
      await page.getByRole("tab", { name: /^Summary/ }).click();
      await expect.poll(() => page.getByTestId("proposal").count(), { timeout: 15000 }).toBeGreaterThanOrEqual(2); // several pending proposals, left unreviewed
      await expandAll(page);
      await page.getByRole("button", { name: "Add a current step", exact: true }).click();
      await answer(page.getByRole("article", { name: /^Step 1/ }), "Step name", longName);
      await page.getByRole("button", { name: "Add item", exact: true }).click();
      await answer(page, /^(Pain point|Future requirement|.*requirement) 1 for Step 1/i, `${longName} ${longName}`);
      const heading = page.getByRole("article", { name: /^Step 1/ }).getByRole("heading", { level: 4 }).first();
      await expect(heading).toContainText(token);
      const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth,
        widest: [...document.querySelectorAll("main *")].map(el => ({ el, w: Math.round(el.getBoundingClientRect().right) })).filter(item => item.w > window.innerWidth)
          .slice(0, 6).map(item => `${item.el.tagName.toLowerCase()}.${String(item.el.className).split(" ")[0]}:${item.w}`) }));
      mkdirSync("test-results/phase3a", { recursive: true });
      await page.screenshot({ path: "test-results/phase3a/summary-populated-390.png", fullPage: true });
      expect(overflow.page, `page scrollWidth ${overflow.page} vs window ${overflow.window}; first overflowing: ${overflow.widest.join(", ")}`).toBeLessThanOrEqual(overflow.window);
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
    const folded = (title: string) => page.getByRole("region", { name: title, exact: true }).locator("details").first();
    await expect(folded("Current process (As-Is)")).toHaveJSProperty("open", false);

    await page.getByTestId("accept-all").click();

    await expect(proposals).toHaveCount(0);
    await expect(page.getByTestId("accept-all")).toHaveCount(0);
    // Content that just arrived is visible without the person having to open anything.
    await expect(folded("Current process (As-Is)")).toHaveJSProperty("open", true);
    await expect(folded("Pain points and requirements")).toHaveJSProperty("open", true);
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

test("a proposed step lists the details accepting it records, and the still-needed list no longer asks for them", async ({ page }) => {
  test.setTimeout(90000);
  const walkthrough = "Dispatch books the truck by phone, with details. The clerk logs the return in a spreadsheet when the truck arrives. Invoices are wrong when the return is late.";
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  await startConversation(page);
  await withWorker(async () => {
    await say(page, walkthrough, 1);
    const proposals = page.getByTestId("proposal");
    await expect(proposals).toHaveCount(3);
    const stepCard = proposals.filter({ hasText: "New current step: logs the return" });
    const details = stepCard.getByTestId("proposal-step-details");
    await expect(details).toBeVisible();
    await expect(details).toContainText("Who does it: The clerk");
    await expect(details).toContainText("System or record used: a spreadsheet");
    await expect(details).toContainText("What starts it: when the truck arrives");
    await expect(details.getByRole("listitem")).toHaveCount(3);
    // Only the step card carries details; a field or requirement card does not.
    await expect(page.getByTestId("proposal-step-details")).toHaveCount(1);
    mkdirSync(phase4g, { recursive: true });
    await stepCard.screenshot({ path: `${phase4g}/step-details-1440.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: /^Summary/ }).click();
    await expect(details).toBeVisible();
    await stepCard.scrollIntoViewIfNeeded();
    await stepCard.screenshot({ path: `${phase4g}/step-details-390.png` });
    const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, window: window.innerWidth }));
    expect(overflow.page).toBeLessThanOrEqual(overflow.window);

    await stepCard.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(proposals.filter({ hasText: "New current step" })).toHaveCount(0);
    const still = page.getByTestId("blockers");
    await expect(still).toContainText("Finish Step 1 (logs the return): inputs, outputs, controls and exceptions.");
    await expect(still).not.toContainText("who does it");
    await expand(page, "Current process (As-Is)");
    const step = page.getByRole("article", { name: /^Step 1/ });
    await expect(step).toContainText("The clerk");
    await expect(step).toContainText("a spreadsheet");
    await expect(step).toContainText("when the truck arrives");
    await page.screenshot({ path: `${phase4g}/after-accept-390.png`, fullPage: true });
  });
});

test("a section the person closed stays closed when more content arrives", async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  await startConversation(page);
  const folded = (title: string) => page.getByRole("region", { name: title, exact: true }).locator("details").first();
  const asIs = page.getByRole("region", { name: "Current process (As-Is)", exact: true });
  await asIs.locator("summary").click(); // open it, then close it again: an explicit choice
  await expect(folded("Current process (As-Is)")).toHaveJSProperty("open", true);
  await asIs.locator("summary").click();
  await expect(folded("Current process (As-Is)")).toHaveJSProperty("open", false);
  await withWorker(async () => {
    await say(page, "Dispatch books the truck by phone. The clerk logs the return in a spreadsheet. Invoices are wrong when the return is late.", 1);
    await expect(page.getByTestId("proposal")).toHaveCount(3);
    await page.getByTestId("accept-all").click();
    await expect(page.getByTestId("proposal")).toHaveCount(0);
    await expect(folded("Pain points and requirements")).toHaveJSProperty("open", true); // control: untouched sections do open
    await expect(folded("Current process (As-Is)")).toHaveJSProperty("open", false);
    await expect(page.getByRole("region", { name: "Current process (As-Is)", exact: true }).locator("summary")).toContainText(/1 step/);
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
