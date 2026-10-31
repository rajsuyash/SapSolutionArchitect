import type { ValidationIssue } from "./problem-analysis";

/** Deterministic repair of the id links in a step body or a register group answer, applied to the raw tool payload before it is parsed.
 * Same principle as outline-repair.ts: an id that is not in the server-owned input or the frozen outline is an invention, so the link is
 * dropped, never renamed or replaced, and a row that existed only to carry that id is dropped whole. Nothing is added. Every repair is a
 * warning (code, path, no model text). Rows whose ids are all valid are never touched. */
type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;

/** A decision id outside the supplied register (with no register every id is outside) is dropped from a step body's decisionIds. */
export function repairStepBody(raw: unknown, registerIds: ReadonlySet<string>, path: string): { value: unknown; warnings: ValidationIssue[] } {
  const cited = isObj(raw) ? strings(raw.decisionIds) : undefined;
  if (!isObj(raw) || !cited) return { value: raw, warnings: [] };
  const kept = cited.filter(ref => registerIds.has(ref));
  return kept.length === cited.length ? { value: raw, warnings: [] }
    : { value: { ...raw, decisionIds: kept }, warnings: [{ code: "REPAIRED_UNKNOWN_DECISION", path }] };
}

export type RegisterRefs = {
  /** Input requirement ids; empty = nothing to compare against, so requirement links are left alone. */
  requirementIds: ReadonlySet<string>;
  /** Step ids of the frozen outline. */
  stepIds: ReadonlySet<string>;
  decisionIds: ReadonlySet<string>;
};

type RefKind = "requirement" | "step" | "role" | "decision";
/** List fields of register rows that cite ids, with the minimum length the row schema demands. Unknown ids are dropped from the list
 * unless that would leave fewer than the minimum: then the row is left for the model to fix, never silently dropped (a segregation-of-duties
 * assessment or a role is not discarded because one id was wrong). */
const LISTS: Record<string, { field: string; kind: RefKind; min: number }[]> = {
  keyDesignDecisions: [{ field: "requirementIds", kind: "requirement", min: 0 }, { field: "impactedStepIds", kind: "step", min: 1 }],
  fitGap: [{ field: "stepIds", kind: "step", min: 0 }],
  roles: [{ field: "stepIds", kind: "step", min: 1 }],
  sodAssessments: [{ field: "roleIds", kind: "role", min: 1 }, { field: "stepIds", kind: "step", min: 1 }],
  controlMappings: [{ field: "stepIds", kind: "step", min: 1 }],
  endToEndTests: [{ field: "stepIds", kind: "step", min: 2 }, { field: "requirementIds", kind: "requirement", min: 1 }],
};
/** Every other register row cites requirements and steps through the shared trace fields. */
const TRACE: { field: string; kind: RefKind; min: number }[] = [{ field: "requirementIds", kind: "requirement", min: 0 }, { field: "stepIds", kind: "step", min: 0 }];
/** Singular requirement link: a row that is about that one requirement is dropped when it is not an input requirement. */
const SOLE_REQUIREMENT = new Set(["fitGap", "controlMappings"]);

export function repairRegisterGroup(raw: unknown, refs: RegisterRefs): { value: unknown; warnings: ValidationIssue[] } {
  if (!isObj(raw)) return { value: raw, warnings: [] };
  const warnings: ValidationIssue[] = [];
  const warn = (code: string, path: string) => { warnings.push({ code, path }); };
  // Roles are repaired first, so an assessment cites only the roles that survive.
  const keys = Object.keys(raw).sort((a, b) => Number(b === "roles") - Number(a === "roles"));
  const roleIds = new Set<string>();
  const out: Obj = { ...raw };
  for (const key of keys) {
    const rows = raw[key];
    if (!Array.isArray(rows) || !rows.every(isObj)) continue;
    const specs = LISTS[key] ?? TRACE;
    const valid = (kind: RefKind, ref: string) => kind === "requirement" ? refs.requirementIds.size === 0 || refs.requirementIds.has(ref)
      : kind === "step" ? refs.stepIds.has(ref) : kind === "role" ? roleIds.has(ref) : refs.decisionIds.has(ref);
    const kept: Obj[] = [];
    rows.forEach((row, i) => {
      const path = `draft.${key}.${i}`;
      if (SOLE_REQUIREMENT.has(key) && typeof row.requirementId === "string" && !valid("requirement", row.requirementId)) { warn("REPAIRED_DROPPED_ROW", path); return; }
      let next: Obj = row, trimmed = false;
      for (const { field, kind, min } of [...specs, { field: "decisionIds", kind: "decision" as const, min: 0 }]) {
        const cited = strings(next[field]);
        if (!cited) continue;
        const ok = cited.filter(ref => valid(kind, ref));
        // A list that would fall below what the row schema demands is left as is: the model gets the UNKNOWN_* error and fixes it.
        if (ok.length === cited.length || ok.length < min) continue;
        trimmed = true;
        next = { ...next, [field]: ok };
      }
      if (trimmed) warn("REPAIRED_UNKNOWN_REF", path);
      kept.push(next);
    });
    if (key === "roles") for (const row of kept) if (typeof row.id === "string") roleIds.add(row.id);
    out[key] = kept;
  }
  return warnings.length ? { value: out, warnings } : { value: raw, warnings };
}
