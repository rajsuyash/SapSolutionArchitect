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

- URL: https://web-production-7a4d.up.railway.app
- Hosting: Railway project `sap-solution-architect-demo` (`ef5224a0-be48-461f-bfaa-dada466937d3`).
- Services: `web`, `worker`, PostgreSQL, and private S3-compatible storage bucket `sap-demo-files`.
- The browser first requests the private demo credentials, then the application account credentials. The presenter credentials are stored locally in the ignored `.env.demo-access` file; never commit or publish this file.
- Three fictional project scenarios live in `fixtures/e2e/synthetic-projects.json`. The deployed demo uses real Anthropic analysis, not the test stub.

Railway bills resource usage. Budget approximately **US$5–10/month for light demo hosting**, excluding Anthropic usage and tax; this is an estimate, not a spending cap. Its Hobby plan has a $5 monthly minimum credited toward usage. The existing workspace has separate spending controls shared with its other projects. See [Railway pricing](https://railway.com/pricing).

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

Both services use the root Dockerfile. Deploy the worker first, then the web service. Both run this pre-deploy command under the existing migration lock:

```sh
node --import tsx scripts/seed.ts --migrate-only
```

| Setting | Web | Worker |
|---|---|---|
| Start command | `node node_modules/next/dist/bin/next start --hostname 0.0.0.0` | `node --import tsx src/worker.ts` |
| Health check | `/api/health` | None; checked through web queue probe |
| Replicas | 1 | 1 |
| Restart | On failure, 3 attempts | On failure, 3 attempts |

Configure secrets through Railway variables, never Docker build arguments or the repository. Required variables are documented in `.env.example` and validated in `src/lib/env.ts`. Production uses HTTPS for `APP_URL` and `S3_ENDPOINT`, a random `AUTH_SECRET`, real Anthropic credentials, and `EMAIL_PROVIDER=disabled` until email features exist. `DATABASE_URL` references `${{Postgres.DATABASE_URL}}` on the private network. Set `DEMO_ACCESS_PASSWORD` to a random string of at least 24 characters to enable the additional demo gate (username `demo`). The gate does not replace session or tenant authorization.

The demo sets `AI_MAX_CONCURRENCY=1` and `AI_MAX_INPUT_TOKENS=60000` (To-Be generation needs about 45000 or more). These limit concurrency and input size, not total monthly AI spending. Do not share the invitation password publicly. Do not enable service tracing that captures request bodies or credentials.

Deploy reviewed source using the Railway CLI:

```sh
railway link --project ef5224a0-be48-461f-bfaa-dada466937d3
railway up --service worker --detach
# Wait for the worker to report "Worker ready" before deploying web.
railway up --service web --detach
```

`/api/health` returns 200 only when PostgreSQL, a completed queue probe, and storage are healthy. Railway checks it before routing traffic. Stopping the worker intentionally makes it return 503.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm build
RUN_BUILD_TESTS=1 RUN_INFRA_TESTS=1 RUN_DB_TESTS=1 pnpm test
pnpm test:browser:synthetic
```

The Playwright harness creates and removes an isolated local database, serves the production build over HTTPS, and tests all three fictional journeys with a deterministic worker. It covers progress after reload, retry, persisted scope review, and tenant isolation; it does not evaluate real AI quality. Local evidence is saved under ignored `playwright-report/` and `test-results/`. Live checks and screenshots are under `test-results/live-demo/`.

For an explicitly authorized audit of the live Railway demo:

```sh
node --import tsx scripts/test-live-demo.ts --create-synthetic-data
```

This creates a fresh fictional tenant and three projects, invokes real AI (billable), and checks signup/login/logout, persisted inputs, idempotent saves, duplicate jobs, live completion status, schema/hierarchy/source quotes, reload persistence, mobile layout, and tenant isolation. Each run retains its synthetic inputs, outputs, screenshots and JSON report in `test-results/live-audit/<timestamp>/`. The latest QA account credentials stay in ignored `.env.live-test`; existing presenter credentials remain in `.env.demo-access`. Synthetic workspaces are retained for inspection. The script only targets the known demo URL and requires the explicit flag.

The production web and worker configuration was checked on 2026-10-20: `AI_PROVIDER=anthropic`, `AI_MODEL=claude-sonnet-5-5`. This powers **problem/scope analysis** and the consultant workflow. The live audit script covers problem analysis only; passing it does not certify the complete Blueprint journey or the semantic accuracy of every SAP recommendation.
