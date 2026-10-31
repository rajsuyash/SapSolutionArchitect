/** Deterministic check that a design names no SAP object the curated catalog does not contain. It finds Fiori app ids,
 * transaction codes, movement types, scope items, BAPIs/APIs and BAdI names in every text field and flags any that appear
 * nowhere in the catalog's ids, capabilities, objects and limitations. It proves nothing about SAP; it stops invention.
 * Only the matched token is reported (a token is an SAP identifier, not client data). */
export type SapObjectKind = "FIORI_APP" | "TRANSACTION" | "MOVEMENT_TYPE" | "SCOPE_ITEM" | "API" | "BADI";
export type SapObjectHit = { path: string; kind: SapObjectKind; token: string };
type Catalog = readonly { id: string; capability?: string; objects?: readonly string[]; limitations?: readonly string[] }[];

// Module-family prefixes keep bare codes such as VA01 or ME21N from matching ordinary words, ticket ids and release names.
const TCODE_PREFIX = "VA|VL|VF|VK|VT|VG|VS|VD|ME|MB|MI|MM|MR|MD|MC|FB|FS|FK|FD|FV|KO|KS|KB|KE|IW|IE|IL|IQ|IP|OV|OB|OM|SM|SE|SU|XD|XK|BP|LT|LS|QA|QM|CJ|CN|CO|CK|AS|AB|AF";
const NOT_AN_OBJECT = new Set(["SAP", "ERP", "API", "EDI", "CRM", "BTP", "ALL", "THE", "AND", "FOR", "NOT", "OFF", "FPS", "GL", "AR", "AP", "PO", "SO"]);
export const SEP = String.raw`\s*(?:,|/|&|and|or|-)\s*`;
export const list = (token: string) => String.raw`(${token}(?:${SEP}${token})*)`;

const PATTERNS: { kind: SapObjectKind; regex: RegExp; group?: number; split?: boolean; accept?: (token: string) => boolean }[] = [
  { kind: "FIORI_APP", regex: /(?<![A-Za-z0-9])F\d{3,4}[A-Z]?(?![A-Za-z0-9])/g },
  { kind: "TRANSACTION", regex: new RegExp(String.raw`(?<![A-Za-z0-9])(?:${TCODE_PREFIX})\d{2}[A-Z]?(?![A-Za-z0-9])`, "g") },
  // After the word "transaction": a code has a digit (VA01) or is a four-letter code (MIGO); "transaction VAT" is not one.
  { kind: "TRANSACTION", group: 1, split: true, accept: token => /\d/.test(token) || /^[A-Z]{4}$/.test(token),
    regex: new RegExp(String.raw`\b(?:[Tt]ransactions?(?:\s+codes?)?|[Tt]-?[Cc]odes?)\s*(?:such as|like|e\.g\.,?|:|\()?\s*${list("[A-Z][A-Z0-9_]{1,19}")}`, "g") },
  { kind: "MOVEMENT_TYPE", group: 1, split: true,
    regex: new RegExp(String.raw`\b(?:[Mm]ovement\s+[Tt]ypes?|[Mm]ovement|[Mm]vt)\s+${list("\\d{3}[A-Z]?(?!\\d)")}`, "g") },
  { kind: "SCOPE_ITEM", group: 1, split: true,
    regex: new RegExp(String.raw`\b[Ss]cope\s+[Ii]tems?\s*:?\s*${list("[A-Z0-9]{3}(?![A-Za-z0-9])")}`, "g") },
  { kind: "API", regex: /(?<![A-Za-z0-9_])(?:BAPI|API)_[A-Z0-9_]{2,}/g },
  { kind: "BADI", group: 1, regex: /\bBAdIs?\s+([A-Z][A-Z0-9]*_[A-Z0-9_]+)/g },
];

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Everything the catalog says, lower-cased, with numeric ranges ("651-657") expanded so a movement type inside one is found. */
function haystack(references: Catalog): string {
  const raw = references.flatMap(ref => [ref.id, ref.capability ?? "", ...(ref.objects ?? []), ...(ref.limitations ?? [])]).join("\n");
  const ranges = [...raw.matchAll(/(?<!\d)(\d{3})-(\d{3})(?!\d)/g)].flatMap(([, from, to]) => {
    const low = Number(from), high = Number(to);
    return high >= low && high - low <= 50 ? Array.from({ length: high - low + 1 }, (_, i) => String(low + i)) : [];
  });
  return `${raw}\n${ranges.join(" ")}`.toLowerCase();
}

export const idKey = (key: string) => key === "id" || key.endsWith("Id") || key.endsWith("Ids");

export function* strings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (const [i, item] of value.entries()) yield* strings(item, `${path}.${i}`);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) if (!idKey(key)) yield* strings(item, `${path}.${key}`);
  }
}

/** Every SAP object named in the design's text fields that the catalog does not contain. */
export function lintSapObjects(design: unknown, references: Catalog): SapObjectHit[] {
  const known = haystack(references);
  const present = (token: string) => new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(token.toLowerCase())}(?![A-Za-z0-9])`).test(known);
  const hits: SapObjectHit[] = [];
  for (const [path, value] of strings(design, "draft")) {
    const seen = new Set<string>();
    for (const { kind, regex, group, split, accept } of PATTERNS) {
      for (const match of value.matchAll(regex)) {
        const captured = match[group ?? 0]!;
        const tokens = split ? captured.split(/\s*(?:,|\/|&|\band\b|\bor\b|-)\s*/) : [captured];
        for (const token of tokens) {
          if (!token || NOT_AN_OBJECT.has(token) || (accept && !accept(token)) || seen.has(`${kind}:${token}`)) continue;
          seen.add(`${kind}:${token}`);
          if (!present(token)) hits.push({ path, kind, token });
        }
      }
    }
  }
  return hits;
}
