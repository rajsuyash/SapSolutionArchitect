// Independent LLM judge for To-Be plans (see src/lib/eval-judge.ts).
//
//   node --import tsx scripts/eval-judge.ts --list-rubric
//   node --import tsx scripts/eval-judge.ts --case fixtures/eval/pump-o2c.json (--run <eval run.json> | --tobe <design.json>) [--runs 3]
//   node --import tsx scripts/eval-judge.ts --calibrate [--case fixtures/eval/pump-o2c.json] [--runs 3]
//
// The judge is chosen automatically as a model family other than the generator's (Qwen3.8-Max for a DeepSeek generator, DeepSeek-V4-Pro for Qwen or MiMo); the generator comes from the run file's
// transcript or --generator-model. A --model of the generator's own family is refused unless --allow-same-family, and then the reports say NOT INDEPENDENT. Judge and generator families go in the report header.
// Needs the provider's key in the environment (DEEPINFRA_API_KEY, or OPENROUTER_API_KEY with --provider openrouter, which also needs --model; cost is still priced at JUDGE_PRICE_PER_MTOK) (this script never reads .env files). --calibrate judges the hand-written
// STRONG control (fixtures/eval/controls/pump-o2c.strong.json) and a WEAK plan mechanically derived from it, and says whether the
// judge separates them. Flags: --provider <deepinfra|openrouter> (default deepinfra) --model <id> --runs N --concurrency N (default 1 on openrouter, 3 on deepinfra)
// --min-runs N (default 2; fewer successful judgements = exit 1, "NOT A MEASUREMENT") --deadline-seconds N (default 1800; no retry starts after it, in-flight calls are aborted)
// --call-timeout-seconds N (default 900) ; transient failures (5xx, 429, a connection cut mid-stream) are retried 3 times with 2/6/18 s backoff --max-cost <usd, default 1.00> --spread-flag <0.5>.
// Output: test-results/eval/judge-<timestamp>.json and .md (gitignored).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  aggregateRuns, assessIndependence, assessJudgements, DEFAULT_DEADLINE_SECONDS, DEFAULT_JUDGE_CALL_TIMEOUT_MS, DEFAULT_MIN_RUNS, defaultConcurrency, runLimited, buildCaseBrief, calibrate, costUsd, DEFAULT_RUNS, DEFAULT_SPREAD_FLAG, defaultJudgeModel, degradeDesign, independenceLine, JudgeError, judgeOnce, loadToBe,
  RUBRIC, type Aggregate, type RunStatus, type Calibration, type CaseBrief, type Graded, type Independence, type ToBe, type Usage,
} from "../src/lib/eval-judge";
import { createProviderClient } from "../src/lib/ai/provider";
import { loadSapReferences } from "../src/lib/ai/sap-references";

const flag = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (name: string) => process.argv.includes(`--${name}`);
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const STRONG_PATH = "fixtures/eval/controls/pump-o2c.strong.json";

type Judged = { label: string; aggregate: Aggregate; runs: Graded[][]; usage: Usage; failures: string[]; valid: boolean; banner: string | null; statuses: RunStatus[] };

async function main() {
  if (has("list-rubric")) {
    for (const c of RUBRIC) console.log(`${c.id}\tw${c.weight}\t${c.na === "allowed" ? "NA?" : "-"}\t${c.text}`);
    console.log(`${RUBRIC.length} criteria, total weight ${RUBRIC.reduce((n, c) => n + c.weight, 0)}`);
    return;
  }
  const runs = Number(flag("runs") ?? DEFAULT_RUNS), maxCost = Number(flag("max-cost") ?? "1.00"), spreadFlag = Number(flag("spread-flag") ?? DEFAULT_SPREAD_FLAG);
  const source = flag("run") ?? flag("tobe");
  if (!has("calibrate") && !source) throw new Error("give --run <eval run.json> or --tobe <design.json> (or --calibrate)");
  // Calibration judges hand-written controls, so there is no generator whose family could matter.
  const tobe = source && !has("calibrate") ? loadToBe(readJson(source)) : undefined;
  const generatorModel = has("calibrate") ? null : flag("generator-model") ?? tobe?.generator?.model ?? null;
  const model = flag("model") ?? defaultJudgeModel(generatorModel);
  const independence = assessIndependence(model, generatorModel);
  if (independence.status === "NOT_INDEPENDENT" && !has("allow-same-family")) {
    throw new Error(`refusing a same-family judge: ${independence.note} Omit --model to pick an independent judge automatically, or pass --allow-same-family to run anyway (the report will say NOT INDEPENDENT).`);
  }
  if (independence.status !== "INDEPENDENT" && !has("calibrate")) console.warn(`WARNING: ${independenceLine(model, independence)}`);
  if (!Number.isInteger(runs) || runs < 1 || !(maxCost > 0)) throw new Error("--runs must be a positive integer and --max-cost a positive number");
  const judgeProvider = flag("provider") ?? "deepinfra";
  if (judgeProvider !== "deepinfra" && judgeProvider !== "openrouter") throw new Error("--provider must be deepinfra or openrouter");
  if (judgeProvider === "openrouter" && !flag("model")) throw new Error("--provider openrouter needs --model (the default judge model id is DeepInfra's)");
  const keyName = judgeProvider === "openrouter" ? "OPENROUTER_API_KEY" : "DEEPINFRA_API_KEY";
  const apiKey = process.env[keyName]?.trim();
  if (!apiKey) throw new Error(`${keyName} is not set`);
  const positive = (name: string, fallback: number) => { const value = Number(flag(name) ?? fallback); if (!(value > 0)) throw new Error(`--${name} must be a positive number`); return value; };
  const concurrency = Math.floor(positive("concurrency", defaultConcurrency(judgeProvider))), minRuns = Math.floor(positive("min-runs", DEFAULT_MIN_RUNS)), deadlineSeconds = positive("deadline-seconds", DEFAULT_DEADLINE_SECONDS);
  const callTimeoutMs = Math.round(positive("call-timeout-seconds", DEFAULT_JUDGE_CALL_TIMEOUT_MS / 1000) * 1000);
  if (minRuns > runs) throw new Error("--min-runs cannot exceed --runs");
  // The SDK timeout only has to outlast the per-call timeout judgeOnce passes with each request.
  const client = createProviderClient(judgeProvider, apiKey, callTimeoutMs + 60_000);
  const rawCase = readJson(flag("case") ?? "fixtures/eval/pump-o2c.json") as { project: { targetProduct: Parameters<typeof loadSapReferences>[0]; targetRelease?: string | null } };
  const references = await loadSapReferences(rawCase.project.targetProduct, rawCase.project.targetRelease ?? null);
  const brief = buildCaseBrief(rawCase, references.length);
  let spent = 0;

  async function judge(label: string, tobe: ToBe, caseBrief: CaseBrief): Promise<Judged> {
    // One deadline for the whole set: no retry starts after it, and calls still streaming are aborted at it.
    const deadlineAt = Date.now() + deadlineSeconds * 1000, signal = AbortSignal.timeout(deadlineSeconds * 1000);
    const settled = await runLimited(runs, concurrency, index => {
      if (signal.aborted) return Promise.reject(new Error("judge deadline reached before this judgement started"));
      return judgeOnce(client, RUBRIC, caseBrief, tobe, { model, timeoutMs: callTimeoutMs, signal, deadlineAt,
        onRetry: (retry, delayMs, error) => console.error(JSON.stringify({ event: "judge_retry", label, run: index + 1, retry, delayMs, error: message(error).slice(0, 120) })) });
    });
    const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
    const good: Graded[][] = [], failures: string[] = [], statuses: RunStatus[] = [];
    settled.forEach((result, index) => {
      const u = result.status === "fulfilled" ? result.value.usage : result.reason instanceof JudgeError ? result.reason.usage : null;
      if (u) { usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; usage.calls += u.calls; }
      if (result.status === "fulfilled") { good.push(result.value.graded); statuses.push({ run: index, ok: true, detail: `total ${result.value.score.total}, ${result.value.usage.calls} calls` }); }
      else { failures.push(message(result.reason)); statuses.push({ run: index, ok: false, detail: message(result.reason) }); }
    });
    spent += costUsd(usage.inputTokens, usage.outputTokens);
    console.log(`${label}: ${good.length}/${runs} judgements ok, ${usage.calls} calls, ${usage.inputTokens} in / ${usage.outputTokens} out tokens, cumulative $${spent.toFixed(4)}`);
    const verdict = assessJudgements(statuses, minRuns);
    console.log(verdict.lines.join("\n"));
    if (verdict.banner) console.error(`${label}: ${verdict.banner}`);
    if (!good.length) throw new Error(`${label}: every judgement failed: ${failures.join(" | ")}`);
    return { label, aggregate: aggregateRuns(RUBRIC, good, spreadFlag), runs: good, usage, failures, valid: verdict.valid, banner: verdict.banner, statuses };
  }
  const guard = (next: string) => { if (spent >= maxCost) throw new Error(`cost cap $${maxCost} reached before ${next} (spent $${spent.toFixed(4)})`); };

  return (async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    mkdirSync("test-results/eval", { recursive: true });
    const base = `test-results/eval/judge-${stamp}`;
    if (has("calibrate")) {
      const strongTobe = loadToBe(readJson(STRONG_PATH));
      const weakTobe: ToBe = { requirements: strongTobe.requirements, design: degradeDesign(strongTobe.design) };
      const strong = await judge("STRONG", strongTobe, brief);
      guard("WEAK");
      const weak = await judge("WEAK", weakTobe, brief);
      const calibration = calibrate(RUBRIC, strong.aggregate, weak.aggregate);
      const cost = costUsd(strong.usage.inputTokens + weak.usage.inputTokens, strong.usage.outputTokens + weak.usage.outputTokens);
      writeFileSync(`${base}.json`, JSON.stringify({ kind: "calibration", model, independence, runs, caseId: brief.caseId, calibration, strong, weak, cost }, null, 2));
      writeFileSync(`${base}.md`, calibrationMarkdown(model, independence, brief, calibration, strong, weak, cost));
      console.log(`${calibration.verdict}\nSTRONG ${calibration.strongTotal} (runs ${strong.aggregate.perRunTotals.join(", ")}) | WEAK ${calibration.weakTotal} (runs ${weak.aggregate.perRunTotals.join(", ")}) | cost $${cost}`);
      console.log(`Wrote ${base}.json and ${base}.md`);
      process.exitCode = calibration.usable && strong.valid && weak.valid ? 0 : 1;
      return;
    }
    const result = await judge("TO-BE", tobe!, brief);
    const cost = costUsd(result.usage.inputTokens, result.usage.outputTokens);
    writeFileSync(`${base}.json`, JSON.stringify({ kind: "judgement", model, independence, runs, caseId: brief.caseId, source, result, cost }, null, 2));
    writeFileSync(`${base}.md`, judgementMarkdown(model, independence, brief, source!, result, cost));
    console.log(`${result.valid ? "" : "NOT A MEASUREMENT (too few successful judgements): "}Total ${result.aggregate.total}/100 (spread ${result.aggregate.totalSpread}), ${result.aggregate.flagged.length} disputed, ${result.aggregate.unjustified.length} unjustified, cost $${cost}`);
    console.log(`Wrote ${base}.json and ${base}.md`);
    if (!result.valid) process.exitCode = 1;
  })();
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");
function criteriaTable(j: Judged): string[] {
  const text = new Map(RUBRIC.map(c => [c.id, c.text.slice(0, 70)]));
  return ["| id | criterion | w | verdict | scores | spread | flag | citation | reason |", "|---|---|---|---|---|---|---|---|---|",
    ...j.aggregate.criteria.map(c => `| ${c.id} | ${cell(text.get(c.id)!)} | ${c.weight} | ${c.verdict} | ${c.scores.map(s => s ?? "NA").join("/")} | ${c.spread} | ${c.flagged ? "DISPUTED" : ""}${c.unjustifiedRuns ? ` UNJUSTIFIED x${c.unjustifiedRuns}` : ""} | ${cell(c.citation)} | ${cell(c.reason)} |`)];
}
function summaryLines(j: Judged): string[] {
  const a = j.aggregate;
  return [...(j.banner ? [`- **${j.banner}**`] : []), `- Total: **${a.total}/100** (median of ${a.runs} runs; per run ${a.perRunTotals.join(", ")}; range ${a.totalMin} to ${a.totalMax}, spread ${a.totalSpread}); total from per-criterion medians ${a.medianCriteriaTotal}`,
    `- Disputed criteria (spread at or above the flag): ${a.flagged.join(", ") || "none"}`,
    `- Verdicts without a real cited element (counted as FAIL): ${a.unjustified.map(u => `${u.id} x${u.runs}`).join(", ") || "none"}`,
    `- Tokens: ${j.usage.inputTokens} in / ${j.usage.outputTokens} out over ${j.usage.calls} calls; failed judgements: ${j.failures.length}${j.failures.length ? ` (${j.failures.join(" | ")})` : ""}`];
}
function judgementMarkdown(model: string, independence: Independence, brief: CaseBrief, source: string, j: Judged, cost: number): string {
  return [`# To-Be judgement: ${brief.caseId}`, "", independenceLine(model, independence), "", `Source \`${source}\`, cost $${cost}`, "", ...summaryLines(j), "", ...criteriaTable(j), ""].join("\n");
}
function calibrationMarkdown(model: string, independence: Independence, brief: CaseBrief, cal: Calibration, strong: Judged, weak: Judged, cost: number): string {
  return [`# Judge calibration: ${brief.caseId}`, "", `Judge ${model} (family ${independence.judgeFamily}; the controls are hand-written, so no generator family applies). **${cal.verdict}**`, "",
    `| | total /100 | per run | spread |`, `|---|---|---|---|`,
    `| STRONG | ${cal.strongTotal} | ${strong.aggregate.perRunTotals.join(", ")} | ${cal.strongSpread} |`,
    `| WEAK | ${cal.weakTotal} | ${weak.aggregate.perRunTotals.join(", ")} | ${cal.weakSpread} |`,
    `| gap | ${cal.gap} (minimum ${cal.minGap}) | | |`, "", `Cost $${cost}. Inverted criteria (WEAK above STRONG): ${cal.invertedCriteria.join(", ") || "none"}`, "",
    "## Per-criterion difference (median score, weighted order)", "", "| id | w | strong | weak | diff |", "|---|---|---|---|---|",
    ...cal.differentiators.map(d => `| ${d.id} | ${d.weight} | ${d.strong ?? "NA"} | ${d.weak ?? "NA"} | ${d.diff} |`), "",
    "## STRONG", "", ...summaryLines(strong), "", ...criteriaTable(strong), "", "## WEAK", "", ...summaryLines(weak), "", ...criteriaTable(weak), ""].join("\n");
}

main().catch(error => { console.error(`eval-judge failed: ${message(error)}`); process.exitCode = 2; });
