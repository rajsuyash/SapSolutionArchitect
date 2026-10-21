import { createHash } from "node:crypto";
import { z } from "zod";
import { AuthError } from "../auth";
import { DiscoveryInputSchema, validateDiscovery, type createDiscoveryRepository } from "../discovery";
import { DetailedDesignSchema, evaluateDesign, type DesignContext, type DesignEvaluation, type DetailedDesign } from "./design-quality";
import { loadSapReferences, type SapReferenceOptions } from "./sap-references";
import type { ValidationIssue } from "./problem-analysis";
import type { StageMetrics } from "./runStage";

const InputSchema = z.strictObject({
  targetProduct: z.enum(["S4HANA_CLOUD_PUBLIC", "S4HANA_CLOUD_PRIVATE", "S4HANA_ON_PREMISE"]),
  discovery: DiscoveryInputSchema,
  // Evaluation-only guidance for the model. Neither is an approval or a trusted reference.
  sharedRules: z.string().trim().min(1).max(20000).optional(),
  decisionRegister: z.array(z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), topic: z.string().trim().min(1).max(1000),
    owner: z.string().trim().min(1).max(200),
    affectedStepIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(100),
  })).max(100).optional(),
});
export type ToBeInput = z.infer<typeof InputSchema>;
export type ToBeOutput = {
  design: DetailedDesign; evaluation: DesignEvaluation;
  unresolvedInputQuestions: ToBeInput["discovery"]["openQuestions"];
};
const sensitive = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b|\b(?:Bearer\s+\S+|(?:password|api[_ -]?key|secret|token)\s*[:=]\s*\S+)/i;

/** Internal allowlist. Preserve evidence exactly; reject sensitive input rather
 * than rewriting quotes or silently truncating a business requirement. */
export function parseToBeInput(raw: unknown): ToBeInput {
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) throw new Error("INVALID_DISCOVERY_INPUT");
  const input = parsed.data;
  validateDiscovery(input.discovery);
  if (sensitive.test(JSON.stringify(input))) throw new Error("SENSITIVE_DISCOVERY_INPUT");
  return input;
}

/** Trusted references come only from the curated catalog for this product and release. */
export function loadToBeReferences(input: ToBeInput, options: SapReferenceOptions = {}) {
  return loadSapReferences(input.targetProduct, input.discovery.targetRelease, options);
}

export function toBeContext(input: ToBeInput, references: DesignContext["references"] = []): DesignContext {
  const discovery = input.discovery;
  return {
    targetProduct: input.targetProduct, targetRelease: discovery.targetRelease ?? "UNKNOWN",
    asIsSteps: discovery.asIsSteps.map(({ id, name }) => ({ id, name })),
    sources: discovery.sources.map(({ id, locator, text }) => ({ id, locator, text })),
    requirements: discovery.requirements.map(({ id, asIsStepId, critical, evidence }) =>
      ({ id, asIsStepId, critical, ...evidence })),
    conflicts: discovery.conflicts,
    // No approved-decision workflow exists yet; source notes and sharedRules/decisionRegister
    // cannot confer approval. References are trusted only via the curated catalog.
    approvedDecisions: [], references,
    ...(input.decisionRegister && { decisionRegister: input.decisionRegister.map(({ id }) => ({ id })) }),
  };
}

export function validateToBeOutput(input: ToBeInput, raw: unknown, references: DesignContext["references"] = []):
  { success: true; data: ToBeOutput } | { success: false; errors: ValidationIssue[] } {
  const evaluation = evaluateDesign(toBeContext(input, references), raw);
  if (!evaluation.structurallyValid) return { success: false, errors: evaluation.errors.slice(0, 30) };
  const design = DetailedDesignSchema.parse(raw);
  // Model omission cannot erase a business question or its assigned owner.
  const unresolvedInputQuestions = input.discovery.openQuestions;
  evaluation.blockers.push(...unresolvedInputQuestions.map((_, i) =>
    ({ code: "INPUT_QUESTION_UNRESOLVED", path: `input.openQuestions.${i}` })));
  if (evaluation.blockers.length) evaluation.reviewStatus = "BLOCKED";
  return { success: true, data: { design, evaluation, unresolvedInputQuestions } };
}

const RequestSchema = z.strictObject({
  projectId: z.uuid(), snapshotId: z.uuid(), variantCode: z.string().regex(/^[A-Z][A-Z0-9_-]{0,39}$/),
  version: z.number().int().min(1).max(2147483647),
});
type Generate = (input: unknown, signal?: AbortSignal) => Promise<{ payload: ToBeOutput; metrics: StageMetrics }>;

/** Server service for the future durable job boundary, not an HTTP handler.
 * Caller supplies identifiers only; content/product come from the authorized,
 * immutable revision. No result is approved or persisted by this service. */
export function createToBeGenerator(discovery: Pick<ReturnType<typeof createDiscoveryRepository>, "get">, generate: Generate, options: SapReferenceOptions = {}) {
  return async (token: string | null, rawRequest: unknown, signal?: AbortSignal) => {
    const parsed = RequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new AuthError("INVALID_DISCOVERY", 400, "Choose a saved discovery revision");
    const request = parsed.data;
    signal?.throwIfAborted();
    const load = () => discovery.get(token, request.projectId, request.variantCode, request.version);
    const { snapshot, canEdit } = await load();
    if (!snapshot || snapshot.id !== request.snapshotId || snapshot.version !== request.version ||
        snapshot.variantCode !== request.variantCode) throw new AuthError("DISCOVERY_NOT_FOUND", 404, "Discovery revision not found");
    if (!canEdit) throw new AuthError("FORBIDDEN", 403, "Only project leads and consultants can generate a design");
    const input = parseToBeInput({ targetProduct: snapshot.targetProduct, discovery: snapshot.input });
    const digests = Object.fromEntries(input.discovery.sources.map(source =>
      [source.id, createHash("sha256").update(source.text, "utf8").digest("hex")]));
    if (Object.keys(digests).length !== Object.keys(snapshot.sourceDigests).length ||
        Object.entries(digests).some(([id, digest]) => snapshot.sourceDigests[id] !== digest)) {
      throw new AuthError("DISCOVERY_INTEGRITY_ERROR", 409, "The saved source revision could not be verified");
    }
    const references = await loadToBeReferences(input, options);
    const result = await generate(input, signal);
    signal?.throwIfAborted();
    const validated = validateToBeOutput(input, result.payload.design, references);
    if (!validated.success) throw new Error("AI_INVALID_OUTPUT");
    // Recheck membership before exposing output if access changed during the call.
    const access = await load();
    if (!access.canEdit || access.snapshot?.id !== snapshot.id) throw new AuthError("FORBIDDEN", 403, "Project access changed");
    signal?.throwIfAborted();
    return { ...validated.data, metrics: result.metrics,
      sourceRevision: { id: snapshot.id, variantCode: snapshot.variantCode, version: snapshot.version,
        targetProduct: input.targetProduct, targetRelease: input.discovery.targetRelease, sourceDigests: digests },
    };
  };
}
