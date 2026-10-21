# Claude Code handoff — SAP consultant discovery and To-Be quality

Checkpoint: 2026-10-21 ~15:45 UTC (end of session). All code committed and pushed on branch feat/consultant-discovery-to-be at 19f05d4; production deploy blocked by a Railway platform outage.

## Goal of next session

Continue building a consultant-grade SAP system whose primary UX is a conversation: understand the business problem, ask relevant follow-up questions in small batches, progressively capture an editable As-Is process, let the user confirm/correct the understanding, then generate a detailed To-Be report and blueprint.

The user explicitly approved **all pending phases** and said **do not wait for further phase approvals**. Continue implementation and verification autonomously. Keep bounded, verified slices; the earlier per-phase approval gate is superseded. This does not authorize inventing customer policy decisions or claiming SAP verification.

Acceptance target: an evidence-backed **at least 9/10** To-Be assessment using the existing rubric. The rental baseline was 62/100; the latest reviewer score is **78.75/100 (v12)**, below target. Reviewer document-only ceiling is 83-84. Passing application tests alone does not improve the design score.

Read the authoritative scope and rubric in [the quality improvement plan](to-be-quality-improvement-plan.md). Do not reproduce or replace its acceptance criteria with an easier scoring system.

## FIRST ACTION: finish the blocked production deploy

Why blocked: Railway Major Outage on 2026-10-21 ("Dashboard and API unavailable, builds paused"; status updates 11:33 and 13:40 UTC, still paused at 15:40 UTC). `railway up` uploads, then prints `Deploys have been paused temporarily` and creates no deployment. The last attempt (~15:42 UTC) failed this way. Check https://status.railway.com first. The page is client-rendered and a partial render once produced a false "resumed": confirm the incident text is actually gone.

- Railway: project `sap-solution-architect-demo`, environment `production`, services `worker`, `web`, `Postgres`. The CLI is already logged in on this machine (`railway whoami`).
- Current live state: old revision `5be1777`; `/api/health` returned 200 at 15:42 UTC.
- Already done: `AI_MAX_INPUT_TOKENS=60000` is set on both web and worker (skip-deploys; takes effect with the new code). `CONSULTANT_DAILY_JOB_LIMIT` defaults to 200 if unset.

Procedure:

1. Make a clean detached worktree of `19f05d4` in a scratch dir (`git worktree add --detach <dir> 19f05d4`) so the untracked customer workbook can never be uploaded. Verify there is no `*.xlsx` in it. Then `railway link -p sap-solution-architect-demo -e production`.
2. `railway up --service worker --detach` FIRST. Its pre-deploy runs migrations 0005, 0006 and 0007. Wait for SUCCESS and for logs containing "Worker ready" and the `sap_reference_catalogs` line with 65 verified. Stop if it fails.
3. Then `railway up --service web --detach`; wait for SUCCESS.
4. `curl https://web-production-7a4d.up.railway.app/api/health` must return 200. Smoke the consultant workspace route `/projects/:id/consultant`.
5. Remove the worktree.
6. Merge `feat/consultant-discovery-to-be` into `main` (open a PR or fast-forward, per user preference) and push.

Rollback (current live, both on revision `5be1777`): worker `a51aa764-8bd3-472a-8deb-f160ea2c5bda`, web `aae47e59-1a83-483f-90e0-928ebe4408ce`. Migrations 0005-0007 are additive; rolling back code does not revert them.

## State of play (updated 2026-10-21, end of day)

### Workspace and Git

- Repository root: `/Volumes/Suyash2TB/07 Tech Projects/SAP Solution Architect`. Remote: https://github.com/rajsuyash/SapSolutionArchitect. Branch `feat/consultant-discovery-to-be`.
- HEAD is `19f05d4` (pushed to origin), 6 commits ahead of `main` (`e6a71f1`, `5d6eb30`, `96b1f87`, `ecdaab6`, `5581d9c`, `19f05d4`). `main` is still at `5be1777`; the branch is not merged. Never commit the customer workbook, generated xlsx deliverables or `test-results/`. Run `git status --short` before editing.
- Live demo (https://web-production-7a4d.up.railway.app) is still at `5be1777` pending the blocked deploy (see FIRST ACTION); do not claim live parity.
- The customer workbook in the repo root is untracked and customer-confidential. **Never add it to Git.** Customer-derived artefacts live only in gitignored `test-results/`. Commit only synthetic fixtures. Keep customer names, workbook text and requirement text out of tracked docs.

### Built (committed on the branch)

| Area | Files / state |
| --- | --- |
| Manual As-Is capture | `migrations/0005_discovery_capture.sql`, `src/lib/discovery.ts`, `src/app/discovery-panel.tsx`. Old path preserved. |
| To-Be schema, validator, prompt | `src/lib/ai/design-quality.ts`, `src/lib/ai/to-be.ts`, `prompts/to_be.system.md`. Validator extended: fit-type consistency, `LICENSE_ENTITLEMENT` blocker, `decisionIds` / `UNKNOWN_DECISION`, CONDITIONAL coverage, located `INVALID_DRAFT` repair errors. Prompt now has a kind ladder, mechanism choice, decision linking, conditional semantics and no assumed outcomes. |
| Interview contract | `src/lib/ai/discovery-interview.ts`, `prompts/discovery_interview.system.md`, `src/lib/ai/runStage.ts`. |
| Workspace domain + persistence | `src/lib/discovery-workspace-model.ts`, `src/lib/discovery-workspace.ts`, `migrations/0006_discovery_workspace.sql`. Row-lock regression fixed: row locks are taken only on the privileged worker connection via a `lockRows` flag; the consultant-jobs worker passes `true`; tenant `access()` takes no locks. |
| Durable jobs | `migrations/0007_consultant_jobs.sql`, `src/lib/consultant-jobs.ts`, wired into `src/lib/runtime.ts` / `src/worker.ts`. Worker re-validates results with `loadToBeReferences` (pre-ship blocker fixed); 360s job deadline / 420s pg-boss expiry mapped to AI_TIMEOUT; per-day job limit `CONSULTANT_DAILY_JOB_LIMIT` -> 429 RATE_LIMITED. |
| RLS / migrations | 0006 trigger `guard_discovery_workspace_confirmation` (PROCESS_OWNER cannot add a confirmation); 0007 composite snapshot FK. Tests: `tests/migrations-upgrade.test.ts`, `tests/rls-direct.test.ts`. |
| HTTP boundary | `src/lib/consultant-http.ts`, routes under `/api/projects/:id/consultant/...`. |
| Chat workspace UI | `/projects/:id/consultant` (`consultant-*.tsx`). |
| To-Be report | Report page plus Markdown/CSV export (`src/lib/consultant-report*.ts`). Exports are sent with `nosniff` and `private, no-store`; CSV formula-injection guard; Markdown escaping. |
| SAP reference layer | Trusted loader `src/lib/ai/sap-references.ts`; curated catalog `fixtures/sap/s4hana-2023/reference-catalog.json` (73 entries, 65 VERIFIED with verbatim quotes from rendered help.sap.com 2023 pages); worker startup check `src/lib/ai/sap-catalog-startup.ts`. |

### Verified versus unfinished

Last reported state (2026-10-21). **Re-run before relying on it; verification expires with any later change.**

- At `19f05d4` (pre-ship /ship review run, blockers fixed): typecheck + lint clean, build OK, `RUN_DB_TESTS=1 vitest` 341 passed, browser synthetic 28/28 (needs the local Postgres below for DB tests).
- Not done: production deploy (blocked), merge to `main`, hosted subscription-auth path (still undesigned; hosted runtime remains the API-key SDK path), real SAP execution of any scenario.
- Customer target confirmed by the user on 2026-10-21: **SAP S/4HANA 2023 private/on-prem, FPS level** (resolves the former release question IQ-RELEASE).

### Rental evaluation (v6 to v12) and where it stands

Runs are in `test-results/rental-reference/v6..v12/` (harness `generate.mts`, `metrics.mts`, diff reports; v10-v12 are bounded repair rounds). Independent GPT-6-Sol (Codex CLI, read-only) reviews are in each `vN/review/`. Scores are separate reviewer judgments on the unchanged rubric, not controlled measurements:

baseline 62, v6 69, v8 71, v9 74, v10 75.75, v11 77.75, **v12 78.75**.

- Reviewer document-only ceiling is 83-84. Reaching 90 or more needs the named scenarios executed in an SAP 2023 system plus approved business decisions. The user chose (2026-10-21) to push the document to its ceiling and deliver with explicit gates.
- **v12 open findings V12-1..9**: three HIGH (credit notification polling misses transitions; freight assignment retry identity; re-issue after credit contradicts two earlier billing rules) plus PARTIALs; full list in `test-results/rental-reference/v12/review/gpt-6-sol-review.last.md`.
- Deliverable renderer: `test-results/rental-reference/deliverable/render.mts` (+ `build_xlsx.py`) produces `To-Be-Design-Rental-vN` .md/.html/.xlsx(/pdf). Customer-confidential, gitignored.

### Local infrastructure

Native PostgreSQL 16 was started earlier because Docker Postgres crashed (read-only filesystem fault in the Docker daemon): data `/private/tmp/sap-workspace-postgres-20261021`, listen `127.0.0.1:55417`, user `sap_pm`, trust auth, no production data. **Verify it is still running before use; `/private/tmp` may be cleaned.** Do not delete Docker volumes. DB tests create/drop their own databases. Sandbox loopback may need escalation.

## First blocker: RESOLVED

The tenant row-lock regression (`FOR SHARE OF p,m,u` failing with `permission denied for table projects`) is fixed as described under Built. Tenant privileges were not broadened. Stale items from the earlier checkpoint (workspace suite 4/4 FAIL, jobs suite EPERM, "no HTTP routes or chat UI yet", "latest rental score 62") are superseded.

## Resume sequence

1. Finish the deploy (see FIRST ACTION), then merge to `main`.
2. Re-verify the tree if anything changed: `git status --short`, typecheck, lint, `pnpm test`, DB suites, build, synthetic browser suite.
3. If continuing the rental design: fix V12-1..9 (three HIGH first), run one bounded repair round, GPT-6-Sol review, re-render the deliverable. Expected gain is small (ceiling 83-84).
4. Get user decisions on the 42-topic decision register; confirm licence entitlement (TM, ARM, event enablement).
5. Schedule SAP sandbox execution of the named scenarios. This is the only route past the document ceiling.
6. Only after rental acceptance: extend to product, service and rigging variants (preserve variant-specific rules).
7. Design the hosted subscription-auth path.
8. Claim 9/10 only after a documented assessment of a newly generated candidate; customer policy approval and SAP sign-off remain separate.

## Integration contracts and traps

Read the source for current signatures; this list identifies the boundaries rather than duplicating implementation.

- `createDiscoveryWorkspaceRepository(pool, auth)` exposes `list/get/create/command`. Create derives product/problem from the authorized project. Command takes expected revision, UUID idempotency key and a strict business command. Final confirmation is LEAD/CONSULTANT only; PROCESS_OWNER can contribute.
- `loadWorkspaceForWorker(client, args)` holds the shared workspace advisory transaction lock and loads latest state/access. `persistWorkspaceTurn(client,args)` validates and appends a turn inside the caller's transaction. Never perform network/model calls while holding a DB transaction.
- `WorkspaceCommandSchema` includes `START_STEP_DRAFT`, `START_REQUIREMENT_DRAFT`, `SET_FIELD`, `SEND_MESSAGE`, `DECIDE_PROPOSAL`, `REVIEW_OBSERVATION`, `SET_TARGET_RELEASE`, `CONFIRM`, plus manual/source commands. Create draft shells so users can describe steps progressively through chat.
- `buildInterviewInput` creates the server-authorized model context. `recordInterviewTurn` stores proposals/questions/observations; `compileDiscovery` converts reviewed drafts to the existing immutable snapshot schema.
- **Known integration limitation:** DiscoveryInput v1 cannot carry every typed workspace fact/status/rationale. The generation boundary must retain that meaning from the confirmed workspace; source text alone is insufficient.
- Review repeated/unanswered question behavior, moving field/evidence windows, total payload limits, semantic completeness and confirmation invalidation across every mutation. The seven domain tests are a foundation, not proof of consultant-grade discovery.
- A prior reviewer reported dropped observations and missing `canEdit` checks. Both were subsequently patched: observations are now persisted and reviewable; job enqueue/load/commit check `canEdit`. Recheck final code and integration tests; do not treat the earlier report as an uncorrected defect.
- To-Be job results are validated again at completion and saved on `consultant_jobs.result`; queue table is separate from existing analysis `jobs`. Readiness must be enforced server-side, never granted by model prose.
- Browser code must use **type-only imports** for workspace types: runtime import of the domain module pulls server/Node dependencies through discovery.
- Before Next code edits, read relevant installed guides in `node_modules/next/dist/docs/`, as required by project `AGENTS.md`.
- Migration runner loads numbered SQL files with a checksum ledger. Do not edit migrations already applied to a retained database; use new migrations or fresh disposable test databases as appropriate.

## Models and credentials

- User preference: use **GPT-6-Sol**, not GPT Luna, for delegated implementation/reviews when available. Do not pretend Claude Code is GPT-6-Sol; state actual models used.
- Actual interview and rental generation tests used **Claude Sonnet 5.5** (`claude-sonnet-5-5`).
- User authorized the existing subscription token store: `/Users/suyashraj/.config/suyashos/vps-secrets/claude-proxy.env`, key `CLAUDE_CODE_OAUTH_TOKEN`. Read only that key inside the request process; never print it, copy it into project files, pass it to agents or source the whole file.
- Local real-model testing uses official `/opt/homebrew/bin/claude` in an isolated temporary config/cwd. The retained harness `test-results/interview-live-check.mjs` contains the working invocation and timeout/output controls.
- **Hosted application authentication is still the Anthropic API-key SDK path in runStage.** Local subscription-CLI tests did not switch hosted runtime authentication. Proper application token integration remains to be designed/verified if retaining that user request.
- The Sonnet structured SDK path uses tool_choice auto, then validates exactly one named tool call. Forced tool selection was rejected in actual prior Sonnet tests.
- Official CLI JSON adaptation used by the local harness is a different transport from the production SDK tool call. Test both at the claimed layer.
- Do not reuse old revoked OpenClaw credentials or start an unrelated login flow.
- Jev router was not used for this task; do not enable it implicitly.

## Open decisions

- ~~Customer SAP edition/release unconfirmed~~ (stale): confirmed 2026-10-21 as S/4HANA 2023 private/on-prem FPS.
- Existing unresolved business policy decisions must stay unresolved until an authorized owner answers; all are indexed in the local decision register.
- SAP verification requires applicable product/release evidence; current design context has no trusted approved-decision/reference records. Implement a trusted workflow before calling a model-produced SAP claim verified.
- Clarify how the hosted worker will support the requested subscription authentication through a supported official path. Do not silently replace the request or claim local CLI testing is hosted integration.

## Artifacts

All relative paths below are inside the repository root unless stated otherwise.

- Original PRD: `sap-program-manager-PRD.md`.
- Product direction, phases, unchanged rubric and acceptance: `docs/to-be-quality-improvement-plan.md`.
- Existing design-quality documentation: `docs/to-be-quality.md`.
- Customer reference workbook: local-only file in the repo root (untracked, confidential; do not name or quote it in tracked docs).
- Rental baseline and full audit (superseded by v6..v12 above): `test-results/rental-reference/input.json`, `output.json`, `review.md`. In output, latest full scope is `audit.combinedDesign`; earlier incomplete work remains in `auditHistory`. Full rental scope: 86 requirements, 12 As-Is steps, 41 generated steps. Refer to the review for all findings; do not rederive from a partial prior run.
- Prepared remediation/shared rules/decisions: `test-results/rental-reference/remediation-register.json`, `shared-rules.md`, `decision-register.json`. Seventeen findings, 34 scenario specifications, 42 consolidated decision topics; preparation is not remediation execution or policy approval.
- Final local real-model interview evidence: `test-results/interview-live-55bd456e-de86-4bec-8a2b-e0059ef9f180.json`, `test-results/interview-live-review.md`, `test-results/interview-live-check.mjs`. Five synthetic turns validated first attempt and passed core/presentation review. This does not establish the missing app/chat journey.
- Existing browser harness: `scripts/test-browser.ts`, `tests/browser/discovery.spec.ts`, `tests/browser/synthetic.spec.ts`.
- Shared memory: `/Users/suyashraj/SuyashOS/05-memory/daily/2026-10-21.md`, `decisions.md`, `learnings.md`. Project currently unmapped; do not invent a vault project.

Useful commands from the repository root (network/loopback access subject to harness permissions):

```sh
rtk proxy pnpm typecheck
rtk proxy pnpm lint
rtk proxy pnpm exec vitest run tests/discovery-workspace-model.test.ts tests/interview.test.ts tests/to-be.test.ts tests/design-quality.test.ts
RUN_DB_TESTS=1 rtk proxy pnpm exec vitest run tests/discovery-workspace.test.ts tests/consultant-jobs.test.ts tests/discovery.test.ts tests/jobs.test.ts
rtk proxy pnpm test:browser:synthetic
rtk proxy pnpm build
```

## Skills to use

- Task observer: `/Users/suyashraj/.agents/skills/task-observer/SKILL.md`; follow its Session Start Protocol. Pinned log: `/Users/suyashraj/.Codex/skill-observations/observation-log/`.
- E2E testing: `/Users/suyashraj/.agents/skills/e2e-testing/SKILL.md` for the actual Playwright journey.
- AI regression testing: `/Users/suyashraj/.agents/skills/ai-regression-testing/SKILL.md` for repeatable model evaluations.
- API design: `/Users/suyashraj/.agents/skills/api-design/SKILL.md` if helpful for the new authenticated endpoints.
- Use code/TypeScript/security/database reviewers for the corresponding changes. Preserve actual reviewer model attribution.
- Do not load skills solely because they are listed; read the relevant skill and its OPEN observations before applying it.

## Handoff integrity

This is a continuation checkpoint, not a completion report. Claimed: the built items and last-reported verification above, and reviewer scores through v12 (78.75). Not claimed: a 9/10 score, executed SAP scenarios, a completed deployment (deployment was attempted but blocked by the Railway outage; live is still `5be1777`), or current whole-system green status (re-verify). The "Integration contracts and traps" and "Models and credentials" sections predate the HTTP/UI/report work; read source for current signatures.
