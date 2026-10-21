# Detailed To-Be quality baseline

Status: phase 1, local contract and fictional benchmark. The live application
still generates an initial problem analysis and proposed scope. This contract,
prompt and renderer helper are not wired to a generation job, database or screen.
No new model output or live To-Be capability is claimed by this phase.

## Reference assessment

The user-supplied workbook was reviewed locally on 2026-10-20. It contains four
operational variants and 40 named steps (12, 7, 9 and 12), in addition to its
cover sheet. Its defining quality is operational specificity: side-by-side
current and proposed behavior, document flow, rules, exceptions and consequences.
It is a level-of-detail benchmark, not an authoritative SAP capability catalog.

The original workbook and extracted customer content must stay outside Git and
public fixtures. The benchmark below is fictional and hand-authored. It does not
reproduce the customer's rows or certify any SAP functionality.

## Required output

| Area | Required detail |
| --- | --- |
| Evidence | Source locator, exact excerpt, stable requirement ID; distinguish current facts from future requests |
| Process | Variant, sequence, actor, trigger, inputs, actions with fields, outputs and document references |
| Rules | Conditions, system response, control and approval gates, changes that require reapproval |
| Exceptions | Partial processing, rejection, correction and accountable owner, where applicable |
| Data | Master data, fields, owner and document relationships |
| Consequences | Inventory, financial and ownership effects stated separately |
| Implementation | Standard/configuration/extension/integration/manual/needs validation, with evidence and applicable release |
| Coverage | Every requirement implemented in the proposal or explicitly deferred/rejected through an approved decision |
| Decisions | Conflicts preserved, unresolved questions assigned and affected steps identified |
| Acceptance | Concrete normal and exception cases, with critical requirements traced to tests |
| Value | Specific change from current behavior, not repetitive generic benefits |

For example, “automate hire billing” is insufficient. The fictional benchmark
specifies four individually tracked hire items, independent end dates, a partial
return that closes only one item, missing-date validation, recurring charges
separate from already-billed installation, and a billing hold until the final-day
proration policy is approved. It specifies actions and expected outcomes.

## What the first-phase checks establish

`src/lib/ai/design-quality.ts` defines bounded strict schemas, evaluates structural
completeness and referential integrity, and materializes source excerpts beside
the proposed steps. It rejects omitted requirement dispositions, dangling or
duplicated IDs, invented quotes, inconsistent coverage links, missing critical
test traces, invented decisions and unverified standard/configuration claims.

Unresolved conflicts, open questions, unknown target releases and implementation
validation needs block progression. Otherwise the result is
`HUMAN_REVIEW_REQUIRED`, never automatically approved.

The trusted input must be assembled by a future authorized server loader.
Approved decisions and verified references must not be accepted from a model or
an arbitrary client payload. A verified reference must be reviewed for support
of the specific claim, not merely for existence or product/release matching.

These checks do **not** establish semantic correctness, completeness of extracted
requirements, the adequacy of each exception test, or SAP fit. Generic prose
could satisfy a schema. A consultant must compare actual content against the
source, examine omitted/contradictory cases and verify proposed SAP capabilities.
Acceptance-test text is a specification, not an executed SAP test.

Source excerpts can contain future requests as well as current-state facts.
The comparison helper calls them `sourceFacts`; the future UI must label their
provenance and intent rather than presenting every quote as an As-Is statement.
It must also show dispositions, eliminated steps, questions and the evaluation;
displaying only comparison rows would hide important unresolved work.

The current contract is for one bounded process variant (up to 200 requirements
and steps), not an entire program. Do not truncate a larger input silently.
Versioned inputs, org-unit replication, wishlist dispositions, process mapping,
gap traces and approval workflows remain requirements of PRD F6/F7. This contract
adds operational detail and validation; it does not replace those requirements.

## Remaining delivery phases

1. **Complete:** quality contract, fictional reference draft, negative regression
   tests, draft prompt and this assessment.
2. **Detailed inputs and generation:** capture/import As-Is facts and future
   requirements separately; preserve source cells and versions; review extraction;
   collect product/release and unresolved policies; connect a tenant-authorized
   generation job with validation and bounded repair. Evaluate real model outputs
   against held-out fictional product, service, customer-owned-stock and rental
   cases. This is multiple bounded implementation phases, not one five-file edit.
3. **Review and export:** display the comparison, sources, decisions, gaps,
   coverage and quality results; enable reviewed versioning and approvals; export
   the detailed comparison and subsequent blueprint with configuration, RICEFW,
   integration, data, security, migration and testing sections.
4. **Demo acceptance:** test the complete journey through Playwright with synthetic
   inputs, inspect actual generated content, and compare against a reviewed
   business checklist before deploying. Browser success alone is not design quality.

Each subsequent implementation slice follows the supplied AGENTS instruction:
approximately five files, verification, then approval before expanding scope.

## Verification

Run `pnpm exec vitest run tests/design-quality.test.ts`, `pnpm typecheck` and
`pnpm lint`. Run the existing unit suite for regressions. The fictional fixture
is an expected example, not output from Claude, and no provider call is made
by this phase. The draft prompt is not yet evaluated with a real provider.
