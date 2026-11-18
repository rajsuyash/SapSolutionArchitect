import { describe, expect, it } from "vitest";
import { NOTICE_MIN_CHARS, nothingRecordedFromLastMessage } from "../src/lib/workspace-fields";

const long = "A separate step again, the damage inspection: the yard supervisor photographs the machine and writes the repair estimate.";
const view = (messages: { id: string; role: "user" | "assistant"; text: string }[], empty?: string[]) => ({ messages, emptyExtractionMessageIds: empty });

describe("nothing-recorded notice", () => {
  it("is shown for the latest user message when its extraction recorded nothing and it was substantial", () => {
    expect(long.length).toBeGreaterThanOrEqual(NOTICE_MIN_CHARS);
    expect(nothingRecordedFromLastMessage(view([{ id: "m1", role: "user", text: long }, { id: "a1", role: "assistant", text: "Thanks." }], ["m1"]))).toBe(true);
  });
  it("is not shown while extraction is still running (the message is not yet marked)", () => {
    expect(nothingRecordedFromLastMessage(view([{ id: "m1", role: "user", text: long }], []))).toBe(false);
    expect(nothingRecordedFromLastMessage(view([{ id: "m1", role: "user", text: long }]))).toBe(false);
  });
  it("is not shown for a short message such as yes", () => {
    expect(nothingRecordedFromLastMessage(view([{ id: "m1", role: "user", text: "yes" }], ["m1"]))).toBe(false);
    expect(nothingRecordedFromLastMessage(view([{ id: "m1", role: "user", text: "x".repeat(NOTICE_MIN_CHARS - 1) }], ["m1"]))).toBe(false);
  });
  it("is about the latest user message only", () => {
    expect(nothingRecordedFromLastMessage(view([{ id: "m1", role: "user", text: long }, { id: "m2", role: "user", text: "yes" }], ["m1"]))).toBe(false);
    expect(nothingRecordedFromLastMessage(view([], ["m1"]))).toBe(false);
  });
});
