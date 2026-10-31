import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReleaseSelect } from "../src/app/discovery-fields";
import { loadSapReferences } from "../src/lib/ai/sap-references";
import { registerRequest, runDesign, stepRequest } from "../src/lib/ai/to-be-pipeline";
import { CATALOG_RELEASES, noCatalogNote } from "../src/lib/sap-releases";
import { buildCaseBrief, buildSystemPrompt, RUBRIC } from "../src/lib/eval-judge";
import { loadExpert } from "./support/expert-control";
import { readFileSync } from "node:fs";

const EVAL_CASES = ["pump-o2c", "services-r2r", "engineering-mto", "pharma-p2p"];

describe("target release and the verified SAP catalog", async () => {
  const expert = await loadExpert("pump-o2c");
  const privateInput = { ...expert.input, targetProduct: "S4HANA_CLOUD_PRIVATE" as const };
  const references = await loadSapReferences("S4HANA_CLOUD_PRIVATE", "2023");
  const outline = { processName: "x", steps: [], coverage: [], conflictDecisions: [], openQuestions: [] } as never;
  const step = { requirementIds: [], asIsStepIds: [], implementation: { referenceIds: [] } } as never;

  it("every release the UI offers has a loadable catalog with references", async () => {
    for (const release of CATALOG_RELEASES) {
      expect((await loadSapReferences("S4HANA_CLOUD_PRIVATE", release)).length, release).toBeGreaterThan(0);
      expect((await loadSapReferences("S4HANA_ON_PREMISE", release)).length, release).toBeGreaterThan(0);
    }
  });

  it("the release select offers the catalog releases and not-decided, and keeps an unknown saved value visible", () => {
    const html = (value: string | null) => renderToStaticMarkup(createElement(ReleaseSelect, { id: "r", value, change: () => undefined }));
    expect(html(null)).toContain("Not decided");
    expect(html(null)).toContain(">2023 (verified SAP reference catalog)<");
    expect(html("2023").match(/<option/g)).toHaveLength(2);
    expect(html("2025 FPS01")).toContain("2025 FPS01 (no verified SAP reference catalog)");
  });

  it("outline, step and register payloads say so when no verified catalog exists, and stay silent when one does", async () => {
    const note = noCatalogNote("S4HANA_CLOUD_PUBLIC", "2023");
    expect(note).toBe("no verified SAP catalog for S4HANA_CLOUD_PUBLIC 2023; every SAP claim must be NEEDS_VALIDATION");
    expect(stepRequest(expert.input, [], outline, step, [])).toMatchObject({ catalogNote: note });
    expect(registerRequest(expert.input, [], outline, "decisions" as never, [])).toMatchObject({ catalogNote: note });
    expect(stepRequest(privateInput, references, outline, step, [])).not.toHaveProperty("catalogNote");
    expect(registerRequest(privateInput, references, outline, "decisions" as never, [])).not.toHaveProperty("catalogNote");
    const asked: Record<string, unknown>[] = [];
    await runDesign(expert.input, [], { parallelism: 1, invalid: () => new Error("stop"), record: () => undefined,
      ask: async (_substage, user) => { asked.push(user as Record<string, unknown>); throw new Error("stop"); } }).catch(() => undefined);
    expect(asked[0]).toMatchObject({ catalogNote: note });
    asked.length = 0;
    await runDesign(privateInput, references, { parallelism: 1, invalid: () => new Error("stop"), record: () => undefined,
      ask: async (_substage, user) => { asked.push(user as Record<string, unknown>); throw new Error("stop"); } }).catch(() => undefined);
    expect(asked[0]).not.toHaveProperty("catalogNote");
  });

  it("all four eval fixtures carry a release; product-with-catalog cases resolve references, public cloud cases measure the no-catalog path", async () => {
    for (const id of EVAL_CASES) {
      const { project } = JSON.parse(readFileSync(`fixtures/eval/${id}.json`, "utf8")) as { project: { targetProduct: "S4HANA_CLOUD_PUBLIC" | "S4HANA_CLOUD_PRIVATE"; targetRelease: string } };
      expect(project.targetRelease, id).toBe("2023");
      const count = (await loadSapReferences(project.targetProduct, project.targetRelease)).length;
      expect(count > 0, id).toBe(project.targetProduct === "S4HANA_CLOUD_PRIVATE");
    }
  });

  it("the judge brief carries target product, release and the verified reference count, and the judge is told what zero means", () => {
    const fixture = JSON.parse(readFileSync("fixtures/eval/pump-o2c.json", "utf8"));
    expect(buildCaseBrief(fixture, 0).sapCatalog).toEqual({ targetProduct: "S4HANA_CLOUD_PUBLIC", targetRelease: "2023", verifiedReferences: 0 });
    expect(buildCaseBrief(fixture).sapCatalog.verifiedReferences).toBeNull();
    expect(buildSystemPrompt(RUBRIC)).toContain("verifiedReferences is how many verified SAP references");
  });
});
