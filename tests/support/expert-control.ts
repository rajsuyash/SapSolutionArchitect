/** The exact To-Be input `scripts/eval-consultant.ts --tobe-only` builds for a fixture, without a database, plus the hand-written
 * expert control for that fixture expressed in that input's ids.
 *
 * Id mapping (the control was written against fixture keys, the workspace generates ids):
 *  - requirements: ids are `rq_<meta.id>`; entering each requirement with meta.id = fixture key gives `rq_<key>`, which is exactly the control's id.
 *  - As-Is steps: draft ids are `st_<meta.id>`; entering step n with meta.id = `as_is_<n>` gives `st_as_is_<n>`, so the control's `as_is_<n>` maps to `st_as_is_<n>`.
 *  - The control's requirement statements are checked equal to the fixture's, so a mismatch fails loudly rather than mapping silently. */
import { readFileSync } from "node:fs";
import { applyWorkspaceCommand, compileDiscovery, createWorkspace, type WorkspaceState } from "../../src/lib/discovery-workspace-model";
import { parseToBeInput, type ToBeInput } from "../../src/lib/ai/to-be";
import { loadSapReferences } from "../../src/lib/ai/sap-references";
import type { DetailedDesign } from "../../src/lib/ai/design-quality";
import { fieldCommand, type Fixture } from "../../src/lib/eval-user";
import { STEP_KEYS } from "../../src/lib/workspace-fields";
import { splitDesign } from "./to-be-split";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;

export function buildToBeInput(fixture: Fixture): ToBeInput {
  let state: WorkspaceState | undefined;
  let counter = 0;
  const run = (command: Record<string, unknown>, id = `cmd${++counter}`) => {
    const meta = { actorId: "eval-actor", at: "2026-10-23T00:00:00.000Z", id };
    state = state ? applyWorkspaceCommand(state, command, meta) : state;
    return state!;
  };
  state = createWorkspace({ variantCode: fixture.project.variantCode, variantName: fixture.project.variantName,
    targetProduct: fixture.project.targetProduct as never, targetRelease: (fixture.project.targetRelease as string | undefined) ?? null, problemStatement: String(fixture.project.problemStatement) },
  { actorId: "eval-actor", at: "2026-10-23T00:00:00.000Z", id: "ws0" });
  for (const [fieldId, value] of Object.entries(fixture.answerBank.catalog)) {
    if (state.facts.some(f => f.id === fieldId && f.status !== "KNOWN")) run(fieldCommand(state, fieldId, value));
  }
  for (const step of fixture.steps) {
    run({ type: "START_STEP_DRAFT" }, `as_is_${step.n}`);
    const draft = state.stepDrafts.at(-1)!;
    for (const key of STEP_KEYS) run(fieldCommand(state, `${draft.id}_${key}`, step[key]));
  }
  for (const req of fixture.requirements) {
    run({ type: "START_REQUIREMENT_DRAFT", asIsStepId: `st_as_is_${req.stepN}`, kind: req.kind, critical: req.critical }, req.key);
    run(fieldCommand(state, `rq_${req.key}_statement`, req.statement));
  }
  run({ type: "CONFIRM" });
  return parseToBeInput({ targetProduct: fixture.project.targetProduct, discovery: compileDiscovery(state) });
}

type Control = { requirements: { id: string; statement: string }[]; design: DetailedDesign };

/** The control's design with As-Is ids mapped to the workspace's. Throws when a control requirement is not in the input. */
export function controlDesign(input: ToBeInput, control: Control): DetailedDesign {
  const have = new Map(input.discovery.requirements.map(r => [r.id, r.statement]));
  for (const r of control.requirements) {
    if (have.get(r.id) !== r.statement) throw new Error(`control requirement ${r.id} does not match the input`);
  }
  const mapAsIs = (id: string) => id.replace(/^as_is_/, "st_as_is_");
  const design = structuredClone(control.design);
  design.steps.forEach(step => { step.asIsStepIds = step.asIsStepIds.map(mapAsIs); });
  design.eliminatedAsIsSteps.forEach(item => { item.asIsStepId = mapAsIs(item.asIsStepId); });
  return design;
}

/** The control cites open decisions (DEC-nn) that a real run only has when the caller supplies a decisionRegister; the eval's
 * --tobe-only supplies none. `withRegister` supplies exactly the ids the control uses, so a check is not blamed for a missing input. */
export async function loadExpert(caseName = "pump-o2c", options: { withRegister?: boolean } = {}) {
  const fixture = read(`fixtures/eval/${caseName}.json`) as Fixture;
  const base = buildToBeInput(fixture);
  const control = read(`fixtures/eval/controls/${caseName}.strong.json`) as Control;
  const design = controlDesign(base, control);
  const decisionIds = [...new Set(JSON.stringify(design).match(/DEC-\d+/g) ?? [])];
  const input: ToBeInput = options.withRegister ? { ...base, decisionRegister: decisionIds.map(id => ({ id, topic: `Open decision ${id}`, owner: "Process owner", affectedStepIds: [] })) } : base;
  const references = await loadSapReferences(input.targetProduct, input.discovery.targetRelease);
  return { fixture, input, references, design, ...splitDesign(design) };
}
