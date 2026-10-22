// Browser-test worker: the real queue, job fencing, validation and persistence, with a scripted
// model in place of the provider. It proves the application path, not the quality of any AI output.
import { workConsultantQueues } from "../../../src/lib/consultant-workers";
import { getRuntime } from "../../../src/lib/runtime";
import type { createStageRunner } from "../../../src/lib/ai/runStage";
import type { InterviewInput } from "../../../src/lib/ai/discovery-interview";
import type { ToBeInput } from "../../../src/lib/ai/to-be";
import { rentalDraft } from "../../../fixtures/ai/to-be/rental-benchmark";

const metrics = (stage: "interview_turn" | "to_be") => ({ stage, provider: "stub" as const, model: "scripted-browser-double",
  inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 1, validationErrors: [] });

function interviewTurn(input: InterviewInput) {
  const message = input.currentMessage;
  const quote = message.text.split(/(?<=\.)\s/)[0]!.trim();
  const first = input.history.length === 0;
  const open = input.fields.find(field => field.id === "current_systems" && field.status === "EMPTY");
  return {
    schemaVersion: 1 as const, contextRevision: input.contextRevision,
    reply: "Thank you for that context." as const,
    // Questions come only from gaps the server says are active, in its order.
    questions: input.activeGaps.slice(0, 2).map(gap => ({ gapKey: gap.key, question: gap.detail.slice(0, 480),
      whyItMatters: "This lets me describe the current process accurately before we design anything." })),
    proposedUpdates: first && open ? [{ fieldId: open.id, operation: "PROPOSE_SET" as const, previousValue: null,
      value: quote, sourceId: message.id, quote }] : [],
    observations: first && open ? [{ kind: "FOLLOW_UP_SUGGESTION" as const, fieldIds: [open.id],
      detail: "Check whether late returns are logged anywhere other than the spreadsheet." }] : [],
  };
}

function design(input: ToBeInput) {
  const step = input.discovery.asIsSteps[0]!; const requirement = input.discovery.requirements[0]!;
  const target = rentalDraft.steps[0]!;
  return { ...rentalDraft, steps: [{ ...target, asIsStepIds: [step.id], requirementIds: [requirement.id],
    acceptanceTests: target.acceptanceTests.map(test => ({ ...test, requirementIds: [requirement.id] })) }],
  coverage: [{ requirementId: requirement.id, disposition: "IMPLEMENTED", stepIds: [target.id], decisionId: null,
    rationale: "Covered by the proposed hire step." }], conflictDecisions: [], openQuestions: [] };
}

const runStage = (async (stage: string, raw: unknown) => stage === "interview_turn"
  ? { payload: interviewTurn(raw as InterviewInput), metrics: metrics("interview_turn") }
  : { payload: { design: design(raw as ToBeInput) }, metrics: metrics("to_be") }) as ReturnType<typeof createStageRunner>;

const { services, consultantJobs, startQueue } = getRuntime();
await startQueue();
await consultantJobs.recover();
const shutdown = new AbortController();
await workConsultantQueues(services.queue, consultantJobs, runStage, { chatConcurrency: 2, batchConcurrency: 2, shutdown: shutdown.signal });
console.info("Consultant test worker ready");
const stop = async () => { shutdown.abort(); try { await services.close(); } finally { process.exit(0); } };
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
