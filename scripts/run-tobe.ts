// Run the production To-Be stage locally on a saved, confirmed discovery, then (separately) score it with scripts/eval-judge.ts.
//
//   node --import tsx scripts/run-tobe.ts --report <report.json> [--state <workspace state.json>] [--out <file>]
//     [--provider openrouter|deepinfra|anthropic|stub] [--model <id>] [--fallback-provider <p>] [--fallback-model <id>] [--capture-raw] [--replay]
//   --replay makes no model call: it re-validates the report's saved design through the same validation/derivation/output path.
//
// The same stage runner production uses (createStageRunner + runStage("to_be") + loadToBeReferences + validateToBeOutput), configured from
// process.env through parseEnvironment: AI_PROVIDER, AI_MODEL, AI_MODEL_DESIGN, AI_FALLBACK_*, AI_*_BUDGET/TIMEOUT/MAX_TOKENS, AI_NO_THINKING_STAGES,
// AI_REASONING_EFFORT, the provider key. Flags override: --model sets AI_MODEL and AI_MODEL_DESIGN, --fallback-model sets AI_FALLBACK_MODEL and
// AI_FALLBACK_MODEL_DESIGN. Values are read from an existing .env (never overriding the real environment), then .env.example fills what is still unset
// (database/auth variables the schema demands but this script never uses: no database is opened). Key values are never printed.
//
// A production report keeps source digests, not source text, so --state is needed to rebuild the DiscoveryInput; every rebuilt source is checked
// against the report's digest. The output file has the shape eval-judge.ts --run accepts, plus input/metrics/job. Exits 1 when the To-Be failed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseEnv } from "node:util";
import { AIStageError, createStageRunner, type StageMetrics } from "../src/lib/ai/runStage";
import { parseEnvironment } from "../src/lib/env";
import { loadToBeReferences, parseToBeInput, validateToBeOutput } from "../src/lib/ai/to-be";
import { reviewBlockers, type ReviewOutcome } from "../src/lib/ai/to-be-review";
import { verifySapCatalogs } from "../src/lib/ai/sap-catalog-startup";
import { jobTiming } from "../src/lib/ai/timeouts";
import { REVIEW_FINDINGS } from "../src/lib/consultant-report";
import { deriveSections } from "../src/lib/to-be-derived";
import { toBeRun, toBeSummary } from "../src/lib/eval-tobe";
import { TranscriptSchema, type Transcript } from "../src/lib/eval-score";
import { flag, loadReport, readJson, rebuildDiscovery, sha256, type StateLike } from "./tobe-input";

const PROVIDERS = ["openrouter", "deepinfra", "anthropic", "stub"] as const;
const FALLBACK_PROVIDERS = ["openrouter", "deepinfra", "anthropic"] as const;
const KEY_NAMES = { anthropic: "ANTHROPIC_API_KEY", deepinfra: "DEEPINFRA_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
const has = (name: string) => process.argv.includes(`--${name}`);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const oneOf = <T extends string>(name: string, allowed: readonly T[]): T | undefined => {
  const value = flag(name);
  if (value !== undefined && !(allowed as readonly string[]).includes(value)) throw new Error(`--${name} must be one of ${allowed.join("|")}`);
  return value as T | undefined;
};

/** Real environment wins, then .env, then .env.example (defaults for variables the schema requires but this script does not use). */
function loadEnvironment() {
  for (const file of [".env", ".env.example"]) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
  }
  const provider = oneOf("provider", PROVIDERS), fallback = oneOf("fallback-provider", FALLBACK_PROVIDERS);
  const model = flag("model"), fallbackModel = flag("fallback-model");
  if (provider) process.env.AI_PROVIDER = provider;
  if (model) { process.env.AI_MODEL = model; process.env.AI_MODEL_DESIGN = model; }
  if (fallback) process.env.AI_FALLBACK_PROVIDER = fallback;
  if (fallbackModel) { process.env.AI_FALLBACK_MODEL = fallbackModel; process.env.AI_FALLBACK_MODEL_DESIGN = fallbackModel; }
  return parseEnvironment();
}

const costUsd = (config: ReturnType<typeof parseEnvironment>, model: string, input: number, output: number) => {
  const [inputPrice, outputPrice] = Object.hasOwn(config.AI_MODEL_PRICES, model) ? config.AI_MODEL_PRICES[model]!
    : [config.AI_PRICE_INPUT_USD_PER_MTOK, config.AI_PRICE_OUTPUT_USD_PER_MTOK];
  return Number(((input * inputPrice + output * outputPrice) / 1e6).toFixed(4));
};

async function main() {
  const reportPath = flag("report");
  if (!reportPath) throw new Error("Usage: node --import tsx scripts/run-tobe.ts --report <report.json> [--state <state.json>] [--out <file>] [--provider ..] [--model ..]");
  const config = loadEnvironment();
  const keyName = config.AI_PROVIDER === "stub" ? null : KEY_NAMES[config.AI_PROVIDER];
  if (keyName && !config[keyName]?.trim()) throw new Error(`${keyName} is not set (provider ${config.AI_PROVIDER}); use --provider stub for an offline wiring check`);
  if (config.AI_FALLBACK_PROVIDER && !config[KEY_NAMES[config.AI_FALLBACK_PROVIDER]]?.trim()) throw new Error(`${KEY_NAMES[config.AI_FALLBACK_PROVIDER]} is not set (fallback provider)`);

  const report = loadReport(reportPath);
  const statePath = flag("state");
  const state = statePath ? readJson(statePath) as StateLike : null;
  const { discovery, digestsVerified } = rebuildDiscovery(report, state);
  const input = parseToBeInput({ targetProduct: report.targetProduct, discovery });
  const catalogs = await verifySapCatalogs();
  const references = await loadToBeReferences(input, { baseDir: catalogs.baseDir });
  console.log(`config: provider ${config.AI_PROVIDER} model ${config.AI_MODEL}${config.AI_MODEL_DESIGN ? ` design ${config.AI_MODEL_DESIGN}` : ""}`
    + `${config.AI_FALLBACK_PROVIDER ? ` fallback ${config.AI_FALLBACK_PROVIDER}/${config.AI_FALLBACK_MODEL}` : ""}; stage budget ${config.AI_STAGE_BUDGET_SECONDS}s`);
  console.log(`catalog: ${input.targetProduct} ${input.discovery.targetRelease ?? "UNKNOWN"} -> ${references.length} verified references`);
  console.log(`To-Be input: ${input.discovery.asIsSteps.length} steps, ${input.discovery.requirements.length} requirements, ${input.discovery.companyContext?.length ?? 0} company-context fields, `
    + `${digestsVerified}/${discovery.sources.length} source digests verified`);

  // Same as production: the runner owns the stage budget; the outer signal only adds the job-row headroom (jobTiming) and Ctrl-C.
  const interrupted = new AbortController();
  process.once("SIGINT", () => interrupted.abort());
  const signal = AbortSignal.any([interrupted.signal, AbortSignal.timeout(jobTiming(config.AI_STAGE_BUDGET_SECONDS).deadlineSeconds * 1000)]);
  const runStage = createStageRunner(config, { sapCatalogDir: catalogs.baseDir, issueDetail: true, captureRaw: has("capture-raw") });

  const startedAt = new Date();
  let metrics: StageMetrics | undefined, errorCode: string | null = null;
  let payload = null as { design?: unknown; reviewFindings?: ReviewOutcome[] } | null;
  try {
    // --replay: no model; the report's own saved design goes through the same validation, derivation and output path (zero cost).
    if (has("replay")) payload = { design: report.design };
    else {
      const generated = await runStage("to_be", input, signal);
      metrics = generated.metrics; payload = generated.payload as NonNullable<typeof payload>;
    }
  } catch (error) {
    const failed = error instanceof AIStageError ? error : null;
    metrics = failed?.metrics;
    errorCode = failed?.code ?? `DRIVER_ERROR:${message(error).slice(0, 120)}`;
  }

  const validation = payload ? validateToBeOutput(input, payload.design, references, reviewBlockers(payload.reviewFindings)) : null;
  const validationIssues = validation && !validation.success ? validation.errors.map(({ path, code, detail }) => ({ path, code, ...(detail && { detail }) })) : [];
  if (payload && !validation?.success) errorCode = "VALIDATION_FAILED";
  for (const issue of validationIssues.slice(0, 10)) console.error(`validation: ${issue.path} ${issue.code}${issue.detail ? ` (${issue.detail})` : ""}`);
  const valid = validation?.success ? validation.data : null;
  const meta = { sourceRevision: report.sourceRevision ?? null, variantCode: report.variant.code, variantName: discovery.variantName, snapshotId: report.snapshotId ?? null,
    generatedAt: new Date().toISOString(), targetProduct: input.targetProduct, targetRelease: discovery.targetRelease,
    sources: discovery.sources.map(({ id, title, revision, text }) => ({ id, title, revision, digest: sha256(text) })) };
  // Exactly the sections the user-facing report builds without a model, so the judge reads what the consultant sees (see consultant-report.ts).
  const derived = valid ? deriveSections({ design: valid.design, asIsSteps: discovery.asIsSteps, meta }) : undefined;
  const reviewFindings = valid ? valid.evaluation.blockers.filter(item => item.code in REVIEW_FINDINGS)
    .map(item => ({ code: item.code, path: item.path, explanation: REVIEW_FINDINGS[item.code], ...(item.detail && { detail: item.detail }) })) : [];
  const derivedWithFindings = derived && { ...derived, reviewFindings };

  const run = toBeRun(metrics);
  console.log(toBeSummary(run, errorCode));
  const provider = metrics?.provider ?? config.AI_PROVIDER, model = metrics?.model ?? config.AI_MODEL_DESIGN ?? config.AI_MODEL;
  const transcript: Transcript = TranscriptSchema.parse({ schemaVersion: 1, caseId: `report-${report.jobId ?? "local"}`, provider, model, startedAt: startedAt.toISOString(),
    turns: [], readiness: { reached: true, atTurn: null, forcedCompletion: true, directEdits: 0, blockers: [] }, toBeOnly: true,
    toBe: { attempted: true, structurallyValid: !!valid, errorCode, ...run, requirements: discovery.requirements.map(r => ({ id: r.id, statement: r.statement, evidence: r.evidence.quote })),
      design: valid?.design ?? null, ...(derivedWithFindings && { derived: derivedWithFindings }) }, aborted: null });

  const out = flag("out") ?? `test-results/eval/tobe-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`;
  mkdirSync(dirname(out), { recursive: true });
  const companyContext = (discovery.companyContext ?? []).map(({ fieldId, label, value }) => ({ fieldId, label, value }));
  writeFileSync(out, JSON.stringify({ schemaVersion: 1, kind: "tobe-run", createdAt: startedAt.toISOString(),
    source: { report: reportPath, state: statePath ?? null, reportJobId: report.jobId ?? null, reportSourceRevision: report.sourceRevision ?? null,
      stateRevision: state?.revision ?? null, sourceDigestsVerified: digestsVerified },
    transcript,
    input: { project: report.project, variant: report.variant, targetProduct: input.targetProduct, targetRelease: discovery.targetRelease,
      problemStatement: discovery.sources.find(source => source.locator === "Initial problem")?.text ?? null, companyContext,
      discovery: { asIsSteps: discovery.asIsSteps, requirements: discovery.requirements } },
    evaluation: valid?.evaluation ?? null, blockers: valid?.evaluation.blockers ?? [], reviewFindings, unresolvedInputQuestions: valid?.unresolvedInputQuestions ?? [],
    metrics: { provider, model, inputTokens: run.inputTokens, outputTokens: run.outputTokens, attempts: run.attempts, durationSeconds: Math.round(run.latencyMs / 100) / 10,
      costUsd: costUsd(config, model, run.inputTokens, run.outputTokens), substages: run.substages },
    job: { status: valid ? "SUCCEEDED" : "FAILED", error: errorCode ? { code: errorCode, ...(validationIssues.length && { issues: validationIssues }) } : null },
    // A failed stage has no accepted design: the last assembled draft and the errors it failed with (needs --capture-raw), and the warnings the server settled on the way.
    ...(!valid && metrics?.lastDraft && { failedDraft: { draft: metrics.lastDraft.design,
      errors: metrics.lastDraft.errors.map(({ code, path, detail }) => ({ code, path, ...(detail && { detail }) })) } }),
    ...(!valid && metrics?.warnings?.length && { warnings: metrics.warnings }) }, null, 2));
  console.log(`wrote ${out}`);
  if (errorCode === "AI_PROVIDER_CREDIT") console.error("run-tobe: the provider refused for credit/balance");
  process.exitCode = valid ? 0 : 1;
}

main().catch(error => { console.error(`run-tobe: ${message(error)}`); process.exitCode = 1; });
