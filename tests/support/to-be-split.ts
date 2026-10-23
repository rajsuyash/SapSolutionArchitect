/** Test transport helpers for the skeleton-then-expansion To-Be pipeline: split a full DetailedDesign into the
 * outline and per-step payloads the model is asked for, and route a fake provider's answer by requested tool. */
import type { DetailedDesign } from "../../src/lib/ai/design-quality";
import type { StepDetail } from "../../src/lib/ai/to-be-pipeline";
import { rentalRegisterGroups } from "../../fixtures/ai/to-be/rental-registers";
import type { RegisterGroup } from "../../src/lib/ai/design-registers";

export type RequestBody = { model: string; system: string; messages: { content: string }[];
  tools: { name: string; input_schema: unknown }[]; tool_choice: unknown; thinking?: unknown; output_config?: unknown };

export function splitDesign(design: DetailedDesign) {
  const outline = {
    schemaVersion: 1 as const, processName: design.processName,
    steps: design.steps.map(({ id, sequence, title, asIsStepIds, requirementIds, implementation }) => ({
      id, sequence, title, purpose: `Purpose of ${title}`, asIsStepIds, requirementIds,
      implementation: { kind: implementation.kind, referenceIds: implementation.referenceIds } })),
    eliminatedAsIsSteps: design.eliminatedAsIsSteps, coverage: design.coverage,
    conflictDecisions: design.conflictDecisions, openQuestions: design.openQuestions,
  };
  const details: Record<string, StepDetail> = Object.fromEntries(design.steps.map(step => {
    const rest: Record<string, unknown> = { ...step };
    for (const key of ["id", "sequence", "title", "asIsStepIds", "requirementIds"]) delete rest[key];
    return [step.id, { ...rest, implementation: { detail: step.implementation.detail } } as StepDetail];
  }));
  return { outline, details };
}

/** Which tool a request asked the model to call (a register call names its group in the tool). */
export const toolOf = (body: RequestBody) => body.tools[0]!.name as "submit_to_be_outline" | "submit_to_be_outline_patch" | "submit_to_be_step" | "submit_to_be" | "submit_to_be_review" | `submit_to_be_registers_${RegisterGroup}`;
export const registerGroupOf = (body: RequestBody) => (toolOf(body).startsWith("submit_to_be_registers_") ? toolOf(body).slice("submit_to_be_registers_".length) : undefined) as RegisterGroup | undefined;
/** The step id a submit_to_be_step request is about (read from the request payload, never from the model). */
export const stepIdOf = (body: RequestBody) => (JSON.parse(body.messages[0]!.content) as { step: { id: string } }).step.id;

export function toolResponse(output: unknown, name: string, stop = "tool_use", usage = { input_tokens: 100, output_tokens: 200 }) {
  return new Response(JSON.stringify({ id: "msg_synthetic", type: "message", role: "assistant", model: "synthetic",
    content: [{ type: "tool_use", id: "tool_synthetic", name, input: output }], stop_reason: stop, usage }),
  { headers: { "content-type": "application/json" } });
}

/** Adapter for the legacy one-shot test harness: a reply built for `submit_to_be` becomes the outline or step payload that
 * was actually requested. Replies that are not a complete design (wrong tool, no tool, truncated, `{}`) pass through unchanged,
 * so they stay invalid for whichever tool was requested. */
export async function routeLegacyReply(reply: Response | Promise<Response>, body: RequestBody): Promise<Response> {
  const res = await reply;
  const name = toolOf(body);
  const group = registerGroupOf(body);
  // Register calls are not part of the legacy one-shot protocol: they always get the valid fixture registers.
  if (group) return toolResponse(rentalRegisterGroups[group], name);
  if (name === "submit_to_be" || res.status !== 200) return res;
  const message = await res.clone().json() as { content: { type: string; name?: string; input?: unknown }[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number } };
  const block = message.content[0];
  const design = block?.input as DetailedDesign | undefined;
  if (message.stop_reason !== "tool_use" || block?.name !== "submit_to_be" || !Array.isArray(design?.steps)) return res;
  const { outline, details } = splitDesign(design);
  if (name === "submit_to_be_outline") return toolResponse(outline, name, "tool_use", message.usage);
  // A patch call is answered as a model that resends everything it can: every step, and each other list that is not empty.
  if (name === "submit_to_be_outline_patch") {
    const { steps, coverage, openQuestions, eliminatedAsIsSteps } = outline;
    return toolResponse(Object.fromEntries(Object.entries({ steps, coverage, openQuestions, eliminatedAsIsSteps }).filter(([, items]) => items.length)), name, "tool_use", message.usage);
  }
  const id = stepIdOf(body);
  return details[id] ? toolResponse(details[id], name, "tool_use", message.usage) : res;
}
