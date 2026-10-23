import { z } from "zod";
import { id } from "./design-primitives";
import type { ValidationIssue } from "./problem-analysis";

/** Deterministic pre-parse repair of tool inputs from providers that mishandle nested schema fields. Two slips only, both
 * mechanical and lossless: (1) a field the schema types as an array or object arrives as a JSON-encoded string that parses
 * to exactly that type; (2) an id array arrives as one bare id string that matches the id pattern (wrapped in an array).
 * Nothing is ever invented: anything else is left as is and fails validation as before. Each repair is reported as a warning
 * (code REPAIRED_STRINGIFIED_JSON / REPAIRED_BARE_ID, path, no model text). */
type Def = { type: string; innerType?: z.ZodType; element?: z.ZodType; shape?: Record<string, z.ZodType> };
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

export function normalizeToolInput(schema: z.ZodType, raw: unknown, root: string): { value: unknown; warnings: ValidationIssue[] } {
  const warnings: ValidationIssue[] = [];
  const walk = (node: z.ZodType, value: unknown, path: string): unknown => {
    const def = defOf(node);
    if ((def.type === "optional" || def.type === "nullable" || def.type === "default") && def.innerType) return value === null ? value : walk(def.innerType, value, path);
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
