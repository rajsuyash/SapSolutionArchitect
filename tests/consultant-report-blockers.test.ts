import { describe, expect, it } from "vitest";
import { buildReport } from "../src/lib/consultant-report";
import { renderMarkdown } from "../src/lib/consultant-report-export";
import { REQUIREMENTS, STEPS, blockedReportData } from "./support/blocked-report-fixture";

const model = buildReport(blockedReportData);
const pageStrings = () => [...model.blockerGroups.flatMap(group => [group.category, group.action, ...group.entries.flatMap(entry =>
  [entry.label, ...entry.subjects.flatMap(subject => [subject.text, subject.detail])])]), model.statusCopy.detail];

describe("blocker groups", () => {
  it("fixture is as big as the live report", () => expect(model.blockers.length).toBeGreaterThan(40));
  it("group counts add up to the one total", () => {
    const total = model.blockerGroups.reduce((sum, group) => sum + group.count, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBe(model.blockers.length);
    expect(model.blockerGroups.every(group => group.count === group.entries.reduce((sum, entry) => sum + entry.subjects.length, 0))).toBe(true);
    expect(model.blockingGroups.reduce((sum, group) => sum + group.count, 0) + (model.reviewFindings?.count ?? 0)).toBe(model.blockers.length);
  });
  it("merges the eight unvalidated steps into one entry that lists every step", () => {
    const entry = model.blockerGroups.flatMap(group => group.entries).find(item => item.codes.includes("IMPLEMENTATION_UNVERIFIED"))!;
    expect(entry.subjects).toHaveLength(STEPS);
    expect(new Set(entry.subjects.map(subject => subject.anchor)).size).toBe(STEPS);
    expect(entry.subjects.map(subject => subject.text)).toContain("Step 8: Handle stage 8");
  });
  it("names a distinct requirement for each conditional-coverage blocker", () => {
    const entry = model.blockerGroups.flatMap(group => group.entries).find(item => item.codes.includes("COVERAGE_CONDITIONAL"))!;
    expect(entry.subjects).toHaveLength(REQUIREMENTS);
    expect(new Set(entry.subjects.map(subject => subject.text)).size).toBe(REQUIREMENTS);
    expect(entry.subjects[0]!.text).toMatch(/^Requirement 1: Requirement statement number 1/);
    expect(entry.subjects.some(subject => subject.text === "Design")).toBe(false);
  });
  it("labels the retained-system blocker instead of calling it Other, and keeps a genuinely unknown code as the fallback", () => {
    const labelOf = (code: string) => model.blockers.find(item => item.code === code)!;
    expect(labelOf("RETAINED_SYSTEM_UNCOVERED").category).not.toBe("Other");
    expect(labelOf("BRAND_NEW_CODE")).toMatchObject({ category: "Other", label: expect.stringMatching(/Review is needed/) });
  });
  it("splits review findings from blockers once, for the page and the Markdown", () => {
    expect(model.reviewFindings?.category).toBe("Review findings");
    expect(model.blockingGroups.map(group => group.category)).not.toContain("Review findings");
    const text = renderMarkdown(model);
    expect(text).toContain("## Blockers");
    expect(text).toContain("## Review findings");
    expect(text).toContain(model.blockingGroups[0]!.action);
    for (const item of model.blockers) expect(text).toContain(item.code);
  });
  it("tells the truth about who clears each group: no in-app step for SAP validation, a conversation step for discovery questions", () => {
    const action = (category: string) => model.blockerGroups.find(group => group.category === category)!;
    expect(action("SAP validation").linksBack).toBe(false);
    expect(action("SAP validation").action).toMatch(/SAP consultant/);
    expect(action("SAP validation").action).toMatch(/no verified SAP reference catalog/);
    expect(action("Open decisions").linksBack).toBe(true);
  });
  it("shows no system code and no draft path in any page-facing string", () => {
    for (const text of pageStrings()) {
      expect(text).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
      expect(text).not.toMatch(/draft\./);
    }
  });
});
