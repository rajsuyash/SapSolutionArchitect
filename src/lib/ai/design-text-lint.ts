import { escapeRegExp, list, strings } from "./sap-object-lint";

/** Two deterministic text checks over a finished design. Both report review findings (the design stays valid): the first
 * finds SAP codes a step uses that no register defines, the second finds the generator's own working vocabulary in client-facing text. */

export type SapCodeKind = "MOVEMENT_TYPE" | "DOCUMENT_TYPE" | "CONDITION_TYPE" | "REASON_CODE" | "ORG_CODE";
export type SapCode = { kind: SapCodeKind; token: string };

const STOP = new Set(["THE", "AND", "FOR", "NOT", "ALL", "SAP", "ANY", "NEW", "OLD", "TBD", "N/A"]);
const ORG_UNIT = String.raw`(?:[Cc]ompany\s+[Cc]odes?|[Pp]lants?|[Ss]torage\s+[Ll]ocations?|[Ss]ales\s+[Oo]rgani[sz]ations?|[Pp]urchasing\s+[Oo]rgani[sz]ations?|[Cc]ontrolling\s+[Aa]reas?|[Pp]rofit\s+[Cc]entres?|[Cc]ost\s+[Cc]entres?)`;
const CODE_PATTERNS: { kind: SapCodeKind; regex: RegExp; accept?: (token: string) => boolean }[] = [
  { kind: "MOVEMENT_TYPE", regex: new RegExp(String.raw`\b(?:[Mm]ovement\s+[Tt]ypes?|[Mm]ovement|[Mm]vt)\s+${list("\\d{3}[A-Z]?(?!\\d)")}`, "g") },
  { kind: "DOCUMENT_TYPE", regex: new RegExp(String.raw`\b[Dd]ocument\s+[Tt]ypes?\s+${list("[A-Z][A-Z0-9]{1,5}(?![A-Za-z0-9])")}`, "g") },
  { kind: "CONDITION_TYPE", regex: new RegExp(String.raw`\b[Cc]ondition\s+[Tt]ypes?\s+${list("[A-Z][A-Z0-9]{1,5}(?![A-Za-z0-9])")}`, "g") },
  { kind: "REASON_CODE", accept: token => /\d/.test(token), regex: new RegExp(String.raw`\b[Rr]easons?\s+[Cc]odes?\s+${list("[A-Z0-9]{1,6}(?![A-Za-z0-9])")}`, "g") },
  { kind: "ORG_CODE", accept: token => /\d/.test(token), regex: new RegExp(String.raw`\b${ORG_UNIT}\s+${list("[A-Z0-9]{3,4}(?![A-Za-z0-9])")}`, "g") },
];

/** The movement types, document types, condition types, reason codes and organisation codes named in a text, each once. */
export function extractSapCodes(text: string): SapCode[] {
  const found = new Map<string, SapCode>();
  for (const { kind, regex, accept } of CODE_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      for (const token of match[1]!.split(/\s*(?:,|\/|&|\band\b|\bor\b|-)\s*/)) {
        if (token && !STOP.has(token) && (!accept || accept(token))) found.set(`${kind}:${token}`, { kind, token });
      }
    }
  }
  return [...found.values()];
}

/** True when `token` appears in `haystack` as a whole code (not inside a longer word or number). */
export const mentionsCode = (haystack: string, token: string) =>
  new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(token)}(?![A-Za-z0-9])`, "i").test(haystack);

/** All text fields of a value (id fields skipped), for the checks that compare free text across registers. */
export const textFields = (value: unknown): string[] => [...strings(value, "draft")].map(([, text]) => text);

// --- the generator's own vocabulary in text a client reads ----------------------------------------------------------------------

/** Words of the generation pipeline that mean nothing to a client. "Outline agreement" is a real SAP term and is not one of them. */
export const INTERNAL_TERM_PATTERNS: readonly RegExp[] = [
  /\boutline\b(?!\s+agreements?)/i, /\b(?:register|step|outline|patch|repair) calls?\b/i, /\bfrozen (?:outline|step|design|register|plan)\b/i,
  /\b(?:to_be_[a-z_]+|submit_to_be\w*)\b/, /\b(?:needsValidation|referenceIds|stepIds|requirementIds|contextFieldIds|validationReason)\b/,
  /\b(?:UNKNOWN|DUPLICATE|REGISTER|REPAIRED|INVALID)_[A-Z_]{3,}\b/,
];
/** The element a text field belongs to: `draft.steps.3` for anything inside the fourth step, `draft.roles.0` for a register row, `draft.processName` for a single field. */
export const elementRoot = (path: string) => {
  const parts = path.split(".");
  return parts.slice(0, /^\d+$/.test(parts[2] ?? "") ? 3 : 2).join(".");
};
export type InternalTermHit = { path: string; term: string };
const MAX_INTERNAL_HITS = 25;
/** One hit per (element, term): `path` is the element (a step, a register row), `term` the matched words. */
export function internalTermHits(design: unknown): InternalTermHit[] {
  const seen = new Set<string>(), hits: InternalTermHit[] = [];
  for (const [path, value] of strings(design, "draft")) {
    const root = elementRoot(path);
    for (const pattern of INTERNAL_TERM_PATTERNS) {
      for (const match of value.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
        const term = match[0].toLowerCase().slice(0, 40), key = `${root}:${term}`;
        if (!seen.has(key) && hits.length < MAX_INTERNAL_HITS) { seen.add(key); hits.push({ path: root, term }); }
      }
    }
  }
  return hits;
}

// --- ids the text cites that the design does not have ---------------------------------------------------------------------------

/** An id-shaped token: upper-case segments joined by hyphens and ending in a number (ETO-OQ-4, TB-12, ETO-5-1-BR-2), optionally with a letter suffix after the number
 * (ETO-OQ-5-F1: a sub-id of a question the design never defined). */
const ID_TOKEN = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+(?:-[A-Z]+\d*)*(?![A-Za-z0-9_-])/g;
/** The pattern an id follows: its last number replaced by `#` (ETO-OQ-4 and ETO-OQ-5-F1 are both ETO-OQ-#). */
export const idFamily = (id: string) => {
  const base = id.replace(/(?:-[A-Z]+\d*)+$/, "");
  return /-\d+$/.test(base) ? base.replace(/\d+$/, "#") : undefined;
};
/** Every string under an `id` key, at any depth: the ids a design gives its own steps, rules, tests, questions and register rows. */
export function* designIds(value: unknown): Generator<string> {
  if (Array.isArray(value)) for (const item of value) yield* designIds(item);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { if (key === "id" && typeof item === "string") yield item; else yield* designIds(item); }
  }
}
export type DanglingIdHit = { path: string; token: string };
/** Tokens in free text that look like one of this design's own id families (same prefix, a number) but name nothing that exists. Only a family the design itself
 * uses counts, so SAP codes and release names never match. `own` are the design's ids, `known` every id that may legitimately be cited (own plus the input's). */
export function danglingIdHits(design: unknown, own: Iterable<string>, known: ReadonlySet<string>): DanglingIdHit[] {
  const families = new Set([...own].flatMap(id => idFamily(id) ?? []));
  const seen = new Set<string>(), hits: DanglingIdHit[] = [];
  for (const [path, value] of strings(design, "draft")) {
    const root = elementRoot(path);
    for (const [token] of value.matchAll(ID_TOKEN)) {
      const family = idFamily(token), key = `${root}:${token}`;
      if (family && families.has(family) && !known.has(token) && !seen.has(key) && hits.length < 25) { seen.add(key); hits.push({ path: root, token }); }
    }
  }
  return hits;
}
