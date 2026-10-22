import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { fixture } from "./support/interview-input";
import { asStream } from "./support/sse";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const settings = parseEnvironment({ ...local, NODE_ENV: "test", AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-metrics-key" });
const json = { headers: { "content-type": "application/json" } };
/** A provider that answers every call with a tool payload the schema rejects (unknown key, missing fields). */
const runner = (issueDetail: boolean) => createStageRunner(settings, { issueDetail, fetch: vi.fn<typeof globalThis.fetch>(async url =>
  String(url).includes("count_tokens") ? new Response(JSON.stringify({ input_tokens: 10 }), json)
    : asStream(new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t", name: "submit_interview_turn", input: { approved: "private-invalid-output" } }],
      usage: { input_tokens: 30, output_tokens: 20 } }), json))) });

describe("StageMetrics capture on the failure path", () => {
  it("records attempts, tokens and the issues of each failed attempt on the thrown error", async () => {
    const error = await runner(false)("interview_turn", fixture()).then(() => null, e => e);
    expect(error).toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 2, inputTokens: 60, outputTokens: 40 } });
    const { attemptIssues, validationErrors } = error.metrics;
    expect(attemptIssues).toHaveLength(2);
    expect(attemptIssues[0].length).toBeGreaterThan(0);
    expect(attemptIssues.flat()).toEqual(validationErrors);
    expect(attemptIssues[0][0]).toEqual({ path: expect.any(String), code: expect.any(String) }); // no detail by default
  });
  it("adds schema messages only when issueDetail is on, and never the model's text", async () => {
    const error = await runner(true)("interview_turn", fixture()).then(() => null, e => e);
    const issues = error.metrics.attemptIssues.flat();
    expect(issues.every((i: { detail?: string }) => typeof i.detail === "string" && i.detail.length > 0)).toBe(true);
    expect(JSON.stringify(issues)).not.toContain("private-invalid-output");
  });
});
