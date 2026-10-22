import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parseEnvironment, type Environment } from "../env";
import { ProblemAnalysisInputSchema, ProblemAnalysisSchema, redactInput, schemaIssues, validateProblemAnalysis,
  type ProblemAnalysis, type ValidationIssue } from "./problem-analysis";
import { createProviderClient, logProviderFailure, logStageTimeout, type Provider } from "./provider";
import { DetailedDesignSchema } from "./design-quality";
import { loadToBeReferences, parseToBeInput, validateToBeOutput, type ToBeOutput } from "./to-be";
import { InterviewTurnRawSchema, InterviewTurnToolSchema, parseInterviewInput, validateInterviewTurn, type InterviewInput, type InterviewTurn } from "./discovery-interview";

type Stage = "problem_analysis" | "to_be" | "interview_turn";
type Payloads = { problem_analysis: ProblemAnalysis; to_be: ToBeOutput; interview_turn: InterviewTurn };
type Code = "AI_INPUT_INVALID" | "AI_INPUT_TOO_LARGE" | "AI_INVALID_OUTPUT" | "AI_PROVIDER_ERROR" | "AI_TIMEOUT" | "AI_CANCELLED";
export type StageMetrics = { stage: Stage; provider: Provider; model: string; inputTokens: number;
  outputTokens: number; latencyMs: number; attempts: number; validationErrors: ValidationIssue[];
  /** The same issues grouped per failed attempt (validationErrors is their flat concatenation). */
  attemptIssues?: ValidationIssue[][];
  /** The provider's stop_reason for each completed provider response, in attempt order (aligned with attemptIssues);
   * null when the provider sent none. A response that never completed (timeout, transport error) adds no entry. */
  stopReasons?: (string | null)[];
  /** Interview turns only: server-side repairs applied to an accepted turn (off-list reply, dropped question, normalized quote). */
  warnings?: ValidationIssue[] };
export class AIStageError extends Error {
  constructor(public readonly code: Code, public readonly metrics: StageMetrics) {
    super(code); this.name = "AIStageError";
  }
}
type Config = Pick<Environment, "NODE_ENV" | "AI_PROVIDER" | "ANTHROPIC_API_KEY" | "DEEPINFRA_API_KEY" | "AI_MODEL" | "AI_MODEL_DESIGN" | "AI_MAX_INPUT_TOKENS" | "AI_MAX_CONCURRENCY" | "AI_FAULT_INJECTION"
  | "AI_STAGE_BUDGET_SECONDS" | "AI_CALL_TIMEOUT_SECONDS" | "AI_DESIGN_CALL_TIMEOUT_SECONDS">;
const SDK_TIMEOUT_MARGIN_MS = 5000;
/** An interview turn carries up to 12 quoted proposals; 8000 truncated some turns into an empty tool payload. */
const INTERVIEW_MAX_TOKENS = 16000;
/** The long design stages: the only place that decides which stages use the design timeout and AI_MODEL_DESIGN. */
const DESIGN_STAGES: ReadonlySet<Stage> = new Set<Stage>(["to_be"]);
/** issueDetail: eval harness only. Adds the schema's own message (never the received value) to interview_turn issues
 * recorded in metrics; the issues sent back to the model and the production default are unchanged. */
type Options = { fetch?: typeof fetch; sapCatalogDir?: string; issueDetail?: boolean };

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Instantiate once per worker; limits include calls still settling after abort.
 * Internal only: the job loader must authorize the tenant/project before calling.
 * No model text is logged here. Persist only the returned metrics and validated payload.
 */
export function createStageRunner(config: Config, options: Options = {}) {
  if (!Number.isSafeInteger(config.AI_MAX_CONCURRENCY) || config.AI_MAX_CONCURRENCY < 1 ||
    !Number.isSafeInteger(config.AI_MAX_INPUT_TOKENS) || config.AI_MAX_INPUT_TOKENS < 1) throw new Error("Invalid AI limits");
  const provider: Provider = config.NODE_ENV === "production" && config.AI_PROVIDER === "stub" ? "anthropic" : config.AI_PROVIDER;
  // Slow models (MiMo: ~20-40 tokens/s) need larger values; the operator sets them, never the provider name.
  const callTimeout = config.AI_CALL_TIMEOUT_SECONDS * 1000;
  const designCallTimeout = config.AI_DESIGN_CALL_TIMEOUT_SECONDS * 1000;
  const stageBudget = config.AI_STAGE_BUDGET_SECONDS * 1000;
  const apiKey = provider === "anthropic" ? config.ANTHROPIC_API_KEY : provider === "deepinfra" ? config.DEEPINFRA_API_KEY : undefined;
  if (provider !== "stub" && !apiKey?.trim()) throw new Error(`Missing ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "DEEPINFRA_API_KEY"}`);
  const fault = config.NODE_ENV === "production" ? undefined : config.AI_FAULT_INJECTION;
  let faultUsed = false;
  // SDK retries and logs are disabled: this boundary owns the bounded policy and
  // SDK debug output can contain bodies. Never inherit API base URLs from env.
  // The request sends only model, max_tokens, system, messages, tools and tool_choice: no Claude-specific
  // thinking, effort, beta or cache_control settings, so any Messages-compatible provider accepts it.
  // DeepInfra may return `thinking` blocks first; only tool_use blocks are read, all others are ignored.
  // Calls are streamed: headers arrive immediately, so Node's 300 s fetch headersTimeout (undici default)
  // cannot cut a long generation. The SDK timeout then only covers the wait for headers; our own
  // AbortSignal in call() bounds the whole stream. Keep the SDK value above both per-call limits.
  const sdkTimeout = Math.max(callTimeout, designCallTimeout) + SDK_TIMEOUT_MARGIN_MS;
  const client = provider === "stub" ? undefined : createProviderClient(provider, apiKey!, sdkTimeout, options.fetch);
  let active = 0;
  const waiters: Array<{ ready: () => void; abort: () => void; signal: AbortSignal }> = [];
  const release = () => {
    const next = waiters.shift();
    if (next) { next.signal.removeEventListener("abort", next.abort); next.ready(); }
    else active--;
  };
  async function acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (active < config.AI_MAX_CONCURRENCY) { active++; return; }
    await new Promise<void>((resolve, reject) => {
      const waiter = { ready: resolve, signal, abort: () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal.reason);
      } };
      waiters.push(waiter); signal.addEventListener("abort", waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
    });
  }

  return async function runStage<S extends Stage>(stage: S, rawInput: unknown, externalSignal?: AbortSignal): Promise<{ payload: Payloads[S]; metrics: StageMetrics }> {
    const started = Date.now();
    const isDesign = DESIGN_STAGES.has(stage);
    const model = isDesign ? config.AI_MODEL_DESIGN ?? config.AI_MODEL : config.AI_MODEL;
    const metrics: StageMetrics = { stage, provider, model, inputTokens: 0, outputTokens: 0,
      latencyMs: 0, attempts: 0, validationErrors: [], attemptIssues: [], stopReasons: [] };
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

    async function transport<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = callTimeout): Promise<T> {
      for (let retry = 0; ; retry++) {
        try { return await call(work, timeoutMs); }
        catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof AIStageError) throw error;
          if (error instanceof Anthropic.APIConnectionTimeoutError) { logProviderFailure(provider, model, stage, error); throw fail("AI_TIMEOUT"); }
          const retryable = error instanceof Anthropic.APIConnectionError ||
            (error instanceof Anthropic.APIError && (error.status === 429 || (error.status ?? 0) >= 500));
          if (!retryable || retry >= 2) { logProviderFailure(provider, model, stage, error); throw fail("AI_PROVIDER_ERROR"); }
          await pause(retry === 0 ? 2000 : 8000, signal);
        }
      }
    }

    try {
      if (stage !== "problem_analysis" && stage !== "to_be" && stage !== "interview_turn") throw fail("AI_INPUT_INVALID");
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
      } else if (stage === "interview_turn") {
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
      await acquire(signal); acquired = true;
      let inputTruncated = false;
      const count = async (source: string) => {
        if (!client) return Buffer.byteLength(source, "utf8"); // Conservative byte cap in offline tests; not reported as measured tokens.
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
      const [system, template] = designInput || interviewInput ? [await call(() =>
        readFile(new URL(designInput ? "../../../prompts/to_be.system.md" : "../../../prompts/discovery_interview.system.md", import.meta.url), "utf8")), ""] : await call(() => Promise.all([
        readFile(new URL("../../../prompts/problem_analysis.system.md", import.meta.url), "utf8"),
        readFile(new URL("../../../prompts/problem_analysis.user.md", import.meta.url), "utf8"),
      ]));
      if (analysisInput && (!template.includes("{{input}}") || !template.includes("{{validationErrors}}"))) throw fail("AI_PROVIDER_ERROR");
      const jsonSchema = z.toJSONSchema(designInput ? DetailedDesignSchema : interviewInput ? InterviewTurnToolSchema : ProblemAnalysisSchema);
      const tool = designInput ? "submit_to_be" : interviewInput ? "submit_interview_turn" : "submit_analysis";
      const tools: Anthropic.Tool[] = [{ name: tool, input_schema: { ...jsonSchema, type: "object" } }];
      const toolChoice = { type: "auto" as const, disable_parallel_tool_use: true };
      let errors: ValidationIssue[] = [];
      for (let repair = 0; repair < 2; repair++) {
        // One replacement pass prevents client text containing template markers from being interpreted.
        const user = designInput ? JSON.stringify({ input: designInput, approvedDecisions: [], references: designReferences, validationErrors: errors })
          : interviewInput ? JSON.stringify({ input: interviewInput, validationErrors: errors })
          : template.replace(/\{\{(input|validationErrors)\}\}/g, (_, key: string) =>
            key === "input" ? JSON.stringify({ ...analysisInput, inputTruncated }) : JSON.stringify(errors));
        const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
        if (designInput || interviewInput) {
          // Count the whole request, including schema and repair instructions.
          // Never truncate source evidence, requirements or unresolved policies.
          const counted = await transport(signal => client!.messages.countTokens({
            model, system, messages, tools, tool_choice: toolChoice,
          }, { signal }));
          if (!Number.isSafeInteger(counted.input_tokens) || counted.input_tokens < 0) throw fail("AI_PROVIDER_ERROR");
          if (counted.input_tokens > config.AI_MAX_INPUT_TOKENS) throw fail("AI_INPUT_TOO_LARGE");
        }
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
          const message = await transport((signal) => {
            metrics.attempts++;
            // Streaming keeps the connection alive during long generations; finalMessage() assembles the same Message.
            return client!.messages.stream({ model, max_tokens: designInput ? 24000 : interviewInput ? INTERVIEW_MAX_TOKENS : 12000, system,
              messages, tools,
              // Sonnet 5.5 rejects forced tool selection. The prompt requests the
              // tool; validation still requires exactly one complete tool payload.
              tool_choice: toolChoice }, { signal, timeout: isDesign ? designCallTimeout : callTimeout }).finalMessage();
          }, isDesign ? designCallTimeout : callTimeout);
          const usage = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
            cache_creation_input_tokens: z.number().int().nonnegative().nullish(), cache_read_input_tokens: z.number().int().nonnegative().nullish(),
          }).safeParse(message.usage);
          if (!usage.success) throw fail("AI_PROVIDER_ERROR");
          metrics.inputTokens += usage.data.input_tokens + (usage.data.cache_creation_input_tokens ?? 0) + (usage.data.cache_read_input_tokens ?? 0);
          metrics.outputTokens += usage.data.output_tokens;
          metrics.stopReasons!.push(message.stop_reason ?? null);
          const toolCalls = message.content.filter((block) => block.type === "tool_use");
          output = message.stop_reason === "tool_use" && toolCalls.length === 1 && toolCalls[0]!.name === tool ? toolCalls[0]!.input : null;
        }
        signal.throwIfAborted();
        if (designInput) {
          const result = validateToBeOutput(designInput, output, designReferences);
          if (result.success) return { payload: result.data as Payloads[S], metrics };
          errors = result.errors;
        } else if (interviewInput) {
          const result = validateInterviewTurn(interviewInput, output);
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
        if (pending.size) void Promise.allSettled([...pending]).then(release);
        else release();
      }
    }
  };
}

let defaultRunner: ReturnType<typeof createStageRunner> | undefined;
export function runStage<S extends Stage>(stage: S, input: unknown, signal?: AbortSignal) {
  defaultRunner ??= createStageRunner(parseEnvironment());
  return defaultRunner(stage, input, signal);
}
