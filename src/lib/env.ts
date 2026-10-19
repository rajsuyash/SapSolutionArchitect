import { z } from "zod";

const required = z.string().trim().min(1);
const httpUrl = z.url({ protocol: /^https?$/ });
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  APP_URL: httpUrl,
  AUTH_SECRET: z.string().min(32),
  AI_PROVIDER: z.enum(["anthropic", "stub"]),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: required.default("claude-sonnet-5-5"),
  AI_MAX_INPUT_TOKENS: z.coerce.number().int().positive().default(60000),
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
}).superRefine((config, context) => {
  const invalid = (name: string) => context.addIssue({ code: "custom", path: [name], message: "Invalid configuration" });
  if (config.AI_PROVIDER === "anthropic" && !config.ANTHROPIC_API_KEY?.trim()) invalid("ANTHROPIC_API_KEY");
  if (config.EMAIL_PROVIDER === "resend" && !config.EMAIL_API_KEY?.trim()) invalid("EMAIL_API_KEY");
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
