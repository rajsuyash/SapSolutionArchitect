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

/** Derive a reason category from status, error type and message. The message is inspected, never returned. */
export function classifyProviderError(error: unknown): { status?: number; errorType?: string; category: FailureCategory } {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return { category: "timeout" };
  if (!(error instanceof Anthropic.APIError)) return { category: "unknown" };
  const body = error.error as { type?: unknown; error?: { type?: unknown } } | undefined;
  const raw = body?.error?.type ?? body?.type;
  const errorType = typeof raw === "string" && /^[a-z_]{1,40}$/.test(raw) && raw !== "error" ? raw : undefined;
  const status = error.status;
  const category: FailureCategory = CREDIT.test(error.message) || status === 402 ? "credit"
    : status === 401 || status === 403 || errorType === "authentication_error" || errorType === "permission_error" ? "auth"
    : status === 429 || errorType === "rate_limit_error" ? "rate_limit"
    : status === 529 || errorType === "overloaded_error" ? "overloaded"
    : status === 408 || status === 504 ? "timeout"
    : status === 400 || errorType === "invalid_request_error" ? "invalid_request" : "unknown";
  return { status, errorType, category };
}

/** One structured line per provider failure for the operator. Carries no prompt, user data or key. */
export function logProviderFailure(provider: Provider, model: string, stage: string, error: unknown) {
  console.error(JSON.stringify({ event: "ai_provider_error", provider, model, stage, ...classifyProviderError(error) }));
}

/** One structured line when the runner's whole-stage budget expires. Carries no prompt, user data or key. */
export function logStageTimeout(provider: Provider, model: string, stage: string, elapsedMs: number, attempts: number) {
  console.error(JSON.stringify({ event: "ai_stage_timeout", provider, model, stage, elapsedMs, attempts }));
}
