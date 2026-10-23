// Fictional registers for the hand-authored rental benchmark. Valid against rentalContext with no company context and an
// empty catalog: every SAP claim is therefore marked needsValidation. Not model output.
import type { DetailedDesign } from "../../../src/lib/ai/design-quality";
import type { RegisterPayloads } from "../../../src/lib/ai/design-registers";
import { rentalDraft } from "./rental-benchmark";

const validation = { referenceIds: [], needsValidation: true, validationReason: "No catalog entry covers this; a consultant must confirm the realization for the target release." };
const gap = (requirementId: string, classification: "KEY_USER_EXTENSION" | "CLASSIC_RICEFW" | "CONFIGURATION", stepIds: string[], ricefwType: "ENHANCEMENT" | null = null) =>
  ({ requirementId, classification, ricefwType, justification: `Proposed ${classification.toLowerCase().replace(/_/g, " ")} for ${requirementId}; the cleaner option above it is not evidenced.`, stepIds, ...validation });
const mitigation = { KEY_USER_EXTENSION: "EXTEND_KEY_USER", CLASSIC_RICEFW: "DEVELOP_CUSTOM", CONFIGURATION: "CONFIGURE" } as const;
const v3gap = (...args: Parameters<typeof gap>) => ({ ...gap(...args), mitigationType: mitigation[args[1]], owner: "Solution architect", status: "OPEN" as const });

/** The first eight registers as a schemaVersion 2 design carried them, before version 3 added owner, channel and failure-handling fields. */
export const rentalLegacyRegisters = {
  keyDesignDecisions: [{
    id: "KDD-1", topic: "How a quotation quantity becomes separately tracked hire items",
    options: [
      { name: "Split into quantity-one items at order creation", pros: "Each asset is dispatched, returned and billed on its own.", cons: "More item rows to maintain.", fitType: "EXTENSION" as const },
      { name: "Keep one item and track assets in a side list", pros: "Fewer rows.", cons: "Billing cannot stop per asset.", fitType: "MANUAL" as const },
    ],
    recommendation: "Split into quantity-one items at order creation", rationale: "Requirements R-1 and R-3 need per-asset dates and per-asset charge stops.",
    impactedStepIds: ["TB-1", "TB-2"], requirementIds: ["R-1", "R-3"], contextFieldIds: [], owner: "Rental operations lead", status: "PROPOSED" as const }],
  fitGap: [gap("R-1", "KEY_USER_EXTENSION", ["TB-1"]), gap("R-2", "KEY_USER_EXTENSION", ["TB-1"]), gap("R-3", "KEY_USER_EXTENSION", ["TB-2"]),
    gap("R-4", "CONFIGURATION", ["TB-2"]), gap("R-5", "CLASSIC_RICEFW", ["TB-3"], "ENHANCEMENT"), gap("R-6", "CONFIGURATION", ["TB-3"])],
  orgStructure: [{ id: "ORG-1", unitType: "Company code", proposal: "One company code for the hire business, to be confirmed.", openPoint: "Legal entities were not provided in discovery.",
    requirementIds: [], contextFieldIds: [], stepIds: ["TB-1"] }],
  masterDataPrerequisites: [{ id: "MD-1", object: "Rental asset", owner: "Rental master-data steward", keyFields: ["unique asset identifier", "availability status"],
    migrationSource: "To be confirmed by the business", requirementIds: [], contextFieldIds: [], stepIds: ["TB-1", "TB-2"] }],
  dataMigration: [{ id: "MIG-1", object: "Rental assets", source: "To be confirmed", approach: "Load, cleanse and reconcile before open orders.", sequence: 1, risk: "Duplicate asset identifiers.",
    requirementIds: [], contextFieldIds: [], stepIds: ["TB-1"] }],
  cutover: [{ id: "CUT-1", activity: "Freeze new hire orders, load assets, reconcile, release.", sequence: 1, owner: "Project lead", risk: "Orders created during the freeze.",
    requirementIds: [], contextFieldIds: [], stepIds: ["TB-1"] }],
  interfaces: [], kpis: [],
};

export const rentalRegisterGroups: RegisterPayloads = {
  decisions: { keyDesignDecisions: rentalLegacyRegisters.keyDesignDecisions },
  fitgap: { fitGap: [v3gap("R-1", "KEY_USER_EXTENSION", ["TB-1"]), v3gap("R-2", "KEY_USER_EXTENSION", ["TB-1"]), v3gap("R-3", "KEY_USER_EXTENSION", ["TB-2"]),
    v3gap("R-4", "CONFIGURATION", ["TB-2"]), v3gap("R-5", "CLASSIC_RICEFW", ["TB-3"], "ENHANCEMENT"), v3gap("R-6", "CONFIGURATION", ["TB-3"])] },
  foundation: {
    masterDataPrerequisites: [{ ...rentalLegacyRegisters.masterDataPrerequisites[0]!, creationChannel: "Created by the master-data steward in the asset register app, or loaded at cutover.",
      governance: "The steward approves every new asset; a duplicate asset identifier is rejected on save." }],
    dataMigration: rentalLegacyRegisters.dataMigration, cutover: rentalLegacyRegisters.cutover,
  },
  integration: { interfaces: [], kpis: [] },
  scope: {
    objectives: [
      { id: "OBJ-1", statement: "Track every hire unit as its own item from order to return.", measure: "not provided", requirementIds: ["R-1", "R-2", "R-3"], contextFieldIds: [], stepIds: ["TB-1", "TB-2"] },
      { id: "OBJ-2", statement: "Bill recurring hire and the one-time installation charge separately.", measure: "not provided", requirementIds: ["R-5", "R-6"], contextFieldIds: [], stepIds: ["TB-3"] },
    ],
    scopeStatements: [
      { id: "SCP-1", kind: "IN_SCOPE", statement: "Hire order creation, partial returns and monthly hire billing.", reason: "These are the three current steps discovery described.", requirementIds: ["R-1"], contextFieldIds: [], stepIds: [] },
      { id: "SCP-2", kind: "OUT_OF_SCOPE", statement: "Maintenance and repair of hired assets.", reason: "Discovery did not describe it; the business must confirm.", requirementIds: [], contextFieldIds: [], stepIds: [] },
    ],
    orgStructure: [{ ...rentalLegacyRegisters.orgStructure[0]!, parentId: null }],
  },
  reporting: {
    reports: [{ id: "REP-1", name: "Open hire items by return date", purpose: "Show which items are still on hire and when each is due back.",
      realization: "A list over hire items filtered by status and planned end date.", ...validation, requirementIds: ["R-2", "R-3"], contextFieldIds: [], stepIds: ["TB-1", "TB-2"] }],
    endToEndTests: [{ id: "E2E-1", valueStream: "Hire from order to billing", given: "A quotation for four units is accepted", when: "Three units return on different dates and the month is billed",
      then: "Four items exist, each return stops charges for its own item only, and installation is billed once.", stepIds: ["TB-1", "TB-2", "TB-3"], requirementIds: ["R-1", "R-3", "R-5"] }],
  },
  documents: {
    documentStatusModels: [{ id: "DSM-1", documentType: "Hire order", statuses: ["Open", "Partly returned", "Fully returned"],
      transitions: [{ from: null, to: "Open", stepId: "TB-1", event: "Items created from the accepted quotation" },
        { from: "Open", to: "Partly returned", stepId: "TB-2", event: "First item returned while others stay on hire" },
        { from: "Partly returned", to: "Fully returned", stepId: "TB-2", event: "Last item returned" }],
      editLockRules: [{ afterEvent: "An item is returned", locked: "The start date and the asset of that item", stillEditable: "The dates of the other items" }], requirementIds: ["R-3"] }],
    configurationCatalogue: [{ id: "CFG-1", category: "DOCUMENT_TYPE", name: "Hire order", purpose: "Carries the individually tracked hire items.", status: "BUSINESS_TO_PROVIDE",
      owner: "Rental operations lead", referenceIds: [], note: "The business names the document type and its number range.", stepIds: ["TB-1"] }],
  },
  governance: {
    roles: [{ id: "ROLE-1", name: "Rental coordinator", responsibilities: "Creates hire items and assigns assets.", stepIds: ["TB-1"] },
      { id: "ROLE-2", name: "Rental stores clerk", responsibilities: "Records returns.", stepIds: ["TB-2"] },
      { id: "ROLE-3", name: "Billing clerk", responsibilities: "Reviews and releases hire billing.", stepIds: ["TB-3"] }],
    sodAssessments: [{ id: "SOD-1", assessment: "NO_CONFLICT_ASSESSED", description: "No role both records a return and releases the billing that depends on it.",
      roleIds: ["ROLE-2", "ROLE-3"], stepIds: ["TB-2", "TB-3"], mitigation: "None needed; a role review at go-live confirms it." }],
    controlMappings: [],
  },
};

export const rentalRegisters = Object.assign({}, ...Object.values(rentalRegisterGroups)) as Pick<DetailedDesign, keyof typeof rentalLegacyRegisters
  | "objectives" | "scopeStatements" | "documentStatusModels" | "configurationCatalogue" | "roles" | "sodAssessments" | "controlMappings" | "reports" | "endToEndTests">;
/** The schemaVersion 2 design as it was stored before version 3: still readable and valid. */
export const rentalDraftV2: DetailedDesign = { ...rentalDraft, schemaVersion: 2, ...rentalLegacyRegisters };
/** The schemaVersion 3 design the pipeline assembles from rentalDraft plus rentalRegisterGroups. */
export const rentalDraftV3: DetailedDesign = { ...rentalDraft, schemaVersion: 3, ...rentalRegisters };
