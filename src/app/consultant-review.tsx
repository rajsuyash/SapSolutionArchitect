"use client";

import { useId, useState, type FormEvent } from "react";
import type { WorkspaceView } from "./consultant-api";
import styles from "./consultant.module.css";

type Proposal = WorkspaceView["proposals"][number];
type Observation = WorkspaceView["observations"][number];

/** A model suggestion is never an answer until the person accepts it, edits it or rejects it. */
export function ProposalCard({ label, proposal, disabled, onAccept, onReject, onEdit }: {
  label: string; proposal: Proposal; disabled: boolean;
  onAccept: () => Promise<boolean>; onReject: () => Promise<boolean>; onEdit: (value: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(proposal.value);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  async function act(work: () => Promise<boolean>) { setBusy(true); const ok = await work(); setBusy(false); if (ok) setEditing(false); }
  async function save(event: FormEvent) { event.preventDefault(); if (text.trim()) await act(() => onEdit(text.trim())); }
  const off = disabled || busy;
  return <li className={styles.card} aria-labelledby={titleId} data-testid="proposal">
    <h4 id={titleId} className={styles.fieldLabel}>{label}</h4>
    {proposal.operation === "PROPOSE_REPLACE" && proposal.previousValue && <p className={styles.muted}>Currently: {proposal.previousValue}</p>}
    {!editing && <>
      <p className={styles.help}>Suggested answer, taken from what you shared</p>
      <blockquote className={styles.quote}>{proposal.quote}</blockquote>
      <div className={styles.row}>
        <button type="button" className={styles.primary} disabled={off} onClick={() => void act(onAccept)}>Accept</button>
        <button type="button" className={styles.small} disabled={off} onClick={() => setEditing(true)}>Edit</button>
        <button type="button" className={styles.small} disabled={off} onClick={() => void act(onReject)}>Reject</button>
      </div>
    </>}
    {editing && <form onSubmit={(event) => void save(event)} className={styles.inline}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={8000} required autoFocus aria-label={`Corrected answer for ${label}`} />
      <div className={styles.row}>
        <button type="submit" className={styles.primary} disabled={off || !text.trim()}>Save my answer</button>
        <button type="button" className={styles.small} disabled={off} onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </form>}
  </li>;
}

/** A possible contradiction or follow-up: closing it needs a short reason, kept with the record. */
export function ObservationCard({ labels, observation, disabled, onReview }: {
  labels: string[]; observation: Observation; disabled: boolean;
  onReview: (decision: "DISMISS" | "RESOLVE", rationale: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  async function review(decision: "DISMISS" | "RESOLVE") { setBusy(true); await onReview(decision, reason.trim()); setBusy(false); }
  const off = disabled || busy || !reason.trim();
  return <li className={styles.card} aria-labelledby={titleId} data-testid="observation">
    <h4 id={titleId} className={styles.fieldLabel}>{observation.kind === "POSSIBLE_CONFLICT" ? "Possible contradiction" : "Suggested follow-up"}</h4>
    <p>{observation.detail}</p>
    <p className={styles.muted}>Related to: {labels.join(", ")}</p>
    <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} aria-label={`Reason for closing: ${observation.detail.slice(0, 60)}`}
      placeholder="Reason (required)" />
    <div className={styles.row}>
      <button type="button" className={styles.small} disabled={off} onClick={() => void review("RESOLVE")}>Mark resolved</button>
      <button type="button" className={styles.small} disabled={off} onClick={() => void review("DISMISS")}>Dismiss</button>
    </div>
  </li>;
}
