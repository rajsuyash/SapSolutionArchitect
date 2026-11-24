import { describe, expect, it } from "vitest";
import { parseInterviewInput, revalidateStoredTurn, validateExtraction, type InterviewInput } from "../src/lib/ai/discovery-interview";

// Fictional equipment-hire paragraph, the shape seen in the live audit: one pasted walkthrough of a step.
const STEP_SENTENCE = "Step 1, equipment return: performed by the counter clerk at the branch, in RentTrack plus a barcode scanner, triggered when the customer arrives with the equipment.";
const ACTOR_SENTENCE = "The counter clerk does it.";
const SYSTEM_SENTENCE = "They use RentTrack.";
const TEXT = [STEP_SENTENCE, ACTOR_SENTENCE, SYSTEM_SENTENCE, "Late-return charges are billed by the back office."].join(" ");
const KEYS = ["actor", "system", "trigger", "inputs", "outputs", "controls"] as const;
const SPANS = { actor: "the counter clerk at the branch", system: "RentTrack plus a barcode scanner", trigger: "the customer arrives with the equipment" };

const input = (descriptionValue: string | null = STEP_SENTENCE): InterviewInput => parseInterviewInput({
  schemaVersion: 1, contextRevision: 4, variantName: "Late returns", problemStatement: "Late-return charges are disputed.",
  currentMessage: { id: "M2", text: TEXT }, evidence: [],
  fields: [
    { id: "st_a_name", label: "step name", value: "Equipment return", status: "KNOWN" },
    { id: "st_a_description", label: "step description", value: descriptionValue, status: descriptionValue ? "KNOWN" : "EMPTY" },
    ...KEYS.map(key => ({ id: `st_a_${key}`, label: key, value: null, status: "EMPTY" as const })),
  ],
  activeGaps: [], closedGapKeys: [], unextractedMessageIds: [], history: [], requirements: [],
  steps: [{ id: "st_a", name: "Equipment return", summary: descriptionValue, status: "CURRENT" }],
});
const update = (fieldId: string, sentenceIds: string[], answer?: string | null) =>
  ({ fieldId, operation: "PROPOSE_SET", previousValue: null, sentenceIds, ...(answer === undefined ? {} : { answer }) });
const run = (updates: unknown[], source = input()) => {
  const result = validateExtraction(source, { proposedUpdates: updates, proposedSteps: [], proposedRequirements: [], observations: [] });
  if (!result.success) throw new Error(JSON.stringify(result.errors));
  return result;
};
const dropped = (r: ReturnType<typeof run>) => r.warnings.filter(w => w.code === "update_dropped").map(w => `${w.path}:${w.detail}`);
const fallbacks = (r: ReturnType<typeof run>) => r.warnings.filter(w => w.code === "answer_fallback").map(w => `${w.path}:${w.detail}`);
const stored = (updates: unknown[], source = input()) => {
  const result = revalidateStoredTurn(source, { proposedUpdates: updates, proposedSteps: [], proposedRequirements: [], observations: [] }, "extraction");
  if (!result.success) throw new Error(JSON.stringify(result.errors));
  return result;
};

describe("short answers checked against the cited sentence", () => {
  it("one sentence answering three fields with three different spans keeps all three, with the sentence as evidence", () => {
    const result = run(Object.entries(SPANS).map(([key, span]) => update(`st_a_${key}`, ["S1"], span)));
    expect(result.data.proposedUpdates.map(u => [u.fieldId, u.value])).toEqual(Object.entries(SPANS).map(([key, span]) => [`st_a_${key}`, span]));
    expect(result.data.proposedUpdates.every(u => u.quote === STEP_SENTENCE && u.sourceId === "M2")).toBe(true);
    expect(dropped(result)).toEqual([]);
    expect(fallbacks(result)).toEqual([]);
  });

  it("accepts a span after whitespace normalisation and stores it normalised", () => {
    const result = run([update("st_a_actor", ["S1"], "  the counter\n  clerk   at the branch ")]);
    expect(result.data.proposedUpdates[0]!.value).toBe(SPANS.actor);
  });

  it("an answer equal to the whole quote stores the quote itself", () => {
    const result = run([update("st_a_actor", ["S2"], ACTOR_SENTENCE)]);
    expect(result.data.proposedUpdates[0]!.value).toBe(ACTOR_SENTENCE);
    expect(fallbacks(result)).toEqual([]);
  });

  it.each([
    ["a paraphrase", "the clerk at the counter"],
    ["invented words", "the regional manager"],
    ["a different case", "THE COUNTER CLERK AT THE BRANCH"],
    ["a fragment that starts inside a word", "ounter clerk at the branch"],
    ["words out of order", "at the branch the counter clerk"],
  ])("%s is not a span: falls back to the quote with a warning, then the guard drops the echo", (_name, answer) => {
    const result = run([update("st_a_actor", ["S1"], answer)]);
    expect(fallbacks(result)).toEqual(["proposedUpdates.0:answer_not_in_quote"]);
    expect(result.data.proposedUpdates).toEqual([]);
    expect(dropped(result)).toEqual(["proposedUpdates.st_a_actor:echoed_value"]);
  });

  it("a short quote with a bad answer falls back to the quote and is kept", () => {
    const result = run([update("st_a_actor", ["S2"], "somebody else")]);
    expect(result.data.proposedUpdates.map(u => u.value)).toEqual([ACTOR_SENTENCE]);
    expect(fallbacks(result)).toEqual(["proposedUpdates.0:answer_not_in_quote"]);
  });

  it("no answer (absent, null or blank): old behaviour, warned, and the guard still drops the echoed sentence", () => {
    for (const answer of [undefined, null, "  "]) {
      const result = run([update("st_a_actor", ["S1"], answer), update("st_a_system", ["S1"], answer)]);
      expect(result.data.proposedUpdates).toEqual([]);
      expect(fallbacks(result)).toEqual(["proposedUpdates.0:no_answer", "proposedUpdates.1:no_answer"]);
      expect(dropped(result)).toEqual(["proposedUpdates.st_a_actor:echoed_value", "proposedUpdates.st_a_system:echoed_value"]);
    }
  });

  it("the guard judges the value: two fields with the same span are still an echo, different spans are not", () => {
    const same = run([update("st_a_actor", ["S1"], SPANS.system), update("st_a_system", ["S1"], SPANS.system)]);
    expect(same.data.proposedUpdates).toHaveLength(2); // both are short, so one span may answer two fields (like a short sentence)
    const long = `${"The clerk checks the tag, the contract and the damage photos at the counter before anything else happens, ".repeat(3)}done.`;
    const source = { ...input(null), currentMessage: { id: "M2", text: long } };
    expect(run([update("st_a_actor", ["S1"])], source).data.proposedUpdates).toEqual([]);
    expect(run([update("st_a_actor", ["S1"], "The clerk checks the tag")], source).data.proposedUpdates.map(u => u.value)).toEqual(["The clerk checks the tag"]);
  });
});

describe("extraction echo guard on the fallback path", () => {
  it("drops the same long sentence proposed for five fields of one step, and keeps them open", () => {
    const result = run(KEYS.slice(0, 5).map(key => update(`st_a_${key}`, ["S1"])), input(null));
    expect(result.data.proposedUpdates).toEqual([]);
    expect(dropped(result).filter(d => d.endsWith(":echoed_value"))).toHaveLength(5);
  });

  it("keeps the description proposal when the same long sentence was also sent to other fields", () => {
    const result = run([update("st_a_description", ["S1"]), update("st_a_actor", ["S1"]), update("st_a_trigger", ["S1"])], input(null));
    expect(result.data.proposedUpdates.map(u => u.fieldId)).toEqual(["st_a_description"]);
  });

  it("drops a value too long to be one detail, but never one for the description", () => {
    const long = `${"The clerk checks the tag, the contract and the damage photos at the counter before anything else happens, ".repeat(3)}done.`;
    const source = { ...input(null), currentMessage: { id: "M2", text: long } };
    expect(run([update("st_a_actor", ["S1"])], source).data.proposedUpdates).toEqual([]);
    expect(run([update("st_a_description", ["S1"])], source).data.proposedUpdates).toHaveLength(1);
  });

  it("negative control: short, different answers for different fields all pass", () => {
    const result = run([update("st_a_actor", ["S2"]), update("st_a_system", ["S3"])]);
    expect(result.data.proposedUpdates.map(u => u.fieldId)).toEqual(["st_a_actor", "st_a_system"]);
    expect(dropped(result)).toEqual([]);
  });

  it("negative control: a long description for a step with no description yet is kept", () => {
    const result = run([update("st_a_description", ["S1"])], input(null));
    expect(result.data.proposedUpdates).toHaveLength(1);
    expect(result.data.proposedUpdates[0]!.value).toBe(STEP_SENTENCE);
  });
});

describe("stored turns", () => {
  const old = (fieldId: string, quote: string) => ({ fieldId, operation: "PROPOSE_SET", previousValue: null, sourceId: "M2", quote, value: quote });

  it("a turn saved before short answers (value equal to quote, no answer field) revalidates unchanged, long echoes included", () => {
    const result = stored([old("st_a_actor", STEP_SENTENCE), old("st_a_system", STEP_SENTENCE), old("st_a_trigger", ACTOR_SENTENCE)]);
    expect(result.data.proposedUpdates.map(u => [u.value, u.quote])).toEqual([[STEP_SENTENCE, STEP_SENTENCE], [STEP_SENTENCE, STEP_SENTENCE], [ACTOR_SENTENCE, ACTOR_SENTENCE]]);
  });

  it("a new row whose value is a span of its quote revalidates and keeps the span", () => {
    const result = stored([{ ...old("st_a_actor", STEP_SENTENCE), value: SPANS.actor }, { ...old("st_a_system", STEP_SENTENCE), value: SPANS.system }]);
    expect(result.data.proposedUpdates.map(u => u.value)).toEqual([SPANS.actor, SPANS.system]);
    expect(result.data.proposedUpdates.every(u => u.quote === STEP_SENTENCE)).toBe(true);
  });

  it("a stored value that is not a span of its quote is replaced by the quote, never trusted", () => {
    const result = stored([{ ...old("st_a_actor", ACTOR_SENTENCE), value: "somebody invented this" }]);
    expect(result.data.proposedUpdates.map(u => u.value)).toEqual([ACTOR_SENTENCE]);
  });

  it("a stored quote that is not in its source still fails", () => {
    const result = revalidateStoredTurn(input(), { proposedUpdates: [old("st_a_actor", "Not said anywhere.")], proposedSteps: [], proposedRequirements: [], observations: [] }, "extraction");
    expect(result.success).toBe(false);
  });
});
