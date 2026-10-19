import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parseEnvironment, type Environment } from "../env";
import { ProblemAnalysisInputSchema, ProblemAnalysisSchema, redactInput, schemaIssues, validateProblemAnalysis,
  type ProblemAnalysis, type ValidationIssue } from "./problem-analysis";

type Stage = "problem_analysis";
type Code = "AI_INPUT_INVALID" | "AI_INPUT_TOO_LARGE" | "AI_INVALID_OUTPUT" | "AI_PROVIDER_ERROR" | "AI_TIMEOUT" | "AI_CANCELLED";
export type StageMetrics = { stage: Stage; provider: "stub" | "anthropic"; model: string; inputTokens: number;
  outputTokens: number; latencyMs: number; attempts: number; validationErrors: ValidationIssue[] };
export class AIStageError extends Error {
  constructor(public readonly code: Code, public readonly metrics: StageMetrics) {
    super(code); this.name = "AIStageError";
  }
}
type Config = Pick<Environment, "NODE_ENV" | "AI_PROVIDER" | "ANTHROPIC_API_KEY" | "AI_MODEL" | "AI_MAX_INPUT_TOKENS" | "AI_MAX_CONCURRENCY" | "AI_FAULT_INJECTION">;
type Options = { fetch?: typeof fetch };
const CALL_TIMEOUT = 120000;
const JOB_TIMEOUT = 300000;
const TOOL = "submit_analysis";

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
  const provider = config.NODE_ENV === "production" ? "anthropic" : config.AI_PROVIDER;
  if (provider === "anthropic" && !config.ANTHROPIC_API_KEY?.trim()) throw new Error("Missing ANTHROPIC_API_KEY");
  const fault = config.NODE_ENV === "production" ? undefined : config.AI_FAULT_INJECTION;
  let faultUsed = false;
  // SDK retries and logs are disabled: this boundary owns the bounded policy and
  // SDK debug output can contain bodies. Never inherit API base URLs from env.
  const client = provider === "anthropic" ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, authToken: null,
    baseURL: "https://api.anthropic.com", maxRetries: 0, timeout: CALL_TIMEOUT, logLevel: "off", openTelemetry: false, fetch: options.fetch }) : undefined;
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

  return async function runStage(stage: Stage, rawInput: unknown, externalSignal?: AbortSignal): Promise<{ payload: ProblemAnalysis; metrics: StageMetrics }> {
    const started = Date.now();
    const metrics: StageMetrics = { stage, provider, model: config.AI_MODEL, inputTokens: 0, outputTokens: 0,
      latencyMs: 0, attempts: 0, validationErrors: [] };
    const fail = (code: Code) => new AIStageError(code, metrics);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(fail("AI_TIMEOUT")), JOB_TIMEOUT);
    const signal = externalSignal ? AbortSignal.any([externalSignal, deadline.signal]) : deadline.signal;
    const pending = new Set<Promise<unknown>>();
    let acquired = false;

    async function call<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(fail("AI_TIMEOUT")), CALL_TIMEOUT);
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

    async function transport<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      for (let retry = 0; ; retry++) {
        try { return await call(work); }
        catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof AIStageError) throw error;
          if (error instanceof Anthropic.APIConnectionTimeoutError) throw fail("AI_TIMEOUT");
          const retryable = error instanceof Anthropic.APIConnectionError ||
            (error instanceof Anthropic.APIError && (error.status === 429 || (error.status ?? 0) >= 500));
          if (!retryable || retry >= 2) throw fail("AI_PROVIDER_ERROR");
          await pause(retry === 0 ? 2000 : 8000, signal);
        }
      }
    }

    try {
      if (stage !== "problem_analysis") throw fail("AI_INPUT_INVALID");
      const parsed = ProblemAnalysisInputSchema.safeParse(rawInput);
      if (!parsed.success) { metrics.validationErrors = schemaIssues(parsed.error.issues); throw fail("AI_INPUT_INVALID"); }
      await acquire(signal); acquired = true;
      const original = parsed.data.problemStatement;
      const input = redactInput(parsed.data);
      if (!input) { metrics.validationErrors = [{ path: "input", code: "sensitive_identifier" }]; throw fail("AI_INPUT_INVALID"); }
      let inputTruncated = false;
      const count = async (source: string) => {
        if (!client) return Buffer.byteLength(source, "utf8"); // Conservative byte cap in offline tests; not reported as measured tokens.
        const result = await transport((signal) => client.messages.countTokens({ model: config.AI_MODEL,
          messages: [{ role: "user", content: source }] }, { signal }));
        if (!Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0) throw fail("AI_PROVIDER_ERROR");
        return result.input_tokens;
      };
      if (await count(input.problemStatement) > config.AI_MAX_INPUT_TOKENS) {
        const points = Array.from(input.problemStatement);
        let low = 0, high = points.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (await count(points.slice(0, middle).join("")) <= config.AI_MAX_INPUT_TOKENS) low = middle;
          else high = middle - 1;
        }
        input.problemStatement = points.slice(0, low).join(""); inputTruncated = true;
        if (!input.problemStatement.trim() || await count(input.problemStatement) > config.AI_MAX_INPUT_TOKENS) throw fail("AI_INPUT_TOO_LARGE");
      }
      const [system, template] = await call(() => Promise.all([
        readFile(new URL("../../../prompts/problem_analysis.system.md", import.meta.url), "utf8"),
        readFile(new URL("../../../prompts/problem_analysis.user.md", import.meta.url), "utf8"),
      ]));
      if (!template.includes("{{input}}") || !template.includes("{{validationErrors}}")) throw fail("AI_PROVIDER_ERROR");
      const jsonSchema = z.toJSONSchema(ProblemAnalysisSchema);
      let errors: ValidationIssue[] = [];
      for (let repair = 0; repair < 2; repair++) {
        // One replacement pass prevents client text containing template markers from being interpreted.
        const user = template.replace(/\{\{(input|validationErrors)\}\}/g, (_, key: string) =>
          key === "input" ? JSON.stringify({ ...input, inputTruncated }) : JSON.stringify(errors));
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
            return client!.messages.create({ model: config.AI_MODEL, max_tokens: 12000, system,
              messages: [{ role: "user", content: user }], tools: [{ name: TOOL, input_schema: { ...jsonSchema, type: "object" } }],
              tool_choice: { type: "tool", name: TOOL, disable_parallel_tool_use: true } }, { signal });
          });
          const usage = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
            cache_creation_input_tokens: z.number().int().nonnegative().nullish(), cache_read_input_tokens: z.number().int().nonnegative().nullish(),
          }).safeParse(message.usage);
          if (!usage.success) throw fail("AI_PROVIDER_ERROR");
          metrics.inputTokens += usage.data.input_tokens + (usage.data.cache_creation_input_tokens ?? 0) + (usage.data.cache_read_input_tokens ?? 0);
          metrics.outputTokens += usage.data.output_tokens;
          const tools = message.content.filter((block) => block.type === "tool_use");
          output = message.stop_reason === "tool_use" && tools.length === 1 && tools[0]!.name === TOOL ? tools[0]!.input : null;
        }
        signal.throwIfAborted();
        const result = validateProblemAnalysis(output, input.problemStatement);
        errors = result.success ? [] : result.errors;
        // A redacted quote must also exist verbatim in the original source.
        if (result.success && result.data.painPoints.some((point) => !original.includes(point.quote) || point.quote.includes("[redacted]"))) {
          errors = [{ path: "painPoints", code: "quote_not_in_source" }];
        }
        if (result.success && !errors.length) return { payload: { ...result.data, inputTruncated }, metrics };
        metrics.validationErrors.push(...errors);
      }
      throw fail("AI_INVALID_OUTPUT");
    } catch (error) {
      if (deadline.signal.aborted) throw fail("AI_TIMEOUT");
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
export function runStage(stage: Stage, input: unknown, signal?: AbortSignal) {
  defaultRunner ??= createStageRunner(parseEnvironment());
  return defaultRunner(stage, input, signal);
}
