import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failureCode, missedExtractions, runExtractionJob } from "../src/lib/consultant-extraction";
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
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ event: "extraction_failed", jobId, code: "AI_PROVIDER_ERROR" });
  });
});
