import { z } from "zod";

const required = z.string().trim().min(1);
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "max"] as const;
/** Model every stage runs on when AI_PROVIDER=openrouter and AI_MODEL is unset (list price USD per MTok: 0.15 in, 0.60 out). */
const OPENROUTER_DEFAULT_PRICES: [number, number] = [0.15, 0.6];
export const OPENROUTER_DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";
const httpUrl = z.url({ protocol: /^https?$/ });
// A blank variable means "use the default", not zero.
const price = (fallback: number) => z.preprocess((value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.coerce.number().min(0).default(fallback));
// Whole number within [min, max]; a blank variable means "use the default".
const whole = (fallback: number, min: number, max: number) => z.preprocess((value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.coerce.number().int().min(min).max(max).default(fallback));
const seconds = whole;
const blankToUndefined = (value: unknown) => (typeof value === "string" && !value.trim() ? undefined : value);
// JSON object: model id -> [input USD/MTok, output USD/MTok]. Unparseable text is passed on as-is and fails the record check.
const modelPrices = z.preprocess((value) => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try { return JSON.parse(value); } catch { return value; }
}, z.record(z.string().trim().min(1), z.tuple([z.number().positive().max(1000), z.number().positive().max(1000)])).default({}));
/** The AI stages the runner knows; runStage derives its Stage type from this list. */
export const STAGE_NAMES = ["problem_analysis", "to_be", "interview_turn", "extraction_turn"] as const;
/** The To-Be stage runs as an outline call, one call per step, eight register calls and a consistency review of the finished design; each kind can have
 * reasoning switched off on its own ("to_be" covers all). They are request kinds inside one stage, so they are not in STAGE_NAMES. */
export const TO_BE_SUBSTAGES = ["to_be_outline", "to_be_step", "to_be_registers", "to_be_review"] as const;
// Comma-separated stage or To-Be substage names; blank or unset means none. Unknown names are rejected.
const stageList = z.preprocess((value) => typeof value === "string"
  ? value.split(",").map((name) => name.trim()).filter(Boolean) : value, z.array(z.enum([...STAGE_NAMES, ...TO_BE_SUBSTAGES])).default([]));
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  APP_URL: httpUrl,
  AUTH_SECRET: z.string().min(32),
  AI_PROVIDER: z.enum(["anthropic", "deepinfra", "openrouter", "stub"]),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEEPINFRA_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  // Model for every stage except design, for any provider: anthropic -> claude-sonnet-5-5, deepinfra -> XiaomiMiMo/MiMo-V2.6-Flash, openrouter -> deepseek/deepseek-v4.1-flash-1017 (applied below when unset).
  AI_MODEL: required.default("claude-sonnet-5-5"),
  // Optional stronger/slower model for the long To-Be design stage only; unset means AI_MODEL runs every stage.
  AI_MODEL_DESIGN: z.preprocess(blankToUndefined, required.optional()),
  AI_MAX_INPUT_TOKENS: z.coerce.number().int().positive().default(60000),
  CONSULTANT_DAILY_JOB_LIMIT: z.coerce.number().int().min(1).max(100000).default(200),
  AI_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // Model-call slots reserved for interview (chat) turns, separate from AI_MAX_CONCURRENCY (To-Be, problem analysis),
  // so a long batch stage never delays a chat turn.
  AI_CHAT_CONCURRENCY: z.coerce.number().int().positive().default(3),
  // Time budgets. The defaults are sized for Claude; slower models need more (see README, "AI time budgets").
  AI_STAGE_BUDGET_SECONDS: seconds(300, 60, 1800),
  AI_CALL_TIMEOUT_SECONDS: seconds(120, 30, 1500),
  AI_DESIGN_CALL_TIMEOUT_SECONDS: seconds(240, 30, 1500),
  // To-Be step calls in flight at once within one design stage (whole number, not seconds). Held under the stage's single AI_MAX_CONCURRENCY permit.
  AI_DESIGN_PARALLELISM: seconds(4, 1, 16),
  // Outline repair calls after the first outline answer (0-2). The second repair only runs while more than half of AI_STAGE_BUDGET_SECONDS remains.
  AI_TO_BE_OUTLINE_REPAIRS: whole(2, 0, 2),
  // Re-requests per To-Be step or register call after its first answer (0-2); the second only while more than half of the stage budget remains.
  AI_TO_BE_PART_REPAIRS: whole(2, 0, 2),
  // Consistency review: after a valid design is assembled, one call reads the whole of it and lists contradictions, missing links, unresolved codes and gaps; each finding that
  // names a step or register group sends that part back once. "off" skips the call. It also runs only while more than a quarter of AI_STAGE_BUDGET_SECONDS remains.
  AI_TO_BE_REVIEW: z.preprocess(blankToUndefined, z.enum(["on", "off"]).default("on")),
  // Output-token ceilings (max_tokens) of the three To-Be request kinds. Reasoning tokens count against them, so a model that
  // thinks needs room above the visible JSON (outline ~3k, step ~3k, register group ~3.5k tokens without reasoning).
  AI_TO_BE_OUTLINE_MAX_TOKENS: whole(16000, 1000, 64000),
  AI_TO_BE_STEP_MAX_TOKENS: whole(8000, 1000, 64000),
  AI_TO_BE_REGISTERS_MAX_TOKENS: whole(8000, 1000, 64000),
  // Stages run with model reasoning off (DeepInfra and OpenRouter; `thinking: {type: "disabled"}`). Empty = every stage keeps default reasoning.
  AI_NO_THINKING_STAGES: stageList,
  // OpenRouter only: reasoning effort sent as `output_config: {effort}` (OpenRouter maps it to its unified reasoning.effort); "none" sends
  // thinking disabled. Unset = "max" (OpenRouter accepts max, xhigh, high, medium, low, minimal, none). Ignored by the other providers.
  AI_REASONING_EFFORT: z.preprocess(blankToUndefined, z.enum(REASONING_EFFORTS).optional()),
  AI_FAULT_INJECTION: z.string().regex(
    /^(problem_analysis|as_is|gap|to_be|change_doc|blueprint_narrative):(timeout|invalid|error)(:once)?$/,
  ).optional(),
  EMAIL_PROVIDER: z.enum(["resend", "stub", "disabled"]),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.email(),
  S3_ENDPOINT: httpUrl,
  S3_REGION: required,
  S3_BUCKET: required,
  S3_ACCESS_KEY_ID: required,
  S3_SECRET_ACCESS_KEY: required,
  DEMO_ACCESS_PASSWORD: z.string().min(24).optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Comma-separated sign-in emails of SaaS operators; empty or unset means nobody is a platform admin.
  PLATFORM_ADMIN_EMAILS: z.string().optional().transform((value) =>
    (value ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean)),
  // Claude Sonnet 5.5 list price, USD per million tokens (per-model overrides: AI_MODEL_PRICES); used only for the admin cost estimate.
  AI_PRICE_INPUT_USD_PER_MTOK: price(2),
  AI_PRICE_OUTPUT_USD_PER_MTOK: price(10),
  // Per-model override of the two prices above, keyed by the model id recorded in job metrics.
  AI_MODEL_PRICES: modelPrices,
}).superRefine((config, context) => {
  const invalid = (name: string) => context.addIssue({ code: "custom", path: [name], message: "Invalid configuration" });
  if (config.AI_PROVIDER === "anthropic" && !config.ANTHROPIC_API_KEY?.trim()) invalid("ANTHROPIC_API_KEY");
  if (config.AI_PROVIDER === "deepinfra" && !config.DEEPINFRA_API_KEY?.trim()) invalid("DEEPINFRA_API_KEY");
  if (config.AI_PROVIDER === "openrouter" && !config.OPENROUTER_API_KEY?.trim()) invalid("OPENROUTER_API_KEY");
  // Claude rejects thinking: {type: "disabled"} with a 400, so the setting is refused rather than silently ignored.
  if (config.AI_PROVIDER === "anthropic" && config.AI_NO_THINKING_STAGES.length) invalid("AI_NO_THINKING_STAGES");
  // A single call can never outlive the stage that contains it.
  if (config.AI_CALL_TIMEOUT_SECONDS > config.AI_STAGE_BUDGET_SECONDS) invalid("AI_CALL_TIMEOUT_SECONDS");
  if (config.AI_DESIGN_CALL_TIMEOUT_SECONDS > config.AI_STAGE_BUDGET_SECONDS) invalid("AI_DESIGN_CALL_TIMEOUT_SECONDS");
  if (config.EMAIL_PROVIDER === "resend" && !config.EMAIL_API_KEY?.trim()) invalid("EMAIL_API_KEY");
  // Google sign-in needs both halves of the client credential, or neither.
  if (!config.GOOGLE_CLIENT_ID?.trim() !== !config.GOOGLE_CLIENT_SECRET?.trim()) {
    invalid(config.GOOGLE_CLIENT_ID?.trim() ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID");
  }
  if (config.NODE_ENV === "production") {
    if (config.AUTH_SECRET.startsWith("local-dev-only")) invalid("AUTH_SECRET");
    if (!config.APP_URL.startsWith("https://")) invalid("APP_URL");
    if (!config.S3_ENDPOINT.startsWith("https://")) invalid("S3_ENDPOINT");
    if (config.EMAIL_PROVIDER === "stub") invalid("EMAIL_PROVIDER");
  }
});

export type Environment = Readonly<z.infer<typeof schema>>;

/** Server-only configuration. Call once from each process's startup entry point. */
export function parseEnvironment(input: Record<string, string | undefined> = process.env): Environment {
  // PRD §4: test hooks must have no effect in production, including invalid fault strings.
  const effective: Record<string, string | undefined> = input.NODE_ENV === "production"
    ? { ...input, AI_PROVIDER: input.AI_PROVIDER === "stub" ? "anthropic" : input.AI_PROVIDER, AI_FAULT_INJECTION: undefined }
    : { ...input, AI_FAULT_INJECTION: input.AI_FAULT_INJECTION || undefined };
  const withModel = effective.AI_PROVIDER === "openrouter" && !effective.AI_MODEL?.trim()
    ? { ...effective, AI_MODEL: OPENROUTER_DEFAULT_MODEL } : effective;
  const result = schema.safeParse(withModel);
  if (!result.success) {
    // Zod messages and input values can contain secrets. Report variable names only.
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment variables: ${names.join(", ")}`);
  }
  // Price the default OpenRouter model out of the box (an explicit AI_MODEL_PRICES entry wins).
  const prices = result.data.AI_PROVIDER === "openrouter" ? { [OPENROUTER_DEFAULT_MODEL]: OPENROUTER_DEFAULT_PRICES, ...result.data.AI_MODEL_PRICES } : result.data.AI_MODEL_PRICES;
  return Object.freeze({ ...result.data, AI_MODEL_PRICES: prices });
}
