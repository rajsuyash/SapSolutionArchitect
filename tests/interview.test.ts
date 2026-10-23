import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "../src/lib/env";
import { createStageRunner } from "../src/lib/ai/runStage";
import { z } from "zod";
import { InterviewTurnSchema, InterviewTurnToolSchema, parseInterviewInput, revalidateStoredTurn, validateChatTurn, validateExtraction, validateInterviewTurn,
  type InterviewTurn } from "../src/lib/ai/discovery-interview";
import { interviewModelView } from "../src/lib/ai/interview-sentences";
import { fixture } from "./support/interview-input";
import { asStream } from "./support/sse";

/** The turn as the server stores it: evidence is `sourceId` + exact `quote`. */
const stored = (): InterviewTurn => ({
  schemaVersion: 1, contextRevision: 3,
  reply: "Thank you for that context.",
  questions: [{ gapKey: "return-date-gap", question: "Which date stops the rental charge?",
    whyItMatters: "This changes the final invoice amount." }],
  proposedUpdates: [{ fieldId: "return-action", operation: "PROPOSE_SET", previousValue: null,
    value: "The clerk records physical returns in the spreadsheet.", sourceId: "MSG-3",
    quote: "The clerk records physical returns in the spreadsheet." }],
  proposedSteps: [], proposedRequirements: [],
  observations: [{ kind: "POSSIBLE_CONFLICT", fieldIds: ["return-system"],
    detail: "The current message mentions a spreadsheet, while the earlier system field says paper log." }],
});
type ModelUpdate = { fieldId: string; operation: "PROPOSE_SET" | "PROPOSE_REPLACE"; previousValue: string | null; sentenceIds: string[]; value?: string };
type ModelTurn = Omit<InterviewTurn, "proposedUpdates" | "proposedSteps" | "proposedRequirements"> & { proposedUpdates: ModelUpdate[];
  proposedSteps: { sentenceIds: string[]; nameHint?: string | null }[];
  proposedRequirements: { stepRef: string; kind: "PAIN_POINT" | "TO_BE_REQUIREMENT" | "CONTROL"; critical: boolean; sentenceIds: string[] }[] };
/** The same turn as the model writes it: it cites sentence S1 of the fixture's current message instead of copying text. */
const proposal = (): ModelTurn => ({ ...stored(), proposedSteps: [], proposedRequirements: [],
  proposedUpdates: [{ fieldId: "return-action", operation: "PROPOSE_SET", previousValue: null, sentenceIds: ["S1"] }] });
const valid = (raw: unknown, input = fixture()) => validateInterviewTurn(input, raw);
/** The input as the extraction call sees it: numbered sentences, and none of the gaps or history it does not use. */
const extractionView = (input: ReturnType<typeof fixture>) => ({ ...interviewModelView(input), activeGaps: [], closedGapKeys: [], history: [] });
/** What the extraction call returns: proposals and observations only. */
const extraction = () => { const p = proposal(); return { proposedUpdates: p.proposedUpdates, proposedSteps: p.proposedSteps,
  proposedRequirements: p.proposedRequirements, observations: p.observations }; };
/** The extraction as the server stores it: the combined stored turn with no questions. */
const extractionStored = (): InterviewTurn => ({ ...stored(), questions: [] });
/** What the chat call returns: a reply and questions only. */
const chat = () => ({ reply: stored().reply, questions: stored().questions });

describe("interview turn contract", () => {
  it("preserves evidence exactly and permits a concise proposal with one grounded question", () => {
    const input = fixture();
    expect(parseInterviewInput(input)).toEqual(input);
    expect(parseInterviewInput(input).evidence[0]!.text).toContain("\r\n");
    expect(valid(proposal())).toEqual({ success: true, data: stored(), warnings: [] });
    const idle = fixture(); idle.activeGaps = [];
    expect(valid({ ...proposal(), questions: [], observations: [] }, idle).success).toBe(true); // nothing left to ask
  });
  it("rejects a turn with no question while a gap is still open, and says why", () => {
    expect(valid({ ...proposal(), questions: [] })).toEqual({ success: false, errors: [{ path: "questions", code: "no_questions" }] });
    expect(valid({ ...proposal(), questions: undefined as never })).toMatchObject({ success: false });
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
    // The same question twice in one turn: the second is dropped with a warning, the first is still asked.
    const repeated = proposal(); repeated.questions.push({ ...repeated.questions[0]!, gapKey: "return-action-gap" });
    expect(valid(repeated)).toMatchObject({ success: true, data: { questions: [{ gapKey: "return-date-gap" }] },
      warnings: [{ code: "question_dropped", detail: "repeated_question" }] });
    // A question asked in an earlier assistant message, with nothing else to ask, is refused outright.
    const input = fixture(); input.history.push({ role: "assistant", text: repeated.questions[0]!.question });
    expect(valid(proposal(), input)).toEqual({ success: false, errors: [{ path: "questions.0.question", code: "repeated_question" }] });
    // An inactive gap beside a good question is dropped, not fatal.
    const mixed = proposal(); mixed.questions.push({ gapKey: "known-actor-gap", question: "Who is the clerk?", whyItMatters: "x" });
    expect(valid(mixed)).toMatchObject({ success: true, warnings: [{ code: "question_dropped", detail: "inactive_gap" }] });
  });
  it("permits an explicit grounded replacement but rejects silent overwrite", () => {
    const corrected = proposal(); corrected.proposedUpdates = [{ fieldId: "return-system", operation: "PROPOSE_REPLACE",
      previousValue: "Paper log", sentenceIds: ["S1"] }];
    expect(valid(corrected).success).toBe(true);
    // A silent overwrite or a wrong previousValue can never apply: it is dropped with a warning, never offered.
    const dropped = (result: ReturnType<typeof valid>) => result.success && result.data.proposedUpdates.length === 0 &&
      result.warnings.some(w => w.code === "update_dropped" && w.detail === "invalid_previous_value");
    corrected.proposedUpdates[0]!.operation = "PROPOSE_SET";
    expect(dropped(valid(corrected))).toBe(true);
    corrected.proposedUpdates[0]!.operation = "PROPOSE_REPLACE";
    corrected.proposedUpdates[0]!.previousValue = "wrong old value";
    expect(dropped(valid(corrected))).toBe(true);
    corrected.proposedUpdates[0]!.previousValue = "Paper log";
    corrected.proposedUpdates[0]!.sentenceIds = ["S99"];
    expect(valid(corrected).success).toBe(false);
  });
  it("rejects invented citations, unknown fields, duplicate proposals and invalid observations", () => {
    const wrongQuote = proposal(); wrongQuote.proposedUpdates[0]!.sentenceIds = ["S99"];
    expect(valid(wrongQuote).success).toBe(false);
    const unknown = proposal(); unknown.proposedUpdates[0]!.fieldId = "not-a-field";
    expect(valid(unknown)).toMatchObject({ success: true, data: { proposedUpdates: [] }, warnings: [{ code: "update_dropped", detail: "unknown_field" }] });
    const duplicate = proposal(); duplicate.proposedUpdates.push({ ...duplicate.proposedUpdates[0]! });
    expect(valid(duplicate)).toMatchObject({ success: true, data: { proposedUpdates: [{ fieldId: "return-action" }] },
      warnings: [{ code: "update_dropped", detail: "duplicate_update" }] }); // the first is kept
    // An advisory observation about an unknown field is dropped with a warning rather than failing the turn.
    const observation = proposal(); observation.observations[0]!.fieldIds = ["not-a-field"];
    expect(valid(observation)).toMatchObject({ success: true, data: { observations: [] },
      warnings: [{ code: "observation_dropped", detail: "invalid_field_refs" }] });
  });
  it("enforces output limits and strict structure", () => {
    const manyQuestions = stored(); manyQuestions.questions = Array.from({ length: 4 }, () => ({ ...stored().questions[0]! }));
    expect(InterviewTurnSchema.safeParse(manyQuestions).success).toBe(false);
    // Extra keys on a question are stripped and a fourth question is cut, each with the rest of the turn kept.
    expect(valid({ ...proposal(), questions: [{ ...proposal().questions[0]!, extra: "x" }] })).toMatchObject({ success: true,
      data: { questions: [proposal().questions[0]] } });
    expect(valid({ ...proposal(), extra: "x" }).success).toBe(false);
  });
  it("keeps the first 20 proposals in model order and warns with the dropped count instead of failing the turn", () => {
    const input = fixture();
    input.fields = Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, label: `Field ${i}`, value: null, status: "EMPTY" as const }));
    input.activeGaps = [{ key: "g1", fieldId: "f0", detail: "d", priority: "IMPORTANT" }];
    const base = proposal().proposedUpdates[0]!;
    const updates = Array.from({ length: 25 }, (_, i) => ({ ...base, fieldId: `f${i}` }));
    updates[24] = { fieldId: "f24" } as typeof base; // a malformed proposal must not fail the turn
    const turn = { ...proposal(), questions: [{ gapKey: "g1", question: "Which date applies?", whyItMatters: "It sets the charge." }], observations: [] };
    const result = valid({ ...turn, proposedUpdates: updates }, input);
    expect(result).toMatchObject({ success: true, warnings: [{ code: "update_dropped", detail: "malformed" },
      { path: "proposedUpdates", code: "proposals_truncated", detail: "dropped 4" }] });
    expect((result as { data: InterviewTurn }).data.proposedUpdates.map(u => u.fieldId)).toEqual(Array.from({ length: 20 }, (_, i) => `f${i}`));
    // A kept proposal is still fully validated.
    updates[3] = { ...base, fieldId: "f3", sentenceIds: ["S99"] };
    expect(valid({ ...turn, proposedUpdates: updates }, input)).toMatchObject({ success: false });
    // Exactly 20 is untouched: no warning.
    expect(valid({ ...turn, proposedUpdates: updates.slice(0, 20).map((u, i) => i === 3 ? { ...base, fieldId: "f3" } : u) }, input)).toMatchObject({ success: true, warnings: [] });
  });
  it("truncates proposed steps and requirements at their own caps with a warning", () => {
    const input = fixture();
    // Twenty passages that share no words, so none counts as a repeat of another.
    const passages = Array.from({ length: 20 }, (_, i) => `Crew${i}a handles item${i}b during shift${i}c at depot${i}d.`);
    input.currentMessage.text = passages.join(" ");
    // Sentence S<n> of the current message is passage n-1.
    const steps = passages.slice(0, 14).map((_, i) => ({ sentenceIds: [`S${i + 1}`] }));
    const requirements = passages.slice(14).map((_, i) => ({ stepRef: "new_0", kind: "PAIN_POINT" as const, critical: true, sentenceIds: [`S${i + 15}`] }));
    const result = valid({ ...proposal(), proposedUpdates: [], proposedSteps: steps, proposedRequirements: requirements }, input) as
      { success: true; data: InterviewTurn; warnings: { path: string; code: string; detail?: string }[] };
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([{ path: "proposedSteps", code: "proposals_truncated", detail: "dropped 2" }]);
    expect(result.data.proposedSteps.map(x => x.quote)).toEqual(passages.slice(0, 12));
    expect(result.data.proposedRequirements.map(x => x.stepRef)).toEqual(Array(6).fill("new_0"));
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
    // A turn that asks nothing is refused while gaps are active, but fine once none remain.
    expect(valid({ ...proposal(), questions: [] }).success).toBe(false);
    expect(valid({ ...proposal(), questions: [] }, noGaps).success).toBe(true);
  });
  it("keeps inactive_gap a hard error for a question that has its explanation", () => {
    const closed = proposal(); closed.questions[0]!.gapKey = "known-actor-gap";
    expect(valid(closed)).toMatchObject({ success: false, errors: [{ path: "questions.0.gapKey", code: "inactive_gap" }] });
  });
});

describe("server-owned proposal value and sentence resolution", () => {
  const withText = (text: string, sentenceIds: string[], value?: string) => {
    const input = fixture(); input.currentMessage.text = text;
    const turn = proposal(); turn.proposedUpdates[0]!.sentenceIds = sentenceIds;
    if (value !== undefined) turn.proposedUpdates[0]!.value = value;
    return { input, result: valid(turn, input) };
  };
  const update = (result: ReturnType<typeof valid>) => (result as { data: InterviewTurn }).data.proposedUpdates[0]!;
  it("sets value from the quote when the model supplies none", () => {
    const result = valid({ ...proposal(), proposedUpdates: [{ ...proposal().proposedUpdates[0]!, value: undefined }] });
    expect(result).toMatchObject({ success: true, warnings: [] });
    expect(update(result)).toMatchObject({ quote: "The clerk records physical returns in the spreadsheet.", value: "The clerk records physical returns in the spreadsheet." });
  });
  it("ignores a model-supplied value that differs from the cited sentence", () => {
    const result = valid({ ...proposal(), proposedUpdates: [{ ...proposal().proposedUpdates[0]!, value: "Auto-approve every invoice" }] });
    expect(update(result).value).toBe(update(result).quote);
    expect(update(result).value).toBe("The clerk records physical returns in the spreadsheet.");
  });
  it("stores the source's own characters (curly quotes, dashes, case), never the model's", () => {
    const original = "The clerk says \u201Cclose the hire\u201D when it\u2019s back \u2014 NEVER earlier.";
    const { input, result } = withText(`Intro. ${original} End.`, ["S2"]);
    expect(update(result).quote).toBe(original);
    expect(input.currentMessage.text.includes(update(result).quote)).toBe(true);
  });
  it("addresses a sentence that repeats in the source by its id", () => {
    const { result } = withText("Returns go to stores. Returns go to stores.", ["S2"]);
    expect(result).toMatchObject({ success: true, warnings: [] });
    expect(update(result).quote).toBe("Returns go to stores.");
  });
  it("is stable: an accepted turn passes the stored-turn check unchanged, and that check never normalises", () => {
    const { input, result } = withText("Intro. The clerk records physical returns in the spreadsheet.", ["S2"]);
    const data = (result as { data: InterviewTurn }).data;
    expect(revalidateStoredTurn(input, data)).toEqual({ success: true, data, warnings: [] });
    const lowered = JSON.parse(JSON.stringify(data)); lowered.proposedUpdates[0].quote = lowered.proposedUpdates[0].quote.toLowerCase();
    expect(revalidateStoredTurn(input, lowered)).toEqual({ success: false, errors: [{ path: "proposedUpdates.0.quote", code: "quote_not_in_source" }] });
    const elsewhere = JSON.parse(JSON.stringify(data)); elsewhere.proposedUpdates[0].sourceId = "nope";
    expect(revalidateStoredTurn(input, elsewhere)).toMatchObject({ success: false, errors: [{ code: "quote_not_in_source" }] });
    // The model-facing check does not accept the stored shape.
    expect(valid(data, input).success).toBe(false);
  });
  it("shows the model no value, schemaVersion or contextRevision in its tool schema", () => {
    const schema = JSON.stringify(z.toJSONSchema(InterviewTurnToolSchema));
    expect(schema).not.toMatch(/"value"|schemaVersion|contextRevision/);
    expect(schema).toContain("sentenceIds");
  });
});

const local = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const settings = (overrides = {}) => parseEnvironment({ ...local, NODE_ENV: "test",
  AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "synthetic-interview-test-key", ...overrides });
type RequestBody = { system: string; messages: { content: string }[];
  tools: { name: string; input_schema: unknown }[]; tool_choice: unknown };
function response(output: unknown = extraction(), stop = "tool_use", name = "submit_extraction") {
  return new Response(JSON.stringify({ id: "msg_synthetic", type: "message", role: "assistant", model: "synthetic",
    content: [{ type: "tool_use", id: "tool_synthetic", name, input: output }], stop_reason: stop,
    usage: { input_tokens: 100, output_tokens: 200 } }), { headers: { "content-type": "application/json" } });
}
function harness(reply: (attempt: number) => Response = () => response(extraction()), count: (attempt: number) => number = () => 1000,
  stage: "interview_turn" | "extraction_turn" = "extraction_turn") {
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
  return { sent, counted, fetch, run: (input: unknown) => runner(stage, input) };
}

describe("chat and extraction scopes", () => {
  it("validates the chat half on questions alone: it asks, ignores proposals, and still refuses to stay silent", () => {
    expect(validateChatTurn(fixture(), chat())).toMatchObject({ success: true, data: { questions: [{ gapKey: "return-date-gap" }], proposedUpdates: [] }, warnings: [] });
    expect(validateChatTurn(fixture(), { ...chat(), ...extraction() })).toMatchObject({ success: true, data: { proposedUpdates: [], observations: [] },
      warnings: [{ code: "chat_extras_ignored" }] });
    expect(validateChatTurn(fixture(), { reply: chat().reply, questions: [] })).toEqual({ success: false, errors: [{ path: "questions", code: "no_questions" }] });
  });
  it("validates the extraction half on proposals alone: it never needs a question or a reply", () => {
    expect(validateExtraction(fixture(), extraction())).toMatchObject({ success: true, data: { questions: [], proposedUpdates: [{ fieldId: "return-action" }] }, warnings: [] });
    expect(validateExtraction(fixture(), { proposedUpdates: [], proposedSteps: [], proposedRequirements: [], observations: [] })).toMatchObject({ success: true, warnings: [] });
    expect(validateExtraction(fixture(), { ...extraction(), questions: chat().questions })).toMatchObject({ success: true, data: { questions: [] },
      warnings: [{ code: "extraction_extras_ignored" }] });
    const unknown = extraction(); unknown.proposedUpdates[0]!.sentenceIds = ["S99"];
    expect(validateExtraction(fixture(), unknown)).toEqual({ success: false, errors: [{ path: "proposedUpdates.0.sentenceIds", code: "unknown_sentence_id" }] });
  });
  it("re-checks a stored half against the current input by scope", () => {
    expect(revalidateStoredTurn(fixture(), { questions: [], proposedUpdates: extractionStored().proposedUpdates, observations: [] }, "extraction").success).toBe(true);
    // A stored chat turn whose questions were all answered meanwhile is saved as the reply alone.
    expect(revalidateStoredTurn(fixture(), { reply: chat().reply, questions: [] }, "chat").success).toBe(true);
  });
});

describe("interview stage transport", () => {
  it("counts the complete request including system/schema and returns a validated proposal", async () => {
    const h = harness(); const input = fixture(); const result = await h.run(input);
    expect(JSON.parse(h.sent[0]!.messages[0]!.content).input).toEqual(extractionView(input));
    expect(h.counted[0]).toEqual(expect.objectContaining({ system: h.sent[0]!.system,
      messages: h.sent[0]!.messages, tools: h.sent[0]!.tools, tool_choice: h.sent[0]!.tool_choice }));
    expect(h.sent[0]!.tools[0]!.name).toBe("submit_extraction");
    expect(result.payload).toEqual(extractionStored());
  });
  it("shows the model its evidence as [Sn] lines and resolves what it cites", async () => {
    const h = harness(); const result = await h.run(fixture());
    const sent = JSON.parse(h.sent[0]!.messages[0]!.content).input;
    expect(sent.currentMessage.text).toBe("[S1] The clerk records physical returns in the spreadsheet.\n[S2] The actual date is sometimes missing.");
    expect(sent.evidence[0].text).toBe("[S3] The hire desk sends a paper return note to billing.");
    expect(JSON.stringify(h.sent[0]!.tools[0]!.input_schema)).toContain("sentenceIds");
    expect(result.payload.proposedUpdates[0]).toMatchObject({ sourceId: "MSG-3", quote: "The clerk records physical returns in the spreadsheet." });
  });
  it("repairs a turn citing an unknown sentence id, telling the model the error code and nothing it wrote", async () => {
    const bad = extraction(); bad.proposedUpdates[0]!.sentenceIds = ["S77"];
    const h = harness(attempt => response(attempt === 1 ? bad : extraction()));
    const result = await h.run(fixture());
    expect(result.payload).toEqual(extractionStored());
    expect(result.metrics.validationErrors).toEqual([{ path: "proposedUpdates.0.sentenceIds", code: "unknown_sentence_id" }]);
    expect(h.sent[1]!.messages[0]!.content).toContain("unknown_sentence_id");
  });
  it("repairs an invalid proposal once without echoing model text or changing context", async () => {
    const h = harness(attempt => response(attempt === 1 ? { ...extraction(), approved: "private-invalid-output" } : extraction()));
    const result = await h.run(fixture());
    expect(result.payload).toEqual(extractionStored());
    expect(result.metrics).toMatchObject({ attempts: 2, inputTokens: 200, outputTokens: 400 });
    expect(result.metrics.attemptIssues).toHaveLength(1); // success path keeps the failed first attempt's issues
    expect(result.metrics.attemptIssues![0]).toEqual(result.metrics.validationErrors);
    expect(h.sent).toHaveLength(2);
    expect(JSON.parse(h.sent[1]!.messages[0]!.content).input).toEqual(extractionView(fixture()));
    expect(h.sent[1]!.messages[0]!.content).not.toContain("private-invalid-output");
  });
  it.each(["wrong tool", "invented citation"]) ("rejects %s after bounded repair", async kind => {
    const wrong = extraction();
    if (kind === "invented citation") wrong.proposedUpdates[0]!.sentenceIds = ["S99"];
    const h = harness(() => response(wrong, "tool_use",
      kind === "wrong tool" ? "other_tool" : "submit_extraction"));
    await expect(h.run(fixture())).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT", metrics: { attempts: 2 } });
    expect(h.sent).toHaveLength(2);
  });
  it("accepts one complete call of the expected tool even when the provider reports end_turn (OpenRouter does)", async () => {
    const h = harness(() => response(extraction(), "end_turn", "submit_extraction"));
    const result = await h.run(fixture());
    expect(h.sent).toHaveLength(1);
    expect(result.metrics.stopReasons).toEqual(["end_turn"]);
  });
  it("requests 16000 output tokens for an extraction and records the stop reason per attempt", async () => {
    const h = harness(attempt => response(attempt === 1 ? { ...extraction(), proposedUpdates: [{ fieldId: "return-action" }] } : extraction(),
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
  it("accepts an extraction whose scalars the server repairs, and reports the repairs in metrics", async () => {
    const sloppy = { ...JSON.parse(JSON.stringify(extraction())), contextRevision: 99, reply: "Sure thing." };
    delete sloppy.schemaVersion;
    const h = harness(() => response(sloppy));
    const result = await h.run(fixture());
    expect(result.metrics.attempts).toBe(1);
    expect(result.payload).toEqual(extractionStored());
    expect(result.metrics.warnings).toEqual([]); // the extraction call has no reply to repair
  });
  it("accepts the turn as one JSON text block when the model skips the tool call, and still validates it fully", async () => {
    const asText = (output: unknown, text = JSON.stringify(output)) => new Response(JSON.stringify({ id: "msg_synthetic", type: "message",
      role: "assistant", model: "synthetic", content: [{ type: "text", text }], stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 200 } }), { headers: { "content-type": "application/json" } });
    const ok = harness(() => asText(extraction()));
    expect((await ok.run(fixture())).payload).toEqual(extractionStored());
    expect((await harness(() => asText(extraction(), "```json\n" + JSON.stringify(extraction()) + "\n```")).run(fixture())).payload).toEqual(extractionStored());
    // The same checks apply: an invented citation, prose, or an array is refused after the bounded repair.
    const invented = extraction(); invented.proposedUpdates[0]!.sentenceIds = ["S99"];
    for (const bad of [asText(invented), asText(null, "I will ask about the return date."), asText(null, "[1,2]")]) {
      await expect(harness(() => bad.clone()).run(fixture())).rejects.toMatchObject({ code: "AI_INVALID_OUTPUT" });
    }
  });
  it("runs the chat call on its own tool: reply and questions, plain messages, nothing to cite", async () => {
    const h = harness(() => response(chat(), "tool_use", "submit_interview_turn"), () => 1000, "interview_turn"); const input = fixture();
    const result = await h.run(input);
    expect(h.sent[0]!.tools[0]!.name).toBe("submit_interview_turn");
    const schema = JSON.stringify(h.sent[0]!.tools[0]!.input_schema);
    expect(schema).toContain("questions");
    expect(schema).not.toMatch(/sentenceIds|proposedUpdates|proposedSteps|observations/);
    expect(JSON.parse(h.sent[0]!.messages[0]!.content).input).toEqual(input); // not [Sn]-tagged
    expect(h.sent[0]!.system).toContain("a separate step that runs in the background");
    expect(result.payload).toEqual({ ...stored(), proposedUpdates: [], observations: [] });
    expect(result.metrics.stage).toBe("interview_turn");
  });
  it("ignores proposals a chat reply carries, with a warning, instead of trusting them", async () => {
    const h = harness(() => response({ ...chat(), proposedUpdates: extraction().proposedUpdates }, "tool_use", "submit_interview_turn"), () => 1000, "interview_turn");
    const result = await h.run(fixture());
    expect(result.payload.proposedUpdates).toEqual([]);
    expect(result.metrics.warnings).toEqual([{ path: "proposals", code: "chat_extras_ignored" }]);
  });
  it("runs the extraction call on its own tool, with numbered sentences and without gaps or history", async () => {
    const h = harness(); const input = fixture(); await h.run(input);
    expect(h.sent[0]!.tools[0]!.name).toBe("submit_extraction");
    const schema = JSON.stringify(h.sent[0]!.tools[0]!.input_schema);
    expect(schema).toContain("sentenceIds");
    expect(schema).not.toMatch(/"questions"|"reply"/);
    const sent = JSON.parse(h.sent[0]!.messages[0]!.content).input;
    expect(sent.activeGaps).toEqual([]); expect(sent.history).toEqual([]);
    expect(sent.currentMessage.text).toContain("[S1]");
    expect(h.sent[0]!.system).toContain("submit_extraction");
  });
  it("counts every response accepted from a JSON text block, so the fallback never hides in the first-try rate", async () => {
    const asText = (output: unknown) => new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "s",
      content: [{ type: "text", text: JSON.stringify(output) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
    { headers: { "content-type": "application/json" } });
    const viaText = await harness(() => asText(extraction())).run(fixture());
    expect(viaText.metrics.textFallbacks).toBe(1);
    const viaTool = await harness().run(fixture());
    expect(viaTool.metrics.textFallbacks).toBe(0);
  });
  it("rejects oversized complete request without truncating sources", async () => {
    const h = harness(() => response(), () => 60001);
    await expect(h.run(fixture())).rejects.toMatchObject({ code: "AI_INPUT_TOO_LARGE" });
    expect(h.sent).toHaveLength(0);
    expect(JSON.parse(h.counted[0]!.messages[0]!.content).input).toEqual(extractionView(fixture()));
  });
  it("refuses a fabricated stub response and sensitive input before provider IO", async () => {
    const stub = createStageRunner(settings({ AI_PROVIDER: "stub" }));
    await expect(stub("extraction_turn", fixture())).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR" });
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
