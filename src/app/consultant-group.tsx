"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Fact } from "./consultant-api";
import type { FactUpdate } from "./consultant-field";
import styles from "./consultant.module.css";

export type GroupField = { id: string; label: string; fact: Pick<Fact, "status" | "value" | "rationale" | "owner"> };
type Props = { heading: ReactNode; toggleLabel: string; formLabel: string; fields: GroupField[]; disabled: boolean;
  onSave: (changes: { id: string; update: FactUpdate }[]) => Promise<boolean>; children: ReactNode };

/** One heading and one edit toggle for a whole group of details. Display mode shows `children`
 * (each open detail keeps its own unknown / not-applicable / ask-the-owner actions); edit mode is a single form. */
export function EditableGroup({ heading, toggleLabel, formLabel, fields, disabled, onSave, children }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const canEdit = !disabled && fields.some(field => field.fact.status === "KNOWN");

  function close() { setEditing(false); requestAnimationFrame(() => opener.current?.focus()); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const changes = fields.flatMap(({ id, fact }) => {
      const value = (draft[id] ?? "").trim();
      return value && !(fact.status === "KNOWN" && fact.value === value)
        ? [{ id, update: { status: "KNOWN" as const, value, rationale: null, owner: null } }] : [];
    });
    if (!changes.length) { close(); return; }
    setSaving(true);
    const saved = await onSave(changes);
    setSaving(false);
    if (saved) close();
  }

  return <>
    <div className={styles.groupHead}>
      {heading}
      {canEdit && <button ref={opener} type="button" className={styles.small} aria-expanded={editing} disabled={saving}
        onClick={() => {
          if (editing) { close(); return; }
          setDraft(Object.fromEntries(fields.map(({ id, fact }) => [id, fact.status === "KNOWN" ? fact.value ?? "" : ""])));
          setEditing(true);
        }}>{toggleLabel}</button>}
    </div>
    {editing
      ? <form aria-label={formLabel} onSubmit={(event) => void submit(event)} className={styles.inline}>
        {fields.map(({ id, label, fact }) => <div key={id}>
          <label htmlFor={`edit-${id}`}>{label}</label>
          {fact.status !== "KNOWN" && <p className={styles.help}>Currently unanswered. Leave blank to keep it that way.</p>}
          <textarea id={`edit-${id}`} rows={2} maxLength={8000} value={draft[id] ?? ""} onChange={(e) => setDraft({ ...draft, [id]: e.target.value })} />
        </div>)}
        <div className={styles.row}>
          <button type="submit" className={styles.primary} disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
          <button type="button" className={styles.small} onClick={close} disabled={saving}>Cancel</button>
        </div>
      </form>
      : children}
  </>;
}
