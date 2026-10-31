import { idKey } from "./sap-object-lint";
import { LONG_ID } from "./input-id-labels";
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

/** Deterministic repair of a long id the model mis-copied (a dropped or changed character) in an id field (id, *Id, *Ids): an unknown value longer than LONG_ID whose nearest
 * known long id is within two edits, uniquely, is replaced by it. Short ids are never touched: a near one is a different item. Warning REPAIRED_ID_TYPO carries the path only. */
const editDistance = (a: string, b: string) => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
};
export function repairIdTypos(raw: unknown, ids: Iterable<string>, prefix: string): { value: unknown; warnings: ValidationIssue[] } {
  const known = new Set(ids), long = [...known].filter(id => id.length > LONG_ID), warnings: ValidationIssue[] = [];
  const fix = (id: string, path: string) => {
    if (id.length <= LONG_ID || known.has(id)) return id;
    const scored = long.map(candidate => [candidate, editDistance(id, candidate)] as const).filter(([, d]) => d <= 2).sort((a, b) => a[1] - b[1]);
    if (!scored.length || (scored[1] && scored[1][1] === scored[0]![1])) return id;
    warnings.push({ code: "REPAIRED_ID_TYPO", path });
    return scored[0]![0];
  };
  const walk = (value: unknown, path: string, inIdField: boolean): unknown => {
    if (typeof value === "string") return inIdField ? fix(value, path) : value;
    if (Array.isArray(value)) return value.map((item, i) => walk(item, `${path}.${i}`, inIdField));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, `${path}.${key}`, idKey(key))]));
    return value;
  };
  return { value: walk(raw, prefix, false), warnings };
}
