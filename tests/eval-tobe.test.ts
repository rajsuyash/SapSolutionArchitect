import { describe, expect, it } from "vitest";
import type { StageMetrics } from "../src/lib/ai/runStage";
import { TranscriptSchema } from "../src/lib/eval-score";
import { rentalDraftV3 } from "../fixtures/ai/to-be/rental-registers";
import { toBeRun, toBeSummary } from "../src/lib/eval-tobe";

const failed: StageMetrics = { stage: "to_be", provider: "deepinfra", model: "m", inputTokens: 64624, outputTokens: 16000, latencyMs: 91500, attempts: 2,
  validationErrors: [{ path: "to_be_outline", code: "OUTPUT_TRUNCATED" }, { path: "to_be_outline", code: "OUTPUT_TRUNCATED" }],
  attemptIssues: [[{ path: "to_be_outline", code: "OUTPUT_TRUNCATED" }], [{ path: "to_be_outline", code: "OUTPUT_TRUNCATED" }]],
  stopReasons: ["max_tokens", null], substages: { to_be_outline: { calls: 2, inputTokens: 64624, outputTokens: 16000 } } };

describe("toBeRun", () => {
  it("keeps stop reasons, issue codes and paths, per-substage tokens and latency from a failed stage", () => {
    const run = toBeRun(failed);
    expect(run).toMatchObject({ attempts: 2, validationErrors: 2, inputTokens: 64624, outputTokens: 16000, latencyMs: 91500, stopReasons: ["max_tokens", "none"] });
    expect(run.issues).toEqual([{ attempt: 1, path: "to_be_outline", code: "OUTPUT_TRUNCATED" }, { attempt: 2, path: "to_be_outline", code: "OUTPUT_TRUNCATED" }]);
    expect(run.substages).toEqual({ to_be_outline: { calls: 2, inputTokens: 64624, outputTokens: 16000 } });
  });
  it("returns zeros for an error that carries no metrics, and validates against the transcript schema", () => {
    expect(toBeRun(undefined)).toMatchObject({ attempts: 0, stopReasons: [], issues: [], substages: {} });
    const toBe = { attempted: true, structurallyValid: false, errorCode: "AI_INVALID_OUTPUT", requirements: [], design: null, ...toBeRun(failed) };
    const parsed = TranscriptSchema.parse({ schemaVersion: 1, caseId: "c", provider: "p", model: "m", startedAt: "t", turns: [],
      readiness: { reached: false, atTurn: null, forcedCompletion: false, directEdits: 0, blockers: [] }, toBe, aborted: null });
    expect(parsed.toBe!.issues).toHaveLength(2); expect(parsed.toBe!.substages!.to_be_outline!.calls).toBe(2);
  });
  it("prints one summary line with the tally, top codes and substage tokens", () => {
    expect(toBeSummary(toBeRun(failed), "AI_INVALID_OUTPUT")).toBe(
      "To-Be AI_INVALID_OUTPUT: 2 calls 92s; stop reasons max_tokensx1 nonex1; top errors OUTPUT_TRUNCATEDx2; substages outline 2c 64624in/16000out");
  });
  it("carries the issue detail, repair warnings and raw failed payloads into the transcript", () => {
    const diag: StageMetrics = { ...failed, attemptIssues: [[{ path: "outline", code: "INVALID_DRAFT", detail: "invalid_type: expected array, received string" }]],
      warnings: [{ path: "outline.steps", code: "REPAIRED_STRINGIFIED_JSON" }],
      rawFailures: [{ substage: "to_be_outline", key: "outline", attempt: 1, json: '{"coverage":"[]"}', truncated: false }] };
    const run = toBeRun(diag);
    expect(run.issues).toEqual([{ attempt: 1, path: "outline", code: "INVALID_DRAFT", detail: "invalid_type: expected array, received string" }]);
    const toBe = { attempted: true, structurallyValid: false, errorCode: "AI_INVALID_OUTPUT", requirements: [], design: null, ...run };
    const parsed = TranscriptSchema.parse({ schemaVersion: 1, caseId: "c", provider: "p", model: "m", startedAt: "t", turns: [],
      readiness: { reached: false, atTurn: null, forcedCompletion: false, directEdits: 0, blockers: [] }, toBe, aborted: null });
    expect(parsed.toBe!.rawFailures).toEqual(diag.rawFailures); expect(parsed.toBe!.warnings).toEqual(run.warnings);
    expect(parsed.toBe!.issues![0]!.detail).toContain("received string");
  });
  it("stores a version 2 design exactly as produced: registers, coverage and every other key survive the transcript schema", () => {
    const toBe = { attempted: true, structurallyValid: true, errorCode: null, requirements: [], design: JSON.parse(JSON.stringify(rentalDraftV3)), ...toBeRun(failed) };
    const parsed = TranscriptSchema.parse({ schemaVersion: 1, caseId: "c", provider: "p", model: "m", startedAt: "t", turns: [],
      readiness: { reached: false, atTurn: null, forcedCompletion: false, directEdits: 0, blockers: [] }, toBe, aborted: null });
    expect(parsed.toBe!.design).toEqual(rentalDraftV3);
    expect(Object.keys(parsed.toBe!.design!)).toEqual(expect.arrayContaining(["schemaVersion", "processName", "coverage", "openQuestions", "fitGap", "orgStructure", "kpis", "interfaces", "cutover"]));
  });
});
