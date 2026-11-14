"use client";

import { useEffect, useState, type ReactNode } from "react";
import { REQUIREMENT_KIND_LABELS, STEP_KEYS, STEP_LABELS, WORKSPACE_FIELDS, describeBlocker, describeField, describeProposal,
  requirementLabel, stepLabel } from "../lib/workspace-fields";
import { isActive, type Command, type Fact, type JobView, type Workspace, type WorkspaceView } from "./consultant-api";
import { FieldRow, type FactUpdate } from "./consultant-field";
import { EditableGroup, type GroupField } from "./consultant-group";
import { ObservationCard, ProposalCard } from "./consultant-review";
import styles from "./consultant.module.css";
import { SupportLink, isAccountBlocked, needsSupport } from "./support";

export type Run = (commands: Command | Command[]) => Promise<boolean>;
type Props = { workspace: Workspace & { state: WorkspaceView }; jobs: JobView[]; locked: boolean; run: Run;
  onGenerate: () => Promise<boolean>; reportHref: (jobId: string) => string; generateError: { message: string; code: string } | null };

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

/** A reference section that folds away. Native <details> keeps the children mounted, so drafts being typed survive a collapse.
 * It is open while something is recorded in it, unless the person has chosen otherwise; their explicit choice always wins. */
function Collapsible({ id, title, figure, recorded, hint, children }: { id: string; title: string; figure: string; recorded: boolean; hint?: string; children: ReactNode }) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? recorded;
  return <section aria-labelledby={id} className={styles.section}>
    <details open={open} onToggle={(event) => {
      // React changing the attribute also fires "toggle"; only a state that differs from what was rendered is the person's doing.
      if (event.currentTarget.open !== open) setChoice(event.currentTarget.open);
    }} className={styles.fold}>
      <summary className={styles.foldRow}><h3 id={id}>{title}</h3><span className={styles.figure}>{figure}</span></summary>
      {hint && <p className={styles.muted}>{hint}</p>}{children}
    </details>
  </section>;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const BLOCKER_PREVIEW = 3;
/** The project's problem statement is copied into "Business problem" when the conversation is created, so it says nothing about
 * whether the person has started answering and must not, on its own, open a section. */
const PREFILLED = new Set(["business_problem"]);
/** "answered" counts real answers and explicit not-applicable; "recorded" also counts unknown / waiting-on-owner. */
function tally(fields: readonly { id: string; fact: { status: string } }[]) {
  return { answered: fields.filter(({ fact }) => fact.status === "KNOWN" || fact.status === "NOT_APPLICABLE").length, total: fields.length,
    recorded: fields.some(({ id, fact }) => fact.status !== "EMPTY" && !PREFILLED.has(id)) };
}

function resultCopy(job: JobView | undefined, current: boolean) {
  if (!job) return null;
  if (job.status === "FAILED") return job.error?.message ?? "The To-Be design could not be generated. Your confirmed answers are safe; you can retry.";
  if (job.status !== "SUCCEEDED") return null;
  const lead = job.result?.status === "BLOCKED"
    ? `A To-Be draft was generated but is blocked${job.result.blockerCount ? ` by ${job.result.blockerCount} issue${job.result.blockerCount === 1 ? "" : "s"}` : ""}. It has not been approved.`
    : "A To-Be draft was generated and needs human review. It has not been approved or verified against SAP.";
  return `${lead}${current ? "" : " Discovery changed after it was generated; confirm again before generating a new draft."}`;
}

const PROGRESS_TICK_MS = 5000;
const duration = (ms: number) => { const total = Math.floor(ms / 1000); return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`; };
/** The job view carries no start time, so this counts from when this page first saw the job running; it never claims a total.
 * The ticking figure sits outside the live region so screen readers hear the status once, not every few seconds. */
function GenerationProgress() {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), PROGRESS_TICK_MS); return () => clearInterval(timer); }, []);
  return <>
    <p id="to-be-status" role="status" data-testid="to-be-status" data-state="RUNNING">Generating the To-Be design from your confirmed understanding. This usually takes several minutes. You can leave this page and return.</p>
    <p className={styles.muted} data-testid="to-be-elapsed">{duration(now - since)} watched on this page so far.</p>
  </>;
}

export function ConsultantSummary({ workspace, jobs, locked, run, onGenerate, reportHref, generateError }: Props) {
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
  /** A catalog section body: one edit toggle, answers shown as a definition list. The heading lives in the section's summary row. */
  const catalogGroup = (domain: string, title: string, toggleLabel: string) => {
    const fields = catalogFields(domain);
    return <EditableGroup heading={null} toggleLabel={toggleLabel} formLabel={`Edit ${title.toLowerCase()}`}
      fields={fields} disabled={!editable} onSave={saveGroup}>
      <dl className={styles.fieldList}>{fields.map(field => fieldRow(field.id, field.fact, undefined, true))}</dl>
    </EditableGroup>;
  };
  const blockers = readiness?.blockers ?? [];
  const blockerItem = (blocker: (typeof blockers)[number], index: number) => <li key={index}>{describeBlocker(state, blocker)}</li>;
  const context = tally(catalogFields("CONTEXT"));
  const asIs = tally(catalogFields("AS_IS"));
  const desired = tally(catalogFields("DESIRED"));
  const requirementCount = state.requirements.length + state.requirementDrafts.length;
  const softBlockers = readiness?.blockers.filter(blocker => blocker.soft) ?? [];
  const draftConfirmed = confirmed && !!state.confirmation?.withGaps && !readiness?.ready;
  const generateBlocked = !!generateError && (isAccountBlocked(generateError.code) || generateError.code === "RATE_LIMITED"); // asking again cannot help
  const canConfirmDraft = !readiness?.ready && !!readiness?.draftReady && !confirmed;
  const unresolved = [...state.facts, ...state.stepDrafts.flatMap(draft => draft.fields), ...state.requirementDrafts.map(draft => draft.statement)]
    .filter(fact => fact.status === "UNKNOWN" || fact.status === "OWNER_PENDING");

  return <div className={styles.summary} data-testid="summary">
    {readiness && <p className={styles.headline} role="status" data-testid="progress">
      {readiness.ready ? "Everything needed is answered." : draftConfirmed
        ? `Confirmed as a draft: ${plural(blockers.length, "open item")} carried into the To-Be as open questions.`
        : `${plural(blockers.length, "thing")} still needed before you can confirm.`}</p>}
    <Section id="readiness-heading" title="Ready to confirm?">
      {readiness?.ready
        ? <p role="status" className={styles.ok}>Everything required is answered. {confirmed ? "You have confirmed this understanding." : "Review it once more, then confirm."}</p>
        : <><p>{draftConfirmed ? "Open items carried into the To-Be:" : "Still needed before this can be confirmed:"}</p>
          <div data-testid="blockers"><ul>{blockers.slice(0, BLOCKER_PREVIEW).map(blockerItem)}</ul>
            {blockers.length > BLOCKER_PREVIEW && <details><summary className={styles.more}>Show all {blockers.length}</summary>
              <ul>{blockers.slice(BLOCKER_PREVIEW).map((blocker, index) => blockerItem(blocker, index + BLOCKER_PREVIEW))}</ul></details>}</div>
          {canConfirmDraft && workspace.canConfirm && <>
            <p id="draft-gaps-note" className={styles.muted}>Nothing else blocks a draft. You can confirm now and the To-Be will carry these as &lsquo;to confirm&rsquo; or open questions:</p>
            <ul data-testid="draft-gaps">{softBlockers.map((blocker, index) => <li key={index}>{describeBlocker(state, blocker)}</li>)}</ul></>}</>}
      {workspace.canConfirm
        ? <div className={styles.row}>
          <button type="button" className={styles.primary} disabled={!editable || !readiness?.ready || confirmed}
            onClick={() => void run({ type: "CONFIRM" })}>{confirmed ? "Confirmed" : "Confirm current process"}</button>
          {canConfirmDraft && <button type="button" className={styles.small} data-testid="confirm-draft" aria-describedby="draft-gaps-note"
            disabled={!editable} onClick={() => void run({ type: "CONFIRM", allowGaps: true })}>Confirm as draft with gaps</button>}
          {confirmed && <button type="button" className={styles.primary} disabled={!editable || isActive(toBe) || generateBlocked} onClick={() => void onGenerate()}>
            {isActive(toBe) ? "Generating To-Be design…" : toBe?.status === "FAILED" ? "Retry To-Be generation" : toBe ? "Generate a new To-Be draft" : "Generate To-Be design"}</button>}
        </div>
        : <p className={styles.muted}>Only project leads and consultants can confirm. You can still answer questions and add details.</p>}
      {confirmed && <p className={styles.muted}>Any change to the answers will require confirming again.</p>}
      {generateError && <div role="alert" className={styles.alert} data-testid="to-be-error"><p>{generateError.message}</p>
        {needsSupport(generateError.code) && <p><SupportLink /></p>}</div>}
      {/* A newer refusal replaces the older job's failure text instead of sitting beside it. */}
      {!generateError && isActive(toBe) && <GenerationProgress key={toBe!.id} />}
      {!generateError && toBe && !isActive(toBe) && <p id="to-be-status" role="status" data-testid="to-be-status" data-state={toBe.result?.status ?? toBe.status}>
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

    <Collapsible id="context-heading" title="Business context" figure={`${context.answered} of ${context.total} answered`} recorded={context.recorded}>
      {catalogGroup("CONTEXT", "Business context", "Edit answers")}
    </Collapsible>

    <Collapsible id="asis-heading" title="Current process (As-Is)" recorded={asIs.recorded || steps.length > 0}
      figure={`${plural(steps.length, "step")}, ${asIs.answered} of ${asIs.total} answered`}>
      {catalogGroup("AS_IS", "Current process (As-Is)", "Edit answers")}
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
    </Collapsible>

    <Collapsible id="requirements-heading" title="Pain points and requirements" recorded={requirementCount > 0}
      figure={requirementCount ? `${requirementCount} recorded` : "none yet"}>
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
    </Collapsible>

    <Collapsible id="desired-heading" title="Desired future" figure={`${desired.answered} of ${desired.total} answered`} recorded={desired.recorded}>
      {catalogGroup("DESIRED", "Desired future", "Edit answers")}
    </Collapsible>

    <Collapsible id="open-heading" title="Open decisions" recorded={unresolved.length > 0} figure={unresolved.length ? `${unresolved.length} open` : "none"}
      hint="Items marked unknown or waiting on someone. They stay visible until answered.">
      {unresolved.length === 0 ? <p className={styles.muted}>None.</p> : <ul data-testid="open-decisions">{unresolved.map(fact => {
        const info = describeField(state, fact.id);
        return <li key={fact.id}>{info.label} — {fact.status === "OWNER_PENDING" ? `waiting for ${fact.owner}` : "not known yet"}</li>;
      })}</ul>}
    </Collapsible>
  </div>;
}
