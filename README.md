# SAP Solution Architect

A private demo for capturing SAP transformation projects and reviewing AI-generated process scope. The implemented flow is sign in → create project → analyze business problem → review objectives, quoted pain points, proposed processes, and clarifying questions.

The consultant workflow adds a guided discovery conversation per process variant, lead/consultant confirmation of the As-Is, a To-Be design generated from the confirmed revision, and Markdown and CSV exports. Invitations and full blueprint exports are still in development. AI proposals require human review.

## Consultant workflow

1. In a project, start a discovery conversation for a process variant (up to 20 per project). Answer the consultant's questions; messages containing emails, passwords or tokens are refused before they are saved.
2. A project lead or consultant confirms the As-Is once the gaps are resolved. Confirmation pins an immutable revision.
3. Generate the To-Be design from that revision. The result is a reviewable report (blockers, comparison, traceability) with `report.md` and `traceability.csv` downloads. Nothing is approved automatically; SAP claims are trusted only when they cite the curated, VERIFIED reference catalog in `fixtures/sap`.

Cost controls: `CONSULTANT_DAILY_JOB_LIMIT` (default 200) caps consultant jobs per organization per rolling 24 hours (HTTP 429 `RATE_LIMITED` with `Retry-After`). The To-Be outline call (the largest) measured about 23000 tokens by chars/4 (about 34000 on DeepInfra MiMo) with a 65-entry catalog, so the 60000 default is enough.

The worker must start with its working directory at the repository root so it finds `fixtures/sap`. It resolves the catalog directory at startup and exits with an error if it is missing or malformed, rather than silently treating every SAP claim as unverified.

## Live demo

- URL: https://sap-web-965411321011.europe-west1.run.app
- Hosting: Google Cloud project `sap-solution-architect-demo` (`europe-west1`): Cloud Run service `sap-web`, Cloud Run worker pool `sap-worker`, Cloud SQL Postgres `sap-pg`, and a Cloud Storage bucket for files. See [Deployment](#deployment).
- The browser first requests the private demo credentials, then the application account credentials. The presenter credentials are stored locally in the ignored `.env.demo-access` file; never commit or publish this file.
- Three fictional project scenarios live in `fixtures/e2e/synthetic-projects.json`. The deployed demo uses real Anthropic analysis, not the test stub.

Budget roughly **US$60/month for demo hosting** (always-on worker about $50, Cloud SQL micro about $10), excluding Anthropic usage and tax; this is an estimate, not a spending cap. A budget alert of ₹6,500 is set on the billing account.

## Local development

Requires Node 22.12+, pnpm 10.30, and Docker.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait
pnpm db:seed
pnpm dev --port 3017
# In another terminal:
node --import tsx --env-file=.env src/worker.ts
```

The fixture accounts are local-only. Production explicitly refuses `db:seed`; deploy migrations with `pnpm db:migrate` or the Node command below.

## Deployment

Production runs on Google Cloud: project `sap-solution-architect-demo`, region `europe-west1`, account `suyash@voxdonna.com` (always pass `--project` and `--account`). Railway is retired: its web and worker deployments were removed on 2026-10-22 after Railway's 2026-10-21 security incident, and its Postgres still exists pending a decision.

Order matters: build the image, run migrations, deploy the worker, then deploy web. Both services use the root Dockerfile image `europe-west1-docker.pkg.dev/sap-solution-architect-demo/app/sap:<git-sha>` (Artifact Registry repo `app`; it keeps the 5 newest images). Build from a clean worktree of the commit so untracked local files can never be uploaded (`.dockerignore` also excludes `*.xlsx`):

```sh
git worktree add --detach <dir> <sha>
gcloud builds submit <dir> --config=deploy/gcp/cloudbuild.yaml --substitutions=_TAG=<sha> --region=europe-west1
```

| Setting | Web | Worker |
|---|---|---|
| Resource | Cloud Run service `sap-web` | Cloud Run worker pool `sap-worker` |
| Start command | Dockerfile CMD (`node node_modules/next/dist/bin/next start --hostname 0.0.0.0`) | `node --import tsx src/worker.ts` |
| Health check | Startup probe on `/api/health`, port 3000 | None; checked through web queue probe |
| Instances | min 0, max 3 | 1 (1 vCPU / 1 GiB) |

- **Database:** Cloud SQL Postgres 16 `sap-pg` (db-f1-micro), private IP only (org policy forbids a public IP); database and user `sap_pm`. Services reach it through Direct VPC egress: `--network=default --subnet=default --vpc-egress=private-ranges-only`.
- **Migrations:** Cloud Run job `sap-migrate` runs the same image with `node --import tsx scripts/seed.ts --migrate-only` under the existing migration lock. Run `gcloud run jobs deploy sap-migrate --image=... --execute-now --wait` (or `gcloud run jobs execute sap-migrate --wait` after updating the image) before deploying the worker.
- **Worker:** deploy with `gcloud run worker-pools deploy sap-worker` (this command needs the Python `grpc` module available to gcloud). Wait for "Worker ready" in its logs before deploying web.
- **Web:** `sap-web` is public via `--no-invoker-iam-check` (org policy blocks `allUsers`); the demo gate and login protect it. URL: https://sap-web-965411321011.europe-west1.run.app, which is also `APP_URL`.
- **Identity and config:** services run as `sap-runtime@sap-solution-architect-demo.iam.gserviceaccount.com`. Secrets live in Secret Manager and are mounted with `--set-secrets`: `database-url`→`DATABASE_URL`, `auth-secret`→`AUTH_SECRET`, `anthropic-api-key`→`ANTHROPIC_API_KEY`, `demo-access-password`→`DEMO_ACCESS_PASSWORD`, `s3-access-key-id`→`S3_ACCESS_KEY_ID`, `s3-secret-access-key`→`S3_SECRET_ACCESS_KEY`. Plain env: `S3_ENDPOINT=https://storage.googleapis.com`, `S3_REGION=auto`, `S3_BUCKET=sap-solution-architect-demo-files` (Cloud Storage through its S3-compatible API with an HMAC key).

Never pass secrets as Docker build arguments or commit them. Required variables are documented in `.env.example` and validated in `src/lib/env.ts`. Production uses HTTPS for `APP_URL` and `S3_ENDPOINT`, a random `AUTH_SECRET`, real Anthropic credentials, and `EMAIL_PROVIDER=disabled` until email features exist. Set `DEMO_ACCESS_PASSWORD` to a random string of at least 24 characters to enable the additional demo gate (username `demo`). The gate does not replace session or tenant authorization.

**AI provider.** `AI_PROVIDER` is `stub` (offline fixtures, never allowed in production), `anthropic`, or `deepinfra`. Both real providers use the Anthropic Messages protocol through the same SDK. `AI_MODEL` is the model for every stage except the long To-Be design stage, which uses `AI_MODEL_DESIGN` when it is set (and `AI_MODEL` when it is not).

| `AI_PROVIDER` | Key | `AI_MODEL` | Admin cost estimate (USD per M tokens) |
| --- | --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` | `AI_PRICE_INPUT_USD_PER_MTOK=2`, `AI_PRICE_OUTPUT_USD_PER_MTOK=10` (defaults) |
| `deepinfra` | `DEEPINFRA_API_KEY` | `XiaomiMiMo/MiMo-V2.6-Flash` (`AI_MODEL_DESIGN=XiaomiMiMo/MiMo-V2.6-Pro`) | `AI_MODEL_PRICES`, below |

**Model per stage.** The fast chat stages (interview turn, problem analysis) need low latency; the To-Be design stage needs the stronger, slower model. Measured on DeepInfra on 2026-10-22: MiMo-V2.6-Flash about 48 output tokens/s, MiMo-V2.6-Pro about 12. Recommended for `AI_PROVIDER=deepinfra`:

```sh
AI_MODEL=XiaomiMiMo/MiMo-V2.6-Flash
AI_MODEL_DESIGN=XiaomiMiMo/MiMo-V2.6-Pro
AI_MODEL_PRICES={"XiaomiMiMo/MiMo-V2.6-Flash":[0.14,0.28],"XiaomiMiMo/MiMo-V2.6-Pro":[0.43,0.87]}
```

**Reasoning off for fast chat turns.** `AI_NO_THINKING_STAGES` is an optional comma-separated list of stage names (`problem_analysis`, `interview_turn`, `to_be`, plus the To-Be request kinds `to_be_outline`, `to_be_step` and `to_be_registers`; `to_be` covers all three; unknown names are rejected; empty or unset keeps today's behaviour). For each listed stage, and only when `AI_PROVIDER` is `deepinfra` or `openrouter`, the request carries `thinking: {"type": "disabled"}` and the job metrics record `thinkingDisabled: true`. Measured on 2026-10-22 with MiMo-V2.6-Pro on DeepInfra's Anthropic-compatible endpoint (one small tool-call request): reasoning on 94 s, reasoning off 18-21 s with a valid tool call each time; `reasoning_effort` is ignored on that endpoint. Recommended production value for MiMo on DeepInfra: `AI_NO_THINKING_STAGES=interview_turn`; keep reasoning on for `to_be`. **OpenRouter provider.** `AI_PROVIDER=openrouter` (needs `OPENROUTER_API_KEY`) calls `https://openrouter.ai/api/v1/messages` with `Authorization: Bearer`, a forced tool choice like DeepInfra, and defaults `AI_MODEL`/`AI_MODEL_DESIGN` to `deepseek/deepseek-v4.1-flash-1017` (priced 0.15/0.60 USD per MTok by default). `AI_REASONING_EFFORT` (`none|low|medium|high|max`, default `max`) is sent as `output_config: {effort}`, which OpenRouter maps to its `reasoning.effort`; `none`, or a stage in `AI_NO_THINKING_STAGES`, sends `thinking: {type: disabled}` instead. OpenRouter has no `count_tokens`, so `AI_MAX_INPUT_TOKENS` is checked against a local estimate (characters / 3.5). **Claude caveat:** Claude Sonnet 5.5 on the Anthropic API answers 400 to `thinking: {"type": "disabled"}` (it only accepts `{"type": "between_tools"}`), so `AI_PROVIDER=anthropic` with a non-empty `AI_NO_THINKING_STAGES` is refused at startup. When an interview turn proposes more than 12 updates, the first 12 (model order) are kept and a `proposals_truncated` warning records how many were dropped; every kept proposal is still quote-checked and needs user acceptance.

`AI_MODEL_DESIGN` is optional; unset, `AI_MODEL` runs every stage. Which stages count as design stages is defined once in `src/lib/ai/runStage.ts` (`DESIGN_STAGES`, currently `to_be`); the same set also selects `AI_DESIGN_CALL_TIMEOUT_SECONDS`. The model actually used is recorded in each job's metrics, and its `count_tokens` guard uses the same model as the call.

**Cost estimate.** `AI_MODEL_PRICES` is an optional JSON object mapping a model id to `[inputUsdPerMTok, outputUsdPerMTok]` (positive numbers, at most 1000). The `/admin` estimate prices each job's tokens by the model recorded in its metrics and falls back to `AI_PRICE_INPUT_USD_PER_MTOK` / `AI_PRICE_OUTPUT_USD_PER_MTOK` (defaults 2 / 10) for a model without an entry and for jobs recorded before models were stored. It remains an estimate, not a bill. Per-model usage comes from the SQL function added in migration `0011_platform_admin_usage_by_model.sql`.

DeepInfra requests go to `https://api.deepinfra.com/anthropic` and carry no Claude-specific parameters (thinking, effort, betas, cache control). The model's `thinking` blocks are ignored. Provider failures stay generic for users; the server logs one JSON line per failure (`ai_provider_error` with provider, model, stage, HTTP status, error type and a category: credit, auth, rate_limit, overloaded, invalid_request, timeout, unknown) and never the prompt or key.

**AI time budgets.** Three variables, whole seconds, validated at startup (a per-call value above the stage budget stops the process):

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `AI_STAGE_BUDGET_SECONDS` | 300 | 60-1800 | Whole stage, including repair attempts |
| `AI_CALL_TIMEOUT_SECONDS` | 120 | 30-1500 | One model call, ordinary stages (problem analysis, interview turn) |
| `AI_DESIGN_CALL_TIMEOUT_SECONDS` | 240 | 30-1500 | One model call within the To-Be design stage (the outline call, up to 8000 output tokens, or one step call, up to 6000) |

The defaults suit Claude. A slow model needs more: MiMo-V2.6-Pro on DeepInfra produces about 12-40 output tokens/s (12 measured on 2026-10-22), so a single 24000-token call (the former one-shot To-Be) needed about 2000 s and always timed out. Recommended for `AI_PROVIDER=deepinfra`: `AI_STAGE_BUDGET_SECONDS=1200`, `AI_CALL_TIMEOUT_SECONDS=300`, `AI_DESIGN_CALL_TIMEOUT_SECONDS=1000`. The provider choice no longer changes any timeout by itself.

**To-Be output ceilings.** `AI_TO_BE_OUTLINE_MAX_TOKENS` (default 16000), `AI_TO_BE_STEP_MAX_TOKENS` (8000) and `AI_TO_BE_REGISTERS_MAX_TOKENS` (8000), each 1000-64000, are the `max_tokens` of the three To-Be request kinds. Reasoning tokens count against them, so a thinking model such as MiMo needs room above the visible JSON (an 11-step, 16-requirement outline is about 3k tokens without reasoning; at 8000 two outline calls both hit the limit on 2026-10-23). A response that stops on `max_tokens` is recorded as validation issue `OUTPUT_TRUNCATED` (path = request kind) instead of a missing payload, and the repair request then carries a fixed `repairNote` telling the model its previous answer was cut off and must be more concise (no model text echoed). That re-ask (and one after an answer with no tool payload) runs with the call's ceiling doubled, up to 64000, and does not use up one of the call's repairs (`AI_TO_BE_OUTLINE_REPAIRS`, `AI_TO_BE_PART_REPAIRS`), so a draft that is wrong keeps its own repairs; each raised call logs `ai_output_ceiling_raised` and adds the warning `OUTPUT_CEILING_RAISED` (path = the step, register group or outline, detail = the new ceiling). Once the cap is reached the ordinary repairs apply.

**To-Be design generation (skeleton, then parallel expansion).** The `to_be` stage is not one model call. Call 1 (`submit_to_be_outline`, prompt `prompts/to_be_outline.system.md`) returns the outline: steps with trace, SAP fit kind and references, eliminated As-Is steps, coverage, conflict decisions and open questions (target under 6000 output tokens). It is validated with the same mechanical checks as a full design (trace, coverage, catalog-only reference ids, SAP fit ladder) and repaired up to `AI_TO_BE_OUTLINE_REPAIRS` times (default 2, 0-2; the second repair only while more than half of `AI_STAGE_BUDGET_SECONDS` remains; a repair answer that blanks a list field the previous answer had right gets the previous value back, warning `REPAIRED_FROM_PREVIOUS_ATTEMPT`). Then one call per step (`submit_to_be_step`, prompt `prompts/to_be_step.system.md`, target under 3000 output tokens) runs with the outline frozen, `AI_DESIGN_PARALLELISM` (default 4, 1-16) at a time. The pieces are assembled into an ordinary `DetailedDesign` and validated by `validateToBeOutput`. A step or register group that fails its schema or whose assembled errors are attributable to it is re-requested up to `AI_TO_BE_PART_REPAIRS` times (default 2, 0-2; the second only while more than half of `AI_STAGE_BUDGET_SECONDS` remains), with paths and codes in `validationErrors` and the previous answer in `currentAnswer` (left out when it was cut off, empty, held tool-call markup or exceeded 24000 characters), in up to 2 rounds of re-expansion; a field or text answer holding DeepSeek tool-call markup (`<｜DSML｜ ...>`) is reported as `TOOL_MARKUP_LEAKED` and the note tells the model to call the tool (checked in every model payload: outline, outline patches, steps, register groups, the consistency review and the fix pass; a leaked outline or patch is re-asked within the outline repairs, a leaked review is skipped, and `validateToBeOutput` refuses any assembled design with markup in any string, which re-expands the part named by the path within the same bounded rounds); errors that need the outline cause one outline repair, after which only steps whose outline entry changed are expanded again; anything still invalid ends as `AI_INVALID_OUTPUT`. One design stage holds one `AI_MAX_CONCURRENCY` permit for all its calls (so `AI_MAX_CONCURRENCY=1` cannot deadlock); provider requests in flight can therefore reach `AI_MAX_CONCURRENCY` x `AI_DESIGN_PARALLELISM`. Alongside the step calls, four register calls (`submit_to_be_registers_decisions`, `_fitgap`, `_foundation`, `_integration`, one shared prompt `prompts/to_be_registers.system.md`, target under 3500 output tokens each) write the solution-design registers from the frozen outline, the answered company context, all requirements and the catalog's objects: key design decisions, clean-core fit-gap (with RICEFW type), organisation structure, master-data prerequisites, interfaces, KPIs, data migration and cutover. They share the `AI_DESIGN_PARALLELISM` pool with the steps, and the assembled design is `schemaVersion` 2 (version 1 designs stay readable). `discovery.companyContext` (the answered interview fields with their evidence, optional so frozen revisions still load) goes whole to the outline and register calls and trimmed to the step-relevant fields on each step call. Besides the trace checks, the evaluator checks every register row's ids, that each critical requirement has a fit-gap row, that a CLASSIC_RICEFW row has a type, that each retained system has an interface (or an explicit out-of-scope row), that each KPI target in the company context has a KPI row and that KPI figures are verbatim from the answers or "not provided". A deterministic linter (`src/lib/ai/sap-object-lint.ts`) rejects any Fiori app id, transaction code, movement type, scope item, BAPI/API or BAdI name that appears in no catalog entry (`UNKNOWN_SAP_OBJECT`, with the token); errors are routed to the step or register group that wrote them and repaired once. Job metrics add `substages` (calls and tokens for `to_be_outline`, `to_be_step` and `to_be_registers`); `attempts` counts every provider call. Register calls add 4 calls of up to 3500 tokens (about 290 s each at 12 tokens/s) to the same pool: with `AI_DESIGN_PARALLELISM=4` and 12 steps that is 16 pool tasks, so about 4 waves of at most 290 s after the outline instead of 3 waves of 250 s; with `AI_DESIGN_PARALLELISM=8` the 16 tasks run in 2 waves. The step-only estimate that follows predates the registers. Worst-case time at 12 output tokens/s per stream with `AI_DESIGN_PARALLELISM=4`: outline 6000 / 12 = 500 s, then 12 steps in 3 waves of 3000 / 12 = 250 s = 750 s, so about 1250 s, over a 1200 s budget; `AI_DESIGN_PARALLELISM=6` gives 500 + 2 x 250 = 1000 s and `12` gives 750 s. On MiMo also consider `AI_NO_THINKING_STAGES=to_be_step` (reasoning tokens count against the same output rate); `to_be` turns reasoning off for both request kinds.

**To-Be consistency review.** After the parts are assembled and the design is valid, one more call (`submit_to_be_review`, prompt `prompts/to_be_review.system.md`, substage `to_be_review`) reads the whole design in a shortened form (text cut so the request stays near 30k tokens) and lists contradictions, missing links, unresolved codes, coverage gaps and internal wording, each with the ids of the elements involved. A finding that names a step or a register group sends that part back once with the finding as its repair note (at most six parts); the repair is kept only if the whole design is still valid with it. Findings that name no part, or whose repair failed, appear as `REVIEW_*` review findings in the report and in the judge's payload. The pass never fails a valid design, is skipped when 25% or less of the stage budget remains, and `AI_TO_BE_REVIEW=off` switches it off. Measured size of its input on the two recorded live designs: about 110k characters (18 steps) and 106k (11 steps).

**Judge independence.** `scripts/eval-judge.ts` derives the model family of the generator (from the run file) and of the judge, picks an independent judge by itself (Qwen3.8-Max for a DeepSeek generator, DeepSeek-V4-Pro for Qwen or MiMo), refuses a same-family `--model` unless `--allow-same-family` is given (the report then says NOT INDEPENDENT), and prints both families in the report header. A same-family judge scored the same designs 10 to 20 points higher.

The job row deadline is the stage budget plus 60 s, and the pg-boss expiry is the deadline plus 60 s (defaults: 360 s and 420 s). Both follow `AI_STAGE_BUDGET_SECONDS` for the web and worker processes, so set it identically on both. `createQueue` does not change an existing queue's expiry; the per-job expiry sent with every job is the authoritative value. Trade-off: a larger budget means a job whose worker died, or a model that hangs, is reported as timed out later (up to the budget plus 60 s). The browser only polls job status and Cloud Run worker pools have no request timeout, so long stages are safe.

Interview turns and long stages are separate: chat turns run on the `consultant-chat` queue with `AI_CHAT_CONCURRENCY` model-call slots (default 3, shared with the background extraction of each user message on the `consultant-extract` queue, which reads facts, steps and requirements out of the message and runs strictly in message order per workspace), To-Be on `consultant-batch` with `AI_MAX_CONCURRENCY` slots, so a running To-Be never delays a chat turn. The worker also drains the old `consultant.discovery` queue so jobs queued before the split still run. The demo sets `AI_MAX_CONCURRENCY=1` and `AI_MAX_INPUT_TOKENS=60000` (the largest To-Be call measured about 34000 on DeepInfra MiMo). These limit concurrency and input size, not total monthly AI spending. Do not share the invitation password publicly. Do not enable service tracing that captures request bodies or credentials.

`/api/health` returns 200 only when PostgreSQL, a completed queue probe, and storage are healthy. Cloud Run checks it before routing traffic. Stopping the worker intentionally makes it return 503.

Cost: roughly $60/month (always-on worker about $50, Cloud SQL micro about $10), excluding Anthropic usage; a budget alert of ₹6,500 is set on the billing account. The trial credit is believed to end 2026-11-13 (from account notes, not verified in the console).

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm build
RUN_BUILD_TESTS=1 RUN_INFRA_TESTS=1 RUN_DB_TESTS=1 pnpm test
pnpm test:browser:synthetic
```

The Playwright harness creates and removes an isolated local database, serves the production build over HTTPS, and tests all three fictional journeys with a deterministic worker. It covers progress after reload, retry, persisted scope review, and tenant isolation; it does not evaluate real AI quality. The worker verifies its S3 bucket on startup, so the harness needs object storage: it uses the MinIO from `.env.example` when reachable, otherwise it starts a tiny in-process stub (`tests/browser/support/s3-stub.ts`) that implements only HeadBucket and CreateBucket and answers 501 NotImplemented to everything else, so Docker is not required. Overrides: `BROWSER_TEST_S3_ENDPOINT` (use that endpoint as-is; optionally `BROWSER_TEST_S3_BUCKET`, `BROWSER_TEST_S3_ACCESS_KEY_ID`, `BROWSER_TEST_S3_SECRET_ACCESS_KEY` for the worker), `BROWSER_TEST_S3_STUB=1` (force the stub) or `=0` (forbid it). Local evidence is saved under ignored `playwright-report/` and `test-results/`. Live checks and screenshots are under `test-results/live-demo/`.

For an explicitly authorized audit of the live demo (https://sap-web-965411321011.europe-west1.run.app):

```sh
node --import tsx scripts/test-live-demo.ts --create-synthetic-data
```

This creates a fresh fictional tenant and three projects, invokes real AI (billable), and checks signup/login/logout, persisted inputs, idempotent saves, duplicate jobs, live completion status, schema/hierarchy/source quotes, reload persistence, mobile layout, and tenant isolation. Each run retains its synthetic inputs, outputs, screenshots and JSON report in `test-results/live-audit/<timestamp>/`. The latest QA account credentials stay in ignored `.env.live-test`; existing presenter credentials remain in `.env.demo-access`. Synthetic workspaces are retained for inspection. The script only targets the known demo URL and requires the explicit flag.

The production web and worker configuration was last checked on 2026-10-20 as `AI_PROVIDER=anthropic`, `AI_MODEL=claude-sonnet-5-5`; that is the deployed state until the DeepInfra values above (Flash for chat stages, Pro for To-Be design) are set on both services and re-checked. This powers **problem/scope analysis** and the consultant workflow. The live audit script covers problem analysis only; passing it does not certify the complete Blueprint journey or the semantic accuracy of every SAP recommendation.
