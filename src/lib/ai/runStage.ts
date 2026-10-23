import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parseEnvironment, STAGE_NAMES, TO_BE_SUBSTAGES, type Environment } from "../env";
import { ProblemAnalysisInputSchema, ProblemAnalysisSchema, redactInput, schemaIssues, validateProblemAnalysis,
  type ProblemAnalysis, type ValidationIssue } from "./problem-analysis";
import { createProviderClient, isTransientProviderError, logProviderFailure, logProviderRetry, logStageTimeout, retryAfterMs, type Provider } from "./provider";
import { loadToBeReferences, parseToBeInput, type ToBeOutput } from "./to-be";
import { REGISTER_GROUP_NAMES, RegisterGroupSchemas } from "./design-registers";
import { OutlinePatchSchema, OutlineSchema, StepDetailSchema, TRUNCATED, runDesign, type Substage } from "./to-be-pipeline";
import { ReviewSchema } from "./to-be-review";
import { interviewModelView } from "./interview-sentences";
import { parseWorkedExample, renderWorkedExamples, withWorkedExample } from "./worked-example";

/** The chat call needs no citations: it sees plain messages, and not the facts it cannot ask about. */
const chatModelView = (input: InterviewInput) => input;
/** The extraction call sees the message as numbered sentences, and neither the gaps nor the history it does not use. */
const extractionModelView = (input: InterviewInput) => ({ ...interviewModelView(input), activeGaps: [], closedGapKeys: [], history: [] });
import { ExtractionToolSchema, InterviewChatToolSchema, InterviewTurnRawSchema, parseInterviewInput, validateChatTurn, validateExtraction,
  type InterviewInput, type InterviewTurn } from "./discovery-interview";

type Stage = (typeof STAGE_NAMES)[number];
type Payloads = { problem_analysis: ProblemAnalysis; to_be: ToBeOutput; interview_turn: InterviewTurn; extraction_turn: InterviewTurn };
type Code = "AI_INPUT_INVALID" | "AI_INPUT_TOO_LARGE" | "AI_INVALID_OUTPUT" | "AI_PROVIDER_ERROR" | "AI_TIMEOUT" | "AI_CANCELLED";
export type StageMetrics = { stage: Stage; provider: Provider; model: string; inputTokens: number;
  outputTokens: number; latencyMs: number; attempts: number; validationErrors: ValidationIssue[];
  /** The same issues grouped per failed attempt (validationErrors is their flat concatenation). */
  attemptIssues?: ValidationIssue[][];
  /** Provider calls re-sent after a transient failure (5xx, 429, overloaded, dropped connection or stream), all substages together. */
  providerRetries?: number;
  /** The provider's stop_reason for each completed provider response, in attempt order (aligned with attemptIssues);
   * null when the provider sent none. A response that never completed (timeout, transport error) adds no entry. */
  stopReasons?: (string | null)[];
  /** Server-side repairs applied to an accepted turn (interview: off-list reply, dropped question, normalized quote) or outline (To-Be: REPAIRED_* codes). */
  warnings?: ValidationIssue[];
  /** Interview stages only: provider responses accepted from a JSON text block because the model skipped the tool call.
   * Counted so a run that leans on the fallback is visible; a clean native tool call is the expected case. */
  textFallbacks?: number;
  /** True when this stage's requests carried `thinking: {type: "disabled"}` (AI_NO_THINKING_STAGES, or AI_REASONING_EFFORT=none; DeepInfra and OpenRouter only). */
  thinkingDisabled?: boolean;
  /** To-Be only: provider calls and tokens per request kind (the outline call and the per-step calls, repairs included). */
  substages?: Partial<Record<Substage, { calls: number; inputTokens: number; outputTokens: number }>>;
  /** Eval only (Options.captureRaw): the raw payload of each To-Be call that failed validation, as capped JSON text. Never set in production. */
  rawFailures?: RawFailure[] };
export type RawFailure = { substage: Substage; key: string; attempt: number; json: string; truncated: boolean };
/** Caps for Options.captureRaw: the first failures are the informative ones. */
const RAW_FAILURE_MAX_ENTRIES = 8;
const RAW_FAILURE_MAX_CHARS = 20000;
export class AIStageError extends Error {
  constructor(public readonly code: Code, public readonly metrics: StageMetrics) {
    super(code); this.name = "AIStageError";
  }
}
type Config = Pick<Environment, "NODE_ENV" | "AI_PROVIDER" | "ANTHROPIC_API_KEY" | "DEEPINFRA_API_KEY" | "OPENROUTER_API_KEY" | "AI_REASONING_EFFORT" | "AI_MODEL" | "AI_MODEL_DESIGN" | "AI_MAX_INPUT_TOKENS" | "AI_MAX_CONCURRENCY" | "AI_CHAT_CONCURRENCY" | "AI_FAULT_INJECTION"
  | "AI_NO_THINKING_STAGES" | "AI_STAGE_BUDGET_SECONDS" | "AI_CALL_TIMEOUT_SECONDS" | "AI_DESIGN_CALL_TIMEOUT_SECONDS" | "AI_DESIGN_PARALLELISM" | "AI_TO_BE_OUTLINE_REPAIRS" | "AI_TO_BE_PART_REPAIRS" | "AI_TO_BE_OUTLINE_MAX_TOKENS" | "AI_TO_BE_STEP_MAX_TOKENS" | "AI_TO_BE_REGISTERS_MAX_TOKENS"> & Partial<Pick<Environment, "AI_TO_BE_REVIEW" | "AI_TO_BE_FIX_MAX_PARTS">>;
const SDK_TIMEOUT_MARGIN_MS = 5000;
/** Waits before retry 1, 2 and 3 of one provider call (so at most 3 retries), each scaled by +-RETRY_JITTER. */
const RETRY_DELAYS_MS = [2000, 6000, 18000] as const;
const RETRY_JITTER = 0.2;
/** Upper bound for any wait, a provider's Retry-After included: the stage budget is minutes, not the hour a 429 may ask for. */
const RETRY_DELAY_CAP_MS = 30000;
/** A retry starts only if, after its wait, the stage budget still holds this long (or the per-call timeout, if shorter).
 * A streamed generation that has less than 30 s cannot realistically finish, and the attempt would only delay the AI_TIMEOUT. */
const MIN_RETRY_WINDOW_MS = 30000;
/** OpenRouter has no count_tokens endpoint: input size is estimated locally. 3.5 chars/token is deliberately below the ~4 of English prose
 * (JSON, SAP codes and non-English text tokenize worse), so the AI_MAX_INPUT_TOKENS guard errs towards refusing. Not a measured count. */
const CHARS_PER_TOKEN = 3.5;
const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);
/** An interview turn carries up to 42 quoted proposals; 8000 truncated some turns into an empty tool payload. */
const INTERVIEW_MAX_TOKENS = 16000;
/** The long design stages: the only place that decides which stages use the design timeout and AI_MODEL_DESIGN. */
const DESIGN_STAGES: ReadonlySet<Stage> = new Set<Stage>(["to_be"]);
/** issueDetail: eval harness only. Adds the schema's own message (never the received value) to interview_turn issues
 * recorded in metrics; the issues sent back to the model and the production default are unchanged. */
type Options = { fetch?: typeof fetch; sapCatalogDir?: string; issueDetail?: boolean;
  /** Eval harness only, synthetic fixtures only: keep the raw payloads of failed To-Be calls in metrics.rawFailures. */
  captureRaw?: boolean };

/** Some models answer a chat turn with the tool payload as a JSON text block and stop with end_turn instead of calling
 * the tool. When there is no tool call at all, accept exactly that: one text block holding one JSON object. The payload
 * then goes through the same full validation as a tool call; anything else stays null (invalid). */
function jsonFromText(content: Anthropic.Message["content"]): unknown {
  const blocks = content.filter((block): block is Anthropic.TextBlock => block.type === "text" && !!block.text.trim());
  if (blocks.length !== 1) return null;
  const text = blocks[0]!.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { const parsed: unknown = JSON.parse(text); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
}

/** What a response block was, without its reasoning: type and size, and the start of any visible text. Eval capture only. */
const BLOCK_HEAD_CHARS = 400;
function describeBlock(block: Anthropic.Message["content"][number]) {
  return block.type === "text" ? { type: block.type, chars: block.text.length, head: block.text.slice(0, BLOCK_HEAD_CHARS) }
    : { type: block.type, chars: JSON.stringify(block).length };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A counting semaphore: `acquire` resolves when a slot is free (or rejects with the signal's reason), `release` frees one. */
function createLane(max: number) {
  let active = 0;
  const waiters: Array<{ ready: () => void; abort: () => void; signal: AbortSignal }> = [];
  return {
    release() {
      const next = waiters.shift();
      if (next) { next.signal.removeEventListener("abort", next.abort); next.ready(); }
      else active--;
    },
    async acquire(signal: AbortSignal) {
      signal.throwIfAborted();
      if (active < max) { active++; return; }
      await new Promise<void>((resolve, reject) => {
        const waiter = { ready: resolve, signal, abort: () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(signal.reason);
        } };
        waiters.push(waiter); signal.addEventListener("abort", waiter.abort, { once: true });
        if (signal.aborted) waiter.abort();
      });
    },
  };
}

/** Instantiate once per worker; limits include calls still settling after abort.
 * Internal only: the job loader must authorize the tenant/project before calling.
 * No model text is logged here. Persist only the returned metrics and validated payload.
 */
export function createStageRunner(config: Config, options: Options = {}) {
  if (!Number.isSafeInteger(config.AI_MAX_CONCURRENCY) || config.AI_MAX_CONCURRENCY < 1 ||
    !Number.isSafeInteger(config.AI_CHAT_CONCURRENCY) || config.AI_CHAT_CONCURRENCY < 1 ||
    !Number.isSafeInteger(config.AI_MAX_INPUT_TOKENS) || config.AI_MAX_INPUT_TOKENS < 1) throw new Error("Invalid AI limits");
  const reviewOn = config.AI_TO_BE_REVIEW !== "off";
  const fixOn = (config.AI_TO_BE_FIX_MAX_PARTS ?? 8) > 0;
  const provider: Provider = config.NODE_ENV === "production" && config.AI_PROVIDER === "stub" ? "anthropic" : config.AI_PROVIDER;
  // Slow models (MiMo: ~20-40 tokens/s) need larger values; the operator sets them, never the provider name.
  const callTimeout = config.AI_CALL_TIMEOUT_SECONDS * 1000;
  const designCallTimeout = config.AI_DESIGN_CALL_TIMEOUT_SECONDS * 1000;
  const stageBudget = config.AI_STAGE_BUDGET_SECONDS * 1000;
  const keyName = ({ anthropic: "ANTHROPIC_API_KEY", deepinfra: "DEEPINFRA_API_KEY", openrouter: "OPENROUTER_API_KEY", stub: null } as const)[provider];
  const apiKey = keyName ? config[keyName] : undefined;
  if (keyName && !apiKey?.trim()) throw new Error(`Missing ${keyName}`);
  const fault = config.NODE_ENV === "production" ? undefined : config.AI_FAULT_INJECTION;
  let faultUsed = false;
  // SDK retries and logs are disabled: this boundary owns the bounded policy and
  // SDK debug output can contain bodies. Never inherit API base URLs from env.
  // The request sends only model, max_tokens, system, messages, tools and tool_choice, plus `thinking: {type: "disabled"}`
  // for stages listed in AI_NO_THINKING_STAGES on DeepInfra only (Claude rejects that form with a 400). No effort, beta or
  // cache_control settings, so any Messages-compatible provider accepts it.
  // DeepInfra may return `thinking` blocks first; only tool_use blocks are read, all others are ignored.
  // Calls are streamed: headers arrive immediately, so Node's 300 s fetch headersTimeout (undici default)
  // cannot cut a long generation. The SDK timeout then only covers the wait for headers; our own
  // AbortSignal in call() bounds the whole stream. Keep the SDK value above both per-call limits.
  const sdkTimeout = Math.max(callTimeout, designCallTimeout) + SDK_TIMEOUT_MARGIN_MS;
  const client = provider === "stub" ? undefined : createProviderClient(provider, apiKey!, sdkTimeout, options.fetch);
  const noThinking = new Set<string>(provider === "deepinfra" || provider === "openrouter" ? config.AI_NO_THINKING_STAGES ?? [] : []);
  // OpenRouter only: effort for stages that think. "none" = reasoning off everywhere. The Messages endpoint documents output_config.effort
  // and thinking:{type:"disabled"} as its reasoning controls (mapped to reasoning.effort / reasoning.enabled=false); no `thinking` is sent otherwise.
  const effort = provider === "openrouter" ? config.AI_REASONING_EFFORT ?? "max" : "none";
  const reasoningOff = provider === "openrouter" && effort === "none";
  // OpenRouter only. DeepSeek documents that a forced tool choice is not supported while thinking is on, and live (2026-10-23, effort max,
  // forced tool) 7 of 8 step and register calls ended their turn without calling the tool. With AI_REASONING_EFFORT unset, only the
  // outline thinks; the step and register calls (a fixed outline to fill in) run with thinking disabled and the forced tool. An
  // explicit AI_REASONING_EFFORT (or AI_NO_THINKING_STAGES) is the operator's choice and applies to every call as before.
  const expansionThinkingOff = (substage: Substage) => provider === "openrouter" && config.AI_REASONING_EFFORT === undefined && substage !== "to_be_outline";
  // Two independent lanes of model-call slots: chat turns (interview_turn) and batch stages (to_be, problem_analysis).
  // A long batch stage can hold every batch slot and a chat turn still runs.
  const chatLane = createLane(config.AI_CHAT_CONCURRENCY), batchLane = createLane(config.AI_MAX_CONCURRENCY);
  // Claude Sonnet 5.5 rejects a forced tool choice (HTTP 400), so Anthropic keeps "auto". DeepInfra's MiMo answers in
  // prose under "auto" (0/4 tool calls measured 2026-10-22) and calls the tool every time when it is forced.
  // This applies to every tool the runner sends, the To-Be outline and step tools included.
  const toolChoiceFor = (name: string): Anthropic.ToolChoice => provider === "deepinfra" || provider === "openrouter"
    ? { type: "tool", name, disable_parallel_tool_use: true } : { type: "auto", disable_parallel_tool_use: true };

  return async function runStage<S extends Stage>(stage: S, rawInput: unknown, externalSignal?: AbortSignal): Promise<{ payload: Payloads[S]; metrics: StageMetrics }> {
    const started = Date.now();
    const isDesign = DESIGN_STAGES.has(stage);
    const lane = stage === "interview_turn" || stage === "extraction_turn" ? chatLane : batchLane;
    const model = isDesign ? config.AI_MODEL_DESIGN ?? config.AI_MODEL : config.AI_MODEL;
    const metrics: StageMetrics = { stage, provider, model, inputTokens: 0, outputTokens: 0,
      latencyMs: 0, attempts: 0, providerRetries: 0, validationErrors: [], attemptIssues: [], stopReasons: [], textFallbacks: 0,
      thinkingDisabled: reasoningOff || noThinking.has(stage) || (stage === "to_be" && TO_BE_SUBSTAGES.filter(substage => (reviewOn || substage !== "to_be_review") && (fixOn || substage !== "to_be_fix")).every(substage => noThinking.has(substage))) };
    const fail = (code: Code) => new AIStageError(code, metrics);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(fail("AI_TIMEOUT")), stageBudget);
    const signal = externalSignal ? AbortSignal.any([externalSignal, deadline.signal]) : deadline.signal;
    const pending = new Set<Promise<unknown>>();
    let acquired = false;

    async function call<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = callTimeout): Promise<T> {
      signal.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(fail("AI_TIMEOUT")), timeoutMs);
      let stop!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        stop = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", stop, { once: true });
      });
      const operation = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal); });
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      try { return await Promise.race([operation, interrupted]); }
      finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", stop); }
    }

    /** One provider request with the transient-retry policy: see RETRY_DELAYS_MS. Used by every stage, token counts included. */
    async function transport<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = callTimeout): Promise<T> {
      for (let retry = 0; ; retry++) {
        try { return await call(work, timeoutMs); }
        catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof AIStageError) throw error;
          const giveUp = (code: Code) => { logProviderFailure(provider, model, stage, error); return fail(code); };
          const timedOut = error instanceof Anthropic.APIConnectionTimeoutError;
          if (!isTransientProviderError(error) || retry >= RETRY_DELAYS_MS.length) throw giveUp(timedOut ? "AI_TIMEOUT" : "AI_PROVIDER_ERROR");
          const backoff = RETRY_DELAYS_MS[retry]! * (1 - RETRY_JITTER + 2 * RETRY_JITTER * Math.random());
          const delay = Math.round(Math.min(Math.max(backoff, retryAfterMs(error) ?? 0), RETRY_DELAY_CAP_MS));
          // The retry still needs a window in which a call can finish; otherwise it only burns the budget.
          if (started + stageBudget - Date.now() - delay < Math.min(timeoutMs, MIN_RETRY_WINDOW_MS)) throw giveUp("AI_TIMEOUT");
          metrics.providerRetries = (metrics.providerRetries ?? 0) + 1;
          logProviderRetry(provider, model, stage, retry + 1, delay, error);
          await pause(delay, signal);
        }
      }
    }

    try {
      if (!STAGE_NAMES.includes(stage)) throw fail("AI_INPUT_INVALID");
      let designInput: ReturnType<typeof parseToBeInput> | undefined;
      let designReferences: Awaited<ReturnType<typeof loadToBeReferences>> = [];
      let interviewInput: InterviewInput | undefined;
      let analysisInput: ReturnType<typeof redactInput> = null;
      let original = "";
      if (stage === "to_be") {
        try { designInput = parseToBeInput(rawInput); }
        catch { metrics.validationErrors = [{ path: "input", code: "invalid_or_sensitive_discovery" }]; throw fail("AI_INPUT_INVALID"); }
        // A static sample cannot faithfully represent arbitrary discovery input.
        if (!client) throw fail("AI_PROVIDER_ERROR");
        // A malformed curated catalog fails closed (provider error) rather than dropping or inventing trust.
        designReferences = await loadToBeReferences(designInput, { baseDir: options.sapCatalogDir });
      } else if (stage === "interview_turn" || stage === "extraction_turn") {
        try { interviewInput = parseInterviewInput(rawInput); }
        catch { metrics.validationErrors = [{ path: "input", code: "invalid_or_sensitive_interview" }]; throw fail("AI_INPUT_INVALID"); }
        if (!client) throw fail("AI_PROVIDER_ERROR");
      } else {
        const parsed = ProblemAnalysisInputSchema.safeParse(rawInput);
        if (!parsed.success) { metrics.validationErrors = schemaIssues(parsed.error.issues); throw fail("AI_INPUT_INVALID"); }
        original = parsed.data.problemStatement;
        analysisInput = redactInput(parsed.data);
        if (!analysisInput) { metrics.validationErrors = [{ path: "input", code: "sensitive_identifier" }]; throw fail("AI_INPUT_INVALID"); }
      }
      await lane.acquire(signal); acquired = true;
      let inputTruncated = false;
      const count = async (source: string) => {
        if (!client) return Buffer.byteLength(source, "utf8"); // Conservative byte cap in offline tests; not reported as measured tokens.
        if (provider === "openrouter") return estimateTokens(source);
        const result = await transport((signal) => client.messages.countTokens({ model,
          messages: [{ role: "user", content: source }] }, { signal }));
        if (!Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0) throw fail("AI_PROVIDER_ERROR");
        return result.input_tokens;
      };
      if (analysisInput && await count(analysisInput.problemStatement) > config.AI_MAX_INPUT_TOKENS) {
        const points = Array.from(analysisInput.problemStatement);
        let low = 0, high = points.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (await count(points.slice(0, middle).join("")) <= config.AI_MAX_INPUT_TOKENS) low = middle;
          else high = middle - 1;
        }
        analysisInput.problemStatement = points.slice(0, low).join(""); inputTruncated = true;
        if (!analysisInput.problemStatement.trim() || await count(analysisInput.problemStatement) > config.AI_MAX_INPUT_TOKENS) throw fail("AI_INPUT_TOO_LARGE");
      }
      /** One provider request: for design and interview stages the whole request (system, schema, repair text) is counted first
       * and never truncated, then streamed. Streaming keeps the connection alive during long generations; finalMessage()
       * assembles the same Message. Only a single complete call of `tool.name` counts as output; anything else is null,
       * except that interview stages (textFallback) also accept one JSON text block when the model made no tool call. */
      const generate = async (a: { system: string; user: string; tool: Anthropic.Tool; maxTokens: number; guard: boolean;
        thinkingOff: boolean; textFallback?: boolean; substage?: Substage;
        /** Eval only: called with a short description of a response that held no usable tool payload. */
        onNoPayload?: (description: unknown) => void }): Promise<unknown> => {
        const messages: Anthropic.MessageParam[] = [{ role: "user", content: a.user }];
        const tools = [a.tool];
        const toolChoice = toolChoiceFor(a.tool.name);
        if (a.guard) {
          const inputTokens = provider === "openrouter" ? estimateTokens(JSON.stringify({ system: a.system, messages, tools, tool_choice: toolChoice }))
            : (await transport(signal => client!.messages.countTokens({ model, system: a.system, messages, tools, tool_choice: toolChoice }, { signal }))).input_tokens;
          if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw fail("AI_PROVIDER_ERROR");
          if (inputTokens > config.AI_MAX_INPUT_TOKENS) throw fail("AI_INPUT_TOO_LARGE");
        }
        const timeoutMs = isDesign ? designCallTimeout : callTimeout;
        const message = await transport((signal) => {
          metrics.attempts++;
          return client!.messages.stream({ model, max_tokens: a.maxTokens, system: a.system,
            messages, tools, ...(a.thinkingOff ? { thinking: { type: "disabled" as const } } : provider === "openrouter" ? { output_config: { effort: effort as "low" | "medium" | "high" | "max" } } : {}),
            // Sonnet 5.5 rejects forced tool selection. The prompt requests the
            // tool; validation still requires exactly one complete tool payload.
            tool_choice: toolChoice }, { signal, timeout: timeoutMs }).finalMessage();
        }, timeoutMs);
        const usage = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
          cache_creation_input_tokens: z.number().int().nonnegative().nullish(), cache_read_input_tokens: z.number().int().nonnegative().nullish(),
        }).safeParse(message.usage);
        if (!usage.success) throw fail("AI_PROVIDER_ERROR");
        const inputTokens = usage.data.input_tokens + (usage.data.cache_creation_input_tokens ?? 0) + (usage.data.cache_read_input_tokens ?? 0);
        metrics.inputTokens += inputTokens;
        metrics.outputTokens += usage.data.output_tokens;
        metrics.stopReasons!.push(message.stop_reason ?? null);
        if (a.substage) {
          const entry = (metrics.substages ??= {})[a.substage] ??= { calls: 0, inputTokens: 0, outputTokens: 0 };
          entry.calls++; entry.inputTokens += inputTokens; entry.outputTokens += usage.data.output_tokens;
        }
        // A design answer cut off by the output limit is reported as such (reasoning tokens count against max_tokens), not as a missing payload.
        if (a.substage && message.stop_reason === "max_tokens") return TRUNCATED;
        const toolCalls = message.content.filter((block) => block.type === "tool_use");
        // OpenRouter reports end_turn even when the model called the tool (measured live: 27 complete tool_use blocks rejected), so one call of the expected tool is accepted
        // whatever the stop reason, except max_tokens, which means the input may be cut off.
        const output = message.stop_reason !== "max_tokens" && toolCalls.length === 1 && toolCalls[0]!.name === a.tool.name ? toolCalls[0]!.input
          : a.textFallback && !toolCalls.length ? jsonFromText(message.content) : null;
        if (a.textFallback && !toolCalls.length && output !== null) metrics.textFallbacks! += 1;
        if (output === null) a.onNoPayload?.({ stopReason: message.stop_reason ?? null, blocks: message.content.map(describeBlock) });
        return output;
      };

      if (designInput) {
        // The stage holds ONE AI_MAX_CONCURRENCY permit (acquired above) for the whole design; the outline call and the
        // step fan-out run under it and never acquire again, so AI_MAX_CONCURRENCY=1 cannot deadlock. Fan-out width is
        // AI_DESIGN_PARALLELISM, so provider requests in flight can reach AI_MAX_CONCURRENCY x AI_DESIGN_PARALLELISM.
        const [outlineTemplate, stepTemplate, registersTemplate, reviewSystem, exampleRaw] = await call(() => Promise.all([
          readFile(new URL("../../../prompts/to_be_outline.system.md", import.meta.url), "utf8"),
          readFile(new URL("../../../prompts/to_be_step.system.md", import.meta.url), "utf8"),
          readFile(new URL("../../../prompts/to_be_registers.system.md", import.meta.url), "utf8"),
          readFile(new URL("../../../prompts/to_be_review.system.md", import.meta.url), "utf8"),
          readFile(new URL("../../../fixtures/ai/to-be/worked-example.json", import.meta.url), "utf8"),
        ]));
        // The worked examples come from the validated fixture, so a prompt can never show something the validators reject.
        const examples = renderWorkedExamples(parseWorkedExample(JSON.parse(exampleRaw)));
        const outlineSystem = withWorkedExample(outlineTemplate, examples.outline);
        const stepSystem = withWorkedExample(stepTemplate, examples.step);
        const registersSystem = withWorkedExample(registersTemplate, examples.registers);
        // The four register groups share one system prompt (a stable prefix) and differ by tool.
        const kinds = {
          to_be_outline: { system: outlineSystem, schema: OutlineSchema, name: "submit_to_be_outline", maxTokens: config.AI_TO_BE_OUTLINE_MAX_TOKENS },
          // The patch repairs a few flagged outline items; it shares the outline's system prompt (the rules it must keep) and its limits.
          to_be_outline_patch: { system: outlineSystem, schema: OutlinePatchSchema, name: "submit_to_be_outline_patch", maxTokens: config.AI_TO_BE_OUTLINE_MAX_TOKENS },
          to_be_step: { system: stepSystem, schema: StepDetailSchema, name: "submit_to_be_step", maxTokens: config.AI_TO_BE_STEP_MAX_TOKENS },
          // The consistency read-through lists findings (a few hundred tokens each), so the register ceiling is ample.
          to_be_review: { system: reviewSystem, schema: ReviewSchema, name: "submit_to_be_review", maxTokens: config.AI_TO_BE_REGISTERS_MAX_TOKENS },
          ...Object.fromEntries(REGISTER_GROUP_NAMES.map(group => [`to_be_registers:${group}`,
            { system: registersSystem, schema: RegisterGroupSchemas[group], name: `submit_to_be_registers_${group}`, maxTokens: config.AI_TO_BE_REGISTERS_MAX_TOKENS }])),
        } as const;
        const tools = Object.fromEntries(Object.entries(kinds).map(([key, kind]) =>
          [key, { name: kind.name, input_schema: { ...z.toJSONSchema(kind.schema), type: "object" } } satisfies Anthropic.Tool]));
        const design = designInput;
        const keepRaw = (substage: Substage, key: string, payload: unknown) => {
          const failures = metrics.rawFailures ??= [];
          if (failures.length >= RAW_FAILURE_MAX_ENTRIES) return;
          const json = JSON.stringify(payload) ?? "undefined";
          failures.push({ substage, key, attempt: failures.filter(item => item.substage === substage && item.key === key).length + 1, json: json.slice(0, RAW_FAILURE_MAX_CHARS), truncated: json.length > RAW_FAILURE_MAX_CHARS });
        };
        const payload = await runDesign(design, designReferences, {
          parallelism: config.AI_DESIGN_PARALLELISM,
          maxOutlineRepairs: config.AI_TO_BE_OUTLINE_REPAIRS,
          maxPartRepairs: config.AI_TO_BE_PART_REPAIRS,
          remainingBudget: () => Math.max(0, 1 - (Date.now() - started) / stageBudget),
          review: reviewOn,
          maxFixParts: config.AI_TO_BE_FIX_MAX_PARTS ?? 8,
          invalid: () => fail("AI_INVALID_OUTPUT"),
          record: (issues) => { metrics.validationErrors.push(...issues); metrics.attemptIssues!.push(issues); },
          warn: (issues) => { metrics.warnings = [...(metrics.warnings ?? []), ...issues]; },
          ...(options.captureRaw && { rawFailure: keepRaw }),
          ask: async (substage, request, group, askOptions) => {
            // A patch call uses the outline patch tool; a fix call (substage to_be_fix) uses the tool of the part it repairs: a register group, the outline patch, or a step.
            const key = group === "patch" ? "to_be_outline_patch" : substage === "to_be_registers" || (substage === "to_be_fix" && group) ? `to_be_registers:${group}`
              : substage === "to_be_fix" ? "to_be_step" : substage;
            const kind = kinds[key as keyof typeof kinds];
            const rawKeyOf = group && group !== "patch" ? String(group) : substage === "to_be_step" || (substage === "to_be_fix" && !group) ? (request as { step: { id: string } }).step.id : substage === "to_be_review" ? "review" : group === "patch" ? "outline-patch" : "outline";
            const output = await generate({ system: kind.system, user: JSON.stringify(request), tool: tools[key]!, maxTokens: kind.maxTokens,
              // A thinking retry (one last call for a step that kept failing) sends the request without thinking-disabled; an operator's AI_REASONING_EFFORT=none still wins.
              guard: true, thinkingOff: reasoningOff || (!askOptions?.thinking && (noThinking.has(substage) || noThinking.has("to_be") || expansionThinkingOff(substage))),
              // A model that ends its turn with the payload as a JSON text block instead of calling the tool is accepted exactly as in the interview.
              textFallback: true, substage,
              ...(options.captureRaw && { onNoPayload: (description: unknown) => keepRaw(substage, rawKeyOf, { noToolPayload: description }) }) });
            signal.throwIfAborted();
            return output;
          },
        });
        return { payload: payload as Payloads[S], metrics };
      }

      const [system, template] = interviewInput ? [await call(() =>
        readFile(new URL(stage === "extraction_turn" ? "../../../prompts/discovery_extraction.system.md" : "../../../prompts/discovery_interview.system.md", import.meta.url), "utf8")), ""] : await call(() => Promise.all([
        readFile(new URL("../../../prompts/problem_analysis.system.md", import.meta.url), "utf8"),
        readFile(new URL("../../../prompts/problem_analysis.user.md", import.meta.url), "utf8"),
      ]));
      if (analysisInput && (!template.includes("{{input}}") || !template.includes("{{validationErrors}}"))) throw fail("AI_PROVIDER_ERROR");
      const jsonSchema = z.toJSONSchema(interviewInput ? (stage === "extraction_turn" ? ExtractionToolSchema : InterviewChatToolSchema) : ProblemAnalysisSchema);
      const tool: Anthropic.Tool = { name: interviewInput ? (stage === "extraction_turn" ? "submit_extraction" : "submit_interview_turn") : "submit_analysis",
        input_schema: { ...jsonSchema, type: "object" } };
      let errors: ValidationIssue[] = [];
      for (let repair = 0; repair < 2; repair++) {
        // One replacement pass prevents client text containing template markers from being interpreted.
        const user = interviewInput ? JSON.stringify({ input: stage === "extraction_turn" ? extractionModelView(interviewInput) : chatModelView(interviewInput), validationErrors: errors })
          : template.replace(/\{\{(input|validationErrors)\}\}/g, (_, key: string) =>
            key === "input" ? JSON.stringify({ ...analysisInput, inputTruncated }) : JSON.stringify(errors));
        let output: unknown;
        if (provider === "stub") {
          metrics.attempts++;
          const parts = fault?.split(":");
          const inject = parts?.[0] === stage && (parts[2] !== "once" || !faultUsed);
          if (inject) faultUsed = true;
          if (inject && parts?.[1] === "timeout") throw fail("AI_TIMEOUT");
          if (inject && parts?.[1] === "error") throw fail("AI_PROVIDER_ERROR");
          output = inject && parts?.[1] === "invalid" ? {} : JSON.parse(await call(() =>
            readFile(new URL("../../../fixtures/ai/problem_analysis/default.json", import.meta.url), "utf8")));
        } else {
          // Interview requests are counted whole (never truncated); problem analysis truncates its input up front instead.
          output = await generate({ system, user, tool, maxTokens: interviewInput ? INTERVIEW_MAX_TOKENS : 12000,
            guard: !!interviewInput, thinkingOff: !!metrics.thinkingDisabled, textFallback: !!interviewInput });
        }
        signal.throwIfAborted();
        if (interviewInput) {
          const result = (stage === "extraction_turn" ? validateExtraction : validateChatTurn)(interviewInput, output);
          if (result.success) { metrics.warnings = result.warnings; return { payload: result.data as Payloads[S], metrics }; }
          errors = result.errors;
        } else {
          const result = validateProblemAnalysis(output, analysisInput!.problemStatement);
          errors = result.success ? [] : result.errors;
          // A redacted quote must also exist verbatim in the original source.
          if (result.success && result.data.painPoints.some((point) => !original.includes(point.quote) || point.quote.includes("[redacted]"))) {
            errors = [{ path: "painPoints", code: "quote_not_in_source" }];
          }
          if (result.success && !errors.length) return { payload: { ...result.data, inputTruncated } as Payloads[S], metrics };
        }
        metrics.validationErrors.push(...errors);
        const schema = options.issueDetail && interviewInput ? InterviewTurnRawSchema.safeParse(output) : null;
        metrics.attemptIssues!.push(schema && !schema.success
          ? schemaIssues(schema.error.issues).map((issue, i) => ({ ...issue, detail: schema.error.issues[i]!.message })) : errors);
      }
      throw fail("AI_INVALID_OUTPUT");
    } catch (error) {
      if (deadline.signal.aborted) {
        logStageTimeout(provider, model, stage, Date.now() - started, metrics.attempts);
        throw fail("AI_TIMEOUT");
      }
      if (externalSignal?.aborted) throw fail("AI_CANCELLED");
      if (error instanceof AIStageError) throw error;
      throw fail("AI_PROVIDER_ERROR");
    } finally {
      clearTimeout(timer); metrics.latencyMs = Date.now() - started;
      if (acquired) {
        // An uncooperative transport must not free capacity while it still runs.
        if (pending.size) void Promise.allSettled([...pending]).then(lane.release);
        else lane.release();
      }
    }
  };
}

let defaultRunner: ReturnType<typeof createStageRunner> | undefined;
export function runStage<S extends Stage>(stage: S, input: unknown, signal?: AbortSignal) {
  defaultRunner ??= createStageRunner(parseEnvironment());
  return defaultRunner(stage, input, signal);
}
