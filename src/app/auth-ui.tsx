"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type FormEvent } from "react";
import type { SessionUser } from "../lib/auth";

type FormError = { message: string; field?: string };
const errorStyle = { color: "#a32626", fontSize: 14, lineHeight: 1.5 };
const subscribeToHydration = () => () => {};
const hydrated = () => true;
const serverRendered = () => false;

// Protected navigation refreshes both page authorization and the root layout.
// A Next client navigation can retain the old signed-in header after revocation.
export function WorkspaceLink(props: ComponentProps<"a"> & { href: string }) {
  return <a {...props} />;
}

export function AuthForm({ mode, destination = "/projects", google = false, googleFailed = false }:
{ mode: "login" | "signup"; destination?: string; google?: boolean; googleFailed?: boolean }) {
  const signup = mode === "signup";
  const form = useRef<HTMLFormElement>(null);
  const sending = useRef(false);
  const [valid, setValid] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const fields = signup ? ["name", "email", "password", "orgName"] : ["email", "password"];
  const labels: Record<string, string> = { name: "Full name", email: "Work email", password: "Password", orgName: "Organisation name" };

  // Covers restored form values and browser/password-manager autofill.
  useEffect(() => { setValid(form.current?.checkValidity() ?? false); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !form.current?.reportValidity()) return;
    sending.current = true;
    const input = Object.fromEntries(new FormData(form.current));
    let leaving = false;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/auth/${mode}`, { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok || result.success !== true) {
        const field = fields.includes(result.error?.field) ? result.error.field as string : undefined;
        const message = response.status === 429 ? "Too many attempts. Wait a few minutes, then try again."
          : response.status >= 500 ? "Something went wrong. Please try again."
            : typeof result.error?.message === "string" ? result.error.message : "Please try again.";
        setError({ message, field });
        requestAnimationFrame(() => {
          const target = field ? form.current?.elements.namedItem(field) : document.getElementById("auth-error");
          if (target instanceof HTMLElement) target.focus();
        });
        return;
      }
      // A full navigation discards the previous user's client router/layout cache.
      const target = !signup && destination === "/projects" && result.data.user.orgRole === "GUEST" ? "/review" : destination;
      leaving = true;
      window.location.replace(target);
    } catch {
      setError({ message: "Couldn't reach the server. Your entries are still here. Try again." });
    } finally {
      if (!leaving) { sending.current = false; setPending(false); }
    }
  }

  return <form ref={form} onSubmit={submit} onInput={() => setValid(form.current?.checkValidity() ?? false)}
    onChange={() => setValid(form.current?.checkValidity() ?? false)} onFocus={() => setValid(form.current?.checkValidity() ?? false)} aria-busy={pending}>
    <fieldset disabled={pending}>
      {fields.map((field) => <div key={field}>
        <label htmlFor={field}>{labels[field]}</label>
        <input id={field} name={field} required type={field === "password" ? "password" : field === "email" ? "email" : "text"}
          autoComplete={field === "password" ? signup ? "new-password" : "current-password"
            : field === "email" ? "username" : field === "name" ? "name" : "organization"}
          maxLength={field === "email" ? 254 : field === "name" ? 120 : field === "orgName" ? 160 : undefined}
          minLength={signup && field === "password" ? 10 : undefined}
          pattern={signup && field === "password" ? "(?=.*[A-Za-z])(?=.*[0-9]).{10,}" : field === "name" || field === "orgName" ? ".*\\S.*" : undefined}
          aria-invalid={error?.field === field || undefined}
          aria-describedby={[signup && field === "password" ? "password-help" : "", error?.field === field ? `${field}-error` : ""].filter(Boolean).join(" ") || undefined}
          style={error?.field === field ? { borderColor: "#a32626", marginBottom: 8 } : undefined} />
        {error?.field === field && <p id={`${field}-error`} role="alert" style={errorStyle}>{error.message}</p>}
        {signup && field === "password" && <p id="password-help" className="panel-description" style={{ margin: "-8px 0 22px" }}>
          Use at least 10 characters, including a letter and a number.
        </p>}
      </div>)}
      {error && !error.field && <p id="auth-error" role="alert" tabIndex={-1} style={errorStyle}>{error.message}</p>}
      <button className="primary-button" type="submit" disabled={!valid || pending} data-action={mode} data-primary-cta>
        {pending ? signup ? "Creating account…" : "Signing in…" : signup ? "Create account" : "Sign in"}
      </button>
    </fieldset>
    {googleFailed && <p role="alert" style={errorStyle}>Google sign-in didn&apos;t complete. Try again, or use your email and password.</p>}
    {google && <WorkspaceLink className="primary-button google-button" href="/api/auth/google/start" data-action="google">Continue with Google</WorkspaceLink>}
    <p className="signup-link">{signup ? <Link href="/login">Back to sign in</Link>
      : <>New here? <Link href="/signup">Create account</Link></>}</p>
  </form>;
}

export function SessionMenu({ user }: { user: Pick<SessionUser, "name"> | null }) {
  const ready = useSyncExternalStore(subscribeToHydration, hydrated, serverRendered);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener("pageshow", restore);
    return () => window.removeEventListener("pageshow", restore);
  }, []);
  if (!user) return <span className="session-label">Signed out</span>;
  async function logout() {
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("Logout failed");
      window.location.replace("/login");
    } catch { setFailed(true); setPending(false); }
  }
  return <div className="session-label" style={{ whiteSpace: "normal", textAlign: "right", maxWidth: 220 }}>
    <span data-testid="session-user" style={{ overflowWrap: "anywhere" }}>{user.name}</span>{" · "}
    <button type="button" onClick={logout} disabled={!ready || pending} data-action="logout"
      style={{ border: 0, background: "transparent", color: "var(--accent)", textDecoration: "underline", cursor: "pointer", padding: 4 }}>
      {pending ? "Signing out…" : "Sign out"}
    </button>
    {failed && <p role="alert" style={errorStyle}>Couldn&apos;t sign out. Try again.</p>}
  </div>;
}
