"use client";

import { useRef, useState, type CSSProperties, type FormEvent } from "react";
import { WorkspaceLink as Link } from "./auth-ui";

const control: CSSProperties = { width: "100%", padding: 12, border: "1px solid var(--border)", borderRadius: 8,
  background: "var(--surface)", color: "var(--foreground)", font: "inherit", marginBottom: 20 };
const secondary: CSSProperties = { padding: "10px 14px", border: "1px solid var(--border)", borderRadius: 8,
  background: "var(--surface)", color: "var(--accent)", font: "inherit", fontSize: 14, cursor: "pointer" };
const unitTypes = { COMPANY_CODE: "Company code", PLANT: "Plant", SALES_ORG: "Sales organisation", REGION: "Region" };
type Attempt = { key: string; body: string };
type FormError = { message: string; field?: string; signin?: boolean };

export function ProjectForm() {
  const form = useRef<HTMLFormElement>(null);
  const sending = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const nextUnit = useRef(0);
  const [units, setUnits] = useState<number[]>([]);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [valid, setValid] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const check = () => setValid(form.current?.checkValidity() ?? false);
  const fieldProps = (name: string) => ({ id: name, name, "aria-invalid": error?.field === name || undefined,
    "aria-describedby": error?.field === name ? "project-error" : undefined });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || !form.current || (!attempt.current && !form.current.reportValidity())) return;
    if (!attempt.current) {
      const data = new FormData(form.current);
      const input = Object.fromEntries(["name", "clientName", "problemStatement", "targetProduct", "startingLandscape"].map((key) => [key, data.get(key)]));
      attempt.current = { key: crypto.randomUUID(), body: JSON.stringify({ ...input,
        modules: String(data.get("modules") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
        orgUnits: units.map((_, index) => Object.fromEntries(["type", "code", "name"].map((key) => [key, data.get(`orgUnits.${index}.${key}`)]))),
      }) };
    }
    sending.current = true;
    setPending(true); setError(null);
    let leaving = false;
    try {
      const response = await fetch("/api/projects", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key },
        body: attempt.current.body, signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (response.ok && result.success === true && typeof result.data?.project?.id === "string"
        && /^[0-9a-f-]{36}$/i.test(result.data.project.id)) {
        leaving = true;
        window.location.replace(`/projects/${result.data.project.id}`);
        return;
      }
      if (response.status >= 500 || response.ok) throw new Error("Uncertain outcome");
      // A rejected retry does not establish what happened to an earlier attempt.
      if (!uncertain) attempt.current = null;
      const field = typeof result.error?.field === "string" && form.current.elements.namedItem(result.error.field)
        ? result.error.field as string : undefined;
      setError({ message: typeof result.error?.message === "string" ? result.error.message : "Couldn't save the project. Try again.",
        field, signin: response.status === 401 });
      requestAnimationFrame(() => {
        const target = field ? form.current?.elements.namedItem(field) : document.getElementById("project-error");
        if (target instanceof HTMLElement) target.focus();
      });
    } catch {
      // The transaction may have committed even when its response was lost.
      // Freeze the original input and reuse its key until the outcome is known.
      setUncertain(true);
      setError({ message: "We couldn't confirm whether the project was saved. Retry to check and save these same details without creating a duplicate. Keep this page open." });
    } finally {
      if (!leaving) { sending.current = false; setPending(false); }
    }
  }

  return <form ref={form} onSubmit={submit} onInput={check} onChange={check} onFocus={check} aria-busy={pending}>
    <fieldset disabled={pending || uncertain}>
      <label htmlFor="name">Project name</label><input {...fieldProps("name")} required maxLength={160} pattern=".*\S.*" />
      <label htmlFor="clientName">Client name</label><input {...fieldProps("clientName")} required maxLength={160} pattern=".*\S.*" />
      <label htmlFor="problemStatement">Problem statement</label>
      <p id="problem-help" className="panel-description">Describe the business problem, current process and desired outcome in 50–20,000 characters.</p>
      <textarea {...fieldProps("problemStatement")} aria-describedby={error?.field === "problemStatement" ? "problem-help project-error" : "problem-help"}
        required minLength={50} maxLength={20000} rows={6} style={{ ...control, resize: "vertical" }} />
      <label htmlFor="targetProduct">Target product</label><select {...fieldProps("targetProduct")} required defaultValue="" style={control}>
        <option value="" disabled>Select a product</option><option value="S4HANA_CLOUD_PUBLIC">SAP S/4HANA Cloud Public Edition</option>
        <option value="S4HANA_CLOUD_PRIVATE">SAP S/4HANA Cloud Private Edition</option><option value="S4HANA_ON_PREMISE">SAP S/4HANA on-premise</option>
      </select>
      <label htmlFor="startingLandscape">Starting landscape</label><select {...fieldProps("startingLandscape")} defaultValue="MIXED" style={control}>
        <option value="MIXED">Mixed landscape</option><option value="NON_SAP">Non-SAP</option><option value="EXISTING_SAP">Existing SAP</option>
      </select>
      <label htmlFor="modules">Modules (optional)</label><input {...fieldProps("modules")} placeholder="For example: SD, MM, FI" maxLength={671} />
      <p className="panel-description">Separate module codes with commas.</p>
      <h2 style={{ fontSize: 22 }}>Organisation units <span style={{ fontWeight: 400 }}>(optional)</span></h2>
      {units.map((id, index) => <fieldset key={id} style={{ border: "1px solid var(--border)", padding: 16, marginBottom: 16 }}>
        <legend>Unit {index + 1}</legend>
        <label htmlFor={`orgUnits.${index}.type`}>Unit {index + 1} type</label><select {...fieldProps(`orgUnits.${index}.type`)} style={control}>
          {Object.entries(unitTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <label htmlFor={`orgUnits.${index}.code`}>Unit {index + 1} code</label><input {...fieldProps(`orgUnits.${index}.code`)} required maxLength={40} pattern="[A-Za-z0-9_\-]+" />
        <label htmlFor={`orgUnits.${index}.name`}>Unit {index + 1} name</label><input {...fieldProps(`orgUnits.${index}.name`)} required maxLength={160} pattern=".*\S.*" />
        <button type="button" style={secondary} onClick={() => { setUnits((value) => value.filter((item) => item !== id)); requestAnimationFrame(check); }}>Remove unit {index + 1}</button>
      </fieldset>)}
      <button type="button" style={secondary} disabled={units.length >= 50} onClick={() => { setUnits((value) => [...value, nextUnit.current++]); setValid(false); }}>Add organisation unit</button>
    </fieldset>
    {error && <p id="project-error" role="alert" tabIndex={-1} style={{ color: "#a32626", lineHeight: 1.5 }}>{error.message}
      {error.signin && <> <Link href="/login" target="_blank" rel="noopener">Sign in in a new tab, then retry here</Link></>}</p>}
    <button type="submit" className="primary-button" data-primary-cta data-action="create-project" style={{ marginTop: 24 }}
      disabled={pending || (!uncertain && !valid)}>{pending ? "Saving project…" : uncertain ? "Retry save" : "Save project"}</button>
    <p className="signup-link"><Link href="/projects">Back to projects</Link></p>
  </form>;
}
