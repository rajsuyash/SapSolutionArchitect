# SAP Solution Architect

A private demo for capturing SAP transformation projects and reviewing AI-generated process scope. The implemented flow is sign in → create project → analyze business problem → review objectives, quoted pain points, proposed processes, and clarifying questions.

The consultant workflow adds a guided discovery conversation per process variant, lead/consultant confirmation of the As-Is, a To-Be design generated from the confirmed revision, and Markdown and CSV exports. Invitations and full blueprint exports are still in development. AI proposals require human review.

## Consultant workflow

1. In a project, start a discovery conversation for a process variant (up to 20 per project). Answer the consultant's questions; messages containing emails, passwords or tokens are refused before they are saved.
2. A project lead or consultant confirms the As-Is once the gaps are resolved. Confirmation pins an immutable revision.
3. Generate the To-Be design from that revision. The result is a reviewable report (blockers, comparison, traceability) with `report.md` and `traceability.csv` downloads. Nothing is approved automatically; SAP claims are trusted only when they cite the curated, VERIFIED reference catalog in `fixtures/sap`.

Cost controls: `CONSULTANT_DAILY_JOB_LIMIT` (default 200) caps consultant jobs per organization per rolling 24 hours (HTTP 429 `RATE_LIMITED` with `Retry-After`). The To-Be stage needs `AI_MAX_INPUT_TOKENS` of about 45000 or more.

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

**Reasoning off for fast chat turns.** `AI_NO_THINKING_STAGES` is an optional comma-separated list of stage names (`problem_analysis`, `interview_turn`, `to_be`; unknown names are rejected; empty or unset keeps today's behaviour). For each listed stage, and only when `AI_PROVIDER=deepinfra`, the request carries `thinking: {"type": "disabled"}` and the job metrics record `thinkingDisabled: true`. Measured on 2026-10-22 with MiMo-V2.6-Pro on DeepInfra's Anthropic-compatible endpoint (one small tool-call request): reasoning on 94 s, reasoning off 18-21 s with a valid tool call each time; `reasoning_effort` is ignored on that endpoint. Recommended production value for MiMo on DeepInfra: `AI_NO_THINKING_STAGES=interview_turn`; keep reasoning on for `to_be`. **Claude caveat:** Claude Sonnet 5.5 on the Anthropic API answers 400 to `thinking: {"type": "disabled"}` (it only accepts `{"type": "between_tools"}`), so `AI_PROVIDER=anthropic` with a non-empty `AI_NO_THINKING_STAGES` is refused at startup. When an interview turn proposes more than 12 updates, the first 12 (model order) are kept and a `proposals_truncated` warning records how many were dropped; every kept proposal is still quote-checked and needs user acceptance.

`AI_MODEL_DESIGN` is optional; unset, `AI_MODEL` runs every stage. Which stages count as design stages is defined once in `src/lib/ai/runStage.ts` (`DESIGN_STAGES`, currently `to_be`); the same set also selects `AI_DESIGN_CALL_TIMEOUT_SECONDS`. The model actually used is recorded in each job's metrics, and its `count_tokens` guard uses the same model as the call.

**Cost estimate.** `AI_MODEL_PRICES` is an optional JSON object mapping a model id to `[inputUsdPerMTok, outputUsdPerMTok]` (positive numbers, at most 1000). The `/admin` estimate prices each job's tokens by the model recorded in its metrics and falls back to `AI_PRICE_INPUT_USD_PER_MTOK` / `AI_PRICE_OUTPUT_USD_PER_MTOK` (defaults 2 / 10) for a model without an entry and for jobs recorded before models were stored. It remains an estimate, not a bill. Per-model usage comes from the SQL function added in migration `0011_platform_admin_usage_by_model.sql`.

DeepInfra requests go to `https://api.deepinfra.com/anthropic` and carry no Claude-specific parameters (thinking, effort, betas, cache control). The model's `thinking` blocks are ignored. Provider failures stay generic for users; the server logs one JSON line per failure (`ai_provider_error` with provider, model, stage, HTTP status, error type and a category: credit, auth, rate_limit, overloaded, invalid_request, timeout, unknown) and never the prompt or key.

**AI time budgets.** Three variables, whole seconds, validated at startup (a per-call value above the stage budget stops the process):

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `AI_STAGE_BUDGET_SECONDS` | 300 | 60-1800 | Whole stage, including repair attempts |
| `AI_CALL_TIMEOUT_SECONDS` | 120 | 30-1500 | One model call, ordinary stages (problem analysis, interview turn) |
| `AI_DESIGN_CALL_TIMEOUT_SECONDS` | 240 | 30-1500 | One model call, the To-Be design stage (up to 24000 output tokens) |

The defaults suit Claude. A slow model needs more: MiMo-V2.6-Pro on DeepInfra produces about 12-40 output tokens/s (12 measured on 2026-10-22), so a 24000-token To-Be call can take 800 s or more. Recommended for `AI_PROVIDER=deepinfra`: `AI_STAGE_BUDGET_SECONDS=1200`, `AI_CALL_TIMEOUT_SECONDS=300`, `AI_DESIGN_CALL_TIMEOUT_SECONDS=1000`. The provider choice no longer changes any timeout by itself.

The job row deadline is the stage budget plus 60 s, and the pg-boss expiry is the deadline plus 60 s (defaults: 360 s and 420 s). Both follow `AI_STAGE_BUDGET_SECONDS` for the web and worker processes, so set it identically on both. `createQueue` does not change an existing queue's expiry; the per-job expiry sent with every job is the authoritative value. Trade-off: a larger budget means a job whose worker died, or a model that hangs, is reported as timed out later (up to the budget plus 60 s). The browser only polls job status and Cloud Run worker pools have no request timeout, so long stages are safe.

The demo sets `AI_MAX_CONCURRENCY=1` and `AI_MAX_INPUT_TOKENS=60000` (To-Be generation needs about 45000 or more). These limit concurrency and input size, not total monthly AI spending. Do not share the invitation password publicly. Do not enable service tracing that captures request bodies or credentials.

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

The Playwright harness creates and removes an isolated local database, serves the production build over HTTPS, and tests all three fictional journeys with a deterministic worker. It covers progress after reload, retry, persisted scope review, and tenant isolation; it does not evaluate real AI quality. Local evidence is saved under ignored `playwright-report/` and `test-results/`. Live checks and screenshots are under `test-results/live-demo/`.

For an explicitly authorized audit of the live demo (https://sap-web-965411321011.europe-west1.run.app):

```sh
node --import tsx scripts/test-live-demo.ts --create-synthetic-data
```

This creates a fresh fictional tenant and three projects, invokes real AI (billable), and checks signup/login/logout, persisted inputs, idempotent saves, duplicate jobs, live completion status, schema/hierarchy/source quotes, reload persistence, mobile layout, and tenant isolation. Each run retains its synthetic inputs, outputs, screenshots and JSON report in `test-results/live-audit/<timestamp>/`. The latest QA account credentials stay in ignored `.env.live-test`; existing presenter credentials remain in `.env.demo-access`. Synthetic workspaces are retained for inspection. The script only targets the known demo URL and requires the explicit flag.

The production web and worker configuration was last checked on 2026-10-20 as `AI_PROVIDER=anthropic`, `AI_MODEL=claude-sonnet-5-5`; that is the deployed state until the DeepInfra values above (Flash for chat stages, Pro for To-Be design) are set on both services and re-checked. This powers **problem/scope analysis** and the consultant workflow. The live audit script covers problem analysis only; passing it does not certify the complete Blueprint journey or the semantic accuracy of every SAP recommendation.
