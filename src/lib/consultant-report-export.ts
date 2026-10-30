// Markdown and CSV renderings of the same ReportModel the page shows.
import { productRelease } from "./sap-releases";
import { REVIEW_FINDINGS_CATEGORY, TEST_LABEL, testKindLabel, type Register, type ReportModel } from "./consultant-report";

/** Table cells cannot hold newlines or bare pipes. */
const cell = (value: string | number | boolean) => String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>") || "-";
const row = (...cells: (string | number | boolean)[]) => `| ${cells.map(cell).join(" | ")} |`;
const table = (head: string[], rows: string[]) => [row(...head), row(...head.map(() => "---")), ...rows, ""].join("\n");
const bullets = (items: string[]) => items.length ? items.map(item => `- ${item.replace(/\r?\n/g, " ")}`).join("\n") : "- None";
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report";

const FIT_CLASS_NAMES: Record<string, string> = { CLASSIC_RICEFW: "Classic custom development", SIDE_BY_SIDE_BTP: "Side-by-side (BTP)",
  KEY_USER_EXTENSION: "Key-user extension", STANDARD_INTEGRATION: "Standard integration",
  STEP_EXTENSION: "Extension step (from the step's realization)", STEP_INTEGRATION: "Integration step (from the step's realization)", CUSTOM_ANALYTICS: "Custom analytics (report or KPI)" };

export function reportFilename(model: ReportModel, extension: "md" | "csv"): string {
  return `to-be-${slug(model.header.project)}-${slug(model.data.variant.code)}-r${model.header.sourceRevision}${extension === "csv" ? "-traceability" : ""}.${extension}`;
}

function registerTable(items: Register[]) {
  return items.length ? table(["Item", "Owner", "Affects", "State"], items.map(item => row(item.text, item.owner, item.affects, item.state))) : "None.\n";
}

/** Client-origin text must not inject HTML or links into a Markdown viewer. Entities survive the cell escaping above. */
const neutralize = <T,>(value: T): T => typeof value === "string"
  ? value.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\[/g, "&#91;") as T
  : Array.isArray(value) ? value.map(neutralize) as T
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, neutralize(item)])) as T : value;

export function renderMarkdown(source: ReportModel): string {
  const model = neutralize(source);
  const { header, summary } = model;
  const out: string[] = [];
  const add = (...lines: string[]) => out.push(...lines, "");
  add(`# To-Be design report: ${header.processName}`);
  add(`**Review status: ${model.statusCopy.label}.** ${model.statusCopy.detail}`);
  if (model.catalogWarning) add(`**${model.catalogWarning}**`);
  add(table(["Field", "Value"], [row("Project", `${header.project} (${header.client})`), row("Process variant", header.variant),
    row("Discovery revision", header.sourceRevision), row("Target product", header.product), row("Target release", header.release),
    row("Generated", header.generatedAt), row("Blockers", model.blockers.length)]));
  const { documentControl: control } = model.derived;
  add("## Document control", table(["Field", "Value"], [row("Document", control.title), row("Version", control.version), row("Date", control.date),
    row("Review status", control.status), row("Design schema version", control.designSchemaVersion),
    row("Discovery revision", control.sourceRevision.discoveryRevision ?? "Not recorded"), row("Process variant", `${control.sourceRevision.variantName} (${control.sourceRevision.variantCode ?? "-"})`),
    row("Frozen revision id", control.sourceRevision.snapshotId ?? "Not recorded"), row("Target product and release", productRelease(header.product, control.sourceRevision.targetRelease))]),
  "**Sources (frozen revision)**", table(["Source", "Title", "Revision", "SHA-256 digest"], control.sourceRevision.sources.map(source => row(source.id, source.title, source.revision, source.digest))),
  "**Reviewers**", table(["Role", "Assigned to"], control.reviewerRoles.map(item => row(item.role, item.assignee))),
  "**Sign-off.** Nothing here is approved; each line is completed by a person.", table(["Role", "Name", "Date", "Status"], control.signOff.map(item => row(item.role, item.name, item.date, item.status))));
  const finding = (item: (typeof model.blockers)[number]) => `${item.subject}: ${item.label}${item.detail ? ` ${item.detail}` : ""} (code ${item.code}, at ${item.path})`;
  const findings = model.blockersByCategory.find(group => group.category === REVIEW_FINDINGS_CATEGORY);
  const blocking = model.blockersByCategory.filter(group => group !== findings);
  if (blocking.length) {
    add("## Blockers");
    for (const group of blocking) add(`### ${group.category}`, bullets(group.items.map(item => `${item.subject}: ${item.label}${item.detail ? ` ${item.detail}` : ""} (code ${item.code})`)));
  }
  if (findings) add("## Review findings", "The design is complete and valid. These checks compare one part of it with another and could not confirm a match; a consultant confirms or corrects each one.", bullets(findings.items.map(finding)));
  add("## Executive summary",
    `Scope: ${summary.asIsSteps} current steps (${summary.eliminated} eliminated by design) redesigned as ${summary.toBeSteps} To-Be steps, with ${summary.rules} business rules, ${summary.exceptions} exceptions and ${summary.tests} acceptance-test specifications (${TEST_LABEL.toLowerCase()}).`);
  add(table(["Requirement coverage", "Count"], [row("Total requirements", summary.requirements), row("Implemented in the To-Be design", summary.implemented),
    row("Deferred (approved decision)", summary.deferred), row("Rejected (approved decision)", summary.rejected)]));

  if (model.solution?.version3) {
    const { solution } = model;
    add("## Objectives and scope", "Objectives rest on the company-context answers; every To-Be step serves at least one.",
      table(["Id", "Objective", "Measure", "Based on", "Served by"], solution.objectives.map(item => row(item.id, item.statement, item.measure, item.basis, item.steps))),
      table(["Id", "Scope", "Statement", "Reason", "Based on"], solution.scope.map(item => row(item.id, item.kind, item.statement, item.reason, item.basis))));
  }

  add("## As-Is vs To-Be comparison");
  for (const item of model.comparison) {
    add(`### ${item.heading}`, `Status: **${item.status}**`);
    add(`**Today:** ${item.actor} using ${item.system}. Starts when: ${item.trigger}. ${item.description}`);
    add("**Problems and requirements:**", bullets(item.requirements.map(req => `${req.kindLabel}${req.critical ? " (critical)" : ""}: ${req.statement} Evidence: “${req.quote}”`)));
    if (item.eliminatedReason) add(`**Eliminated by design:** ${item.eliminatedReason}`);
    if (item.steps.length) {
      add(table(["To-Be step", "Actor", "Trigger", "Documents", "Key rules", "Exceptions", "SAP realization", "Status"], item.steps.map(view => row(view.heading, view.step.actor, view.step.trigger,
        `In: ${view.step.inputDocuments.join(", ")}. Out: ${view.step.outputDocuments.join(", ")}`,
        view.step.businessRules.map(rule => `${rule.id}: ${rule.condition} → ${rule.response}`).join("\n"),
        view.step.exceptions.length ? view.step.exceptions.map(exception => `${exception.condition} → ${exception.response}`).join("\n") : view.step.exceptionsNotApplicableReason ?? "None",
        `${view.implementation.kindLabel}${view.implementation.refs.length ? `: ${view.implementation.refs.map(ref => `${ref.capability} [${ref.id}]${ref.urls.length ? ` (${ref.urls[0]})` : ""}`).join("; ")}` : ""}`,
        view.status.label))));
    }
  }

  add("## As-Is narratives", "The current state as the client described it, kept apart from the To-Be design below. Text is quoted from discovery, not rewritten.");
  for (const item of model.derived.asIsNarratives) {
    add(`### Before: ${item.toBeTitle} (${item.toBeStepId})`);
    if (!item.asIs.length) add("No current step is replaced by this step.");
    for (const asIs of item.asIs) {
      add(`**${asIs.name}** (${asIs.asIsStepId}). Actor: ${asIs.actor}. System: ${asIs.system}. Starts when: ${asIs.trigger}`, asIs.description,
        `Inputs: ${asIs.inputs.join("; ") || "-"}. Outputs: ${asIs.outputs.join("; ") || "-"}. Controls: ${asIs.controls.join("; ") || "-"}. Exceptions: ${asIs.exceptions.join("; ") || "-"}.`);
    }
  }
  if (model.derived.eliminatedAsIs.length) add("### Current steps that disappear", table(["Current step", "What happens today", "Why it goes"],
    model.derived.eliminatedAsIs.map(item => row(item.name, item.description, item.reason))));

  add("## To-Be steps");
  for (const view of model.steps) {
    const { step } = view;
    add(`### ${view.heading}`, `Status: **${view.status.label}**. Replaces: ${view.asIsNames.join(", ") || "-"}. Actor: ${step.actor}. Trigger: ${step.trigger}.`);
    if (view.typeLabel || view.phase) add(`**Step type:** ${view.typeLabel || "-"}. **Phase:** ${view.phase || "-"}.${view.interimProcess ? ` **Interim process until it goes live:** ${view.interimProcess}` : ""}`);
    add(`**Documents in:** ${step.inputDocuments.join(", ")}. **Documents out:** ${step.outputDocuments.join(", ")}.`);
    add("**Actions**", table(["Actor", "System", "Operation", "Fields"], step.actions.map(action => row(action.actor, action.system, action.operation, action.fields.join(", ")))));
    add("**Business rules**", table(["Id", "Condition", "Response"], step.businessRules.map(rule => row(rule.id, rule.condition, rule.response))));
    add("**Exceptions**", step.exceptions.length ? table(["Condition", "Response", "Owner"], step.exceptions.map(exception => row(exception.condition, exception.response, exception.owner)))
      : `Not applicable: ${step.exceptionsNotApplicableReason ?? "no reason recorded"}`);
    add(`**Effects:** inventory — ${step.effects.inventory}; financial — ${step.effects.financial}; ownership — ${step.effects.ownership}.${step.effects.accountingEntry ? ` **Accounting entry:** ${step.effects.accountingEntry}` : ""}`);
    add(`**SAP realization (${view.implementation.kindLabel}):** ${view.implementation.detail}`);
    if (view.implementation.refs.length) add(bullets(view.implementation.refs.map(ref => `${ref.capability} [${ref.id}], ${ref.fit}${ref.objects.length ? `, objects: ${ref.objects.join(", ")}` : ""}${ref.urls.length ? `, evidence: ${ref.urls.join(" ")}` : ""}`)));
    add(`**Added value:** ${step.addedValue}`);
    add(`**Acceptance tests — ${TEST_LABEL}.** These are written specifications; none has been run.`,
      table(["Id", "Kind", "Given", "When", "Then", "Requirements", "Status"], step.acceptanceTests.map(test =>
        row(test.id, testKindLabel(test.kind), test.given, test.when, test.then, test.requirementIds.map(id => model.requirementLabels[id] ?? "Unknown requirement").join(", "), TEST_LABEL))));
  }

  add("## Traceability matrix", table(["Requirement", "Type", "Statement", "Current step", "Disposition", "Rationale", "To-Be steps", "Rules", "Tests"],
    model.traceability.map(trace => row(trace.label, `${trace.kindLabel}${trace.critical ? " (critical)" : ""}`, trace.statement, trace.asIs, trace.disposition,
      trace.rationale, trace.steps.join("; "), trace.rules.join("; "), trace.tests.join(", ")))));
  if (model.solution) {
    const { solution } = model;
    const section = (title: string, head: string[], rows: (string | number)[][]) =>
      add(`### ${title}`, rows.length ? table(head, rows.map(cells => row(...cells))) : "None recorded.");
    add("## Solution design registers", "Proposals for consultant review; none has been approved. Every SAP object named comes from the curated catalog or is marked as needing validation.");
    section("Key design decisions", ["Id", "Topic", "Options", "Recommendation", "Rationale", "Affects", "Based on", "Owner", "Status"],
      solution.decisions.map(item => [item.id, item.topic, item.options, item.recommendation, item.rationale, item.affects, item.basis, item.owner, item.status]));
    section("Fit-gap (clean core)", ["Requirement", "Statement", "Classification", "RICEFW type", "Justification", "SAP basis", "To-Be steps", "Mitigation", "Owner", "Status"],
      solution.fitGap.map(item => [item.requirement, item.statement, item.classification, item.ricefwType, item.justification, item.sap, item.steps || "-", item.mitigation, item.owner, item.status]));
    section("RICEFW list", ["Id", "Type", "Class", "Requirement", "Linked steps", "Rationale", "SAP basis", "Owner", "Status"],
      model.derived.ricefwList.map(item => [item.id, item.type, FIT_CLASS_NAMES[item.classification] ?? item.classification, (item.requirementId && model.requirementLabels[item.requirementId]) || "-",
        item.linkedSteps.map(step => `${step.id}: ${step.title}`).join("; ") || "-", item.rationale,
        [...item.referenceIds, ...(item.needsValidation ? [`needs validation: ${item.validationReason ?? "no reason recorded"}`] : [])].join("; ") || "-", item.owner ?? "-", item.status ?? "-"]));
    section("Organisation structure", ["Id", "Unit type", "Code", "Owner", "Parent", "Proposal", "Source", "Open point"],
      solution.orgStructure.map(item => [item.id, item.unitType, item.code, item.owner, item.parent, item.proposal, item.source, item.openPoint]));
    section("Master-data prerequisites", ["Id", "Object", "Owner", "Key fields and settings", "Creation channel", "Governance", "Migration source", "Used by"],
      solution.masterData.map(item => [item.id, item.object, item.owner, item.keyFields, item.creationChannel, item.governance, item.migrationSource, item.steps]));
    section("Interfaces", ["Id", "System", "System of record", "Direction", "Trigger and frequency", "Payload", "API candidate", "Error owner", "Failed messages", "Used by", "Scope"],
      solution.interfaces.map(item => [item.id, item.system, item.systemOfRecord, item.direction, item.trigger, item.payload, item.apiCandidate, item.errorOwner, item.failureHandling, item.steps, item.scope]));
    section("KPIs", ["Id", "KPI", "Baseline", "Target", "Measured from", "Owner", "Produced by", "Used by"],
      solution.kpis.map(item => [item.id, item.name, item.baseline, item.target, item.measuredFrom, item.owner, item.producedBy, item.steps]));
    if (solution.version3) {
      section("Reports", ["Id", "Report", "Purpose", "Realization", "SAP basis", "Used by"],
        solution.reports.map(item => [item.id, item.name, item.purpose, item.realization, item.sap, item.steps]));
      section("Document status models", ["Id", "Document type", "Statuses", "Transitions", "Edit and lock rules"],
        solution.statusModels.map(item => [item.id, item.documentType, item.statuses, item.transitions, item.editLock]));
      section("Configuration catalogue", ["Id", "Category", "Name", "Purpose", "Status", "Owner", "SAP basis", "Note", "Used by"],
        solution.configuration.map(item => [item.id, item.category, item.name, item.purpose, item.status, item.owner, item.sap, item.note, item.steps]));
      section("Role catalogue", ["Id", "Role", "Responsibilities", "Acts in"], solution.roles.map(item => [item.id, item.name, item.responsibilities, item.steps]));
      section("Actors and roles", ["Step", "Actor as written", "Role ids"], model.derived.actorRoles.map(item => [item.stepId, item.actor, item.roleIds.join(", ") || "-"]));
      section("Segregation of duties", ["Id", "Assessment", "Duties compared", "Roles", "Steps", "Mitigation"],
        solution.sod.map(item => [item.id, item.assessment, item.description, item.roles, item.steps, item.mitigation]));
      section("Control mappings", ["Id", "Control requirement", "Statement", "Mechanism", "How it works", "Rule", "Steps"],
        solution.controls.map(item => [item.id, item.requirement, item.statement, item.mechanism, item.realization, item.rule, item.steps]));
      section("End-to-end scenarios", ["Id", "Value stream", "Given", "When", "Then", "Steps", "Proves"],
        solution.endToEnd.map(item => [item.id, item.valueStream, item.given, item.when, item.then, item.steps, item.basis]));
    }
    section("Data migration", ["Sequence", "Id", "Object", "Source", "Approach", "Risk"],
      solution.dataMigration.map(item => [item.sequence, item.id, item.object, item.source, item.approach, item.risk]));
    section("Cutover", ["Sequence", "Id", "Activity", "Owner", "Risk"],
      solution.cutover.map(item => [item.sequence, item.id, item.activity, item.owner, item.risk]));
    if (solution.version3) section("Period-end activities", ["Sequence", "Id", "Activity", "Owner", "Steps"],
      solution.periodEnd.map(item => [item.sequence, item.id, item.activity, item.owner, item.steps]));
  }
  add("## Registers", "### Open decisions and questions", registerTable(model.registers.questions), "### Source conflicts", registerTable(model.registers.conflicts),
    "### SAP validation points", registerTable(model.registers.sapPoints));
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Spreadsheet apps execute cells that start with these characters. */
const csvCell = (value: string) => {
  // Leading whitespace and newlines are skipped by spreadsheets before a formula is recognised.
  const safe = /^[=+\-@\t\r\n]/.test(value) || /^[=+\-@]/.test(value.trimStart()) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export function renderTraceabilityCsv(model: ReportModel): string {
  const head = ["Requirement", "Type", "Critical", "Statement", "Current step", "Disposition", "Rationale", "To-Be steps", "Rules", "Tests"];
  const lines = model.traceability.map(trace => [trace.label, trace.kindLabel, trace.critical ? "Yes" : "No", trace.statement, trace.asIs,
    trace.disposition, trace.rationale, trace.steps.join("; "), trace.rules.join("; "), trace.tests.join("; ")]);
  // Fit-gap rows and every register row that cites requirements follow the requirement rows in the same columns.
  const solution = model.solution ? [
    ...model.solution.fitGap.map(item => {
      const trace = model.traceability.find(candidate => candidate.id === item.requirementId);
      return [item.requirement, `Fit-gap: ${item.classification}${item.ricefwType === "-" ? "" : ` (${item.ricefwType})`}`, trace?.critical ? "Yes" : "No", item.statement,
        trace?.asIs ?? "", item.classification, item.justification, item.stepTitles.join("; "), "", ""];
    }),
    ...model.solution.traces.map(item => [item.requirementIds.map(id => model.requirementLabels[id] ?? "Unknown requirement").join("; "), item.kind, "", item.summary,
      "", `Proposed (${item.label})`, "", item.stepTitles.join("; "), "", ""]),
  ] : [];
  return [head, ...lines, ...solution].map(line => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
