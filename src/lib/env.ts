import { z } from "zod";

const required = z.string().trim().min(1);
const httpUrl = z.url({ protocol: /^https?$/ });
// A blank variable means "use the default", not zero.
const price = (fallback: number) => z.preprocess((value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z.coerce.number().min(0).default(fallback));
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  APP_URL: httpUrl,
  AUTH_SECRET: z.string().min(32),
  AI_PROVIDER: z.enum(["anthropic", "deepinfra", "stub"]),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEEPINFRA_API_KEY: z.string().optional(),
  // One model setting for every provider: anthropic -> claude-sonnet-5-5, deepinfra -> XiaomiMiMo/MiMo-V2.6-Pro.
  AI_MODEL: required.default("claude-sonnet-5-5"),
  AI_MAX_INPUT_TOKENS: z.coerce.number().int().positive().default(60000),
  CONSULTANT_DAILY_JOB_LIMIT: z.coerce.number().int().min(1).max(100000).default(200),
  AI_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),
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
  // Claude Sonnet 5.5 list price, USD per million tokens (MiMo-V2.6-Pro on DeepInfra: 0.43 / 0.87); used only for the admin cost estimate.
  AI_PRICE_INPUT_USD_PER_MTOK: price(2),
  AI_PRICE_OUTPUT_USD_PER_MTOK: price(10),
}).superRefine((config, context) => {
  const invalid = (name: string) => context.addIssue({ code: "custom", path: [name], message: "Invalid configuration" });
  if (config.AI_PROVIDER === "anthropic" && !config.ANTHROPIC_API_KEY?.trim()) invalid("ANTHROPIC_API_KEY");
  if (config.AI_PROVIDER === "deepinfra" && !config.DEEPINFRA_API_KEY?.trim()) invalid("DEEPINFRA_API_KEY");
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
  const effective = input.NODE_ENV === "production"
    ? { ...input, AI_PROVIDER: input.AI_PROVIDER === "stub" ? "anthropic" : input.AI_PROVIDER, AI_FAULT_INJECTION: undefined }
    : { ...input, AI_FAULT_INJECTION: input.AI_FAULT_INJECTION || undefined };
  const result = schema.safeParse(effective);
  if (!result.success) {
    // Zod messages and input values can contain secrets. Report variable names only.
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid environment variables: ${names.join(", ")}`);
  }
  return Object.freeze(result.data);
}
