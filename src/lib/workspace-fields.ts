// Client-safe catalog and human labels for the discovery workspace. This module
// must stay free of runtime imports: browser components and the server model share it.
import type { WorkspaceState } from "./discovery-workspace-model";

/** Stable IDs, separate current practice from desired outcomes. The catalog is
 * deliberately small: process-specific detail belongs in steps and requirements. */
export const WORKSPACE_FIELDS = [
  { id: "business_problem", domain: "CONTEXT", label: "Business problem", question: "What business problem are you trying to solve?", priority: "CRITICAL" },
  { id: "process_owner", domain: "CONTEXT", label: "Process owner", question: "Who owns the current process and can confirm its rules?", priority: "CRITICAL" },
  { id: "scope_boundary", domain: "CONTEXT", label: "Process scope", question: "Where does this process begin and end, and which units or locations are in scope?", priority: "CRITICAL" },
  { id: "current_trigger", domain: "AS_IS", label: "Current initiating event", question: "What event starts the process today?", priority: "CRITICAL" },
  { id: "current_systems", domain: "AS_IS", label: "Current systems and handoffs", question: "Which applications, spreadsheets and handoffs are used today?", priority: "IMPORTANT" },
  { id: "current_rules", domain: "AS_IS", label: "Current business rules", question: "What approvals, timing rules or thresholds apply today?", priority: "IMPORTANT" },
  { id: "current_exceptions", domain: "AS_IS", label: "Current exceptions", question: "What happens today when a request is cancelled, corrected or fails?", priority: "IMPORTANT" },
  { id: "current_financial", domain: "AS_IS", label: "Current financial effects", question: "What pricing, billing, accounting or reconciliation occurs today?", priority: "IMPORTANT" },
  { id: "desired_outcome", domain: "DESIRED", label: "Desired business outcome", question: "What measurable outcome should the future process achieve?", priority: "CRITICAL" },
  { id: "desired_controls", domain: "DESIRED", label: "Desired controls", question: "Which future approvals, audit records or safeguards are required?", priority: "IMPORTANT" },
] as const;

export const STEP_KEYS = ["name", "actor", "system", "trigger", "description", "inputs", "outputs", "controls", "exceptions"] as const;
export type StepKey = (typeof STEP_KEYS)[number];
export const STEP_QUESTIONS: Record<StepKey, string> = {
  name: "What is this current process step called?", actor: "Who performs this step today?",
  system: "Which system or manual record is used in this step today?", trigger: "What starts this step today?",
  description: "What actually happens in this step today?", inputs: "Which documents or data enter this step today?",
  outputs: "Which documents or data leave this step today?", controls: "Which checks or approvals apply today?",
  exceptions: "What happens when this step fails or must be corrected today?",
};
export const STEP_LABELS: Record<StepKey, string> = {
  name: "Step name", actor: "Who does it", system: "System or record used", trigger: "What starts it",
  description: "What happens", inputs: "Inputs", outputs: "Outputs", controls: "Checks and approvals", exceptions: "Exceptions",
};
export const REQUIREMENT_KIND_LABELS = { PAIN_POINT: "Pain point", TO_BE_REQUIREMENT: "Future requirement", CONTROL: "Control" } as const;

type View = Pick<WorkspaceState, "steps" | "stepDrafts" | "requirements" | "requirementDrafts">;
type Blocker = { code: string; fieldId?: string; detail: string };

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
