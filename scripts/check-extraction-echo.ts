// One real extraction call (plus an optional chat call) on a fixed fictional transcript that reproduces the "echoed chat text" problem:
// one long pasted paragraph describing two steps of a late-return process, with the step details still empty.
//
//   node --import tsx scripts/check-extraction-echo.ts [--with-chat | --new-step | --project-shape] [--repeat N]
//
// --new-step: instead, a message that describes a step NOT in the workspace (damage inspection; 3 existing steps, none about it), to see whether
// the model proposes it as a step. Prints counts, each proposed step (name hint, value length) and every warning as code/detail.
// --project-shape: the same message against a fixed fictional workspace shaped like the real "late-return charges" project (7 current steps,
// scope and problem about late-return charges, earlier messages that mention inspection notes and damage photos at return). Prints like --new-step.
// --repeat N (1 to 5, default 1): run the same extraction call N times and print one result line per run, to read a rate. Not with --with-chat.
//
// Provider settings come from the real environment, then .env, then .env.example (same order as scripts/run-tobe.ts). No secrets are
// accepted on the command line or printed. Makes 1 AI call (extraction_turn), 2 with --with-chat (interview_turn). Writes nothing.
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { parseInterviewInput } from "../src/lib/ai/discovery-interview";
import { createStageRunner } from "../src/lib/ai/runStage";
import { parseEnvironment } from "../src/lib/env";

for (const file of [".env", ".env.example"]) {
  if (!existsSync(file)) continue;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
}
const config = parseEnvironment();
const PARAGRAPH = "Step 1, equipment return: performed by the counter clerk at the branch, in RentTrack plus a barcode scanner, triggered when the customer arrives with the equipment. "
  + "The clerk scans the equipment tag, checks the contract end date against the actual return time by eye, and notes any visible damage. "
  + "Step 2, late-return charge: performed by the back office billing team in RentTrack, triggered at the end of each day by the overdue contracts report. "
  + "The billing team calculates the extra days, applies the daily rate from the contract, and sends the charge to the customer by email. "
  + "Customers often dispute the charge when the return was logged the next morning.";
const PROJECT_SHAPE = process.argv.includes("--project-shape");
const NEW_STEP = process.argv.includes("--new-step") || PROJECT_SHAPE;
const repeatAt = process.argv.indexOf("--repeat");
const REPEAT = repeatAt < 0 ? 1 : Number(process.argv[repeatAt + 1]);
if (!Number.isInteger(REPEAT) || REPEAT < 1 || REPEAT > 5) { console.error("--repeat takes a whole number from 1 to 5."); process.exit(1); }
if (REPEAT > 1 && !NEW_STEP) { console.error("--repeat works with --new-step or --project-shape only."); process.exit(1); }
const DAMAGE_MESSAGE = "One more step we have not covered, the damage inspection: it is done by the yard supervisor in the workshop, in the DamageLog spreadsheet, "
  + "triggered when a returned machine arrives in the yard. The supervisor photographs the machine, compares it with the hand-over photos and writes the repair estimate in the spreadsheet.";
const empty = (step: string, keys: string[]) => keys.map(key => ({ id: `${step}_${key}`, label: `AS_IS step ${step}: ${key}`, value: null, status: "EMPTY" as const }));
const baseInput = {
  schemaVersion: 1, contextRevision: 5, variantName: "Late-return charges", problemStatement: "Late-return charges on rented equipment are applied inconsistently and disputed.",
  currentMessage: { id: "M2", text: PARAGRAPH }, evidence: [],
  fields: [
    { id: "st_a_name", label: "AS_IS step st_a: name", value: "Equipment return", status: "KNOWN" },
    { id: "st_a_description", label: "AS_IS step st_a: description", value: "A customer returns rented equipment at the counter.", status: "KNOWN" },
    ...empty("st_a", ["actor", "system", "trigger", "inputs", "outputs", "controls"]),
    { id: "st_b_name", label: "AS_IS step st_b: name", value: "Late-return charge", status: "KNOWN" },
    { id: "st_b_description", label: "AS_IS step st_b: description", value: "The back office charges for late returns.", status: "KNOWN" },
    ...empty("st_b", ["actor", "system", "trigger", "inputs", "outputs", "controls"]),
  ],
  activeGaps: [], closedGapKeys: [], unextractedMessageIds: [], history: [], requirements: [],
  steps: [{ id: "st_a", name: "Equipment return", summary: "A customer returns rented equipment at the counter.", status: "CURRENT" },
    { id: "st_b", name: "Late-return charge", summary: "The back office charges for late returns.", status: "CURRENT" }],
};
// Three existing steps, none about damage inspection; the message is the new-step paragraph.
const newStepInput = {
  ...baseInput, currentMessage: { id: "M5", text: DAMAGE_MESSAGE },
  fields: [...baseInput.fields,
    { id: "st_c_name", label: "AS_IS step st_c: name", value: "Machine hand-over", status: "KNOWN" },
    { id: "st_c_description", label: "AS_IS step st_c: description", value: "The yard hands a cleaned machine to the next customer.", status: "KNOWN" },
    ...empty("st_c", ["actor", "system", "trigger", "inputs", "outputs", "controls"])],
  steps: [...baseInput.steps, { id: "st_c", name: "Machine hand-over", summary: "The yard hands a cleaned machine to the next customer.", status: "CURRENT" }],
};
// A fixed fictional workspace shaped like the real project: 7 current steps (as the report names them), some fields KNOWN and some EMPTY
// (the model sees only EMPTY fields plus name and description of each step), a late-return scope, and earlier messages as evidence.
const projectStep = (n: number, name: string | null, description: string, emptyKeys: string[]) => ({
  fields: [{ id: `st_${n}_name`, label: `AS_IS step st_${n}${name ? ` (${name.slice(0, 60)})` : ""}: name`, value: name, status: name ? "KNOWN" as const : "EMPTY" as const },
    { id: `st_${n}_description`, label: `AS_IS step st_${n}: description`, value: description, status: "KNOWN" as const }, ...empty(`st_${n}`, emptyKeys)],
  step: { id: `st_${n}`, name, summary: description, status: "CURRENT" as const },
});
const projectSteps = [
  projectStep(1, "A customer returns rented equipment", "A customer brings rented equipment back to the branch counter.", ["inputs", "outputs", "controls"]),
  projectStep(2, "The counter clerk checks the returned date against the contract end date", "The clerk scans the tag and compares the return time with the contract end by eye.", ["outputs", "controls", "exceptions"]),
  projectStep(3, "the clerk manually decides a late-return charge", "The clerk decides a day rate times days late from a laminated rate card.", ["inputs", "controls", "exceptions"]),
  projectStep(4, "The clerk emails the charge to the branch accountant", "The clerk emails contract number, days late and amount to the branch accountant.", ["controls", "exceptions"]),
  projectStep(5, null, "The branch accountant types each charge into the Excel invoicing sheet, once a day at most.", ["controls", "exceptions"]),
  projectStep(6, "branch staff learn the rules by word of mouth", "The Head of Rental Operations publishes the rate card and policy PDF; branch managers brief clerks verbally.", ["inputs", "outputs", "controls"]),
  projectStep(7, "dispute is credited", "The branch manager emails head office finance, who raise a credit note in the legacy invoicing tool.", ["actor", "controls", "exceptions"]),
];
const context = (id: string, label: string, value: string | null) => ({ id, label, value, status: value ? "KNOWN" as const : "EMPTY" as const });
const projectShapeInput = {
  ...baseInput, variantName: "Late-return charges", problemStatement: "Late-return charges on rented equipment are decided by hand, applied differently at each of 12 branches and often disputed.",
  currentMessage: { id: "M9", text: DAMAGE_MESSAGE.replace("One more step we have not covered, the damage inspection", "A separate step again, the damage inspection") },
  evidence: [
    { id: "M4", text: "At the counter the clerk also writes an inspection note on the paper return slip and takes damage photos with the branch phone. The photos stay on the phone and are rarely attached to the contract. When a customer disputes a charge nobody can find the photos." },
    { id: "M6", text: "Late returns are decided by the clerk. Each branch has its own grace period, from 0 to 24 hours, and clerks often waive the fee without approval. About 15 percent of late charges are disputed." },
    { id: "M7", text: "The charge goes to the branch accountant by email, who keys it into the Excel invoicing sheet. About 10 percent of the emails are lost or carry the wrong amount." },
  ],
  fields: [
    context("business_problem", "CONTEXT: Business problem", "Late-return charges on rented equipment are decided by hand and disputed."),
    context("process_overview", "CONTEXT: Process overview", "A customer returns equipment, the clerk checks the date, decides a charge and emails it to the branch accountant."),
    context("process_owner", "CONTEXT: Process owner", "Head of Rental Operations"),
    context("scope_boundary", "CONTEXT: Process scope", "Late-return charges on rented equipment at the 12 branches, from the return at the counter to the invoiced charge and any dispute credit."),
    context("current_systems", "AS_IS: Current systems and handoffs", null),
    context("external_parties", "AS_IS: External parties involved", null),
    context("current_exceptions", "AS_IS: Current exceptions", null),
    context("current_financial", "AS_IS: Current financial effects", null),
    ...projectSteps.flatMap(item => item.fields),
  ],
  steps: projectSteps.map(item => item.step),
};
const input = parseInterviewInput(PROJECT_SHAPE ? projectShapeInput : NEW_STEP ? newStepInput : baseInput);
if (config.AI_PROVIDER === "stub") { console.error("Provider is the offline stub: set AI_PROVIDER and AI_MODEL (real provider) and run again."); process.exit(1); }
const runStage = createStageRunner(config, { issueDetail: true });
if (NEW_STEP) {
  for (let run = 1; run <= REPEAT; run++) {
    const { payload, metrics } = await runStage("extraction_turn", input);
    const warnings = metrics.warnings ?? [];
    console.log(`run ${run}/${REPEAT} | provider ${metrics.provider} model ${metrics.model}; message length ${input.currentMessage.text.length}`);
    console.log(`  returned: ${payload.proposedUpdates.length} updates, ${payload.proposedSteps.length} steps, ${payload.proposedRequirements.length} requirements, ${payload.observations.length} observations`);
    for (const step of payload.proposedSteps) {
      console.log(`  step | name hint: ${step.nameHint ?? "(none)"} | value length ${step.value.length} | details kept: ${step.details?.length ?? 0}`);
      for (const detail of step.details ?? []) console.log(`    detail | ${detail.key} = ${detail.value}`);
    }
    const droppedDetails = warnings.filter(w => w.code === "step_detail_dropped");
    console.log(`  dropped step details: ${droppedDetails.length}`);
    for (const w of droppedDetails) console.log(`    ${w.path} | ${w.detail ?? ""}`);
    console.log(`  warnings: ${warnings.length}`);
    for (const w of warnings) console.log(`    ${w.path} | ${w.code}${w.detail ? ` | ${w.detail}` : ""}`);
  }
  process.exit(0);
}
const { payload, metrics } = await runStage("extraction_turn", input);
console.log(`provider ${metrics.provider} model ${metrics.model}; message length ${input.currentMessage.text.length}`);
console.log(`proposals: ${payload.proposedUpdates.length} field updates, ${payload.proposedSteps.length} steps, ${payload.proposedRequirements.length} requirements`);
for (const update of payload.proposedUpdates) console.log(`  ${update.fieldId} | length ${update.value.length} | ${update.value === update.quote ? "full quote" : "span of quote"} | ${update.value.slice(0, 80)}`);
const fallbacks = (metrics.warnings ?? []).filter(w => w.code === "answer_fallback");
console.log(`answers that fell back to the whole quote: ${fallbacks.length}`);
for (const w of fallbacks) console.log(`  ${w.path} (${w.detail})`);
const guarded = (metrics.warnings ?? []).filter(w => w.code === "update_dropped" && ["echoed_value", "too_long_for_field"].includes(w.detail ?? ""));
console.log(`dropped by the echo guard: ${guarded.length}`);
for (const w of guarded) console.log(`  ${w.path} (${w.detail})`);
console.log(`other warnings: ${(metrics.warnings ?? []).length - guarded.length - fallbacks.length}`);
if (process.argv.includes("--with-chat")) {
  const chat = await runStage("interview_turn", { ...input, activeGaps: [{ key: "g_st_a_actor", fieldId: "st_a_actor", stepId: "st_a", priority: "CRITICAL", detail: "Who performs this step today?" }],
    unextractedMessageIds: ["M2"] });
  console.log(`chat questions: ${chat.payload.questions.length}`);
  for (const q of chat.payload.questions) console.log(`  [${q.gapKey}] ${q.question}`);
}
