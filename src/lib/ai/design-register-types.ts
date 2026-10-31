/** Shared by the register checks. Types and two text helpers only, so the check modules do not import each other. */
export type Row = { id?: string; requirementIds?: string[]; contextFieldIds?: string[]; stepIds?: string[]; referenceIds?: string[];
  needsValidation?: boolean; validationReason?: string | null };
export type StepFacts = { id: string; actor: string; /** Every text field of the step (ids skipped), for the checks that read what a step says. */ texts?: readonly string[]; outputDocuments: readonly string[]; businessRuleIds: readonly string[];
  stepType?: string; phase?: string; interimProcess?: string | null;
  /** Owners named inside the step (exception and master-data owners), for the check that every owner is a catalogued role. */
  owners?: readonly string[];
  /** Each business rule as one text (condition and response), for the check that a variant references a shared rule instead of restating it. */
  ruleTexts?: readonly { id: string; text: string }[];
  /** How the step is realised, for the check that a named build reaches the RICEFW list. */
  implementation?: { kind: string; detail: string } };
export type RegisterContext = {
  requirements: ReadonlyMap<string, { critical: boolean; kind?: string }>; stepIds: ReadonlySet<string>;
  referenceIds: ReadonlySet<string>; companyContext: readonly { fieldId: string; value: string }[]; takenIds: ReadonlySet<string>;
  /** The design's steps, for the checks that compare a register with step content (version 3). */
  steps?: readonly StepFacts[];
  /** What each catalog reference evidences (its capability and object names), for the check that a row confirmed in the catalog is backed by what it cites. */
  referenceTexts?: ReadonlyMap<string, string>;
};
export type Report = (code: string, path: string, detail?: string) => void;

export const norm = (value: string) => value.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
export const overlaps = (a: string, b: string) => !!a && !!b && (a.includes(b) || b.includes(a));

const WEAK_WORDS = new Set(["type", "types", "code", "codes", "document", "documents", "number", "numbers", "range", "ranges", "reason", "status", "configuration", "standard", "default", "other", "with", "from", "that", "this", "per"]);
/** The content words of a text reduced to their first five letters (so "orders" meets "order"); generic words of SAP configuration are dropped. */
export const stems = (value: string) => new Set(norm(value).split(/[^a-z0-9]+/).filter(word => word.length >= 4 && !WEAK_WORDS.has(word)).map(word => word.slice(0, 5)));
/** True when `text` mentions at least one content word of `subject`. A subject with no content words proves nothing and reports `whenEmpty`. */
export const mentionsSubject = (subject: string, text: string, whenEmpty: boolean) => {
  const wanted = stems(subject);
  if (!wanted.size) return whenEmpty;
  const have = stems(text);
  return [...wanted].some(stem => have.has(stem));
};
