/** Extra time after the stage budget for the pre-stage and completion transactions, so a valid late result is not fenced out. */
const HEADROOM_SECONDS = 60;

/** Job-row deadline and queue expiry derived from the whole-stage budget (AI_STAGE_BUDGET_SECONDS).
 * The per-job `expireInSeconds` passed to pg-boss send() is authoritative: createQueue() is
 * ON CONFLICT DO NOTHING, so an existing queue keeps the expiry it was created with. */
export function jobTiming(stageBudgetSeconds: number) {
  const deadlineSeconds = stageBudgetSeconds + HEADROOM_SECONDS;
  return { deadlineSeconds, queueExpireSeconds: deadlineSeconds + HEADROOM_SECONDS };
}

/** Used when a service is constructed without configuration (tests); equals the AI_STAGE_BUDGET_SECONDS default. */
export const DEFAULT_STAGE_BUDGET_SECONDS = 300;
