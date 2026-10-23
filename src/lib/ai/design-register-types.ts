/** Shared by the register checks. Types and two text helpers only, so the check modules do not import each other. */
export type Row = { id?: string; requirementIds?: string[]; contextFieldIds?: string[]; stepIds?: string[]; referenceIds?: string[];
  needsValidation?: boolean; validationReason?: string | null };
export type StepFacts = { id: string; actor: string; outputDocuments: readonly string[]; businessRuleIds: readonly string[];
  stepType?: string; phase?: string; interimProcess?: string | null };
export type RegisterContext = {
  requirements: ReadonlyMap<string, { critical: boolean; kind?: string }>; stepIds: ReadonlySet<string>;
  referenceIds: ReadonlySet<string>; companyContext: readonly { fieldId: string; value: string }[]; takenIds: ReadonlySet<string>;
  /** The design's steps, for the checks that compare a register with step content (version 3). */
  steps?: readonly StepFacts[];
};
export type Report = (code: string, path: string, detail?: string) => void;

export const norm = (value: string) => value.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
export const overlaps = (a: string, b: string) => !!a && !!b && (a.includes(b) || b.includes(a));
