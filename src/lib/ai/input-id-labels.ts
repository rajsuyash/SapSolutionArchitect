/** Long input ids (rq_<uuid>_17, st_<uuid>_10) are mis-copied by the model one character at a time. Whatever the model and the checks see carries short labels
 * instead (RQ-n for requirements, AS-n for As-Is steps, in input order); the finished design is written back to the original ids. A kind is labelled only when one
 * of its ids holds a UUID: readable ids (rq_credit, TB-1, st_as_is_3) pass through untouched, since the model copies those reliably. Whole-token replacement, so RQ-1 never matches inside RQ-12 or RQ-1-F1. */
/** Ids longer than this are the ones whose mis-copies the typo repair (id-variant-repair.ts) may settle. */
export const LONG_ID = 16;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const escape = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Deep-replace every whole-token occurrence of a key of `labels` in the strings (and object keys) of `value`. */
export function replaceIds<T>(value: T, labels: ReadonlyMap<string, string>): T {
  if (!labels.size) return value;
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${[...labels.keys()].sort((a, b) => b.length - a.length).map(escape).join("|")})(?![A-Za-z0-9_-])`, "g");
  const text = (s: string) => s.replace(pattern, id => labels.get(id) ?? id);
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return text(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object" && Object.getPrototypeOf(node) === Object.prototype) return Object.fromEntries(Object.entries(node).map(([k, v]) => [text(k), walk(v)]));
    return node;
  };
  return walk(value) as T;
}

type Discovery = { requirements: { id: string }[]; asIsSteps: { id: string }[] };
export function shortenInputIds<I extends { discovery: Discovery }>(input: I): { input: I; restore: <T>(value: T) => T } {
  const forward = new Map<string, string>(), back = new Map<string, string>();
  const label = (items: readonly { id: string }[], prefix: string) => {
    if (!items.some(item => UUID.test(item.id))) return;
    items.forEach((item, i) => { forward.set(item.id, `${prefix}-${i + 1}`); back.set(`${prefix}-${i + 1}`, item.id); });
  };
  label(input.discovery.requirements, "RQ");
  label(input.discovery.asIsSteps, "AS");
  return { input: replaceIds(input, forward), restore: value => replaceIds(value, back) };
}
