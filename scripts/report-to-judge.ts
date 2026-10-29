// Turn a To-Be result into the two files scripts/eval-judge.ts reads: a case file (--case) and a design file (--tobe).
//
//   node --import tsx scripts/report-to-judge.ts --report <production report.json | run-tobe output.json> [--state <workspace state.json>] --out-dir <dir>
//   node --import tsx scripts/eval-judge.ts --case <dir>/case.json --tobe <dir>/design.json
//
// The judge's brief and the design must share ids, and production ids (st_<uuid>_n, rq_<uuid>_n) are not the ones the judge's case format
// builds (as_is_<n>, rq_r<NN>). Every original id is therefore rewritten in the design and in the derived sections, and the run fails unless
// no original id is left (checked with a positive control, so "none left" cannot be an artefact of a detector that finds nothing).
// A run-tobe output carries its own problem statement, company context and derived sections; a production report needs --state for the first two
// and has its derived sections computed with deriveSections, as the user-facing report does.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCaseBrief, loadToBe } from "../src/lib/eval-judge";
import { deriveSections, inputQuestionLabel, inputQuestionRows } from "../src/lib/to-be-derived";
import type { DetailedDesign } from "../src/lib/ai/design-quality";
import { flag, loadReport, readJson, sha256, type ReportLike, type StateLike } from "./tobe-input";

type Step = ReportLike["discovery"]["asIsSteps"][number];
type Requirement = ReportLike["discovery"]["requirements"][number];
type Normalized = { caseId: string; project: ReportLike["project"]; variant: ReportLike["variant"]; targetProduct: string; targetRelease: string | null;
  asIsSteps: readonly Step[]; requirements: readonly Requirement[]; design: Record<string, unknown>; derived: Record<string, unknown>; inputQuestions: { id: string; question: string; owner: string; label?: string }[];
  problemStatement: string; catalog: Record<string, string>; generator: { provider: string | null; model: string } | null };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const escape = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function catalogFrom(items: readonly { id: string; value: string | null }[]): Record<string, string> {
  return Object.fromEntries(items.flatMap(item => item.value ? [[item.id, item.value] as const] : []));
}

/** A run-tobe output file (kind "tobe-run") or a production report; both end up in one shape. */
function normalize(path: string, state: StateLike | null): Normalized {
  const raw = readJson(path) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- two untyped file shapes, narrowed field by field below
  if (raw.kind === "tobe-run") {
    const toBe = raw.transcript?.toBe;
    if (!toBe?.design) throw new Error(`${path} has no design to judge (job ${raw.job?.status}: ${raw.job?.error?.code ?? "no error recorded"})`);
    const problemStatement = raw.input.problemStatement ?? state?.problemStatement;
    if (!problemStatement) throw new Error("No problem statement: the run output lacks it and no --state was given");
    const questions = (raw.unresolvedInputQuestions ?? raw.transcript?.toBe?.unresolvedInputQuestions ?? []) as Normalized["inputQuestions"];
    const context = (raw.input.companyContext ?? []) as { fieldId: string; value: string }[];
    return { caseId: String(raw.transcript.caseId ?? "tobe-run"), project: raw.input.project, variant: raw.input.variant, targetProduct: raw.input.targetProduct,
      targetRelease: raw.input.targetRelease, asIsSteps: raw.input.discovery.asIsSteps, requirements: raw.input.discovery.requirements, design: toBe.design,
      derived: { ...(toBe.derived ?? {}), ...(toBe.derived?.inputQuestions ? {} : { inputQuestions: inputQuestionRows(questions) }) }, inputQuestions: questions, problemStatement,
      catalog: catalogFrom(context.length ? context.map(c => ({ id: c.fieldId, value: c.value })) : (state?.facts ?? []).filter(f => f.status === "KNOWN")),
      generator: raw.transcript.model ? { provider: raw.transcript.provider ?? null, model: raw.transcript.model } : null };
  }
  const report = loadReport(path);
  if (!state) throw new Error("A production report has no problem statement or company context: pass --state <workspace state.json>");
  const design = report.design as unknown as DetailedDesign;
  const questions = report.discovery.openQuestions as Normalized["inputQuestions"];
  const derived = deriveSections({ design, asIsSteps: report.discovery.asIsSteps, inputQuestions: questions, meta: { sourceRevision: report.sourceRevision ?? null, variantCode: report.variant.code,
    variantName: report.variant.name, snapshotId: report.snapshotId ?? null, generatedAt: report.generatedAt ?? null, targetProduct: report.targetProduct, targetRelease: report.targetRelease,
    sources: report.discovery.sources.map(({ id, title, revision, digest, text }) => ({ id, title, revision, digest: digest ?? (text === undefined ? undefined : sha256(text)) })) } });
  return { caseId: `report-${report.jobId ?? "local"}`, project: report.project, variant: report.variant, targetProduct: report.targetProduct, targetRelease: report.targetRelease,
    asIsSteps: report.discovery.asIsSteps, requirements: report.discovery.requirements, design: report.design, derived: derived as unknown as Record<string, unknown>, inputQuestions: questions,
    problemStatement: state.problemStatement, catalog: catalogFrom(state.facts.filter(f => f.status === "KNOWN")), generator: null };
}

function main() {
  const reportPath = flag("report"), outDir = flag("out-dir");
  if (!reportPath || !outDir) throw new Error("Usage: node --import tsx scripts/report-to-judge.ts --report <report.json|run-tobe output> [--state <state.json>] --out-dir <dir>");
  const statePath = flag("state");
  const n = normalize(reportPath, statePath ? readJson(statePath) as StateLike : null);

  const steps = n.asIsSteps.map((s, i) => ({ n: i + 1, name: s.name, system: s.system, actor: s.actor, trigger: s.trigger, description: s.description }));
  const stepN = new Map(n.asIsSteps.map((s, i) => [s.id, i + 1] as const));
  const reqs = n.requirements.map((r, i) => {
    const asIsN = stepN.get(r.asIsStepId);
    if (!asIsN) throw new Error(`Requirement ${r.id} names an unknown As-Is step ${r.asIsStepId}`);
    return { key: `r${String(i + 1).padStart(2, "0")}`, origId: r.id, stepN: asIsN, kind: r.kind, critical: r.critical, statement: r.statement };
  });
  // Input open questions read as IQ-n (the label the To-Be itself uses); an older design that still cites a raw question id gets it rewritten the same way.
  const idMap = new Map<string, string>([...n.asIsSteps.map((s, i) => [s.id, `as_is_${i + 1}`] as const), ...reqs.map(r => [r.origId, `rq_${r.key}`] as const),
    ...n.inputQuestions.map((q, i) => [q.id, q.label ?? inputQuestionLabel(i)] as const).filter(([id, label]) => id !== label)]);
  if (new Set(idMap.values()).size !== idMap.size) throw new Error("Judge ids are not unique");

  // Longest first so an id never shadows a longer one it prefixes (_1 vs _10); the lookarounds stop a match inside a longer identifier.
  const ids = [...idMap.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${ids.map(escape).join("|")})(?![A-Za-z0-9_-])`, "g");
  const original = JSON.stringify({ design: n.design, derived: n.derived });
  const counts = { asIs: 0, requirement: 0, question: 0 };
  const mapped = original.replace(pattern, id => { const to = idMap.get(id)!; if (to.startsWith("rq_")) counts.requirement++; else if (to.startsWith("IQ-")) counts.question++; else counts.asIs++; return to; });
  const { design, derived } = JSON.parse(mapped) as { design: Record<string, unknown>; derived: Record<string, unknown> };

  const residual = ids.filter(id => new RegExp(`(?<![A-Za-z0-9_-])${escape(id)}(?![A-Za-z0-9_-])`).test(mapped));
  const uuidShaped = (mapped.match(/(?<![A-Za-z0-9_-])(?:st|rq)_[0-9a-f-]{36}_\d+/g) ?? []).length;
  const presentBefore = ids.filter(id => original.includes(id)).length;
  // Positive control: the detector must find ids in the unmapped text, otherwise "residual 0" proves nothing.
  const controlHits = ids.filter(id => new RegExp(`(?<![A-Za-z0-9_-])${escape(id)}(?![A-Za-z0-9_-])`).test(original)).length;
  const problems = [
    ...(counts.asIs + counts.requirement + counts.question === 0 ? ["no id was replaced"] : []), ...(controlHits === 0 ? ["positive control failed: detector found no original id in the input"] : []),
    ...(residual.length ? [`${residual.length} original ids remain`] : []), ...(uuidShaped ? [`${uuidShaped} uuid-shaped ids remain`] : []),
  ];

  const caseFile = { schemaVersion: 1, caseId: n.caseId, company: n.project.clientName,
    project: { name: n.project.name, clientName: n.project.clientName, problemStatement: n.problemStatement, targetProduct: n.targetProduct, targetRelease: n.targetRelease,
      variantCode: n.variant.code, variantName: n.variant.name },
    answerBank: { catalog: n.catalog }, steps, requirements: reqs.map(({ key, stepN: step, kind, critical, statement }) => ({ key, stepN: step, kind, critical, statement })) };
  const designFile = { ...(n.generator && { provider: n.generator.provider, model: n.generator.model }), design,
    requirements: reqs.map(r => ({ id: `rq_${r.key}`, statement: r.statement, critical: r.critical })), derived };

  // Self-check with the judge's own loaders: both files must parse, and every coverage id must be a requirement the judge will see.
  const brief = buildCaseBrief(caseFile, 0), tobe = loadToBe(designFile);
  const briefIds = new Set(brief.requirements.map(r => r.id));
  const coverage = ((design.coverage ?? []) as { requirementId: string }[]).map(c => c.requirementId);
  const matched = coverage.filter(id => briefIds.has(id)).length;
  if (coverage.length === 0 || matched !== coverage.length) problems.push(`coverage ids in brief: ${matched}/${coverage.length}`);
  if (!tobe.derived) problems.push("derived sections missing from the design file");

  console.log(JSON.stringify({ steps: steps.length, requirements: reqs.length, catalogFields: Object.keys(n.catalog).length, replaced: counts, originalIdsInInput: presentBefore,
    positiveControlHits: controlHits, residualOriginalIds: residual.length, residualUuidShaped: uuidShaped, coverageInBrief: `${matched}/${coverage.length}`,
    derivedKeys: Object.keys(tobe.derived ?? {}), generator: tobe.generator ?? null }));
  if (problems.length) throw new Error(`not writing: ${problems.join("; ")}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "case.json"), JSON.stringify(caseFile, null, 2));
  writeFileSync(join(outDir, "design.json"), JSON.stringify(designFile, null, 2));
  console.log(`wrote ${join(outDir, "case.json")} and ${join(outDir, "design.json")}`);
}

try { main(); } catch (error) { console.error(`report-to-judge: ${message(error)}`); process.exitCode = 1; }
