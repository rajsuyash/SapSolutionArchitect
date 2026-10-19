import type { Metadata } from "next";
import { getPageSession } from "../lib/page-auth";
import { SessionMenu, WorkspaceLink as Link } from "./auth-ui";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AI SAP Program Manager",
    template: "%s | AI SAP Program Manager",
  },
  description: "A shared workspace for SAP process design, review, and Business Blueprints.",
  icons: {
    icon: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#126354"/><text x="16" y="21" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="white">PM</text></svg>')}`,
  },
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { user } = await getPageSession();
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <header className="topbar" data-testid="app-shell-header">
          <Link className="brand" href="/">
            <span className="brand-mark" aria-hidden="true">PM</span>
            <span>AI SAP Program Manager</span>
          </Link>
          <nav aria-label="Primary navigation">
            <Link href="/projects">Projects</Link>
            <Link href="/review">Review</Link>
            {(!user || user.orgRole === "ADMIN") && <Link href="/admin/reference-library">Reference library</Link>}
          </nav>
          <SessionMenu user={user ? { name: user.name } : null} />
        </header>
        <main id="main-content" tabIndex={-1}>{children}</main>
      </body>
    </html>
  );
}
