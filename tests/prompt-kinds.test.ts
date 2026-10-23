import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IMPLEMENTATION_KINDS } from "../src/lib/ai/design-quality";

/** The kind ladder in the To-Be prompts must only ever name legal values of implementation.kind. A reference's fitType
 * (notably LICENSE_DEPENDENT) is not a kind: a model told to use it as one fails the enum (seen live, 2026-10-23). */
const kinds = new Set<string>(IMPLEMENTATION_KINDS);
const FIT_ONLY = ["LICENSE_DEPENDENT"];
const upper = (text: string) => text.match(/\b[A-Z][A-Z_]{3,}\b/g) ?? [];

for (const name of ["outline", "step"]) {
  describe(`prompts/to_be_${name}.system.md kind section`, () => {
    const prompt = readFileSync(`prompts/to_be_${name}.system.md`, "utf8");
    const ladder = prompt.slice(prompt.indexOf("using this ladder:"), prompt.indexOf("- Choosing the extension mechanism"));
    const listed = /has a kind \(([^)]*)\)/.exec(prompt)?.[1] ?? "";
    // A ladder entry is a bullet that opens with a kind word: "  - STANDARD or CONFIGURATION: ..."
    const heads = [...ladder.matchAll(/^ {2}- ([A-Z_]+(?: or [A-Z_]+)*)[:,]/gm)].flatMap(match => match[1]!.split(" or "));

    it("finds the ladder and the kind sentence (a parse that finds nothing proves nothing)", () => {
      expect(ladder.length).toBeGreaterThan(200);
      expect(heads.length).toBeGreaterThanOrEqual(5);
      expect(upper(listed)).toHaveLength(6);
    });
    it("names every ladder bullet head and every listed kind only as a member of the implementation.kind enum", () => {
      for (const word of [...heads, ...upper(listed)]) expect(kinds.has(word), word).toBe(true);
      expect(new Set(heads)).toEqual(kinds);
    });
    it("never offers a reference fit type as a kind, and says LICENSE_DEPENDENT is not one", () => {
      for (const word of FIT_ONLY) expect(heads).not.toContain(word);
      expect(ladder).toMatch(/LICENSE_DEPENDENT is the fit type of a reference, never a value for kind/);
    });
    it("no ladder bullet starts with a line that mentions a fit-only word as if it were a kind; the check goes red on the pre-fix bullet", () => {
      const mentionsFitAsKind = (text: string) => /^ {2}- (?!LICENSE_DEPENDENT is the fit type)[^\n]*LICENSE_DEPENDENT/m.test(text);
      expect(mentionsFitAsKind(ladder)).toBe(false);
      expect(mentionsFitAsKind("  - INTEGRATION, or a LICENSE_DEPENDENT reference: per the cited references (a\n")).toBe(true);
    });
  });
}
