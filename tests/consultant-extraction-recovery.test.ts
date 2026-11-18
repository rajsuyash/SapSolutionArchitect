import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failureCode, missedExtractions, runExtractionJob, summarizeExtraction, extractionLogEvent, inputShape } from "../src/lib/consultant-extraction";
import type { createStageRunner } from "../src/lib/ai/runStage";

const users = (n: number) => Array.from({ length: n }, (_, i) => [{ id: `u${i + 1}`, role: "user" }, { id: `a${i + 1}`, role: "assistant" }]).flat();

describe("missedExtractions", () => {
  it("picks earlier unextracted, unqueued messages with their real user-message position, oldest first", () => {
    const picked = missedExtractions(users(8), ["u1", "u2", "u3"], new Set(["u5"]), "u8");
    expect(picked).toEqual([{ messageId: "u4", seq: 4 }, { messageId: "u6", seq: 6 }, { messageId: "u7", seq: 7 }]);
  });
  it("keeps only the most recent five and never includes the current message", () => {
    const picked = missedExtractions(users(10), [], new Set(), "u10");
    expect(picked.map(p => p.seq)).toEqual([5, 6, 7, 8, 9]);
  });
  it("returns nothing when everything earlier is extracted or the message is unknown", () => {
    expect(missedExtractions(users(3), ["u1", "u2"], new Set(), "u3")).toEqual([]);
    expect(missedExtractions(users(3), undefined, new Set(), "nope")).toEqual([]);
  });
});

describe("failureCode", () => {
  it("prefers a code-shaped error.code, then message, then the error name, never free text", () => {
    expect(failureCode(Object.assign(new Error("secret user text"), { code: "AI_TIMEOUT" }))).toBe("AI_TIMEOUT");
    expect(failureCode(new Error("EXTRACTION_ORDER_TIMEOUT"))).toBe("EXTRACTION_ORDER_TIMEOUT");
    expect(failureCode(new TypeError("the user said something private"))).toBe("TypeError");
    expect(failureCode("raw string")).toBe("UnknownError");
  });
});

describe("runExtractionJob", () => {
  afterEach(() => vi.restoreAllMocks());
  it("logs one line with a fixed code and rethrows the original error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(new Error("private answer text"), { code: "AI_PROVIDER_ERROR" });
    const pool = { query: async () => { throw failure; } } as unknown as Pool;
    const jobId = randomUUID();
    const data = { scope: "s", orgId: randomUUID(), projectId: randomUUID(), variantCode: "RENTAL", requestedBy: randomUUID(), messageId: "m1", seq: 2 };
    await expect(runExtractionJob(pool, (async () => ({})) as unknown as ReturnType<typeof createStageRunner>, { id: jobId, data },
      new AbortController().signal, 5)).rejects.toBe(failure);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ event: "extraction_failed", jobId, durationMs: expect.any(Number), code: "AI_PROVIDER_ERROR" });
  });
});

describe("summarizeExtraction", () => {
  const payload = (n: Partial<Record<"proposedUpdates" | "proposedSteps" | "proposedRequirements" | "observations", number>>) =>
    Object.fromEntries(["proposedUpdates", "proposedSteps", "proposedRequirements", "observations"].map(key => [key, Array.from({ length: n[key as keyof typeof n] ?? 0 })])) as unknown as
      Parameters<typeof summarizeExtraction>[0];
  it("counts kept entries and derives returned and dropped from the warnings, by reason code", () => {
    const summary = summarizeExtraction(payload({ proposedUpdates: 3, proposedSteps: 0, observations: 1 }), [
      { path: "proposedUpdates.F_secret_field", code: "update_dropped", detail: "echoed_value" },
      { path: "proposedUpdates.2", code: "update_dropped", detail: "echoed_value" },
      { path: "proposedSteps.0", code: "step_dropped", detail: "duplicate_step" },
      { path: "proposedSteps.1", code: "evidence_span_too_long" },
      { path: "proposedRequirements", code: "proposals_truncated", detail: "dropped 4" },
      { path: "proposedUpdates.0", code: "answer_fallback", detail: "answer_not_in_quote" },
      { path: "proposedSteps.0.nameHint", code: "name_hint_dropped" },
    ]);
    expect(summary.kept).toEqual({ updates: 3, steps: 0, requirements: 0, observations: 1 });
    expect(summary.dropped).toEqual({ updates: 2, steps: 2, requirements: 4, observations: 0 });
    expect(summary.returned).toEqual({ updates: 5, steps: 2, requirements: 4, observations: 1 });
    expect(summary.dropReasons).toEqual({ "update_dropped:echoed_value": 2, "step_dropped:duplicate_step": 1, evidence_span_too_long: 1, proposals_truncated: 4 });
    expect(summary.answerFallbacks).toBe(1);
  });
  it("never lets free text into a reason code", () => {
    const summary = summarizeExtraction(payload({}), [{ path: "proposedUpdates.0", code: "update_dropped", detail: "Client said: hello" }]);
    expect(Object.keys(summary.dropReasons)).toEqual(["update_dropped"]);
  });
  it("handles a run with no warnings", () => {
    expect(summarizeExtraction(payload({}), undefined).returned).toEqual({ updates: 0, steps: 0, requirements: 0, observations: 0 });
  });
});

describe("extractionLogEvent / runExtractionJob logging", () => {
  afterEach(() => vi.restoreAllMocks());
  const runner = (async () => ({})) as unknown as ReturnType<typeof createStageRunner>;
  it("logs a skip with a reason code when the job payload is invalid", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const jobId = randomUUID();
    expect(await runExtractionJob({} as Pool, runner, { id: jobId, data: { nope: 1 } }, new AbortController().signal, 5)).toBeUndefined();
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ event: "extraction_skipped", jobId, durationMs: expect.any(Number), reason: "invalid_job_payload" });
  });
  const marker = "SECRET_MARKER_TEXT";
  const shape = { steps: 2, fields: 3, emptyFields: 1, pendingFields: 1, requirements: 4, currentSentences: 2, evidenceSentences: 3, totalSentences: 5, messageChars: 40 };
  const recorded = (metrics: object) => ({ status: "RECORDED" as const, metrics: metrics as never, inputShape: shape, proposalsAdded: 0, observationsAdded: 0,
    summary: summarizeExtraction({ proposedUpdates: [], proposedSteps: [], proposedRequirements: [], observations: [] }, undefined) });
  it("logs provider diagnostics and the input shape as numbers", () => {
    const event = extractionLogEvent("j1", 5, recorded({ provider: "deepinfra", model: "m1", inputTokens: 10, outputTokens: 2, attempts: 2, providerRetries: 1,
      stopReasons: ["tool_use", null, `ignore ${marker}`, "length"], textFallbacks: 1, validationErrors: [{ path: marker, code: "x", detail: marker }, { path: "b", code: "y" }] }));
    expect(event).toMatchObject({ provider: "deepinfra", model: "m1", inputTokens: 10, outputTokens: 2, attempts: 2, providerRetries: 1,
      stopReasons: ["tool_use", null, "other", "length"], textFallbacks: 1, validationErrorCount: 2, input: shape });
    expect(JSON.stringify(event)).not.toContain(marker);
  });
  it("defaults absent optional metrics to 0 and []", () => {
    expect(extractionLogEvent("j1", 5, recorded({ provider: "p", model: "m", inputTokens: 1, outputTokens: 1, attempts: 1, validationErrors: [] })))
      .toMatchObject({ providerRetries: 0, stopReasons: [], textFallbacks: 0, validationErrorCount: 0 });
  });
  it("describes the model input by counts and lengths only", () => {
    const text = `First ${marker}. Second one.`;
    const input = { currentMessage: { id: "m", text }, evidence: [{ id: "e", text: "One thing. Two things. Three things." }],
      steps: [{ id: "s1" }, { id: "s2" }], requirements: [{ statement: marker }],
      fields: [{ id: "a", value: marker, status: "KNOWN" }, { id: "b", value: null, status: "EMPTY", pending: true }, { id: "c", value: null, status: "EMPTY" }] };
    const result = inputShape(input as never);
    expect(result).toEqual({ steps: 2, fields: 3, emptyFields: 2, pendingFields: 1, requirements: 1, currentSentences: 2, evidenceSentences: 3,
      totalSentences: 5, messageChars: text.length });
    expect(JSON.stringify(result)).not.toContain(marker);
  });
  it("describes a recorded extraction with counts only", () => {
    const summary = summarizeExtraction({ proposedUpdates: [1], proposedSteps: [], proposedRequirements: [], observations: [] },
      [{ path: "proposedSteps.0", code: "step_dropped", detail: "duplicate_step" }]);
    const event = extractionLogEvent("j1", 12, { status: "RECORDED", metrics: {} as never, inputShape: shape, summary, proposalsAdded: 1, observationsAdded: 0 });
    expect(event).toMatchObject({ event: "extraction_succeeded", durationMs: 12, returned: { updates: 1, steps: 1 }, dropped: { steps: 1 },
      dropReasons: { "step_dropped:duplicate_step": 1 }, proposalsAdded: 1, workspaceChanged: true });
    expect(extractionLogEvent("j1", 1, { status: "ALREADY_EXTRACTED" })).toMatchObject({ event: "extraction_skipped", reason: "already_extracted" });
  });
});
