import type { DetailedDesign } from "./design-quality";
import { REGISTER_GROUPS, groupOf, type RegisterGroup, type RegisterKey } from "./design-registers";
import { norm } from "./design-register-types";
import { idFamily, mentionsCode, textFields } from "./design-text-lint";
import type { ToBeInput } from "./to-be";
import { routeFindings, type Part, type ReviewOutcome, type RoutedFinding } from "./to-be-review";

/** The fix pass: after validation and the consistency review, every heuristic blocker and every unresolved review finding that names a part is sent back to
 * that part once (all findings for the same part in one call). These are the pure helpers: which blockers are fixable, which part owns each, what the repair
 * note says. Nothing here calls a model. */

type Blocker = { code: string; path: string; detail?: string };

/** Blockers a model call can clear by rewriting one part. The others (open questions, unverified implementations, licence entitlement, ...) are real open items. */
export const FIXABLE_BLOCKERS: ReadonlySet<string> = new Set([
  "OBJECTIVE_STEP_UNMAPPED", "OBJECTIVE_CONTEXT_UNCOVERED", "STATUS_TRANSITION_MISSING", "CONFIG_DOCUMENT_TYPE_MISSING", "CONFIG_CONFIRMATION_UNSUPPORTED",
  "CONTROL_UNMAPPED", "UNRESOLVED_CODE", "REPORT_PAIN_POINT_UNCOVERED", "E2E_STEP_UNCOVERED", "INTERFACE_STEP_UNCOVERED", "ROLE_STEP_UNCOVERED",
  "ROLE_ACTOR_UNMATCHED", "SOD_CONFLICT_STEPS", "PERIOD_END_MISSING", "ORG_CODE_NOT_IN_CONTEXT", "KPI_VALUE_IGNORED", "INTERNAL_TERM", "DANGLING_ID_REFERENCE",
  "TRUNCATED_TEXT", "LANGUAGE_FRAGMENT", "STATUS_MODEL_UNCOVERED", "STATUS_TRANSITION_STEP_MISMATCH", "ROLE_OWNER_UNCATALOGUED", "CUTOVER_INTERFACE_UNCOVERED",
  "REQUIRED_OUTPUT_UNCOVERED", "RULE_RESTATED", "BUILD_REALIZATION_UNLISTED",
]);
/** Some blockers point at a step but are cleared in a register: the interface, role or report row has to be added there. */
const GROUP_OF_CODE: Readonly<Record<string, RegisterGroup>> = { INTERFACE_STEP_UNCOVERED: "integration", ROLE_STEP_UNCOVERED: "governance", ROLE_ACTOR_UNMATCHED: "governance" };
/** Review findings about no part that can still be cleared by a step the design lacks. */
const NEW_STEP_KINDS: ReadonlySet<string> = new Set(["COVERAGE_GAP", "MISSING_LINK"]);

export const partPath = (part: Part, design: DetailedDesign) => part.type === "step" ? `draft.steps.${design.steps.findIndex(step => step.id === part.stepId)}` : `draft.${part.group}`;

/** The step or register group a blocker is cleared in. */
export function blockerPart(blocker: Blocker, design: DetailedDesign): Part | undefined {
  const group = GROUP_OF_CODE[blocker.code];
  if (group) return { type: "group", group };
  const step = /^draft\.steps\.(\d+)(?:\.|$)/.exec(blocker.path);
  if (step) { const found = design.steps[Number(step[1])]; return found && { type: "step", stepId: found.id }; }
  const key = groupOf(/^draft\.([A-Za-z]+)(?:\.|$)/.exec(blocker.path)?.[1] ?? "");
  return key && { type: "group", group: key };
}

export type FixTarget = { part: Part; blockers: Blocker[]; findingIndexes: number[] };
/** An open question the text cites that the outline does not hold: `stepIds` are the steps whose text cites it. */
export type MissingQuestion = { token: string; stepIds: string[] };
const key = (part: Part) => part.type === "step" ? `step:${part.stepId}` : `group:${part.group}`;

/** The id a DANGLING_ID_REFERENCE blocker names, when it follows the pattern of the design's own open questions (ETO-OQ-5-F1 beside ETO-OQ-1..5): then the question is what
 * is missing, and a step cannot supply it. Any other dangling id is a wrong citation, which the part that cites it corrects. */
function missingQuestionToken(blocker: Blocker, design: DetailedDesign): string | undefined {
  const token = blocker.code === "DANGLING_ID_REFERENCE" ? /^(\S+) does not exist/.exec(blocker.detail ?? "")?.[1] : undefined;
  const family = token && idFamily(token);
  return family && design.openQuestions.some(question => idFamily(question.id) === family) ? token : undefined;
}

/** The parts to send back, the busiest first, the unresolved review findings that need a step the design lacks (no part, a gap or a missing link), and the open questions
 * the text cites that the outline lacks (they need an outline patch, not a rewrite of the citing part).
 * `tried` are parts the consistency pass already sent back: their review findings are not sent again, their blockers are. */
export function collectTargets(design: DetailedDesign, blockers: readonly Blocker[], findings: readonly ReviewOutcome[] = [], tried: ReadonlySet<string> = new Set()):
  { targets: FixTarget[]; routed: RoutedFinding[]; newStep: number[]; newQuestions: MissingQuestion[] } {
  const targets = new Map<string, FixTarget>();
  const entry = (part: Part) => { const k = key(part); return targets.get(k) ?? (targets.set(k, { part, blockers: [], findingIndexes: [] }).get(k)!); };
  const questions = new Map<string, MissingQuestion>();
  for (const blocker of blockers) {
    const token = missingQuestionToken(blocker, design);
    if (token) {
      const citing = design.steps.filter(step => textFields(step).some(text => mentionsCode(text, token))).map(step => step.id);
      questions.set(token, { token, stepIds: citing });
      continue;
    }
    const part = FIXABLE_BLOCKERS.has(blocker.code) ? blockerPart(blocker, design) : undefined;
    if (part) entry(part).blockers.push(blocker);
  }
  const routed = routeFindings(design, findings);
  const newStep: number[] = [];
  routed.forEach((finding, i) => {
    if (findings[i]!.outcome !== "UNRESOLVED") return;
    if (!finding.parts.length) { if (NEW_STEP_KINDS.has(finding.kind)) newStep.push(i); return; }
    for (const part of finding.parts) if (!tried.has(key(part))) entry(part).findingIndexes.push(i);
  });
  const weight = (target: FixTarget) => target.blockers.length + target.findingIndexes.length;
  return { targets: [...targets.values()].sort((a, b) => weight(b) - weight(a)), routed, newStep, newQuestions: [...questions.values()] };
}

// --- the repair note --------------------------------------------------------------------------------------------------------------

const ids = (values: readonly string[]) => values.slice(0, 12).join(", ") + (values.length > 12 ? ", ..." : "");
const rowIndex = (path: string) => Number(/\.(\d+)$/.exec(path)?.[1] ?? /\.(\d+)\./.exec(path)?.[1] ?? -1);

/** One plain sentence for a blocker: what is open, computed from the design and the discovery so the part is told which ids it concerns. */
export function explainBlocker(blocker: Blocker, design: DetailedDesign, input: ToBeInput): string {
  const at = rowIndex(blocker.path);
  const requirements = input.discovery.requirements;
  switch (blocker.code) {
    case "OBJECTIVE_STEP_UNMAPPED": {
      const served = new Set((design.objectives ?? []).flatMap(row => row.stepIds ?? []));
      return `Steps ${ids(design.steps.filter(step => !served.has(step.id)).map(step => step.id))} are not served by any objective: add each to the stepIds of the objective it serves, or add an objective for it.`;
    }
    case "OBJECTIVE_CONTEXT_UNCOVERED": return "An answered desired outcome, KPI target or constraint in the company context is cited by no objective: cite it in the contextFieldIds of an objective that rests on it.";
    case "STATUS_TRANSITION_MISSING": {
      const model = design.documentStatusModels?.[at];
      const type = norm(model?.documentType ?? "");
      const missing = !model ? [] : design.steps.filter(step => step.outputDocuments.some(output => norm(output).includes(type)) && !model.transitions.some(item => item.stepId === step.id));
      return `The status model for "${model?.documentType ?? "?"}" records no status change for step ${ids(missing.map(step => step.id))}, which outputs that document: add a transition for it.`;
    }
    case "CONFIG_DOCUMENT_TYPE_MISSING": return `The configuration catalogue has no DOCUMENT_TYPE item matching the status model for "${design.documentStatusModels?.[at]?.documentType ?? "?"}": add one.`;
    case "CONFIG_CONFIRMATION_UNSUPPORTED": {
      const row = design.configurationCatalogue?.[at];
      return `Configuration item "${row?.name ?? "?"}" is marked CONFIRMED_IN_CATALOG, but no reference it cites mentions it: set the status to BUSINESS_TO_PROVIDE or NEEDS_VALIDATION with a note, or cite a reference whose capability or objects name it.`;
    }
    case "CONTROL_UNMAPPED": {
      const mapped = new Set((design.controlMappings ?? []).map(row => row.requirementId));
      return `Controls ${ids(requirements.filter(item => item.kind === "CONTROL" && !mapped.has(item.id)).map(item => item.id))} have no control mapping: add one for each, naming the step and mechanism that enforce it.`;
    }
    case "UNRESOLVED_CODE": return `This step names SAP codes that no configuration item or organisation unit defines (${blocker.detail ?? "see the step text"}): describe them generically, or name only codes the design defines.`;
    case "REPORT_PAIN_POINT_UNCOVERED": {
      const cited = new Set([...(design.reports ?? []), ...(design.kpis ?? [])].flatMap(row => row.requirementIds ?? []));
      return `Pain points ${ids(requirements.filter(item => item.kind === "PAIN_POINT" && !cited.has(item.id)).map(item => item.id))} are cited by no report or KPI: cite each in the requirementIds of the report that addresses it, or add a report.`;
    }
    case "E2E_STEP_UNCOVERED": {
      const walked = new Set((design.endToEndTests ?? []).flatMap(row => row.stepIds));
      return `Steps ${ids(design.steps.filter(step => !walked.has(step.id)).map(step => step.id))} are walked by no end-to-end test: add them to a test's stepIds or add a test.`;
    }
    case "INTERFACE_STEP_UNCOVERED": return `Step ${design.steps[at]?.id ?? "?"} is an INTEGRATION step but no interface lists it: add an interface row with this step in its stepIds.`;
    case "ROLE_STEP_UNCOVERED": return `No role is assigned to step ${design.steps[at]?.id ?? "?"}: add it to the stepIds of the role that performs it, or add a role.`;
    case "ROLE_ACTOR_UNMATCHED": return `The roles assigned to step ${design.steps[at]?.id ?? "?"} do not match its actor "${design.steps[at]?.actor ?? "?"}": name the role like the actor, or assign the step to a role that is.`;
    case "SOD_CONFLICT_STEPS": return `Segregation-of-duties assessment ${design.sodAssessments?.[at]?.id ?? "?"} records a conflict but names fewer than two steps: name the clashing steps, or record NO_CONFLICT_ASSESSED.`;
    case "PERIOD_END_MISSING": return "No period-end activity is listed: add the activities the scope touches, in the order they run.";
    case "ORG_CODE_NOT_IN_CONTEXT": return `Organisation unit ${design.orgStructure?.[at]?.id ?? "?"} is marked CODE_CONFIRMED but its code is in no company-context answer: set BUSINESS_TO_PROVIDE with a null code and an owner.`;
    case "KPI_VALUE_IGNORED": return `KPI ${design.kpis?.[at]?.id ?? "?"} says "not provided" for a baseline or target, but the company-context answers (kpi_baselines, kpi_targets) hold a value for this measure: copy it verbatim.`;
    case "STATUS_MODEL_UNCOVERED": return `Steps output documents with a lifecycle that have no status model (${blocker.detail ?? "see the steps"}): add one model per document type, with a transition at the step that changes its status.`;
    case "STATUS_TRANSITION_STEP_MISMATCH": return `Status model "${design.documentStatusModels?.[at]?.documentType ?? "?"}" attributes a transition to step ${blocker.detail ?? "?"}, which neither outputs nor handles that document: attribute each status change to the step whose action sets it.`;
    case "ROLE_OWNER_UNCATALOGUED": return `Owners that are not in the role catalogue (${blocker.detail ?? "see the part"}): name each owner exactly like a catalogue role (${ids((design.roles ?? []).map(role => role.name))}), or use that role's id.`;
    case "CUTOVER_INTERFACE_UNCOVERED": return `Interfaces to ${blocker.detail ?? "a counterpart system"} have no cutover item: add one per interface for its initial load or connection set-up (open documents, master or condition data, credentials, certificates), or say none is needed and why.`;
    case "REQUIRED_OUTPUT_UNCOVERED": return `Required outputs with no report or KPI (${blocker.detail ?? "see the company context"}): add a report or KPI for each, or add an out-of-scope statement that names it.`;
    case "RULE_RESTATED": return `Step ${design.steps[at]?.id ?? "?"} restates a rule of an earlier step (${blocker.detail ?? "?"}): refer to it as "as <rule id>" and write only what differs.`;
    case "BUILD_REALIZATION_UNLISTED": return `Step ${design.steps[at]?.id ?? "?"} names something to build (extension, custom field or logic, report, form, workflow) but is not realised as an extension or integration and no built fit-gap row lists it: set its implementation kind to EXTENSION or INTEGRATION, or reword it as standard.`;
    case "INTERNAL_TERM": return `Client text uses the generation process's working term "${blocker.detail ?? "?"}": reword it in business language.`;
    case "TRUNCATED_TEXT": return `Text that ${blocker.detail ?? "stops early"}: the sentence is not finished, so write it out in full.`;
    case "LANGUAGE_FRAGMENT": return `Text with a fragment that is not English (${blocker.detail ?? "see the part"}): rewrite it in English; SAP terms may stay.`;
    default: return blocker.code;
  }
}

/** A review finding as a line of a repair note. */
export const findingLine = (finding: Pick<ReviewOutcome, "kind" | "explanation" | "paths">) => `[${finding.kind}] ${finding.explanation} (elements: ${finding.paths.join(", ")})`;

const MAX_NOTE_LINES = 8;
/** The note for one part: everything still open about it, then the instruction to change only what that needs. */
export function fixNote(part: Part, lines: readonly string[]): string {
  const what = part.type === "step" ? `step ${part.stepId}` : `register group ${part.group} (${(REGISTER_GROUPS[part.group] as readonly RegisterKey[]).join(", ")})`;
  return `A check of the finished design found the following still open about ${what}: ${lines.slice(0, MAX_NOTE_LINES).join(" ")} Rewrite the complete answer so that each of these no longer holds, changing only what that needs and keeping every other field exactly as in "currentAnswer". Use only facts already in the input; invent nothing.`;
}

/** Note for the outline patch that adds the open question(s) the design's text cites but the outline lacks. */
export const newQuestionNote = (missing: readonly MissingQuestion[]) =>
  `The design's text cites open questions that the outline does not hold: ${missing.slice(0, MAX_NOTE_LINES).map(item => `"${item.token}" (cited in steps ${item.stepIds.length ? ids(item.stepIds) : "of the outline"})`).join("; ")}. Answer with submit_to_be_outline_patch: add each as an open question with exactly that id, the question the text says is held under it, the owner who must answer it, and affectedStepIds naming the steps that cite it. Leave everything else out of the patch.`;

/** Note for the outline patch that adds the step(s) the findings say are missing. */
export const newStepNote = (lines: readonly string[]) =>
  `A check of the finished design found something that no existing step can fix: ${lines.slice(0, MAX_NOTE_LINES).join(" ")} Answer with submit_to_be_outline_patch: add a complete step object for each missing step (a new unique id; sequence numbers run 1..n in order, so append at the end unless the order matters and then resend every step whose sequence changes), update the coverage rows whose stepIds change when a step takes over a requirement, and remove nothing unless a finding says an item is wrong. A step with no requirement of its own must set enablesStepIds. Leave everything else out of the patch.`;
