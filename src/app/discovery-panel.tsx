"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { DiscoveryInput } from "../lib/discovery";
import { cleanDiscovery, DiscoveryFields, emptyDiscovery, quoteIssue } from "./discovery-fields";
import styles from "./discovery.module.css";

export type Variant = { variantCode: string; variantName: string; version: number };
type Snapshot = { id: string; variantCode: string; version: number; input: DiscoveryInput };
type Attempt = { key: string; body: string; code: string };
class CaptureError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
async function read<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (response.ok && body.success !== true) throw new Error("Unconfirmed response");
  if (!response.ok) {
    throw new CaptureError(typeof body.error?.message === "string" ? body.error.message : "Could not complete this request.",
      response.status, body.error?.code ?? "UNKNOWN");
  }
  if (!body.data || typeof body.data !== "object") throw new Error("Invalid response");
  return body.data as T;
}

export function DiscoveryPanel({ projectId, initialVariants, canCreate }:
  { projectId: string; initialVariants: Variant[]; canCreate: boolean }) {
  const [variants, setVariants] = useState(initialVariants);
  const [input, setInput] = useState<DiscoveryInput | null>(null);
  const [code, setCode] = useState("");
  const [version, setVersion] = useState(0);
  const [latestVersion, setLatestVersion] = useState(0);
  const [canEdit, setCanEdit] = useState(canCreate);
  const [dirty, setDirty] = useState(false);
  const [review, setReview] = useState(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [signin, setSignin] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState("");
  const active = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/discovery`;
  const historical = version > 0 && version < latestVersion;
  const readOnly = !canEdit || historical;

  useEffect(() => {
    if (!dirty && !uncertain) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, uncertain]);

  function showError(text: string) {
    setError(text);
    requestAnimationFrame(() => document.getElementById("capture-error")?.focus());
  }
  function mayDiscard() {
    return (!dirty && !uncertain) || window.confirm("Discard your unsaved edits and load the saved data? Download your draft first if you need to keep it.");
  }
  function resetFlags() {
    attempt.current = null; setDirty(false); setUncertain(false); setConflict(false);
    setError(""); setSignin(false); setMessage(""); setReview(false);
  }
  function create() {
    if (active.current || !mayDiscard()) return;
    resetFlags(); setCode(""); setVersion(0); setLatestVersion(0); setCanEdit(canCreate); setInput(emptyDiscovery());
  }
  async function load(codeToLoad: string, revision?: number) {
    if (active.current || !mayDiscard()) return;
    active.current = true; setPending(true); setError(""); setMessage("");
    try {
      const data = await read<{ snapshot: Snapshot | null; canEdit: boolean }>(await fetch(
        `${endpoint}/${encodeURIComponent(codeToLoad)}${revision ? `?version=${revision}` : ""}`,
        { cache: "no-store", signal: AbortSignal.timeout(15000) }));
      if (!data.snapshot) throw new Error("That saved revision is not available.");
      resetFlags(); setInput(data.snapshot.input); setCode(codeToLoad); setVersion(data.snapshot.version); setCanEdit(data.canEdit);
      if (!revision) setLatestVersion(data.snapshot.version);
      setMessage(`Loaded revision ${data.snapshot.version}.`);
    } catch (failure) {
      setSignin(failure instanceof CaptureError && failure.status === 401);
      showError(failure instanceof CaptureError ? failure.message : "Could not load the revision. Your current edits are still here; try opening it again.");
    } finally { active.current = false; setPending(false); }
  }
  function change(value: DiscoveryInput) { setInput(value); setDirty(true); setMessage(""); setReview(false); }
  function validate() {
    if (!form.current?.reportValidity() || !input) return false;
    const issue = quoteIssue(input);
    if (issue) { showError(issue); return false; }
    return true;
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (active.current || readOnly || !input || (!attempt.current && !validate())) return;
    if (!attempt.current) attempt.current = { key: crypto.randomUUID(), code,
      body: JSON.stringify({ expectedVersion: version, input: cleanDiscovery(input) }) };
    active.current = true; setPending(true); setError(""); setSignin(false);
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(attempt.current.code)}`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key },
        body: attempt.current.body, signal: AbortSignal.timeout(15000),
      });
      const data = await read<{ snapshot: Snapshot }>(response);
      if (!data.snapshot?.id || !Number.isSafeInteger(data.snapshot.version) || !data.snapshot.input) throw new Error("Unconfirmed save");
      const saved = data.snapshot;
      resetFlags(); setInput(saved.input); setCode(saved.variantCode); setVersion(saved.version); setLatestVersion(saved.version);
      setVariants(items => [...items.filter(item => item.variantCode !== saved.variantCode),
        { variantCode: saved.variantCode, variantName: saved.input.variantName, version: saved.version }].sort((a, b) => a.variantCode.localeCompare(b.variantCode)));
      setMessage(`Saved revision ${saved.version}. Sources and requirements are ready for review.`);
    } catch (failure) {
      if (failure instanceof CaptureError && failure.status < 500 && failure.status !== 408 && !uncertain) {
        attempt.current = null;
        setSignin(failure.status === 401);
        setConflict(failure.code === "DISCOVERY_CONFLICT");
        showError(failure.code === "DISCOVERY_CONFLICT"
          ? "A newer revision was saved elsewhere. Your edits are still here. Download your draft before loading the latest revision."
          : `${failure.message} Your edits have been kept.`);
      } else {
        // A lost response may follow a committed transaction. Reuse both the
        // original payload and key until a retry confirms the outcome.
        setUncertain(true); setSignin(failure instanceof CaptureError && failure.status === 401);
        showError("We could not confirm the save. Keep this page open and retry the same save to avoid a duplicate revision.");
      }
    } finally { active.current = false; setPending(false); }
  }
  function download() {
    if (!input) return;
    const blob = new Blob([JSON.stringify({ expectedVersion: version, input: cleanDiscovery(input) }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url;
    link.download = `discovery-${code.replace(/[^A-Z0-9_-]/g, "") || "draft"}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className={styles.workspace}>
    <p className="panel-description">Capture the operational detail that a useful To-Be plan needs: what happens today, the evidence behind it, and what must change.</p>
    <div className={styles.notice}>These are discovery inputs, not an approved design. Detailed AI generation and workbook import are still in development.</div>
    <h2>Process variants</h2>
    {variants.length ? <ul className={styles.variants} aria-label="Process variants">{variants.map(item => <li key={item.variantCode}>
      <div><strong>{item.variantName}</strong><small>{item.variantCode} · Revision {item.version}</small></div>
      <button type="button" disabled={pending} onClick={() => void load(item.variantCode)}>Open {item.variantName}</button>
    </li>)}</ul> : <p>No detailed process inputs saved yet.</p>}
    {canCreate && <button type="button" disabled={pending || uncertain} onClick={create}>Add process variant</button>}
    {pending && <p role="status">Working…</p>}
    {message && <p role="status" className={styles.notice}>{message}</p>}
    {error && <div id="capture-error" role="alert" tabIndex={-1} className={styles.error}>{error}
      {signin && <p><a href="/login" target="_blank" rel="noopener">Sign in in a new tab, then retry here</a></p>}
      {conflict && <button type="button" disabled={pending} onClick={() => void load(code)}>Load latest and discard my edits</button>}
    </div>}
    {input && <form ref={form} onSubmit={event => void save(event)} aria-label="Detailed discovery" aria-busy={pending}>
      <h2>{version ? `Discovery revision ${version}` : "New process variant"}</h2>
      {version > 0 && <div><label htmlFor="capture-saved-revision">Saved revision</label><select id="capture-saved-revision" value={version} disabled={pending || uncertain}
        onChange={event => void load(code, Number(event.target.value))}>
        {Array.from({ length: latestVersion }, (_, i) => i + 1).reverse().map(item =>
          <option value={item} key={item}>Revision {item}{item === latestVersion ? " (latest)" : ""}</option>)}
      </select></div>}
      {readOnly && <p className={styles.notice}>{historical ? "Historical revision — read-only. Select the latest revision to continue editing." : "You have read-only access to these inputs."}</p>}
      {review && <p className={styles.notice}>Review draft: check the current process, each requirement and its source quote before saving.</p>}
      <fieldset disabled={pending || uncertain || readOnly || review}>
        <label htmlFor="capture-variant-code">Process variant code</label><input id="capture-variant-code" value={code} required pattern="[A-Z][A-Z0-9_\-]{0,39}" maxLength={40}
          readOnly={version > 0} onChange={event => { setCode(event.target.value.toUpperCase()); setDirty(true); }} />
        <p className={styles.help}>A short label such as RENTAL or SERVICE. Use letters, numbers, underscores or hyphens.</p>
        <DiscoveryFields value={input} change={change} />
      </fieldset>
      <div className={styles.actions}>
        {!readOnly && <button type="button" disabled={pending || uncertain} onClick={() => {
          if (review) setReview(false);
          else if (validate()) { setError(""); setReview(true); window.scrollTo({ top: form.current?.offsetTop ?? 0, behavior: "instant" }); }
        }}>{review ? "Continue editing" : "Review draft"}</button>}
        {!readOnly && <button type="submit" className={styles.save} disabled={pending || (!dirty && !uncertain) || conflict}>
          {pending ? "Saving…" : uncertain ? "Retry same save" : "Save revision"}
        </button>}
        <button type="button" onClick={download}>Download my draft</button>
      </div>
      <p className={styles.help}>{dirty ? "You have unsaved changes." : "No unsaved changes."} Saving creates a new revision; earlier revisions remain available.</p>
    </form>}
  </div>;
}
