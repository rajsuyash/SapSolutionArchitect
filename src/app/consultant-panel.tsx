"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, api, isActive, isUncertain, variantCodeFor, type Command, type JobView, type VariantSummary, type Workspace } from "./consultant-api";
import { ConsultantChat } from "./consultant-chat";
import { ConsultantSummary } from "./consultant-summary";
import styles from "./consultant.module.css";

type Tab = "chat" | "summary";
const DEFAULT_CODE = "MAIN";
const POLL_MS = 1500;
const withJob = (jobs: JobView[], job: JobView) => [job, ...jobs.filter(item => item.id !== job.id)];
const messageOf = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Try again.";

/** Resumes from server state on every load; nothing but the unsent draft lives only in the browser. */
export function ConsultantPanel({ projectId }: { projectId: string }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/consultant`;
  const [variants, setVariants] = useState<VariantSummary[] | null>(null);
  const [code, setCode] = useState(DEFAULT_CODE);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const [attempt, setAttempt] = useState(0);
  const [pollFailures, setPollFailures] = useState(0);
  const [starting, setStarting] = useState(false);
  // One user intent keeps one idempotency key until the server gives a definite answer.
  const keys = useRef(new Map<string, string>());
  const busyRef = useRef(false);

  const load = useCallback(async (variant: string) => {
    const [next, list] = await Promise.all([api<Workspace>(`${base}/${encodeURIComponent(variant)}`),
      api<{ jobs: JobView[] }>(`${base}/${encodeURIComponent(variant)}/jobs`)]);
    setWorkspace(next); setJobs(list.jobs);
    return next;
  }, [base]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = (await api<{ variants: VariantSummary[] }>(base)).variants;
        const first = list[0]?.variantCode ?? DEFAULT_CODE;
        if (cancelled) return;
        setVariants(list); setCode(first); setLoadError("");
        await load(first);
      } catch (failure) { if (!cancelled) setLoadError(messageOf(failure)); }
    })();
    return () => { cancelled = true; };
  }, [base, load, attempt]);

  const busy = isActive(jobs[0]);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(async () => {
      try {
        const list = await api<{ jobs: JobView[] }>(`${base}/${encodeURIComponent(code)}/jobs`);
        if (isActive(list.jobs[0])) setJobs(list.jobs); else await load(code);
      } catch { setPollFailures(count => count + 1); }
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [busy, jobs, code, base, load, pollFailures]);

  const keyFor = (intent: string) => {
    let key = keys.current.get(intent);
    if (!key) { key = crypto.randomUUID(); keys.current.set(intent, key); }
    return key;
  };
  /** Serialises writes (each depends on the latest revision) and reports failures in one place. */
  async function guarded(work: () => Promise<boolean>): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true; setPending(true); setError("");
    try { return await work(); }
    catch (failure) {
      const conflict = failure instanceof ApiError && failure.status === 409;
      setError(failure instanceof ApiError && failure.code === "WORKSPACE_CONFLICT"
        ? "This conversation was updated by someone else or by the consultant. The latest version is shown; your change was not saved, so please make it again."
        : messageOf(failure));
      if (conflict) await load(code).catch(() => {});
      return false;
    } finally { busyRef.current = false; setPending(false); }
  }
  async function send<T>(intent: string, path: string, body: unknown): Promise<T> {
    try { const result = await api<T>(`${base}/${encodeURIComponent(code)}/${path}`, { body, key: keyFor(intent) }); keys.current.delete(intent); return result; }
    catch (failure) { if (!isUncertain(failure)) keys.current.delete(intent); throw failure; }
  }

  const run = (commands: Command | Command[]) => guarded(async () => {
    let current = workspace!;
    for (const command of Array.isArray(commands) ? commands : [commands]) {
      // Sequential commands each need the revision the previous one produced.
      const revision = current.state!.revision;
      current = await send<Workspace>(`cmd:${revision}:${JSON.stringify(command)}`, "commands", { expectedRevision: revision, command });
      setWorkspace(current);
    }
    return true;
  });

  const sendMessage = (text: string) => guarded(async () => {
    const revision = workspace!.state!.revision;
    try {
      const result = await send<{ workspace: Workspace; job: JobView }>(`msg:${revision}:${text}`, "messages", { expectedRevision: revision, text });
      setWorkspace(result.workspace); setJobs(items => withJob(items, result.job));
      return true;
    } catch (failure) {
      // The message is saved before the reply is queued: do not make the person send it twice.
      const fresh = await load(code).catch(() => null);
      const last = fresh?.state?.messages.at(-1);
      if (fresh?.state && fresh.state.revision > revision && last?.role === "user" && last.text === text) {
        setError(`Your message was saved, but the consultant could not start replying (${messageOf(failure)}) Use “Ask the consultant to reply again”.`);
        return true;
      }
      throw failure;
    }
  });
  const retryReply = () => guarded(async () => {
    const state = workspace!.state!; const last = state.messages.at(-1);
    if (last?.role !== "user") return false;
    const result = await send<{ job: JobView }>(`retry:${state.revision}:${last.id}`, "interview", { expectedRevision: state.revision, messageId: last.id });
    setJobs(items => withJob(items, result.job));
    return true;
  });
  const generate = () => guarded(async () => {
    const revision = workspace!.state!.revision;
    const result = await send<{ job: JobView }>(`tobe:${revision}`, "to-be", { expectedRevision: revision });
    setJobs(items => withJob(items, result.job));
    return true;
  });
  const start = (name: string, release: string) => guarded(async () => {
    const next = variantCodeFor(name, (variants ?? []).map(item => item.variantCode));
    const created = await api<Workspace>(`${base}/${next}`, { body: { variantName: name, targetRelease: release || null }, key: keyFor(`create:${next}:${name}:${release}`) });
    keys.current.delete(`create:${next}:${name}:${release}`);
    setVariants(items => [...(items ?? []), { variantCode: next, variantName: name, revision: 1, confirmedSnapshotId: null }]);
    setCode(next); setWorkspace(created); setJobs([]); setStarting(false); setTab("chat");
    requestAnimationFrame(() => document.getElementById("consultant-message")?.focus());
    return true;
  });
  async function choose(next: string) {
    setError(""); setCode(next); setWorkspace(null); setJobs([]);
    try { await load(next); } catch (failure) { setLoadError(messageOf(failure)); }
  }

  const state = workspace?.state ?? null;
  const lastMessage = state?.messages.at(-1);
  const failedJob = jobs[0]?.kind === "INTERVIEW" && jobs[0].status === "FAILED" ? jobs[0] : undefined;
  const summaryBadge = state ? state.proposals.filter(item => item.status === "PENDING").length + state.observations.filter(item => item.status === "PENDING").length : 0;
  function tabKeys(event: KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const next: Tab = tab === "chat" ? "summary" : "chat";
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
  }

  return <div className={styles.root}>
    {loadError && <div role="alert" className={styles.alert}><p>{loadError}</p>
      <button type="button" className={styles.small} onClick={() => { setLoadError(""); setAttempt(count => count + 1); }}>Try again</button></div>}
    {!workspace && !loadError && <p role="status">Loading your conversation…</p>}
    {workspace && variants && variants.length > 0 && <div className={styles.row}>
      {variants.length > 1 && <label className={styles.variant}>Process variant
        <select value={code} onChange={(e) => void choose(e.target.value)} disabled={pending}>
          {variants.map(item => <option key={item.variantCode} value={item.variantCode}>{item.variantName}</option>)}
        </select></label>}
      {workspace.canEdit && !starting && <button type="button" className={styles.small} onClick={() => setStarting(true)}>Start another process variant</button>}
    </div>}
    {workspace && (!state || starting) && <StartForm canEdit={workspace.canEdit} pending={pending} error={error} onStart={start}
      onCancel={state ? () => setStarting(false) : undefined} />}
    {workspace && state && !starting && <>
      <div role="tablist" aria-label="Conversation sections" className={styles.tabs} onKeyDown={tabKeys}>
        <button role="tab" id="tab-chat" type="button" aria-selected={tab === "chat"} aria-controls="pane-chat" tabIndex={tab === "chat" ? 0 : -1}
          onClick={() => setTab("chat")}>Chat</button>
        <button role="tab" id="tab-summary" type="button" aria-selected={tab === "summary"} aria-controls="pane-summary" tabIndex={tab === "summary" ? 0 : -1}
          onClick={() => setTab("summary")}>Summary{summaryBadge ? ` (${summaryBadge} to review)` : ""}</button>
      </div>
      <div className={styles.layout} data-tab={tab}>
        <section id="pane-chat" role="tabpanel" aria-labelledby="tab-chat" className={styles.chatPane} aria-label="Chat">
          <ConsultantChat problem={state.problemStatement} messages={state.messages} questions={state.questions}
            waiting={busy && jobs[0]?.kind === "INTERVIEW"} canEdit={workspace.canEdit} error={error}
            needsRetry={lastMessage?.role === "user" && !busy && !pending}
            failure={failedJob?.error?.message ?? null} onSend={sendMessage} onRetry={() => void retryReply()} />
        </section>
        <section id="pane-summary" role="tabpanel" aria-labelledby="tab-summary" className={styles.summaryPane} aria-label="Summary">
          <h2 className={styles.paneTitle}>What I understand so far</h2>
          {busy && <p className={styles.notice} role="status">Editing is paused while the consultant works, so nothing changes underneath you.</p>}
          <ConsultantSummary workspace={{ ...workspace, state }} jobs={jobs} locked={busy || pending} run={run} onGenerate={generate}
            reportHref={(jobId) => `/projects/${encodeURIComponent(projectId)}/consultant/${encodeURIComponent(code)}/to-be/${encodeURIComponent(jobId)}`} />
        </section>
      </div>
    </>}
  </div>;
}

function StartForm({ canEdit, pending, error, onStart, onCancel }: { canEdit: boolean; pending: boolean; error: string;
  onStart: (name: string, release: string) => Promise<boolean>; onCancel?: () => void }) {
  const [name, setName] = useState("");
  const [release, setRelease] = useState("");
  if (!canEdit) return <p className={styles.notice}>No discovery conversation has been started for this project, and you have read-only access.</p>;
  async function submit(event: FormEvent) { event.preventDefault(); if (name.trim()) await onStart(name.trim(), release.trim()); }
  return <form onSubmit={(event) => void submit(event)} className={styles.start} aria-labelledby="start-heading">
    <h2 id="start-heading">Start the discovery conversation</h2>
    <p className={styles.muted}>Describe the business problem in your own words. The consultant will ask a few focused questions at a time and build the current-process summary with you.</p>
    <label htmlFor="variant-name">Which process are we discussing?</label>
    <input id="variant-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required placeholder="For example: Equipment hire" />
    <label htmlFor="target-release">Target SAP release (optional)</label>
    <input id="target-release" value={release} onChange={(e) => setRelease(e.target.value)} maxLength={200} placeholder="Leave blank if not decided" />
    {error && <div role="alert" className={styles.alert}><p>{error}</p></div>}
    <div className={styles.row}>
      <button type="submit" className={styles.primary} disabled={pending || !name.trim()}>{pending ? "Starting…" : "Start the conversation"}</button>
      {onCancel && <button type="button" className={styles.small} onClick={onCancel} disabled={pending}>Cancel</button>}
    </div>
  </form>;
}
