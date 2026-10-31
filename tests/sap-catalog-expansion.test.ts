import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSapReferences } from "../src/lib/ai/sap-references";

// Fourth pass (2026-10-23): production planning, quality management, project system and payment run coverage.
const BASELINE_VERIFIED = 65;
const AREAS = ["PP", "QM", "PS", "CO", "FI"] as const;
const NEW_PREFIX = /^S4-2023-(PP|QM|PS)-|^S4-2023-CO-SALES-ORDER-RESULTS-ANALYSIS$|^S4-2023-FI-(AUTOMATIC-PAYMENT-PROGRAM|PAYMENT-PROPOSAL-REVISE)$/;
const OFFICIAL = /^https:\/\/(help\.sap\.com|fioriappslibrary\.hana\.ondemand\.com|me\.sap\.com)\//;
const file = join(process.cwd(), "fixtures", "sap", "s4hana-2023", "reference-catalog.json");

describe("SAP catalog expansion (PP, QM, PS, F110)", () => {
  it("loads more VERIFIED references than the 65 of the previous pass, each with official evidence", async () => {
    const refs = await loadSapReferences("S4HANA_CLOUD_PRIVATE", "2023");
    const added = refs.filter(ref => NEW_PREFIX.test(ref.id));
    expect(refs.length).toBe(BASELINE_VERIFIED + added.length);
    expect(added.length).toBeGreaterThanOrEqual(25);
    for (const area of AREAS) expect(added.some(ref => ref.id.startsWith(`S4-2023-${area}-`))).toBe(true);
    for (const ref of added) {
      expect(ref.evidence.trim().length, ref.id).toBeGreaterThan(0);
      const urls = ref.evidenceUrls ?? [];
      expect(urls.length, ref.id).toBeGreaterThan(0);
      for (const url of urls) expect(url, ref.id).toMatch(OFFICIAL);
    }
  });
  it("names the automatic payment run transaction F110 and the core PP, QM and PS objects", async () => {
    const refs = await loadSapReferences("S4HANA_CLOUD_PRIVATE", "2023");
    const objects = (id: string) => refs.find(ref => ref.id === id)?.objects?.join(" | ") ?? "";
    expect(objects("S4-2023-FI-AUTOMATIC-PAYMENT-PROGRAM")).toMatch(/F110/);
    expect(objects("S4-2023-QM-USAGE-DECISION")).toMatch(/QA11/);
    expect(objects("S4-2023-PP-MRP-LIVE")).toMatch(/MD01N/);
    expect(objects("S4-2023-PS-PROJECT-STRUCTURE")).toMatch(/Project Builder/);
  });
  it("keeps every quote short, every release label 2023 and every id unique", async () => {
    const catalog = JSON.parse(await readFile(file, "utf8")) as { references: { id: string; verification: string; evidence: { quote: string; release: string }[] }[] };
    const ids = catalog.references.map(ref => ref.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const ref of catalog.references.filter(item => NEW_PREFIX.test(item.id))) {
      expect(ref.verification, ref.id).toBe("VERIFIED");
      for (const item of ref.evidence) {
        expect(item.release, ref.id).toBe("2023");
        expect(item.quote.split(/\s+/).length, ref.id).toBeLessThanOrEqual(25);
      }
    }
  });
});
