import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageSession } from "../../lib/page-auth";
import { getRuntime } from "../../lib/runtime";
import { AdminWorkspaces } from "./admin-workspaces";
import styles from "./admin.module.css";
import { usd, when } from "./format";

export const metadata: Metadata = { title: "Platform admin" };
export const dynamic = "force-dynamic";

const SIGN_IN = { google: "Google", password: "Password", both: "Google + password" } as const;

export default async function AdminPage() {
  const { user, token } = await requirePageSession("/admin");
  const { platformAdmin } = getRuntime();
  if (!platformAdmin.isAdminEmail(user.email)) notFound();
  const { totals, pricing, organizations, users } = await platformAdmin.overview(token);
  return <div className={styles.root}>
    <h1>Platform admin</h1>
    <p className={styles.lede}>All workspaces. Costs are estimates from token counts at ${pricing.inputUsdPerMTok} / ${pricing.outputUsdPerMTok} per million input / output tokens.</p>
    <ul className={styles.totals} aria-label="Totals">
      <li><strong>{totals.workspaces}</strong><span>Workspaces</span></li>
      <li><strong>{totals.users}</strong><span>Users</span></li>
      <li><strong>{totals.jobsToday}</strong><span>AI jobs, last 24h</span></li>
      <li><strong>{usd(totals.estimatedCostUsd30d)}</strong><span>Cost, last 30 days</span></li>
    </ul>
    <h2>Workspaces</h2>
    <AdminWorkspaces orgs={organizations} />
    <h2>Users</h2>
    <div className={styles.scroll}><table className={styles.table}>
      <thead><tr><th>Email</th><th>Name</th><th>Workspace</th><th>Role</th><th>Sign-in</th><th>Created</th><th>Last login</th></tr></thead>
      <tbody>{users.map((u) => <tr key={u.id}>
        <td>{u.email}</td><td>{u.name}</td><td>{u.orgName}</td><td>{u.orgRole}</td><td>{SIGN_IN[u.signIn]}</td>
        <td>{when(u.createdAt)}</td><td>{when(u.lastLoginAt)}</td></tr>)}</tbody>
    </table></div>
  </div>;
}
