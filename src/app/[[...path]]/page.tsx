import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AuthForm, WorkspaceLink as Link } from "../auth-ui";
import { getPageSession, loginDestination, requirePageSession } from "../../lib/page-auth";
import { isAuthError } from "../../lib/auth";
import { getRuntime } from "../../lib/runtime";
import { ProjectForm } from "../project-form";

type Props = { params: Promise<{ path?: string[] }> };
export async function generateMetadata({ params }: Props) {
  const { path = [] } = await params;
  return { title: path[0] === "signup" ? "Create account" : path[0] === "review" ? "Review"
    : path[0] === "projects" ? "Projects" : "Workspace" };
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="access-panel access-placeholder" style={{ width: "min(880px, calc(100% - 48px))" }}>
    <h1>{title}</h1>{children}
  </section>;
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
      <AuthForm mode="signup" />
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
    return <Panel title="Start a transformation project"><p className="panel-description">Capture your project details. You can save a draft now; AI scope analysis is not available yet.</p>
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
    if (path.length !== 2) notFound(); // Unimplemented pages cannot bypass project authorization.
    return <Panel title={project.name}>
      <p className="eyebrow">Project overview</p>
      <p className="panel-description">{project.clientName} · {project.setupStatus === "ACTIVE" ? "Active" : "Setup incomplete"}</p>
      <p className="panel-description">Process scope and design tools are not available yet.</p>
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
  return <Panel title={review ? "Review" : "Your projects"}>
    {review && <p className="panel-description">Review requests are not available yet. Open one of your project workspaces below.</p>}
    {projects.length === 0 ? <div data-testid="projects-empty">
      <h2 style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.3 }}>{user.orgRole === "GUEST"
        ? "No assigned projects" : "Turn a problem statement into an SAP Business Blueprint"}</h2>
      <p className="panel-description">{user.orgRole === "GUEST" ? "Projects shared with you will appear here."
        : "Start with one project: capture the As-Is of one process and get a draft To-Be in about 15 minutes."}</p>
    </div> : <ul aria-label="Projects" style={{ listStyle: "none", padding: 0, margin: "24px 0" }}>
      {projects.map((item) => <li key={item.id} style={{ borderTop: "1px solid var(--border)", padding: "20px 0" }}>
        <Link href={`/projects/${item.id}`} style={{ fontSize: 19, fontWeight: 600, overflowWrap: "anywhere" }}>{item.name}</Link>
        <p className="panel-description" style={{ margin: "8px 0 0" }}>{item.clientName} · {item.setupStatus === "ACTIVE" ? "Active" : "Setup incomplete"}</p>
      </li>)}
    </ul>}
    {user.orgRole !== "GUEST" && !review && <Link className="primary-button" href="/projects/new"
      data-action="new-project" data-primary-cta>{projects.length ? "New project" : "Start a transformation project"}</Link>}
  </Panel>;
}
