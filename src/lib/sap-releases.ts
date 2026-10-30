/** Releases for which a curated, version-controlled reference catalog exists (fixtures/sap/<family>-<release>/).
 * Client-safe: the UI offers exactly these plus "not decided". Add a release here in the same change as its catalog. */
export const CATALOG_RELEASES = ["2023"] as const;

/** "<product> <release>" for a sentence. Some stored releases already begin with the product name; it is then not repeated. */
export const productRelease = (product: string, release: string | null, none = "(release not decided)") =>
  !release ? `${product} ${none}` : release.toLowerCase().startsWith(product.toLowerCase()) ? release : `${product} ${release}`;

/** Sent to the model, and shown on the report, when the project's product and release have no verified catalog. */
export const noCatalogNote = (product: string, release: string | null) =>
  `no verified SAP catalog for ${productRelease(product, release, "UNKNOWN")}; every SAP claim must be NEEDS_VALIDATION`;
