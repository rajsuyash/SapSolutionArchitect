import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <article className="access-panel" style={{ maxWidth: 760, margin: "40px auto", lineHeight: 1.65, fontSize: 15 }}>
      <h1>Privacy</h1>
      <p className="panel-description">Last updated 2026-10-22. SAP Solution Architect is operated by Suyash Raj. Contact: <a href="mailto:suyash@voxdonna.com">suyash@voxdonna.com</a>.</p>
      <h2>What we collect</h2>
      <ul>
        <li>Your name and email address, and your Google account identifier if you use Google sign-in.</li>
        <li>The workspace and project content you enter, including discovery answers and documents.</li>
        <li>Usage metadata, such as the number of AI jobs you run and their token usage.</li>
      </ul>
      <h2>Why</h2>
      <p>To provide the service, to apply trial and fair-use limits, and to give you support.</p>
      <h2>Who processes it</h2>
      <ul>
        <li>Google Cloud hosts the application and its database in europe-west1 (Belgium).</li>
        <li>Anthropic processes the content you submit to an AI feature in order to generate its output.</li>
      </ul>
      <h2>Cookies</h2>
      <p>We set a session cookie to keep you signed in and, during Google sign-in, a short-lived sign-in cookie. We do not use advertising or analytics trackers.</p>
      <h2>Retention</h2>
      <p>We keep your data until you ask us to delete your account, by email.</p>
      <h2>Your rights</h2>
      <p>You can ask to access, correct or delete your data by emailing <a href="mailto:suyash@voxdonna.com">suyash@voxdonna.com</a>.</p>
    </article>
  );
}
