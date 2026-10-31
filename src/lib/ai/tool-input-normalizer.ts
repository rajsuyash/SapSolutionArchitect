import { z } from "zod";
import { id } from "./design-primitives";
import type { ValidationIssue } from "./problem-analysis";

/** Deterministic pre-parse repair of tool inputs from providers that mishandle nested schema fields. Four slips only, all
 * mechanical and lossless: (1) a field the schema types as an array or object arrives as a JSON-encoded string that parses
 * to exactly that type; (2) an id array arrives as one bare id string that matches the id pattern (wrapped in an array); (3) the whole payload arrives under one invented wrapper key (REPAIRED_WRAPPED_PAYLOAD); (4) an enum value in a different case or spelling, or a listed synonym (REPAIRED_ENUM_SYNONYM).
 * Nothing is ever invented: anything else is left as is and fails validation as before. Each repair is reported as a warning
 * (code REPAIRED_STRINGIFIED_JSON / REPAIRED_BARE_ID, path, no model text). */
type Def = { type: string; innerType?: z.ZodType; element?: z.ZodType; shape?: Record<string, z.ZodType>; entries?: Record<string, string> };
const defOf = (schema: z.ZodType) => (schema as unknown as { def: Def }).def;
const MAX_ENCODED = 400_000;

function decode(value: string, want: "array" | "object"): unknown {
  if (value.length > MAX_ENCODED) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    const isArray = Array.isArray(parsed);
    return (want === "array" ? isArray : !isArray && typeof parsed === "object" && parsed !== null) ? parsed : undefined;
  } catch { return undefined; }
}

/** (4) An enum value that differs from an allowed one only in case, spacing or hyphens, or that is a listed synonym of one. The table is small and
 * explicit: a synonym applies only where its target is an allowed value of that enum, and a word that could mean two allowed values is
 * deliberately absent (MANUAL for a step type: in the system or outside it; INTEGRATION for a fit-gap class: standard or custom).
 * Anything else stays an error for the model. */
const ENUM_SYNONYMS: Readonly<Record<string, string>> = {
  AUTOMATED: "AUTOMATIC", AUTO: "AUTOMATIC", MANUAL_IN_SYSTEM: "IN_SYSTEM_MANUAL", MANUAL_OUTSIDE_SYSTEM: "OUTSIDE_SYSTEM",
  OFF_SYSTEM: "OUTSIDE_SYSTEM", INTERFACE: "INTEGRATION", DECISION_POINT: "DECISION",
};

const WRAPPER_NAME = /^[a-z_]{1,30}$/;

/** (3) A model that wraps the whole payload under one invented key ({"parameter": "<JSON of the payload>"} or {"input": {...}}):
 * the single unexpected key's value, decoded if it is a string, is an object whose keys are all top-level keys of the schema. */
function unwrap(schema: z.ZodType, raw: unknown): { value: unknown; wrapper: string } | undefined {
  const shape = defOf(schema).shape;
  if (!shape || typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw);
  if (entries.length !== 1 || Object.hasOwn(shape, entries[0]![0])) return undefined;
  const [wrapper, inner] = entries[0]!;
  const value = typeof inner === "string" ? decode(inner, "object") : inner;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length && keys.every(key => Object.hasOwn(shape, key)) ? { value, wrapper } : undefined;
}

export function normalizeToolInput(schema: z.ZodType, input: unknown, root: string): { value: unknown; warnings: ValidationIssue[] } {
  const warnings: ValidationIssue[] = [];
  const wrapped = unwrap(schema, input);
  // The wrapper key name is recorded only when it is a plain word, so no model text can leak into stored metrics.
  if (wrapped) warnings.push({ code: "REPAIRED_WRAPPED_PAYLOAD", path: root, ...(WRAPPER_NAME.test(wrapped.wrapper) && { detail: wrapped.wrapper }) });
  const raw = wrapped ? wrapped.value : input;
  const walk = (node: z.ZodType, value: unknown, path: string): unknown => {
    const def = defOf(node);
    if ((def.type === "optional" || def.type === "nullable" || def.type === "default") && def.innerType) return value === null ? value : walk(def.innerType, value, path);
    if (def.type === "enum" && def.entries && typeof value === "string") {
      const allowed = Object.values(def.entries);
      if (allowed.includes(value)) return value;
      const key = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
      const target = allowed.includes(key) ? key : ENUM_SYNONYMS[key];
      if (target && allowed.includes(target)) { warnings.push({ code: "REPAIRED_ENUM_SYNONYM", path }); return target; }
      return value;
    }
    if (def.type === "array" && def.element) {
      let list = value;
      if (typeof list === "string") {
        const decoded = decode(list, "array");
        if (decoded !== undefined) { warnings.push({ code: "REPAIRED_STRINGIFIED_JSON", path }); list = decoded; }
        else if (def.element === id && id.safeParse(list).success) { warnings.push({ code: "REPAIRED_BARE_ID", path }); list = [list]; }
      }
      return Array.isArray(list) ? list.map((item, i) => walk(def.element!, item, `${path}.${i}`)) : list;
    }
    if (def.type === "object" && def.shape) {
      let obj = value;
      if (typeof obj === "string") {
        const decoded = decode(obj, "object");
        if (decoded !== undefined) { warnings.push({ code: "REPAIRED_STRINGIFIED_JSON", path }); obj = decoded; }
      }
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return obj;
      const record = obj as Record<string, unknown>;
      return Object.fromEntries(Object.entries(record).map(([key, item]) =>
        [key, Object.hasOwn(def.shape!, key) ? walk(def.shape![key]!, item, `${path}.${key}`) : item]));
    }
    return value;
  };
  return { value: walk(schema, raw, root), warnings };
}
