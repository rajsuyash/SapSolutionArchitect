// Client-safe catalog and human labels for the discovery workspace. This module
// must stay free of runtime imports: browser components and the server model share it.
import type { WorkspaceState } from "./discovery-workspace-model";

/** Stable IDs, separate current practice from desired outcomes. `tier` orders the interview: 0 critical business
 * context, 1 landscape, 2 process detail, 3 KPIs, targets and constraints. Process-specific detail belongs in steps
 * and requirements. A field added later is backfilled EMPTY into older persisted workspaces on read. */
export const WORKSPACE_FIELDS = [
  { id: "business_problem", domain: "CONTEXT", tier: 0, label: "Business problem", question: "What business problem are you trying to solve?", priority: "CRITICAL" },
  { id: "process_overview", domain: "CONTEXT", tier: 0, label: "Process overview", question: "Can you take me through the process from start to finish, stage by stage?", priority: "IMPORTANT" },
  { id: "process_owner", domain: "CONTEXT", tier: 0, label: "Process owner", question: "Who owns the current process and can confirm its rules?", priority: "CRITICAL" },
  { id: "scope_boundary", domain: "CONTEXT", tier: 0, label: "Process scope", question: "Where does this process begin and end, and which units or locations are in scope?", priority: "CRITICAL" },
  { id: "operating_scale", domain: "CONTEXT", tier: 0, label: "Operating scale and volumes", question: "How large is the operation: revenue, headcount and the monthly volume of orders, invoices or other documents?", priority: "CRITICAL" },
  { id: "retained_systems", domain: "AS_IS", tier: 1, label: "Retained and non-SAP systems and integrations", question: "Which current systems will stay after go-live, and what must they exchange with SAP?", priority: "CRITICAL" },
  { id: "current_systems", domain: "AS_IS", tier: 1, label: "Current systems and handoffs", question: "Which applications, spreadsheets and handoffs are used today?", priority: "IMPORTANT" },
  { id: "legal_entities", domain: "CONTEXT", tier: 1, label: "Legal entities, sites and organisation structure", question: "Which legal entities, plants, warehouses and sales or service units are involved, and how do they relate?", priority: "IMPORTANT" },
  { id: "target_org_units", domain: "CONTEXT", tier: 1, label: "Target SAP organisational units", question: "Which SAP organisational units are planned, such as company codes, plants, sales organisations or storage locations?", priority: "IMPORTANT" },
  { id: "modules_in_scope", domain: "CONTEXT", tier: 1, label: "SAP modules in scope", question: "Which business areas or SAP modules should the project cover?", priority: "IMPORTANT" },
  { id: "external_parties", domain: "AS_IS", tier: 1, label: "External parties involved", question: "Which customers, vendors, banks or authorities does the process exchange documents or data with?", priority: "IMPORTANT" },
  { id: "current_trigger", domain: "AS_IS", tier: 2, label: "Current initiating event", question: "What event starts the process today?", priority: "CRITICAL" },
  { id: "current_rules", domain: "AS_IS", tier: 2, label: "Current business rules", question: "What approvals, timing rules or thresholds apply today?", priority: "IMPORTANT" },
  { id: "approval_rules", domain: "AS_IS", tier: 2, label: "Approval and delegation-of-authority rules", question: "Who approves what, up to which value, and who can stand in for them?", priority: "IMPORTANT" },
  { id: "current_exceptions", domain: "AS_IS", tier: 2, label: "Current exceptions", question: "What happens today when a request is cancelled, corrected or fails?", priority: "IMPORTANT" },
  { id: "current_financial", domain: "AS_IS", tier: 2, label: "Current financial effects", question: "What pricing, billing, accounting or reconciliation occurs today?", priority: "IMPORTANT" },
  { id: "localization_compliance", domain: "CONTEXT", tier: 2, label: "Localisation and compliance", question: "Which tax, e-invoicing or statutory requirements must the process meet?", priority: "IMPORTANT" },
  { id: "kpi_baselines", domain: "AS_IS", tier: 3, label: "KPI baselines", question: "Which measures do you track today, and what are their current values?", priority: "CRITICAL" },
  { id: "desired_outcome", domain: "DESIRED", tier: 3, label: "Desired business outcome", question: "What measurable outcome should the future process achieve?", priority: "CRITICAL" },
  { id: "kpi_targets", domain: "DESIRED", tier: 3, label: "KPI targets", question: "What target value should each of those measures reach, and by when?", priority: "CRITICAL" },
  { id: "constraints", domain: "DESIRED", tier: 3, label: "Constraints", question: "What constraints apply: standard versus custom development, systems to keep or retire, and budget?", priority: "CRITICAL" },
  { id: "desired_controls", domain: "DESIRED", tier: 3, label: "Desired controls", question: "Which future approvals, audit records or safeguards are required?", priority: "IMPORTANT" },
  { id: "timeline", domain: "CONTEXT", tier: 3, label: "Timeline and go-live", question: "When do you need to go live, and are there fixed dates or phases?", priority: "IMPORTANT" },
  { id: "required_outputs", domain: "DESIRED", tier: 3, label: "Required outputs", question: "Which documents, reports and forms must the process produce, and for whom?", priority: "IMPORTANT" },
] as const;

/** Gap keys: `g_<fieldId>` asks one catalog, step or requirement field; `gstep_<draftId>` asks for a whole step
 * walkthrough. `_r2` is the single permitted re-ask of a gap that stayed unanswered. */
export const STEP_GAP_PREFIX = "gstep_";
export const REASK_SUFFIX = "_r2";
export const REASK_AFTER_USER_TURNS = 3;

export const STEP_KEYS = ["name", "actor", "system", "trigger", "description", "inputs", "outputs", "controls", "exceptions"] as const;
export type StepKey = (typeof STEP_KEYS)[number];
export const STEP_QUESTIONS: Record<StepKey, string> = {
  name: "What is this current process step called?", actor: "Who performs this step today?",
  system: "Which system or manual record is used in this step today?", trigger: "What starts this step today?",
  description: "What actually happens in this step today?", inputs: "Which documents or data enter this step today?",
  outputs: "Which documents or data leave this step today?", controls: "Which checks or approvals apply today?",
  exceptions: "What happens when this step fails or must be corrected today?",
};
/** Stands in for a step detail the consultant has not confirmed, in a discovery confirmed as a draft with gaps. */
export const TO_CONFIRM = "To confirm";
export const STEP_LABELS: Record<StepKey, string> = {
  name: "Step name", actor: "Who does it", system: "System or record used", trigger: "What starts it",
  description: "What happens", inputs: "Inputs", outputs: "Outputs", controls: "Checks and approvals", exceptions: "Exceptions",
};
export const REQUIREMENT_KIND_LABELS = { PAIN_POINT: "Pain point", TO_BE_REQUIREMENT: "Future requirement", CONTROL: "Control" } as const;

type View = Pick<WorkspaceState, "steps" | "stepDrafts" | "requirements" | "requirementDrafts">;
type Blocker = { code: string; fieldId?: string; detail: string; soft?: true };

/** Position-based name, never the internal id: "Step 2 (Record return)". */
export function stepLabel(state: View, stepId: string): string {
  const steps = [...state.steps, ...state.stepDrafts];
  const index = steps.findIndex(step => step.id === stepId);
  if (index < 0) return "a process step";
  const step = steps[index]!;
  const name = "name" in step ? step.name : step.fields.find(field => field.id === `${step.id}_name`)?.value;
  return name ? `Step ${index + 1} (${name})` : `Step ${index + 1}`;
}

export function requirementLabel(state: View, draftId: string): string {
  const index = state.requirementDrafts.findIndex(draft => draft.id === draftId);
  const draft = state.requirementDrafts[index];
  if (!draft) return "a requirement";
  return `${REQUIREMENT_KIND_LABELS[draft.kind]} ${index + 1 + state.requirements.length} for ${stepLabel(state, draft.asIsStepId)}`;
}

/** Human label and question for any field id the workspace can ask about. */
export function describeField(state: View, fieldId: string): { label: string; question: string } {
  const catalog = WORKSPACE_FIELDS.find(field => field.id === fieldId);
  if (catalog) return { label: catalog.label, question: catalog.question };
  const draft = state.stepDrafts.find(item => fieldId.startsWith(`${item.id}_`));
  if (draft) {
    const key = fieldId.slice(draft.id.length + 1) as StepKey;
    if (STEP_KEYS.includes(key)) return { label: `${stepLabel(state, draft.id)}: ${STEP_LABELS[key]}`, question: STEP_QUESTIONS[key] };
  }
  const requirement = state.requirementDrafts.find(item => `${item.id}_statement` === fieldId);
  if (requirement) return { label: requirementLabel(state, requirement.id),
    question: requirement.kind === "PAIN_POINT" ? "What fails or causes delay in this step, and what is the business impact?"
      : "What should change in the future process, and what outcome would show it works?" };
  return { label: "Discovery detail", question: "" };
}

type ProposalView = { operation: string; fieldId: string; nameHint?: string | null; stepRef?: string | null;
  kind?: keyof typeof REQUIREMENT_KIND_LABELS | null };
/** Label for a proposal card: field proposals use the field label; structure proposals describe what would be created. */
export function describeProposal(state: View & { proposals: (ProposalView & { id: string })[] }, proposal: ProposalView): string {
  if (proposal.operation === "PROPOSE_STEP") return proposal.nameHint ? `New current step: ${proposal.nameHint}` : "New current step";
  if (proposal.operation !== "PROPOSE_REQUIREMENT") return describeField(state, proposal.fieldId).label;
  const ref = proposal.stepRef ?? "";
  const proposed = state.proposals.find(item => item.id === ref);
  const target = proposed ? (proposed.nameHint ? `proposed step ${proposed.nameHint}` : "a proposed step") : stepLabel(state, ref);
  return `${REQUIREMENT_KIND_LABELS[proposal.kind ?? "PAIN_POINT"]} for ${target}`;
}

/** What a draft confirmation carries into the To-Be as open questions: one per unfinished step and one per pending observation
 * (the readiness list has a single OBSERVATIONS_PENDING entry for all of them, so its length is not the count). */
export function carriedGaps(state: { observations: readonly { status: string }[] }, blockers: readonly Pick<Blocker, "code">[]) {
  const steps = blockers.filter(blocker => blocker.code === "AS_IS_STEP_INCOMPLETE").length;
  const points = state.observations.filter(observation => observation.status === "PENDING").length;
  const parts = [steps && `${steps} unfinished step${steps === 1 ? "" : "s"}`, points && `${points} point${points === 1 ? "" : "s"} to check`].filter(Boolean).join(" and ");
  return { steps, points, total: steps + points, parts };
}

/** Readiness copy for people: blockers carry internal ids in `detail`. */
export function describeBlocker(state: View, blocker: Blocker): string {
  const id = /(?:step|requirement) (\S+)$/.exec(blocker.detail)?.[1] ?? "";
  switch (blocker.code) {
    case "FIELD_UNANSWERED": return `Answer: ${blocker.detail}`;
    case "CRITICAL_FIELD_UNRESOLVED": return `${blocker.detail} needs an answer. “I don’t know”, “Not applicable” or “Ask the process owner” cannot be confirmed yet.`;
    case "AS_IS_STEP_MISSING": return "Describe at least one current process step.";
    case "AS_IS_STEP_INCOMPLETE": return `Finish ${stepLabel(state, id)}: name, who does it, system, trigger and what happens.`;
    case "REQUIREMENT_MISSING": return "Record at least one pain point or desired requirement.";
    case "REQUIREMENT_INCOMPLETE": return `Finish ${requirementLabel(state, id)}.`;
    case "PROPOSALS_PENDING": return "Accept, edit or reject the proposed answers.";
    case "OBSERVATIONS_PENDING": return "Review the possible contradictions.";
    default: return blocker.detail;
  }
}
