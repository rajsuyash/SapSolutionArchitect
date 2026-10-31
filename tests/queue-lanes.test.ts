import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { fixture } from "./support/interview-input";
import { asStream } from "./support/sse";

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const settings = (overrides = {}) => parseEnvironment({ ...local, NODE_ENV: "test", AI_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "synthetic-lane-test-key", ...overrides });
const defer = () => { let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; }); return { gate, open }; };
const settled = (promise: Promise<unknown>) => Promise.race([promise.then(() => "done", () => "done"), new Promise<string>(r => setTimeout(() => r("pending"), 150))]);
const problem = { name: "Order intake", clientName: "Synthetic Client", targetProduct: "S4HANA_CLOUD_PRIVATE", problemStatement: "Orders are re-keyed by hand into the legacy system and arrive late at the warehouse every week." };

/** A provider that answers interview turns at once and holds problem analysis (the batch lane) until released. */
function provider(analysisGate: Promise<void>) {
  const started: string[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { tools?: { name: string }[] };
    const interview = body.tools?.[0]?.name === "submit_interview_turn";
    if (String(url).includes("count_tokens")) {
      if (!interview) { started.push("analysis"); await analysisGate; }
      return new Response(JSON.stringify({ input_tokens: 10 }), { headers: { "content-type": "application/json" } });
    }
    started.push(interview ? "interview" : "analysis-call");
    const input = interview ? { reply: "Thank you for that context.", questions: [{ gapKey: "return-date-gap", question: "Which date stops the rental charge?",
      whyItMatters: "This changes the final invoice amount." }], proposedUpdates: [], proposedSteps: [], proposedRequirements: [], observations: [] } : {};
    return asStream(new Response(JSON.stringify({ id: "msg", type: "message", role: "assistant", model: "synthetic",
      content: [{ type: "tool_use", id: "t", name: interview ? "submit_interview_turn" : "submit_analysis", input }], stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 10 } }), { headers: { "content-type": "application/json" } }));
  };
  return { fetch, started };
}

describe("model-call lanes: chat is never queued behind batch work", () => {
  it("runs an interview turn while a batch stage holds the only batch slot", async () => {
    const hold = defer(); const p = provider(hold.gate);
    const run = createStageRunner(settings({ AI_MAX_CONCURRENCY: "1", AI_CHAT_CONCURRENCY: "1" }), { fetch: p.fetch });
    const batch = run("problem_analysis", problem).catch(() => undefined);
    await expect.poll(() => p.started).toContain("analysis");
    const chat = run("interview_turn", fixture());
    await expect(chat).resolves.toMatchObject({ metrics: { stage: "interview_turn" } });
    expect(p.started).toContain("interview");
    expect(await settled(batch)).toBe("pending"); // the batch stage is still held while the turn completed
    hold.open(); await batch;
  });

  it("control: a second batch stage does wait for the held slot", async () => {
    const hold = defer(); const p = provider(hold.gate);
    const run = createStageRunner(settings({ AI_MAX_CONCURRENCY: "1", AI_CHAT_CONCURRENCY: "1" }), { fetch: p.fetch });
    const first = run("problem_analysis", problem).catch(() => undefined);
    await expect.poll(() => p.started).toContain("analysis");
    const second = run("problem_analysis", problem).catch(() => undefined);
    expect(await settled(second)).toBe("pending");
    expect(p.started.filter(name => name === "analysis")).toHaveLength(1); // the second never reached the provider
    hold.open(); await Promise.all([first, second]);
  });

  it("limits chat turns to AI_CHAT_CONCURRENCY slots", async () => {
    const hold = defer(); const entered: number[] = [];
    let active = 0, peak = 0;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (String(url).includes("count_tokens")) {
        active++; peak = Math.max(peak, active); entered.push(active); await hold.gate; active--;
        return new Response(JSON.stringify({ input_tokens: 10 }), { headers: { "content-type": "application/json" } });
      }
      return provider(Promise.resolve()).fetch(url, init);
    };
    const run = createStageRunner(settings({ AI_CHAT_CONCURRENCY: "2" }), { fetch });
    const turns = [1, 2, 3].map(() => run("interview_turn", fixture()));
    await expect.poll(() => entered.length).toBe(2);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(peak).toBe(2); // the third waits for a slot
    hold.open(); await Promise.all(turns);
  });
});
