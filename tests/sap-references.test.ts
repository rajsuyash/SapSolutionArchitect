import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSapReferences } from "../src/lib/ai/sap-references";

const evidence = (over = {}) => ({ url: "https://help.sap.com/docs/synthetic", quote: "Synthetic quote", release: "2023", ...over });
const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id, capability: "Synthetic capability", fitType: "STANDARD", objects: ["Synthetic object"],
  verification: "VERIFIED", evidence: [evidence()], limitations: ["Synthetic limit"], ...over,
});
const catalog = (references: unknown[], over = {}) => ({
  schemaVersion: 1, targetProducts: ["S4HANA_CLOUD_PRIVATE", "S4HANA_ON_PREMISE"], targetRelease: "2023", references, ...over,
});

describe("trusted SAP reference loader", () => {
  let base: string;
  const put = async (dir: string, value: unknown) => {
    await mkdir(join(base, dir), { recursive: true });
    await writeFile(join(base, dir, "reference-catalog.json"), typeof value === "string" ? value : JSON.stringify(value));
  };
  beforeAll(async () => { base = await mkdtemp(join(tmpdir(), "sap-ref-")); });
  afterAll(async () => { await rm(base, { recursive: true, force: true }); });

  it("returns an empty list, not an error, when no catalog exists or the release is unusable", async () => {
    expect(await loadSapReferences("S4HANA_CLOUD_PRIVATE", "2023", { baseDir: base })).toEqual([]);
    expect(await loadSapReferences("S4HANA_CLOUD_PRIVATE", null, { baseDir: base })).toEqual([]);
    expect(await loadSapReferences("S4HANA_CLOUD_PRIVATE", "../../etc", { baseDir: base })).toEqual([]);
  });
  it("returns only VERIFIED entries with an official https sap.com URL and a non-empty quote for the release", async () => {
    await put("s4hana-2023", catalog([
      entry("REF-OK", { fitType: "CONFIGURATION" }),
      entry("REF-UNVERIFIED", { verification: "UNVERIFIED" }),
      entry("REF-HOST", { evidence: [evidence({ url: "https://notsap.com/x" })] }),
      entry("REF-LOOKALIKE", { evidence: [evidence({ url: "https://sap.com.evil.example/x" })] }),
      entry("REF-HTTP", { evidence: [evidence({ url: "http://help.sap.com/x" })] }),
      entry("REF-QUOTE", { evidence: [evidence({ quote: "   " })] }),
      entry("REF-RELEASE", { evidence: [evidence({ release: "2022" })] }),
      entry("REF-MIXED", { evidence: [evidence({ url: "https://blog.example/x" }), evidence({ quote: "Second quote" })] }),
    ]));
    const refs = await loadSapReferences("S4HANA_CLOUD_PRIVATE", "2023", { baseDir: base });
    expect(refs.map(ref => ref.id)).toEqual(["REF-OK", "REF-MIXED"]);
    expect(refs[0]).toMatchObject({ targetProduct: "S4HANA_CLOUD_PRIVATE", targetRelease: "2023", status: "VERIFIED",
      fitType: "CONFIGURATION", objects: ["Synthetic object"], evidenceUrls: ["https://help.sap.com/docs/synthetic"] });
    expect(refs[1]!.evidence).toBe("Second quote");
  });
  it("does not serve a catalog to a product it does not cover", async () => {
    expect(await loadSapReferences("S4HANA_CLOUD_PUBLIC", "2023", { baseDir: base })).toEqual([]);
  });
  it.each([
    ["invalid JSON", "{not json"],
    ["unknown field", catalog([entry("REF-1", { extra: true })])],
    ["bad fit type", catalog([entry("REF-1", { fitType: "MAGIC" })])],
    ["bad id", catalog([entry("bad id!")])],
    ["duplicate id", catalog([entry("REF-1"), entry("REF-1")])],
    ["wrong release for directory", catalog([entry("REF-1")], { targetRelease: "2022" })],
    ["no evidence", catalog([entry("REF-1", { evidence: [] })])],
  ])("throws for a malformed catalog: %s", async (_name, value) => {
    await put("s4hana-2023", value);
    await expect(loadSapReferences("S4HANA_CLOUD_PRIVATE", "2023", { baseDir: base })).rejects.toThrow("SAP_REFERENCE_CATALOG_INVALID");
  });
});
