/** The model wrote its tool call as markup (DeepSeek's `<｜DSML｜ ...>`) instead of calling the tool: as the whole text answer, or inside a field value. */
export const TOOL_MARKUP_LEAKED = "TOOL_MARKUP_LEAKED";
export const LEAK_DETAIL = "tool-call markup was written here instead of calling the tool";
const TOOL_MARKUP = /[｜|]DSML[｜|]/;
export const hasToolMarkup = (text: string) => TOOL_MARKUP.test(text);
/** Path (relative to `path`) of the first string in `value` that holds tool-call markup. Array indices are part of the path; object keys only when they look like field names. Never changes the value: a corrupt field is reported, not cleaned. */
export function findToolMarkup(value: unknown, path: string): string | undefined {
  if (typeof value === "string") return hasToolMarkup(value) ? path : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const isList = Array.isArray(value);
  for (const [key, item] of Object.entries(value)) {
    const found = findToolMarkup(item, isList || /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) ? `${path}.${key}` : path);
    if (found) return found;
  }
  return undefined;
}
