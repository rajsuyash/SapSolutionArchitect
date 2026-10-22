import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <article className="access-panel" style={{ maxWidth: 760, margin: "40px auto", lineHeight: 1.65, fontSize: 15 }}>
      <h1>Terms</h1>
      <p className="panel-description">Last updated 2026-10-22. SAP Solution Architect is operated by Suyash Raj. Contact: <a href="mailto:suyash@voxdonna.com">suyash@voxdonna.com</a>.</p>
      <h2>Trial service</h2>
      <p>The service is a trial, provided as is and without warranty of any kind. We may change or end the trial at any time.</p>
      <h2>AI output</h2>
      <p>AI output can be wrong or incomplete. A qualified SAP consultant must review it before you rely on it. Nothing here is SAP certified or implies SAP endorsement.</p>
      <h2>Acceptable use</h2>
      <p>Do not submit unlawful content, and do not try to break the service&apos;s security or get around its limits.</p>
      <h2>Fair use and suspension</h2>
      <p>Each workspace has a trial period and a daily limit on AI jobs. We may suspend a workspace that exceeds fair use or breaks these terms.</p>
      <h2>Contact</h2>
      <p><a href="mailto:suyash@voxdonna.com">suyash@voxdonna.com</a></p>
    </article>
  );
}
