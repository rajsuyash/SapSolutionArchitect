import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseEnv as parseDotEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createInfrastructure, ensureDevelopmentBucket } from "../src/lib/infrastructure";

const example = () => ({
  ...parseDotEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8")),
  NODE_ENV: "test",
});

describe("server environment", () => {
  it("accepts local configuration and supplies the PRD defaults", () => {
    const config = parseEnvironment(example());
    expect(config.AI_MODEL).toBe("claude-sonnet-5-5");
    expect(config.AI_MAX_INPUT_TOKENS).toBe(60000);
    expect(config.AI_MAX_CONCURRENCY).toBe(4);
    expect(config.AI_CHAT_CONCURRENCY).toBe(3);
    expect(config.AI_PROVIDER).toBe("stub");
    expect(config.CONSULTANT_DAILY_JOB_LIMIT).toBe(200);
    expect(parseEnvironment({ ...example(), CONSULTANT_DAILY_JOB_LIMIT: "50", AI_MAX_INPUT_TOKENS: "60000" }).CONSULTANT_DAILY_JOB_LIMIT).toBe(50);
  });

  it.each([
    "DATABASE_URL", "APP_URL", "AUTH_SECRET", "AI_PROVIDER", "EMAIL_PROVIDER",
    "EMAIL_FROM", "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ])("names missing %s without exposing values", (name) => {
    const input: Record<string, string> = example();
    delete input[name];
    expect(() => parseEnvironment(input)).toThrow(name);
  });

  it.each([
    ["DATABASE_URL", "https://database.invalid"],
    ["APP_URL", "javascript:alert(1)"],
    ["S3_ENDPOINT", "file:///tmp/storage"],
    ["AUTH_SECRET", "short"],
    ["AI_MAX_CONCURRENCY", "0"],
    ["AI_CHAT_CONCURRENCY", "0"],
    ["AI_CHAT_CONCURRENCY", "two"],
    ["AI_MAX_INPUT_TOKENS", "1.5"],
    ["AI_MAX_INPUT_TOKENS", ""],
    ["CONSULTANT_DAILY_JOB_LIMIT", "0"],
    ["CONSULTANT_DAILY_JOB_LIMIT", "many"],
    ["AI_FAULT_INJECTION", "unknown:timeout"],
  ])("rejects invalid %s", (name, value) => {
    expect(() => parseEnvironment({ ...example(), [name]: value })).toThrow(name);
  });

  it.each([
    ["AI_PROVIDER", "anthropic", "ANTHROPIC_API_KEY"],
    ["EMAIL_PROVIDER", "resend", "EMAIL_API_KEY"],
  ])("requires credentials for %s", (name, provider, key) => {
    expect(() => parseEnvironment({ ...example(), [name]: provider })).toThrow(key);
  });

  it.each(["problem_analysis", "as_is", "gap", "to_be", "change_doc", "blueprint_narrative"])(
    "accepts the PRD fault hook for %s", (stage) => {
      const fault = `${stage}:timeout:once`;
      expect(parseEnvironment({ ...example(), AI_FAULT_INJECTION: fault }).AI_FAULT_INJECTION).toBe(fault);
    },
  );

  it("ignores AI test hooks in production and requires a real provider key", () => {
    const production = {
      ...example(), NODE_ENV: "production", AUTH_SECRET: randomUUID(),
      APP_URL: "https://sap.example.com", S3_ENDPOINT: "https://storage.example.com",
      EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "test-email-key",
      AI_FAULT_INJECTION: "deliberately-invalid",
    };
    expect(() => parseEnvironment(production)).toThrow("ANTHROPIC_API_KEY");
    const config = parseEnvironment({ ...production, ANTHROPIC_API_KEY: "test-ai-key" });
    expect(config.AI_PROVIDER).toBe("anthropic");
    expect(config.AI_FAULT_INJECTION).toBeUndefined();
  });

  it("rejects the example signing secret in production", () => {
    expect(() => parseEnvironment({ ...example(), NODE_ENV: "production" })).toThrow("AUTH_SECRET");
  });

  it("reports only variable names, never input values", () => {
    const secret = "private-value-that-must-not-appear";
    try {
      parseEnvironment({ ...example(), DATABASE_URL: secret });
      expect.fail("Invalid configuration was accepted");
    } catch (error) {
      expect(String(error)).toContain("DATABASE_URL");
      expect(String(error)).not.toContain(secret);
    }
  });
});

// Opt-in integration tests use ONLY the checked-in localhost example, never a developer's DB.
describe.skipIf(process.env.RUN_INFRA_TESTS !== "1")("local infrastructure", () => {
  const config = parseEnvironment(example());
  const errors: string[] = [];
  const services = createInfrastructure(config, (service) => errors.push(service));

  beforeAll(async () => {
    await services.queue.start();
    await ensureDevelopmentBucket(services.storage, config);
  }, 30000);

  afterAll(async () => {
    await Promise.all([services.close(), services.close()]);
    expect(errors).toEqual([]);
  }, 30000);

  it("executes a real SQL query through Drizzle on PostgreSQL 16", async () => {
    const result = await services.db.execute<{ version: string; answer: number }>(
      sql`select current_setting('server_version') as version, 6 * 7 as answer`,
    );
    expect(result.rows[0]?.version).toMatch(/^16\./);
    expect(result.rows[0]?.answer).toBe(42);
  });

  it("processes a persisted queue job within five seconds", async () => {
    const name = `infra-${randomUUID()}`;
    await services.queue.createQueue(name);
    try {
      await services.queue.work(name, { pollingIntervalSeconds: 0.5 }, async () => ({ ok: true }));
      const started = performance.now();
      const id = await services.queue.send(name, { probe: true });
      expect(id).toBeTruthy();
      let job = await services.queue.getJobById(name, id!);
      while (job?.state !== "completed" && performance.now() - started < 4500) {
        await delay(50);
        job = await services.queue.getJobById(name, id!);
      }
      expect(job?.state).toBe("completed");
      expect(job?.output).toEqual({ ok: true });
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      await services.queue.offWork(name);
      await services.queue.deleteQueue(name);
    }
  }, 10000);

  it("provisions the local bucket idempotently and round-trips an object", async () => {
    await ensureDevelopmentBucket(services.storage, config);
    const object = { Bucket: config.S3_BUCKET, Key: `infra-test/${randomUUID()}.txt` };
    try {
      await services.storage.send(new PutObjectCommand({ ...object, Body: "sap-pm-storage-probe" }));
      const result = await services.storage.send(new GetObjectCommand(object));
      expect(await result.Body?.transformToString()).toBe("sap-pm-storage-probe");
    } finally {
      await services.storage.send(new DeleteObjectCommand(object));
    }
  });

  it("never auto-provisions a production bucket", async () => {
    await expect(ensureDevelopmentBucket(services.storage, { ...config, NODE_ENV: "production" }))
      .rejects.toThrow("production");
  });
});
