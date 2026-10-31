import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IMPLEMENTATION_KINDS } from "../src/lib/ai/design-quality";
import { FIT_CLASSES } from "../src/lib/ai/design-registers";
import { RegisterGroupSchemas } from "../src/lib/ai/design-registers";

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

describe("prompts/to_be_registers.system.md fit-gap classes", () => {
  const prompt = readFileSync("prompts/to_be_registers.system.md", "utf8");
  const section = prompt.slice(prompt.indexOf("classification, in the order you must prefer:"), prompt.indexOf("justification says why this class"));
  // A class entry is a numbered line that opens with a class word: "3. STANDARD_INTEGRATION: ..."
  const heads = [...section.matchAll(/^\d+\. ([A-Z_]+):/gm)].map(match => match[1]!);
  it("lists exactly the FIT_CLASSES enum, in order, and finds something (a parse that finds nothing proves nothing)", () => {
    expect(heads.length).toBeGreaterThanOrEqual(6);
    expect(heads).toEqual([...FIT_CLASSES]);
  });
  it("the enum in the fit-gap tool schema is the same list, and an integration through a released API has a class of its own", () => {
    const classes = (RegisterGroupSchemas.fitgap.shape.fitGap.element as unknown as { shape: { classification: { options: string[] } } }).shape.classification.options;
    expect(classes).toEqual([...FIT_CLASSES]);
    expect(section).toMatch(/STANDARD_INTEGRATION[^]*released\s+standard SAP API/);
    expect(section).toMatch(/INTEGRATION\s+maps here/);
  });
  it("the check goes red on an invented class", () => {
    expect([...heads, "INTEGRATION"]).not.toEqual([...FIT_CLASSES]);
  });
});
