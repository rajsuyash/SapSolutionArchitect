// Shared by scripts/run-tobe.ts and scripts/report-to-judge.ts: reading a saved production To-Be report (the ReportData that
// ConsultantJobs.report returns) and, when needed, rebuilding the DiscoveryInput the To-Be stage was run on.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateDiscovery, type DiscoveryInput } from "../src/lib/discovery";
import { WORKSPACE_FIELDS } from "../src/lib/workspace-fields";

export const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
export const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The slice of a production report both scripts rely on. Unknown keys are kept; the discovery is validated later. */
export type ReportLike = {
  jobId?: string | null; project: { name: string; clientName: string }; variant: { code: string; name: string };
  targetProduct: "S4HANA_CLOUD_PUBLIC" | "S4HANA_CLOUD_PRIVATE" | "S4HANA_ON_PREMISE"; targetRelease: string | null;
  sourceRevision?: number | null; snapshotId?: string | null; generatedAt?: string | null;
  discovery: { asIsSteps: DiscoveryInput["asIsSteps"]; requirements: DiscoveryInput["requirements"]; conflicts: DiscoveryInput["conflicts"];
    openQuestions: DiscoveryInput["openQuestions"]; sources: { id: string; title: string; locator: string; revision: string; digest?: string; text?: string }[] };
  design: Record<string, unknown>; blockers?: { code: string; path: string; detail?: string }[];
};
/** The slice of a saved workspace state (the API view lacks `sources`, so they are rebuilt from messages). */
export type StateLike = { revision?: number; problemStatement: string; messages: { id: string; text: string }[];
  facts: { id: string; status: string; value: string | null; evidence: { sourceId: string; quote: string } | null }[] };

export function loadReport(path: string): ReportLike {
  const raw = readJson(path) as Partial<ReportLike>;
  if (!raw?.discovery?.asIsSteps || !raw.project || !raw.variant || !raw.targetProduct || typeof raw.design !== "object") {
    throw new Error(`${path} is not a production To-Be report (needs project, variant, targetProduct, discovery and design)`);
  }
  return raw as ReportLike;
}

/** Source text is what a report leaves out (it keeps a digest). The initial problem is the state's problemStatement and a message source
 * is the message with the same id; every rebuilt text is checked against the report's digest, so a state from another revision fails loudly. */
function sourceText(source: ReportLike["discovery"]["sources"][number], state: StateLike): string {
  if (source.text !== undefined) return source.text;
  const text = source.locator === "Initial problem" ? state.problemStatement : state.messages.find(m => m.id === source.id)?.text;
  if (text === undefined) throw new Error(`Cannot rebuild the text of source ${source.id} (${source.locator}) from the state`);
  if (source.digest && sha256(text) !== source.digest) throw new Error(`Rebuilt text of source ${source.id} does not match the report digest: wrong state revision?`);
  return text;
}

/** The DiscoveryInput a report's To-Be was generated from. companyContext is rebuilt from the state's KNOWN facts exactly as compileDiscovery does. */
export function rebuildDiscovery(report: ReportLike, state: StateLike | null): { discovery: DiscoveryInput; digestsVerified: number } {
  const needsText = report.discovery.sources.some(source => source.text === undefined);
  if (needsText && !state) throw new Error("The report keeps only source digests, not source text: pass --state <workspace state.json> (any revision whose digests match)");
  let digestsVerified = 0;
  const sources = report.discovery.sources.map(source => {
    const text = sourceText(source, state!);
    if (source.digest) digestsVerified++;
    return { id: source.id, title: source.title, revision: source.revision, locator: source.locator, text };
  });
  const companyContext = (state?.facts ?? []).flatMap(fact => {
    const def = WORKSPACE_FIELDS.find(field => field.id === fact.id);
    return fact.status === "KNOWN" && fact.value && fact.evidence && def
      ? [{ fieldId: fact.id as NonNullable<DiscoveryInput["companyContext"]>[number]["fieldId"], label: def.label, value: fact.value, evidence: fact.evidence }] : [];
  });
  const discovery = validateDiscovery({ schemaVersion: 1, variantName: report.variant.name, targetRelease: report.targetRelease, sources,
    asIsSteps: report.discovery.asIsSteps, requirements: report.discovery.requirements, conflicts: report.discovery.conflicts,
    openQuestions: report.discovery.openQuestions, ...(companyContext.length && { companyContext }) });
  return { discovery, digestsVerified };
}
