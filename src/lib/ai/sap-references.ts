import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { FIT_TYPES, type DesignContext } from "./design-quality";

const text = z.string().max(2000);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const EvidenceSchema = z.strictObject({ url: z.string().max(500), quote: text, release: z.string().max(40) });
const EntrySchema = z.strictObject({
  id, capability: z.string().trim().min(1).max(500), fitType: z.enum(FIT_TYPES),
  objects: z.array(z.string().trim().min(1).max(300)).min(1).max(50),
  verification: z.enum(["VERIFIED", "UNVERIFIED"]),
  evidence: z.array(EvidenceSchema).min(1).max(5),
  limitations: z.array(z.string().trim().min(1).max(1000)).max(50),
});
/** Curated, version-controlled file. Trust comes from reviewing this file,
 * never from model output, source notes or client payloads. */
const CatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  targetProducts: z.array(z.enum(["S4HANA_CLOUD_PUBLIC", "S4HANA_CLOUD_PRIVATE", "S4HANA_ON_PREMISE"])).min(1),
  targetRelease: z.string().trim().min(1).max(40),
  references: z.array(EntrySchema).max(500),
});

type Product = DesignContext["targetProduct"];
export type SapReferenceOptions = { baseDir?: string };
// Runtime resolution: a static URL would make the bundler treat the directory as an asset.
const defaultBase = () => join(/* turbopackIgnore: true */ process.cwd(), "fixtures", "sap");
// ponytail: private cloud and on-premise share one documentation line; add a mapping row per new edition.
const FAMILY: Record<Product, string> = {
  S4HANA_CLOUD_PUBLIC: "s4hana-cloud-public", S4HANA_CLOUD_PRIVATE: "s4hana", S4HANA_ON_PREMISE: "s4hana",
};

function officialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "sap.com" || url.hostname.endsWith(".sap.com"));
  } catch { return false; }
}

/** Load VERIFIED references for the exact product and release. A missing
 * catalog yields [] (every SAP claim then stays NEEDS_VALIDATION); a malformed
 * one throws rather than silently granting or hiding trust. */
export async function loadSapReferences(product: Product, release: string | null,
  options: SapReferenceOptions = {}): Promise<DesignContext["references"]> {
  const slug = release?.trim().toLowerCase() ?? "";
  // Release text comes from client-saved discovery: never let it shape a path.
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(slug) || slug.includes("..")) return [];
  const file = join(options.baseDir ?? defaultBase(), `${FAMILY[product]}-${slug}`, "reference-catalog.json");
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("SAP_REFERENCE_CATALOG_INVALID");
  }
  let catalog: z.infer<typeof CatalogSchema>;
  try { catalog = CatalogSchema.parse(JSON.parse(raw)); }
  catch { throw new Error("SAP_REFERENCE_CATALOG_INVALID"); }
  if (new Set(catalog.references.map(entry => entry.id)).size !== catalog.references.length ||
      catalog.targetRelease.trim().toLowerCase() !== slug) throw new Error("SAP_REFERENCE_CATALOG_INVALID");
  if (!catalog.targetProducts.includes(product)) return [];
  const targetRelease = catalog.targetRelease.trim();
  return catalog.references.flatMap(entry => {
    if (entry.verification !== "VERIFIED") return [];
    const support = entry.evidence.filter(item => item.release.trim() === targetRelease && item.quote.trim() && officialUrl(item.url));
    if (!support.length) return [];
    return [{
      id: entry.id, targetProduct: product, targetRelease, status: "VERIFIED" as const,
      evidence: support.map(item => item.quote.trim()).join("\n"), fitType: entry.fitType,
      capability: entry.capability, objects: entry.objects, limitations: entry.limitations,
      evidenceUrls: support.map(item => item.url),
    }];
  });
}
