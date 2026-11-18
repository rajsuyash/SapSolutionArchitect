import { describe, expect, it } from "vitest";
import { emptyListKeys, noneApplyLabel } from "../src/lib/workspace-fields";

const KEYS = ["name", "actor", "system", "trigger", "description", "inputs", "outputs", "controls", "exceptions"];
const draft = (statuses: Record<string, string> = {}) => ({ id: "st_a",
  fields: KEYS.map(key => ({ id: `st_a_${key}`, status: statuses[key] ?? "EMPTY" })) });

describe("emptyListKeys", () => {
  it("covers only EMPTY list details, in display order, and never a core detail", () => {
    expect(emptyListKeys(draft())).toEqual(["inputs", "outputs", "controls", "exceptions"]);
  });
  it("leaves KNOWN, UNKNOWN, NOT_APPLICABLE and OWNER_PENDING list details alone", () => {
    expect(emptyListKeys(draft({ inputs: "KNOWN", outputs: "UNKNOWN", controls: "OWNER_PENDING", exceptions: "EMPTY" }))).toEqual(["exceptions"]);
    expect(emptyListKeys(draft({ inputs: "NOT_APPLICABLE" }))).toEqual(["outputs", "controls", "exceptions"]);
  });
  it("is empty (so no button) when no list detail is EMPTY", () => {
    expect(emptyListKeys(draft({ inputs: "KNOWN", outputs: "UNKNOWN", controls: "OWNER_PENDING", exceptions: "NOT_APPLICABLE" }))).toEqual([]);
  });
});

describe("noneApplyLabel", () => {
  it("names the details it will clear", () => {
    expect(noneApplyLabel(["outputs", "controls", "exceptions"])).toBe("No outputs, checks or exceptions for this step");
    expect(noneApplyLabel(["exceptions"])).toBe("No exceptions for this step");
    expect(noneApplyLabel(["inputs", "controls"])).toBe("No inputs or checks for this step");
  });
});
