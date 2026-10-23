import { describe, expect, it } from "vitest";
import { evaluateDesign, type DetailedDesign } from "../src/lib/ai/design-quality";
import { junkHits, languageHits, truncationHits } from "../src/lib/ai/design-text-quality";
import { rentalContext } from "../fixtures/ai/to-be/rental-benchmark";
import { rentalDraftV3 } from "../fixtures/ai/to-be/rental-registers";

const design = (change: (draft: DetailedDesign) => void) => { const draft = structuredClone(rentalDraftV3); change(draft); return draft; };
const step = (field: string, value: string) => ({ steps: [{ id: "S-1", [field]: value }] });
const LONG = "The billing run collects every hire order whose rental period has ended and posts one invoice per customer with the agreed daily rate";

describe("placeholder text", () => {
  it("flags a field that is only a placeholder word, whatever its case or punctuation, and names the element and field", () => {
    for (const value of ["Ignore", "placeholder", "Placeholder.", "TBD", "n/a", "N/A", "?", "-", "TODO", "XXX", "tbd tbd", "[placeholder]", "lorem ipsum dolor sit amet"]) {
      expect(junkHits({ steps: [{ id: "S-1", outputDocuments: [value] }] }), value).toEqual([{ path: "draft.steps.0", detail: "placeholder text in field outputDocuments" }]);
    }
  });
  it("flags an id written with a question mark where its number goes, and a bracketed gap marker", () => {
    expect(junkHits(step("addedValue", "The open question ETO-OQ-? covers the release."))).toEqual([{ path: "draft.steps.0", detail: "placeholder in text in field addedValue" }]);
    expect(junkHits(step("addedValue", "Owner is [TBD] until the review."))).toHaveLength(1);
    expect(junkHits(step("addedValue", "Lorem ipsum dolor sit amet, consectetur."))).toHaveLength(1);
  });
  it("leaves real statements alone: None with a reason, a sentence that mentions the word, a question, an id with a number", () => {
    for (const value of ["None: the step moves no stock.", "No inventory effect.", "Not applicable: no goods are issued.", "The placeholder customer is replaced at order entry.",
      "Ignore the warning only when the budget is released.", "Which system masters the part record?", "See ETO-OQ-4 and ETO-1-1-BR-2.", "5%", "Tbd Consulting Ltd supplies the part"]) {
      expect(junkHits(step("addedValue", value)), value).toEqual([]);
    }
  });
  it("skips id fields and reports one hit per element and field", () => {
    expect(junkHits({ steps: [{ id: "TBD", requirementIds: ["TBD"] }] })).toEqual([]);
    expect(junkHits({ steps: [{ id: "S-1", outputDocuments: ["Ignore", "ignore"] }] })).toHaveLength(1);
  });
});

describe("text cut off", () => {
  it("flags long text that ends in an ellipsis, with either dots or the ellipsis character", () => {
    expect(truncationHits(step("addedValue", `${LONG} and the open question covers the...`))).toEqual([{ path: "draft.steps.0", detail: "ends with an ellipsis in field addedValue" }]);
    expect(truncationHits(step("addedValue", `${LONG} and the open question covers the…`))).toHaveLength(1);
  });
  it("flags long text that ends on an article, a conjunction or a joining word", () => {
    for (const ending of ["and", "or", "the", "of", "with", "that", "which", "its"]) {
      expect(truncationHits(step("addedValue", `${LONG} ${ending}`)), ending).toEqual([{ path: "draft.steps.0", detail: "ends on a joining word in field addedValue" }]);
    }
  });
  it("flags a sentence field with no closing punctuation, but not a clause field or a name", () => {
    expect(truncationHits(step("detail", `${LONG} per customer`))).toEqual([{ path: "draft.steps.0", detail: "ends without closing punctuation in field detail" }]);
    expect(truncationHits({ steps: [{ id: "S-1", effects: { accountingEntry: `${LONG} on the settlement` } }] })).toHaveLength(1);
    expect(truncationHits(step("condition", `${LONG} per customer`))).toEqual([]);
    expect(truncationHits(step("title", `${LONG} per customer`))).toEqual([]);
  });
  it("leaves complete text alone: a full stop, a closing bracket, a quote, short text, and endings that can end a clause", () => {
    for (const value of [`${LONG}.`, `${LONG} (see the budget).`, `${LONG} per "Release".`, `${LONG} on the WBS element A`, `${LONG}, as the order was built from`, `${LONG}, as the order was built to`]) {
      expect(truncationHits(step("detail", value)).filter(hit => !hit.detail.startsWith("ends without")), value).toEqual([]);
    }
    expect(truncationHits(step("detail", "Short note and"))).toEqual([]);
    expect(truncationHits(step("detail", `${LONG}.`))).toEqual([]);
  });
});

describe("another language", () => {
  it("flags a German clause inside an English sentence", () => {
    const text = "Liegt eine geänderte Betriebsmittelzuordnung nicht vor; routing change to a released order is held as a revision decision";
    expect(languageHits(step("event", text))).toEqual([{ path: "draft.steps.0", detail: "German text in field event" }]);
  });
  it("flags French and Spanish clauses", () => {
    expect(languageHits(step("event", "La commande est livrée avec les documents pour le client"))).toEqual([{ path: "draft.steps.0", detail: "French text in field event" }]);
    expect(languageHits(step("event", "El pedido se envía con los documentos para el cliente"))).toEqual([{ path: "draft.steps.0", detail: "Spanish text in field event" }]);
  });
  it("leaves English alone, including SAP terms in German and short quotes", () => {
    for (const value of ["Create the production order with the routing and release it for the shop floor.",
      "The Materialstamm (material master) holds the Werk, Lagerort and Bestellung data used by the plant.",
      "Use the field Betriebsmittelzuordnung to assign the production resource and tool.",
      "Die Bestellung (purchase order) is created from the requisition and sent to the supplier.",
      "The vendor Müller GmbH delivers the part before the date in the contract."]) {
      expect(languageHits(step("event", value)), value).toEqual([]);
    }
  });
});

describe("in the design evaluation", () => {
  const codes = (draft: DetailedDesign) => { const result = evaluateDesign(rentalContext, draft); return { errors: result.errors, blockers: result.blockers.map(item => item.code) }; };
  it("the fixture has none of the three", () => {
    expect(junkHits(rentalDraftV3).concat(truncationHits(rentalDraftV3), languageHits(rentalDraftV3))).toEqual([]);
  });
  it("placeholder text is a structural error on the step that holds it, so that step is repaired", () => {
    const result = codes(design(draft => { draft.steps[1]!.outputDocuments = ["Placeholder"]; }));
    expect(result.errors).toEqual([{ code: "PLACEHOLDER_TEXT", path: "draft.steps.1", detail: "placeholder text in field outputDocuments" }]);
  });
  it("placeholder text in a register row is an error at the row (the group is repaired)", () => {
    const result = codes(design(draft => { draft.reports![0]!.purpose = "TBD"; }));
    expect(result.errors).toEqual([{ code: "PLACEHOLDER_TEXT", path: "draft.reports.0", detail: "placeholder text in field purpose" }]);
  });
  it("cut-off text and a foreign fragment are blockers, not errors: the design stays valid and the fix pass sends the part back", () => {
    const cut = codes(design(draft => { draft.steps[0]!.effects.financial = `${LONG} and the open question covers the...`; }));
    expect(cut.errors).toEqual([]);
    expect(cut.blockers).toContain("TRUNCATED_TEXT");
    const german = codes(design(draft => { draft.steps[0]!.effects.financial = "Liegt eine geänderte Zuordnung nicht vor; the hire order stays open"; }));
    expect(german.errors).toEqual([]);
    expect(german.blockers).toContain("LANGUAGE_FRAGMENT");
  });
});
