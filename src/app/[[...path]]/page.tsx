import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AuthForm, WorkspaceLink as Link } from "../auth-ui";
import { getPageSession, loginDestination, requirePageSession } from "../../lib/page-auth";
import { isAuthError } from "../../lib/auth";
import { z } from "zod";
import { failureCode } from "../../lib/consultant-extraction";
import { zodIssues } from "../../lib/auth-http";
import { getRuntime } from "../../lib/runtime";
import { googleEnabled } from "../../lib/google-oauth";
import { ProjectForm } from "../project-form";
import { AnalysisPanel } from "../analysis-panel";
import { DiscoveryPanel, type Variant } from "../discovery-panel";
import { ConsultantPanel } from "../consultant-panel";
import { ConsultantReport } from "../consultant-report";
import { buildReport } from "../../lib/consultant-report";
import { overviewStatus } from "../../lib/project-status";

type Props = { params: Promise<{ path?: string[] }> };
export async function generateMetadata({ params }: Props) {
  const { path = [] } = await params;
  return { title: path[0] === "signup" ? "Create account" : path[0] === "review" ? "Review"
    : path[0] === "projects" ? "Projects" : "Workspace" };
}

function Panel({ title, children, wide = false }: { title: string; children: ReactNode; wide?: boolean }) {
  return <section className="access-panel access-placeholder" style={{ width: `min(${wide ? 1280 : 880}px, calc(100% - 48px))` }}>
    <h1>{title}</h1>{children}
  </section>;
}

type FirstVariant = Awaited<ReturnType<ReturnType<typeof getRuntime>["workspaces"]["list"]>>[number] | undefined;
type ToBeJob = Awaited<ReturnType<ReturnType<typeof getRuntime>["consultantJobs"]["latest"]>>["jobs"][number] | undefined;
/** The project's first process variant; a failed lookup reads as "none yet" so the steps and next step fall back to not-done. */
async function firstVariant(token: string | null, projectId: string): Promise<FirstVariant> {
  try { return (await getRuntime().workspaces.list(token, projectId))[0]; } catch { return undefined; }
}
/** The first variant's latest To-Be job, once its process is confirmed. A failed lookup reads as "no To-Be yet". */
async function latestToBe(token: string | null, projectId: string, variant: FirstVariant): Promise<ToBeJob> {
  if (!variant?.confirmedSnapshotId) return undefined;
  try { return (await getRuntime().consultantJobs.latest(token, projectId, variant.variantCode)).jobs.find(job => job.kind === "TO_BE"); } catch { return undefined; }
}
const reportHref = (projectId: string, variant: NonNullable<FirstVariant>, job: NonNullable<ToBeJob>) =>
  `/projects/${projectId}/consultant/${encodeURIComponent(variant.variantCode)}/to-be/${job.id}`;

/** Where a project stands. Scope is done once the project is no longer a draft; mapping is done once the first variant is confirmed.
 * The To-Be step is never "done": a generated To-Be is a draft for human review (it may even be blocked), and nothing here records an
 * approval, so a succeeded one reads "(draft ready)". `toBe` is only passed on the overview; the other pages leave step 3 as plain text. */
function ProjectSteps({ projectId, current, scoped, mapped, toBe }: { projectId: string; current: 1 | 2; scoped: boolean; mapped: boolean;
  toBe?: { variant: FirstVariant; job: ToBeJob } }) {
  const consultant = `/projects/${projectId}/consultant`;
  const succeeded = toBe?.variant && toBe.job?.status === "SUCCEEDED";
  const steps: { label: string; href?: string; mark?: string }[] = [
    { label: "Scope the problem", href: `/projects/${projectId}`, mark: scoped ? "done" : undefined },
    { label: "Map the current process", href: consultant, mark: mapped ? "done" : undefined },
    { label: "Design the To-Be", ...(succeeded ? { href: reportHref(projectId, toBe.variant!, toBe.job!), mark: "draft ready" }
      : toBe && mapped ? { href: consultant, mark: toBe.job?.status === "QUEUED" || toBe.job?.status === "RUNNING" ? "generating" : undefined } : {}) },
  ];
  return <ol className="steps" aria-label="Project steps">{steps.map((step, index) =>
    <li key={step.label} aria-current={index + 1 === current ? "step" : undefined}>
      {step.href && index + 1 !== current ? <Link href={step.href}>{step.label}</Link> : step.label}
      {step.mark && <span className="steps-done"> ({step.mark})</span>}
    </li>)}</ol>;
}

/** The overview's next step follows the guided conversation: its first variant, whether it is confirmed, and its latest To-Be job
 * (looked up once by the caller and shared with the step tracker and status line). */
function nextStep(projectId: string, guest: boolean, variant: FirstVariant, toBe: ToBeJob): { href: string; label: string } {
  const consultant = `/projects/${projectId}/consultant`;
  const fallback = { href: consultant, label: guest ? "Next: view the current process" : "Next: map the current process" };
  if (!variant) return fallback;
  if (!variant.confirmedSnapshotId) return { href: consultant, label: guest ? fallback.label : "Next: continue mapping the current process" };
  if (toBe?.status === "QUEUED" || toBe?.status === "RUNNING") return { href: consultant, label: "To-Be design is being generated" };
  if (toBe?.status === "SUCCEEDED") return { href: reportHref(projectId, variant, toBe), label: "Open the To-Be report" };
  return { href: consultant, label: guest ? fallback.label : "Next: generate the To-Be design" };
}

export default async function WorkspacePage({ params }: Props) {
  const { path = [] } = await params;
  if (path.length === 0) {
    const { user } = await getPageSession();
    redirect(user ? loginDestination(undefined, user.orgRole) : "/login");
  }
  const route = `/${path.map(encodeURIComponent).join("/")}`;
  if (route === "/signup") {
    const { user } = await getPageSession();
    if (user) redirect(loginDestination(undefined, user.orgRole));
    return <section className="access-panel access-placeholder" aria-labelledby="signup-heading">
      <h1 id="signup-heading">Create account</h1>
      <p className="panel-description">Create a workspace for your organisation and start your first transformation project.</p>
      <AuthForm mode="signup" google={googleEnabled(getRuntime().config)} />
    </section>;
  }
  if (path.length === 2 && path[0] === "invite") return <Panel title="Join your project">
    <p className="panel-description">Invitation access is not available yet.</p>
    <Link className="primary-button" href="/login" data-primary-cta>Back to sign in</Link>
  </Panel>;
  if (path[0] !== "projects" && route !== "/review" && route !== "/admin/reference-library") notFound();
  const { user, token } = await requirePageSession(route);
  if (route === "/admin/reference-library") {
    if (user.orgRole !== "ADMIN") notFound();
    return <Panel title="Reference library"><p className="panel-description">Reference library management is not available yet.</p>
      <Link className="primary-button" href="/projects" data-primary-cta>Back to projects</Link></Panel>;
  }
  if (route === "/projects/new") {
    if (user.orgRole === "GUEST") notFound();
    return <Panel title="Start a transformation project"><p className="panel-description">Capture your project details, then analyze the business problem to draft your process scope.</p>
      <ProjectForm /></Panel>;
  }

  const repository = getRuntime().projects;
  let project: Awaited<ReturnType<typeof repository.get>> | undefined;
  let projects: Awaited<ReturnType<typeof repository.list>> = [];
  try {
    if (path[0] === "projects" && path[1]) project = await repository.get(token, path[1]);
    else projects = await repository.list(token);
  } catch (error) {
    if (isAuthError(error) && error.status === 401) redirect(`/login?${new URLSearchParams({ next: route })}`);
    if (isAuthError(error) && error.status === 404) notFound();
    return <Panel title="Couldn't load projects"><p className="panel-description">Please try again in a moment.</p>
      <a className="primary-button" href={route} data-primary-cta>Retry</a></Panel>;
  }
  if (project) {
    if (path.length === 3 && path[2] === "consultant") {
      // Data loads in the browser from the authorized API so the page resumes from server state on every visit.
      const first = await firstVariant(token, project.id);
      return <Panel title="Discovery conversation" wide>
        <p className="eyebrow">{project.name}</p>
        <ProjectSteps projectId={project.id} current={2} scoped={project.setupStatus !== "DRAFT"} mapped={!!first?.confirmedSnapshotId} />
        <ConsultantPanel projectId={project.id} />
        <p className="signup-link"><Link href={`/projects/${project.id}/discovery`}>Enter process details manually instead</Link>
          {" · "}<Link href={`/projects/${project.id}`}>Back to project overview</Link></p>
      </Panel>;
    }
    if (path.length === 6 && path[2] === "consultant" && path[4] === "to-be") {
      let data: Awaited<ReturnType<NonNullable<ReturnType<typeof getRuntime>["consultantJobs"]>["report"]>>;
      try { data = await getRuntime().consultantJobs.report(token, project.id, path[3]!, path[5]!); }
      catch (error) {
        if (isAuthError(error) && error.status === 401) redirect(`/login?${new URLSearchParams({ next: route })}`);
        if (isAuthError(error) && error.status === 404) notFound();
        // Codes and issue paths only: no values, no report text.
        console.error(JSON.stringify({ event: "report_load_failed", ...(z.uuid().safeParse(path[5]).success && { jobId: path[5] }),
          code: failureCode(error), ...zodIssues(error) }));
        return <Panel title="Could not load the report"><p className="panel-description">Please try again in a moment.</p>
          <a className="primary-button" href={route} data-primary-cta>Retry</a></Panel>;
      }
      const api = `/api/projects/${encodeURIComponent(project.id)}/consultant/${encodeURIComponent(path[3]!)}/to-be/${encodeURIComponent(path[5]!)}`;
      return <ConsultantReport model={buildReport(data)} downloads={{ markdown: `${api}/report.md`, csv: `${api}/traceability.csv`,
        back: `/projects/${project.id}/consultant` }} />;
    }
    if (path.length === 3 && path[2] === "discovery") {
      let variants: Variant[];
      let canEdit: boolean;
      try {
        const discovery = getRuntime().discovery;
        variants = await discovery.list(token, project.id);
        // The repository applies project membership and read-only permissions,
        // including when this project has not saved a variant yet.
        ({ canEdit } = await discovery.get(token, project.id, variants[0]?.variantCode ?? "DEFAULT"));
      } catch (error) {
        if (isAuthError(error) && error.status === 401) redirect(`/login?${new URLSearchParams({ next: route })}`);
        if (isAuthError(error) && error.status === 404) notFound();
        return <Panel title="Could not load discovery"><p>Please try again.</p><a href={route}>Retry</a></Panel>;
      }
      const first = await firstVariant(token, project.id);
      return <Panel title="Detailed process discovery">
        <p className="eyebrow">{project.name}</p>
        <ProjectSteps projectId={project.id} current={2} scoped={project.setupStatus !== "DRAFT"} mapped={!!first?.confirmedSnapshotId} />
        <DiscoveryPanel projectId={project.id} initialVariants={variants} canCreate={canEdit} />
        <p className="signup-link"><Link href={`/projects/${project.id}/consultant`}>Describe the process in a conversation instead</Link>
          {" · "}<Link href={`/projects/${project.id}`}>Back to project overview</Link></p>
      </Panel>;
    }
    if (path.length !== 2) notFound(); // Unimplemented pages cannot bypass project authorization.
    const first = await firstVariant(token, project.id);
    const toBe = await latestToBe(token, project.id, first);
    const mapped = !!first?.confirmedSnapshotId;
    return <Panel title={project.name}>
      <p className="eyebrow">Project overview</p>
      <p className="panel-description">{project.clientName} · {overviewStatus(project.setupStatus, mapped, toBe)}</p>
      <ProjectSteps projectId={project.id} current={1} scoped={project.setupStatus !== "DRAFT"} mapped={mapped} toBe={{ variant: first, job: toBe }} />
      <AnalysisPanel projectId={project.id} next={nextStep(project.id, user.orgRole === "GUEST", first, toBe)} />
      <h2 style={{ fontSize: 22 }}>Detailed process discovery</h2>
      <p className="panel-description">Capture current steps, source notes and future requirements before designing the To-Be process.</p>
      <p><Link href={`/projects/${project.id}/consultant`}>Describe the process in a guided conversation</Link> (recommended)</p>
      <p className="panel-description">Prefer a form? <Link href={`/projects/${project.id}/discovery`}>Capture and review process details</Link></p>
      <h2 style={{ fontSize: 22 }}>Project details</h2>
      <dl style={{ display: "grid", gridTemplateColumns: "minmax(100px, 1fr) 3fr", gap: "16px 20px", lineHeight: 1.5 }}>
        <dt>Target product</dt><dd style={{ margin: 0 }}>{({ S4HANA_CLOUD_PUBLIC: "SAP S/4HANA Cloud Public Edition", S4HANA_CLOUD_PRIVATE: "SAP S/4HANA Cloud Private Edition", S4HANA_ON_PREMISE: "SAP S/4HANA on-premise" } as Record<string, string>)[project.targetProduct] ?? project.targetProduct}</dd>
        <dt>Starting landscape</dt><dd style={{ margin: 0 }}>{({ MIXED: "Mixed landscape", NON_SAP: "Non-SAP", EXISTING_SAP: "Existing SAP" } as Record<string, string>)[project.startingLandscape]}</dd>
        <dt>Modules</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{project.modules.join(", ") || "Not specified"}</dd>
      </dl>
      <h3>Problem statement</h3><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.6 }}>{project.problemStatement}</p>
      {project.orgUnits.length > 0 && <><h3>Organisation units</h3><ul>{project.orgUnits.map((unit) =>
        <li key={`${unit.type}:${unit.code}`} style={{ overflowWrap: "anywhere" }}>{unit.type.replaceAll("_", " ")} · {unit.code} · {unit.name}</li>)}</ul></>}
      <Link className="primary-button" href={user.orgRole === "GUEST" ? "/review" : "/projects"} data-primary-cta>
        {user.orgRole === "GUEST" ? "Back to review" : "Back to projects"}
      </Link>
    </Panel>;
  }
  const review = route === "/review";
  // The list shows the overview's status line; one query covers every listed project, and a failed lookup falls back to the stored status.
  const progressRows = await getRuntime().consultantJobs.projectProgress(token).catch(error => {
    console.error(JSON.stringify({ event: "project_progress_lookup_failed", code: failureCode(error) }));
    return [];
  });
  const progress = new Map(progressRows.map(row => [row.projectId, row]));
  const status = (item: (typeof projects)[number]) => { const row = progress.get(item.id);
    return overviewStatus(item.setupStatus, !!row?.mapped, row?.toBeStatus ? { status: row.toBeStatus } : undefined); };
  return <Panel title={review ? "Review" : "Your projects"}>
    {review && <p className="panel-description">Review requests are not available yet. Open one of your project workspaces below.</p>}
    {projects.length === 0 ? <div data-testid="projects-empty">
      <h2 style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.3 }}>{user.orgRole === "GUEST"
        ? "No assigned projects" : "Turn a problem statement into an SAP Business Blueprint"}</h2>
      <p className="panel-description">{user.orgRole === "GUEST" ? "Projects shared with you will appear here."
        : "Describe a business problem and review an AI-generated proposal for your SAP process scope."}</p>
    </div> : <ul aria-label="Projects" style={{ listStyle: "none", padding: 0, margin: "24px 0" }}>
      {projects.map((item) => <li key={item.id} style={{ borderTop: "1px solid var(--border)", padding: "20px 0" }}>
        <Link href={`/projects/${item.id}`} style={{ fontSize: 19, fontWeight: 600, overflowWrap: "anywhere" }}>{item.name}</Link>
        <p className="panel-description" style={{ margin: "8px 0 0" }}>{item.clientName} · {status(item)}</p>
      </li>)}
    </ul>}
    {user.orgRole !== "GUEST" && !review && <Link className="primary-button" href="/projects/new"
      data-action="new-project" data-primary-cta>{projects.length ? "New project" : "Start a transformation project"}</Link>}
  </Panel>;
}
