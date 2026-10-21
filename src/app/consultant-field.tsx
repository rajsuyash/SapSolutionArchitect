"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import type { Fact } from "./consultant-api";
import styles from "./consultant.module.css";

export type FactUpdate = { status: "KNOWN" | "UNKNOWN" | "NOT_APPLICABLE" | "OWNER_PENDING";
  value: string | null; rationale: string | null; owner: string | null };
type Mode = "answer" | "not-applicable" | "owner";
type Props = { label: string; question: string; fact: Pick<Fact, "status" | "value" | "rationale" | "owner">;
  disabled: boolean; onSave: (update: FactUpdate) => Promise<boolean>;
  /** Inside a definition list: label is a term. `allowEdit: false` leaves editing of known answers to the group's own toggle. */
  list?: boolean; allowEdit?: boolean };

function Summary({ fact }: { fact: Props["fact"] }) {
  if (fact.status === "KNOWN") return <p className={styles.value}>{fact.value}</p>;
  if (fact.status === "UNKNOWN") return <p className={styles.muted}>Marked as not known yet.</p>;
  if (fact.status === "NOT_APPLICABLE") return <p className={styles.muted}>Not applicable: {fact.rationale}</p>;
  if (fact.status === "OWNER_PENDING") return <p className={styles.muted}>Waiting for {fact.owner} to answer.</p>;
  return <p className={styles.muted}>Not answered yet.</p>;
}

/** One editable discovery detail with the explicit non-answers a consultant needs:
 * unknown, not applicable (with a reason) and "ask the process owner" (with a name). */
export function FieldRow({ label, question, fact, disabled, onSave, list = false, allowEdit = true }: Props) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const labelId = useId();
  const opener = useRef<HTMLButtonElement | null>(null);
  const open = fact.status === "EMPTY" || fact.status === "UNKNOWN" || fact.status === "OWNER_PENDING" || fact.status === "NOT_APPLICABLE";

  function begin(next: Mode, button: HTMLButtonElement) {
    opener.current = button;
    setText(next === "answer" ? fact.value ?? "" : next === "owner" ? fact.owner ?? "" : fact.rationale ?? "");
    setMode(next);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!mode || !value) return;
    setSaving(true);
    const saved = await onSave(mode === "answer" ? { status: "KNOWN", value, rationale: null, owner: null }
      : mode === "owner" ? { status: "OWNER_PENDING", value: null, rationale: null, owner: value }
        : { status: "NOT_APPLICABLE", value: null, rationale: value, owner: null });
    setSaving(false);
    if (saved) { setMode(null); requestAnimationFrame(() => opener.current?.focus()); }
  }
  async function unknown(button: HTMLButtonElement) {
    opener.current = button;
    await onSave({ status: "UNKNOWN", value: null, rationale: null, owner: null });
  }
  const prompt = { answer: question, owner: "Who will answer this?", "not-applicable": "Why does this not apply?" };
  const inputLabel = { answer: "Your answer", owner: "Name of the process owner", "not-applicable": "Reason it does not apply" };

  const Label = list ? "dt" : "h4";
  const Body = list ? "dd" : "div";
  const actions = fact.status !== "KNOWN" || allowEdit;
  return <div role="group" aria-labelledby={labelId} className={styles.field} data-status={fact.status} data-list={list || undefined}>
    <Label id={labelId} className={styles.fieldLabel}>{label}</Label>
    <Body className={styles.fieldBody}>
    {mode === null && <Summary fact={fact} />}
    {mode === null && !disabled && actions && <div className={styles.row}>
      <button type="button" className={styles.small} onClick={(e) => begin("answer", e.currentTarget)}>{fact.status === "KNOWN" ? "Edit" : "Answer"}</button>
      {open && <>
        <button type="button" className={styles.small} onClick={(e) => void unknown(e.currentTarget)} disabled={fact.status === "UNKNOWN"}>I don’t know</button>
        <button type="button" className={styles.small} onClick={(e) => begin("not-applicable", e.currentTarget)}>Not applicable</button>
        <button type="button" className={styles.small} onClick={(e) => begin("owner", e.currentTarget)}>Ask the process owner</button>
      </>}
    </div>}
    {mode !== null && <form onSubmit={(event) => void submit(event)} className={styles.inline}>
      <p className={styles.help}>{prompt[mode]}</p>
      {mode === "answer"
        ? <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={8000} required autoFocus aria-label={inputLabel[mode]} />
        : <input value={text} onChange={(e) => setText(e.target.value)} maxLength={mode === "owner" ? 200 : 1000} required autoFocus aria-label={inputLabel[mode]} />}
      <div className={styles.row}>
        <button type="submit" className={styles.primary} disabled={saving || !text.trim()}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" className={styles.small} onClick={() => { setMode(null); requestAnimationFrame(() => opener.current?.focus()); }} disabled={saving}>Cancel</button>
      </div>
    </form>}
    </Body>
  </div>;
}
