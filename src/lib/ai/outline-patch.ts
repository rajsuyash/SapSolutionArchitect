import type { ValidationIssue } from "./problem-analysis";

/** Targeted repair of the To-Be outline. A model asked to re-answer the whole outline after one flagged field regresses fields that were
 * already valid, so when every remaining error points into one step, coverage row, open question or As-Is disposition (or names a
 * missing As-Is mapping or coverage row), the model is asked for a patch holding only replacements for those items and the server
 * merges it onto the last outline by id or key. A global error (unparseable, a missing top-level list, a cut-off answer) still
 * takes the full re-answer. Pure functions over plain data: no model text is created or interpreted here. */
type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** Sections a patch can carry and the key that identifies an item in each. */
export const PATCH_KEYS = { steps: "id", coverage: "requirementId", openQuestions: "id", eliminatedAsIsSteps: "asIsStepId" } as const;
export type PatchSection = keyof typeof PATCH_KEYS;
export type OutlinePatch = Partial<Record<PatchSection, Obj[]>>;

/** Error paths (outline-relative) that a patch can fix, with the section whose item the first capture indexes. */
const OWN = /^outline\.(steps|coverage|openQuestions|eliminatedAsIsSteps)\.(\d+)(?:\.|$)/;
/** The validator names a missing As-Is mapping or a requirement without a coverage row by its input position. */
const INPUT = /^input\.(asIsSteps|requirements)\.(\d+)$/;

export type Located = { section: PatchSection | "asIsSteps" | "requirements"; index: number };
export const locate = (path: string): Located | undefined => {
  const match = OWN.exec(path) ?? INPUT.exec(path);
  return match ? { section: match[1] as Located["section"], index: Number(match[2]) } : undefined;
};

/** True when there is at least one error, none is a cut-off answer, and every one points at an item that exists in `base`. */
export function isPatchable(errors: readonly ValidationIssue[], base: unknown): boolean {
  if (!errors.length || !isObj(base) || !Array.isArray(base.steps) || !Array.isArray(base.coverage)) return false;
  return errors.every(error => {
    if (error.code === "OUTPUT_TRUNCATED") return false;
    const at = locate(error.path);
    if (!at) return false;
    if (at.section === "asIsSteps" || at.section === "requirements") return true;
    const items = base[at.section];
    return Array.isArray(items) && at.index < items.length;
  });
}

/** Merge a patch onto the outline: an item with a matching id or key is replaced in place, any other is appended. Sections the patch
 * does not name are returned as they were. The base is never mutated. */
export function applyOutlinePatch(base: unknown, patch: OutlinePatch): unknown {
  if (!isObj(base)) return base;
  const merged: Obj = { ...base };
  for (const [section, key] of Object.entries(PATCH_KEYS) as [PatchSection, string][]) {
    const items = patch[section];
    if (!items) continue;
    const list: unknown[] = Array.isArray(base[section]) ? [...base[section] as unknown[]] : [];
    for (const item of items) {
      const at = list.findIndex(existing => isObj(existing) && existing[key] === item[key]);
      if (at < 0) list.push(item); else list[at] = item;
    }
    merged[section] = list;
  }
  return merged;
}

/** The implementation kinds the SAP fit rules accept for a step that cites references of these fit types (the mirror of the checks in
 * evaluateDesign): STANDARD only over STANDARD, CONFIGURATION over STANDARD or CONFIGURATION, EXTENSION or INTEGRATION when a
 * cited reference has that fit type. MANUAL and NEEDS_VALIDATION never contradict a citation. */
export function allowedKinds(citedFitTypes: readonly string[]): string[] {
  const only = (...types: string[]) => citedFitTypes.length > 0 && citedFitTypes.every(type => types.includes(type));
  return [
    ...(only("STANDARD") ? ["STANDARD"] : []),
    ...(only("STANDARD", "CONFIGURATION") ? ["CONFIGURATION"] : []),
    ...(citedFitTypes.includes("EXTENSION") ? ["EXTENSION"] : []),
    ...(citedFitTypes.includes("INTEGRATION") ? ["INTEGRATION"] : []),
    "MANUAL", "NEEDS_VALIDATION",
  ];
}
