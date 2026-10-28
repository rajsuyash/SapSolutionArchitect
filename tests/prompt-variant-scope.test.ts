import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const prompt = (name: string) => readFileSync(new URL(`../prompts/${name}.system.md`, import.meta.url), "utf8");

describe("questions and extracted steps stay inside the variant's recorded scope", () => {
  it("interview prompt: process and step questions follow scope_boundary, or the variant name and problem while it is empty", () => {
    const text = prompt("discovery_interview");
    expect(text).toContain("scope_boundary");
    expect(text).toContain("variant name and problem statement");
    expect(text).toContain("order-to-cash");
    expect(text).toContain("hands over to or from this process");
  });
  it("extraction prompt: a proposed step is an activity inside the recorded scope; upstream and downstream activity is context only", () => {
    const text = prompt("discovery_extraction");
    expect(text).toContain("scope_boundary");
    expect(text).toContain("inside this variant's recorded scope");
    expect(text).toContain("not steps of this variant");
    expect(text).toContain("external parties");
  });
});
