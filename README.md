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

For an explicitly authorized audit of the live demo:

```sh
node --import tsx scripts/test-live-demo.ts --create-synthetic-data
```

This creates a fresh fictional tenant and three projects, invokes real AI (billable), and checks signup/login/logout, persisted inputs, idempotent saves, duplicate jobs, live completion status, schema/hierarchy/source quotes, reload persistence, mobile layout, and tenant isolation. Each run retains its synthetic inputs, outputs, screenshots and JSON report in `test-results/live-audit/<timestamp>/`. The latest QA account credentials stay in ignored `.env.live-test`; existing presenter credentials remain in `.env.demo-access`. Synthetic workspaces are retained for inspection. The script only targets the known demo URL and requires the explicit flag.

The production web and worker configuration was checked on 2026-10-20: `AI_PROVIDER=anthropic`, `AI_MODEL=claude-sonnet-5-5`. This powers **problem/scope analysis** and the consultant workflow. The live audit script covers problem analysis only; passing it does not certify the complete Blueprint journey or the semantic accuracy of every SAP recommendation.
