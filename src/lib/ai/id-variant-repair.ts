import { idKey } from "./sap-object-lint";
import type { ValidationIssue } from "./problem-analysis";

/** Deterministic repair of an id the model respells in free text ("ETO-5" for the step "ETO-05", "eto-oq-4" for "ETO-OQ-4"). A token is rewritten only when exactly one
 * existing id has the same segments ignoring case and zero-padding; none or several candidates leave the text alone. Id-list fields (idKey) are never touched: they
 * have their own UNKNOWN_* checks. Warning REPAIRED_ID_VARIANT carries the path of the element only, never the text. */
const VARIANT_TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-\d+(?![A-Za-z0-9_-])/g;
const normKey = (id: string) => id.toUpperCase().split("-").map(segment => /^\d+$/.test(segment) ? String(Number(segment)) : segment).join("-");

export function repairIdVariants(raw: unknown, ids: Iterable<string>, prefix: string): { value: unknown; warnings: ValidationIssue[] } {
  const known = new Set(ids), byKey = new Map<string, Set<string>>();
  for (const id of known) { const key = normKey(id); byKey.set(key, (byKey.get(key) ?? new Set()).add(id)); }
  const warned = new Set<string>(), warnings: ValidationIssue[] = [];
  const rewrite = (text: string, path: string) => text.replace(VARIANT_TOKEN, token => {
    if (known.has(token)) return token;
    const candidates = byKey.get(normKey(token));
    if (candidates?.size !== 1) return token;
    const parts = path.split("."), root = parts.slice(0, /^\d+$/.test(parts[2] ?? "") ? 3 : 2).join(".");
    if (!warned.has(root)) { warned.add(root); warnings.push({ code: "REPAIRED_ID_VARIANT", path: root }); }
    return [...candidates][0]!;
  });
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === "string") return rewrite(value, path);
    if (Array.isArray(value)) { const next = value.map((item, i) => walk(item, `${path}.${i}`)); return next.some((item, i) => item !== value[i]) ? next : value; }
    if (value && typeof value === "object") {
      const entries = Object.entries(value), next = entries.map(([key, item]) => [key, idKey(key) ? item : walk(item, `${path}.${key}`)] as const);
      return next.some(([, item], i) => item !== entries[i]![1]) ? Object.fromEntries(next) : value;
    }
    return value;
  };
  const value = walk(raw, prefix);
  return { value, warnings };
}
