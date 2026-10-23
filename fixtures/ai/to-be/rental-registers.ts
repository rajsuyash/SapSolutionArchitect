// Fictional registers for the hand-authored rental benchmark. Valid against rentalContext with no company context and an
// empty catalog: every SAP claim is therefore marked needsValidation. Not model output.
import type { DetailedDesign } from "../../../src/lib/ai/design-quality";
import type { RegisterPayloads } from "../../../src/lib/ai/design-registers";
import { rentalDraft } from "./rental-benchmark";

const validation = { referenceIds: [], needsValidation: true, validationReason: "No catalog entry covers this; a consultant must confirm the realization for the target release." };
const gap = (requirementId: string, classification: "KEY_USER_EXTENSION" | "CLASSIC_RICEFW" | "CONFIGURATION", stepIds: string[], ricefwType: "ENHANCEMENT" | null = null) =>
  ({ requirementId, classification, ricefwType, justification: `Proposed ${classification.toLowerCase().replace(/_/g, " ")} for ${requirementId}; the cleaner option above it is not evidenced.`, stepIds, ...validation });

export const rentalRegisterGroups: RegisterPayloads = {
  decisions: { keyDesignDecisions: [{
    id: "KDD-1", topic: "How a quotation quantity becomes separately tracked hire items",
    options: [
      { name: "Split into quantity-one items at order creation", pros: "Each asset is dispatched, returned and billed on its own.", cons: "More item rows to maintain.", fitType: "EXTENSION" },
      { name: "Keep one item and track assets in a side list", pros: "Fewer rows.", cons: "Billing cannot stop per asset.", fitType: "MANUAL" },
    ],
    recommendation: "Split into quantity-one items at order creation", rationale: "Requirements R-1 and R-3 need per-asset dates and per-asset charge stops.",
    impactedStepIds: ["TB-1", "TB-2"], requirementIds: ["R-1", "R-3"], contextFieldIds: [], owner: "Rental operations lead", status: "PROPOSED" }] },
  fitgap: { fitGap: [gap("R-1", "KEY_USER_EXTENSION", ["TB-1"]), gap("R-2", "KEY_USER_EXTENSION", ["TB-1"]), gap("R-3", "KEY_USER_EXTENSION", ["TB-2"]),
    gap("R-4", "CONFIGURATION", ["TB-2"]), gap("R-5", "CLASSIC_RICEFW", ["TB-3"], "ENHANCEMENT"), gap("R-6", "CONFIGURATION", ["TB-3"])] },
  foundation: {
    orgStructure: [{ id: "ORG-1", unitType: "Company code", proposal: "One company code for the hire business, to be confirmed.", openPoint: "Legal entities were not provided in discovery.",
      requirementIds: [], contextFieldIds: [], stepIds: ["TB-1"] }],
    masterDataPrerequisites: [{ id: "MD-1", object: "Rental asset", owner: "Rental master-data steward", keyFields: ["unique asset identifier", "availability status"],
      migrationSource: "To be confirmed by the business", requirementIds: [], contextFieldIds: [], stepIds: ["TB-1", "TB-2"] }],
    dataMigration: [{ id: "MIG-1", object: "Rental assets", source: "To be confirmed", approach: "Load, cleanse and reconcile before open orders.", sequence: 1, risk: "Duplicate asset identifiers.",
      requirementIds: [], contextFieldIds: [], stepIds: ["TB-1"] }],
    cutover: [{ id: "CUT-1", activity: "Freeze new hire orders, load assets, reconcile, release.", sequence: 1, owner: "Project lead", risk: "Orders created during the freeze.",
      requirementIds: [], contextFieldIds: [], stepIds: ["TB-1"] }],
  },
  integration: { interfaces: [], kpis: [] },
};

export const rentalRegisters = Object.assign({}, ...Object.values(rentalRegisterGroups)) as Pick<DetailedDesign,
  "keyDesignDecisions" | "fitGap" | "orgStructure" | "masterDataPrerequisites" | "dataMigration" | "cutover" | "interfaces" | "kpis">;
/** The schemaVersion 2 design the pipeline assembles from rentalDraft plus rentalRegisterGroups. */
export const rentalDraftV2: DetailedDesign = { ...rentalDraft, schemaVersion: 2, ...rentalRegisters };
