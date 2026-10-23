/** Releases for which a curated, version-controlled reference catalog exists (fixtures/sap/<family>-<release>/).
 * Client-safe: the UI offers exactly these plus "not decided". Add a release here in the same change as its catalog. */
export const CATALOG_RELEASES = ["2023"] as const;

/** Sent to the model, and shown on the report, when the project's product and release have no verified catalog. */
export const noCatalogNote = (product: string, release: string | null) =>
  `no verified SAP catalog for ${product} ${release ?? "UNKNOWN"}; every SAP claim must be NEEDS_VALIDATION`;
