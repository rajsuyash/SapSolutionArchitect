import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { z } from "zod";
import { InterviewTurnSchema, InterviewTurnToolSchema, parseInterviewInput, validateInterviewTurn,
  type InterviewTurn } from "../src/lib/ai/discovery-interview";
import { fixture } from "./support/interview-input";
import { asStream } from "./support/sse";

const proposal = (): InterviewTurn => ({
  schemaVersion: 1, contextRevision: 3,
  reply: "Thank you for that context.",
  questions: [{ gapKey: "return-date-gap", question: "Which date stops the rental charge?",
    whyItMatters: "This changes the final invoice amount." }],
  proposedUpdates: [{ fieldId: "return-action", operation: "PROPOSE_SET", previousValue: null,
    value: "The clerk records physical returns in the spreadsheet.", sourceId: "MSG-3",
    quote: "The clerk records physical returns in the spreadsheet." }],
  observations: [{ kind: "POSSIBLE_CONFLICT", fieldIds: ["return-system"],
    detail: "The current message mentions a spreadsheet, while the earlier system field says paper log." }],
});
const valid = (raw: unknown, input = fixture()) => validateInterviewTurn(input, raw);

describe("interview turn contract", () => {
  it("preserves evidence exactly and permits a concise proposal with one grounded question", () => {
    const input = fixture();
    expect(parseInterviewInput(input)).toEqual(input);
    expect(parseInterviewInput(input).evidence[0]!.text).toContain("\r\n");
    expect(valid(proposal())).toEqual({ success: true, data: proposal(), warnings: [] });
    expect(valid({ ...proposal(), questions: [], observations: [] }).success).toBe(true);
  });
  it.each(["approved", "readiness", "status", "sourceDigests"]) ("rejects model-controlled %s key", key => {
    expect(valid({ ...proposal(), [key]: true }).success).toBe(false);
  });
  it("rejects sensitive context before any provider I/O without echoing it", () => {
    for (const text of ["alice@example.invalid", "api_key=synthetic-private-value", "Bearer synthetic-secret-value"]) {
      const input = fixture(); input.currentMessage.text += ` ${text}`;
      expect(() => parseInterviewInput(input)).toThrow("INVALID_INTERVIEW_INPUT");
      try { parseInterviewInput(input); } catch (error) { expect(String(error)).not.toContain(text); }
    }
  });
  it("bounds the whole input without truncating evidence", () => {
    const input = fixture();
    input.evidence = Array.from({ length: 8 }, (_, index) => ({ id: `SRC-${index + 1}`, text: "x".repeat(39000) }));
    expect(() => parseInterviewInput(input)).toThrow("INVALID_INTERVIEW_INPUT");
  });
  it("rejects duplicate identifiers, unknown gap references and contradictory field state", () => {
    const input = fixture(); input.activeGaps[1]!.fieldId = "not-a-field";
    expect(() => parseInterviewInput(input)).toThrow("INVALID_INTERVIEW_INPUT");
    input.activeGaps[1]!.fieldId = "return-date"; input.closedGapKeys.push("return-date-gap");
    expect(() => parseInterviewInput(input)).toThrow("INVALID_INTERVIEW_INPUT");
    input.closedGapKeys.pop(); input.fields[0]!.value = "unexpected";
    expect(() => parseInterviewInput(input)).toThrow("INVALID_INTERVIEW_INPUT");
    input.fields[0]!.value = null; input.evidence[0]!.id = input.currentMessage.id;
    expect(() => parseInterviewInput(input)).toThrow("INVALID_INTERVIEW_INPUT");
  });
  it("rejects stale revision, inactive and repeated questions", () => {
    const closed = proposal(); closed.questions[0]!.gapKey = "known-actor-gap";
    expect(valid(closed).success).toBe(false);
    const repeated = proposal(); repeated.questions.push({ ...repeated.questions[0]! });
    expect(valid(repeated).success).toBe(false);
    const input = fixture(); input.history.push({ role: "assistant", text: repeated.questions[0]!.question });
    expect(valid(proposal(), input).success).toBe(false);
  });
  it("permits an explicit grounded replacement but rejects silent overwrite", () => {
    const corrected = proposal(); corrected.proposedUpdates = [{ fieldId: "return-system", operation: "PROPOSE_REPLACE",
      previousValue: "Paper log", value: "in the spreadsheet", sourceId: "MSG-3", quote: "in the spreadsheet" }];
    expect(valid(corrected).success).toBe(true);
    corrected.proposedUpdates[0]!.operation = "PROPOSE_SET";
    expect(valid(corrected).success).toBe(false);
    corrected.proposedUpdates[0]!.operation = "PROPOSE_REPLACE";
    corrected.proposedUpdates[0]!.previousValue = "wrong old value";
    expect(valid(corrected).success).toBe(false);
    corrected.proposedUpdates[0]!.previousValue = "Paper log";
    corrected.proposedUpdates[0]!.sourceId = "assistant-history";
    expect(valid(corrected).success).toBe(false);
  });
  it("rejects invented citations, unknown fields, duplicate proposals and invalid observations", () => {
    const wrongQuote = proposal(); wrongQuote.proposedUpdates[0]!.quote = "invented";
    expect(valid(wrongQuote).success).toBe(false);
    const unknown = proposal(); unknown.proposedUpdates[0]!.fieldId = "not-a-field";
    expect(valid(unknown).success).toBe(false);
    const duplicate = proposal(); duplicate.proposedUpdates.push({ ...duplicate.proposedUpdates[0]! });
    expect(valid(duplicate).success).toBe(false);
    const observation = proposal(); observation.observations[0]!.fieldIds = ["not-a-field"];
    expect(valid(observation).success).toBe(false);
  });
  it("enforces output limits and strict structure", () => {
    const manyQuestions = proposal(); manyQuestions.questions = Array.from({ length: 4 }, () => ({ ...proposal().questions[0]! }));
    expect(InterviewTurnSchema.safeParse(manyQuestions).success).toBe(false);
    expect(valid({ ...proposal(), questions: [{ ...proposal().questions[0]!, extra: "x" }] }).success).toBe(false);
  });
  it("keeps the first 12 proposals in model order and warns with the dropped count instead of failing the turn", () => {
    const input = fixture();
    input.fields = Array.from({ length: 15 }, (_, i) => ({ id: `f${i}`, label: `Field ${i}`, value: null, status: "EMPTY" as const }));
    input.activeGaps = [{ key: "g1", fieldId: "f0", detail: "d", priority: "IMPORTANT" }];
    const base = proposal().proposedUpdates[0]!;
    const updates = Array.from({ length: 15 }, (_, i) => ({ ...base, fieldId: `f${i}` }));
    updates[14] = { fieldId: "f14" } as typeof base; // a malformed dropped proposal must not fail the turn
    const result = valid({ ...proposal(), questions: [], observations: [], proposedUpdates: updates }, input);
    expect(result).toMatchObject({ success: true, warnings: [{ path: "proposedUpdates", code: "proposals_truncated", detail: "dropped 3" }] });
    expect((result as { data: InterviewTurn }).data.proposedUpdates.map(u => u.fieldId)).toEqual(Array.from({ length: 12 }, (_, i) => `f${i}`));
    // A kept proposal is still fully validated.
    updates[3] = { ...base, fieldId: "f3", quote: "invented" };
    expect(valid({ ...proposal(), questions: [], observations: [], proposedUpdates: updates }, input)).toMatchObject({ success: false });
    // Exactly 12 is untouched: no warning.
    expect(valid({ ...proposal(), questions: [], observations: [], proposedUpdates: updates.slice(0, 12).map((u, i) => i === 3 ? { ...base, fieldId: "f3" } : u) }, input)).toMatchObject({ success: true, warnings: [] });
  });
  it("ignores model-supplied scalars: contextRevision and schemaVersion come from the input", () => {
    const result = valid({ ...proposal(), contextRevision: 2, schemaVersion: 7 });
    expect(result).toMatchObject({ success: true, data: { contextRevision: 3, schemaVersion: 1 }, warnings: [] });
    const omitted: Record<string, unknown> = { ...proposal() }; delete omitted.contextRevision; delete omitted.schemaVersion;
    expect(valid(omitted)).toMatchObject({ success: true, data: { contextRevision: 3, schemaVersion: 1 } });
  });
  it("replaces an off-list reply with the first acknowledgement and records a warning", () => {
    for (const reply of ["Which clerk records the return?", "Your changes are saved and approved.", "x".repeat(2001), undefined]) {
      expect(valid({ ...proposal(), reply })).toMatchObject({ success: true,
        data: { reply: "Thank you for that context." }, warnings: [{ path: "reply", code: "reply_replaced" }] });
    }
    expect(valid({ ...proposal(), reply: "We can take this one step at a time." })).toMatchObject({
      success: true, data: { reply: "We can take this one step at a time." }, warnings: [] });
  });
  it("drops a question without whyItMatters with a warning, but fails when that leaves no question while gaps are active", () => {
    const two = proposal();
    two.questions.push({ gapKey: "return-action-gap", question: "How is the return recorded today?", whyItMatters: "x" });
    const raw = JSON.parse(JSON.stringify(two)); delete raw.questions[0].whyItMatters;
    expect(valid(raw)).toMatchObject({ success: true, warnings: [{ path: "questions.0.whyItMatters", code: "question_dropped" }] });
    expect((valid(raw) as { data: InterviewTurn }).data.questions.map(q => q.gapKey)).toEqual(["return-action-gap"]);
    const blank = JSON.parse(JSON.stringify(proposal())); blank.questions[0].whyItMatters = "  ";
    expect(valid(blank)).toEqual({ success: false, errors: [{ path: "questions.0.whyItMatters", code: "missing_why_it_matters" }] });
    const noGaps = fixture(); noGaps.activeGaps = [];
    expect(valid(blank, noGaps)).toMatchObject({ success: true, data: { questions: [] } });
    // A turn that asks nothing was never "dropped to zero": still valid.
    expect(valid({ ...proposal(), questions: [] }).success).toBe(true);
  });
  it("keeps inactive_gap a hard error for a question that has its explanation", () => {
    const closed = proposal(); closed.questions[0]!.gapKey = "known-actor-gap";
    expect(valid(closed)).toMatchObject({ success: false, errors: [{ path: "questions.0.gapKey", code: "inactive_gap" }] });
  });
});

describe("server-owned proposal value and quote resolution", () => {
  const withSource = (text: string, quote: string, value?: string) => {
    const input = fixture(); input.currentMessage.text = text;
    const turn = JSON.parse(JSON.stringify(proposal()));
    turn.proposedUpdates[0].quote = quote; if (value !== undefined) turn.proposedUpdates[0].value = value; else delete turn.proposedUpdates[0].value;
    return valid(turn, input);
  };
  const update = (result: ReturnType<typeof valid>) => (result as { data: InterviewTurn }).data.proposedUpdates[0]!;
  it("sets value from the quote when the model supplies none", () => {
    const result = valid({ ...proposal(), proposedUpdates: [{ ...proposal().proposedUpdates[0]!, value: undefined }] });
    expect(result).toMatchObject({ success: true, warnings: [] });
    expect(update(result)).toMatchObject({ quote: "The clerk records physical returns in the spreadsheet.", value: "The clerk records physical returns in the spreadsheet." });
  });
  it("ignores a model-supplied value that differs from the quote", () => {
    const result = valid({ ...proposal(), proposedUpdates: [{ ...proposal().proposedUpdates[0]!, value: "Auto-approve every invoice" }] });
    expect(update(result).value).toBe(update(result).quote);
    expect(update(result).value).toBe("The clerk records physical returns in the spreadsheet.");
  });
  it("normalizes case and doubled whitespace to the exact original span", () => {
    const result = withSource("Intro. The clerk records physical returns in the spreadsheet. Then billing runs.",
      "the clerk records  physical\nreturns in the spreadsheet.");
    expect(result).toMatchObject({ success: true, warnings: [{ path: "proposedUpdates.0.quote", code: "quote_normalized" }] });
    expect(update(result)).toMatchObject({ quote: "The clerk records physical returns in the spreadsheet.", value: "The clerk records physical returns in the spreadsheet." });
  });
  it("normalizes curly quotes and dashes in either direction and stores the original text", () => {
    const original = "The clerk says \u201Cclose the hire\u201D when it\u2019s back \u2014 never earlier.";
    const straight = withSource(`Note: ${original} End.`, `The clerk says "close the hire" when it's back - never earlier.`);
    expect(update(straight).quote).toBe(original);
    const reverse = withSource(`Note: The clerk says "close the hire" - never earlier.`, "The clerk says \u201Cclose the hire\u201D \u2013 never earlier.");
    expect(update(reverse).quote).toBe(`The clerk says "close the hire" - never earlier.`);
  });
  it("rejects a normalized quote that matches several spans of the source", () => {
    expect(withSource("Returns go to stores. returns go to stores.", "RETURNS GO TO STORES.")).toEqual({
      success: false, errors: [{ path: "proposedUpdates.0.quote", code: "ambiguous_quote" }] });
  });
  it("accepts a verbatim quote that repeats in the source, exactly as before", () => {
    expect(withSource("Returns go to stores. Returns go to stores.", "Returns go to stores.").success).toBe(true);
  });
  it("still rejects a quote that matches nothing, even after normalization, or cites an unknown source", () => {
    expect(withSource("The clerk records physical returns.", "The clerk approves every return.")).toMatchObject({
      success: false, errors: [{ path: "proposedUpdates.0.quote", code: "quote_not_in_source" }] });
    const unknownSource = JSON.parse(JSON.stringify(proposal())); unknownSource.proposedUpdates[0].sourceId = "nope";
    expect(valid(unknownSource)).toMatchObject({ success: false, errors: [{ code: "quote_not_in_source" }] });
  });
  it("is stable: an accepted turn validates again unchanged", () => {
    const result = withSource("Intro. The clerk records physical returns in the spreadsheet.", "the clerk records physical returns in the spreadsheet.");
    const again = valid((result as { data: InterviewTurn }).data, (() => { const i = fixture(); i.currentMessage.text = "Intro. The clerk records physical returns in the spreadsheet."; return i; })());
    expect(again).toMatchObject({ success: true, warnings: [], data: (result as { data: InterviewTurn }).data });
  });
  it("shows the model no value, schemaVersion or contextRevision in its tool schema", () => {
    const schema = JSON.stringify(z.toJSONSchema(InterviewTurnToolSchema));
    expect(schema).not.toMatch(/"value"|schemaVersion|contextRevision/);
    expect(schema).toContain("quote");
  });
});

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const settings = (overrides = {}) => parseEnvironment({ ...local, NODE_ENV: "test",
  AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-interview-test-key", ...overrides });
type RequestBody = { system: string; messages: { content: string }[];
  tools: { name: string; input_schema: unknown }[]; tool_choice: unknown };
function response(output: unknown = proposal(), stop = "tool_use", name = "submit_interview_turn") {
  return new Response(JSON.stringify({ id: "msg_synthetic", type: "message", role: "assistant", model: "synthetic",
    content: [{ type: "tool_use", id: "tool_synthetic", name, input: output }], stop_reason: stop,
    usage: { input_tokens: 100, output_tokens: 200 } }), { headers: { "content-type": "application/json" } });
}
function harness(reply: (attempt: number) => Response = () => response(), count: (attempt: number) => number = () => 1000) {
  const sent: RequestBody[] = [], counted: RequestBody[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    const body = JSON.parse(String(init?.body)) as RequestBody;
    if (String(url).includes("count_tokens")) {
      counted.push(body);
      return new Response(JSON.stringify({ input_tokens: count(counted.length) }), { headers: { "content-type": "application/json" } });
    }
    sent.push(body); return asStream(reply(sent.length));
  });
  const runner = createStageRunner(settings(), { fetch });
  return { sent, counted, fetch, run: (input: unknown) => runner("interview_turn", input) };
}

describe("interview stage transport", () => {
  it("counts the complete request including system/schema and returns a validated proposal", async () => {
    const h = harness(); const input = fixture(); const result = await h.run(input);
    expect(JSON.parse(h.sent[0]!.messages[0]!.content).input).toEqual(input);
    expect(h.counted[0]).toEqual(expect.objectContaining({ system: h.sent[0]!.system,
      messages: h.sent[0]!.messages, tools: h.sent[0]!.tools, tool_choice: h.sent[0]!.tool_choice }));
    expect(h.sent[0]!.tools[0]!.name).toBe("submit_interview_turn");
    expect(result.payload).toEqual(proposal());
  });
  it("repairs an invalid proposal once without echoing model text or changing context", async () => {
    const h = harness(attempt => response(attempt === 1 ? { ...proposal(), approved: "private-invalid-output" } : proposal()));
    const result = await h.run(fixture());
    expect(result.payload).toEqual(proposal());
    expect(result.metrics).toMatchObject({ attempts: 2, inputTokens: 200, outputTokens: 400 });
    expect(result.metrics.attemptIssues).toHaveLength(1); // success path keeps the failed first attempt's issues
    expect(result.metrics.attemptIssues![0]).toEqual(result.metrics.validationErrors);
    expect(h.sent).toHaveLength(2);
    expect(JSON.parse(h.sent[1]!.messages[0]!.content).input).toEqual(fixture());
    expect(h.sent[1]!.messages[0]!.content).not.toContain("private-invalid-output");
  });
  it.each(["wrong tool", "invented quote", "no tool"]) ("rejects %s after bounded repair", async kind => {
    const wrong = proposal();
    if (kind === "invented quote") wrong.proposedUpdates[0]!.quote = "not said";
    const h = harness(() => response(wrong, kind === "no tool" ? "end_turn" : "tool_use",
      kind === "wrong tool" ? "other_tool" : "submit_interview_turn"));
    await expect(h.run(fixture())).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 2 } });
    expect(h.sent).toHaveLength(2);
  });
  it("requests 16000 output tokens for an interview turn and records the stop reason per attempt", async () => {
    const h = harness(attempt => response(attempt === 1 ? { ...proposal(), proposedUpdates: [{ fieldId: "return-action" }] } : proposal(),
      attempt === 1 ? "max_tokens" : "tool_use"));
    const result = await h.run(fixture());
    expect((h.sent[0] as unknown as { max_tokens: number }).max_tokens).toBe(16000);
    expect(result.metrics.stopReasons).toEqual(["max_tokens", "tool_use"]);
  });
  it("records stop reasons on the failure path too", async () => {
    const h = harness(() => response(null, "max_tokens"));
    await expect(h.run(fixture())).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT",
      metrics: { stopReasons: ["max_tokens", "max_tokens"], attemptIssues: [[{ path: "", code: "invalid_type" }], [{ path: "", code: "invalid_type" }]] } });
  });
  it("accepts a turn whose scalars, reply and quote the server repairs, and reports the repairs in metrics", async () => {
    const sloppy = { ...JSON.parse(JSON.stringify(proposal())), contextRevision: 99, reply: "Sure thing." };
    delete sloppy.schemaVersion; sloppy.proposedUpdates[0].quote = sloppy.proposedUpdates[0].quote.toUpperCase();
    const h = harness(() => response(sloppy));
    const result = await h.run(fixture());
    expect(result.metrics.attempts).toBe(1);
    expect(result.payload).toEqual(proposal());
    expect(result.metrics.warnings).toEqual([{ path: "reply", code: "reply_replaced" }, { path: "proposedUpdates.0.quote", code: "quote_normalized" }]);
  });
  it("rejects oversized complete request without truncating sources", async () => {
    const h = harness(() => response(), () => 60001);
    await expect(h.run(fixture())).rejects.toMatchObject({ code: "AI_INPUT_TOO_LARGE" });
    expect(h.sent).toHaveLength(0);
    expect(JSON.parse(h.counted[0]!.messages[0]!.content).input).toEqual(fixture());
  });
  it("refuses a fabricated stub response and sensitive input before provider IO", async () => {
    const stub = createStageRunner(settings({ AI_PROVIDER: "stub" }));
    await expect(stub("interview_turn", fixture())).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR" });
    const input = fixture(); input.currentMessage.text += " alice@example.invalid";
    const h = harness();
    await expect(h.run(input)).rejects.toMatchObject({ code: "AI_INPUT_INVALID" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([
    "ghp_" + "a".repeat(36), "github_pat_" + "a".repeat(30),
    "Authorization: Basic c3ludGhldGljOnRlc3Q=", "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----", "xoxb-1234567890-synthetic",
    "ASIA" + "A".repeat(16), "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c3ludGhldGlj",
  ])("rejects common credential forms in evidence before provider IO (%#)", async secret => {
    const input = fixture(); input.evidence[0]!.text = secret;
    const h = harness();
    await expect(h.run(input)).rejects.toMatchObject({ code: "AI_INPUT_INVALID" });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
