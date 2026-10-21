import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadSapReferences } from "./sap-references";
import type { DesignContext } from "./design-quality";

type Product = DesignContext["targetProduct"];
// Mirrors the directory naming in sap-references.ts (which keeps its mapping private).
const FAMILIES: Record<string, Product[]> = {
  "s4hana-cloud-public": ["S4HANA_CLOUD_PUBLIC"], "s4hana": ["S4HANA_CLOUD_PRIVATE", "S4HANA_ON_PREMISE"] };
export type CatalogReport = { directory: string; product: Product; release: string; verified: number };

/** loadSapReferences answers [] when the working directory is wrong, which silently turns every SAP claim into
 * "needs validation". Resolve the directory once at startup, fail if it is absent, and report what each catalog yields. */
export async function verifySapCatalogs(baseDir = join(process.cwd(), "fixtures", "sap")) {
  const info = await stat(baseDir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`SAP reference directory not found at ${baseDir}. Start the worker from the project root.`);
  const catalogs: CatalogReport[] = [];
  for (const entry of (await readdir(baseDir, { withFileTypes: true })).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const match = /^(s4hana-cloud-public|s4hana)-(.+)$/.exec(entry.name);
    if (!match || !(await stat(join(baseDir, entry.name, "reference-catalog.json")).catch(() => null))?.isFile()) continue;
    for (const product of FAMILIES[match[1]!]!) {
      // A malformed catalog throws here, so the worker refuses to start rather than run with silently missing trust.
      catalogs.push({ directory: entry.name, product, release: match[2]!, verified: (await loadSapReferences(product, match[2]!, { baseDir })).length });
    }
  }
  const degraded = catalogs.length === 0 || catalogs.some(catalog => catalog.verified === 0);
  return { baseDir, catalogs, degraded };
}

/** One structured line: a warning when a catalog is missing or empty, otherwise informational. */
export async function logSapCatalogs(baseDir?: string) {
  const result = await verifySapCatalogs(baseDir);
  const { degraded, ...fields } = result;
  (degraded ? console.warn : console.info)(JSON.stringify({ event: "sap_reference_catalogs", level: degraded ? "warn" : "info", ...fields,
    ...(result.catalogs.length === 0 ? { note: "No reference catalogs found: every SAP claim will stay NEEDS_VALIDATION." } : {}) }));
  return result;
}
