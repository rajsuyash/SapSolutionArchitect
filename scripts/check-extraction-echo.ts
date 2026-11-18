// One real extraction call (plus an optional chat call) on a fixed fictional transcript that reproduces the "echoed chat text" problem:
// one long pasted paragraph describing two steps of a late-return process, with the step details still empty.
//
//   node --import tsx scripts/check-extraction-echo.ts [--with-chat | --new-step]
//
// --new-step: instead, a message that describes a step NOT in the workspace (damage inspection; 3 existing steps, none about it), to see whether
// the model proposes it as a step. Prints counts, each proposed step (name hint, value length) and every warning as code/detail.
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
const NEW_STEP = process.argv.includes("--new-step");
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
const input = parseInterviewInput(NEW_STEP ? newStepInput : baseInput);
if (config.AI_PROVIDER === "stub") { console.error("Provider is the offline stub: set AI_PROVIDER and AI_MODEL (real provider) and run again."); process.exit(1); }
const runStage = createStageRunner(config, { issueDetail: true });
const { payload, metrics } = await runStage("extraction_turn", input);
console.log(`provider ${metrics.provider} model ${metrics.model}; message length ${input.currentMessage.text.length}`);
if (NEW_STEP) {
  console.log(`returned: ${payload.proposedUpdates.length} updates, ${payload.proposedSteps.length} steps, ${payload.proposedRequirements.length} requirements, ${payload.observations.length} observations`);
  for (const step of payload.proposedSteps) console.log(`  step | name hint: ${step.nameHint ?? "(none)"} | value length ${step.value.length}`);
  const warnings = metrics.warnings ?? [];
  console.log(`warnings: ${warnings.length}`);
  for (const w of warnings) console.log(`  ${w.path} | ${w.code}${w.detail ? ` | ${w.detail}` : ""}`);
  process.exit(0);
}
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
