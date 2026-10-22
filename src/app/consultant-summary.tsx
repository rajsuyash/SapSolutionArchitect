"use client";

import { useState, type ReactNode } from "react";
import { REQUIREMENT_KIND_LABELS, STEP_KEYS, STEP_LABELS, WORKSPACE_FIELDS, describeBlocker, describeField, describeProposal,
  requirementLabel, stepLabel } from "../lib/workspace-fields";
import { isActive, type Command, type Fact, type JobView, type Workspace, type WorkspaceView } from "./consultant-api";
import { FieldRow, type FactUpdate } from "./consultant-field";
import { EditableGroup, type GroupField } from "./consultant-group";
import { ObservationCard, ProposalCard } from "./consultant-review";
import styles from "./consultant.module.css";

export type Run = (commands: Command | Command[]) => Promise<boolean>;
type Props = { workspace: Workspace & { state: WorkspaceView }; jobs: JobView[]; locked: boolean; run: Run;
  onGenerate: () => Promise<boolean>; reportHref: (jobId: string) => string };

/** The command that records a fact depends on which kind of detail the id belongs to. */
function setFact(state: WorkspaceView, fieldId: string, update: FactUpdate): Command {
  const body = { ...update, sourceId: null, quote: null };
  if (state.stepDrafts.some(draft => fieldId.startsWith(`${draft.id}_`))) return { type: "SET_STEP_DRAFT_FIELD", fieldId, ...body };
  const requirement = state.requirementDrafts.find(draft => `${draft.id}_statement` === fieldId);
  if (requirement) return { type: "SET_REQUIREMENT_DRAFT_STATEMENT", requirementDraftId: requirement.id, ...body };
  return { type: "SET_FIELD", fieldId, ...body };
}

function Section({ id, title, children, hint }: { id: string; title: string; children: ReactNode; hint?: string }) {
  return <section aria-labelledby={id} className={styles.section}>
    <h3 id={id}>{title}</h3>{hint && <p className={styles.muted}>{hint}</p>}{children}
  </section>;
}

function resultCopy(job: JobView | undefined, current: boolean) {
  if (!job) return null;
  if (isActive(job)) return "Generating the To-Be design from your confirmed understanding. You can leave this page and return.";
  if (job.status === "FAILED") return job.error?.message ?? "The To-Be design could not be generated. Your confirmed answers are safe; you can retry.";
  if (job.status !== "SUCCEEDED") return null;
  const lead = job.result?.status === "BLOCKED"
    ? `A To-Be draft was generated but is blocked${job.result.blockerCount ? ` by ${job.result.blockerCount} issue${job.result.blockerCount === 1 ? "" : "s"}` : ""}. It has not been approved.`
    : "A To-Be draft was generated and needs human review. It has not been approved or verified against SAP.";
  return `${lead}${current ? "" : " Discovery changed after it was generated; confirm again before generating a new draft."}`;
}

export function ConsultantSummary({ workspace, jobs, locked, run, onGenerate, reportHref }: Props) {
  const { state, readiness } = workspace;
  const editable = workspace.canEdit && !locked;
  const confirmed = !!workspace.confirmedSnapshotId && !!state.confirmation;
  const toBe = jobs.find(job => job.kind === "TO_BE");
  const [requirement, setRequirement] = useState({ kind: "PAIN_POINT" as keyof typeof REQUIREMENT_KIND_LABELS, stepId: "", critical: false });
  const steps = [...state.steps, ...state.stepDrafts];
  const stepId = steps.some(step => step.id === requirement.stepId) ? requirement.stepId : steps[0]?.id ?? "";
  const pending = state.proposals.filter(proposal => proposal.status === "PENDING");
  const reviews = state.observations.filter(observation => observation.status === "PENDING");
  type Plain = Pick<Fact, "status" | "value" | "rationale" | "owner">;
  const fieldRow = (id: string, fact: Plain, label?: string, grouped = false) => {
    const info = describeField(state, id);
    return <FieldRow key={id} label={label ?? info.label} question={info.question} fact={fact} disabled={!editable}
      list={grouped} allowEdit={!grouped} onSave={(update) => run(setFact(state, id, update))} />;
  };
  const saveGroup = (changes: { id: string; update: FactUpdate }[]) => run(changes.map(change => setFact(state, change.id, change.update)));
  const catalogFields = (domain: string): GroupField[] => WORKSPACE_FIELDS.filter(field => field.domain === domain)
    .map(field => ({ id: field.id, label: field.label, fact: state.facts.find(fact => fact.id === field.id)! }));
  /** A catalog section: one heading, one edit toggle, answers shown as a definition list. */
  const catalogGroup = (domain: string, headingId: string, title: string, toggleLabel: string) => {
    const fields = catalogFields(domain);
    return <EditableGroup heading={<h3 id={headingId}>{title}</h3>} toggleLabel={toggleLabel} formLabel={`Edit ${title.toLowerCase()}`}
      fields={fields} disabled={!editable} onSave={saveGroup}>
      <dl className={styles.fieldList}>{fields.map(field => fieldRow(field.id, field.fact, undefined, true))}</dl>
    </EditableGroup>;
  };
  const unresolved = [...state.facts, ...state.stepDrafts.flatMap(draft => draft.fields), ...state.requirementDrafts.map(draft => draft.statement)]
    .filter(fact => fact.status === "UNKNOWN" || fact.status === "OWNER_PENDING");

  return <div className={styles.summary} data-testid="summary">
    <Section id="readiness-heading" title="Ready to confirm?">
      {readiness?.ready
        ? <p role="status" className={styles.ok}>Everything required is answered. {confirmed ? "You have confirmed this understanding." : "Review it once more, then confirm."}</p>
        : <><p role="status">{readiness?.blockers.length ?? 0} thing{readiness?.blockers.length === 1 ? "" : "s"} still needed before this can be confirmed:</p>
          <ul data-testid="blockers">{readiness?.blockers.map((blocker, index) => <li key={index}>{describeBlocker(state, blocker)}</li>)}</ul></>}
      {workspace.canConfirm
        ? <div className={styles.row}>
          <button type="button" className={styles.primary} disabled={!editable || !readiness?.ready || confirmed}
            onClick={() => void run({ type: "CONFIRM" })}>{confirmed ? "Confirmed" : "Confirm current process"}</button>
          {confirmed && <button type="button" className={styles.primary} disabled={!editable || isActive(toBe)} onClick={() => void onGenerate()}>
            {toBe?.status === "FAILED" ? "Retry To-Be generation" : toBe ? "Generate a new To-Be draft" : "Generate To-Be design"}</button>}
        </div>
        : <p className={styles.muted}>Only project leads and consultants can confirm. You can still answer questions and add details.</p>}
      {confirmed && <p className={styles.muted}>Any change to the answers will require confirming again.</p>}
      {toBe && <p id="to-be-status" role="status" data-testid="to-be-status" data-state={toBe.result?.status ?? toBe.status}>
        {resultCopy(toBe, toBe.result?.sourceRevision === state.confirmation?.revision)}</p>}
      {toBe?.status === "SUCCEEDED" && <p><a href={reportHref(toBe.id)} data-testid="report-link">Open the To-Be report</a>
        <span className={styles.muted}> — compare current and proposed steps, then print or download it.</span></p>}
    </Section>

    {pending.length > 0 && <Section id="proposals-heading" title="Proposed answers to review" hint="Nothing becomes part of the record until you accept it.">
      {editable && pending.length > 1 && <div className={styles.row}>
        <button type="button" className={styles.primary} data-testid="accept-all"
          onClick={() => void run({ type: "DECIDE_PROPOSALS", ids: pending.map(proposal => proposal.id), decision: "ACCEPT" })}>
          Accept all {pending.length}</button>
        <span className={styles.muted}>Anything that no longer fits your current answers stays here for you to check.</span>
      </div>}
      <ul className={styles.list}>{pending.map(proposal => {
        const label = describeProposal(state, proposal);
        const isField = proposal.operation === "PROPOSE_SET" || proposal.operation === "PROPOSE_REPLACE";
        return <ProposalCard key={proposal.id} label={label} proposal={proposal} disabled={!editable}
          onAccept={() => run({ type: "DECIDE_PROPOSAL", proposalId: proposal.id, decision: "ACCEPT" })}
          onReject={() => run({ type: "DECIDE_PROPOSAL", proposalId: proposal.id, decision: "REJECT" })}
          onEdit={isField ? (value) => run([setFact(state, proposal.fieldId, { status: "KNOWN", value, rationale: null, owner: null }),
            { type: "DECIDE_PROPOSAL", proposalId: proposal.id, decision: "REJECT" }]) : undefined} />;
      })}</ul>
    </Section>}

    {reviews.length > 0 && <Section id="observations-heading" title="Points to check">
      <ul className={styles.list}>{reviews.map(observation => <ObservationCard key={observation.id} observation={observation} disabled={!editable}
        labels={observation.fieldIds.map(id => describeField(state, id).label)}
        onReview={(decision, rationale) => run({ type: "REVIEW_OBSERVATION", observationId: observation.id, decision, rationale })} />)}</ul>
    </Section>}

    <section aria-labelledby="context-heading" className={styles.section}>{catalogGroup("CONTEXT", "context-heading", "Business context", "Edit answers")}</section>

    <section aria-labelledby="asis-heading" className={styles.section}>
      {catalogGroup("AS_IS", "asis-heading", "Current process (As-Is)", "Edit answers")}
      <h4 className={styles.subheading}>Current steps</h4>
      {steps.length === 0 && <p className={styles.muted}>No steps yet. Describe how the work happens today in the chat, or add a step here.</p>}
      {state.steps.map((step, index) => <article key={step.id} className={styles.card} aria-label={`Step ${index + 1}: ${step.name}`}>
        <h4 className={styles.fieldLabel}>Step {index + 1}: {step.name}</h4>
        <dl className={styles.fieldList}>
          <div className={styles.field}><dt className={styles.fieldLabel}>Who does it</dt><dd className={styles.fieldBody}>{step.actor}</dd></div>
          <div className={styles.field}><dt className={styles.fieldLabel}>System or record used</dt><dd className={styles.fieldBody}>{step.system}</dd></div>
          <div className={styles.field}><dt className={styles.fieldLabel}>What starts it</dt><dd className={styles.fieldBody}>{step.trigger}</dd></div>
          <div className={styles.field}><dt className={styles.fieldLabel}>What happens</dt><dd className={styles.fieldBody}>{step.description}</dd></div>
        </dl>
      </article>)}
      {state.stepDrafts.map(draft => {
        const label = stepLabel(state, draft.id);
        const fields: GroupField[] = STEP_KEYS.map(key => ({ id: `${draft.id}_${key}`, label: STEP_LABELS[key],
          fact: draft.fields.find(field => field.id === `${draft.id}_${key}`)! }));
        return <article key={draft.id} className={styles.card} aria-label={label}>
          <EditableGroup heading={<h4 className={styles.fieldLabel}>{label}</h4>} toggleLabel="Edit step" formLabel={`Edit ${label}`}
            fields={fields} disabled={!editable} onSave={saveGroup}>
            <dl className={styles.fieldList}>{fields.map(field => fieldRow(field.id, field.fact, field.label, true))}</dl>
          </EditableGroup>
        </article>;
      })}
      {workspace.canEdit && <button type="button" className={styles.small} disabled={!editable}
        onClick={() => void run({ type: "START_STEP_DRAFT" })}>Add a current step</button>}
    </section>

    <Section id="requirements-heading" title="Pain points and requirements">
      {state.requirements.length + state.requirementDrafts.length === 0 && <p className={styles.muted}>None recorded yet.</p>}
      {state.requirements.map(item => <article key={item.id} className={styles.card}>
        <h4 className={styles.fieldLabel}>{REQUIREMENT_KIND_LABELS[item.kind]} for {stepLabel(state, item.asIsStepId)}{item.critical ? " (critical)" : ""}</h4>
        <p>{item.statement}</p></article>)}
      {state.requirementDrafts.map(draft => <article key={draft.id} className={styles.card}>
        {fieldRow(draft.statement.id, draft.statement, `${requirementLabel(state, draft.id)}${draft.critical ? " (critical)" : ""}`)}
      </article>)}
      {workspace.canEdit && <form className={styles.inline} aria-label="Add a pain point or requirement" onSubmit={(event) => {
        event.preventDefault(); if (stepId) void run({ type: "START_REQUIREMENT_DRAFT", asIsStepId: stepId, kind: requirement.kind, critical: requirement.critical });
      }}>
        <div className={styles.row}>
          <select aria-label="What kind of item" value={requirement.kind} disabled={!editable}
            onChange={(e) => setRequirement({ ...requirement, kind: e.target.value as typeof requirement.kind })}>
            {Object.entries(REQUIREMENT_KIND_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
          <select aria-label="Which current step" value={stepId} disabled={!editable || !steps.length}
            onChange={(e) => setRequirement({ ...requirement, stepId: e.target.value })}>
            {steps.length === 0 && <option value="">Add a step first</option>}
            {steps.map(step => <option key={step.id} value={step.id}>{stepLabel(state, step.id)}</option>)}
          </select>
          <label className={styles.check}><input type="checkbox" checked={requirement.critical} disabled={!editable}
            onChange={(e) => setRequirement({ ...requirement, critical: e.target.checked })} /> Critical</label>
          <button type="submit" className={styles.small} disabled={!editable || !stepId}>Add item</button>
        </div>
      </form>}
    </Section>

    <section aria-labelledby="desired-heading" className={styles.section}>{catalogGroup("DESIRED", "desired-heading", "Desired future", "Edit answers")}</section>

    <Section id="open-heading" title="Open decisions" hint="Items marked unknown or waiting on someone. They stay visible until answered.">
      {unresolved.length === 0 ? <p className={styles.muted}>None.</p> : <ul data-testid="open-decisions">{unresolved.map(fact => {
        const info = describeField(state, fact.id);
        return <li key={fact.id}>{info.label} — {fact.status === "OWNER_PENDING" ? `waiting for ${fact.owner}` : "not known yet"}</li>;
      })}</ul>}
    </Section>
  </div>;
}
