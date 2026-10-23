import Anthropic from "@anthropic-ai/sdk";

export type Provider = "stub" | "anthropic" | "deepinfra" | "openrouter";
export type FailureCategory = "credit" | "auth" | "rate_limit" | "overloaded" | "invalid_request" | "timeout" | "unknown";

// Never inherited from env: a stray ANTHROPIC_BASE_URL must not redirect prompts.
// The SDK appends /v1/messages to the base URL, so OpenRouter's is its origin + /api (-> https://openrouter.ai/api/v1/messages).
const BASE_URLS = { anthropic: "https://api.anthropic.com", deepinfra: "https://api.deepinfra.com/anthropic", openrouter: "https://openrouter.ai/api" } as const;

/** Every provider speaks the Anthropic Messages protocol, so one SDK serves all. OpenRouter authenticates with
 * `Authorization: Bearer <key>` (SDK authToken); the others use `x-api-key`. */
export function createProviderClient(provider: "anthropic" | "deepinfra" | "openrouter", apiKey: string, timeout: number, fetch?: typeof globalThis.fetch) {
  const auth = provider === "openrouter" ? { apiKey: null, authToken: apiKey } : { apiKey, authToken: null };
  return new Anthropic({ ...auth, baseURL: BASE_URLS[provider], maxRetries: 0, timeout,
    logLevel: "off", openTelemetry: false, fetch });
}

const CREDIT = /credit balance|insufficient (funds|credit|balance)|billing|payment required|out of credit/i;

/** OpenRouter reports its HTTP-like code in the body, `{"error":{"code":402,"message":...}}`, and repeats it there for errors
 * that arrive inside a 200 stream, where the SDK sees no failing status. Numeric (or numeric-string) 4xx/5xx codes only. */
function bodyStatus(code: unknown): number | undefined {
  const value = typeof code === "number" ? code : typeof code === "string" && /^\d{3}$/.test(code) ? Number(code) : undefined;
  return value !== undefined && value >= 400 && value <= 599 ? value : undefined;
}

/** Derive a reason category from status, error type and message. The message is inspected, never returned. */
export function classifyProviderError(error: unknown): { status?: number; errorType?: string; category: FailureCategory } {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return { category: "timeout" };
  if (!(error instanceof Anthropic.APIError)) return { category: "unknown" };
  const body = error.error as { type?: unknown; error?: { type?: unknown; code?: unknown } } | undefined;
  const raw = body?.error?.type ?? body?.type;
  const errorType = typeof raw === "string" && /^[a-z_]{1,40}$/.test(raw) && raw !== "error" ? raw : undefined;
  const status = error.status !== undefined && error.status >= 400 ? error.status : bodyStatus(body?.error?.code);
  const category: FailureCategory = CREDIT.test(error.message) || status === 402 ? "credit"
    : status === 401 || status === 403 || errorType === "authentication_error" || errorType === "permission_error" ? "auth"
    : status === 429 || errorType === "rate_limit_error" ? "rate_limit"
    : status === 529 || errorType === "overloaded_error" ? "overloaded"
    : status === 408 || status === 504 ? "timeout"
    : status === 400 || errorType === "invalid_request_error" ? "invalid_request" : "unknown";
  return { status, errorType, category };
}

const TRANSIENT_STATUS: ReadonlySet<number> = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const TRANSIENT_TYPES: ReadonlySet<string> = new Set(["overloaded_error", "api_error", "rate_limit_error"]);

/** True when the same request may succeed if sent again. Never true for 400/401/402/403/404 or a credit message.
 * An error with no HTTP status (an `error` event inside the stream, which the SDK raises without one) is judged by its error type. */
export function isTransientProviderError(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true; // includes the SDK's own timeout
  if (error instanceof Anthropic.APIError) {
    const { status, errorType, category } = classifyProviderError(error);
    if (category === "credit" || category === "auth") return false;
    return status !== undefined ? TRANSIENT_STATUS.has(status) : errorType !== undefined && TRANSIENT_TYPES.has(errorType);
  }
  // The stream ended without a complete message, or the socket was cut while the body was being read.
  return error instanceof Anthropic.AnthropicError || (error instanceof TypeError && error.message === "terminated");
}

/** The provider's Retry-After (seconds or HTTP date) in ms, or undefined when absent or unusable. */
export function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
  const value = error instanceof Anthropic.APIError ? error.headers?.get("retry-after")?.trim() : undefined;
  if (!value) return undefined;
  const ms = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined;
}

/** One structured line per provider failure for the operator. Carries no prompt, user data or key. */
export function logProviderFailure(provider: Provider, model: string, stage: string, error: unknown) {
  console.error(JSON.stringify({ event: "ai_provider_error", provider, model, stage, ...classifyProviderError(error) }));
}

/** One structured line per retried provider call. Carries no prompt, user data or key. */
export function logProviderRetry(provider: Provider, model: string, stage: string, attempt: number, delayMs: number, error: unknown) {
  const { status, errorType } = classifyProviderError(error);
  console.error(JSON.stringify({ event: "ai_provider_retry", provider, model, stage, attempt, status, errorType, delayMs }));
}

/** One structured line when the runner's whole-stage budget expires. Carries no prompt, user data or key. */
export function logStageTimeout(provider: Provider, model: string, stage: string, elapsedMs: number, attempts: number) {
  console.error(JSON.stringify({ event: "ai_stage_timeout", provider, model, stage, elapsedMs, attempts }));
}
