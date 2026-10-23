import { describe, expect, it } from "vitest";
import { extractSapCodes, internalTermHits, mentionsCode } from "../src/lib/ai/design-text-lint";

describe("SAP codes in step text", () => {
  it("finds movement types, document types, condition types, reason codes and organisation codes, once each", () => {
    const found = extractSapCodes("Post movement type 321 or 343, use document type ZOR and condition type PR00. Reason code R01 applies at plant 4100 and 4200; company code 1000 and plant 4100 again.");
    expect(found).toEqual(expect.arrayContaining([
      { kind: "MOVEMENT_TYPE", token: "321" }, { kind: "MOVEMENT_TYPE", token: "343" }, { kind: "DOCUMENT_TYPE", token: "ZOR" }, { kind: "CONDITION_TYPE", token: "PR00" },
      { kind: "REASON_CODE", token: "R01" }, { kind: "ORG_CODE", token: "4100" }, { kind: "ORG_CODE", token: "4200" }, { kind: "ORG_CODE", token: "1000" }]));
    expect(found.filter(code => code.token === "4100")).toHaveLength(1);
  });
  it("ignores words that are not codes", () => {
    expect(extractSapCodes("The plant manager approves; document type and condition type are set up by the key user. Reason codes are listed.")).toEqual([]);
    expect(extractSapCodes("Use the plant Sheffield and the storage location for returns.")).toEqual([]);
  });
  it("matches a code as a whole token only", () => {
    expect(mentionsCode("Plant 4100 Sheffield", "4100")).toBe(true);
    expect(mentionsCode("Plant 41000 Sheffield", "4100")).toBe(false);
    expect(mentionsCode("document type zor", "ZOR")).toBe(true);
  });
});

describe("the generator's own vocabulary in client text", () => {
  it("flags outline, register call, step call, frozen outline, tool and field names and error codes, once per element and term", () => {
    const design = { steps: [{ id: "S-1", implementation: { detail: "Kind fixed by the outline. The outline says so; see the register call and the step call." } }],
      interfaces: [{ id: "IF-1", payload: "Uses referenceIds and UNKNOWN_SAP_OBJECT; submit_to_be_step." }], processName: "The frozen outline process" };
    const hits = internalTermHits(design);
    expect(hits).toEqual(expect.arrayContaining([
      { path: "draft.steps.0", term: "outline" }, { path: "draft.steps.0", term: "register call" }, { path: "draft.steps.0", term: "step call" },
      { path: "draft.interfaces.0", term: "referenceids" }, { path: "draft.interfaces.0", term: "unknown_sap_object" }, { path: "draft.interfaces.0", term: "submit_to_be_step" },
      { path: "draft.processName", term: "frozen outline" }]));
    expect(hits.filter(hit => hit.path === "draft.steps.0" && hit.term === "outline")).toHaveLength(1);
  });
  it("leaves real SAP and business words alone", () => {
    expect(internalTermHits({ steps: [{ id: "S-1", implementation: { detail: "Create an outline agreement (scheduling agreement) with the supplier; the frozen zone of the plan is five days; register the asset." } }] })).toEqual([]);
  });
});
