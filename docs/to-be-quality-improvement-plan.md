# To-Be quality improvement plan

Date: 2026-10-21  
Status: execution in progress, see Progress 2026-10-21 (latest reviewer score 78.75/100, v12); user approved all pending implementation phases on 2026-10-21 and waived further phase-approval gates  
Objective: build and test the consultant discovery and design system; improve the rental To-Be draft from the current 6/10 assessment to an evidence-backed rating of at least 9/10, then apply the proven approach to the other process variants.

## Outcome and scope

The target is a detailed, internally consistent, evidence-backed design that a business owner and SAP consultant can review. The user specified a measured review target of at least 9/10 on 2026-10-21. This is a reviewer assessment against the retained rubric, not a promised accuracy percentage or a substitute for business-owner/SAP deployment sign-off. Scores must follow evidence, rather than drive cosmetic changes to the rubric.

Complete the rental variant first. Extend to product, service and rigging only after the rental acceptance gates pass. Preserve variant-specific rules instead of applying the rental design indiscriminately. This plan documents quality work; it does not claim a live To-Be or blueprint deployment.

## Verified starting point

Baseline (superseded by the Progress 2026-10-21 section; kept as the starting reference). The initial October 21 rental evaluation contained:

| Item | Baseline |
| --- | --- |
| Source inventory | 35 exact source cells and 94 bullet units |
| Requirements and current steps | 86 candidate requirements and 12 As-Is steps |
| Generated design | 41 steps, 170 rules and 82 acceptance-test specifications |
| Traceability | All 86 requirements have dispositions; full structural/trace validation passes |
| Semantic review | Nine high and eight medium findings remain; corrections are not applied |
| Outstanding questions | 70 generated questions, with overlap, plus six retained input questions |
| SAP applicability | All 41 steps remain NEEDS_VALIDATION; target edition/release is unconfirmed |
| Rating | Reviewer judgment: 62/100, rounded to 6/10 (baseline only; later rounds below) |

The 82 scenarios are written specifications, not executed SAP tests. Complete traceability does not establish business correctness.

Local evidence: [quality audit](../test-results/rental-reference/review.md), [generation results](../test-results/rental-reference/output.json), [source inventory](../test-results/rental-reference/input.json), and [review checklist](../test-results/rental-reference/quality-checklist.md). These files are intentionally ignored by Git, so their links require the local evaluation workspace. Keep customer source content and credentials out of repository fixtures.

The existing [quality contract](to-be-quality.md) describes the original contract and delivery roadmap. This plan adds the remediation and acceptance work informed by actual generated results.

## Progress 2026-10-21

Customer target confirmed by the user: SAP S/4HANA 2023 private/on-prem, FPS level (resolves IQ-RELEASE). Scores below are separate reviewer judgments on the unchanged rubric, not controlled measurements; evidence is in `test-results/rental-reference/vN/` and `vN/review/` (GPT-6-Sol, read-only, independent).

| Run | Score /100 | What the round changed |
| --- | --- | --- |
| baseline | 62 | Original generation. |
| v6 | 69 | Regeneration with extended validator and revised prompt (see `v6/` diff report for specifics). |
| v8 | 71 | Further rounds; per-round changes are in the diff reports. |
| v9 | 74 | Further rounds; per-round changes are in the diff reports. |
| v10 | 75.75 | Bounded repair round against reviewer findings. |
| v11 | 77.75 | Bounded repair round. |
| v12 | 78.75 | Bounded repair round; diminishing returns. |

Cumulative changes across v6-v9 (not attributed per round here): validator extensions (fit-type consistency, `LICENSE_ENTITLEMENT` blocker, `decisionIds` / `UNKNOWN_DECISION`, CONDITIONAL coverage, located repair errors), prompt revisions (kind ladder, mechanism choice, decision linking, conditional semantics, no assumed outcomes) and the trusted SAP 2023 reference catalog. Consult each `vN/` diff report for exact per-round deltas.

Supporting capability built the same day (all uncommitted): consultant HTTP boundary, chat workspace UI, To-Be report page with Markdown/CSV export, worker SAP-catalog startup check, trusted reference loader and curated catalog (73 entries, 65 VERIFIED against rendered help.sap.com 2023 pages), tenant row-lock fix (locks only on the privileged worker connection). Last reported: typecheck and lint clean, `pnpm test` 258 passed / 73 skipped, build OK, DB suites 46/46, browser synthetic 28/28. Re-verify before relying on these.

Ceiling and decision: the reviewer's document-only ceiling is 83-84. At least 90 requires executing the named scenarios in an SAP 2023 system and approved business decisions. The user chose to push the document to its ceiling and deliver with explicit gates. The 9/10 acceptance gate is therefore **not met**.

Open: V12-1..9 (three HIGH: credit notification polling misses transitions; freight assignment retry identity; re-issue after credit contradicts two earlier billing rules) plus PARTIALs, listed in `test-results/rental-reference/v12/review/gpt-6-sol-review.last.md`. Next: user decisions on the 42-topic register; SAP sandbox execution; licence entitlement (TM, ARM, event enablement); fix V12 findings if continuing; extend to product/service/rigging only after rental acceptance; hosted subscription-auth path and production migration/deploy remain undone. Deliverable renderer: `test-results/rental-reference/deliverable/render.mts` (gitignored, confidential output).

## Model and review responsibilities

- **Generation:** Claude Sonnet 5.5 through the verified Anthropic subscription authentication path in the official Claude Code CLI for local evaluation.
- **Delegated review:** GPT-6-Sol, following the user's instruction to replace GPT-6-Luna for future delegated tasks and reviews.
- **Final technical acceptance:** the primary coding agent checks evidence and reconciles reviewer findings. A second model's agreement is not proof of correctness.
- **Business decisions and SAP sign-off:** the relevant business owners and SAP consultant approve policies and applicability. A generated answer cannot approve its own decisions.

Record the actual model, input revision, prompt revision, authentication mode, attempts and validation results for each run. Store no token values. The hosted application's API authentication is unchanged; any production integration is separate implementation work.

## Required product workflow — consultant-led discovery

User direction, 2026-10-21: the tool must understand the problem, provide a detailed As-Is template, ask relevant follow-up questions as an SAP consultant would, and only then generate the To-Be. The primary experience should be a chatbot that investigates pain points deeply. This is an upstream quality requirement, not an optional questionnaire after generation.

1. **Understand the problem.** Start with the user's plain-language problem and reuse existing project context. Establish business objective, process boundaries, organization/locations, systems, process owner and target SAP landscape. Ask only for missing or ambiguous information.
2. **Capture the As-Is.** Guide the user through a reusable template, one process variant at a time. Explain each field and accept an explicit unknown or justified not-applicable answer. Support existing documents as evidence and distinguish them from newly entered user statements.
3. **Investigate gaps.** Ask small, prioritized batches of questions tied to the selected process characteristics and actual missing fields, contradictions or dependencies. Explain why each answer matters. Answered facts should not be asked again unless the underlying context changes.
4. **Confirm understanding.** Present the current process, pain points, requirements, confirmed answers, contradictions and remaining decisions for user correction and confirmation. Preserve who supplied each answer and the input revision; an edit invalidates stale confirmation.
5. **Generate the To-Be.** Use the confirmed input revision and answers. Enforce readiness on the server. Missing critical information triggers a focused follow-up; explicitly unresolved implementation details remain visible and prevent unsupported consultant-grade/sign-off claims. User confirmation does not establish verified SAP capability.

### Conversational workspace

Use a chat beside a live, editable As-Is summary; on small screens make both accessible through tabs. The template remains visible so users can see what the consultant understands and fill details directly. Start with a plain-language problem, then ask one to three focused questions per turn rather than presenting an exhaustive form.

For example, after “we invoice equipment after it has been returned,” ask how physical returns are recorded and which event stops charging. If an answer reveals a missing return date, investigate evidence, responsibility and correction handling before suggesting a future billing rule. Adapt to the answer instead of following a fixed script.

Show extracted facts as pending changes with their supporting message or document. Let users accept, edit or reject them. Preserve previous values when correcting a fact. Provide explicit “I don't know,” “Not applicable” and “Ask the process owner” actions; record rationale and ownership without inventing answers. Support pause/resume and a visible list of unresolved decisions. A readiness view should list concrete missing evidence and contradictions, not imply that a chat-length or percentage score proves completeness.

Persist question IDs and their lifecycle so paraphrased repeats are prevented across sessions. Only questions eligible to be asked now enter the model's activeGaps context. Maintain append-only turns, authorized evidence, expected revisions and idempotent submission; fence late responses after context changes. Accepting a proposal must be a separate authorized action, never a consequence of model output alone.

The first implementation slice adds a bounded internal interview contract, evidence-linked proposals, a model prompt and stage-runner validation. Proposed field values are exact source excerpts for user review; provenance checks cannot establish business truth or passage relevance. A neutral acknowledgement is separated from the structured questions and application-owned status. Model observations remain untrusted suggestions and cannot change workflow state. It does not yet persist conversations, render chat or enforce To-Be generation readiness. Subsequent slices add persistence, the conversational workspace and confirmation/generation integration, followed by synthetic real-provider evaluation and Playwright journeys.

### Interview verification — 2026-10-21

The first local contract slice passes typecheck, lint and 108 targeted automated tests (two opt-in tests skipped). A five-turn synthetic subscription-CLI evaluation using actual Claude Sonnet 5.5 responses passes the stated core behavioral criteria after primary-agent and GPT-6-Sol review. It covers initial pain, follow-up answers, a correction, an unknown policy and an instruction to bypass review. Earlier runs exposed the need to distinguish what should happen from actual current practice, preserve role-specific facts and avoid unsupported causal claims.

See the [local evaluation review](../test-results/interview-live-review.md) for artifacts, findings and limits. The final v5 run also resolves the previously observed internal routing language and unsupported role assignment in all five turns. This is model-level evidence; the CLI JSON adapter does not prove production API transport, persistence, UI, confirmation or To-Be readiness. The rental To-Be has not been regenerated, and its previous quality rating remains unchanged.

### As-Is template

| Area | Details to capture |
| --- | --- |
| Business context | Problem, measurable desired outcome, industry, process variant, scope boundaries, business units and locations |
| People and systems | Process owner, participants, current applications, spreadsheets/manual work, interfaces and handoffs |
| Step-by-step process | Sequence, initiating event, actor, inputs, activities, fields, output documents and receiving role/system |
| Business rules | Decision conditions, approvals, thresholds, authority, timing, statuses and prerequisites |
| Exceptions and recovery | Partial completion, rejection, cancellation, corrections, rework, duplicate requests and lost responses |
| Data and assets | Master/transaction data, identifiers, quantities, ownership, custody, locations and data quality |
| Financial behavior | Pricing, costing, billing, accounting effects and reconciliation where applicable |
| Operating scale | Frequency, volumes, peaks, turnaround time and service expectations |
| Controls and evidence | Access, auditability, compliance requirements, supporting source/revision and accountable owner |
| Problems and requirements | Current pain points, business impact, desired change, priority and acceptance outcome |

Process-specific questions extend this template. For example, recurring charges require rate periods, start/end events, returns, proration and repeat-charge controls; physical goods require allocation, movement and custody; approvals require authority and rejection/reapproval behavior. Selecting a process characteristic is evidence of relevance, not proof that its policies are already known. Avoid relying on keyword presence to certify completeness.

### Discovery acceptance tests

- A new user can describe a problem and receive a usable As-Is template without first constructing technical IDs or duplicating every statement into a quote field.
- Relevant follow-ups change with the process and recorded answers; unrelated questions are omitted, and unchanged answered questions are not repeated.
- Unknown and not-applicable answers remain distinguishable from confirmed business facts. Not-applicable requires a rationale where it affects readiness.
- Conflicting answers remain visible and cannot silently approve one alternative.
- Answers survive save/reload with tenant authorization, immutable revisions and concurrency/idempotency protection.
- Editing an answer or process detail invalidates confirmation and updates dependent questions.
- The server refuses generation from incomplete or unconfirmed input even if a client bypasses the UI.
- The generated design can be traced back to the confirmed answers and evidence; no model-created approval or SAP claim becomes trusted automatically.

Implement this workflow in bounded backend, interface and generation-integration slices. Test each slice, then exercise the complete journey with synthetic users and Playwright. Preserve the existing source capture and historical snapshots during migration.

## Phase 1 — Correct the documented findings and establish regressions

Turn each finding into a scenario with source references, concrete preconditions, an action and an observable expected outcome. Check the expected outcome against the source and approved decisions before using it as a test oracle. Unresolved policy must remain an explicit dependency, not an invented answer.

| Finding | Required correction or scenario |
| --- | --- |
| H1 | Recover an unpaid historical final-period charge after correction without inventing a new current-period hire charge. |
| H2 | Use distinct recurring and one-time charge identities; prevent one-time rebilling across periods. |
| H3 | Exclude owned-asset capital value specifically; do not exclude unrelated cost categories without evidence. |
| H4 | Distinguish replay of one credit request from a legitimate separate request for the same customer. |
| H5 | Define stock buckets and verify conversion-availability arithmetic without double subtraction. |
| H6 | Separate failed posting, lost response, cancellation, reversal and physical return; define safe retry and custody transitions. |
| H7 | Preserve the required transport commitment before final-invoice closure; keep the implementation mechanism explicit. |
| H8 | Keep cancelled delivery demand out of the open freight-planning queue. |
| H9 | Gate settlement on applicable approved accounting policies and distinguish completeness from posting authorization. |
| M1 | Distinguish quotation draft persistence from completion, release and printing requirements. |
| M2 | Derive custody and location from movements independently of the owning party. |
| M3 | Identify a conversion instruction before posting; reconcile retries while permitting legitimate partial conversion. |
| M4 | Separate physically on-hand, missing, damaged and returned packaging quantities. |
| M5 | Prevent a receipt reversal from detaching an asset already dispatched to a customer. |
| M6 | Correct and validate rule-to-rule references, including the dispatch credit reference. |
| M7 | Finish successful replacement allocation in the status required by delivery selection. |
| M8 | Describe and test the optional future scanner capability; do not count manual-only behavior as scanner implementation. |

Deliverables: a finding-to-scenario register, corrected design proposals, regression fixtures using synthetic data, and a before/after assessment retaining the original outputs.

Exit gate: each of the 17 findings has a reviewed disposition and evidence. Corrections must not silently resolve business questions. New defects discovered during correction join the same register.

## Phase 2 — Define consistent rules across sections

Establish shared business definitions before regenerating dependent sections:

- Document and item states: draft, approved where applicable, allocated, dispatched, returned, held, issued, posted, cancelled and reversed.
- Allowed transitions, their initiating events, owners, preconditions and downstream effects.
- Ownership, physical custody and location as separate concepts.
- Requested, actual, effective and billing dates, including missing or corrected dates.
- Partial quantities, remaining quantities, charge identities, instruction identities and retries.
- Action-specific approval and credit controls, including save, print, dispatch and billing.
- Explicit section interfaces: quotation to order, procurement to allocation, delivery to freight, return to billing, and billing to accounting.

Deliverables: a reviewed business-rule catalog, transition tables and section-interface contracts, each carrying evidence or an unresolved decision reference.

Exit gate: a downstream rule can select every upstream state it claims to process; cancellation and retry paths remain coherent; no section silently redefines a shared rule. Phase 1 scenarios are rechecked against these definitions.

## Phase 3 — Resolve decisions and establish SAP applicability

Consolidate overlapping questions into a decision register without deleting distinct decisions. Each entry needs an owner, source, affected requirements and steps, allowed alternatives, approval evidence and revision. Approved decisions come from trusted records, not model output.

Confirm the exact SAP edition and release. For each implementation claim, verify relevant official SAP documentation and any licensing or deployment dependencies. A matching product name or documentation link is insufficient: the evidence must support the specific behavior.

Deliverables: the decision register and a requirement-to-SAP-fit matrix distinguishing standard capability, configuration, extension, integration, manual activity and unresolved validation.

Exit gate: implementation-critical decisions are approved and consistently reflected across the design; claims of standard/configuration fit have applicable evidence. Remaining unknowns are visible and prevent sign-off for the affected scope.

Independent drafting and regression work may continue while owner decisions are pending. Do not fill those gaps with assumptions presented as facts.

## Phase 4 — Generate, independently review and repair

Supply Sonnet with the reviewed requirements, shared rules, approved decisions and verified references. Generate bounded sections while preserving their common interfaces and the complete requirement inventory.

Use GPT-6-Sol to review against the source and the regression scenarios. Each finding must identify the exact requirement, rule or step, explain the contradiction or omission, and state a proposed correction with supporting evidence. Reject unsupported reviewer assertions as well as unsupported generator assertions.

Run bounded repair cycles. Preserve every attempt and its outcome; unresolved defects remain visible when a retry budget is exhausted. Revalidate the assembled design after every accepted section change, then review cross-section behavior again.

Deliverables: versioned generations, independent review results, repair history and the consolidated candidate design.

Exit gate: no unresolved high-severity contradiction or unsupported business-policy choice; all critical requirements are substantively addressed; revisions pass the established regression scenarios and full trace validation.

## Phase 5 — Verify at the layer that establishes the claim

| Verification layer | Evidence required | What it does not establish |
| --- | --- | --- |
| Structure and traceability | Parsed schema, exact source links, valid IDs, complete dispositions and test mappings | Semantic correctness |
| Business behavior | Reviewed transition/decision scenarios; executable checks where behavior is modeled; documented semantic assessment otherwise | Actual SAP execution |
| Application integration | Tests of input revisions, authorization, jobs, persistence, retries and error handling when implemented | Correctness of SAP configuration |
| Browser journey | Playwright checks of implemented capture, generation, review and export journeys using synthetic data | Business quality merely because pages load |
| SAP applicability and execution | Relevant release-specific evidence plus representative execution in an appropriate SAP test environment | Behaviors that were only described or simulated |
| Human acceptance | Business-owner and SAP-consultant review of the actual versioned deliverable | Automatic approval of later revisions |

Include normal, partial, repeated, corrected and failed operations. Prioritize late returns, duplicate invoices, lost responses, partial conversions, missing POD, cancelled transport and unresolved-policy holds.

Label every scenario as specified, simulated, executed in the application, executed in SAP, or blocked. Record the tested artifact revision and actual outcome. Never convert written acceptance text into a passing execution result.

Exit gate: required tests pass at the appropriate layer, and any unavailable SAP environment or unverified behavior is stated as an open acceptance dependency. Type checking, linting and applicable regression tests are mandatory for code changes.

## Phase 6 — Deliver the reviewable plan and expand coverage

Produce a comparison matching the reference's operational depth. For each requirement or process step, show As-Is, To-Be, source evidence, actor, trigger, documents, fields, rules, exceptions, inventory/accounting/ownership effects, SAP implementation, benefits and acceptance criteria.

Include decision, gap, evidence and test-status registers. Preserve links from the To-Be design into subsequent blueprint detail, including configuration, extensions, integrations, data, security, migration and testing where relevant. Keep unverified blueprint detail explicitly unresolved.

Inspect the rendered/exported deliverable for readability, completeness and trace preservation. Obtain rental business-owner and consultant acceptance before extending the approach to product, service and rigging. Each variant requires its own evidence and cases.

Exit gate: accepted rental deliverable with readable exports and no loss of decisions, exceptions or evidence. Later variants are separately assessed rather than inheriting the rental score.

## Independent As-Is-only evaluation

The current reference-conditioned exercise supplied both As-Is and proposed To-Be content. It measures reconstruction and design quality with that assistance, not independent discovery from As-Is alone.

Maintain a separate evaluation where generation receives only the approved As-Is information and any explicitly supplied business constraints. Keep the reference To-Be, its derived requirements and expected answers out of the generation context. Freeze the inputs and rubric before the run; have reviewers compare the result with the withheld reference and other justified alternatives.

Do not penalize justified alternatives simply for using different wording, and do not assume the sample resolves missing policy or establishes SAP fit. Separate source-supported omissions from facts that could not be inferred from the permitted input. Report this evaluation separately from the reference-conditioned score.

## Scoring and final acceptance

Retain the current rubric for comparable assessments:

| Dimension | Weight | Baseline rating /10 (not updated per round) |
| --- | --- | --- |
| Requirement coverage | 25% | 8 |
| Operational detail | 20% | 8 |
| Internal business logic | 20% | 4 |
| SAP implementation specificity | 15% | 2 |
| Evidence and uncertainty handling | 10% | 8 |
| Consultant review usability | 10% | 7 |

These are reviewer judgments. Record evidence and disagreements alongside scores. If scope, source exposure or the rubric changes, report it explicitly and avoid claiming a controlled score improvement.

The candidate is ready for final acceptance only when:

- All critical requirements are substantively addressed, or have an explicit approved disposition.
- No high-severity contradiction remains; medium findings are corrected or explicitly accepted with rationale.
- Cross-process states, dates, document links, financial effects and retry behavior agree.
- Business decisions are approved wherever required, and SAP claims have applicable evidence.
- Required tests have passed at the claimed layer; specified and blocked tests remain visibly distinct.
- Business owners and the SAP consultant accept the reviewed version and its remaining limitations.

An aggregate score cannot override a failed acceptance gate. Any subsequent change to the accepted artifact requires proportionate revalidation.

## Execution sequence and controls

H1–H9 and M1–M8 now have a local finding-to-scenario register, and candidate shared rules are prepared. Following the user's additional direction, implement consultant-led discovery before accepting regenerated corrections. Resolve applicable decisions before claiming SAP implementation readiness.

Break implementation into verified slices of approximately five files or fewer and summarize each slice. The user's 2026-10-21 instruction explicitly approves all pending phases and overrides the earlier per-phase approval gate; proceed without further phase confirmations. This authorizes implementation and testing, not invented customer policy approvals or unsupported SAP claims. Keep secrets and customer evidence outside Git; use synthetic fixtures for committed tests.

The active goal authorizes execution of the quality plan. Documentation and preparatory artifacts do not themselves establish completion, approve unresolved policies or constitute a deployment.
