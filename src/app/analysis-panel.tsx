"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { createJobService } from "../lib/jobs";

type State = Awaited<ReturnType<ReturnType<typeof createJobService>["latest"]>>;

export function AnalysisPanel({ projectId }: { projectId: string }) {
  const router = useRouter();
  const refreshedJob = useRef<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [version, setVersion] = useState(0);
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/analysis`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        if (response.status === 401) { window.location.replace(`/login?next=${encodeURIComponent(`/projects/${projectId}`)}`); return; }
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error(body.error?.message ?? "Couldn't load analysis");
        if (controller.signal.aborted) return;
        setState(body.data); setError("");
        // The worker updates server-rendered project metadata as well as this
        // panel. Refresh it once per completed job, preserving the user's scroll.
        if (body.data.job?.status === "SUCCEEDED" && refreshedJob.current !== body.data.job.id) {
          refreshedJob.current = body.data.job.id;
          router.refresh();
        }
        if (["QUEUED", "RUNNING"].includes(body.data.job?.status)) timer = setTimeout(refresh, 1500);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Couldn't load analysis");
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint, projectId, version, router]);

  async function analyze() {
    setSubmitting(true); setError("");
    try {
      const target = state?.job?.status === "FAILED" ? `/api/jobs/${state.job.id}/retry` : endpoint;
      const response = await fetch(target, { method: "POST", signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (!response.ok && body.error?.code !== "JOB_ALREADY_RUNNING") throw new Error(body.error?.message ?? "Couldn't start analysis");
      // Reload persisted state, including work started in another browser tab.
      setVersion((value) => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn't start analysis"); }
    finally { setSubmitting(false); }
  }
  const busy = submitting || ["QUEUED", "RUNNING"].includes(state?.job?.status ?? "");
  const result = state?.analysis;
  return <section aria-labelledby="analysis-heading" style={{ margin: "28px 0", borderBlock: "1px solid var(--border)", padding: "24px 0", lineHeight: 1.6 }}>
    <h2 id="analysis-heading" style={{ fontSize: 24 }}>AI scope analysis</h2>
    <p className="panel-description">Draft objectives, pain points, and an SAP process hierarchy from your problem statement. Review the proposal with your team before making design decisions.</p>
    {!state && !error && <p role="status">Loading analysis…</p>}
    {state?.job && <p role="status">{state.job.progressLabel}{busy ? " — you can leave this page and return later." : ""}</p>}
    {state?.job?.status === "FAILED" && <p role="alert">{state.job.error?.message ?? "Analysis failed. Please retry."}</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setVersion((value) => value + 1)}>Refresh analysis</button></div>}
    {state?.canAnalyze && <button type="button" className="primary-button" onClick={() => void analyze()} disabled={busy}>
      {busy ? "Analyzing…" : state.job?.status === "FAILED" ? "Retry analysis" : result ? "Run a new analysis" : "Analyze business problem"}
    </button>}
    {result && <div data-testid="analysis-result" style={{ overflowWrap: "anywhere" }}>
      <h3>Proposed scope</h3><p>{result.scopeSummary}</p>
      {result.inputTruncated && <p role="note">The problem statement was shortened to fit the analysis limit.</p>}
      <h3>Business objectives</h3><ul>{result.objectives.map((item) => <li key={item.id}>{item.text}</li>)}</ul>
      {result.painPoints.length > 0 && <><h3>Pain points</h3><ul>{result.painPoints.map((item) => <li key={item.id}>
        <strong>{item.text}</strong><blockquote style={{ marginInline: 16 }}>“{item.quote}”</blockquote>
      </li>)}</ul></>}
      <h3>Proposed processes</h3>
      <ul style={{ listStyle: "none", padding: 0 }}>{result.proposedProcesses.map((item) => <li key={item.ref}
        style={{ marginLeft: (item.level - 1) * 20, marginBlock: 12, borderLeft: "2px solid var(--border)", paddingLeft: 12 }}>
        <strong>L{item.level} · {item.name}</strong> <span>{item.module}</span>
        <p style={{ margin: "4px 0" }}>{item.rationale}</p>
      </li>)}</ul>
      {result.clarifyingQuestions.length > 0 && <><h3>Questions for your team</h3><ul>{result.clarifyingQuestions.map((question, index) => <li key={index}>{question}</li>)}</ul></>}
      <p className="panel-description">Demo: scope review is available here. Scope confirmation, detailed design, and blueprint export are still in development.</p>
    </div>}
  </section>;
}
