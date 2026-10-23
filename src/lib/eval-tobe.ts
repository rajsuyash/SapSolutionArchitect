import type { StageMetrics } from "./ai/runStage";

/** What the eval transcript keeps of a To-Be generation, on success and on failure. Codes and paths only, never model values. */
export type ToBeRun = {
  attempts: number; validationErrors: number; inputTokens: number; outputTokens: number; latencyMs: number;
  stopReasons: string[];
  issues: { attempt: number; path: string; code: string }[];
  substages: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
};

const MAX_ISSUES = 60;

/** Pure view of StageMetrics (from a result or from AIStageError.metrics); undefined (a non-stage error) yields zeros. */
export function toBeRun(m: StageMetrics | undefined): ToBeRun {
  const groups = m?.attemptIssues ?? (m?.validationErrors.length ? [m.validationErrors] : []);
  return {
    attempts: m?.attempts ?? 0, validationErrors: m?.validationErrors.length ?? 0, inputTokens: m?.inputTokens ?? 0,
    outputTokens: m?.outputTokens ?? 0, latencyMs: m?.latencyMs ?? 0,
    stopReasons: (m?.stopReasons ?? []).map(reason => reason ?? "none"),
    issues: groups.flatMap((group, i) => group.map(({ path, code }) => ({ attempt: i + 1, path, code }))).slice(0, MAX_ISSUES),
    substages: Object.fromEntries(Object.entries(m?.substages ?? {}).map(([name, v]) => [name, { ...v! }])),
  };
}

const tally = (values: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
};

/** One console line: stop reasons tally, top three error codes, tokens per substage. */
export function toBeSummary(run: ToBeRun, errorCode: string | null): string {
  const stops = tally(run.stopReasons).map(([reason, n]) => `${reason}x${n}`).join(" ") || "none";
  const codes = tally(run.issues.map(issue => issue.code)).slice(0, 3).map(([code, n]) => `${code}x${n}`).join(" ") || "none";
  const subs = Object.entries(run.substages).map(([name, v]) => `${name.replace("to_be_", "")} ${v.calls}c ${v.inputTokens}in/${v.outputTokens}out`).join("; ") || "none";
  return `To-Be ${errorCode ?? "ok"}: ${run.attempts} calls ${Math.round(run.latencyMs / 1000)}s; stop reasons ${stops}; top errors ${codes}; substages ${subs}`;
}
