import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import strongControl from "../fixtures/eval/controls/pump-o2c.strong.json";
import pharma from "../fixtures/eval/pharma-p2p.json";
import pump from "../fixtures/eval/pump-o2c.json";
import services from "../fixtures/eval/services-r2r.json";
import engineering from "../fixtures/eval/engineering-mto.json";
import { loadSapReferences } from "../src/lib/ai/sap-references";
import { lintSapObjects } from "../src/lib/ai/sap-object-lint";

const catalog = [
  { id: "S4-2023-SD-QUOTE", capability: "Sales quotation", objects: ["VA21/VA22/VA23", "Manage Sales Quotations", "Create Billing Documents (VF04 / F0798-class apps)"] },
  { id: "S4-2023-INV", capability: "Stock", objects: ["Movement types 349/350", "Customer returns delivery (movement types 651-657)", "Return delivery (MIGO, movement 122/161/124)"],
    limitations: ["Scope items 1JW, BDN, BD3 (as listed on the page)", "BAdI SD_SLS_CHECK_HEAD", "Sales Order (A2X) API: API_SALES_ORDER_SRV"] },
];
const lint = (value: unknown) => lintSapObjects({ x: value }, catalog).map(hit => `${hit.kind}:${hit.token}`);

describe("SAP-object linter: positives", () => {
  it.each([
    ["Open Fiori app F9999 to approve", "FIORI_APP:F9999"],
    ["Post it in VA99 afterwards", "TRANSACTION:VA99"],
    ["Use ME21N or ME99N", "TRANSACTION:ME99N"],
    ["Run transaction MIXY and then report", "TRANSACTION:MIXY"],
    ["The transaction codes ZQ01 and ZQ02 apply", "TRANSACTION:ZQ01"],
    ["Post with movement type 999 on receipt", "MOVEMENT_TYPE:999"],
    ["Movement types 101, 102 and 350", "MOVEMENT_TYPE:101"],
    ["Configure scope item J45 for this", "SCOPE_ITEM:J45"],
    ["Call BAPI_SALESORDER_CREATEFROMDAT2 afterwards", "API:BAPI_SALESORDER_CREATEFROMDAT2"],
    ["Expose API_PURCHASEORDER_PROCESS_SRV to the portal", "API:API_PURCHASEORDER_PROCESS_SRV"],
    ["Implement BAdI MB_DOCUMENT_BADI for this", "BADI:MB_DOCUMENT_BADI"],
  ])("flags %s", (value, expected) => expect(lint(value)).toContain(expected));

  it("reports the exact path and the token, once per field, and nothing else", () => {
    const hits = lintSapObjects({ steps: [{ id: "F1234", implementation: { detail: "See F9999, then F9999 again and VA99." } }] }, catalog);
    expect(hits).toEqual([{ path: "draft.steps.0.implementation.detail", kind: "FIORI_APP", token: "F9999" },
      { path: "draft.steps.0.implementation.detail", kind: "TRANSACTION", token: "VA99" }]);
  });
  it("ignores id-like keys, which carry design ids, not prose", () => {
    expect(lintSapObjects({ steps: [{ id: "F9999", referenceIds: ["F9999"], requirementId: "VA99" }] }, catalog)).toEqual([]);
  });
});

describe("SAP-object linter: negatives", () => {
  it.each([
    "VA21, VA22 and VA23 are quotation transactions", "Billing via F0798 apps", "Return with movement 122 and 161", "Movement types 651 to 657 apply",
    "A movement type 652 is inside the catalog range", "Scope item BD3 is listed", "Use Sales Order API_SALES_ORDER_SRV", "Check BAdI SD_SLS_CHECK_HEAD",
    "Run MIGO for the goods receipt (transaction MIGO)",
  ])("accepts catalog objects: %s", value => expect(lint(value)).toEqual([]));

  it.each([
    "Fiscal year FY24 and quarter Q324 close on 2023-12-31", "The FPS02 feature pack and the F2 billing type", "Form F12 is not an app id",
    "transaction VAT amounts are reported monthly", "The transaction SAP posts is an internal one", "We hold 3 movement meetings and a movement of 2023 units",
    "Scope items are agreed with the business; scope item list to follow", "Contact REF-1024 and ticket AB-12 about step 3", "ISO27001 and ISO9001 certificates",
    "Phase P2 needs M5 sign-off, plus A3 approval", "Iterate over 100-200 rows of a spreadsheet", "Upgrade to release 2023 FPS01 in Q4",
  ])("does not flag ordinary text: %s", value => expect(lint(value)).toEqual([]));
});

describe("SAP-object linter: real material", () => {
  it("reports zero hits on the hand-written strong control against the real 2023 catalog (the control names no SAP identifiers)", async () => {
    const references = await loadSapReferences("S4HANA_CLOUD_PRIVATE", "2023", { baseDir: fileURLToPath(new URL("../fixtures/sap", import.meta.url)) });
    expect(references.length).toBeGreaterThan(50);
    expect(lintSapObjects(strongControl.design, references)).toEqual([]);
    // The instrument is live: with an empty catalog a design that names objects is flagged.
    expect(lintSapObjects({ detail: "Post in VA01 with movement type 101" }, [])).toHaveLength(2);
  });
  it("does not flag ordinary prose in the four eval cases, except the one genuine tcode-like token it should", () => {
    const hits = [pump, pharma, services, engineering].flatMap(fixture => lintSapObjects(fixture, []).map(hit => `${hit.kind}:${hit.token}`));
    expect(hits).toEqual(["FIORI_APP:F110"]);
  });
});
