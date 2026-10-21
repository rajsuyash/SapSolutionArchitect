// Markdown and CSV renderings of the same ReportModel the page shows.
import { TEST_LABEL, testKindLabel, type Register, type ReportModel } from "./consultant-report";

/** Table cells cannot hold newlines or bare pipes. */
const cell = (value: string | number | boolean) => String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>") || "-";
const row = (...cells: (string | number | boolean)[]) => `| ${cells.map(cell).join(" | ")} |`;
const table = (head: string[], rows: string[]) => [row(...head), row(...head.map(() => "---")), ...rows, ""].join("\n");
const bullets = (items: string[]) => items.length ? items.map(item => `- ${item.replace(/\r?\n/g, " ")}`).join("\n") : "- None";
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report";

export function reportFilename(model: ReportModel, extension: "md" | "csv"): string {
  return `to-be-${slug(model.header.project)}-${slug(model.data.variant.code)}-r${model.header.sourceRevision}${extension === "csv" ? "-traceability" : ""}.${extension}`;
}

function registerTable(items: Register[]) {
  return items.length ? table(["Item", "Owner", "Affects", "State"], items.map(item => row(item.text, item.owner, item.affects, item.state))) : "None.\n";
}

export function renderMarkdown(model: ReportModel): string {
  const { header, summary } = model;
  const out: string[] = [];
  const add = (...lines: string[]) => out.push(...lines, "");
  add(`# To-Be design report: ${header.processName}`);
  add(`**Review status: ${model.statusCopy.label}.** ${model.statusCopy.detail}`);
  add(table(["Field", "Value"], [row("Project", `${header.project} (${header.client})`), row("Process variant", header.variant),
    row("Discovery revision", header.sourceRevision), row("Target product", header.product), row("Target release", header.release),
    row("Generated", header.generatedAt), row("Blockers", model.blockers.length)]));
  if (model.blockersByCategory.length) {
    add("## Blockers");
    for (const group of model.blockersByCategory) add(`### ${group.category}`, bullets(group.items.map(item => `${item.subject}: ${item.label} (code ${item.code})`)));
  }
  add("## Executive summary",
    `Scope: ${summary.asIsSteps} current steps (${summary.eliminated} eliminated by design) redesigned as ${summary.toBeSteps} To-Be steps, with ${summary.rules} business rules, ${summary.exceptions} exceptions and ${summary.tests} acceptance-test specifications (${TEST_LABEL.toLowerCase()}).`);
  add(table(["Requirement coverage", "Count"], [row("Total requirements", summary.requirements), row("Implemented in the To-Be design", summary.implemented),
    row("Deferred (approved decision)", summary.deferred), row("Rejected (approved decision)", summary.rejected)]));

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

  add("## To-Be steps");
  for (const view of model.steps) {
    const { step } = view;
    add(`### ${view.heading}`, `Status: **${view.status.label}**. Replaces: ${view.asIsNames.join(", ") || "-"}. Actor: ${step.actor}. Trigger: ${step.trigger}.`);
    add(`**Documents in:** ${step.inputDocuments.join(", ")}. **Documents out:** ${step.outputDocuments.join(", ")}.`);
    add("**Actions**", table(["Actor", "System", "Operation", "Fields"], step.actions.map(action => row(action.actor, action.system, action.operation, action.fields.join(", ")))));
    add("**Business rules**", table(["Id", "Condition", "Response"], step.businessRules.map(rule => row(rule.id, rule.condition, rule.response))));
    add("**Exceptions**", step.exceptions.length ? table(["Condition", "Response", "Owner"], step.exceptions.map(exception => row(exception.condition, exception.response, exception.owner)))
      : `Not applicable: ${step.exceptionsNotApplicableReason ?? "no reason recorded"}`);
    add(`**Effects:** inventory — ${step.effects.inventory}; financial — ${step.effects.financial}; ownership — ${step.effects.ownership}.`);
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
  add("## Registers", "### Open decisions and questions", registerTable(model.registers.questions), "### Source conflicts", registerTable(model.registers.conflicts),
    "### SAP validation points", registerTable(model.registers.sapPoints));
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Spreadsheet apps execute cells that start with these characters. */
const csvCell = (value: string) => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export function renderTraceabilityCsv(model: ReportModel): string {
  const head = ["Requirement", "Type", "Critical", "Statement", "Current step", "Disposition", "Rationale", "To-Be steps", "Rules", "Tests"];
  const lines = model.traceability.map(trace => [trace.label, trace.kindLabel, trace.critical ? "Yes" : "No", trace.statement, trace.asIs,
    trace.disposition, trace.rationale, trace.steps.join("; "), trace.rules.join("; "), trace.tests.join("; ")]);
  return [head, ...lines].map(line => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
