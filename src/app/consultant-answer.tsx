"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api, isUncertain } from "./consultant-api";
import styles from "./consultant-report.module.css";

export type AnswerTarget = { projectId: string; variant: string; jobId: string; revision: number };
type Props = { id: string; state: string; answerable: boolean; answer?: { text: string; answeredAt: string; answeredBy: string }; target: AnswerTarget | null };

const MAX = 2000;
const CONFLICT = "The discovery changed since this page loaded. Reload the page and try again.";
const GENERIC = "Could not save the answer. Try again.";

/** The State cell of a question row: the state, the recorded answer, and the form to record or change it. */
export function AnswerCell({ id, state, answerable, answer, target }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [saved, setSaved] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const key = useRef<{ signature: string; value: string } | null>(null);
  const canAnswer = answerable && target !== null;

  // Runs after the textarea has rendered; not requestAnimationFrame, which can fire before the field exists.
  useEffect(() => { if (open) field.current?.focus(); }, [open]);

  function begin() { setText(answer?.text ?? ""); setError(null); setSaved(""); setOpen(true); }

  async function save() {
    if (!target || saving || !text.trim()) return;
    const body = { expectedRevision: target.revision, command: { type: "ANSWER_QUESTION", sourceJobId: target.jobId, questionId: id, answer: text } };
    const signature = JSON.stringify(body);
    // The same intent reuses its key when the outcome of an earlier try is unknown.
    if (key.current?.signature !== signature) key.current = { signature, value: crypto.randomUUID() };
    setSaving(true); setError(null);
    try {
      await api(`/api/projects/${encodeURIComponent(target.projectId)}/consultant/${encodeURIComponent(target.variant)}/commands`, { body, key: key.current.value });
      key.current = null; setOpen(false); setSaved("Answer saved."); router.refresh();
    } catch (failure) {
      if (!isUncertain(failure)) key.current = null;
      const known = failure instanceof ApiError ? failure : null;
      setError({ conflict: known?.status === 409,
        message: known?.status === 409 ? CONFLICT : known?.status === 400 && known.code === "SENSITIVE_MESSAGE" ? known.message : GENERIC });
    } finally { setSaving(false); }
  }

  const label = `Your answer to ${id}`;
  return <div>
    <p><strong>{state}</strong></p>
    {answer && <>
      <p>Answered by {answer.answeredBy}, {answer.answeredAt}: {answer.text}</p>
      <p className={styles.muted}>Not yet applied: confirm discovery again in the conversation, then generate a new To-Be.</p>
    </>}
    {canAnswer && !open && <button type="button" className={styles.button} onClick={begin}>{answer ? "Change answer" : "Answer"}</button>}
    {canAnswer && open && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor={`answer-${id}`}>{label}</label>
      <textarea id={`answer-${id}`} ref={field} rows={4} maxLength={MAX} value={text} onChange={event => setText(event.target.value)}
        aria-describedby={error ? `answer-error-${id}` : undefined} aria-invalid={error ? true : undefined} style={{ display: "block", width: "100%", margin: "6px 0", font: "inherit" }} />
      {error && <p id={`answer-error-${id}`} role="alert">{error.message}{error.conflict && <> <button type="button" className={styles.button} onClick={() => window.location.reload()}>Reload the page</button></>}</p>}
      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={saving || !text.trim()}>{saving ? "Saving" : "Save"}</button>
        <button type="button" className={styles.button} disabled={saving} onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
      </div>
    </form>}
    <p className={styles.muted} aria-live="polite" role="status">{saved}</p>
  </div>;
}
