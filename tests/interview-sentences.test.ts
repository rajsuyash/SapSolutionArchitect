import { describe, expect, it } from "vitest";
import { indexSentences, interviewModelView, splitSentences } from "../src/lib/ai/interview-sentences";
import { InterviewTurnToolSchema, validateInterviewTurn, type InterviewTurn } from "../src/lib/ai/discovery-interview";
import { z } from "zod";
import { fixture } from "./support/interview-input";

const pieces = (text: string) => splitSentences(text).map(({ start, end }) => text.slice(start, end));

describe("splitSentences", () => {
  const samples = [
    "The clerk records returns. The date is sometimes missing! Who checks it? Nobody.",
    "no punctuation at all just words running on",
    "Line one\nLine two\r\n\r\nLine three.  Trailing   ",
    "We use SAP, e.g. for finance. i.e. the ledger. Approx. 40 orders a day, etc. Then billing runs.",
    "1. Receive the order\n2. Check stock\nA. Confirm. Dr. Rao signs off. Total is 3.5 million.",
    "Wait... what happened? Then it stopped.",
    "ग्राहक का ऑर्डर आता है। क्लर्क उसे दर्ज करता है।",
    "",
    "   \n  ",
    `${"word ".repeat(600)}end.`,
  ];

  it("is lossless: spans are ordered, inside the text, and only whitespace lies between them", () => {
    for (const text of samples) {
      const spans = splitSentences(text);
      let at = 0;
      for (const { start, end } of spans) {
        expect(start).toBeGreaterThanOrEqual(at);
        expect(end).toBeGreaterThan(start);
        expect(text.slice(at, start).trim()).toBe("");
        expect(text.slice(start, end)).toBe(text.slice(start, end).trim());
        at = end;
      }
      expect(text.slice(at).trim()).toBe("");
      // No character other than whitespace is lost.
      expect(spans.map(s => text.slice(s.start, s.end)).join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    }
  });

  it("is deterministic", () => {
    for (const text of samples) expect(splitSentences(text)).toEqual(splitSentences(text));
  });

  it("splits at . ! ? followed by whitespace, and at every newline", () => {
    expect(pieces(samples[0]!)).toEqual(["The clerk records returns.", "The date is sometimes missing!", "Who checks it?", "Nobody."]);
    expect(pieces(samples[2]!)).toEqual(["Line one", "Line two", "Line three.", "Trailing"]);
  });

  it("keeps text without punctuation as one sentence", () => {
    expect(pieces(samples[1]!)).toEqual([samples[1]]);
  });

  it("does not split after abbreviations, list markers, decimals or a lowercase continuation", () => {
    expect(pieces(samples[3]!)).toEqual(["We use SAP, e.g. for finance. i.e. the ledger.",
      "Approx. 40 orders a day, etc.", "Then billing runs."]);
    expect(pieces(samples[4]!)).toEqual(["1. Receive the order", "2. Check stock", "A. Confirm.", "Dr. Rao signs off.", "Total is 3.5 million."]);
    expect(pieces(samples[5]!)).toEqual(["Wait... what happened?", "Then it stopped."]);
  });

  it("splits Devanagari text at the danda", () => {
    expect(pieces(samples[6]!)).toEqual(["ग्राहक का ऑर्डर आता है।", "क्लर्क उसे दर्ज करता है।"]);
  });

  it("returns nothing for empty or blank text", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n  ")).toEqual([]);
  });

  it("cuts a very long unpunctuated run into chunks of at most 1000 characters on whitespace", () => {
    const parts = pieces(samples[9]!);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(1000);
  });
});

describe("indexSentences and the model's view", () => {
  it("numbers sentences S1.. across the current message then each evidence source", () => {
    const index = indexSentences(fixture());
    expect([...index.sentences.keys()]).toEqual(["S1", "S2", "S3"]);
    expect(index.sentences.get("S2")).toMatchObject({ sourceId: "MSG-3" });
    expect(index.sentences.get("S3")).toMatchObject({ sourceId: "SRC-1" });
    expect(indexSentences(fixture())).toEqual(index); // rebuilt identically at validation time
  });

  it("shows evidence as [Sn] lines per source and changes nothing else", () => {
    const input = fixture();
    const view = interviewModelView(input);
    expect(view.currentMessage).toEqual({ id: "MSG-3", text: "[S1] The clerk records physical returns in the spreadsheet.\n[S2] The actual date is sometimes missing." });
    expect(view.evidence).toEqual([{ id: "SRC-1", text: "[S3] The hire desk sends a paper return note to billing." }]);
    expect({ ...view, currentMessage: input.currentMessage, evidence: input.evidence }).toEqual(input);
  });
});

describe("sentence-ID citations", () => {
  const first = "The clerk records physical returns in the spreadsheet.";
  const second = "The actual date is sometimes missing.";
  const turn = (proposedUpdates: unknown[] = [], extra: object = {}) => ({
    reply: "Thank you for that context.",
    questions: [{ gapKey: "return-date-gap", question: "Which date stops the rental charge?", whyItMatters: "This changes the final invoice amount." }],
    proposedUpdates, proposedSteps: [], proposedRequirements: [], observations: [], ...extra });
  const update = (sentenceIds: string[], fieldId = "return-action") =>
    ({ fieldId, operation: "PROPOSE_SET", previousValue: null, sentenceIds });
  const run = (raw: unknown, input = fixture()) => validateInterviewTurn(input, raw);
  const data = (result: ReturnType<typeof run>) => (result as { data: InterviewTurn }).data;

  it("resolves one sentence to the exact source text, with value equal to the quote", () => {
    const result = run(turn([update(["S1"])]));
    expect(result).toMatchObject({ success: true, warnings: [] });
    expect(data(result).proposedUpdates).toEqual([{ fieldId: "return-action", operation: "PROPOSE_SET", previousValue: null,
      sourceId: "MSG-3", quote: first, value: first }]);
  });

  it("resolves contiguous sentences to the slice from the first start to the last end", () => {
    const result = run(turn([update(["S1", "S2"])]));
    expect(data(result).proposedUpdates[0]).toMatchObject({ sourceId: "MSG-3", quote: `${first} ${second}`, value: `${first} ${second}` });
    expect(fixture().currentMessage.text.includes(data(result).proposedUpdates[0]!.quote)).toBe(true);
    // Order of the ids does not matter.
    expect(data(run(turn([update(["S2", "S1"])]))).proposedUpdates[0]!.quote).toBe(`${first} ${second}`);
  });

  it("keeps the line break when a multi-sentence quote spans one", () => {
    const input = fixture(); input.currentMessage.text = "First step.\nSecond step.";
    expect(data(run(turn([update(["S1", "S2"])]), input)).proposedUpdates[0]!.quote).toBe("First step.\nSecond step.");
  });

  it("rejects an unknown sentence id", () => {
    expect(run(turn([update(["S99"])]))).toEqual({ success: false, errors: [{ path: "proposedUpdates.0.sentenceIds", code: "unknown_sentence_id" }] });
    expect(run(turn([update(["T4.S2"])]))).toMatchObject({ success: false, errors: [{ code: "unknown_sentence_id" }] });
  });

  it("trims ids from other sources to the first cited id's source, with a warning", () => {
    const result = run(turn([update(["S2", "S3"])]));
    expect(result).toMatchObject({ success: true, warnings: [{ path: "proposedUpdates.0", code: "evidence_cross_source_trimmed" }] });
    expect(data(result).proposedUpdates[0]).toMatchObject({ sourceId: "MSG-3", quote: second });
    expect(data(run(turn([update(["S3", "S2"])]))).proposedUpdates[0]!.sourceId).not.toBe("MSG-3");
  });

  it("resolves non-contiguous ids within one source to the exact span from the first start to the last end", () => {
    const input = fixture(); input.currentMessage.text = "One. Two. Three.";
    const result = run(turn([update(["S1", "S3"])]), input);
    expect(result).toMatchObject({ success: true, warnings: [] });
    expect(data(result).proposedUpdates[0]).toMatchObject({ quote: "One. Two. Three.", value: "One. Two. Three." });
  });

  it("de-duplicates repeated ids silently", () => {
    const input = fixture(); input.currentMessage.text = "One. Two. Three.";
    const result = run(turn([update(["S1", "S1"])]), input);
    expect(result).toMatchObject({ success: true, warnings: [] });
    expect(data(result).proposedUpdates[0]!.quote).toBe("One.");
  });

  it("drops a proposal whose span covers more than 6 sentences, without failing the turn", () => {
    const input = fixture(); input.currentMessage.text = "A1. B2. C3. D4. E5. F6. G7. H8.";
    const six = run(turn([update(["S1", "S6"])]), input);
    expect(data(six).proposedUpdates).toHaveLength(1);
    const seven = run(turn([update(["S1", "S7"])]), input);
    expect(seven).toMatchObject({ success: true, warnings: [{ path: "proposedUpdates.0", code: "evidence_span_too_long" }] });
    expect(data(seven).proposedUpdates).toEqual([]);
  });

  it("requires one to three ids and refuses the old quote shape from the model", () => {
    expect(run(turn([update([])])).success).toBe(false);
    expect(run(turn([update(["S1", "S2", "S3", "S4"])])).success).toBe(false);
    expect(run(turn([{ fieldId: "return-action", operation: "PROPOSE_SET", previousValue: null, sourceId: "MSG-3", quote: first }])).success).toBe(false);
  });

  it("resolves proposed steps and requirements and drops a nameHint that is not in the source", () => {
    const result = run(turn([], {
      proposedSteps: [{ sentenceIds: ["S1"], nameHint: "records physical returns" }, { sentenceIds: ["S2"], nameHint: "Invented label" }],
      proposedRequirements: [{ stepRef: "new_0", kind: "PAIN_POINT", critical: true, sentenceIds: ["S2"] }] }));
    expect(result).toMatchObject({ success: true, warnings: [{ path: "proposedSteps.1.nameHint", code: "name_hint_dropped" }] });
    expect(data(result).proposedSteps).toEqual([
      { sourceId: "MSG-3", quote: first, value: first, nameHint: "records physical returns" },
      { sourceId: "MSG-3", quote: second, value: second, nameHint: null }]);
    expect(data(result).proposedRequirements[0]).toMatchObject({ stepRef: "new_0", sourceId: "MSG-3", quote: second, value: second });
    expect(run(turn([], { proposedRequirements: [{ stepRef: "new_0", kind: "PAIN_POINT", critical: true, sentenceIds: ["S99"] }] })))
      .toMatchObject({ success: false, errors: [{ path: "proposedRequirements.0.sentenceIds", code: "unknown_sentence_id" }] });
  });

  it("drops a requirement that attaches to no step, with a warning, instead of failing the turn", () => {
    const result = run(turn([], { proposedRequirements: [
      { stepRef: "st_missing", kind: "PAIN_POINT", critical: true, sentenceIds: ["S2"] },
      { stepRef: "new_5", kind: "PAIN_POINT", critical: true, sentenceIds: ["S1"] }] }));
    expect(result).toMatchObject({ success: true, warnings: [
      { path: "proposedRequirements.0", code: "requirement_dropped", detail: "unknown_step_ref" },
      { path: "proposedRequirements.1", code: "requirement_dropped", detail: "unknown_step_ref" }] });
    expect(data(result).proposedRequirements).toEqual([]);
  });

  it("shows the model sentenceIds and no quote, sourceId or value in the tool schema", () => {
    const schema = JSON.stringify(z.toJSONSchema(InterviewTurnToolSchema));
    expect(schema).toContain("sentenceIds");
    expect(schema).not.toMatch(/"quote"|"sourceId"|"value"/);
  });
});
