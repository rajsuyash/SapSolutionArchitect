import { isTransientProviderError, retryAfterMs } from "./provider";

/** Waits before retry 1, 2 and 3 of one provider call (so at most 3 retries), each scaled by +-RETRY_JITTER. */
export const RETRY_DELAYS_MS = [2000, 6000, 18000] as const;
export const RETRY_JITTER = 0.2;
/** Upper bound for any wait, a provider's Retry-After included: a budget is minutes, not the hour a 429 may ask for. */
export const RETRY_DELAY_CAP_MS = 30000;
/** A retry starts only if, after its wait, the deadline still holds this long (or the per-call timeout, if shorter).
 * A streamed generation with less than 30 s left cannot realistically finish, and the attempt would only delay the failure. */
export const MIN_RETRY_WINDOW_MS = 30000;

export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** The wait before retry number `retry` (0-based): the backoff with jitter, raised to the provider's Retry-After, capped. */
export function retryDelayMs(retry: number, error: unknown): number {
  const backoff = RETRY_DELAYS_MS[retry]! * (1 - RETRY_JITTER + 2 * RETRY_JITTER * Math.random());
  return Math.round(Math.min(Math.max(backoff, retryAfterMs(error) ?? 0), RETRY_DELAY_CAP_MS));
}

export type RetryOptions = {
  /** Aborts the wait and the loop; an aborted signal rethrows the error at once. */
  signal?: AbortSignal;
  /** Epoch ms after which no retry starts. Omit for no deadline. */
  deadlineAt?: number;
  /** Per-call timeout, for the "does a retry still fit" check. */
  callTimeoutMs: number;
  /** Errors that are never retried and are rethrown untouched (the caller's own error types). */
  passthrough?: (error: unknown) => boolean;
  /** Maps the error that ends the loop to the one thrown. `reason`: "permanent" (not transient), "exhausted" (retries used up) or "deadline" (no room left). */
  giveUp?: (error: unknown, reason: "permanent" | "exhausted" | "deadline") => unknown;
  onRetry?: (retry: number, delayMs: number, error: unknown) => void;
};

/** Runs `work`, re-sending it after a transient provider failure (5xx, 429, overloaded, dropped connection or stream, "terminated")
 * with 2/6/18 s backoff and jitter, at most three times. The one retry policy of the runner and the eval judge. */
export async function withProviderRetry<T>(work: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { signal, deadlineAt, callTimeoutMs, passthrough, giveUp = error => error, onRetry } = options;
  for (let retry = 0; ; retry++) {
    try { return await work(); }
    catch (error) {
      if (signal?.aborted || passthrough?.(error)) throw error;
      if (!isTransientProviderError(error)) throw giveUp(error, "permanent");
      if (retry >= RETRY_DELAYS_MS.length) throw giveUp(error, "exhausted");
      const delay = retryDelayMs(retry, error);
      if (deadlineAt !== undefined && deadlineAt - Date.now() - delay < Math.min(callTimeoutMs, MIN_RETRY_WINDOW_MS)) throw giveUp(error, "deadline");
      onRetry?.(retry + 1, delay, error);
      await pause(delay, signal);
    }
  }
}
