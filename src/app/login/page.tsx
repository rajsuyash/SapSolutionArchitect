import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "../auth-ui";
import { getPageSession, loginDestination } from "../../lib/page-auth";
import { googleEnabled } from "../../lib/google-oauth";
import { getRuntime } from "../../lib/runtime";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[]; error?: string | string[] }> }) {
  const { next, error } = await searchParams;
  const { user } = await getPageSession();
  const destination = loginDestination(next, user?.orgRole);
  if (user) redirect(destination);
  return (
    <div className="login-layout">
      <section className="introduction" aria-labelledby="workspace-heading">
        <p className="eyebrow">Your process design workspace</p>
        <h2 id="workspace-heading">From workshop notes to a shared Blueprint.</h2>
        <p>Keep the current process, proposed changes, and approvals connected in one SAP Business Blueprint.</p>
        <ol className="workflow" aria-label="Process design stages">
          <li><div><strong>Capture the As-Is</strong><span>Describe how the process works today.</span></div></li>
          <li><div><strong>Assess the gaps</strong><span>Connect requirements to a proposed resolution.</span></div></li>
          <li><div><strong>Design the To-Be</strong><span>Trace each change back to its source.</span></div></li>
          <li><div><strong>Review and compile</strong><span>Bring approved change documents into the Blueprint.</span></div></li>
        </ol>
      </section>
      <section className="access-panel" aria-labelledby="login-heading">
        <h1 id="login-heading">Sign in to your workspace</h1>
        <p className="panel-description">Access your projects and process reviews.</p>
        <AuthForm mode="login" destination={destination} google={googleEnabled(getRuntime().config)} googleFailed={error === "google"} />
      </section>
    </div>
  );
}
