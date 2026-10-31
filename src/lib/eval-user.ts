// The simulated client of the evaluation driver (scripts/eval-consultant.ts): answers from a fixture, and plans the
// direct entry that completes a workspace from that fixture. Pure functions over a workspace state, no I/O.
import type { ScoringCase } from "./eval-score";
import { jaccard } from "./eval-score";
import { REASK_SUFFIX, STEP_GAP_PREFIX, STEP_KEYS } from "./workspace-fields";
import type { WorkspaceState } from "./discovery-workspace-model";

export type Fixture = ScoringCase & {
  opening: string; project: Record<string, unknown> & { variantCode: string; variantName: string };
  answerBank: { catalog: Record<string, string> };
  steps: ({ n: number } & Record<(typeof STEP_KEYS)[number], string>)[];
  requirements: { key: string; stepN: number; kind: "PAIN_POINT" | "TO_BE_REQUIREMENT" | "CONTROL"; critical: boolean; statement: string }[];
};
export type Command = Record<string, unknown>;

export type FixtureStep = Fixture["steps"][number];
const MATCH_THRESHOLD = 0.12;
const stepDraftOf = (state: WorkspaceState, fieldId: string) => state.stepDrafts.find(d => fieldId.startsWith(`${d.id}_`));
const factValue = (state: WorkspaceState, fieldId: string) => state.stepDrafts.flatMap(d => d.fields).find(f => f.id === fieldId)?.value ?? "";
export const firstSentence = (text: string) => text.trim().split(/(?<=[.!?])\s/)[0]!;

/** The fixture step a draft the interviewer created stands for: the best word overlap between the draft's own name and
 * description (plus any extra hint such as the question asked) and each fixture step. Null when nothing resembles it. */
export function fixtureStepFor(fixture: Fixture, state: WorkspaceState, draftId: string, hint = "", avoid = new Set<number>()): FixtureStep | null {
  const own = `${factValue(state, `${draftId}_name`)} ${factValue(state, `${draftId}_description`)}`;
  const ranked = fixture.steps.map(step => ({ step, score: jaccard(`${own} ${hint}`, `${step.name} ${step.description}`) +
    (own.toLowerCase().includes(step.name.toLowerCase()) ? 1 : 0) - (avoid.has(step.n) ? 0.5 : 0) })).sort((a, b) => b.score - a.score);
  return ranked[0] && ranked[0].score >= MATCH_THRESHOLD ? ranked[0].step : null;
}
/** What the simulated user would say for a field the interviewer asked about, or null when the bank has no answer. */
export function answerFor(fixture: Fixture, state: WorkspaceState, fieldId: string): string | null {
  const catalog = fixture.answerBank.catalog[fieldId];
  if (catalog) return catalog;
  const draft = stepDraftOf(state, fieldId);
  if (!draft) return null;
  return fixtureStepFor(fixture, state, draft.id)?.[fieldId.slice(draft.id.length + 1) as (typeof STEP_KEYS)[number]] ?? null;
}
const sentence = (text: string) => /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
/** One step in the client's voice, as a real client would walk through it: the work, then the problems and wishes tied to it. */
export function stepParagraph(fixture: Fixture, step: FixtureStep): string {
  const lead = { PAIN_POINT: "The problem here:", TO_BE_REQUIREMENT: "What we need:", CONTROL: "A control we need:" } as const;
  return [`For the "${step.name}" step, ${step.actor} does the work in ${step.system}.`, sentence(step.trigger), sentence(step.description),
    `The inputs are ${sentence(step.inputs)}`, `The outputs are ${sentence(step.outputs)}`,
    `The controls are ${sentence(step.controls)}`, sentence(step.exceptions),
    ...fixture.requirements.filter(r => r.stepN === step.n).map(r => `${lead[r.kind]} ${sentence(r.statement)}`)].join(" ");
}
export type Asked = { gapKey: string; fieldId: string; question: string };
/** The reply to an interviewer turn: a walkthrough question gets one paragraph about that step, any other asked field its
 * bank answer, anything the user cannot answer "I don't know". `answered` are fields the user spoke to directly, so a
 * missed capture can be seen (and counted as a direct edit); `told` remembers which fixture steps were already described. */
export function composeReply(fixture: Fixture, state: WorkspaceState, asked: Asked[], told: Set<number>) {
  const paragraphs: string[] = [], singles: string[] = [], answered: string[] = [], unknown: string[] = [];
  for (const q of asked) {
    if (q.gapKey.startsWith(STEP_GAP_PREFIX)) {
      const draftId = q.gapKey.slice(STEP_GAP_PREFIX.length).replace(new RegExp(`${REASK_SUFFIX}$`), "");
      const step = fixtureStepFor(fixture, state, draftId, q.question, told);
      if (step) { told.add(step.n); paragraphs.push(stepParagraph(fixture, step)); }
      else singles.push("I am not sure how to describe that part of the process.");
      continue;
    }
    const answer = answerFor(fixture, state, q.fieldId);
    if (answer) { singles.push(answer); answered.push(q.fieldId); } else unknown.push(q.fieldId);
  }
  const text = [...paragraphs, [...singles, ...(unknown.length ? ["I don't know the rest of that."] : [])].join(" ")]
    .filter(Boolean).join("\n\n");
  return { text: text || "I don't have anything more to add.", answered, unknown };
}
export function fieldCommand(state: WorkspaceState, fieldId: string, value: string | null): Command {
  const base = { status: value === null ? "UNKNOWN" : "KNOWN", value, rationale: null, owner: null, sourceId: null, quote: null };
  if (state.facts.some(f => f.id === fieldId)) return { type: "SET_FIELD", fieldId, ...base };
  const draft = state.requirementDrafts.find(d => `${d.id}_statement` === fieldId);
  if (draft) return { type: "SET_REQUIREMENT_DRAFT_STATEMENT", requirementDraftId: draft.id, ...base };
  return { type: "SET_STEP_DRAFT_FIELD", fieldId, ...base };
}
export function factStatus(state: WorkspaceState, fieldId: string) {
  return (state.facts.find(f => f.id === fieldId) ?? state.stepDrafts.flatMap(d => d.fields).find(f => f.id === fieldId)
    ?? state.requirementDrafts.map(d => d.statement).find(d => d.id === fieldId))?.status;
}


// --- direct entry --------------------------------------------------------------------------------------------------

const CORE = ["name", "actor", "system", "trigger", "description"] as const;
const isCore = (key: string) => (CORE as readonly string[]).includes(key);
/** What the server requires of a step before it can be confirmed (mirrors the readiness rule in discovery-workspace-model). */
const stepIsComplete = (draft: WorkspaceState["stepDrafts"][number]) => draft.fields.every(f => {
  const key = f.id.slice(draft.id.length + 1);
  return isCore(key) ? f.status === "KNOWN" : f.status === "KNOWN" || f.status === "NOT_APPLICABLE";
});

/** The direct edits that clear every readiness blocker that a fixture can answer: unanswered catalog fields, every blank
 * field of every incomplete step (a step that resembles no fixture step takes the best unused one, because a blocker that
 * stays is worth more to the evaluation than a perfect match), and every unstated requirement. `unresolved` names what the
 * fixture cannot supply (more drafts than fixture steps, or requirements). Commands apply in order without re-reading state. */
export function planForcedCompletion(fixture: Fixture, state: WorkspaceState): { commands: Command[]; unresolved: string[] } {
  const commands: Command[] = [], unresolved: string[] = [];
  for (const fact of state.facts) {
    const value = fixture.answerBank.catalog[fact.id];
    if (value && fact.status !== "KNOWN") commands.push(fieldCommand(state, fact.id, value));
  }
  const used = new Set<number>(), mapped = new Map<string, FixtureStep>();
  for (const draft of state.stepDrafts) {
    const step = fixtureStepFor(fixture, state, draft.id, "", used);
    if (step) { used.add(step.n); mapped.set(draft.id, step); }
  }
  for (const draft of state.stepDrafts) {
    if (stepIsComplete(draft)) continue;
    const step = mapped.get(draft.id) ?? fixture.steps.find(s => !used.has(s.n));
    if (!step) { unresolved.push(`step ${draft.id}: no unused fixture step`); continue; }
    used.add(step.n); mapped.set(draft.id, step);
    for (const fact of draft.fields) {
      const key = fact.id.slice(draft.id.length + 1) as (typeof STEP_KEYS)[number];
      const keep = fact.status === "KNOWN" || (!isCore(key) && fact.status === "NOT_APPLICABLE");
      if (!keep) commands.push(fieldCommand(state, fact.id, step[key]));
    }
  }
  const taken = new Set<string>();
  for (const draft of state.requirementDrafts) {
    if (draft.statement.status === "KNOWN") continue;
    const own = mapped.get(draft.asIsStepId)?.n;
    const pick = fixture.requirements.find(r => !taken.has(r.key) && r.kind === draft.kind && r.stepN === own)
      ?? fixture.requirements.find(r => !taken.has(r.key) && r.kind === draft.kind && !state.requirementDrafts.some(d => d.statement.value === r.statement));
    if (!pick) { unresolved.push(`requirement ${draft.id}: no unused fixture ${draft.kind}`); continue; }
    taken.add(pick.key);
    commands.push(fieldCommand(state, draft.statement.id, pick.statement));
  }
  return { commands, unresolved };
}
