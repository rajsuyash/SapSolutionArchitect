# AI SAP Program Manager — Product Requirements

**Status:** Draft v1 · **Last updated:** 2026-10-19 · **Format:** agent-optimized PRD v3
**Working name:** AI SAP Program Manager · repo/package slug `sap-pm` — ASSUMPTION(med): final product name not decided.

<!--
Conventions used throughout:
- TODO: <text>            → requires a product decision from a human; the agent must NOT resolve it
- ASSUMPTION(conf): <text> → best inference, confidence high/med/low; agent may build on it but must surface it
- LOCKED                  → decision made by the human; do not revisit
- PROPOSED                → inferred default; binding until the human overrides it
- DELEGATED               → decision left to the agent, within the stated constraints
- P0 must ship in v1 · P1 nice-to-have · P2 backlog
- Verify tags on every AC: unit | integration | browser-verify (/verify via browser-verifier subagent) | manual
- IDs are globally unique: F1, F1-AC1, F1-ERR1, J1, J1.1, J1-AC1, E1, M0, ENV-1, FIX-1 — reference them in commits, branches, tests
-->

---

## 0. How to use this document (for the coding agent)

**Read order:** §1 Summary → **§2 Users & journeys (always — never skip)** → §3 Scope → §4 Stack & decisions → §5 Build sequence → §6.0 Shared AI stage contract → then ONLY the feature specs for the milestone you are working on. Each feature spec is self-contained. §2 and §6.0 stay in context for every milestone.

**Rules of engagement:**

1. **The current milestone defines your scope.** Build to its exit criteria (named AC IDs). Do not start later milestones, and never build anything listed in §3 non-goals.
1b. **A feature is not done until it is reachable.** Wire every feature to the entry point named in its Journey context block and in §2.4. A working route no user can navigate to is an incomplete task. When a milestone makes a journey segment walkable, walk it yourself before declaring done.
2. **Markers are binding.** `TODO:` = stop and ask the human. `ASSUMPTION` = proceed, restate it in your task summary. `LOCKED` = final. `PROPOSED` = binding until overridden; flag friction early. `DELEGATED` = your call; choose the simplest option that meets the constraint and record it in Appendix B.
3. **Verify library and framework APIs against the lockfile and current docs** (Context7 or equivalent), not memory.
4. **Simplicity bias.** Boring technology, smallest diff that passes the AC, no speculative abstraction.
5. **Definition of done = evidence.** A task is done when its named ACs pass at their tagged layer.
6. **This PRD is the source of truth.** If reality diverges, propose a PRD edit, log it in Appendix B, then proceed.
7. **Never write secret values** into this document, code, commits, fixtures or logs. Env var names only (§9).
8. **SAP facts are data, not model knowledge.** Never hard-code SAP scope item IDs, transaction codes or Fiori app IDs in prompts or UI copy outside the reference library seed (F9).

---

## 1. Summary

**What it is (one sentence):** A multi-tenant web app where SAP consultants turn a client's problem statement and current-process information into approved As-Is, Gap analysis, To-Be and Change of Process documents for every process, compiled into an exportable **SAP Business Blueprint**.

**Problem:** SAP design phases are run in Word, Excel and Visio. As-Is and To-Be documents drift apart, gaps lose their link to the requirement that caused them, consultants hand-copy SAP best-practice content (and sometimes get it wrong), and the Business Blueprint is assembled manually at the end — late, inconsistent and hard to get signed off.

**Primary user:** SAP solution architect / senior functional consultant leading the design phase of a transformation — either from non-SAP (legacy, homegrown, Excel, manual) processes to SAP, or from existing SAP processes to a redesigned SAP process.

**Product type:** Web app (B2B SaaS, multi-tenant) · **Browser-facing:** yes · **Stage:** greenfield

---

## 2. Users & journeys

### 2.1 Personas

| Attribute | Primary — Solution Architect / Consultant | Secondary — Client Process Owner |
|-----------|-------------------------------------------|----------------------------------|
| Role | SAP solution architect or senior functional consultant (SD, MM, FI, CO, PP…) at an implementation partner or a client SAP CoE | Business owner of one or more processes at the client (e.g. Head of Sales Operations) |
| Context | Leads the design phase for 1–3 projects of 10–80 processes; runs workshops with process owners | Invited to review and approve the documents for their processes; spends ≤ 30 min per review |
| Current workflow | Workshop notes in Word, process maps in Visio/Signavio, fit-gap and RICEFW lists in Excel, Blueprint assembled in Word; versions tracked by file name | Receives Word attachments by email, replies with comments, signs a PDF |
| Technical fluency | Expert in SAP terminology (scope item, IMG, RICEFW, T-code); moderate software fluency | Non-technical in SAP; will not read documentation; reaches the product only through an email link |
| Cares about | A credible first draft fast; traceability; client sign-off; never showing the client an invented SAP fact | Their process described correctly; their wish list captured; clarity on what changes for their team |
| Does not care about | Diagram editing, project financials, billing | RICEFW, IMG, configuration detail |

**Roles (binding):**

| Scope | Role | Who | Permissions |
|-------|------|-----|-------------|
| Org | ADMIN | Person who signed up the org | Everything a MEMBER can do + manage the reference library (F9) |
| Org | MEMBER | Consultants | Create projects (becoming LEAD of them); join projects when invited |
| Org | GUEST | Invited process owners | See only projects they are members of; cannot create projects |
| Project | LEAD | Consultant leading the project (also acts as program manager in v1) | Edit scope; generate and edit all documents; invite; approve any document; generate and export the Blueprint |
| Project | CONSULTANT | Other consultants | Generate and edit documents; comment; send for review. Cannot approve, invite or generate the Blueprint |
| Project | PROCESS_OWNER | Client business owner | Read the project; comment; approve or request changes on As-Is and To-Be of processes assigned to them |

### 2.2 Journey map

**J1 · First project to first To-Be draft** — persona: Consultant (as LEAD) · frequency: once per project, then per process · goal: a credible To-Be for a real process, traced to its As-Is

**Trigger:** a new SAP project's design phase starts; the consultant has the client's problem statement and notes from a first workshop on one process.

| # | Surface | User does | System responds | How they knew to do it | Feature |
|---|---------|-----------|-----------------|------------------------|---------|
| J1.1 | `/signup` | Enters name, work email, password, organisation name; clicks "Create account" | `POST /api/auth/signup` 201; session set; redirect to `/projects` | "Create account" link on `/login` or marketing site | F1 |
| J1.2 | `/projects` (empty) | Clicks "Start a transformation project" | Navigates to `/projects/new` | Sole primary CTA of the empty state (secondary link: "Explore the demo project", F12) | F2 |
| J1.3 | `/projects/new` | Fills the 4 required fields (project name, client name, problem statement, target SAP product) and optional ones (starting landscape, modules, org units); clicks "Analyse & propose scope" | Project created; analysis job runs with a progress panel; on success redirect to `/projects/:id/scope` | Form's only primary button; step indicator "Step 1 of 2" | F2 |
| J1.4 | `/projects/:id/scope` | Reviews extracted objectives and pain points; edits the proposed process tree (rename, remove, add children); sets starting point (Non-SAP / Existing SAP) and legacy system per leaf; edits org units; clicks "Confirm scope" | `PUT /api/projects/:id/scope` 200; redirect to `/projects/:id` | Step indicator "Step 2 of 2"; sticky footer primary button | F3 |
| J1.5 | `/projects/:id` | Clicks the next-step banner CTA "Capture the As-Is for {first leaf process}" | Navigates to that process's As-Is page | Next-step banner, always present on the workspace, computed from stage statuses | F3 |
| J1.6 | `/projects/:id/processes/:pid/as-is` | Pastes workshop notes and/or uploads files; clicks "Structure As-Is" | Sources saved; job runs; steps table, swimlane diagram, pain points and follow-up questions render; As-Is chip = Draft | Empty state of the As-Is tab: paste box, dropzone, one button; "Try with sample notes" link | F4 |
| J1.7 | same | Answers follow-up questions or edits steps (autosave); clicks "Next: Run gap analysis" | Saved; navigates to `/…/gap` | Primary CTA in the document header once an As-Is draft exists; stage stepper shows Gap next | F4 |
| J1.8 | `/…/gap` | Clicks "Run gap analysis"; reviews the table; clicks "Next: Design the To-Be" | Requirements table with Fit / Partial fit / Gap, resolution, RICEFW type, complexity, priority; SAP references shown as verified or amber "Unverified" chips; then navigates to `/…/to-be` | Empty-state CTA, then header CTA | F5, F9 |
| J1.9 | `/…/to-be` | Clicks "Generate To-Be" | Wish list, best-practice mapping, process-mapping badge (1:1 / 1:n / n:1), replication table, To-Be steps with trace links, diagram; "Compare with As-Is" toggle | Empty-state CTA | F6, F9 |

**Ends at:** the To-Be draft, viewable side by side with the As-Is. The header offers "Send for review" (→ J2) and, for the LEAD, "Approve".
**Activation moment:** J1.9 — the first To-Be draft for a process the user created renders with every To-Be step linked to at least one As-Is step, requirement or gap.
**Drop-off risks:** J1.3 (long form — only 4 fields required, the rest optional with defaults); J1.6 (no notes at hand — "Try with sample notes" fills the paste box with an Order-to-Cash example).

**J2 · Process owner reviews and approves** — persona: Process Owner (J2.1 by the LEAD) · frequency: several times per project · goal: confirm their process is described correctly and approve it

**Trigger:** an email "{Consultant} asked you to review the As-Is for {process}".

| # | Surface | User does | System responds | How they knew to do it | Feature |
|---|---------|-----------|-----------------|------------------------|---------|
| J2.1 | `/…/as-is` (LEAD) | Clicks "Send for review"; picks an existing process owner or enters a new email | Review request created; invite created if new; email sent; chip "In review" | Document header button, shown while status is Draft | F8, F1 |
| J2.2 | Email → `/invite/:token` | Clicks the email link; enters name and password; clicks "Join & review" | Account activated (org GUEST + project PROCESS_OWNER); redirect to `/review` | Email link | F1 |
| J2.3 | `/review` | Opens the top card | Document opens in review mode (`?mode=review`): read view with sticky decision bar | Review queue is the process owner's home; cards sorted oldest first | F8 |
| J2.4 | `/…/as-is?mode=review` | Comments on a step; clicks "Approve" or "Request changes" (with reason) | Decision saved; toast with remaining count; back to `/review` | Sticky decision bar | F8 |
| J2.5 | `/review` → `/…/to-be?mode=review` | After the LEAD approves the Gap analysis and sends the To-Be: opens the To-Be card, uses "Compare with As-Is", approves | To-Be approved; queue shows "All caught up" | Email "New item to review" + queue card | F8, F6 |

**Ends at:** empty queue; the LEAD receives an in-app notification and an email for every decision.
**Drop-off risks:** J2.2 (account creation) — the invite page asks only for name and password; token valid 7 days; the LEAD can copy the link if email fails.

**J3 · Approved To-Be to approved Change of Process document** — persona: Consultant (LEAD) · frequency: once per process · goal: a technically detailed change document ready for the Blueprint

**Trigger:** notification "To-Be for {process} approved by {owner}".

| # | Surface | User does | System responds | How they knew to do it | Feature |
|---|---------|-----------|-----------------|------------------------|---------|
| J3.1 | Notification bell → `/…/to-be` | Clicks the notification | To-Be opens; header CTA "Next: Generate Change of Process document" | Bell badge + email | F8 |
| J3.2 | `/…/change-doc` | Clicks "Generate Change of Process document" | 8-section document renders with a table of contents | Header CTA, then empty-state button | F7 |
| J3.3 | same | Edits tables inline; resolves amber "Unverified" references (verify & add to library, replace, or remove) | Autosave; chips turn verified; header counter "Unverified references: 0" | Header counter jumps to the first unverified chip | F7, F9 |
| J3.4 | same | Clicks "Approve" | Status Approved; process chip "Ready for Blueprint"; workspace banner "Next: Generate the Blueprint ({n} of {m} processes ready)" | Decision bar | F8 |

**Ends at:** the process is ready for the Blueprint.
**Drop-off risks:** J3.3 (many unverified references) — counter plus "next unverified" navigation; references can stay unverified, at the cost of a DRAFT watermark on the Blueprint.

**J4 · Compile and export the SAP Business Blueprint** — persona: LEAD · frequency: a few times per project · goal: a sign-off-ready Blueprint file

**Trigger:** steering-committee review or sign-off date.

| # | Surface | User does | System responds | How they knew to do it | Feature |
|---|---------|-----------|-----------------|------------------------|---------|
| J4.1 | `/projects/:id` | Reviews the status overview; clicks "Blueprint" in the project sidebar or the banner CTA | `/projects/:id/blueprint` with a readiness checklist (ready vs blocked processes, with the blocking stage) | Sidebar item; next-step banner | F11, F10 |
| J4.2 | `/projects/:id/blueprint` | Clicks "Generate Blueprint" | Job; preview with 12-section table of contents; version v{n}; DRAFT badge if scope incomplete or unverified references remain | Primary CTA | F10 |
| J4.3 | same | Clicks "Export DOCX" or "Export PDF" | Export job; download starts; export listed under the version | Buttons in the preview header | F10 |

**Ends at:** file downloaded; the version stays in history.

**J5 · Recovery** — what users do when the main journeys break

| # | Situation | User sees | Recovery path | Feature |
|---|-----------|-----------|---------------|---------|
| J5.1 | Any AI job fails or times out | Error panel "Generation failed. Your inputs are saved." + "Retry" | Retry; on success the page renders normally; no duplicate documents | F2, F4–F7, F10 |
| J5.2 | Upload rejected (type, size, no text layer) | Inline error on that file; other files kept | Remove file, paste text instead | F4 |
| J5.3 | LEAD edits an approved document | Downstream documents marked Stale with banner "{Upstream} changed v{a} → v{b}" | "Regenerate" or "Keep & re-link", then re-approve | F8 |
| J5.4 | User left during project setup | `/projects` card "Setup incomplete — Resume" | Resume returns to the scope page with the AI proposal intact | F2, F3 |
| J5.5 | Same document edited in two tabs | 409 banner "Changed elsewhere — reload to see the latest" | Reload | F4, F8 |

### 2.3 First-run experience

| Aspect | Specification |
|--------|--------------|
| First route after signup | `/projects` |
| What's on screen with zero data | Headline "Turn a problem statement into an SAP Business Blueprint"; line "Start with one project: capture the As-Is of one process and get a draft To-Be in about 15 minutes."; one primary CTA "Start a transformation project"; secondary link "Explore the demo project" (F12, P1) |
| Onboarding mechanism | Inline only: two-step project setup, then the workspace next-step banner and the per-process stage stepper (As-Is → Gap → To-Be → Change doc). No tour — consultants know the methodology; they need the order shown, not tutorials. |
| Setup steps before value | (1) sign up, (2) project form, (3) confirm scope, (4) As-Is input. Four steps; mitigation: only 4 required fields in (2), AI-proposed scope in (3), sample notes in (4). |
| **Activation moment** | First To-Be draft for a user-created process rendered with trace links (J1.9); tracked as event `to_be_generated` with `firstForOrg=true` |
| Time-to-activation target | p50 ≤ 15 min from signup; ≤ 8 screens (route changes) |
| If setup is abandoned midway | Project saved at J1.3 submit; `/projects` shows the card with "Setup incomplete — Resume" → `/projects/:id/scope`. Pasted As-Is text is autosaved as a draft source (debounce 2 s) |
| Sample/demo data | No seeded data in a new org. Optional demo project (F12, P1). "Try with sample notes" link on the As-Is empty state (P0, part of F4) |

### 2.4 Navigation & information architecture

| Route | Screen purpose | Reachable from | Auth | Features | Primary CTA |
|-------|----------------|----------------|------|----------|-------------|
| `/` | Redirect | direct URL | public | — | → `/projects` (or `/review` for GUEST) if signed in, else `/login` |
| `/signup` | Create account + org | `/login` link; marketing site | public | F1 | Create account |
| `/login` | Sign in | redirect when unauthenticated (`?next=`) | public | F1 | Sign in |
| `/invite/:token` | Accept invite | email link; copied link | public (token) | F1 | Join & review |
| `/projects` | Project list | post-login redirect (ADMIN/MEMBER); top nav "Projects" | auth | F2, F12 | Start a transformation project |
| `/projects/new` | Setup step 1 | `/projects` CTA | ADMIN, MEMBER | F2 | Analyse & propose scope |
| `/projects/:id/scope` | Setup step 2 / scope editing | redirect after analysis; "Resume setup"; sidebar "Scope" | members (edit: LEAD, CONSULTANT) | F3 | Confirm scope / Save scope |
| `/projects/:id` | Workspace: process tree, stage chips, status overview, next-step banner | project card; sidebar "Overview"; breadcrumb | members | F3, F11 | Next-step banner CTA |
| `/projects/:id/processes/:pid/as-is` | As-Is | banner; stage chip; stepper | members | F4, F8 | Structure As-Is → Next: Run gap analysis |
| `/projects/:id/processes/:pid/gap` | Gap analysis | stepper; chip; As-Is header CTA | members | F5, F8 | Run gap analysis → Next: Design the To-Be |
| `/projects/:id/processes/:pid/to-be` | To-Be design | stepper; chip; Gap header CTA | members | F6, F8 | Generate To-Be → Send for review |
| `/projects/:id/processes/:pid/change-doc` | Change of Process doc | stepper; chip; To-Be header CTA; notification | members | F7, F8 | Generate Change of Process document → Approve |
| `/projects/:id/blueprint` | Readiness, preview, versions, exports | sidebar "Blueprint"; banner | members (generate/export: LEAD) | F10 | Generate Blueprint |
| `/projects/:id/members` | Members & invites | sidebar "Members" | members (invite: LEAD) | F1 | Invite |
| `/review` | Review queue | top nav "Review" (count badge); GUEST post-login redirect; email links | auth | F8 | Open top item |
| `/admin/reference-library` | SAP reference library | top nav "Reference library" | auth (edit: ADMIN) | F9 | Add reference |

**Persistent navigation:** top bar — org name · Projects (hidden for GUEST with one project) · Review (badge) · Reference library · notification bell · user menu (Sign out). Inside a project: left sidebar — Overview · Scope · Blueprint · Members. Process pages: breadcrumb (Project › L1 › L2 › Process) and a 4-step stage stepper with status chips; locked steps show a lock icon and the reason on hover and focus.
**Discoverability rule:** every P0 feature is reachable in ≤ 3 clicks from `/projects/:id`.
**Back-path rule:** breadcrumb on every project page; review mode has "Back to queue"; every modal has Cancel. No dead ends.
**Primary-CTA rule:** each screen marks exactly one element with `data-primary-cta` (journey ACs rely on it).

### 2.5 Screen state coverage

AI job states are shared by every generating surface: **Loading** = progress panel `[data-testid="job-progress"]` with stage labels, polled every 2 s; **Error** = panel `[data-testid="job-error"]` "Generation failed. Your inputs are saved." + `[data-action="retry-job"]`.

| Surface | Empty | Loading | Error | Success | Partial / stale |
|---------|-------|---------|-------|---------|-----------------|
| `/projects` | Headline + "Start a transformation project" (§2.3) | Card skeletons | "Couldn't load projects" + Retry | Project cards with stage progress bar | Card badge "Setup incomplete — Resume" |
| `/projects/:id/scope` | Not reachable empty (analysis runs first); if analysis failed: job error panel | Job progress | Job error panel; form data preserved | Objectives, pain points, editable tree, org units | — |
| `/projects/:id` | "No processes in scope" + "Edit scope" | Tree skeleton | "Couldn't load project" + Retry | Tree with 4 stage chips per leaf; next-step banner; status overview (F11) | Stale chips amber; banner points to the first stale stage |
| `…/as-is` | Paste box + dropzone + "Structure As-Is" (disabled until input) + "Try with sample notes" | Job progress | Job error panel; per-file upload errors inline | Steps table, diagram, pain points, follow-up questions | "Input was long — some text was not analysed" notice when `inputTruncated` |
| `…/gap` | Locked "Capture the As-Is first" + link, or "Run gap analysis" | Job progress | Job error panel | Gap table + fit summary counts | Stale banner |
| `…/to-be` | Locked "Run the gap analysis first" + link, or "Generate To-Be" | Job progress | Job error panel | All To-Be sections + diagram + compare toggle | Stale banner; "Merged into {process}" if consolidated |
| `…/change-doc` | Locked with list of missing approvals, or "Generate Change of Process document" | Job progress | Job error panel | 8 sections + table of contents + unverified counter | Stale banner; "Merged into {process}" if consolidated |
| `/projects/:id/blueprint` | Readiness checklist; button disabled with "Approve at least one Change of Process document" | Job progress | Job error panel; failed export row with Retry | Preview, version list, exports | DRAFT badge when scope incomplete or unverified refs remain |
| `/review` | "All caught up — nothing waiting for your review" | Card skeletons | "Couldn't load your queue" + Retry | Cards (process, document type, requested by, age) | — |
| `/admin/reference-library` | "No references yet" + "Add reference" + "Import CSV" | Table skeleton | "Couldn't load library" + Retry | Searchable table | Import result panel with row errors |

### 2.6 Journey acceptance criteria

Journey ACs run with `AI_PROVIDER=stub` (deterministic golden outputs, FIX-8) and start from a fresh account (FIX-3). **Chained suite:** J1-AC1 → J2-AC1 → J3-AC1 → J4-AC1 → J5-AC2 run in order in one test run, each continuing from the state the previous one produced. J1-AC2, J1-AC3 and J5-AC1 each start from their own fresh account. No J-AC may enter a URL by hand except `/signup` at the start and invite links read from the stub mailbox.

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| J1-AC1 | FIX-3 fresh visitor on `/signup` | The user follows only `[data-primary-cta]` elements and the form fields on each screen, pasting FIX-9 workshop notes on the As-Is page | The To-Be page renders `[data-testid="to-be-steps"]` with ≥ 1 step showing a trace link to an As-Is step; the path took ≤ 8 route changes; every intermediate screen had exactly one `[data-primary-cta]`; zero console errors across the path | browser-verify |
| J1-AC2 | Fresh account that completed J1.3 (analysis succeeded) and signed out on the scope page | The user signs in again | `/projects` shows the project card with `[data-action="resume-setup"]`; clicking it opens `/projects/:id/scope` with the same proposed node count as before; no new analysis job is created | browser-verify |
| J1-AC3 | Fresh account at J1.6 with text pasted but "Structure As-Is" not clicked | The user navigates to `/projects/:id` via the breadcrumb and back via the stage chip | The paste box still contains the text (autosaved draft source) | browser-verify |
| J2-AC1 | State after J1-AC1 | LEAD sends the As-Is for review to a new email; the owner opens the invite link from the stub mailbox, joins, approves the As-Is from `/review`; LEAD approves the Gap analysis directly and sends the To-Be; owner approves it from `/review` | Owner landed on `/review` after joining; reached each document from a queue card; queue ends in the "All caught up" state; LEAD's notification badge shows 2 new items; zero console errors | browser-verify |
| J3-AC1 | State after J2-AC1 | LEAD clicks the "To-Be approved" notification, then follows header CTAs to generate and approve the Change of Process document | Change doc status Approved; process chip "Ready for Blueprint"; workspace banner names the Blueprint as next step; zero console errors | browser-verify |
| J4-AC1 | State after J3-AC1 | LEAD clicks sidebar "Blueprint", generates, and clicks `[data-action="export-docx"]` | Readiness shows 1 of 1 ready; download returns 200 with DOCX content type; no DRAFT badge (stub outputs reference only seeded library entries) | browser-verify |
| J5-AC1 | Fresh account at J1.8 with `AI_FAULT_INJECTION=gap:timeout:once` | User clicks "Run gap analysis", sees the error panel, clicks `[data-action="retry-job"]` | Gap table renders on retry; As-Is version count unchanged; exactly one Gap document exists for the process | browser-verify |
| J5-AC2 | State after J4-AC1 | LEAD opens the As-Is, clicks `[data-action="new-version"]`, edits a step, then follows the workspace banner | To-Be shows `[data-testid="stale-banner"]` naming "As-Is v1 → v2"; clicking `[data-action="regenerate"]` produces To-Be v2 Draft and removes the banner; Change doc chip shows Stale | browser-verify |

### 2.7 Feature ↔ journey traceability

| Feature | Appears in journeys | Entry point |
|---------|--------------------|-------------|
| F1 Accounts, orgs, roles, invites | J1.1, J2.1, J2.2 | `/login` "Create account" link; email invite link; sidebar "Members" |
| F2 Project setup & problem analysis | J1.2, J1.3, J5.1, J5.4 | `/projects` empty-state CTA; "New project" button on a non-empty list |
| F3 Scope & process hierarchy | J1.4, J1.5, J5.4 | Redirect after analysis; sidebar "Scope"; "Resume setup" |
| F4 As-Is capture & structuring | J1.6, J1.7, J5.1, J5.2, J5.5 | Workspace next-step banner; stage chip; stepper |
| F5 Gap analysis | J1.8, J5.1 | As-Is header CTA "Next: Run gap analysis"; stepper |
| F6 To-Be design | J1.9, J2.5, J5.1 | Gap header CTA "Next: Design the To-Be"; stepper |
| F7 Change of Process documentation | J3.2, J3.3, J5.1 | To-Be header CTA; approval notification; stepper |
| F8 Review, comments, approvals, versions | J2.1, J2.3–J2.5, J3.1, J3.4, J5.3, J5.5 | "Send for review" / "Approve" in document headers; top nav "Review"; bell |
| F9 SAP reference library & verification | J1.8, J1.9, J3.3 | Reference chips in documents; top nav "Reference library" |
| F10 Business Blueprint | J4.1–J4.3, J5.1 | Sidebar "Blueprint"; workspace banner |
| F11 Program status overview (P1) | J4.1 | `/projects/:id` overview panel |
| F12 Demo project (P1) | J1.2 (alternate path) | `/projects` empty-state secondary link |

No orphans: every P0 feature has a journey step and an on-screen entry point; every journey step is powered by a listed feature.

---

## 3. Scope

### In scope for v1

| ID | Feature | Priority | Complexity | Brief description | Verification |
|----|---------|----------|------------|-------------------|--------------|
| F1 | Accounts, organisations, roles & invitations | P0 | high — auth boundary, tenant isolation | Email/password signup creating an org; login; project invites with roles | mixed |
| F2 | Project setup & problem-statement analysis | P0 | medium — first AI stage, async job | Project form; AI extracts objectives, pain points, proposed process hierarchy | mixed |
| F3 | Scope & process hierarchy | P0 | medium — tree editing, next-step logic | Confirm/edit L1–L4 tree, starting point per process, org units; workspace with stage chips | mixed |
| F4 | As-Is capture & structuring | P0 | high — file parsing, AI, editable structured doc | Paste/upload sources; AI structures steps, pain points, follow-up questions; deterministic diagram | mixed |
| F5 | Gap analysis | P0 | high — AI classification, reference integrity | Requirements (current capabilities + wishes) classified Fit / Partial fit / Gap with resolution and RICEFW type | mixed |
| F6 | To-Be design | P0 | high — AI with trace-coverage invariants | Wish list, best-practice mapping, 1:1 / 1:n / n:1 mapping, replication, traced To-Be steps, compare view | mixed |
| F7 | Change of Process documentation | P0 | high — merges approved versions, technical detail | Side-by-side As-Is vs To-Be plus configuration, master data, RICEFW, integrations, migration, roles, risks, tests | mixed |
| F8 | Review, comments, approvals & versioning | P0 | high — state machine, locking, concurrency | Review requests, decisions, anchored comments, notifications, immutable versions, staleness | mixed |
| F9 | SAP reference library & verification | P0 | medium — tenant-scoped data, render-time verification | Library of SAP references; unverified chips; verify/replace/remove; CSV import | mixed |
| F10 | SAP Business Blueprint compile & export | P0 | high — aggregation, document rendering | Readiness, versioned Blueprint, DOCX and PDF export with DRAFT watermark rule | mixed |
| F11 | Program status overview | P1 | low — read-only aggregation | Status counts and process × stage matrix on the workspace | browser-verify |
| F12 | Demo project | P1 | low — seeded read-only copy | One-click read-only Order-to-Cash demo project in the org | browser-verify |

### Explicitly NOT in scope for v1 (non-goals)

- **No connection to SAP systems** — no RFC/OData reads from client ECC or S/4HANA, no configuration pushed to SAP. Documents only.
- **No SAP Signavio, Solution Manager or Cloud ALM integration**, import or export.
- **No BPMN 2.0 XML import/export and no graphical diagram editor** — diagrams are generated from the steps table; users edit steps, not shapes.
- **No real-time co-editing** — optimistic concurrency with a 409 conflict banner.
- **No project management** — no timelines, Gantt charts, effort estimates, resource plans or RICEFW costing.
- **No full functional or technical specifications** per RICEFW object — only the outline inside the Change doc.
- **No test management or execution** — test scenarios are listed, not run.
- **No data migration tooling** — migration objects are documented only.
- **No bundling of SAP proprietary Best Practices content** (process diagrams, test scripts, configuration guides). The library stores kind, code, title and short consultant-written summaries.
- **No OCR** for scanned PDFs.
- **No billing, subscriptions, SSO/SAML/SCIM, or multi-language UI** (English only).
- **No mobile layout** — desktop-first (≥ 1280 px primary, ≥ 1024 px usable).

### Future considerations (do NOT build)

- Signavio / Cloud ALM export; BPMN XML export
- Read-only SAP system analysis for brownfield As-Is (usage and custom-code analysis)
- Per-RICEFW functional/technical spec generation; push of the RICEFW backlog to Jira or Cloud ALM
- SSO, data-residency-specific deployments, multi-language documents
- Real-time collaboration

---

## 4. Stack & decisions

### Product decisions (from the founder brief)

| Decision | Status |
|----------|--------|
| Pipeline order: problem statement → As-Is → Gap analysis → To-Be → Change of Process documentation → SAP Business Blueprint | LOCKED |
| Both non-SAP processes and existing-SAP processes get their own As-Is and To-Be | LOCKED |
| To-Be contains: wish list, SAP best-practice mapping, process mapping (1:1, 1:n), replication | LOCKED |
| As-Is and To-Be merge into one "Change of Process Documentation with technical detail" per process | LOCKED |
| Final deliverable is named "SAP Business Blueprint" | LOCKED |
| n:1 (consolidation) mapping added alongside 1:1 and 1:n | ASSUMPTION(med) |
| "Replication" = rolling one To-Be design across org units (company codes, plants, sales orgs, regions) with local variants — not data replication | ASSUMPTION(med) |

### Stack

| Layer | Choice | Version | Status |
|-------|--------|---------|--------|
| Language | TypeScript | per lockfile | PROPOSED |
| Framework | Next.js (App Router), route handlers for the API | per lockfile | PROPOSED |
| Database | PostgreSQL 16 + Drizzle ORM | per lockfile | PROPOSED |
| Background jobs | pg-boss (Postgres-backed queue) in a separate worker process | per lockfile | PROPOSED |
| UI | Tailwind CSS + shadcn/ui | per lockfile | PROPOSED |
| AI | Anthropic TypeScript SDK; model from `AI_MODEL` (default `claude-sonnet-5-5`) | per lockfile | PROPOSED |
| Validation | Zod (shared between API, AI output validation and forms) | per lockfile | PROPOSED |
| Diagrams | Mermaid, rendered client-side; server-side SVG/PNG for exports | per lockfile | PROPOSED |
| DOCX export | `docx` npm package | per lockfile | PROPOSED |
| PDF export | Render Blueprint HTML to PDF with headless Chromium (Playwright) in the worker | per lockfile | PROPOSED |
| File storage | S3-compatible object storage | — | PROPOSED |
| Email | Resend (any transactional provider behind one interface) | — | PROPOSED |
| Package manager | pnpm | — | PROPOSED |
| Testing | Vitest (unit/integration) + Playwright (browser) | per lockfile | PROPOSED |
| Hosting | Docker images for `web` and `worker`; managed Postgres; EU region | — | PROPOSED · see TODO-2 |

### Delegated decisions

| Decision | Constraint |
|----------|-----------|
| Auth library | Email/password, httpOnly session cookies, invitation flow; org ID always derived from the session |
| Text extraction libraries (PDF, DOCX, XLSX) | Pure Node, no external service; must report "no text layer" for scanned PDFs |
| Table/grid component | Inline cell editing with keyboard support; prefer what shadcn/ui pairs with |
| Splitting large AI stages into several model calls | Each call still validates against its schema; the job reports one combined progress |
| Library candidate selection for prompts | Filter by project modules + target product; ≤ 50 entries per prompt; deterministic |
| Folder layout below `/src` | Framework conventions; document in `docs/architecture.md` |

### Architectural constraints

- **Tenancy:** every tenant-owned table has `orgId`; `orgId` comes from the session, never from the request body or URL. All queries go through a repository helper that injects the `orgId` filter; Postgres row-level security as defence in depth. Cross-tenant access returns 404, never 403.
- **API envelope:** `{ "success": true, "data": … }` or `{ "success": false, "error": { "code": "SCREAMING_SNAKE", "message": "…", "field": "…?", "requestId": "…" } }`.
- **AI calls are always asynchronous:** generating endpoints return 202 `{ jobId }`; the UI polls `GET /api/jobs/:jobId`. No AI call inside a request/response cycle.
- **Documents are structured JSON**, one Zod schema per document type with `schemaVersion`. UI, DOCX and PDF render from the same payload. Free text only in named narrative fields.
- **Approved versions are immutable.** Editing an approved document creates a new version.
- **Diagrams are deterministic:** Mermaid source is generated by code from the steps table, never by the model.
- **SAP references** are stored as `{ kind, code, label? }`. Verified/unverified is computed at render and export time by looking up `(kind, code)` in the library visible to the org (F9).
- **Test hooks:** `AI_PROVIDER=stub` and `AI_FAULT_INJECTION` are ignored when `NODE_ENV=production`.
- **Selectors:** every interactive element named in an AC carries the exact `data-action` / `data-testid` written in this PRD.

---

## 5. Build sequence

| Milestone | Goal | Journey segment made walkable | Features | Exit criteria (must pass) | Demoable check |
|-----------|------|-------------------------------|----------|---------------------------|----------------|
| **M0 — Walking skeleton** | Repo boots; web + worker + DB run; nav shell and route stubs exist; `/verify` green | Shell only | — | M0-AC1, M0-AC2, M0-AC3 | Open the dev URL, see the login page and app shell |
| **M1 — Sign up to confirmed scope** | Account, project form, AI scope proposal, scope confirmation, workspace with next-step banner | J1.1 → J1.5 | F1 (account part), F2, F3 | F1-AC1, F1-AC2, F1-AC5, F1-ERR1–4, F1-ERR7; F2-AC1–5, F2-ERR1–4; F3-AC1–4, F3-ERR1–4; **J1-AC2** | New user signs up, describes a project, confirms an AI-proposed tree, lands on the workspace |
| **M2 — As-Is** | Capture and structure the As-Is | J1.5 → J1.7 | F4 | F4-AC1–6, F4-ERR1–6; **J1-AC3** | Paste notes, get a structured As-Is with diagram and questions |
| **M3 — Gap + To-Be (activation)** | Gap analysis and To-Be with traceability; reference chips | J1.8 → J1.9 (J1 complete) | F5, F6, F9 (render + selection) | F5-AC1–5, F5-ERR1–3; F6-AC1–6, F6-ERR1–4; F9-AC1, F9-AC2, F9-AC6; **J1-AC1, J5-AC1** | A new user reaches a traced To-Be draft unaided |
| **M4 — Review & approvals** | Invites, review queue, decisions, comments, versions, staleness | J2 complete; J5.3 | F8, F1 (invite part) | F8-AC1–9, F8-ERR1–7; F1-AC3, F1-AC4, F1-ERR5, F1-ERR6, F1-ERR8; **J2-AC1** | Owner joins from email and approves As-Is and To-Be |
| **M5 — Change of Process doc** | Generate, edit, verify references, approve | J3 complete | F7, F9 (library management) | F7-AC1–5, F7-ERR1–3; F9-AC3–5, F9-ERR1–3; **J3-AC1** | Approved To-Be becomes an approved change document |
| **M6 — Blueprint · v1 complete** | Compile and export; full regression | J4 complete; all journeys walkable | F10 | F10-AC1–6, F10-ERR1–3; **J4-AC1, J5-AC2**; re-run every P0 AC and every J-AC; §12 launch criteria | Full journey demo on a fresh account ending in a downloaded Blueprint |
| **M7 — P1** | Status overview and demo project | J4.1 enriched; J1.2 alternate | F11, F12 | F11-AC1–2, F11-ERR1, F12-AC1–2, F12-ERR1 | Workspace overview; demo project in one click |

**M0 skeleton ACs:**

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| M0-AC1 | Dev server running | Browser opens `/login` | 200; app shell with top bar renders; zero console errors | browser-verify |
| M0-AC2 | Web and worker running | `GET /api/health` | 200 `{ "db": "ok", "queue": "ok", "storage": "ok" }`; a no-op job enqueued by the health check reaches SUCCEEDED within 5 s | integration |
| M0-AC3 | Empty database | `pnpm db:seed` runs twice | Both runs exit 0; seeded reference library row count identical after each run | integration |

---

## 6. Feature specifications

### 6.0 Shared AI stage contract (applies to F2, F4, F5, F6, F7, F10)

| Aspect | Specification |
|--------|--------------|
| Model | `AI_MODEL` (default `claude-sonnet-5-5`); provider from `AI_PROVIDER` = `anthropic` \| `stub` |
| Single entry point | `src/lib/ai/runStage.ts` → `runStage(stage, input)`. Nothing else imports the SDK |
| Prompt artifacts | `prompts/<stage>.system.md` and `prompts/<stage>.user.md`; no prompt strings in code |
| Output | The model answers through one tool whose input schema is generated from the stage's Zod schema; the server re-validates with Zod and runs the stage's invariant checks |
| Repair | On schema or invariant failure: one retry with the validator errors appended to the prompt; a second failure ends the job FAILED with the stage's error code (default `AI_INVALID_OUTPUT`) |
| Transport errors | 429 / 5xx / network: up to 2 retries with backoff (2 s, 8 s). Per call timeout 120 s; job hard timeout 300 s → FAILED `AI_TIMEOUT` |
| Input rules | Only the current org's and project's data; never other tenants' data, secrets or user emails. Source text capped at `AI_MAX_INPUT_TOKENS`; when capped, output `inputTruncated: true` and the UI shows a notice |
| SAP references | The prompt includes candidate library entries (F9 selector). The model cites `{ kind, code }` from candidates; anything else it must output as `{ kind, code, label }`, which renders Unverified |
| Behaviour rules (every system prompt) | Act as an SAP solution architect; never invent client facts; when information is missing, add a follow-up question or open issue instead of assuming; keep given IDs exactly |
| Logging | Per job: stage, model, input/output tokens, latency, attempts, validation errors. Prompt and output text never go to application logs |
| Evals | Golden sets in `evals/<stage>/`, run with `pnpm eval:<stage>` against the real model; required before merging any prompt change |
| Test hooks | `AI_PROVIDER=stub` returns `fixtures/ai/<stage>/default.json`; `AI_FAULT_INJECTION=<stage>:<timeout\|invalid\|error>[:once]` simulates failures |
| Cost budget | TODO-1 |

| Stage | Feature | Output schema | p95 job latency |
|-------|---------|---------------|-----------------|
| `problem_analysis` | F2 | `ProblemAnalysisSchema` | ≤ 60 s |
| `as_is` | F4 | `AsIsPayloadSchema` | ≤ 90 s |
| `gap` | F5 | `GapPayloadSchema` | ≤ 120 s |
| `to_be` | F6 | `ToBePayloadSchema` | ≤ 150 s |
| `change_doc` | F7 | `ChangeDocPayloadSchema` | ≤ 180 s |
| `blueprint_narrative` | F10 | `BlueprintNarrativeSchema` | ≤ 90 s |

**Shared job API:** `GET /api/jobs/:jobId` → 200 `{ "id", "kind", "status": "QUEUED|RUNNING|SUCCEEDED|FAILED", "progressLabel", "error": { "code", "message" } | null, "result": { "documentId", "versionId" } | null }` (404 for another org's job). `POST /api/jobs/:jobId/retry` → 202 `{ jobId }` for FAILED jobs, 409 `INVALID_STATE` otherwise. **Every generation creates a new document version**; earlier versions stay in history.

---

### F1 · Accounts, organisations, roles & invitations — P0 · complexity: high

**User story:** As a consultant, I want to create an account for my organisation and invite colleagues and client process owners to a project, so that each person sees only what their role allows.

**Description:** Signup creates a User and an Organization (user = org ADMIN). Login and logout with session cookies. The project LEAD invites people by email with a project role; process owners are also assigned processes. Accepting an invite activates the account and memberships. Every data access is scoped to the session's org.

**Journey context:**

| | |
|---|---|
| Serves journey steps | J1.1, J2.1, J2.2 |
| Entry point | "Create account" link on `/login`; email invite link; sidebar "Members" → `[data-action="invite-member"]`; inline from "Send for review" (F8) |
| Preceded by | Nothing (signup) · F8 "Send for review" (invite) |
| On success, user lands at | Signup → `/projects` empty state · invite accepted → `/review` (PROCESS_OWNER) or `/projects/:id` (CONSULTANT) |
| On cancel/abandon | Invite stays PENDING for 7 days; LEAD can resend or copy the link |

**Routes & network:**

| Route | Method | Purpose | Expected status |
|-------|--------|---------|-----------------|
| `/signup`, `/login` | GET | Forms | 200 |
| `/api/auth/signup` | POST | Create user + org + session | 201, 400, 409 |
| `/api/auth/login` | POST | Create session | 200, 401, 429 |
| `/api/auth/logout` | POST | End session | 200 |
| `/projects/:id/members` | GET | Members and invites page | 200 |
| `/api/projects/:id/invites` | POST | Create invite, send email | 201, 400, 403, 409 |
| `/api/invites/:token` | GET | Invite details for the accept page | 200, 410 |
| `/api/invites/:token/accept` | POST | Set name/password, activate memberships | 200, 400, 410 |

**Happy path (invite):**

1. LEAD on `/projects/:id/members` clicks `[data-action="invite-member"]`; modal asks email, role (Consultant / Process owner) and, for Process owner, processes (multi-select of leaves).
2. `[data-action="send-invite"]` → `POST /api/projects/:id/invites` 201; row shows "Invited" and `[data-action="copy-invite-link"]`; email sent.
3. Invitee opens `/invite/:token` → `GET /api/invites/:token` 200 shows org, project and inviter; enters name and password; `[data-action="accept-invite"]` → `POST …/accept` 200; session set; redirect as above.

**Data in:**

```json
{ "name": "Asha Rao", "email": "asha@example-si.com", "password": "<≥10 chars, letter + digit>", "orgName": "Example SI" }
```
```json
{ "email": "owner@client.example", "projectRole": "PROCESS_OWNER", "processIds": ["prc_01J9ZQ3M"] }
```

**Data out:**

```json
{ "inviteId": "inv_01J9ZQ7T", "status": "PENDING", "expiresAt": "2026-10-26T09:00:00Z", "inviteUrl": "https://app.example/invite/<token>", "emailSent": true }
```

**Acceptance criteria:**

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| F1-AC1 | Visitor on `/signup`, no session | Fills all fields and clicks `[data-action="signup"]` | `POST /api/auth/signup` 201; session cookie set (httpOnly); URL `/projects`; `[data-testid="projects-empty"]` visible; zero console errors | browser-verify |
| F1-AC2 | FIX-1 LEAD on `/login` | Submits valid credentials | `POST /api/auth/login` 200; URL `/projects`; card "Acme O2C Transformation" visible | browser-verify |
| F1-AC3 | FIX-1 LEAD on `/projects/:id/members` | Invites `new.owner@test.local` as Process owner for O2C-01 via `[data-action="send-invite"]` | `POST /api/projects/:id/invites` 201; row "Invited" with `[data-action="copy-invite-link"]`; stub mailbox (FIX-13) holds 1 message to that address containing the invite URL | browser-verify |
| F1-AC4 | Valid invite token from F1-AC3 | Invitee opens `/invite/:token`, enters name + password, clicks `[data-action="accept-invite"]` | `POST /api/invites/:token/accept` 200; session set; URL `/review`; top nav shows no "Projects" list beyond this project | browser-verify |
| F1-AC5 | FIX-1 LEAD session; FIX-10 other org's IDs | Calls every tenant-scoped GET/PATCH/POST route with the other org's IDs | Every call returns 404 with `*_NOT_FOUND`; no data from FIX-10 in any response body | integration |

**Error cases:**

| ID | Case | Expected behavior | Verify |
|----|------|-------------------|--------|
| F1-ERR1 | Missing or invalid signup field | 400 `MISSING_FIELD` / `INVALID_FIELD` with `field`; inline error; no user or org created | integration + browser-verify |
| F1-ERR2 | Email already registered | 409 `EMAIL_EXISTS`; UI shows generic "Couldn't create account — try signing in"; no other info | integration |
| F1-ERR3 | Wrong password | 401 `INVALID_CREDENTIALS`; inline "Email or password is incorrect"; URL stays `/login` | browser-verify |
| F1-ERR4 | 6th failed login for one email within 10 min | 429 `RATE_LIMITED` with `Retry-After` | integration |
| F1-ERR5 | Expired or already-used token | `GET /api/invites/:token` 410 `INVITE_EXPIRED`; page shows "This invite has expired — ask {inviter} for a new one"; no form | browser-verify |
| F1-ERR6 | CONSULTANT or PROCESS_OWNER tries to invite | 403 `FORBIDDEN`; `[data-action="invite-member"]` not rendered for them | integration |
| F1-ERR7 | Unauthenticated visit to `/projects` | Redirect to `/login?next=/projects`; after login, lands on `/projects` | browser-verify |
| F1-ERR8 | Invited email belongs to a user of another org | 409 `EMAIL_IN_OTHER_ORG`; modal message "This person already uses the product with another organisation" (ASSUMPTION(med): one org per user in v1) | integration |

**Known pitfalls:**
- Store invite tokens hashed; compare in constant time; single use.
- Normalise emails to lowercase before every lookup.
- Derive `orgId` and role from the session on every request — never trust IDs in the body.
- Process-owner (GUEST) sessions must not list other projects via any API.

**Dependencies:** Email provider (§8) — on failure the invite is still created (`emailSent: false`).
**Out of scope:** password reset by email (P1 — in v1 an operator runs `pnpm user:reset-password`, ASSUMPTION(med)); SSO; org switching.

---

### F2 · Project setup & problem-statement analysis — P0 · complexity: medium

**User story:** As a consultant, I want to describe the client's problem once and get a proposed scope, so I don't start the process hierarchy from a blank page.

**Description:** A one-page form creates the project. An AI job reads the problem statement and returns objectives, pain points, a scope summary, a proposed L1–L3 process hierarchy and clarifying questions. The proposal is shown on the scope page (F3). The job runner and `runStage` built here are reused by every later AI stage.

**Journey context:**

| | |
|---|---|
| Serves journey steps | J1.2, J1.3, J5.1, J5.4 |
| Entry point | `/projects` empty-state CTA `[data-action="new-project"]`; "New project" button on a non-empty list |
| Preceded by | F1 signup or login |
| On success, user lands at | `/projects/:id/scope` with the proposal |
| On cancel/abandon | Before submit: nothing saved. After submit: project saved with `setupStatus` DRAFT or SCOPE_PROPOSED; card shows "Setup incomplete — Resume" |

**Routes & network:**

| Route | Method | Purpose | Expected status |
|-------|--------|---------|-----------------|
| `/projects`, `/projects/new` | GET | List; setup form | 200 |
| `/api/projects` | POST | Create project | 201, 400, 401 |
| `/api/projects/:id/analysis` | POST | Start `problem_analysis` job | 202, 409 |
| `/api/jobs/:jobId`, `/api/jobs/:jobId/retry` | GET, POST | Poll, retry (§6.0) | 200 / 202, 409 |

**Happy path:**

1. `/projects/new`: required — name, client name, problem statement (50–20,000 chars), target product. Optional — starting landscape (default MIXED), modules (multi-select), org units (type, code, name rows).
2. `[data-action="analyse-scope"]` (disabled after first click) → `POST /api/projects` 201 → `POST /api/projects/:id/analysis` 202 `{ jobId }`.
3. `[data-testid="job-progress"]` shows "Reading problem statement → Extracting objectives → Proposing process hierarchy".
4. Job SUCCEEDED → `setupStatus` = SCOPE_PROPOSED → redirect `/projects/:id/scope`.

**Data in:**

```json
{
  "name": "Acme O2C transformation",
  "clientName": "Acme Industries",
  "problemStatement": "Orders arrive by email and phone and are keyed into Excel and Tally…",
  "targetProduct": "S4HANA_CLOUD_PRIVATE",
  "startingLandscape": "NON_SAP",
  "modules": ["SD", "MM", "FI"],
  "orgUnits": [{ "type": "PLANT", "code": "1000", "name": "Pune plant" }]
}
```

**Data out (ProblemAnalysis payload):**

```json
{
  "schemaVersion": 1,
  "objectives": [{ "id": "OBJ-1", "text": "Cut order-entry errors below 0.5%" }],
  "painPoints": [{ "id": "PPS-1", "text": "Orders re-keyed from email into Excel", "quote": "keyed into Excel and Tally" }],
  "scopeSummary": "Order-to-cash for domestic and export sales across two plants…",
  "proposedProcesses": [
    { "ref": "p1", "parentRef": null, "level": 1, "code": "O2C", "name": "Order to Cash", "module": "SD", "rationale": "Core of the problem statement" },
    { "ref": "p2", "parentRef": "p1", "level": 2, "code": "O2C-01", "name": "Sales order management", "module": "SD", "rationale": "…" }
  ],
  "clarifyingQuestions": ["Are export orders handled by a separate team?"],
  "inputTruncated": false
}
```

**AI behavior:** §6.0 contract; prompt `prompts/problem_analysis.*.md`; enum values: `targetProduct` ∈ {S4HANA_CLOUD_PUBLIC, S4HANA_CLOUD_PRIVATE, S4HANA_ON_PREMISE}, `startingLandscape` ∈ {NON_SAP, EXISTING_SAP, MIXED}; `quote` must be a substring of the problem statement (invariant); golden set `evals/problem-analysis/` (10 cases).

**Acceptance criteria:**

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| F2-AC1 | Fresh user on `/projects` (empty) | Clicks `[data-action="new-project"]` | URL `/projects/new`; required fields marked; `[data-action="analyse-scope"]` disabled until required fields valid | browser-verify |
| F2-AC2 | `/projects/new` with valid required fields (FIX-9 problem statement) | Clicks `[data-action="analyse-scope"]` | `POST /api/projects` 201, then `POST …/analysis` 202; `[data-testid="job-progress"]` visible; on SUCCEEDED URL becomes `/projects/:id/scope`; zero console errors | browser-verify |
| F2-AC3 | Stub golden output | Job completes | Stored payload validates `ProblemAnalysisSchema`; ≥ 1 objective; ≥ 1 L1 process; every `quote` is a substring of the problem statement | integration |
| F2-AC4 | `evals/problem-analysis/` (10 labelled statements), real model | `pnpm eval:problem-analysis` | Schema validity 100% after ≤ 1 repair; recall of labelled L1 processes ≥ 80% | manual |
| F2-AC5 | `runStage` with a stub that returns invalid output once, then valid | Stage runs | Exactly 2 model calls; second prompt contains the validator errors; job SUCCEEDED; job record shows `attempts: 2` | unit |

**Error cases:**

| ID | Case | Expected behavior | Verify |
|----|------|-------------------|--------|
| F2-ERR1 | Problem statement < 50 chars | 400 `FIELD_TOO_SHORT` `field: problemStatement`; inline error; no project created | browser-verify |
| F2-ERR2 | Job fails (`AI_FAULT_INJECTION=problem_analysis:timeout`) | `[data-testid="job-error"]` replaces progress; form values still shown read-only with "Edit"; `[data-action="retry-job"]` → 202; project stays DRAFT | browser-verify |
| F2-ERR3 | Analysis requested while a job is running | 409 `JOB_ALREADY_RUNNING` with the existing `jobId`; UI keeps polling it | integration |
| F2-ERR4 | Unauthenticated `POST /api/projects` | 401 `UNAUTHENTICATED` | integration |

**Known pitfalls:**
- Double submit creates two projects — disable the button and send an idempotency key.
- Stop polling when the component unmounts; resume polling on return if the job is still running.

**Dependencies:** F1; AI provider (§8).
**Out of scope:** editing the proposal here (that is F3); importing projects from files.

---

### F3 · Scope & process hierarchy — P0 · complexity: medium

**User story:** As a consultant, I want to confirm which processes are in scope, how they nest, where each one starts from and which org units they cover, so every later document hangs off the right process.

**Description:** The scope page shows the AI proposal as an editable L1–L4 tree plus org units. Leaves (nodes without children) are the documented units: each leaf gets As-Is, Gap, To-Be and Change doc. Leaves require a starting point (NON_SAP / EXISTING_SAP) and a current system name. The workspace `/projects/:id` shows the tree with four stage chips per leaf and a next-step banner.

**Journey context:**

| | |
|---|---|
| Serves journey steps | J1.4, J1.5, J5.4 |
| Entry point | Redirect after analysis; "Resume setup" on the project card; sidebar "Scope" |
| Preceded by | F2 |
| On success, user lands at | `/projects/:id` with the next-step banner pointing to the first leaf's As-Is |
| On cancel/abandon | Proposal kept; card shows "Setup incomplete — Resume" |

**Routes & network:**

| Route | Method | Purpose | Expected status |
|-------|--------|---------|-----------------|
| `/projects/:id/scope`, `/projects/:id` | GET | Scope page; workspace | 200 |
| `/api/projects/:id/scope` | PUT | Save tree + org units; first save sets `setupStatus` ACTIVE | 200, 400, 409 |
| `/api/projects/:id/overview` | GET | Tree with stage statuses + next step | 200 |
| `/api/processes/:pid` | PATCH, DELETE | Edit or remove one node after setup | 200, 400, 409 / 204, 409 |

**Happy path:**

1. `/projects/:id/scope` shows objectives, pain points, clarifying questions (read-only) and `[data-testid="process-tree"]` with proposed nodes, plus `[data-testid="org-units"]`.
2. User renames inline, removes nodes, adds children with `[data-action="add-child"]`, sets starting point and current system on leaves, toggles in-scope.
3. `[data-action="confirm-scope"]` → `PUT /api/projects/:id/scope` 200 → `/projects/:id`.
4. Workspace: each leaf row shows `[data-testid="stage-chip-AS_IS|GAP|TO_BE|CHANGE_DOC"]`; `[data-testid="next-step-banner"]` names the next action.

**Data in:**

```json
{
  "processes": [
    { "clientRef": "p1", "parentClientRef": null, "level": 1, "code": "O2C", "name": "Order to Cash", "module": "SD", "inScope": true },
    { "clientRef": "p3", "parentClientRef": "p2", "level": 3, "code": "O2C-01-01", "name": "Standard sales order", "module": "SD", "inScope": true, "startingPoint": "NON_SAP", "currentSystem": "Tally + Excel order book" }
  ],
  "orgUnits": [{ "type": "PLANT", "code": "1000", "name": "Pune plant" }, { "type": "PLANT", "code": "2000", "name": "Chennai plant" }]
}
```

**Data out:** `{ "projectId": "prj_…", "setupStatus": "ACTIVE", "leafCount": 6, "nextStep": { "processId": "prc_…", "stage": "AS_IS", "label": "Capture the As-Is for Standard sales order" } }`

**Next-step rule (binding):** walk in-scope leaves in tree pre-order; pick the first leaf with a stage in {NOT_STARTED, DRAFT, CHANGES_REQUESTED, STALE}, taking that leaf's earliest such stage. If none, and ≥ 1 Change doc is APPROVED, the banner points to the Blueprint. If everything is IN_REVIEW, the banner reads "Waiting for {n} reviews" with a link to `/review`.

**Acceptance criteria:**

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| F3-AC1 | FIX-4 on `/projects/:id/scope` | Renames a node, removes one, adds an L3 child, sets its starting point and current system, clicks `[data-action="confirm-scope"]` | `PUT …/scope` 200; URL `/projects/:id`; tree shows exactly the edits; `setupStatus` ACTIVE | browser-verify |
| F3-AC2 | Workspace with leaves and no documents | Page loads | `[data-testid="next-step-banner"]` reads "Capture the As-Is for {first leaf}" and its CTA links to that leaf's `/as-is` | browser-verify |
| F3-AC3 | Table of tree + status combinations (incl. all IN_REVIEW, all APPROVED) | `nextStep()` runs | Returns the result defined by the next-step rule for every row | unit |
| F3-AC4 | Workspace with mixed statuses | User clicks a stage chip | Navigates to that stage's page for that process; chip colours match status | browser-verify |

**Error cases:**

| ID | Case | Expected behavior | Verify |
|----|------|-------------------|--------|
| F3-ERR1 | Confirm with zero in-scope leaves | 400 `NO_PROCESSES`; inline "Add at least one process" | browser-verify |
| F3-ERR2 | Node at level 5, or leaf missing starting point / current system | 400 `MAX_DEPTH` / `MISSING_FIELD` with node `clientRef` | integration |
| F3-ERR3 | Delete a process that has any APPROVED document | 409 `PROCESS_HAS_APPROVED_DOCS`; delete menu item disabled with tooltip | integration + browser-verify |
| F3-ERR4 | Duplicate process code in the project | 409 `DUPLICATE_CODE`; inline on the node | integration |

**Known pitfalls:**
- Turning a leaf into a parent (adding a child) when it already has documents: block with 409 `PROCESS_HAS_DOCUMENTS` and explain.
- Tree save is one transaction; client refs map to server IDs in the response.

**Dependencies:** F2.
**Out of scope:** drag-and-drop reordering (up/down buttons only); importing a process tree from Excel (P2).

---

### F4 · As-Is capture & structuring — P0 · complexity: high

**User story:** As a consultant, I want to paste my workshop notes or upload documents and get a structured As-Is with a diagram and the questions I still need to ask, so I can validate the current process with the client quickly.

**Description:** Sources (pasted text, PDF, DOCX, XLSX, TXT) are stored per leaf process. The `as_is` stage turns them into actors, systems, ordered steps, pain points and follow-up questions. The swimlane diagram is generated by code from the steps. For EXISTING_SAP processes, steps also carry current SAP references and custom objects. The As-Is is editable inline with autosave.

**Journey context:**

| | |
|---|---|
| Serves journey steps | J1.6, J1.7, J5.1, J5.2, J5.5 |
| Entry point | Workspace next-step banner; As-Is stage chip; stage stepper |
| Preceded by | F3 (leaf exists) |
| On success, user lands at | Same page showing the draft; header CTA `[data-action="next-gap"]` "Next: Run gap analysis" (also `[data-action="send-for-review"]`, F8) |
| On cancel/abandon | Pasted text autosaved as a draft source; uploaded files kept |

**Routes & network:**

| Route | Method | Purpose | Expected status |
|-------|--------|---------|-----------------|
| `/projects/:id/processes/:pid/as-is` | GET | As-Is page | 200 |
| `/api/processes/:pid/source-draft` | PUT | Autosave pasted text | 200 |
| `/api/processes/:pid/sources` | POST | Add pasted text or file (multipart) | 201, 413, 415, 422 |
| `/api/sources/:sid` | DELETE | Remove a source | 204 |
| `/api/processes/:pid/as-is/generate` | POST | Start `as_is` job | 202, 409, 422 |
| `/api/documents/:docId` | GET, PATCH | Read; edit current draft (`{ revision, payload }`) | 200 / 200, 409, 423 |
| `/api/documents/:docId/apply-answers` | POST | Regenerate with answered questions | 202 |

**Happy path:**

1. Empty state: `[data-testid="source-paste"]`, file dropzone, `[data-action="structure-as-is"]` (disabled until input), link `[data-action="use-sample-notes"]`.
2. Click → pending paste saved as source (`POST …/sources` 201) → `POST …/as-is/generate` 202 → progress.
3. Draft renders: `[data-testid="as-is-steps"]` table, `[data-testid="process-diagram"] svg`, `[data-testid="pain-points"]`, `[data-testid="follow-up-questions"]`; As-Is chip = Draft.
4. Cell edits PATCH after 2 s debounce; the diagram re-renders from the edited steps.
5. Answering questions then `[data-action="apply-answers"]` → new draft version with answers used.

**Data out (AsIs payload):**

```json
{
  "schemaVersion": 1,
  "summary": "Orders arrive by email, are keyed into Excel, credit-checked by phone…",
  "actors": ["Customer service clerk", "Credit controller", "Warehouse supervisor"],
  "systems": ["Tally", "Excel order book", "Email"],
  "steps": [
    { "id": "AS-1", "seq": 1, "actor": "Customer service clerk", "system": "Email", "action": "Receives customer PO by email",
      "inputs": ["Customer PO (PDF)"], "outputs": [], "documents": ["Customer PO"], "controls": [], "volume": "~120 orders/day",
      "painPointIds": ["PP-1"], "sapRefs": [], "customObjects": [] }
  ],
  "painPoints": [{ "id": "PP-1", "text": "Orders re-keyed from email into Excel; ~3% entry errors", "severity": "HIGH", "sourceIds": ["src_01J9ZR"] }],
  "followUpQuestions": [{ "id": "Q-1", "question": "Who approves orders above the credit limit, and how?", "relatedStepId": "AS-4", "answer": null }],
  "inputTruncated": false
}
```

**AI behavior:** §6.0; prompt `prompts/as_is.*.md`; invariants: step IDs unique `AS-\d+` with contiguous `seq`; every `painPointIds` and `relatedStepId` resolves; every `sourceIds` entry is a source of this process; `sapRefs`/`customObjects` only for EXISTING_SAP. Golden set `evals/as-is/` (8 note sets incl. 2 EXISTING_SAP).

**Acceptance criteria:**

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| F4-AC1 | New leaf, As-Is page empty | Pastes FIX-9 notes, clicks `[data-action="structure-as-is"]` | `POST …/sources` 201, `POST …/as-is/generate` 202; progress shown; then steps table (≥ 1 row), diagram `svg`, pain points and questions render; chip Draft; zero console errors | browser-verify |
| F4-AC2 | Same page | Uploads FIX-9 `o2c-asis.docx` | `POST …/sources` 201 with `extractedChars > 0`; file listed by name; "Structure As-Is" enabled | browser-verify |
| F4-AC3 | FIX-5 As-Is Draft | Edits the action cell of AS-2 and blurs | `PATCH /api/documents/:docId` 200 within 3 s; reload shows the edit; diagram node text updated | browser-verify |
| F4-AC4 | FIX-5 with Q-1 open | Answers Q-1, clicks `[data-action="apply-answers"]` | 202; new version (v+1, Draft) whose payload has Q-1 answered and the answer reflected as input to the stage | integration |
| F4-AC5 | Every golden As-Is payload in `fixtures/ai/as_is/` | `toMermaidSwimlane(steps)` | Output parses with `mermaid.parse`; one lane per actor; nodes in `seq` order | unit |
| F4-AC6 | Stub golden output | Job completes | Payload validates `AsIsPayloadSchema` and all invariants above | integration |

**Error cases:**

| ID | Case | Expected behavior | Verify |
|----|------|-------------------|--------|
| F4-ERR1 | Unsupported type (e.g. .pptx) | 415 `UNSUPPORTED_FILE_TYPE`; inline under that file; other sources unaffected | browser-verify |
| F4-ERR2 | File > 20 MB, or > 10 sources | 413 `FILE_TOO_LARGE` / `TOO_MANY_SOURCES`; rejected client-side before upload when size is known | browser-verify |
| F4-ERR3 | Scanned PDF with no text layer | 422 `NO_EXTRACTABLE_TEXT`; message "This PDF has no text — paste the text or upload a DOCX" | integration |
| F4-ERR4 | Model output invalid twice (`as_is:invalid`) | Job FAILED `AI_INVALID_OUTPUT`; job error panel with retry; sources intact | browser-verify |
| F4-ERR5 | PATCH with an old `revision` (second tab) | 409 `VERSION_CONFLICT`; banner "Changed elsewhere — reload to see the latest" + `[data-action="reload-doc"]` | browser-verify |
| F4-ERR6 | PATCH on an APPROVED version | 423 `DOCUMENT_LOCKED`; UI read-only with `[data-action="new-version"]` (F8) | integration |

**Known pitfalls:**
- MIME-sniff uploads; never trust the extension alone.
- Extract text in the worker, not in the request; store extracted text with the source.
- Debounced autosave must flush on route change.
- Mermaid labels need escaping (quotes, brackets, `#`).

**Dependencies:** F3; object storage; AI provider.
**Out of scope:** OCR; audio transcription; editing the diagram directly.

---

### F5 · Gap analysis — P0 · complexity: high

**User story:** As a consultant, I want every requirement of the process classified against SAP standard with a resolution, so I can see what is configuration, what is process change and what needs development.

**Description:** The `gap` stage derives requirements from the As-Is (current capabilities that must continue), pain points, project objectives (wishes) and user-added items. Each requirement gets one assessment: FIT, PARTIAL_FIT or GAP, with standard coverage, SAP references, resolution type, RICEFW type when development is needed, complexity and rationale. Requirements of type WISH become the To-Be wish list (F6). For EXISTING_SAP processes, custom objects found in the As-Is get a disposition.

**Journey context:**

| | |
|---|---|
| Serves journey steps | J1.8, J5.1 |
| Entry point | As-Is header CTA `[data-action="next-gap"]`; Gap stage chip; stepper |
| Preceded by | F4 (As-Is exists, any status) |
| On success, user lands at | Same page; header CTA `[data-action="next-to-be"]` "Next: Design the To-Be" |
| On cancel/abandon | Job continues in the background; result visible on return |

**Routes & network:**

| Route | Method | Purpose | Expected status |
|-------|--------|---------|-----------------|
| `/projects/:id/processes/:pid/gap` | GET | Gap page | 200 |
| `/api/processes/:pid/gap/generate` | POST | Start `gap` job | 202, 409 |
| `/api/documents/:docId` | PATCH | Add/edit requirements, edit assessments | 200, 400, 409, 423 |
| `/api/documents/:docId/requirements/:reqId/reassess` | POST | Classify one requirement | 202 |

**Happy path:**

1. Empty state `[data-action="run-gap"]` → 202 → progress.
2. `[data-testid="gap-table"]` columns: Requirement · Type · Fit · Standard coverage · SAP refs · Resolution · RICEFW · Complexity · Priority; `[data-testid="fit-summary"]` counts; filter chips by fit status.
3. User adds a requirement via `[data-action="add-requirement"]` → row "Not assessed" → `[data-action="reassess"]` → row classified.

**Data out (Gap payload):**

```json
{
  "schemaVersion": 1,
  "requirements": [
    { "id": "R-1", "type": "CURRENT_CAPABILITY", "text": "Capture orders with customer-specific prices", "source": { "kind": "AS_IS_STEP", "refId": "AS-2" }, "priority": "MUST" },
    { "id": "R-6", "type": "WISH", "text": "Automatic credit check at order entry", "source": { "kind": "PAIN_POINT", "refId": "PP-3" }, "priority": "SHOULD" }
  ],
  "gaps": [
    { "id": "G-1", "requirementId": "R-1", "fitStatus": "FIT", "standardCoverage": "Standard sales order with condition-based pricing",
      "sapRefs": [{ "kind": "SCOPE_ITEM", "code": "BD9" }, { "kind": "TCODE", "code": "VA01" }],
      "resolutionType": "STANDARD", "ricefwType": null, "complexity": "LOW", "rationale": "…" },
    { "id": "G-3", "requirementId": "R-4", "fitStatus": "GAP", "standardCoverage": "No standard intake of e-mailed PDF orders",
      "sapRefs": [], "resolutionType": "DEVELOPMENT", "ricefwType": "INTERFACE", "complexity": "MEDIUM", "rationale": "…" }
  ],
  "customObjectDispositions": [],
  "openQuestions": [],
  "inputTruncated": false
}
```

Enums: `type` ∈ {CURRENT_CAPABILITY, WISH}; `source.kind` ∈ {AS_IS_STEP, PAIN_POINT, OBJECTIVE, USER}; `priority` ∈ {MUST, SHOULD, COULD, WONT}; `fitStatus` ∈ {FIT, PARTIAL_FIT, GAP}; `resolutionType` ∈ {STANDARD, CONFIGURATION, PROCESS_CHANGE, DEVELOPMENT, OUT_OF_SCOPE}; `ricefwType` ∈ {REPORT, INTERFACE, CONVERSION, ENHANCEMENT, FORM, WORKFLOW}; disposition ∈ {RETIRE, KEEP, REPLACE_WITH_STANDARD}.

**AI behavior:** §6.0; prompt `prompts/gap.*.md`; invariants: each requirement has 0 or 1 gap (0 only for USER requirements not yet assessed); FIT ⇒ resolution STANDARD or CONFIGURATION; resolution DEVELOPMENT ⇔ `ricefwType` set; every `source.refId` resolves in the referenced As-Is version or project objectives. Golden set `evals/gap/` (8 processes with consultant labels).

**Acceptance criteria:**

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| F5-AC1 | FIX-5 on `/…/gap` (empty) | Clicks `[data-action="run-gap"]` | `POST …/gap/generate` 202; progress; `[data-testid="gap-table"]` with ≥ 1 row and all columns; `[data-testid="fit-summary"]` totals equal row count; zero console errors | browser-verify |
| F5-AC2 | Payloads violating each invariant | Validator runs | Each violation reported with the offending ID; valid golden payloads pass | unit |
| F5-AC3 | Gap Draft | Adds requirement (WISH, SHOULD) via `[data-action="add-requirement"]`, then `[data-action="reassess"]` on it | PATCH 200; row shows "Not assessed"; reassess 202 → row classified; all other rows byte-identical | browser-verify |
| F5-AC4 | FIX-11 EXISTING_SAP leaf whose As-Is lists 2 custom objects | Gap job completes (stub) | `customObjectDispositions` has exactly 2 entries; section `[data-testid="custom-objects"]` renders them | integration |
| F5-AC5 | `evals/gap/`, real model | `pnpm eval:gap` | Schema validity 100% after ≤ 1 repair; DEVELOPMENT ⇔ RICEFW consistency 100%; fit-status agreement with labels ≥ 70% | manual |

**Error cases:**

| ID | Case | Expected behavior | Verify |
|----|------|-------------------|--------|
| F5-ERR1 | No As-Is document | Generate → 409 `UPSTREAM_NOT_READY`; page shows locked state "Capture the As-Is first" with link | browser-verify |
| F5-ERR2 | Job fails twice on validation | FAILED `AI_INVALID_OUTPUT`; retry available; no partial Gap saved | integration |
| F5-ERR3 | Approve with any "Not assessed" requirement | 409 `REQUIREMENTS_NOT_ASSESSED` listing IDs | integration |

**Known pitfalls:**
- Keep requirement IDs stable across regenerations where the source is unchanged, so trace links in later documents survive (match by `source` + normalised text).
- Large tables: virtualise rows above 200.

**Dependencies:** F4; F9 (reference chips).
**Out of scope:** effort estimation; cross-process gap deduplication (P2).

---

### F6 · To-Be design — P0 · complexity: high

**User story:** As a consultant, I want a To-Be design that maps the current process onto SAP best practice, covers the client's wish list, handles splits, consolidations and multi-entity rollout, and links every step back to the As-Is, so I can explain exactly how the process will be built in SAP.

**Description:** The `to_be` stage produces, per leaf process: (a) wish list — WISH requirements with priority and disposition; (b) SAP best-practice mapping; (c) process mapping — one or more To-Be processes, plus optional consolidation of other leaves; (d) replication across org units; (e) To-Be steps with SAP references and trace links; (f) a short build approach. Steps drive a deterministic diagram. A compare view shows As-Is and To-Be side by side with linked highlighting.

**Journey context:**

| | |
|---|---|
| Serves journey steps | J1.9, J2.5, J5.1 |
| Entry point | Gap header CTA `[data-action="next-to-be"]`; To-Be stage chip; stepper |
| Preceded by | F5 (Gap exists, any status) |
| On success, user lands at | Same page; header offers `[data-action="send-for-review"]` and, for LEAD, `[data-action="approve"]` (F8) |
| On cancel/abandon | Job continues; result visible on return |

**Routes & network:**

| Route | Method | Purpose | Expected status |
|-------|--------|---------|-----------------|
| `/projects/:id/processes/:pid/to-be` | GET | To-Be page (`?mode=review` for reviewers) | 200 |
| `/api/processes/:pid/to-be/generate` | POST | Start `to_be` job | 202, 409 |
| `/api/documents/:docId` | PATCH | Edit draft | 200, 400, 409, 423 |
| `/api/processes/:pid/consolidation` | PUT | Set leaves consolidated into this process (n:1) | 200, 400, 409 |

**Happy path:**

1. Empty state `[data-action="generate-to-be"]` → 202 → progress.
2. Sections render: `[data-testid="wishlist"]`, `[data-testid="best-practice-mapping"]`, `[data-testid="process-mapping"]` with badge `[data-testid="mapping-type"]` (1:1 / 1:n / n:1), `[data-testid="replication"]`, `[data-testid="to-be-steps"]` (each row with trace chips), `[data-testid="process-diagram"]`, `[data-testid="build-approach"]`.
3. `[data-action="toggle-compare"]` shows two columns; clicking a To-Be step highlights its traced As-Is steps; eliminated As-Is steps carry an "Eliminated" badge with reason.
4. Optional: `[data-action="consolidate-processes"]` picks other leaves to merge into this design.

**Data out (ToBe payload):**

```json
{
  "schemaVersion": 1,
  "toBeProcesses": [
    { "id": "TB-A", "name": "Sell from stock — standard sales order",
      "steps": [
        { "id": "TB-A-1", "seq": 1, "actor": "Internal sales representative", "action": "Create sales order from customer PO",
          "sapRefs": [{ "kind": "TCODE", "code": "VA01" }], "changeType": "MODIFIED",
          "traces": { "asIsStepIds": ["AS-1", "AS-2"], "requirementIds": ["R-1"], "gapIds": ["G-1"] } }
      ] }
  ],
  "eliminatedAsIsSteps": [{ "asIsStepId": "AS-4", "reason": "Phone credit check replaced by automatic credit check in TB-A-2" }],
  "wishlist": [{ "requirementId": "R-6", "priority": "SHOULD", "disposition": "ADDRESSED_BY_GAP_RESOLUTION", "gapId": "G-5" }],
  "bestPracticeMapping": [{ "ref": { "kind": "SCOPE_ITEM", "code": "BD9" }, "relevance": "Core flow for stock materials", "toBeProcessIds": ["TB-A"] }],
  "processMapping": { "consolidatedProcessIds": [], "rationale": "One legacy order flow maps to one SAP flow" },
  "replication": [
    { "orgUnitId": "ou_1000", "variant": "TEMPLATE", "localDifferences": [], "affectedStepIds": [] },
    { "orgUnitId": "ou_2000", "variant": "LOCAL_VARIANT", "localDifferences": ["Export documents required for all orders"], "affectedStepIds": ["TB-A-4"] }
  ],
  "buildApproach": "Standard configuration for TB-A; one interface (G-3) for e-mailed PDF orders.",
  "inputTruncated": false
}
```

Enums: `changeType` ∈ {UNCHANGED, MODIFIED, NEW}; `disposition` ∈ {ADDRESSED_BY_STANDARD, ADDRESSED_BY_GAP_RESOLUTION, DEFERRED, REJECTED}; `variant` ∈ {TEMPLATE, LOCAL_VARIANT}.

**Mapping type (derived, never stored from the model):** 1 To-Be process and no consolidation → ONE_TO_ONE; > 1 To-Be processes and no consolidation → ONE_TO_MANY; 1 To-Be process with consolidation → MANY_TO_ONE; > 1 To-Be processes with consolidation → rejected 400 `MAPPING_UNSUPPORTED` ("Split this design into separate processes").

**AI behavior:** §6.0; prompt `prompts/to_be.*.md`; input: approved-or-latest As-Is, Gap, project org units, consolidated leaves' As-Is, library candidates. Invariants (validator `validateToBe`): every As-Is step of this process and of every consolidated leaf is in ≥ 1 `traces.asIsStepIds` or in `eliminatedAsIsSteps` with a non-empty reason; every To-Be step has ≥ 1 trace; every trace ID exists in the referenced versions; every WISH requirement appears once in `wishlist`; `gapId` required when disposition is ADDRESSED_BY_GAP_RESOLUTION; replication lists every project org unit exactly once (empty array when the project has none); LOCAL_VARIANT has ≥ 1 local difference. Invariant failure after repair → FAILED `AI_TRACE_INVALID`. Golden set `evals/to-be/` (8 processes).

**Acceptance criteria:**

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| F6-AC1 | Gap Draft (FIX-5 + stub Gap) on `/…/to-be` | Clicks `[data-action="generate-to-be"]` | 202; progress; all section test IDs above render; mapping badge shows "1:1"; diagram `svg` present; zero console errors | browser-verify |
| F6-AC2 | Payloads violating each `validateToBe` invariant, plus golden payloads | Validator runs | Every violation reported with the offending ID; golden payloads pass; a stub returning a violating payload then a valid one yields 2 model calls and SUCCEEDED | unit + integration |
| F6-AC3 | To-Be Draft | Clicks `[data-action="toggle-compare"]`, then To-Be step TB-A-1 | Two columns render; As-Is rows AS-1 and AS-2 get `data-highlighted="true"`; AS-4 shows "Eliminated" with its reason | browser-verify |
| F6-AC4 | Combinations of To-Be process count and consolidation | `deriveMappingType()` | Returns ONE_TO_ONE / ONE_TO_MANY / MANY_TO_ONE, or throws `MAPPING_UNSUPPORTED`, per the rule above | unit |
| F6-AC5 | FIX-1 project with leaves O2C-01-01 and O2C-01-02 (both with As-Is) | On O2C-01-01 To-Be, selects O2C-01-02 in `[data-action="consolidate-processes"]` and saves | `PUT …/consolidation` 200; badge "n:1"; O2C-01-02's To-Be and Change doc chips read "Merged into O2C-01-01" and its To-Be page links there; `[data-testid="untraced-steps"]` lists O2C-01-02 As-Is steps not yet traced | browser-verify |
| F6-AC6 | Project with 2 plants (FIX-1) vs project with no org units | To-Be generated (stub) | Replication table lists both plants with variant chips; for the no-org-unit project the section reads "Single entity — no replication" with link `[data-action="edit-org-units"]` to scope | browser-verify |

**Error cases:**

| ID | Case | Expected behavior | Verify |
|----|------|-------------------|--------|
| F6-ERR1 | No Gap document | 409 `UPSTREAM_NOT_READY`; locked state "Run the gap analysis first" with link | browser-verify |
| F6-ERR2 | Trace invariants fail twice | FAILED `AI_TRACE_INVALID`; error panel "The draft didn't link every As-Is step. Retry, or adjust the Gap analysis." + retry | integration |
| F6-ERR3 | Consolidating a leaf that already has an APPROVED To-Be | 409 `PROCESS_HAS_APPROVED_DOCS`; leaf disabled in the picker with tooltip | integration |
| F6-ERR4 | Consolidation that would create a cycle (A into B, B into A) | 400 `CONSOLIDATION_CYCLE` | unit |

**Known pitfalls:**
- When a leaf is merged, its own To-Be/Change doc stages show "Merged" — the next-step rule (F3) must skip them.
- Trace chips must resolve against the exact upstream version stored on the To-Be version, not the latest As-Is.
- Compare view with 50+ steps: keep highlighting O(1) via an ID → row map.

**Dependencies:** F4, F5, F9; F3 org units.
**Out of scope:** many-to-many mapping; editing the diagram; choosing between alternative designs (one design per process in v1).

---

### F7 · Change of Process documentation — P0 · complexity: high

**User story:** As a consultant, I want one document per process that shows As-Is versus To-Be and everything technical needed to build the change, so the build team and the client sign off on the same thing.

**Description:** Generated only from **approved** As-Is, Gap and To-Be versions. Sections 1–3 are assembled by code from those versions; sections 4–8 are generated by the `change_doc` stage and editable.

| # | Section | Source |
|---|---------|--------|
| 1 | Process overview & mapping (type, consolidated leaves, org units) | Code |
| 2 | As-Is vs To-Be side by side (steps, eliminated steps, change type) | Code |
| 3 | Change list (one row per MODIFIED/NEW To-Be step and per eliminated As-Is step, with reason) | Code |
| 4 | Impacted roles & organisational change (role, impact, training need) | AI |
| 5 | Technical detail: 5.1 configuration (area, object, setting summary, refs) · 5.2 master data · 5.3 RICEFW objects with functional-spec outline · 5.4 integrations · 5.5 data migration objects · 5.6 roles & authorisations | AI |
| 6 | Risks (likelihood, impact, mitigation) | AI |
| 7 | Test scenarios (steps summary, expected result, covered To-Be steps and gaps) | AI |
| 8 | Open issues | AI + unresolved follow-up questions |

**Journey context:**

| | |
|---|---|
| Serves journey steps | J3.2, J3.3, J5.1 |
| Entry point | To-Be header CTA `[data-action="next-change-doc"]` once To-Be is approved; "To-Be approved" notification; stepper |
| Preceded by | F8 approvals of As-Is, Gap, To-Be |
| On success, user lands at | Same page; header `[data-action="approve"]` (LEAD) or `[data-action="send-for-review"]` |
| On cancel/abandon | Edits autosaved |

**Routes & network:**

| Route | Method | Purpose | Expected status |
|-------|--------|---------|-----------------|
| `/projects/:id/processes/:pid/change-doc` | GET | Change doc page | 200 |
| `/api/processes/:pid/change-doc/generate` | POST | Start `change_doc` job | 202, 409 |
| `/api/documents/:docId` | PATCH | Edit sections 4–8 | 200, 400, 409, 423 |

**Happy path:**

1. Locked state lists missing approvals until all three are approved; then `[data-action="generate-change-doc"]` → 202 → progress.
2. Document renders with `[data-testid="change-doc-toc"]` and sections `[data-testid="cd-section-1"]` … `cd-section-8`; header shows `[data-testid="unverified-count"]`.
3. Inline table edits autosave; reference chips can be verified, replaced or removed (F9).

**Data out (ChangeDoc payload, sections 4–8 excerpt):**

```json
{
  "schemaVersion": 1,
  "impactedRoles": [{ "role": "Customer service clerk", "impact": "Creates orders in SAP instead of Excel", "trainingNeed": "Sales order entry, 2 h" }],
  "configuration": [{ "area": "Sales", "object": "Sales document type", "settingSummary": "Standard order type with credit check active", "sapRefs": [] }],
  "masterData": [{ "object": "Business partner (customer)", "change": "Credit segment and limit per customer" }],
  "ricefwObjects": [
    { "id": "RW-1", "type": "INTERFACE", "gapId": "G-3", "title": "E-mailed PDF order intake", "complexity": "MEDIUM",
      "fsOutline": { "purpose": "…", "trigger": "…", "inputs": ["…"], "outputs": ["…"], "logic": "…", "errorHandling": "…" } }
  ],
  "integrations": [{ "source": "Customer e-mail inbox", "target": "SAP S/4HANA", "direction": "INBOUND", "method": "API", "frequency": "Near real time", "data": "Sales orders" }],
  "migrationObjects": [{ "object": "Open sales orders", "sourceSystem": "Excel order book", "approach": "Load via migration tooling", "volume": "~2,000" }],
  "rolesAndAuthorizations": [{ "businessRole": "Internal sales representative", "access": "Create/change sales orders; display credit status" }],
  "risks": [{ "id": "RK-1", "description": "Credit limits missing for 30% of customers", "likelihood": "HIGH", "impact": "MEDIUM", "mitigation": "Data cleansing before cut-over" }],
  "testScenarios": [{ "id": "TS-1", "title": "Order within credit limit", "steps": "…", "expected": "Order saved without block", "coversToBeStepIds": ["TB-A-1", "TB-A-2"], "coversGapIds": ["G-1"] }],
  "openIssues": [{ "id": "OI-1", "text": "Confirm approval route for orders above limit", "owner": null }]
}
```

**AI behavior:** §6.0; prompt `prompts/change_doc.*.md`; may be split per section group (DELEGATED). Invariants (`validateChangeDoc`): every gap with resolution DEVELOPMENT has ≥ 1 RICEFW object with that `gapId` and the same `ricefwType`; every gap with resolution other than OUT_OF_SCOPE is covered by ≥ 1 test scenario; every `coversToBeStepIds`/`coversGapIds` ID exists. Golden set `evals/change-doc/` (6 processes).

**Acceptance criteria:**

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| F7-AC1 | FIX-6 on `/…/change-doc` | Clicks `[data-action="generate-change-doc"]` | 202; progress; TOC and sections 1–8 render; zero console errors | browser-verify |
| F7-AC2 | FIX-6 | Change doc generated | Section 2 step rows equal the approved As-Is and To-Be payload steps exactly (IDs, text, order); the stage makes no model call for sections 1–3 (spy asserts) | integration |
| F7-AC3 | Payloads violating each `validateChangeDoc` invariant, plus golden payloads | Validator runs | Violations reported with IDs; golden payloads pass | unit |
| F7-AC4 | Change doc Draft | Edits RW-1 title inline and blurs | PATCH 200; reload shows the new title | browser-verify |
| F7-AC5 | FIX-6 | Change doc generated | Version stores `upstreamVersionIds` = the approved As-Is, Gap and To-Be version IDs | integration |

**Error cases:**

| ID | Case | Expected behavior | Verify |
|----|------|-------------------|--------|
| F7-ERR1 | Any upstream not approved, or stale | Page shows locked state listing each missing approval with its status and link; `POST …/generate` → 409 `UPSTREAM_NOT_APPROVED` | browser-verify |
| F7-ERR2 | Job fails twice | FAILED `AI_INVALID_OUTPUT`; retry; no partial document | integration |
| F7-ERR3 | Leaf merged into another process | Page shows "Merged into {process}" with link; `POST …/generate` → 409 `PROCESS_MERGED` | integration |

**Known pitfalls:**
- Sections 1–3 must re-render from the stored upstream version IDs, never from "latest".
- Large technical tables: keep each section independently editable so one PATCH doesn't overwrite another section edited in a second tab (revision check is per document — show the conflict banner).

**Dependencies:** F4–F6, F8, F9.
**Out of scope:** full functional/technical specs; effort estimates; test execution.

---

### F8 · Review, comments, approvals & versioning — P0 · complexity: high

**User story:** As a consultant, I want to send documents to the right person for approval, see their comments on specific steps, and keep approved versions locked, so the Blueprint is built only from what the client signed off.

**Description:** One state machine for all four document types, approver rules, review requests, decisions, comments anchored to items, notifications (in-app + email), immutable approved versions, version history, and staleness when an upstream document gets a newer version.

**State machine (binding):**

| From | Event | To | Who |
|------|-------|----|-----|
| NOT_STARTED | Generation succeeds | DRAFT | LEAD, CONSULTANT |
| DRAFT | Send for review | IN_REVIEW | LEAD, CONSULTANT |
| IN_REVIEW | Withdraw | DRAFT | LEAD, CONSULTANT |
| DRAFT or IN_REVIEW | Approve | APPROVED | Approver set (DRAFT → APPROVED: LEAD only) |
| IN_REVIEW | Request changes (reason required) | CHANGES_REQUESTED | Approver set |
| CHANGES_REQUESTED | Edit or regenerate | DRAFT | LEAD, CONSULTANT |
| APPROVED | New version | new version, DRAFT | LEAD |
| any | — | shown as **Stale** while any upstream document has a newer version than the one this version references | computed |
| Stale | Regenerate, or Keep & re-link | new version, DRAFT | LEAD, CONSULTANT |

**Approver set:** AS_IS and TO_BE → LEAD or the PROCESS_OWNER assigned to the process. GAP and CHANGE_DOC → LEAD only.
**Approval gating:** GAP needs As-Is APPROVED; TO_BE needs GAP APPROVED; CHANGE_DOC needs TO_BE APPROVED; none of them stale.
**Notifications:** REVIEW_REQUESTED → reviewer (email + in-app); DECISION_MADE → requester and LEAD (email + in-app); COMMENT_ADDED → document participants (in-app); BECAME_STALE → LEAD (in-app).

**Journey context:**

| | |
|---|---|
| Serves journey steps | J2.1, J2.3, J2.4, J2.5, J3.1, J3.4, J5.3, J5.5 |
| Entry point | Document header `[data-action="send-for-review"]` / `[data-action="approve"]`; top nav "Review" with badge; bell `[data-testid="notification-bell"]`; email links |
| Preceded by | F4–F7 (a draft exists) |
| On success, user lands at | Reviewer → back to `/review` with toast; LEAD approving → same document with header CTA for the next stage |
| On cancel/abandon | Review request stays open; queue keeps the card |

**Routes & network:**

| Route | Method | Purpose | Expected status |
|-------|--------|---------|-----------------|
| `/review` | GET | Review queue page | 200 |
| `/api/review-queue` | GET | Items awaiting the user's decision | 200 |
| `/api/documents/:docId/review-requests` | POST | `{ reviewerUserId }` or `{ inviteEmail }` | 201, 403, 409 |
| `/api/documents/:docId/withdraw-review` | POST | Back to DRAFT | 200, 409 |
| `/api/documents/:docId/decision` | POST | `{ decision: "APPROVE" \| "REQUEST_CHANGES", reason? }` | 200, 400, 403, 409 |
| `/api/documents/:docId/comments` | POST | `{ anchorItemId?, body }` | 201, 400 |
| `/api/comments/:cid` | PATCH | `{ resolved }` | 200, 403 |
| `/api/documents/:docId/new-version` | POST | New draft from an approved version | 201, 403, 409 |
| `/api/documents/:docId/stale-resolution` | POST | `{ action: "REGENERATE" \| "KEEP_AND_RELINK" }` | 202 / 201, 409 |
| `/api/documents/:docId/versions` | GET | Version history | 200 |
| `/api/notifications`, `/api/notifications/read` | GET, POST | Bell list; mark read | 200 |

**Happy path (review):** LEAD clicks `[data-action="send-for-review"]` → modal picks reviewer or invites by email → 201 → chip "In review" → reviewer opens card on `/review` → review mode with `[data-testid="decision-bar"]` → comments via `[data-action="comment-on-item"]` on a row → `[data-action="approve"]` or `[data-action="request-changes"]` (reason textarea) → 200 → toast → back to `/review`.

**Data in / out:**

```json
{ "decision": "REQUEST_CHANGES", "reason": "Step AS-4 is done by the regional manager, not the credit controller." }
```
```json
{ "documentId": "doc_01J9ZT", "versionId": "ver_01J9ZV", "versionNo": 1, "status": "CHANGES_REQUESTED", "decidedBy": "usr_…", "decidedAt": "2026-10-19T09:40:00Z" }
```

**Acceptance criteria:**

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| F8-AC1 | FIX-5 As-Is Draft; FIX-1 LEAD on the As-Is page | Clicks `[data-action="send-for-review"]`, picks FIX-2 owner, confirms | `POST …/review-requests` 201; chip "In review"; stub mailbox message to the owner with a link to `…/as-is?mode=review`; `GET /api/review-queue` as owner contains the item | browser-verify |
| F8-AC2 | Owner in review mode on that As-Is | Clicks `[data-action="approve"]` | `POST …/decision` 200; status APPROVED; a later PATCH returns 423; LEAD's bell count +1 and an email; audit entry `DOCUMENT_APPROVED` | browser-verify |
| F8-AC3 | Owner in review mode | Clicks `[data-action="request-changes"]` with a reason | 200; status CHANGES_REQUESTED; LEAD sees the reason in `[data-testid="changes-requested-banner"]`; LEAD's edit (PATCH 200) moves status to DRAFT; "Send for review" available again | browser-verify |
| F8-AC4 | Owner in review mode | Uses `[data-action="comment-on-item"]` on row AS-3 and posts | `POST …/comments` 201; comment marker on AS-3; LEAD sees the thread; resolving sets `resolved: true` and hides the marker | browser-verify |
| F8-AC5 | LEAD on a DRAFT As-Is with no review request | Clicks `[data-action="approve"]` | 200; APPROVED | integration |
| F8-AC6 | Matrix of document type × project role × assignment | `canDecide()` | Matches the approver set exactly; CONSULTANT never allowed | unit |
| F8-AC7 | FIX-6 (As-Is, Gap, To-Be approved) | LEAD clicks `[data-action="new-version"]` on the As-Is | `POST …/new-version` 201; As-Is v2 Draft; Gap and To-Be chips show Stale; To-Be page shows `[data-testid="stale-banner"]` "As-Is v1 → v2" with `[data-action="regenerate"]` and `[data-action="keep-and-relink"]` | browser-verify |
| F8-AC8 | State after F8-AC7 | `POST …/stale-resolution { KEEP_AND_RELINK }` on the Gap | 201; Gap v2 Draft with `upstreamVersionIds.asIs` = As-Is v2 and payload equal to v1; validator results shown for any new untraced As-Is steps | integration |
| F8-AC9 | Document with 3 versions | Clicks `[data-action="version-history"]`, selects v1 | List shows version, status, author, time; v1 opens read-only with a "Viewing v1" banner and a way back to latest | browser-verify |

**Error cases:**

| ID | Case | Expected behavior | Verify |
|----|------|-------------------|--------|
| F8-ERR1 | Non-approver posts a decision | 403 `FORBIDDEN`; decision buttons not rendered for them | integration |
| F8-ERR2 | Decision on a document not in DRAFT/IN_REVIEW | 409 `INVALID_STATE` | integration |
| F8-ERR3 | Approve To-Be while Gap not approved | 409 `UPSTREAM_NOT_APPROVED`; UI "Approve the Gap analysis first" with link | browser-verify |
| F8-ERR4 | Request changes without reason | 400 `MISSING_FIELD` `field: reason`; inline error | integration |
| F8-ERR5 | Two approvers decide at the same moment | Exactly one 200; the other 409 `INVALID_STATE` (row lock) | integration |
| F8-ERR6 | Email provider fails on a review request | Request still 201 with `emailSent: false`; banner "Email not sent — copy the review link" + `[data-action="copy-review-link"]` | browser-verify |
| F8-ERR7 | PATCH while IN_REVIEW | 409 `IN_REVIEW`; UI "Withdraw the review to edit" + `[data-action="withdraw-review"]` | integration |

**Known pitfalls:**
- Approvals and state changes in one transaction with `SELECT … FOR UPDATE` on the document row.
- Staleness is computed, not stored — compute it in one query for the workspace to avoid N+1.
- Email sending happens in the worker after commit, never inside the transaction.

**Dependencies:** F1 (invites), F4–F7.
**Out of scope:** multi-step or parallel approval chains; e-signatures; real-time presence.

---

### F9 · SAP reference library & verification — P0 · complexity: medium

**User story:** As a consultant, I want every SAP scope item, transaction, Fiori app or IMG activity in my documents checked against a library my team trusts, so I never present an invented SAP fact to a client.

**Description:** A library of `{ kind, code, title, module, targetProducts, summary }` entries: a global seed (read-only, maintained by us) plus org-owned entries. Documents store references as `{ kind, code, label? }`; a reference renders **Verified** when `(kind, code)` matches a library entry visible to the org (case-insensitive), otherwise amber **Unverified**. LEAD and ADMIN can verify (adds an org entry), replace or remove references. A selector picks the candidate entries sent to AI stages.

**Journey context:**

| | |
|---|---|
| Serves journey steps | J1.8, J1.9, J3.3 |
| Entry point | Reference chips in documents; `[data-testid="unverified-count"]` in document headers; top nav "Reference library" |
| Preceded by | Any document with references |
| On success, user lands at | Same document, chip now Verified, counter decremented |
| On cancel/abandon | Popover closes; nothing saved |

**Routes & network:**

| Route | Method | Purpose | Expected status |
|-------|--------|---------|-----------------|
| `/admin/reference-library` | GET | Library page | 200 |
| `/api/reference-library` | GET | Search `?q=&kind=&module=` | 200 |
| `/api/reference-library` | POST | Create org entry | 201, 400, 403, 409 |
| `/api/reference-library/:rid` | PATCH | Edit org entry | 200, 403 |
| `/api/reference-library/import` | POST | CSV import | 200, 400, 403 |

**Happy path (verify from a document):** click amber chip → popover with `[data-action="verify-ref"]`, `[data-action="replace-ref"]`, `[data-action="remove-ref"]` → verify opens a prefilled form (kind, code, title, module) → save → `POST /api/reference-library` 201 → every chip with the same kind + code in the org re-renders Verified. Replace and remove edit the draft payload (PATCH) and are hidden on approved versions.

**Data in:**

```json
{ "kind": "TCODE", "code": "VA01", "title": "Create Sales Order", "module": "SD", "targetProducts": ["S4HANA_ON_PREMISE", "S4HANA_CLOUD_PRIVATE"], "summary": "Consultant-written one-line summary." }
```
CSV headers (exact): `kind,code,title,module,targetProducts,summary` (`targetProducts` pipe-separated). `kind` ∈ {SCOPE_ITEM, TCODE, FIORI_APP, IMG_ACTIVITY, TABLE, BUSINESS_ROLE}.

**Data out (import):** `{ "created": 18, "skipped": 0, "errors": [{ "row": 7, "code": "INVALID_KIND" }, { "row": 12, "code": "DUPLICATE_REFERENCE" }] }`

**Acceptance criteria:**

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| F9-AC1 | Doc payload with refs: one in the global seed, one only in FIX-10's private library, one in no library | Rendered for FIX-1 | Seed ref Verified; the other two Unverified (other orgs' entries never verify) | integration |
| F9-AC2 | Gap or To-Be page with both kinds of refs | Page loads | Verified refs use `[data-testid="ref-chip-verified"]` with title tooltip; unverified use amber `[data-testid="ref-chip-unverified"]` labelled "Unverified"; header `[data-testid="unverified-count"]` equals the number of unverified chips | browser-verify |
| F9-AC3 | FIX-1 LEAD on a Change doc with an unverified ref | Clicks the chip → `[data-action="verify-ref"]` → saves | `POST /api/reference-library` 201; all chips with that kind + code in the project turn Verified; counter decrements; audit entry `REFERENCE_VERIFIED` | browser-verify |
| F9-AC4 | ADMIN on `/admin/reference-library` | Imports FIX-9 `library-import.csv` (20 rows, 2 invalid) | `POST …/import` 200 `{ created: 18, errors: [2 rows] }`; table shows the 18; result panel lists the 2 rows with reasons | browser-verify |
| F9-AC5 | Library with VA01 | Types "va01" in `[data-testid="library-search"]` | `GET /api/reference-library?q=va01` 200; VA01 row shown | browser-verify |
| F9-AC6 | Library of 300 entries across modules and two orgs | `selectCandidates(project)` | ≤ 50 entries; only the project's modules and target product; never another org's entries; same input → same output | unit |

**Error cases:**

| ID | Case | Expected behavior | Verify |
|----|------|-------------------|--------|
| F9-ERR1 | Duplicate kind + code in the org | 409 `DUPLICATE_REFERENCE` | integration |
| F9-ERR2 | CONSULTANT or PROCESS_OWNER creates an entry | 403 `FORBIDDEN`; verify action not rendered for them | integration |
| F9-ERR3 | CSV with wrong headers | 400 `INVALID_CSV_HEADERS` listing the expected headers; nothing imported | browser-verify |

**Known pitfalls:**
- Normalise codes (trim, uppercase) on write and lookup.
- Verification must also be applied at export time (F10), not cached in payloads.

**Dependencies:** F1 roles; seed file `seed/reference-library.csv`.
**Out of scope:** syncing with SAP's online catalogues; bundling SAP proprietary content; per-release version tracking of entries (P2).

---

### F10 · SAP Business Blueprint compile & export — P0 · complexity: high

**User story:** As the project lead, I want to compile every approved process design into one SAP Business Blueprint and export it as Word or PDF, so the client can review and sign it.

**Description:** The readiness checklist shows which in-scope leaves have an approved, non-stale Change doc. Generating creates an immutable Blueprint version that snapshots the included Change doc versions. Most content is aggregated by code; only three narratives come from the `blueprint_narrative` stage. Export runs in the worker. The Blueprint is marked **DRAFT** when any in-scope leaf is excluded or any unverified reference remains.

| # | Section | Source |
|---|---------|--------|
| 0 | Cover & document control (project, client, version, date, FINAL/DRAFT, version history) | Code |
| 1 | Executive summary | AI |
| 2 | Scope & objectives (objectives, in-scope tree) | Code |
| 3 | Organisational structure & replication | Code |
| 4 | Process designs — one subsection per included leaf: mapping type, To-Be steps, diagram, key changes, wish-list dispositions | Code |
| 5 | Cross-module integration (aggregated table + narrative) | Code + AI |
| 6 | Gap & RICEFW register | Code |
| 7 | Data migration approach (aggregated objects + narrative) | Code + AI |
| 8 | Roles & authorisations | Code |
| 9 | Traceability matrix (requirement → gap → To-Be step(s) → test scenario(s)) | Code |
| 10 | Risks, open issues & unverified references | Code |
| 11 | Processes not yet approved (excluded) | Code |
| 12 | Sign-off (name, role, signature, date lines for the LEAD and each process owner) | Code |

**Journey context:**

| | |
|---|---|
| Serves journey steps | J4.1, J4.2, J4.3, J5.1 |
| Entry point | Project sidebar "Blueprint"; workspace next-step banner |
| Preceded by | F7 + F8 (≥ 1 approved Change doc) |
| On success, user lands at | Preview of the new version with export buttons |
| On cancel/abandon | Jobs continue; versions and exports listed on return |

**Routes & network:**

| Route | Method | Purpose | Expected status |
|-------|--------|---------|-----------------|
| `/projects/:id/blueprint` | GET | Readiness, preview, versions | 200 |
| `/api/projects/:id/blueprint-readiness` | GET | Ready / blocked leaves | 200 |
| `/api/projects/:id/blueprints` | POST, GET | Generate version / list versions | 202, 403, 409 / 200 |
| `/api/blueprints/:bid` | GET | Version payload | 200 |
| `/api/blueprints/:bid/exports` | POST | `{ format: "DOCX" \| "PDF" }` | 202, 409 |
| `/api/exports/:eid` | GET | Export status | 200 |
| `/api/exports/:eid/download` | GET | 302 to a signed URL (5-min expiry) → file | 302 → 200 |

**Data out (Blueprint version, excerpt):**

```json
{
  "id": "bp_01J9ZX", "versionNo": 1, "status": "DRAFT",
  "includedChangeDocVersionIds": ["ver_01J9ZY", "ver_01J9ZZ"],
  "excludedProcessIds": ["prc_01J9ZQ5K"],
  "unverifiedRefCount": 1,
  "sections": { "executiveSummary": "…", "ricefwRegister": [{ "processCode": "O2C-01-01", "id": "RW-1", "type": "INTERFACE", "title": "E-mailed PDF order intake", "gapId": "G-3", "complexity": "MEDIUM" }] }
}
```
Cross-process IDs are qualified as `{processCode}:{itemId}` (e.g. `O2C-01-01:G-3`) wherever items from several processes share a table.

**Acceptance criteria:**

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| F10-AC1 | FIX-7 LEAD on `/projects/:id/blueprint` | Page loads, then clicks `[data-action="generate-blueprint"]` | `[data-testid="blueprint-readiness"]` shows 2 ready, 1 blocked with its blocking stage; `POST …/blueprints` 202; preview with TOC sections 0–12, version "v1" and DRAFT badge; zero console errors | browser-verify |
| F10-AC2 | FIX-7 Blueprint v1 | Payload inspected | RICEFW register rows = total RICEFW objects in the included Change doc versions; one traceability row per requirement → gap → To-Be step → test scenario chain; excluded leaf listed in section 11 | integration |
| F10-AC3 | Blueprint v1 preview | Clicks `[data-action="export-docx"]` | `POST …/exports` 202; status polled to SUCCEEDED; download 200 with DOCX content type; parsed text contains headings for sections 0–12 and one embedded image per included process diagram | browser-verify |
| F10-AC4 | Blueprint v1 | Exports PDF | Download 200 `application/pdf`; ≥ 1 page; "DRAFT" watermark text present | integration |
| F10-AC5 | Combinations of excluded leaves and unverified refs | `isDraft()` | true iff excluded > 0 or unverified > 0 | unit |
| F10-AC6 | Blueprint v1 exists | LEAD generates again after another approval | v2 created; v1 payload unchanged and still downloadable | integration |

**Error cases:**

| ID | Case | Expected behavior | Verify |
|----|------|-------------------|--------|
| F10-ERR1 | No approved Change doc | Generate button disabled with "Approve at least one Change of Process document"; `POST` → 409 `NO_APPROVED_PROCESSES` | browser-verify |
| F10-ERR2 | Export job fails | Export row "Failed" with `[data-action="retry-export"]`; no broken file offered | integration |
| F10-ERR3 | Non-LEAD generates or exports | 403 `FORBIDDEN`; buttons not rendered | integration |

**Known pitfalls:**
- Render Mermaid to PNG/SVG in the worker for DOCX/PDF; never ship raw Mermaid text into exports.
- Build DOCX headings with real heading styles so Word generates a table of contents.
- Generation reads Change doc versions by ID (snapshot), never "latest".

**Dependencies:** F7, F8, F9; object storage.
**Out of scope:** custom templates/branding per client (P1 candidate); e-signature; editing the Blueprint text directly (edit the source documents and regenerate).

---

### F11 · Program status overview — P1 · complexity: low

**User story:** As the project lead, I want one view of where every process stands, so I can chase the right reviews.
**Journey context:** J4.1 · entry: `/projects/:id` overview panel `[data-testid="status-overview"]` above the tree · lands: clicking a matrix cell opens that stage page.
**Contents:** counts per stage × status; process × stage matrix; RICEFW objects by type; unverified reference count; open review requests with age.

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| F11-AC1 | FIX-7 on `/projects/:id` | Page loads | Overview counts match `GET /api/projects/:id/overview`; matrix has one row per in-scope leaf | browser-verify |
| F11-AC2 | FIX-7 | Clicks a matrix cell | Navigates to that leaf's stage page | browser-verify |
| F11-ERR1 | Overview request fails | Panel shows "Couldn't load status" + retry; tree still renders | browser-verify |

---

### F12 · Demo project — P1 · complexity: low

**User story:** As a new consultant, I want to see a finished example before entering my own data, so I understand what the product produces.
**Journey context:** J1.2 alternate · entry: `/projects` empty-state link `[data-action="open-demo"]` · lands: `/projects/:id` of a read-only Order-to-Cash demo with a "Demo — read only" banner.
**Behaviour:** `POST /api/demo-project` 201 creates one read-only copy per org from `seed/demo-project.json` (FIX-12) (200 with the existing ID if already created). Every mutating route on it returns 403 `DEMO_READ_ONLY`.

| ID | Given | When | Then | Verify |
|----|-------|------|------|--------|
| F12-AC1 | Fresh account on `/projects` | Clicks `[data-action="open-demo"]` | `POST /api/demo-project` 201; URL `/projects/:id`; banner "Demo — read only"; all four stages Approved for its leaves; Blueprint preview available | browser-verify |
| F12-AC2 | Demo project | Any PATCH/POST on its documents | 403 `DEMO_READ_ONLY`; edit controls not rendered | integration |
| F12-ERR1 | Demo seed file invalid at boot | App logs a named error and hides the demo link; nothing else breaks | integration |

---

## 7. Data model

### Entities

| ID | Entity | Description | Key fields |
|----|--------|-------------|------------|
| E1 | Organization | Tenant (the consulting firm or client CoE using the product) | id, name, createdAt |
| E2 | User | A person with a login; belongs to exactly one org in v1 | id, orgId, email (unique, lowercase), name, passwordHash, orgRole (ADMIN \| MEMBER \| GUEST), createdAt |
| E3 | Project | One transformation programme for one client | id, orgId, name, clientName, problemStatement, targetProduct, startingLandscape, modules[], setupStatus (DRAFT \| SCOPE_PROPOSED \| ACTIVE), isDemo, createdBy |
| E4 | ProjectMembership | User's role in a project | projectId, userId, projectRole (LEAD \| CONSULTANT \| PROCESS_OWNER) |
| E5 | Invite | Pending invitation | id, orgId, projectId, email, projectRole, processIds[], tokenHash, expiresAt, acceptedAt, invitedBy |
| E6 | OrgUnit | Company code, plant, sales org or region in a project | id, projectId, type (COMPANY_CODE \| PLANT \| SALES_ORG \| REGION), code, name |
| E7 | ProcessNode | Node of the L1–L4 tree; leaves carry documents | id, projectId, parentId, level (1–4), code, name, module, inScope, startingPoint (NON_SAP \| EXISTING_SAP, leaves only), currentSystem, processOwnerUserId, consolidatedIntoProcessId |
| E8 | ProblemAnalysis | Output of the `problem_analysis` stage | id, projectId, payload (ProblemAnalysisSchema), jobId, createdAt |
| E9 | SourceInput | Pasted text or file for a leaf's As-Is | id, processId, kind (PASTED_TEXT \| FILE \| DRAFT_TEXT), fileName, mimeType, storageKey, extractedText, sizeBytes |
| E10 | Document | One per leaf × type | id, orgId, processId, type (AS_IS \| GAP \| TO_BE \| CHANGE_DOC), currentVersionId |
| E11 | DocumentVersion | Versioned payload with workflow status | id, documentId, versionNo, status (DRAFT \| IN_REVIEW \| CHANGES_REQUESTED \| APPROVED), revision, payload, upstreamVersionIds { asIs?, gap?, toBe? }, createdBy, approvedBy, approvedAt, generatedByJobId |
| E12 | ReviewRequest | Request for a decision | id, documentVersionId, reviewerUserId, requestedBy, status (OPEN \| DECIDED \| WITHDRAWN), decision, reason, decidedAt |
| E13 | Comment | Comment on a version, optionally anchored to an item ID | id, documentVersionId, anchorItemId, authorId, body, resolved, createdAt |
| E14 | Notification | In-app notification | id, userId, kind, payload, readAt, createdAt |
| E15 | SapReference | Library entry; `orgId` null = global seed | id, orgId, kind, code (uppercase), title, module, targetProducts[], summary, sourceNote, createdBy |
| E16 | Job | Background job record | id, orgId, kind, status, progressLabel, attempts, error { code, message }, result, createdAt, finishedAt |
| E17 | Blueprint | Immutable Blueprint version | id, projectId, versionNo, status (FINAL \| DRAFT), payload, includedChangeDocVersionIds[], excludedProcessIds[], unverifiedRefCount, createdBy |
| E18 | Export | File generated from a Blueprint version | id, blueprintId, format (DOCX \| PDF), status, storageKey, error |
| E19 | AuditLog | Append-only record of sensitive actions | id, orgId, actorUserId, action, entityType, entityId, metadata, at |

### Relationships

- E1 has many E2, E3, E15 (org entries), E19.
- E3 has many E4, E5, E6, E7, E8, E17. E7 is a tree via `parentId`.
- A leaf E7 has 0–1 E10 per type; E10 has many E11; E11 has many E12 and E13.
- E17 has many E18. E16 is referenced by E8, E11 and E18.

### Example record (DocumentVersion)

```json
{
  "id": "ver_01J9ZV",
  "documentId": "doc_01J9ZT",
  "versionNo": 2,
  "status": "DRAFT",
  "revision": 5,
  "payload": { "schemaVersion": 1, "toBeProcesses": [], "eliminatedAsIsSteps": [], "wishlist": [], "bestPracticeMapping": [], "processMapping": { "consolidatedProcessIds": [], "rationale": "" }, "replication": [], "buildApproach": "", "inputTruncated": false },
  "upstreamVersionIds": { "asIs": "ver_01J9ZM", "gap": "ver_01J9ZP" },
  "createdBy": "usr_01J9ZA",
  "approvedBy": null,
  "approvedAt": null,
  "generatedByJobId": "job_01J9ZU"
}
```

### Constraints & invariants

- Every tenant-owned row is reachable from exactly one `orgId`; no query crosses orgs.
- APPROVED versions are immutable (payload, revision, upstreamVersionIds).
- Documents exist only on leaves; a leaf with `consolidatedIntoProcessId` has no TO_BE or CHANGE_DOC of its own.
- A version is **stale** iff some upstream document's latest version ID differs from the ID stored in its `upstreamVersionIds` (As-Is → Gap → To-Be → Change doc).
- At most one RUNNING job per (process, stage).
- A Blueprint version references only APPROVED, non-stale Change doc versions at generation time.
- Item IDs are unique within a payload and stable across regenerations where the source is unchanged.

---

## 8. External integrations

| Service | Purpose | Auth | Env vars | Rate limits | On failure |
|---------|---------|------|----------|-------------|-----------|
| Anthropic API (Claude) | All AI stages (§6.0) | API key | ENV-4–ENV-9 | Account limits; app caps concurrency with ENV-8 | Retries per §6.0, then job FAILED with retry in UI |
| Transactional email (Resend proposed) | Invites, review requests, decisions | API key | ENV-10–ENV-12 | Provider limits | Action still succeeds; `emailSent: false`; copy-link fallback in UI |
| S3-compatible object storage | Uploads, diagram images, exports | Access key pair | ENV-13–ENV-17 | — | Upload or export returns 503 `STORAGE_UNAVAILABLE`; retry-safe |

---

## 9. Environment & configuration

| ID | Variable | Purpose | Source | If missing |
|----|----------|---------|--------|-----------|
| ENV-1 | `DATABASE_URL` | Postgres connection | DB host | Refuse to boot with named error |
| ENV-2 | `APP_URL` | Absolute links in emails and invites | Deployment | Refuse to boot |
| ENV-3 | `AUTH_SECRET` | Session signing | Generated per environment | Refuse to boot |
| ENV-4 | `AI_PROVIDER` | `anthropic` or `stub` | Config | Refuse to boot |
| ENV-5 | `ANTHROPIC_API_KEY` | Model access | Anthropic Console | Refuse to boot when ENV-4 = `anthropic` |
| ENV-6 | `AI_MODEL` | Model ID | Config | Default `claude-sonnet-5-5` |
| ENV-7 | `AI_MAX_INPUT_TOKENS` | Cap on source text per stage | Config | Default 60000 |
| ENV-8 | `AI_MAX_CONCURRENCY` | Parallel AI jobs per worker | Config | Default 4 |
| ENV-9 | `AI_FAULT_INJECTION` | Test-only failure simulation | Test config | Off; ignored in production |
| ENV-10 | `EMAIL_PROVIDER` | `resend` or `stub` | Config | Refuse to boot |
| ENV-11 | `EMAIL_API_KEY` | Email provider key | Provider dashboard | Refuse to boot when ENV-10 = `resend` |
| ENV-12 | `EMAIL_FROM` | Sender address | Config | Refuse to boot |
| ENV-13 | `S3_ENDPOINT` | Storage endpoint | Storage provider | Refuse to boot |
| ENV-14 | `S3_REGION` | Storage region | Storage provider | Refuse to boot |
| ENV-15 | `S3_BUCKET` | Bucket name | Storage provider | Refuse to boot |
| ENV-16 | `S3_ACCESS_KEY_ID` | Storage credentials | Storage provider | Refuse to boot |
| ENV-17 | `S3_SECRET_ACCESS_KEY` | Storage credentials | Storage provider | Refuse to boot |

**Rule:** the app validates all variables at startup (one Zod schema) and fails fast with the variable name; no silent production defaults. Local development and CI use `AI_PROVIDER=stub`, `EMAIL_PROVIDER=stub` and a local S3-compatible container.

---

## 10. Test fixtures & seed data

| ID | Fixture | Contents | Used by |
|----|---------|----------|---------|
| FIX-1 | Main org & project | Org "Acme Consulting"; `lead@test.local` (ADMIN, LEAD); project "Acme O2C Transformation" ACTIVE, S4HANA_CLOUD_PRIVATE, NON_SAP, plants 1000 and 2000; tree O2C → O2C-01 → leaves O2C-01-01 "Standard sales order" and O2C-01-02 "Phone orders" (both with As-Is Draft) and O2C-01-03 "Returns" (no documents) | F1, F3, F6, F8, F9 ACs |
| FIX-2 | Process owner | `owner@test.local`, org GUEST, PROCESS_OWNER on FIX-1 assigned to O2C-01-01 | F8 ACs |
| FIX-3 | **Fresh account** | No user; tests sign up as `fresh+{runId}@test.local`. `pnpm db:seed --fixture=FIX-3` can also create a logged-in user with an org and zero projects | All J-ACs, F1-AC1, F2-AC1 |
| FIX-4 | Scope pending | Project "Scope Pending" in SCOPE_PROPOSED with a stored ProblemAnalysis of 7 proposed nodes | F3-AC1 |
| FIX-5 | As-Is draft | O2C-01-01 As-Is v1 Draft: steps AS-1…AS-8, 3 pain points, Q-1 open | F4, F5, F6, F8 ACs |
| FIX-6 | Approved chain | O2C-01-01 with As-Is, Gap (incl. G-3 DEVELOPMENT/INTERFACE) and To-Be approved (v1 each) | F7, F8-AC7, F8-AC8 |
| FIX-7 | Blueprint-ready project | Project "Blueprint Ready": 3 leaves — 2 with approved Change docs (3 RICEFW objects in total; 1 unverified ref `TCODE ZZ_CUSTOM`), 1 with To-Be in review | F10, F11 |
| FIX-8 | AI stub outputs | `fixtures/ai/<stage>/default.json` and `invalid.json` per stage; IDs from the input (`$SOURCE_ID_0`, `$AS_IS_STEP_IDS`, …) are filled in by the stub at run time; references use seeded library codes only | All AI ACs, all J-ACs |
| FIX-9 | Sample inputs | `fixtures/inputs/problem-statement-o2c.txt`, `o2c-workshop-notes.txt`, `o2c-asis.docx`, `scanned-no-text.pdf`, `library-import.csv` (20 rows, 2 invalid); oversize file generated at test time | F2, F4, F9, J1-AC1 |
| FIX-10 | Other tenant | Org "Other Co" with a project, documents, a Blueprint, an export, and private library entry `TCODE ZOTHER` | F1-AC5, F9-AC1 |
| FIX-11 | Existing-SAP leaf | EXISTING_SAP leaf whose As-Is lists 2 custom objects | F5-AC4 |
| FIX-12 | Demo seed | `seed/demo-project.json` — fully approved O2C demo with one Blueprint version | F12 |
| FIX-13 | Stub mailbox | With `EMAIL_PROVIDER=stub`, messages are stored and readable at `GET /api/test/mailbox?to=` (route exists only when `NODE_ENV=test`) | F1-AC3, F8-AC1, J2-AC1 |

**Seed commands:** `pnpm db:seed` (reference library seed from `seed/reference-library.csv` + FIX-1, FIX-2, FIX-10), `pnpm db:seed --fixture=<FIX-n>` for the rest. Idempotent; `pnpm db:reset` returns to a known state.

---

## 11. Non-functional requirements

### Performance
- Non-AI pages and API: p95 server time ≤ 500 ms at 50 concurrent users; workspace with 80 leaves renders in ≤ 2 s.
- AI stages: p95 targets in §6.0; hard timeout 300 s.
- Exports: DOCX or PDF for a 30-process Blueprint in ≤ 60 s.

### Security & auth
- httpOnly, Secure, SameSite=Lax session cookies; passwords hashed with argon2id (or bcrypt cost ≥ 12).
- Project-role checks on every route (F8 matrix); tenant isolation per §4.
- Uploads MIME-sniffed; downloads only via signed URLs with 5-minute expiry.
- Audit log entries for: invite created/accepted, review requested, approved, changes requested, version created, reference verified, Blueprint generated, export created.
- Secrets only in environment variables; never logged.

### Confidentiality
- Client material is often under NDA: no cross-tenant data in prompts, logs or exports; prompt/output text never in application logs.
- Deleting a project hard-deletes its sources, documents and exports within 30 days (job), and immediately hides them.
- Whether client documents may be sent to the model provider under client NDAs: TODO-3.

### Compliance
- GDPR baseline: EU hosting (TODO-2), data export and deletion handled on request by the operator in v1.

### Accessibility
- WCAG 2.1 AA for J1–J4 surfaces; decision bar, tables and chip popovers fully keyboard-operable; status never conveyed by colour alone (chips carry text).

### Observability
- Structured logs with `requestId`, `orgId`, `jobId`.
- Product events: `signup`, `project_created`, `scope_confirmed`, `as_is_generated`, `gap_generated`, `to_be_generated` (activation), `review_requested`, `document_approved`, `change_doc_approved`, `blueprint_generated`, `blueprint_exported`.
- Per-job AI metrics: tokens, latency, attempts, validation failures.

### Browser support
- Latest Chrome, Edge, Firefox, Safari; desktop ≥ 1280 px primary, ≥ 1024 px usable.

---

## 12. Success metrics & launch criteria

### Launch criteria (v1 is "done" when)

- [ ] All P0 ACs pass at their tagged verification layer
- [ ] All `browser-verify` ACs return PASS from the `browser-verifier` subagent
- [ ] **All J-ACs pass against a fresh account (FIX-3)**, including the chained J1 → J2 → J3 → J4 → J5-AC2 suite
- [ ] Every P0 feature appears in §2.7 with a real entry point — zero orphans
- [ ] Every surface in §2.5 has its empty, loading and error states implemented
- [ ] F1-AC5 cross-tenant suite passes on every tenant-scoped route
- [ ] Eval suites F2-AC4, F5-AC5 and the To-Be / Change doc golden sets meet their thresholds with the production model
- [ ] `production-readiness` verdict is SHIP or SHIP-WITH-FIXES

### Post-launch metrics

| Metric | Target | Measured how |
|--------|--------|--------------|
| Activation rate — new orgs reaching the first To-Be draft | ≥ 50% within the first session | `to_be_generated` with `firstForOrg=true` |
| Time to activation | p50 ≤ 15 min from signup | Event timestamps |
| Design throughput | Median ≤ 2 working days from As-Is draft to approved Change doc per process | Version timestamps |
| Draft quality | ≥ 60% of AI-generated To-Be steps approved without edit | Diff between generated and approved versions |
| Reference hygiene | Unverified references per approved Change doc trending to 0 | F9 counts at approval |
| Consultant value (qualitative) | 3 of 5 pilot consultants say it saved at least half their documentation time | Pilot interviews |

---

## 13. Glossary

| Term | Definition |
|------|-----------|
| Organization (org) | The tenant using the product — usually a consulting firm or a client's SAP CoE. **Not** the client company being transformed. |
| Client | The company being transformed; a text field on the project, not a tenant. |
| Project | One transformation programme for one client inside an org. |
| Process / process node | A node of the L1–L4 hierarchy (L1 end-to-end, e.g. Order to Cash; L4 most detailed). |
| Leaf process | A process node without children; the unit that gets documents. |
| Starting point | Whether a leaf currently runs outside SAP (NON_SAP) or in SAP (EXISTING_SAP). |
| Stage | One of As-Is, Gap analysis, To-Be, Change of Process doc for a leaf. |
| Document / version | A Document is one stage of one leaf; it has numbered versions. Status belongs to a version. |
| As-Is | How the process works today: actors, systems, steps, pain points. |
| Requirement | Something the To-Be must do: CURRENT_CAPABILITY (must continue from the As-Is) or WISH (an improvement the business wants). |
| Wish list | The WISH requirements, with priority and how the To-Be addresses each. |
| Gap analysis | Assessment of each requirement against SAP standard: FIT, PARTIAL_FIT or GAP, with a resolution. |
| RICEFW | Development object types: Report, Interface, Conversion, Enhancement, Form, Workflow. |
| SAP best practice / scope item | SAP's predefined standard process content, identified by a scope item code (e.g. BD9). Stored only as library references. |
| SAP reference | `{ kind, code }` pointer to a scope item, transaction, Fiori app, IMG activity, table or business role. |
| Verified / Unverified | Whether a reference's kind + code exists in the library visible to the org. |
| Process mapping | How a leaf's As-Is maps to To-Be: 1:1 (one to one), 1:n (one split into several), n:1 (several consolidated into one). |
| Consolidation / merged | n:1 case: other leaves' As-Is are designed inside this leaf's To-Be; those leaves show "Merged". |
| Org unit | Company code, plant, sales org or region in scope. |
| Replication | Rolling one To-Be design out to several org units: TEMPLATE (as designed) or LOCAL_VARIANT (with listed differences). |
| Change of Process doc (change doc) | Per-leaf merge of the approved As-Is and To-Be plus technical detail. |
| SAP Business Blueprint | Final project document compiled from approved change docs. |
| Stale | A version built on an upstream version that has since been superseded. |
| Approver set | Roles allowed to approve a document type (F8). |
| Activation moment | First To-Be draft for a user-created process (§2.3). |
| Item ID | ID of a row inside a payload (AS-1, R-1, G-1, TB-A-1, RW-1, TS-1); qualified as `{processCode}:{itemId}` across processes. |

---

## 14. Open questions & assumptions register

### Open questions (agent must NOT resolve these)

- [ ] **TODO-1:** AI cost budget per process for all four stages — needed to choose between models per stage. Until answered, use ENV-6 for every stage and log token usage.
- [ ] **TODO-2:** Data residency — must client data for Indian clients be hosted in India and EU clients in the EU? Blocks production hosting choice (not M0–M3).
- [ ] **TODO-3:** Contractual stance on sending client documents to the model provider under client NDAs (standard API terms vs a dedicated or cloud-provider deployment). Blocks onboarding the first real client.
- [ ] **TODO-4:** Should S/4HANA Cloud projects also show SAP Activate wording ("Fit-to-Standard") next to "Gap analysis"? Until answered, use the labels in this PRD.

### Assumptions register

| # | Assumption | Confidence | Impact if wrong |
|---|-----------|------------|-----------------|
| 1 | ASSUMPTION(med): The journeys in §2 — consultant-led setup, activation at the first To-Be draft, process owners approving As-Is and To-Be from an email-driven review queue | med | Navigation, first-run and milestone order change |
| 2 | ASSUMPTION(med): "Replication" means rolling one To-Be across org units with local variants, not data replication | med | F6 replication section and Blueprint section 3 redesigned |
| 3 | ASSUMPTION(med): n:1 consolidation is needed alongside 1:1 and 1:n; many-to-many is out of scope | med | F6 mapping model and merged-leaf handling |
| 4 | ASSUMPTION(med): The wish list is the set of WISH requirements created at the Gap stage and dispositioned in the To-Be | med | F5/F6 payloads and traceability |
| 5 | ASSUMPTION(med): Approver rules — As-Is and To-Be by LEAD or assigned process owner; Gap and Change doc by LEAD only; LEAD may approve without a review request | med | F8 matrix and J2 |
| 6 | ASSUMPTION(med): Generation needs only an upstream draft; approval needs upstream approval; Change doc generation needs all upstream approved | med | Speed to activation vs rigour |
| 7 | ASSUMPTION(med): The Blueprint can be generated with partial scope, marked DRAFT when leaves are excluded or references are unverified | med | F10 rules |
| 8 | ASSUMPTION(high): Documents attach to leaf processes only | high | Data model |
| 9 | ASSUMPTION(high): Diagrams are generated by code from steps; no diagram editor | high | F4/F6 |
| 10 | ASSUMPTION(med): One org per user in v1; process owners join as org GUESTs | med | Process owners working with two consulting firms are blocked (F1-ERR8) |
| 11 | ASSUMPTION(med): The founding team curates the global reference-library seed before first client use | med | Many references stay Unverified at launch |
| 12 | ASSUMPTION(high): Stack in §4 (Next.js, Postgres, pg-boss, Claude) | high | Rework of M0 |
| 13 | ASSUMPTION(high): English only, desktop-first | high | i18n and layout work |
| 14 | ASSUMPTION(med): Password reset by email is P1; in v1 an operator resets passwords with `pnpm user:reset-password` | med | Support load |
| 15 | ASSUMPTION(med): Working product name "AI SAP Program Manager", slug `sap-pm` | med | Rename only |

---

## Appendix A — References

- Founder brief: "AI SAP Program Manager" prompt (conversation of 2026-10-19) — source of the LOCKED product decisions in §4.
- Background: SAP's older ASAP methodology names the design deliverable "Business Blueprint"; the current SAP Activate methodology runs Fit-to-Standard workshops in its Explore phase (see TODO-4).

## Appendix B — Changelog

| Version | Date | Author | Change |
|---------|------|--------|--------|
| v1 | 2026-10-19 | human + Claude | Initial draft from the founder brief |
