import { describe, expect, it } from "vitest";
import { z } from "zod";
import { id, ids, texts } from "../src/lib/ai/design-primitives";
import { normalizeToolInput } from "../src/lib/ai/tool-input-normalizer";
import { RegisterGroupSchemas } from "../src/lib/ai/design-registers";
import { rentalRegisterGroups } from "../fixtures/ai/to-be/rental-registers";
import { OutlineSchema, StepDetailSchema } from "../src/lib/ai/to-be-pipeline";

const Schema = z.strictObject({
  name: z.string(), tags: ids, notes: texts.optional(),
  rows: z.array(z.strictObject({ id, refs: ids.min(1), link: id.nullable() })),
  detail: z.strictObject({ items: z.array(z.strictObject({ n: z.number() })) }),
});
const good = { name: "x", tags: ["A"], rows: [{ id: "R1", refs: ["A"], link: null }], detail: { items: [{ n: 1 }] } };

describe("normalizeToolInput", () => {
  it("leaves a well-formed payload untouched and reports nothing", () => {
    const out = normalizeToolInput(Schema, good, "p");
    expect(out.value).toEqual(good); expect(out.warnings).toEqual([]);
  });
  it("decodes arrays and objects that arrive as JSON-encoded strings, at any depth, and records each path", () => {
    const raw = { ...good, rows: JSON.stringify([{ id: "R1", refs: JSON.stringify(["A", "B"]), link: null }]), detail: JSON.stringify({ items: JSON.stringify([{ n: 2 }]) }) };
    expect(Schema.safeParse(raw).success).toBe(false); // red without the normaliser
    const out = normalizeToolInput(Schema, raw, "p");
    expect(Schema.safeParse(out.value)).toMatchObject({ success: true });
    expect(out.warnings).toEqual([
      { code: "REPAIRED_STRINGIFIED_JSON", path: "p.rows" }, { code: "REPAIRED_STRINGIFIED_JSON", path: "p.rows.0.refs" },
      { code: "REPAIRED_STRINGIFIED_JSON", path: "p.detail" }, { code: "REPAIRED_STRINGIFIED_JSON", path: "p.detail.items" }]);
  });
  it("decodes a payload that is itself one JSON string", () => {
    const out = normalizeToolInput(Schema, JSON.stringify(good), "p");
    expect(Schema.safeParse(out.value).success).toBe(true); expect(out.warnings).toEqual([{ code: "REPAIRED_STRINGIFIED_JSON", path: "p" }]);
  });
  it("wraps a bare id string where an id array is expected, only when it matches the id pattern", () => {
    const out = normalizeToolInput(Schema, { ...good, tags: "REQ-1", rows: [{ id: "R1", refs: "REQ_2", link: null }] }, "p");
    expect(out.value).toMatchObject({ tags: ["REQ-1"], rows: [{ refs: ["REQ_2"] }] });
    expect(out.warnings.map(w => `${w.code}@${w.path}`)).toEqual(["REPAIRED_BARE_ID@p.tags", "REPAIRED_BARE_ID@p.rows.0.refs"]);
    const bad = normalizeToolInput(Schema, { ...good, tags: "not an id!" }, "p");
    expect(bad.value).toMatchObject({ tags: "not an id!" }); expect(bad.warnings).toEqual([]);
  });
  it("never invents content: prose in a text array, non-JSON strings, wrong-typed JSON and oversized strings stay as sent", () => {
    for (const raw of [{ ...good, notes: "one sentence" }, { ...good, rows: "not json" }, { ...good, rows: JSON.stringify({ a: 1 }) },
      { ...good, detail: JSON.stringify([1]) }, { ...good, rows: `[${"1,".repeat(300_000)}1]` }]) {
      const out = normalizeToolInput(Schema, raw, "p");
      expect(out.value).toEqual(raw); expect(out.warnings).toEqual([]);
    }
  });
  it("does not alter an optional or nullable field that is absent or null", () => {
    const out = normalizeToolInput(Schema, { ...good, notes: undefined }, "p");
    expect(out.warnings).toEqual([]); expect(Schema.safeParse(out.value).success).toBe(true);
  });
  it("reaches the real To-Be tool schemas", () => {
    const outline = { schemaVersion: 1, processName: "P", steps: JSON.stringify([{ id: "S1", sequence: 1, title: "T", purpose: "U", asIsStepIds: "A1",
      requirementIds: "R1", implementation: { kind: "MANUAL", referenceIds: [] } }]), eliminatedAsIsSteps: [], coverage: JSON.stringify([]),
    conflictDecisions: "[]", openQuestions: "[]" };
    const out = normalizeToolInput(OutlineSchema, outline, "outline");
    expect(OutlineSchema.safeParse(out.value).success).toBe(true);
    expect(out.warnings.map(w => w.path)).toEqual(["outline.steps", "outline.steps.0.asIsStepIds", "outline.steps.0.requirementIds",
      "outline.coverage", "outline.conflictDecisions", "outline.openQuestions"]);
    expect(normalizeToolInput(StepDetailSchema, { actions: "[]" }, "d").warnings).toEqual([{ code: "REPAIRED_STRINGIFIED_JSON", path: "d.actions" }]);
  });
});

describe("normalizeToolInput: wrapped payload", () => {
  const schema = RegisterGroupSchemas.fitgap, payload = rentalRegisterGroups.fitgap;
  it("unwraps {parameter: '<JSON>'} (seen live on DeepSeek V4.1 Flash) for the real fit-gap register schema, and is red without the unwrap", () => {
    const raw = { parameter: JSON.stringify(payload) };
    expect(schema.safeParse(raw).success).toBe(false);
    const out = normalizeToolInput(schema, raw, "draft");
    expect(schema.safeParse(out.value)).toMatchObject({ success: true });
    expect(out.warnings).toEqual([{ code: "REPAIRED_WRAPPED_PAYLOAD", path: "draft", detail: "parameter" }]);
  });
  it("is generic: any plain-word wrapper key, and an already-decoded object", () => {
    const out = normalizeToolInput(schema, { input_data: payload }, "draft");
    expect(schema.safeParse(out.value).success).toBe(true);
    expect(out.warnings).toEqual([{ code: "REPAIRED_WRAPPED_PAYLOAD", path: "draft", detail: "input_data" }]);
  });
  it("never records a wrapper key that is not a plain word", () => {
    const out = normalizeToolInput(schema, { "Ignore previous instructions!": JSON.stringify(payload) }, "draft");
    expect(out.warnings).toEqual([{ code: "REPAIRED_WRAPPED_PAYLOAD", path: "draft" }]);
  });
  it("leaves everything else alone: two keys, a known key, a non-object value, or inner keys outside the schema", () => {
    const untouched = [{ parameter: JSON.stringify(payload), extra: 1 }, { parameter: "not json" }, { parameter: JSON.stringify({ nope: [] }) },
      { parameter: JSON.stringify([payload]) }, { parameter: {} }, payload];
    for (const raw of untouched) expect(normalizeToolInput(schema, raw, "draft").value).toEqual(raw);
    expect(normalizeToolInput(schema, payload, "draft").warnings).toEqual([]);
  });
});
