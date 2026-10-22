"use client";

import { useState } from "react";
import styles from "./admin.module.css";
import { usd, when } from "./format";

export type AdminOrg = { id: string; name: string; createdAt: string; trialEndsAt: string | null; dailyAiJobQuota: number;
  suspendedAt: string | null; userCount: number; projectCount: number; lastLoginAt: string | null; jobsToday: number;
  jobs30d: number; inputTokens30d: number; outputTokens30d: number; estimatedCostUsd30d: number };
type Saved = Pick<AdminOrg, "trialEndsAt" | "dailyAiJobQuota" | "suspendedAt">;
type Message = { ok: boolean; text: string } | null;


function Row({ org }: { org: AdminOrg }) {
  const [saved, setSaved] = useState<Saved>(org);
  const [trial, setTrial] = useState(org.trialEndsAt?.slice(0, 10) ?? "");
  const [quota, setQuota] = useState(String(org.dailyAiJobQuota));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const suspended = saved.suspendedAt !== null;

  async function send(patch: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/organizations/${org.id}`, { method: "PATCH", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch), signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok || result.success !== true) {
        setMessage({ ok: false, text: typeof result.error?.message === "string" ? result.error.message : "Could not save." });
        return;
      }
      const next: Saved = result.data.organization;
      setSaved(next);
      setTrial(next.trialEndsAt?.slice(0, 10) ?? "");
      setQuota(String(next.dailyAiJobQuota));
      setMessage({ ok: true, text: "Saved." });
    } catch {
      setMessage({ ok: false, text: "Could not save. Try again." });
    } finally { setBusy(false); }
  }

  function save() {
    const patch: Record<string, unknown> = {};
    const savedDay = saved.trialEndsAt?.slice(0, 10) ?? "";
    if (trial !== savedDay) patch.trialEndsAt = trial || null;
    const wanted = Number(quota);
    if (!quota.trim() || !Number.isInteger(wanted) || wanted < 1 || wanted > 10000) {
      return setMessage({ ok: false, text: "Quota must be a whole number from 1 to 10000." });
    }
    if (wanted !== saved.dailyAiJobQuota) patch.dailyAiJobQuota = wanted;
    if (!Object.keys(patch).length) return setMessage({ ok: true, text: "No changes." });
    return send(patch);
  }

  return <tr className={suspended ? styles.suspended : undefined}>
    <td><strong>{org.name}</strong><br /><span className={suspended ? `${styles.badge} ${styles.badgeBad}` : styles.badge}>
      {suspended ? "Suspended" : "Active"}</span></td>
    <td>{when(org.createdAt)}</td>
    <td className={styles.num}>{org.userCount}</td>
    <td className={styles.num}>{org.projectCount}</td>
    <td>{when(org.lastLoginAt)}</td>
    <td className={styles.num}>{org.jobsToday} / {org.jobs30d}</td>
    <td className={styles.num}>{org.inputTokens30d.toLocaleString("en-US")} / {org.outputTokens30d.toLocaleString("en-US")}</td>
    <td className={styles.num}>{usd(org.estimatedCostUsd30d)}</td>
    <td><div className={styles.controls}>
      <input type="date" aria-label={`Trial end date for ${org.name}`} value={trial} onChange={(e) => setTrial(e.target.value)} disabled={busy} />
      <button type="button" disabled={busy || !trial} onClick={() => setTrial("")}>No expiry</button>
      <input className={styles.quota} type="number" min={1} max={10000} step={1} aria-label={`Daily AI job quota for ${org.name}`}
        value={quota} onChange={(e) => setQuota(e.target.value)} disabled={busy} />
      <button type="button" className={styles.save} disabled={busy} onClick={save}>Save</button>
      <button type="button" disabled={busy} onClick={() => send({ suspended: !suspended })}>{suspended ? "Unsuspend" : "Suspend"}</button>
    </div><div role="status" className={message?.ok ? styles.ok : styles.error}>{message?.text}</div></td>
  </tr>;
}

export function AdminWorkspaces({ orgs }: { orgs: AdminOrg[] }) {
  return <div className={styles.scroll}><table className={styles.table}>
    <thead><tr><th>Workspace</th><th>Created</th><th className={styles.num}>Users</th><th className={styles.num}>Projects</th>
      <th>Last login</th><th className={styles.num}>AI jobs 24h / 30d</th><th className={styles.num}>Tokens in / out (30d)</th>
      <th className={styles.num}>Cost (30d)</th><th>Trial end, quota, status</th></tr></thead>
    <tbody>{orgs.map((org) => <Row key={org.id} org={org} />)}</tbody>
  </table></div>;
}
