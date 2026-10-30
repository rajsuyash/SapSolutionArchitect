import { describe, expect, it } from "vitest";
import { z } from "zod";
import { rentalDraft } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";
import { classifyFailure, jobSucceededEvent } from "../src/lib/consultant-jobs";
import { substageEvents } from "../src/lib/ai/runStage";
import { runDesign, type DesignDeps } from "../src/lib/ai/to-be-pipeline";
import { zodIssues } from "../src/lib/auth-http";
import type { RegisterGroup } from "../src/lib/ai/design-registers";
import { fixture } from "./support/to-be-input";
import { splitDesign } from "./support/to-be-split";

describe("classifyFailure", () => {
  it.each([
    ["AI_TIMEOUT", "timeout"], ["AI_INVALID_OUTPUT", "invalid_output"], ["AI_PROVIDER_CREDIT", "provider_credit"],
    ["AI_PROVIDER_ERROR", "provider_error"], ["STALE_INPUT", "other"], ["AI_CANCELLED", "other"], ["CONSULTANT_FAILED", "other"],
  ])("%s -> %s", (code, expected) => expect(classifyFailure(code)).toBe(expected));
});

describe("jobSucceededEvent", () => {
  it("surfaces only what the metrics hold, never payload text", () => {
    const metrics = { stage: "to_be", inputTokens: 10, outputTokens: 5, substages: { to_be_step: { calls: 3, inputTokens: 6, outputTokens: 2 }, to_be_outline: { calls: 1, inputTokens: 4, outputTokens: 3 } } };
    expect(jobSucceededEvent("j1", "TO_BE", 1234, metrics, 2)).toEqual({ event: "consultant_job_succeeded", jobId: "j1", kind: "TO_BE", durationMs: 1234,
      calls: 4, inputTokens: 10, outputTokens: 5, blockerCount: 2 });
    expect(jobSucceededEvent("j2", "INTERVIEW", 5, { inputTokens: 1, outputTokens: 2 }, undefined))
      .toEqual({ event: "consultant_job_succeeded", jobId: "j2", kind: "INTERVIEW", durationMs: 5, inputTokens: 1, outputTokens: 2 });
  });
});

describe("substageEvents", () => {
  const substages = { to_be_outline: { calls: 1, inputTokens: 1, outputTokens: 1 }, to_be_step: { calls: 8, inputTokens: 1, outputTokens: 1 }, to_be_registers: { calls: 8, inputTokens: 1, outputTokens: 1 } };
  it("one event per substage of the phase, cumulative calls, no jobId when unknown", () => {
    expect(substageEvents("expand", substages, 5000, true)).toEqual([
      { event: "to_be_substage_finished", substage: "steps", calls: 8, elapsedMs: 5000, ok: true },
      { event: "to_be_substage_finished", substage: "registers", calls: 8, elapsedMs: 5000, ok: true }]);
    expect(substageEvents("outline", substages, 10, false, "job-1")).toEqual([{ event: "to_be_substage_finished", jobId: "job-1", substage: "outline", calls: 1, elapsedMs: 10, ok: false }]);
  });
  it("skips review and fix substages that made no calls", () => expect(substageEvents("review_fix", substages, 1, true)).toEqual([]));
});

describe("runDesign progress", () => {
  it("reports outline, expand, then review_fix, all ok", async () => {
    const split = splitDesign(rentalDraft), phases: [string, boolean][] = [];
    const deps: DesignDeps = { parallelism: 2, invalid: () => new Error("AI_INVALID_OUTPUT"), record: () => {}, progress: (phase, ok) => { phases.push([phase, ok]); },
      ask: async (substage, user, group) => substage === "to_be_outline" ? split.outline
        : substage === "to_be_step" ? split.details[(user as { step: { id: string } }).step.id] : rentalRegisterGroups[group as RegisterGroup] };
    await runDesign(fixture(), [], deps);
    expect(phases).toEqual([["outline", true], ["expand", true], ["review_fix", true]]);
  });
});

describe("zodIssues", () => {
  it("logs paths and codes only, never values", () => {
    const parsed = z.object({ secret: z.string() }).safeParse({ secret: 42 });
    const logged = JSON.stringify(zodIssues(parsed.error));
    expect(logged).toContain("secret");
    expect(logged).not.toContain("42");
    expect(zodIssues(new Error("x"))).toEqual({});
  });
});
