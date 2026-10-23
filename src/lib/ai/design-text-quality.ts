import { elementRoot } from "./design-text-lint";
import { strings } from "./sap-object-lint";

/** Three deterministic checks over the free text of a finished design: placeholder text left in a field, text cut off mid-sentence, and a fragment in another language.
 * Each reports the element (a step, a register row) and the field, never the model's words, so the part that owns the element can be sent back to rewrite it. */
export type TextQualityHit = { path: string; detail: string };
const MAX_HITS = 25;
const fieldOf = (path: string) => path.split(".").filter(part => !/^\d+$/.test(part)).pop() ?? "";

/** Walks every text field once and collects at most MAX_HITS hits from `check` (one per element and detail). */
function collect(design: unknown, check: (value: string, field: string) => string[]): TextQualityHit[] {
  const seen = new Set<string>(), hits: TextQualityHit[] = [];
  for (const [path, value] of strings(design, "draft")) {
    const root = elementRoot(path), field = fieldOf(path);
    for (const detail of check(value, field)) {
      const key = `${root}:${field}:${detail}`;
      if (!seen.has(key) && hits.length < MAX_HITS) { seen.add(key); hits.push({ path: root, detail: `${detail} in field ${field}` }); }
    }
  }
  return hits;
}

// --- placeholder text --------------------------------------------------------------------------------------------------------------

/** A value made only of these words says nothing ("Ignore", "placeholder", "TBD", "n/a", "?"). "None: <reason>" is a real statement and is not one. */
const JUNK_WORD = /^(?:placeholders?|tbd|tba|tbc|todo|to-do|ignored?|n\/a|na|x{3,}|lorem|ipsum|dolor|sit|amet|text|value|here)$/i;
const TOKEN_EDGES = /^[\s"'`([{<*_.,:;!?-]+|[\s"'`)\]}>*_.,:;!?-]+$/g;
/** An id with a question mark where its number goes ("ETO-OQ-?"), a lorem-ipsum run, or a bracketed gap marker ("[TBD]", "<insert owner>"). */
const JUNK_INSIDE = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\?(?![A-Za-z0-9])|\blorem ipsum\b|[[<](?:placeholder|tbd|todo|insert\b[^\]>]*)[\]>]/i;

export const junkHits = (design: unknown): TextQualityHit[] => collect(design, value => {
  const words = value.split(/\s+/).map(word => word.replace(TOKEN_EDGES, "")).filter(Boolean);
  if (!words.length || words.every(word => JUNK_WORD.test(word))) return ["placeholder text"];
  return JUNK_INSIDE.test(value) ? ["placeholder in text"] : [];
});

// --- text cut off ------------------------------------------------------------------------------------------------------------------

const MIN_TRUNCATION_CHARS = 80;
/** Words a sentence never ends on (lower case only, so "WBS element A" is not one). Prepositions that can end a clause ("built from", "built to") are left out on purpose. */
const DANGLING_END = /\b(?:and|or|but|the|a|an|of|with|that|which|whose|its|their|because|than)$/;
/** Fields written as whole sentences, where a missing full stop means the answer stopped early. Clause fields (condition, given, when) and names carry none by design. */
const SENTENCE_FIELDS = new Set(["detail", "response", "inventory", "financial", "ownership", "accountingEntry"]);

export const truncationHits = (design: unknown): TextQualityHit[] => collect(design, (value, field) => {
  const text = value.trim();
  if (text.length <= MIN_TRUNCATION_CHARS) return [];
  if (/(?:\.\.\.|…)$/.test(text)) return ["ends with an ellipsis"];
  if (DANGLING_END.test(text)) return ["ends on a joining word"];
  return SENTENCE_FIELDS.has(field) && !/[.!?;:)"'”’\]]$/.test(text) ? ["ends without closing punctuation"] : [];
});

// --- another language --------------------------------------------------------------------------------------------------------------

const words = (list: string) => new Set(list.split(" "));
const ENGLISH = words("the and of to a is are with for in on by that this be as at from not or it an when if which");
/** Function words that are distinctive for the language and are not English words. One German SAP term in an English sentence has none of them. */
const FOREIGN: Record<string, ReadonlySet<string>> = {
  German: words("der das und nicht ist eine einen einem eines mit von für auf bei nach zum zur dem den des im sich wird werden oder auch aus über wenn liegt noch nur wie sind"),
  French: words("les des une est sont pour avec dans que qui sur aux cette être pas"),
  Spanish: words("los las del una para por que como más pero sus este esta están"),
};
const MIN_CLAUSE_WORDS = 4, MIN_FOREIGN_WORDS = 2;

/** A clause (text between punctuation marks) with two or more function words of one other language, and more of them than English ones, is a fragment in that language. */
export const languageHits = (design: unknown): TextQualityHit[] => collect(design, value => {
  const found: string[] = [];
  for (const clause of value.split(/[;:.,()\n–—]|\s-\s/)) {
    const clauseWords = clause.toLowerCase().match(/[\p{L}']+/gu) ?? [];
    if (clauseWords.length < MIN_CLAUSE_WORDS) continue;
    const english = clauseWords.filter(word => ENGLISH.has(word)).length;
    for (const [language, set] of Object.entries(FOREIGN)) {
      const foreign = clauseWords.filter(word => set.has(word)).length;
      if (foreign >= MIN_FOREIGN_WORDS && foreign > english) found.push(`${language} text`);
    }
  }
  return [...new Set(found)];
});
