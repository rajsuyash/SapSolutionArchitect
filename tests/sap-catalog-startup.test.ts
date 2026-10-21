import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logSapCatalogs, verifySapCatalogs } from "../src/lib/ai/sap-catalog-startup";

const made: string[] = [];
async function scratch() { const dir = await mkdtemp(join(tmpdir(), "sap-catalogs-")); made.push(dir); return dir; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("SAP catalog startup check", () => {
  it("reports a verified count per product for the repository catalogs", async () => {
    const result = await verifySapCatalogs(join(process.cwd(), "fixtures", "sap"));
    expect(result.catalogs.length).toBeGreaterThan(0);
    expect(result.catalogs.every(catalog => catalog.verified > 0)).toBe(true);
    expect(result.catalogs.map(catalog => catalog.product)).toContain("S4HANA_CLOUD_PRIVATE");
    expect(result.degraded).toBe(false);
  });
  it("fails fast when the directory is missing or is a file", async () => {
    const dir = await scratch();
    await expect(verifySapCatalogs(join(dir, "nope"))).rejects.toThrow(/SAP reference directory not found/);
    await writeFile(join(dir, "file"), "x");
    await expect(verifySapCatalogs(join(dir, "file"))).rejects.toThrow(/not found/);
  });
  it("fails fast on a malformed catalog instead of running without trust", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "s4hana-2023"));
    await writeFile(join(dir, "s4hana-2023", "reference-catalog.json"), "{ not json");
    await expect(verifySapCatalogs(dir)).rejects.toThrow("SAP_REFERENCE_CATALOG_INVALID");
  });
  it("logs one structured warning when no catalog exists and info when all are populated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const empty = await scratch();
    await logSapCatalogs(empty);
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({ event: "sap_reference_catalogs", level: "warn", baseDir: empty, catalogs: [] });
    expect(info).not.toHaveBeenCalled();
    await logSapCatalogs(join(process.cwd(), "fixtures", "sap"));
    expect(JSON.parse(info.mock.calls[0]![0] as string)).toMatchObject({ level: "info", baseDir: join(process.cwd(), "fixtures", "sap") });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
