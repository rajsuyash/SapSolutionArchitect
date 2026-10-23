// Sentence IDs for the interview turn. The model cites `S<n>`; the server resolves the citation to the exact source text,
// so a stored quote is always a substring of its source. The map is rebuilt from the same InterviewInput at validation
// time (never read from model output), so the IDs of a turn are fully determined by that input.

export type SentenceSpan = { start: number; end: number };
export type IndexedSentence = { sourceId: string; start: number; end: number; ordinal: number };
type Sources = { currentMessage: { id: string; text: string }; evidence: { id: string; text: string }[] };

/** A sentence longer than this is cut on whitespace, so one unpunctuated paragraph still has addressable parts. */
const MAX_SENTENCE = 1000;
/** Words whose trailing period does not end a sentence. Single letters and numbers ("1.", "A.") are handled separately. */
const ABBREVIATIONS = new Set(["vs", "approx", "incl", "mr", "mrs", "ms", "dr", "prof", "inc", "ltd", "pvt", "co", "corp",
  "st", "fig", "ref", "dept", "est", "avg", "max", "min", "qty", "tel"]);
// A terminator run (with closing quotes/brackets) followed by whitespace, a semicolon followed by whitespace, or a newline.
const BOUNDARY = /[.!?…।]+["'”’)\]]*(?=\s)|;+(?=\s)|\n/g;
const isAbbreviation = (word: string) => /^(?:\p{L}\.)+\p{L}$/u.test(word) || /^\p{L}$/u.test(word) || /^\d+$/.test(word) || ABBREVIATIONS.has(word.toLowerCase());

function endsSentence(text: string, at: number, end: number): boolean {
  const mark = text.slice(at, end);
  if (mark === "\n" || mark.startsWith(";") || /[!?\u0964]/.test(mark)) return true;
  if (/^\p{Ll}/u.test(text.slice(end).trimStart())) return false;
  if (mark !== ".") return true;
  // A single full stop is not a sentence end after an abbreviation, a list marker or an initial.
  const word = /([^\s"'(\[]+)$/.exec(text.slice(Math.max(0, at - 24), at))?.[1] ?? "";
  return !(word && isAbbreviation(word));
}

/** Split text into sentences: spans of the original string, ordered, never overlapping, trimmed of surrounding whitespace.
 * Only whitespace lies between them, so no other character is lost. Boundaries: ". ! ? … ।" followed by whitespace, and
 * every newline and every ";" followed by whitespace (the ";" is not part of the sentence). A single "." does not end a sentence after an abbreviation ("e.g.", "etc.", "Dr."), a list marker ("1."),
 * or when the next word starts in lowercase; "..." is treated the same way. */
export function splitSentences(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let from = 0;
  const push = (to: number) => {
    let start = from, end = to;
    while (start < end && /\s/.test(text[start]!)) start++;
    // A list marker ("- ", "• ", "1) ") is not part of the sentence; the semicolon that ended a clause is not either.
    const bullet = /^(?:[-*•–]|\d{1,3}\))\s+/.exec(text.slice(start, end));
    if (bullet) start += bullet[0].length;
    while (end > start && /[\s;]/.test(text[end - 1]!)) end--;
    from = to;
    while (end - start > MAX_SENTENCE) {
      let cut = text.lastIndexOf(" ", start + MAX_SENTENCE);
      if (cut <= start) cut = start + MAX_SENTENCE - (/[\uD800-\uDBFF]/.test(text[start + MAX_SENTENCE - 1]!) ? 1 : 0);
      let chunkEnd = cut;
      while (chunkEnd > start && /\s/.test(text[chunkEnd - 1]!)) chunkEnd--;
      if (chunkEnd > start) spans.push({ start, end: chunkEnd });
      start = cut;
      while (start < end && /\s/.test(text[start]!)) start++;
    }
    if (end > start) spans.push({ start, end });
  };
  for (const match of text.matchAll(BOUNDARY)) {
    const end = match.index + match[0].length;
    if (endsSentence(text, match.index, end)) push(end);
  }
  push(text.length);
  return spans;
}

/** Sentence IDs for one turn: the current message first, then each evidence source in order. */
export function indexSentences(input: Sources) {
  const sentences = new Map<string, IndexedSentence>();
  const bySource = new Map<string, { id: string; text: string }[]>();
  let next = 1;
  for (const source of [input.currentMessage, ...input.evidence]) {
    const lines: { id: string; text: string }[] = [];
    splitSentences(source.text).forEach(({ start, end }, ordinal) => {
      const id = `S${next++}`;
      sentences.set(id, { sourceId: source.id, start, end, ordinal });
      lines.push({ id, text: source.text.slice(start, end) });
    });
    bySource.set(source.id, lines);
  }
  return { sentences, bySource };
}
export type SentenceIndex = ReturnType<typeof indexSentences>;

/** The input as the model sees it: each source's text is replaced by one `[S<n>] sentence` line per sentence. */
export function interviewModelView<T extends Sources>(input: T): T {
  const { bySource } = indexSentences(input);
  const tagged = (id: string) => (bySource.get(id) ?? []).map(line => `[${line.id}] ${line.text}`).join("\n");
  return { ...input, currentMessage: { ...input.currentMessage, text: tagged(input.currentMessage.id) },
    evidence: input.evidence.map(source => ({ ...source, text: tagged(source.id) })) };
}

/** A cited span longer than this many sentences is not evidence for one fact; the proposal is dropped, not the turn. */
export const MAX_EVIDENCE_SPAN = 6;
export type Citation = { sourceId: string; quote: string; warning?: "evidence_cross_source_trimmed" } |
  { problem: "unknown_sentence_id" | "evidence_span_too_long" };

/** Resolve cited IDs to the source and the exact slice from the earliest cited sentence's start to the latest one's end.
 * Repeated IDs are collapsed; IDs from other sources than the first cited one are ignored (warning); gaps between the
 * cited sentences are covered by the slice. An unknown ID is a hard problem (hallucination). */
export function resolveSentenceIds(index: SentenceIndex, sources: ReadonlyMap<string, string>, ids: readonly string[]): Citation {
  const found = [...new Set(ids)].map(id => index.sentences.get(id));
  if (!found.length || found.some(item => !item)) return { problem: "unknown_sentence_id" };
  const all = found as IndexedSentence[];
  const sourceId = all[0]!.sourceId;
  const cited = all.filter(item => item.sourceId === sourceId).sort((a, b) => a.ordinal - b.ordinal);
  const first = cited[0]!, last = cited.at(-1)!;
  if (last.ordinal - first.ordinal + 1 > MAX_EVIDENCE_SPAN) return { problem: "evidence_span_too_long" };
  const quote = sources.get(sourceId)!.slice(first.start, last.end);
  return cited.length < all.length ? { sourceId, quote, warning: "evidence_cross_source_trimmed" } : { sourceId, quote };
}
