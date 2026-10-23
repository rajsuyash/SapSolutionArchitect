// Independent LLM judge for To-Be plans (see src/lib/eval-judge.ts).
//
//   node --import tsx scripts/eval-judge.ts --list-rubric
//   node --import tsx scripts/eval-judge.ts --case fixtures/eval/pump-o2c.json (--run <eval run.json> | --tobe <design.json>) [--runs 3]
//   node --import tsx scripts/eval-judge.ts --calibrate [--case fixtures/eval/pump-o2c.json] [--runs 3]
//
// Needs the provider's key in the environment (DEEPINFRA_API_KEY, or OPENROUTER_API_KEY with --provider openrouter, which also needs --model; cost is still priced at JUDGE_PRICE_PER_MTOK) (this script never reads .env files). --calibrate judges the hand-written
// STRONG control (fixtures/eval/controls/pump-o2c.strong.json) and a WEAK plan mechanically derived from it, and says whether the
// judge separates them. Flags: --provider <deepinfra|openrouter> (default deepinfra) --model <id> --runs N --max-cost <usd, default 1.00> --spread-flag <0.5>.
// Output: test-results/eval/judge-<timestamp>.json and .md (gitignored).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  aggregateRuns, buildCaseBrief, calibrate, costUsd, DEFAULT_RUNS, DEFAULT_SPREAD_FLAG, degradeDesign, JUDGE_MODEL, JudgeError, judgeOnce, loadToBe,
  RUBRIC, type Aggregate, type Calibration, type CaseBrief, type Graded, type ToBe, type Usage,
} from "../src/lib/eval-judge";
import { createProviderClient } from "../src/lib/ai/provider";
import { loadSapReferences } from "../src/lib/ai/sap-references";

const flag = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (name: string) => process.argv.includes(`--${name}`);
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const STRONG_PATH = "fixtures/eval/controls/pump-o2c.strong.json";

type Judged = { label: string; aggregate: Aggregate; runs: Graded[][]; usage: Usage; failures: string[] };

async function main() {
  if (has("list-rubric")) {
    for (const c of RUBRIC) console.log(`${c.id}\tw${c.weight}\t${c.na === "allowed" ? "NA?" : "-"}\t${c.text}`);
    console.log(`${RUBRIC.length} criteria, total weight ${RUBRIC.reduce((n, c) => n + c.weight, 0)}`);
    return;
  }
  const runs = Number(flag("runs") ?? DEFAULT_RUNS), maxCost = Number(flag("max-cost") ?? "1.00"), spreadFlag = Number(flag("spread-flag") ?? DEFAULT_SPREAD_FLAG);
  const model = flag("model") ?? JUDGE_MODEL;
  if (!Number.isInteger(runs) || runs < 1 || !(maxCost > 0)) throw new Error("--runs must be a positive integer and --max-cost a positive number");
  const judgeProvider = flag("provider") ?? "deepinfra";
  if (judgeProvider !== "deepinfra" && judgeProvider !== "openrouter") throw new Error("--provider must be deepinfra or openrouter");
  if (judgeProvider === "openrouter" && !flag("model")) throw new Error("--provider openrouter needs --model (the default judge model id is DeepInfra's)");
  const keyName = judgeProvider === "openrouter" ? "OPENROUTER_API_KEY" : "DEEPINFRA_API_KEY";
  const apiKey = process.env[keyName]?.trim();
  if (!apiKey) throw new Error(`${keyName} is not set`);
  const client = createProviderClient(judgeProvider, apiKey, 660_000);
  const rawCase = readJson(flag("case") ?? "fixtures/eval/pump-o2c.json") as { project: { targetProduct: Parameters<typeof loadSapReferences>[0]; targetRelease?: string | null } };
  const references = await loadSapReferences(rawCase.project.targetProduct, rawCase.project.targetRelease ?? null);
  const brief = buildCaseBrief(rawCase, references.length);
  let spent = 0;

  async function judge(label: string, tobe: ToBe, caseBrief: CaseBrief): Promise<Judged> {
    const settled = await Promise.allSettled(Array.from({ length: runs }, () => judgeOnce(client, RUBRIC, caseBrief, tobe, { model })));
    const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
    const good: Graded[][] = [], failures: string[] = [];
    for (const result of settled) {
      const u = result.status === "fulfilled" ? result.value.usage : result.reason instanceof JudgeError ? result.reason.usage : null;
      if (u) { usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; usage.calls += u.calls; }
      if (result.status === "fulfilled") good.push(result.value.graded); else failures.push(message(result.reason));
    }
    spent += costUsd(usage.inputTokens, usage.outputTokens);
    console.log(`${label}: ${good.length}/${runs} judgements ok, ${usage.calls} calls, ${usage.inputTokens} in / ${usage.outputTokens} out tokens, cumulative $${spent.toFixed(4)}`);
    if (!good.length) throw new Error(`${label}: every judgement failed: ${failures.join(" | ")}`);
    return { label, aggregate: aggregateRuns(RUBRIC, good, spreadFlag), runs: good, usage, failures };
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
      writeFileSync(`${base}.json`, JSON.stringify({ kind: "calibration", model, runs, caseId: brief.caseId, calibration, strong, weak, cost }, null, 2));
      writeFileSync(`${base}.md`, calibrationMarkdown(model, brief, calibration, strong, weak, cost));
      console.log(`${calibration.verdict}\nSTRONG ${calibration.strongTotal} (runs ${strong.aggregate.perRunTotals.join(", ")}) | WEAK ${calibration.weakTotal} (runs ${weak.aggregate.perRunTotals.join(", ")}) | cost $${cost}`);
      console.log(`Wrote ${base}.json and ${base}.md`);
      process.exitCode = calibration.usable ? 0 : 1;
      return;
    }
    const source = flag("run") ?? flag("tobe");
    if (!source) throw new Error("give --run <eval run.json> or --tobe <design.json> (or --calibrate)");
    const result = await judge("TO-BE", loadToBe(readJson(source)), brief);
    const cost = costUsd(result.usage.inputTokens, result.usage.outputTokens);
    writeFileSync(`${base}.json`, JSON.stringify({ kind: "judgement", model, runs, caseId: brief.caseId, source, result, cost }, null, 2));
    writeFileSync(`${base}.md`, judgementMarkdown(model, brief, source, result, cost));
    console.log(`Total ${result.aggregate.total}/100 (spread ${result.aggregate.totalSpread}), ${result.aggregate.flagged.length} disputed, ${result.aggregate.unjustified.length} unjustified, cost $${cost}`);
    console.log(`Wrote ${base}.json and ${base}.md`);
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
  return [`- Total: **${a.total}/100** (median of ${a.runs} runs; per run ${a.perRunTotals.join(", ")}; range ${a.totalMin} to ${a.totalMax}, spread ${a.totalSpread}); total from per-criterion medians ${a.medianCriteriaTotal}`,
    `- Disputed criteria (spread at or above the flag): ${a.flagged.join(", ") || "none"}`,
    `- Verdicts without a real cited element (counted as FAIL): ${a.unjustified.map(u => `${u.id} x${u.runs}`).join(", ") || "none"}`,
    `- Tokens: ${j.usage.inputTokens} in / ${j.usage.outputTokens} out over ${j.usage.calls} calls; failed judgements: ${j.failures.length}${j.failures.length ? ` (${j.failures.join(" | ")})` : ""}`];
}
function judgementMarkdown(model: string, brief: CaseBrief, source: string, j: Judged, cost: number): string {
  return [`# To-Be judgement: ${brief.caseId}`, "", `Judge ${model} (independent family), source \`${source}\`, cost $${cost}`, "", ...summaryLines(j), "", ...criteriaTable(j), ""].join("\n");
}
function calibrationMarkdown(model: string, brief: CaseBrief, cal: Calibration, strong: Judged, weak: Judged, cost: number): string {
  return [`# Judge calibration: ${brief.caseId}`, "", `Judge ${model}. **${cal.verdict}**`, "",
    `| | total /100 | per run | spread |`, `|---|---|---|---|`,
    `| STRONG | ${cal.strongTotal} | ${strong.aggregate.perRunTotals.join(", ")} | ${cal.strongSpread} |`,
    `| WEAK | ${cal.weakTotal} | ${weak.aggregate.perRunTotals.join(", ")} | ${cal.weakSpread} |`,
    `| gap | ${cal.gap} (minimum ${cal.minGap}) | | |`, "", `Cost $${cost}. Inverted criteria (WEAK above STRONG): ${cal.invertedCriteria.join(", ") || "none"}`, "",
    "## Per-criterion difference (median score, weighted order)", "", "| id | w | strong | weak | diff |", "|---|---|---|---|---|",
    ...cal.differentiators.map(d => `| ${d.id} | ${d.weight} | ${d.strong ?? "NA"} | ${d.weak ?? "NA"} | ${d.diff} |`), "",
    "## STRONG", "", ...summaryLines(strong), "", ...criteriaTable(strong), "", "## WEAK", "", ...summaryLines(weak), "", ...criteriaTable(weak), ""].join("\n");
}

main().catch(error => { console.error(`eval-judge failed: ${message(error)}`); process.exitCode = 2; });
