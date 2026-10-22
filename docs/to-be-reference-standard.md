# To-Be reference standard: what a CTO-grade SAP As-Is/To-Be plan contains

Date: 2026-10-22
Status: analysis, no code changed. Generalized from a set of real implementation documents (a master
requirements document, a signed-off process blueprint, a functional guide for a custom planning tool and an
integration design specification in two revisions). All content below is restated in our own words. It
contains no customer names, places, products, codes, volumes or quotations, and the examples are fictional.

Purpose: give the generator, validator, interviewer and report a concrete target for "consultant-grade" output,
and rank what our app is missing against it.

---

## 1. Document architecture of a CTO-grade blueprint

A real blueprint is not one long process narrative. It is a layered document where the foundation sections
(structure, data) are defined once and every process section refers back to them. Section order matters: a reader
must be able to resolve every code used in a process step from an earlier section.

| # | Section | Contents | Why it exists |
|---|---|---|---|
| 0 | Document control | Title, version, date, version history (change, author, reviewer, review date), sign-off table per version, scope-baseline statement | The blueprint is the scope contract. Change control and sign-off are measured against it. |
| 1 | Introduction and objectives | Business context of the entity, implementation objectives (replace spreadsheets, real-time visibility, faster close, analytics), modules and value streams in scope, out of scope | Anchors every later design choice to a stated objective. |
| 2 | Organizational structure | Per area (finance/controlling, logistics, sales, HR): each enterprise-structure element, its definition, why this design, assigned values in a table, and how elements link | Org elements drive every document, posting and authorization. Wrong here means rework everywhere. |
| 3 | Key data structures (configuration catalogue) | Per module: document types, item categories, number ranges, pricing procedures (condition, description, calculation basis, remarks), order reasons, tax codes, ledgers, currency types, fiscal year and posting period control, account groups, material types and groups, profiles | Makes the To-Be concrete and buildable; lets configuration be traced to process steps. Values the business must supply are marked as such. |
| 4 | Master data | Per object (GL account, asset, bank, material, business partner, payment terms, delivery terms): ownership, creation process, number range, mandatory fields, change logging, governance | Master data defects are the most common go-live failure; ownership must be explicit. |
| 5 | High-level integrated process maps | One map per value stream showing phases as columns and steps as boxes, with the accounting entry posted at each step and where the flow leaves or re-enters the system | Shows end-to-end integration (logistics to finance) before the detail. |
| 6 | Process scenarios | One sub-section per scenario/variant using a fixed template (see section 2 of this document) | The core design. Repeatable template makes review and sign-off fast. |
| 7 | Reports per module | Report ID, purpose, standard app or custom object | Proves operational and management information needs are met. |
| 8 | Enhancements, forms, programs | Per module tables of custom objects | Feeds the RICEFW estimate. |
| 9 | Period-end closing calendar | Ordered list: module, activity, process ID, app, day offset, owner | Converts design into an operating rhythm; a close-time KPI depends on it. |
| 10 | Integration design (often a separate document) | Interface catalogue plus one spec per interface (section 3.3 below), error-handling strategy, assumptions, glossary | Non-SAP systems are where projects fail; integration needs its own contract. |
| 11 | Consolidated customization list and observation log | All custom objects across modules; numbered list of business observations/requests with raised-by, response, solution, status | The fit-gap outcome and the open-issues register in one place. |
| 12 | Data migration and cutover | Strategy, objects, legacy-balance controls, upload programs, cutover plan (often a linked document) | Required before build sign-off; references in the process sections point here. |

Patterns observed that our output should copy:

- Stable hierarchical IDs: value stream, scenario and step share a prefix, and the same ID appears in the flow
  diagram, the step table, the report list, the gap list and the month-end calendar.
- Applicability matrices: a row per value (status, source, reason code, role) and a column per business unit
  or site, so one design serves several units without copying it.
- Phase flags: each capability marked current phase or later, with the interim manual or bridge process
  described until the later phase arrives (for example a periodic export/import until an integration is live).
- Explicit "not allowed" requirements (no deletion, no edit after a given status, no bulk upload) stated as
  rules, not left implicit.
- Values the business still owes are marked "business to provide" inline and collected in the observation log,
  not hidden.

Weaknesses seen in the reference set, which our output should beat rather than copy: missing KPIs and baselines,
no roles/segregation-of-duties section, no test scenarios, placeholder migration and cutover sections, generic
textbook paragraphs explaining standard SAP concepts, duplicated text across variants, named individuals instead
of roles, and many configuration values left "to be discussed" without an owner or date.

---

## 2. Anatomy of one well-specified process (As-Is to To-Be)

### 2.1 Scenario-level template

Each scenario/variant section contains, in this order:

1. **Flow diagram** with swimlanes per role, every box carrying its step ID, and a legend distinguishing:
   step in SAP, step outside SAP, automatic system step, decision, data object. Cross-references to other
   scenarios (for example "procurement continues in P2P-xx") are explicit boxes.
2. **Current state (As-Is)**: how the business operates today, including real constraints (holding periods,
   who decides, which document triggers what, tax or legal treatment rules and the evidence each rule needs).
   Facts, not wishes.
3. **Prerequisites**: master data and configuration that must exist, by object: material and its unit and
   category settings, product characteristics (table: characteristic, description, mandatory, conditional
   rule, default, used in fast entry), price source, credit setup, customer sales-area extension, tax
   classification (default per channel, where editable, until which document), payment and delivery terms,
   text types and where they print, organizational assignments and document types used.
4. **To-Be narrative ("process in the system")**: numbered statements, typically 15 to 30, each one a
   decision a builder can implement: which part stays outside the system, how the plant or org unit is chosen,
   which fields are copied from which incoming document, what is editable before and after each follow-on
   document, partial processing, packing and weights, automatic follow-on documents, defaults.
5. **Process step table** (one row per step):

   | Column | Content |
   |---|---|
   | Process ID | Hierarchical, stable |
   | Description | Action in business terms |
   | Prerequisite | Document or data that must exist |
   | App / transaction | The concrete application used |
   | Accounting entry | Debit/credit by account type, or "no accounting entry" stated explicitly |
   | User remarks | Optional clarifications |

6. **Functional gaps and mitigation**: numbered "gap -> mitigation" pairs (configuration, report, custom
   field, process workaround, or "to be discussed with <role>").
7. **Technical gaps**: forms (with link to the form specification), validations, workflow (approve, reject,
   send back for rework; standard workflow plus custom extension point), enhancements.
8. **Owner**: business owner role and end-user roles for the scenario.

Cross-period and multi-entity flows add a **worked accounting timeline**: dated events, which entity posts what,
and month-end manual entries with their reversal.

### 2.2 Attributes every To-Be step should carry

| Attribute | Type | Notes |
|---|---|---|
| processId | string | Hierarchical: valueStream-scenario-step |
| title, sequence | string, int | |
| stepType | enum | IN_SYSTEM_MANUAL, IN_SYSTEM_AUTOMATIC, OUTSIDE_SYSTEM, DECISION, INTEGRATION |
| actorRole | role ID | From the role catalogue, not free text |
| trigger | text | Event or document that starts the step |
| prerequisites | list | Documents, master data, configuration objects (IDs) |
| inputs / outputs | documents | With document type and reference to predecessor |
| app or transaction | list | Only names evidenced by trusted references |
| actions and fields | list | Ordered; fields read/written, mandatory/editable rules |
| business rules | condition -> response | Includes thresholds and approval triggers |
| status change | from -> to | Against the document's status model |
| edit/lock rules | list | What can change after this step and by whom |
| exceptions | condition, response, owner | Partial, reject, cancel, correct, retry |
| approval | workflow ID | Levels, approver role, reject/rework path |
| accounting entries | list of {event, debit, credit, basis} | Or explicit "none" with reason |
| inventory / ownership effects | text | Separate from financial |
| config objects | IDs | Into the configuration catalogue |
| custom objects | RICEFW IDs | Forms, reports, enhancements used |
| interfaces | interface IDs | If data crosses a system boundary |
| reports / KPIs fed | IDs | Which measurement this step produces |
| applicability | units/sites, phase | Matrix entry and phase flag |
| gaps | gap IDs | With mitigation |
| acceptance tests | normal and exception | Given/when/then |
| evidence | source IDs | Requirement trace |

### 2.3 Fictional example (industrial spare-parts distributor, customer return)

As-Is (current state): Customers phone the service desk to report a defective part. The desk fills a paper
complaint form; the store accepts the part without reference to the original invoice; finance raises a manual
credit in the accounting package weeks later. No inspection outcome is recorded, and refunds are sometimes issued
for parts that are later found to be customer-damaged.

To-Be step O2C-RET-020 "Create return order with reference":

| Attribute | Value |
|---|---|
| stepType | IN_SYSTEM_MANUAL |
| actorRole | ROLE-SALES-SVC (customer service agent) |
| trigger | Customer complaint accepted by the service desk |
| prerequisites | Original billing document exists in the system (else see exception E2); return reason codes configured (CFG-SD-ORDREASON) |
| inputs / outputs | In: complaint form (attached), original invoice. Out: return order (type CFG-SD-DOCTYPE-RETURN) referencing the invoice item |
| actions | Select invoice item; enter return quantity (<= billed quantity minus already returned); select return reason (mandatory, header level); attach complaint form |
| rules | R1: reason "damaged in transit" routes to logistics claims queue. R2: return value above the approval threshold (business to provide, decision DEC-07) requires service manager approval |
| status | Return order: created -> awaiting approval (R2) or released |
| edit/lock | Quantity editable until the return delivery is created; reason locked after approval |
| exceptions | E1 approver rejects -> order closed with rejection reason, customer notified by agent. E2 invoice predates go-live -> create without reference, mandatory legacy invoice number field, finance review flag |
| approval | WF-RET-01: one level, approve / reject / send back for rework |
| accounting | No accounting entry at this step (value is recognised at credit memo, step O2C-RET-050) |
| config objects | CFG-SD-DOCTYPE-RETURN, CFG-SD-ORDREASON, CFG-SD-COPYCONTROL-INV-RET |
| custom objects | FORM-RET-01 (return authorisation printout) |
| KPI fed | KPI-RET-CYCLE (days from complaint to credit) |
| gaps | GAP-RET-03: legacy invoices not in system -> mitigation: manual reference field plus finance review |
| tests | Normal: invoiced item, quantity within limit, below threshold -> released, linked to invoice item. Exception: quantity above remaining returnable -> blocked with message; rejected approval -> closed, no delivery possible |

---

## 3. Supporting artefacts a reviewer expects

### 3.1 Organizational structure mapping

Per element: element type, code, name, definition, design rationale, parent assignment, currency/language/
country where relevant, which processes use it. Areas: legal entity and company code; controlling and
operating structures; profit and cost centre hierarchies (with governance principles); plants (and whether
production or trading), storage locations by stock purpose; purchasing organization and groups; sales
organization, channels, divisions, customer groups, sales offices, shipping points; HR personnel areas and
groupings, payroll areas, organizational units. A single summary table per entity closes the section.

### 3.2 Master data

Per object: owner role, creation channel (central team via request form, self-service, migration), number range
(internal/external), mandatory fields and field-status control, extension rules (to which org units), change
logging, approval for creation/change, data-quality rules (for example derivation fields that must be filled
before downstream planning can run).

### 3.3 Integration specifications

Interface catalogue (one row per interface):

| Field | Meaning |
|---|---|
| ID, name, domain | Stable identifier and business grouping |
| Type | Standard (delivered content) or custom |
| Source, target, middleware route | Including round trips (A -> middleware -> B -> middleware -> A) |
| System of record | Which side owns the data object |
| Direction and pattern | Push/pull, synchronous/asynchronous, file, message, API or embedded UI |
| Trigger | Event, scheduler, or user action; which side initiates |
| Frequency and window | And peak volume per run |
| Record type | Full or delta (delta key, last-run-date handling) |
| Data objects and mapping | Mapping sheet reference; field table: target field, source table/field, derivation logic |
| Security | Authentication method per hop, encryption, network allowlisting |
| Error handling | Where errors are visible, alerting (who, what content), retrigger/rerun procedure, idempotency |
| Limitations and resolutions | Known behaviour of delivered content that constrains the design, and the agreed workaround |
| Prerequisites and licensing | Configuration and licence dependencies |
| Cutover role | Initial load needed or not |

Plus: architecture diagram, process diagram per interface, layered monitoring strategy (dashboard first, alert
second), assumptions with action items, glossary, version history with a change log naming added and removed
interfaces.

### 3.4 RICEFW list

One consolidated list: ID, type (Report, Interface, Conversion, Enhancement, Form, Workflow), module, name,
purpose, linked process IDs, standard alternative considered, complexity, owner, status. Each custom object with
non-trivial logic gets a functional guide: user journey, selection screen and steps, validations with exact
messages, status model (draft, released, re-edit), derivation logic, prerequisites, open development items.

### 3.5 Reports and KPIs

Reports: ID, purpose, audience, standard app or custom object, linked process. KPIs (the reference set mostly
lacked these; we should exceed it): name, definition and formula, baseline, target, owner, data source step,
frequency.

### 3.6 Roles and authorizations

Role catalogue (business role, responsibilities, org-level restriction), role-by-capability matrix per business
unit (who may create, approve, transfer, change priority, delete), approval matrix (document, threshold,
approver levels, escalation levels with time limits), segregation-of-duties conflicts and mitigations, and
negative permissions (no delete, no edit after status X).

### 3.7 Data migration

Objects (master data, open items, balances, open documents, history needed or not), source, cleansing owner,
load tool, sequence, reconciliation check, controls (dedicated document type for opening balances that is
locked after the load; no postings in legacy after go-live; post-go-live corrections in the new system only).

### 3.8 Testing and UAT

Per step acceptance tests (normal and exception), end-to-end scenario tests across value streams, integration
tests per interface (success, error, rerun), period-end close rehearsal, UAT entry/exit criteria and sign-off.

### 3.9 Cutover

Activities, owners, timing relative to go-live, freeze windows, initial interface loads, verification checks,
fallback decision point.

### 3.10 Governance and sign-off

Scope-baseline statement, change control, quality checkpoints at phase ends, observation/issue log (number,
requirement, raised by role, response, solution, status), sign-off table per version with role and date.

---

## 4. Quality checklist for a generated plan

Each item is checkable by a reviewer (and many by the validator). "All" means every step or every item in scope.

Structure and control
1. Document control present: version, date, source revision, reviewer roles, sign-off table (even if empty).
2. Objectives and in/out-of-scope statement present, and every scenario maps to at least one objective.
3. Every code used in a step resolves to the org-structure, configuration or master-data sections.
4. Step IDs are hierarchical, unique and reused consistently in tests, gaps, reports and RICEFW links.

Process depth
5. Each scenario has an As-Is narrative clearly separated from To-Be statements.
6. Each step has trigger, actor role, prerequisites, inputs and outputs with document references.
7. Each step states its type (in system manual, automatic, outside system, decision, integration).
8. Each step that posts or could post states the accounting entry or explicitly "none" with reason.
9. Inventory, financial and ownership effects are stated separately.
10. Each document type used has a status model, and every step's status change exists in it.
11. Edit/lock rules state what may change after each follow-on document.
12. Approvals specify levels, approver roles, thresholds (or an open decision), reject and rework paths.
13. Exceptions cover partial, reject, cancel, correct and retry where applicable, each with an owner.
14. Business-unit/site applicability and phase are stated for each scenario; interim processes are described
    for anything deferred to a later phase.

Data and structure
15. Org structure lists each element with code, rationale and parent; only elements supported by evidence.
16. Configuration catalogue lists document types, reason codes, pricing elements and number ranges used,
    each marked confirmed or "business to provide" with an owner.
17. Master data objects have owner, creation channel, mandatory fields and governance.
18. Configurable products list characteristics with mandatory flags and defaults.

Custom, integration, reporting
19. Every non-standard element appears once in the RICEFW list with type, linked steps and rationale.
20. Every system boundary has an interface entry with direction, trigger, frequency, record type, system of
    record and error handling.
21. Every interface names how a failed message is seen, alerted and safely rerun.
22. Reports list purpose and realization; at least one report or KPI per pain point.
23. KPIs carry baseline, target, owner and the step that produces the data.

Controls and roles
24. A role catalogue exists, actors reference it, and no person names are used.
25. Segregation-of-duties conflicts are identified or explicitly assessed as none.
26. Each control requirement from discovery maps to a rule, workflow, authorization or report.

Fit-gap and uncertainty
27. A gap register lists each gap with mitigation type, owner and status.
28. Every SAP object named is evidenced by a trusted reference; unevidenced items are flagged for validation.
29. Open decisions have owner, affected steps and the hold they impose; none is silently resolved.
30. No invented thresholds, rates, dates or accounting rules.

Migration, cutover, testing
31. Data migration objects and opening-balance controls are listed for the scope.
32. Initial loads for interfaces and master data are identified for cutover.
33. Each step has normal and (where applicable) exception acceptance tests; end-to-end scenarios exist per
    value stream.
34. Period-end activities touched by the scope are listed with sequence and owner.

Traceability and readability
35. Every requirement has a disposition and traces to steps and tests.
36. Variants share text by reference instead of copying it; differences are explicit.
37. No generic textbook explanations of standard SAP concepts in place of design decisions.

---

## 5. Gap analysis against our app

What we read: `prompts/to_be.system.md`, `src/lib/ai/to-be.ts`, `src/lib/ai/design-quality.ts`,
`src/lib/consultant-report.ts`, `prompts/discovery_interview.system.md`, `src/lib/workspace-fields.ts`,
`docs/to-be-quality-improvement-plan.md`, `fixtures/eval/pump-o2c.json`.

### 5.1 Already covered (often better than the reference set)

| Reference element | Our equivalent |
|---|---|
| Step trigger, actor, inputs/outputs | `steps[].trigger`, `actor`, `inputDocuments`, `outputDocuments` |
| Ordered actions and fields | `steps[].actions[]{actor, system, operation, fields}` |
| Business rules | `businessRules[]{id, condition, response}` |
| Exceptions with owner | `exceptions[]{condition, response, owner}` plus not-applicable reason |
| Master data per step | `masterData[]{object, fields, owner}` |
| Inventory/financial/ownership effects | `effects{inventory, financial, ownership}` (free text) |
| SAP realization and fit | `implementation{kind, detail, referenceIds}` with trusted-catalogue validation |
| Open issues log | `openQuestions[]` with owner and affected steps; `decisionIds`; register in report |
| As-Is vs To-Be comparison | Report `comparison` rows, eliminated steps |
| Requirement traceability | `coverage[]`, trace validator, report traceability table (the reference had none) |
| Acceptance tests | Per-step normal and exception tests (the reference had none) |
| Evidence handling | Source quotes, conflicts, release gating (the reference had none) |

### 5.2 Missing, ranked by impact

| Rank | Missing element | Impact | Today |
|---|---|---|---|
| 1 | Fit-gap register with mitigation (gap, type, mitigation, owner, status) | The consultant's primary deliverable; reviewers look for it first | Only open questions and SAP limitation notes |
| 2 | RICEFW list (forms, reports, interfaces, conversions, enhancements, workflows) with linked steps | Drives build estimate and scope sign-off | EXTENSION kind in free text only |
| 3 | Integration/interface catalogue and specs | Fixture already has a retained non-SAP CRM and a government portal; interfaces are invisible today | Mentioned in `implementation.detail` at best |
| 4 | Org-structure mapping | Every document and posting depends on it; project already stores org units but the To-Be input does not receive them | `orgUnits` stored in project (`src/lib/tenant.ts`), not passed into `ToBeInput` |
| 5 | KPIs with baseline/target and reports list | Interviewer captures `desired_outcome`, the eval checks KPIs by regex on text, but the schema has no KPI field | Free text only |
| 6 | Structured accounting entries per step | Finance sign-off depends on Dr/Cr per event; free text is not checkable | `effects.financial` text |
| 7 | Configuration catalogue (document types, reason codes, pricing elements, number ranges) | Makes the design buildable and lets "business to provide" values be tracked | Inside `implementation.detail` text |
| 8 | Role catalogue, approval matrix and SoD | Controls requirement kind exists but no structured authorization output | `actor` is free text |
| 9 | Status models per document and edit/lock rules | Plan phase 2 calls for it; reviewer findings (retry, cancellation, held charges) stem from it | Implicit in rules |
| 10 | Step type (in-system manual/automatic/outside/decision) and process hierarchy IDs | Needed for flow diagrams and cross-scenario references | `sequence` only; one variant per design |
| 11 | Applicability by business unit/site and phase flag with interim process | Multi-unit customers; staged rollouts | None |
| 12 | Data migration objects and cutover items | Required before build sign-off | None |
| 13 | Period-end calendar | Ties to close-time KPI | None |
| 14 | Document control and sign-off block in report | Cheap credibility gain | Report has status, revision, timestamp; no version history or sign-off table |
| 15 | Objectives/scope section in report | Anchors design to the problem statement | Problem statement exists in project, not rendered in report |

### 5.3 Interviewer coverage needed for each missing piece

`WORKSPACE_FIELDS` has ten catalogue questions and nine step questions. The plan's own As-Is template lists
operating scale, data and assets, and controls, but the catalogue does not ask for them.

| Missing piece | Question area to add (gap key suggestion) |
|---|---|
| Fit-gap, RICEFW | `required_outputs`: printed or sent documents (forms) and their recipients; `custom_tools`: spreadsheets or tools that compute something the business depends on |
| Interfaces | `retained_systems`: which current systems stay after go-live; `external_parties`: portals, banks, partners, regulators exchanging data; per interface: direction, frequency, volume, who owns the data |
| Org structure | `legal_entities_sites`: legal entities, sites, warehouses, sales units in scope and how they relate |
| KPIs, reports | `current_kpis`: what is measured today and the current value; `reports_needed`: who needs which report how often |
| Accounting | Already partly via `current_financial`; add per-step "does anything get posted or valued here" when the step moves goods or money |
| Configuration values | `document_variants`: kinds of orders/returns/credits and the reasons used; numbering conventions that must be kept |
| Roles, approvals | `approval_matrix`: approver by document and value band; `role_split`: who must not do two given things |
| Status, edit rules | Step question: "after this step, what can still be changed and by whom" |
| Applicability, phase | `rollout_scope`: units/sites first versus later, and the interim process until then |
| Migration | `legacy_data`: open items, balances and history to carry over and where they live |
| Period-end | `period_close`: current close steps, duration and owners |
| Volumes | `operating_scale`: transactions per period, peaks, turnaround expectations (in plan template, absent from catalogue) |

---

## 6. Recommendations (prioritised)

Effort: S under a day, M one to three days, L over three days (includes prompt, schema, validator, report and
tests).

### 6.1 Schema additions (`DetailedDesignSchema`)

Add design-level registers rather than enlarging every step, and link steps by ID. Keeps output size bounded
(relevant given the streaming/time-budget work in recent commits) and allows a separate generation stage.

| Pri | Addition | Shape (zod-style) | Validator rule | Effort |
|---|---|---|---|---|
| P1 | `gaps` | `[{id, title, kind: enum(CONFIG, REPORT, FORM, ENHANCEMENT, INTEGRATION, WORKFLOW, PROCESS_CHANGE, DATA), mitigation: text, owner: text, stepIds: ids.min(1), requirementIds: ids, status: enum(PROPOSED, NEEDS_DECISION), decisionIds?}]` | stepIds/requirementIds exist; every EXTENSION or INTEGRATION step is linked from at least one gap | M |
| P1 | `customObjects` (RICEFW) | `[{id, type: enum(REPORT, INTERFACE, CONVERSION, ENHANCEMENT, FORM, WORKFLOW), name, purpose, stepIds, standardAlternative: text, complexity: enum(LOW, MEDIUM, HIGH, UNKNOWN), referenceIds}]` | type INTERFACE must also exist in `interfaces`; EXTENSION steps reference at least one object | M |
| P1 | `interfaces` | `[{id, name, sourceSystem, targetSystem, systemOfRecord, direction: enum(INBOUND, OUTBOUND, BIDIRECTIONAL), pattern: enum(API, MESSAGE, FILE, UI_EMBED, MANUAL_BRIDGE), trigger, frequency, recordType: enum(FULL, DELTA, EVENT), dataObjects: texts, errorHandling, rerun, security, stepIds, referenceIds, decisionIds?}]` | Each retained non-SAP system in discovery appears in at least one interface; frequency/trigger may be an open decision but not blank | M |
| P1 | `kpis` | `[{id, name, definition, baseline: text.nullable(), target: text, owner, sourceStepIds, requirementIds}]` | target must quote or trace to a requirement/desired-outcome source; no invented numbers | S |
| P2 | `steps[].accountingEntries` | `[{event, debit: text, credit: text, basis: text, validation: enum(EVIDENCED, PENDING_VALIDATION)}]` plus `steps[].postingNotApplicableReason` | Exactly one of the two; PENDING when no reference supports it | M |
| P2 | `orgMapping` (and pass project org units into `ToBeInput`) | `[{elementType, code, name, rationale, parentCode, usedByStepIds}]` | codes must come from project org units or be marked PROPOSED | M |
| P2 | `configItems` | `[{id, area, objectType, value: text.nullable(), status: enum(CONFIRMED, PROPOSED, BUSINESS_TO_PROVIDE), owner, stepIds, referenceIds}]` | object names only from references; BUSINESS_TO_PROVIDE becomes a blocker | M |
| P2 | `roles` and `approvals` | `roles:[{id, name, responsibilities, orgRestriction}]`; `approvals:[{id, document, levels:[{approverRoleId, condition}], rejectPath, reworkPath, decisionIds?}]`; `steps[].actorRoleId` | actorRoleId resolves; approval thresholds without evidence must link a decision | M |
| P2 | `statusModels` | `[{document, states: texts, transitions:[{from, to, stepId, guard}]}]`; `steps[].statusChange?` | every statusChange exists in the model; no unreachable state | M |
| P3 | `steps[].processId`, `steps[].stepType` | string, enum(IN_SYSTEM_MANUAL, IN_SYSTEM_AUTOMATIC, OUTSIDE_SYSTEM, DECISION, INTEGRATION) | INTEGRATION steps link an interface | S |
| P3 | `applicability` | `[{scopeUnit, phase: enum(CURRENT, LATER), interimProcess: text.nullable(), stepIds}]` | LATER requires interimProcess | S |
| P3 | `migrationObjects`, `cutoverItems`, `periodEndActivities` | small arrays with owner and linked steps | owners required | M |

### 6.2 Prompt rules (`prompts/to_be.system.md`)

| Pri | Rule | Effort |
|---|---|---|
| P1 | Every EXTENSION, INTEGRATION or MANUAL step must produce a gap entry with a mitigation and, for custom build, a RICEFW object; do not describe custom work only inside `implementation.detail`. | S |
| P1 | Every system named in discovery that stays after go-live, and every external party exchanging data, gets an interface entry; unknown frequency or volume becomes a linked open decision, not a guess. | S |
| P1 | KPIs only from stated desired outcomes or current measures in the sources; baseline null when unknown. | S |
| P2 | State accounting per posting event or explicitly why none; mark PENDING_VALIDATION when no reference supports the posting logic. | S |
| P2 | Use org codes only from supplied org units; anything else is PROPOSED with rationale. | S |
| P2 | Each approval rule names approver role, condition and reject/rework path; thresholds not in sources link a decision. | S |
| P2 | Describe the status model for every document type the scenario creates, including edit/lock after each follow-on document. | S |
| P3 | Write As-Is facts and To-Be statements in separate fields; never restate standard SAP concepts as design content. | S |

### 6.3 Interviewer question areas (`src/lib/workspace-fields.ts`, interview prompt)

| Pri | Addition | Effort |
|---|---|---|
| P1 | Catalogue fields: `retained_systems`, `external_parties`, `current_kpis`, `operating_scale`, `legal_entities_sites` | S |
| P1 | Catalogue fields: `approval_matrix`, `required_outputs` (forms and recipients) | S |
| P2 | Step key `editability` ("after this step, what can still be changed and by whom") and `posting` (does this step move goods or money) | M (step schema, UI, extraction) |
| P2 | Catalogue fields: `rollout_scope`, `legacy_data`, `period_close`, `document_variants`, `role_split` | S |
| P3 | Process-characteristic triggers: ask interface detail only when a non-SAP system is retained; ask migration detail only once scope is confirmed | M |

### 6.4 Report sections (`src/lib/consultant-report.ts` and page/exports)

| Pri | Section | Effort |
|---|---|---|
| P1 | Fit-gap register (gap, kind, mitigation, owner, status, linked steps) | S once schema exists |
| P1 | RICEFW list and interface catalogue tables, linked to steps | S |
| P1 | Objectives and scope header from the project problem statement, plus KPI table | S |
| P2 | Org-structure table, configuration catalogue with "business to provide" items, role/approval matrix | M |
| P2 | Per-step accounting entry table in the step card | S |
| P3 | Document control block: version history from job history, reviewer and sign-off table placeholders | S |
| P3 | Period-end calendar, migration objects and cutover list | S |

### 6.5 Delivery approach

1. Phase A (P1, about 5 files): schema registers `gaps`, `customObjects`, `interfaces`, `kpis`; prompt rules;
   validator cross-links; report tables; three interviewer fields. Extend `fixtures/eval/pump-o2c.json`
   expectations: the retained CRM and the tax portal each yield an interface entry; desired-outcome KPIs appear
   in `kpis` (replacing the regex-on-text check).
2. Phase B (P2): accounting entries, org mapping with project org units passed into the To-Be input, config
   catalogue, roles/approvals, status models. Consider a second generation stage ("blueprint annex") that takes
   the validated step design as input, to keep each call within the time budget.
3. Phase C (P3): step type and IDs, applicability/phase, migration/cutover/period-end, document control.

Each phase: typecheck, lint, unit tests for new validator rules (including a negative case per rule), one live
generation on the synthetic fixture, reviewer score against the rubric in
`docs/to-be-quality-improvement-plan.md`, and the checklist in section 4 above.
